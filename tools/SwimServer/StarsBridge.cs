using System.Collections.Concurrent;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace SwimServer;

/// <summary>
/// vNAS profile cache for the STARS port. The vNAS data API
/// (data-api.vnas.vatsim.net) publishes the same CRCARTCC schema that
/// scope/MapImporter/CRC/CRCARTCC.cs ports — STARS configuration, video
/// map IDs, beacon code banks, area/sector layout, primary scratchpad
/// rules, etc. We hit /api/artccs/{id}/ once per ARTCC and keep the
/// parsed tree in memory; daily refresh.
///
/// Video-map GEOMETRY comes from the static file store vNAS's own
/// configuration service names — see the service-discovery block below.
/// It needs no authentication, so crc-export is a cache, not a dependency.
///
/// No Solace involvement — pure HTTP fetcher.
/// </summary>
class StarsBridge
{
    private readonly HttpClient _http;
    private readonly JsonSerializerOptions _jsonOpts;

    private string[] _artccIds = Array.Empty<string>();
    private readonly ConcurrentDictionary<string, JsonDocument> _artccs = new(StringComparer.OrdinalIgnoreCase);
    private DateTime _lastRefresh = DateTime.MinValue;

    // Where the CRC export tree lives — see KNOWN-DEVIATIONS G10. Default is
    // <cwd>/crc-export/. Layout matches CRCMapImporter.cs expectations:
    //   <root>/<artccId>/VideoMaps/<mapId>.geojson
    private string _crcExportRoot;

    // Optional vNAS auth for fetching video-map GeoJSON on demand (the public
    // /api/artccs/{id}/video-maps/{mapId} endpoint requires authentication).
    // Set VNAS_TOKEN (a bearer token) or VNAS_COOKIE (a full Cookie header) in
    // the environment / .env. Downloaded maps are cached under crc-export/.
    private static readonly string? VnasToken = Environment.GetEnvironmentVariable("VNAS_TOKEN");
    private static readonly string? VnasCookie = Environment.GetEnvironmentVariable("VNAS_COOKIE");

    // ── vNAS service discovery ──────────────────────────────────────────
    //
    // CRC hardcodes no endpoints: it asks configuration.vnas.vatsim.net where everything lives
    // (dataApiBaseUrl, videoMapBaseUrl, navDataUrl, …) and uses what comes back. Video-map
    // geometry lives in the static file store that config names:
    //
    //     {videoMapBaseUrl}/{ARTCC}/{mapId}.geojson     — public, no auth
    //
    // The authenticated route is /api/artccs/{id}/video-maps/{mapId}, which is the ADMIN API and
    // is what returns 401. Confusing the two is why this was believed impossible (KNOWN-DEVIATIONS
    // G10). We resolve the base URL rather than hardcoding it, for the same reason CRC does: if
    // vNAS moves the store, the next daily refresh follows it.
    private const string ConfigUrl = "https://configuration.vnas.vatsim.net/";
    private const string DefaultVideoMapBase = "https://data-api.vnas.vatsim.net/Files/VideoMaps";
    private string _videoMapBase = DefaultVideoMapBase;

    // mapId → lastUpdatedAt, per ARTCC, straight out of the ARTCC document. This is how CRC
    // decides what to re-download, and it is what makes the on-disk copy a cache: a file older
    // than the published timestamp gets refetched instead of served forever.
    private readonly ConcurrentDictionary<string, Dictionary<string, DateTime>> _mapStamps =
        new(StringComparer.OrdinalIgnoreCase);

    public StarsBridge(HttpClient http, JsonSerializerOptions jsonOpts)
    {
        _http = http;
        _jsonOpts = new JsonSerializerOptions(jsonOpts)
        {
            PropertyNameCaseInsensitive = true,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        };
        _crcExportRoot = Path.Combine(Directory.GetCurrentDirectory(), "crc-export");
        Directory.CreateDirectory(_crcExportRoot);
    }

    public string CrcExportRoot => _crcExportRoot;
    public void SetCrcExportRoot(string root)
    {
        _crcExportRoot = root;
        Directory.CreateDirectory(root);
    }

    public void Start()
    {
        _ = Task.Run(RefreshLoop);
    }

    private async Task RefreshLoop()
    {
        while (true)
        {
            try { await RefreshOnce(); }
            catch (Exception ex) { Console.Error.WriteLine($"[STARS] vNAS refresh: {ex.Message}"); }
            try { await SweepStaleMapsAsync(); }
            catch (Exception ex) { Console.Error.WriteLine($"[STARS] video map sweep: {ex.Message}"); }
            await Task.Delay(TimeSpan.FromHours(24));
        }
    }

    private async Task RefreshConfigAsync()
    {
        try
        {
            using var doc = JsonDocument.Parse(await _http.GetStringAsync(ConfigUrl));
            if (doc.RootElement.TryGetProperty("videoMapBaseUrl", out var v)
                && v.GetString() is { Length: > 0 } url)
            {
                url = url.TrimEnd('/');
                if (!string.Equals(url, _videoMapBase, StringComparison.Ordinal))
                    Console.WriteLine($"[STARS] vNAS videoMapBaseUrl = {url}");
                _videoMapBase = url;
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[STARS] vNAS config: {ex.Message} (keeping {_videoMapBase})");
        }
    }

    private async Task RefreshOnce()
    {
        await RefreshConfigAsync();
        var listJson = await _http.GetStringAsync("https://data-api.vnas.vatsim.net/api/artccs/");
        using var doc = JsonDocument.Parse(listJson);
        var ids = new List<string>();
        foreach (var item in doc.RootElement.EnumerateArray())
        {
            if (item.TryGetProperty("id", out var idEl) && idEl.GetString() is string id)
                ids.Add(id);
        }
        _artccIds = ids.OrderBy(x => x).ToArray();
        // Drop cached ARTCC facility trees so sector/frequency data genuinely re-pulls on the 24h
        // tick (otherwise a loaded ARTCC's frequencies stay frozen until the next process restart).
        // Just clear — don't dispose, since a concurrent request may still hold a doc reference;
        // the pooled buffers are reclaimed by GC once the last reader releases them.
        int evicted = _artccs.Count;
        _artccs.Clear();
        _mapStamps.Clear();   // rebuilt from the re-fetched ARTCC docs, with the new timestamps
        Console.WriteLine($"[STARS] vNAS: {_artccIds.Length} ARTCCs available" +
            (evicted > 0 ? $"; evicted {evicted} cached facility tree(s) for refresh" : ""));
        _lastRefresh = DateTime.UtcNow;
    }

    /// <summary>List of ARTCC IDs (lazy-loaded if not yet refreshed).</summary>
    public async Task<string[]> GetArtccIdsAsync()
    {
        if (_artccIds.Length == 0) await RefreshOnce();
        return _artccIds;
    }

    /// <summary>Full ARTCC document — facility tree, video maps, configurations.
    /// Cached after first fetch; mirrors CRCARTCC schema from the WPF source.</summary>
    public async Task<JsonDocument?> GetArtccAsync(string artccId)
    {
        if (_artccs.TryGetValue(artccId, out var cached)) return cached;
        try
        {
            var json = await _http.GetStringAsync(
                $"https://data-api.vnas.vatsim.net/api/artccs/{artccId}/");
            var doc = JsonDocument.Parse(json);
            _artccs[artccId] = doc;
            return doc;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[STARS] vNAS fetch {artccId}: {ex.Message}");
            return null;
        }
    }

    // ── Is this facility displayable at all? ────────────────────────────────
    //
    // `/stars/{artcc}/{facility}` used to serve the scope shell for ANY two strings, so a facility
    // with no `starsConfiguration` drew a blank screen and said nothing. That is the COMMON case,
    // not an edge one: measured over 10 ARTCCs, 306 facilities have no STARS config.
    //
    // What made it baffling is DJT. vNAS splits Palm Beach into the ATCT (**DJT**, no config, 0
    // video maps) and the TRACON (**PBI**, 160 maps) — and names BOTH of them "Palm Beach ATCT".
    // So after the airport's PBI→DJT rename, DJT is the identifier you reach for and the one that
    // shows nothing.
    //
    // Hence the alias rule: a non-STARS facility whose name matches **exactly one** STARS facility
    // in the same ARTCC resolves to it. Over those 306 that fires exactly once (DJT → PBI) and is
    // never ambiguous, and unlike a hardcoded table it handles the next ATCT/TRACON split on its
    // own. Requiring uniqueness is what makes it safe — two matches means we say nothing.

    public enum StarsFacilityStatus
    {
        Ok,             // has a starsConfiguration — serve the scope
        Aliased,        // no config, but exactly one same-named STARS facility — send them there
        NoStarsConfig,  // no config and no unique alias — nothing to display
        NotFound,       // the ARTCC has no facility with this id
        Unknown,        // vNAS unreachable; we can't tell, so don't block
    }

    public record StarsFacilityResolution(StarsFacilityStatus Status, string FacilityId,
                                          string? Name, string? Type, string? AliasOf,
                                          string[] Available);

    private readonly record struct FacNode(string Id, string Name, string? Type, bool HasStars);

    private static void CollectAllFacilities(JsonElement f, List<FacNode> into)
    {
        if (f.TryGetProperty("id", out var idEl) && idEl.GetString() is { Length: > 0 } id)
            into.Add(new FacNode(
                id,
                f.TryGetProperty("name", out var n) ? (n.GetString() ?? "") : "",
                f.TryGetProperty("type", out var t) ? t.GetString() : null,
                f.TryGetProperty("starsConfiguration", out var sc) && sc.ValueKind != JsonValueKind.Null));
        if (f.TryGetProperty("childFacilities", out var kids) && kids.ValueKind == JsonValueKind.Array)
            foreach (var k in kids.EnumerateArray())
                CollectAllFacilities(k, into);
    }

    /// <summary>
    /// Pure resolution over one ARTCC's facility tree — the testable core of
    /// <see cref="ResolveFacilityAsync"/>. Public so it can be driven from a hand-built tree.
    /// </summary>
    public static StarsFacilityResolution Resolve(JsonElement facilityRoot, string facilityId)
    {
        var all = new List<FacNode>();
        CollectAllFacilities(facilityRoot, all);
        var want = (facilityId ?? "").Trim();
        var available = all.Where(f => f.HasStars).Select(f => f.Id)
                           .Distinct(StringComparer.OrdinalIgnoreCase)
                           .OrderBy(x => x, StringComparer.OrdinalIgnoreCase).ToArray();

        var hit = all.FirstOrDefault(f => string.Equals(f.Id, want, StringComparison.OrdinalIgnoreCase));
        if (hit.Id is null)
            return new(StarsFacilityStatus.NotFound, want.ToUpperInvariant(), null, null, null, available);
        if (hit.HasStars)
            return new(StarsFacilityStatus.Ok, hit.Id, hit.Name, hit.Type, null, available);

        var sameName = all
            .Where(f => f.HasStars
                     && !string.Equals(f.Id, hit.Id, StringComparison.OrdinalIgnoreCase)
                     && f.Name.Trim().Length > 0
                     && string.Equals(f.Name.Trim(), hit.Name.Trim(), StringComparison.OrdinalIgnoreCase))
            .Select(f => f.Id).Distinct(StringComparer.OrdinalIgnoreCase).ToList();

        return sameName.Count == 1
            ? new(StarsFacilityStatus.Aliased, hit.Id, hit.Name, hit.Type, sameName[0], available)
            : new(StarsFacilityStatus.NoStarsConfig, hit.Id, hit.Name, hit.Type, null, available);
    }

    /// <summary>Resolve a facility for the scope route. Fails OPEN if vNAS is unreachable.</summary>
    public async Task<StarsFacilityResolution> ResolveFacilityAsync(string artccId, string facilityId)
    {
        var doc = await GetArtccAsync(artccId);
        // Unknown, not NotFound: an upstream blip must not turn a facility that normally works
        // into an error page. The scope is served and left to cope, exactly as before this existed.
        if (doc is null || !doc.RootElement.TryGetProperty("facility", out var root))
            return new(StarsFacilityStatus.Unknown, (facilityId ?? "").Trim().ToUpperInvariant(),
                       null, null, null, Array.Empty<string>());
        return Resolve(root, facilityId);
    }

    /// <summary>List of facilities (with their parents) that have a STARS
    /// configuration. CRCMapImporter.cs auto-picks if there's exactly one;
    /// the frontend handles that same logic.</summary>
    /// <param name="resolveFeedId">
    /// Same resolver <see cref="GetFacilityAsync"/> takes, for the same reason — the picker shows
    /// each facility's live track count and controller positions, and both are keyed by the id the
    /// TRACK feed publishes, which is not always the facility's own. Palm Beach is the live case:
    /// vNAS says PBI, TAIS says DJT, so the row read "0 maps' worth of traffic" on a TRACON working
    /// 170 tracks and looked inactive. Optional, so a caller that only wants names/map counts can
    /// skip the live-facility lookup.
    /// </param>
    public async Task<object?> GetStarsFacilitiesAsync(string artccId,
                                                       Func<string, string[], string?>? resolveFeedId = null)
    {
        var doc = await GetArtccAsync(artccId);
        if (doc is null) return null;
        var root = doc.RootElement;
        var results = new List<object>();
        if (root.TryGetProperty("facility", out var facility))
            CollectStarsFacilities(facility, parentId: null, results, resolveFeedId);
        return new { artccId, facilities = results };
    }

    // facilityId → artccId reverse index, built lazily by scanning every ARTCC's STARS facilities.
    private readonly ConcurrentDictionary<string, string> _facilityArtcc = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// Find which ARTCC a STARS facility (e.g. "A80", "PCT") belongs to, so a caller with only the
    /// facility id — like the incident STARS replay — can build the /stars/{artcc}/{facility} URL.
    /// Cached; scans ARTCCs on a miss. Returns null if no ARTCC publishes a STARS config for it.
    /// </summary>
    public async Task<string?> ResolveArtccForFacilityAsync(string facilityId)
    {
        if (string.IsNullOrWhiteSpace(facilityId)) return null;
        if (_facilityArtcc.TryGetValue(facilityId, out var cached)) return cached;

        foreach (var artccId in await GetArtccIdsAsync())
        {
            var doc = await GetArtccAsync(artccId);
            if (doc is null) continue;
            if (doc.RootElement.TryGetProperty("facility", out var facility))
                CollectStarsFacilityIds(facility, artccId);
            if (_facilityArtcc.TryGetValue(facilityId, out var hit)) return hit;
        }
        return null;
    }

    // ── Radar reference points, for weighting how accurate a position is ──────────────
    //
    // A STARS area publishes a `visibilityCenter` and a `surveillanceRange`, which is the closest
    // thing vNAS gives to "where this facility's radar is". It is a PROXY and the code says so:
    // a TRACON's ASRs can sit tens of miles from the center of the area they feed, so this
    // supports "roughly how far out is this target" and not "how far from the antenna".
    //
    // Keyed by BOTH the vNAS facility id and the FEED id, because those differ - Palm Beach is
    // PBI to vNAS and DJT on the TAIS feed, and the consumer here only ever sees the feed id.
    // Keying on one alone is the exact mismatch that made PBI read as a dead facility on the
    // STARS picker.
    private volatile Dictionary<string, double[][]>? _radarRefs;

    /// <summary>
    /// Area reference points for a facility, as [lat, lon] pairs, or null when vNAS publishes
    /// none. Synchronous and allocation-free on the hot path: the fused index calls this once per
    /// candidate per pass.
    /// </summary>
    public double[][]? RadarRefs(string? facilityId)
    {
        var map = _radarRefs;
        if (map is null || facilityId is null) return null;
        return map.TryGetValue(facilityId, out var v) ? v : null;
    }

    public int RadarRefCount => _radarRefs?.Count ?? 0;

    /// <summary>Rebuild the reference map from every ARTCC's STARS areas. Daily is ample - this
    /// is adaptation, not traffic.</summary>
    public async Task RefreshRadarRefsAsync(Func<string, string[], string?>? resolveFeedId = null)
    {
        var map = new Dictionary<string, double[][]>(StringComparer.OrdinalIgnoreCase);
        foreach (var artccId in await GetArtccIdsAsync())
        {
            var doc = await GetArtccAsync(artccId);
            if (doc is null) continue;
            if (doc.RootElement.TryGetProperty("facility", out var facility))
                CollectRadarRefs(facility, map, resolveFeedId);
        }
        // An empty result never replaces a map we already hold: vNAS being unreachable must not
        // silently turn every range term off, which would look like nothing at all.
        if (map.Count > 0) _radarRefs = map;
        Console.WriteLine($"[STARS] Radar refs: {map.Count} facility keys");
    }

    private static void CollectRadarRefs(JsonElement facility, Dictionary<string, double[][]> map,
                                         Func<string, string[], string?>? resolveFeedId)
    {
        if (facility.TryGetProperty("id", out var idEl) && idEl.GetString() is { } id
            && facility.TryGetProperty("starsConfiguration", out var sc)
            && sc.ValueKind == JsonValueKind.Object
            && sc.TryGetProperty("areas", out var areas) && areas.ValueKind == JsonValueKind.Array)
        {
            var pts = new List<double[]>();
            foreach (var a in areas.EnumerateArray())
            {
                if (!a.TryGetProperty("visibilityCenter", out var vc)
                    || vc.ValueKind != JsonValueKind.Object) continue;
                if (vc.TryGetProperty("lat", out var la) && la.TryGetDouble(out var y)
                    && vc.TryGetProperty("lon", out var lo) && lo.TryGetDouble(out var x)
                    && (y != 0 || x != 0))
                    pts.Add(new[] { y, x });
            }
            if (pts.Count > 0)
            {
                var arr = pts.ToArray();
                map[id] = arr;
                var feed = resolveFeedId?.Invoke(id, InternalAirports(sc));
                if (feed is { Length: > 0 } && !string.Equals(feed, id, StringComparison.OrdinalIgnoreCase))
                    map[feed] = arr;
            }
        }

        if (facility.TryGetProperty("childFacilities", out var children)
            && children.ValueKind == JsonValueKind.Array)
            foreach (var child in children.EnumerateArray())
                CollectRadarRefs(child, map, resolveFeedId);
    }

    /// <summary>Recursively index every STARS-configured facility id under a facility tree to its ARTCC.</summary>
    private void CollectStarsFacilityIds(JsonElement facility, string artccId)
    {
        if (facility.TryGetProperty("id", out var idEl)
            && facility.TryGetProperty("starsConfiguration", out var sc) && sc.ValueKind != JsonValueKind.Null
            && idEl.GetString() is { } id)
            _facilityArtcc.TryAdd(id, artccId);

        if (facility.TryGetProperty("childFacilities", out var children) && children.ValueKind == JsonValueKind.Array)
            foreach (var child in children.EnumerateArray())
                CollectStarsFacilityIds(child, artccId);
    }

    private static void CollectStarsFacilities(JsonElement facility, string? parentId, List<object> results,
                                               Func<string, string[], string?>? resolveFeedId = null)
    {
        var id = facility.TryGetProperty("id", out var idEl) ? idEl.GetString() : null;
        var name = facility.TryGetProperty("name", out var nameEl) ? nameEl.GetString() : null;
        var type = facility.TryGetProperty("type", out var typeEl) ? typeEl.GetString() : null;
        bool hasStars = facility.TryGetProperty("starsConfiguration", out var sc)
            && sc.ValueKind != JsonValueKind.Null;

        if (hasStars && id is not null)
        {
            // Extract a few quick-stat fields for the picker UI
            int? videoMapCount = null;
            if (sc.TryGetProperty("videoMapIds", out var vmIds) && vmIds.ValueKind == JsonValueKind.Array)
                videoMapCount = vmIds.GetArrayLength();

            // Areas (id + name) so the picker can offer them as a submenu —
            // bigger TRACONs (e.g. PCT) define many; most ATCT/TRACONs have one.
            var areaList = new List<object>();
            if (sc.TryGetProperty("areas", out var areas) && areas.ValueKind == JsonValueKind.Array)
            {
                foreach (var a in areas.EnumerateArray())
                {
                    areaList.Add(new
                    {
                        id = a.TryGetProperty("id", out var aid) ? aid.GetString() : null,
                        name = a.TryGetProperty("name", out var an) ? an.GetString() : null,
                    });
                }
            }

            results.Add(new
            {
                id,
                name,
                type,
                parentId,
                videoMapCount,
                areaCount = areaList.Count,
                areas = areaList,
                // The id the TRACK feed publishes this facility under — what the picker must key
                // its live track/position lookups on. Same as `id` for all but a handful.
                feedFacilityId = resolveFeedId?.Invoke(id, InternalAirports(sc)) ?? id,
            });
        }

        if (facility.TryGetProperty("childFacilities", out var children)
            && children.ValueKind == JsonValueKind.Array)
        {
            foreach (var child in children.EnumerateArray())
                CollectStarsFacilities(child, id, results, resolveFeedId);
        }
    }

    /// <summary>Returns the STARS configuration for one facility, plus its
    /// location (for screen-center default) and the list of associated
    /// video map IDs. Mirrors what CRCMapImporter pulls from CRCARTCC.</summary>
    /// <param name="resolveFeedId">
    /// Given the facility's own id plus its vNAS <c>internalAirports</c>, return the id the
    /// terminal TRACK feed publishes under. These are NOT always the same: vNAS adaptation still
    /// calls Palm Beach <c>PBI</c> while STDDS/TAIS publishes the renamed <c>DJT</c>, so the scope
    /// needs PBI for maps and DJT for targets. Null = caller has no opinion; the id stands.
    /// </param>
    public async Task<object?> GetFacilityAsync(string artccId, string facilityId,
                                                Func<string, string[], string?>? resolveFeedId = null)
    {
        var doc = await GetArtccAsync(artccId);
        if (doc is null) return null;
        var found = FindFacility(doc.RootElement.GetProperty("facility"), facilityId);
        if (found is null) return null;
        var fac = found.Value;

        // STARS config — copy verbatim for the client; the client mirrors PrefSet defaults.
        JsonElement? starsConfig = fac.TryGetProperty("starsConfiguration", out var sc) ? sc : null;
        // Location — try multiple paths (facility-level location, or visibility center default)
        JsonElement? location = null;
        if (fac.TryGetProperty("location", out var locEl)) location = locEl;
        // Positions — controller positions assigned to this facility (TCPs)
        JsonElement? positions = fac.TryGetProperty("positions", out var posEl) ? posEl : null;

        // Video map metadata (id, name, shortName, starsId, starsBrightnessCategory) —
        // CRCMapImporter walks artcc.videoMaps and matches by ID.
        var videoMaps = new List<object>();
        if (starsConfig.HasValue
            && starsConfig.Value.TryGetProperty("videoMapIds", out var vmIds)
            && vmIds.ValueKind == JsonValueKind.Array
            && doc.RootElement.TryGetProperty("videoMaps", out var allMaps)
            && allMaps.ValueKind == JsonValueKind.Array)
        {
            var wanted = new HashSet<string>(
                vmIds.EnumerateArray().Select(e => e.GetString() ?? "").Where(s => s.Length > 0));
            foreach (var map in allMaps.EnumerateArray())
            {
                var mapId = map.TryGetProperty("id", out var mIdEl) ? mIdEl.GetString() : null;
                if (mapId is null || !wanted.Contains(mapId)) continue;
                videoMaps.Add(new
                {
                    id = mapId,
                    name = map.TryGetProperty("name", out var nm) ? nm.GetString() : null,
                    shortName = map.TryGetProperty("shortName", out var sn) ? sn.GetString() : null,
                    starsId = map.TryGetProperty("starsId", out var sid) ? (int?)sid.GetInt32() : null,
                    starsBrightnessCategory = map.TryGetProperty("starsBrightnessCategory", out var bc) ? bc.GetString() : null,
                    starsAlwaysVisible = map.TryGetProperty("starsAlwaysVisible", out var av) && av.ValueKind == JsonValueKind.True,
                });
            }
        }

        // visibilityCenters[] on the ARTCC root — used as fallback center when
        // the facility itself has no location field (true for most TRACONs).
        JsonElement? visibilityCenters = doc.RootElement.TryGetProperty("visibilityCenters", out var vc)
            ? vc : null;

        return new
        {
            artccId,
            facilityId,
            name = fac.TryGetProperty("name", out var nm2) ? nm2.GetString() : null,
            type = fac.TryGetProperty("type", out var ty) ? ty.GetString() : null,
            location,
            visibilityCenters,
            positions,
            starsConfiguration = starsConfig,
            // Explicit, so a caller never has to infer "displayable" from a null config. The scope
            // route blocks non-STARS facilities before they get here, but the API is public.
            hasStars = starsConfig is not null && starsConfig.Value.ValueKind != JsonValueKind.Null,
            // Which id to ask the TRACK feed for. Usually the facility's own; see resolveFeedId.
            feedFacilityId = resolveFeedId?.Invoke(facilityId, InternalAirports(starsConfig)) ?? facilityId,
            videoMaps,
        };
    }

    // ── Video-map content (Phase 2) ─────────────────────────────────────────
    //
    // CRCMapImporter.cs lines 28-30 builds the path from a sibling VideoMaps
    // folder of the artcc JSON file. We replicate that layout:
    //   <crcExportRoot>/<artccId>/VideoMaps/<mapId>.geojson

    /// <summary>mapId → lastUpdatedAt for one ARTCC, from its published catalog.</summary>
    private async Task<Dictionary<string, DateTime>> GetMapStampsAsync(string artccId)
    {
        if (_mapStamps.TryGetValue(artccId, out var cached)) return cached;
        var stamps = new Dictionary<string, DateTime>(StringComparer.OrdinalIgnoreCase);
        var doc = await GetArtccAsync(artccId);
        if (doc is not null
            && doc.RootElement.TryGetProperty("videoMaps", out var maps)
            && maps.ValueKind == JsonValueKind.Array)
        {
            foreach (var m in maps.EnumerateArray())
                if (m.TryGetProperty("id", out var idEl) && idEl.GetString() is { Length: > 0 } id
                    && m.TryGetProperty("lastUpdatedAt", out var tEl)
                    && tEl.TryGetDateTime(out var t))
                    stamps[id] = t.ToUniversalTime();
        }
        _mapStamps[artccId] = stamps;
        return stamps;
    }

    // ── Keeping the mirror current, and keeping the local copy ours ─────────
    //
    // Fetch-on-demand keeps a map fresh once somebody opens it, which is not the same as the
    // mirror being current: a map nobody looked at this month stays stale until they do. After
    // each catalog refresh we therefore sweep what we already hold and re-pull only the files the
    // catalog says have changed.
    //
    // Two rules guard the local copy, because it is what's left if vNAS is unreachable or wrong:
    //
    //   * a replacement must parse as GeoJSON, and must not take a map that had features down to
    //     zero. Nothing here is signed, so authenticity can't be checked — but refusing to
    //     overwrite good geometry with something that isn't geometry is cheap and catches both a
    //     truncated download and an error page served with a 200.
    //   * the version being replaced is kept, one generation, under _backup/.
    //
    // Nothing is ever deleted because the catalog stopped listing it. If vNAS loses a map or
    // serves a short catalog, our copy is the one that survives.
    private const int SweepMaxDownloads = 500;      // per sweep — a mass re-publish shouldn't thrash the SD card
    private static readonly TimeSpan SweepPace = TimeSpan.FromMilliseconds(100);

    public record SyncStatus(DateTime? LastRunUtc, int Checked, int Stale, int Updated,
                             int Failed, int Rejected, bool Capped);
    private volatile SyncStatus _sync = new(null, 0, 0, 0, 0, 0, false);
    public SyncStatus Sync => _sync;

    private string BackupPath(string artccId, string mapId)
        => Path.Combine(_crcExportRoot, "_backup", artccId, mapId + ".geojson");

    /// <summary>Does this parse as GeoJSON, and how many features does it carry?</summary>
    private static bool LooksLikeGeoJson(byte[] bytes, out int features)
    {
        features = 0;
        try
        {
            using var doc = JsonDocument.Parse(bytes);
            if (doc.RootElement.ValueKind != JsonValueKind.Object) return false;
            if (!doc.RootElement.TryGetProperty("type", out var t) || t.GetString() is not string ty)
                return false;
            if (doc.RootElement.TryGetProperty("features", out var f) && f.ValueKind == JsonValueKind.Array)
                features = f.GetArrayLength();
            return ty is "FeatureCollection" or "GeometryCollection" or "Feature";
        }
        catch { return false; }
    }

    /// <summary>Validate, back up the old version, then replace. False = kept what we had.</summary>
    private bool StoreMap(string path, byte[] bytes, string artccId, string mapId)
    {
        if (!LooksLikeGeoJson(bytes, out var newFeatures))
        {
            Console.Error.WriteLine($"[STARS] video map {artccId}/{mapId}: not GeoJSON ({bytes.Length} B) — keeping local copy");
            return false;
        }
        if (File.Exists(path))
        {
            try
            {
                if (LooksLikeGeoJson(File.ReadAllBytes(path), out var oldFeatures)
                    && oldFeatures > 0 && newFeatures == 0)
                {
                    Console.Error.WriteLine($"[STARS] video map {artccId}/{mapId}: {oldFeatures} features → 0 — keeping local copy");
                    return false;
                }
            }
            catch { /* unreadable local copy — let the replacement through */ }
            try
            {
                var bak = BackupPath(artccId, mapId);
                Directory.CreateDirectory(Path.GetDirectoryName(bak)!);
                File.Copy(path, bak, overwrite: true);
            }
            catch { /* backup best-effort — never block an update on it */ }
        }
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            var tmp = path + ".tmp";
            File.WriteAllBytes(tmp, bytes);
            File.Move(tmp, path, overwrite: true);      // atomic, so a crash can't leave a half file
            File.SetLastWriteTimeUtc(path, DateTime.UtcNow);
            return true;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[STARS] video map {artccId}/{mapId} write: {ex.Message}");
            return false;
        }
    }

    private async Task<byte[]?> DownloadMapAsync(string artccId, string mapId)
    {
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Get,
                $"{_videoMapBase}/{artccId}/{mapId}.geojson");
            // The file store is public. These are sent only if set, in case vNAS ever gates it.
            if (VnasToken is { Length: > 0 })
                req.Headers.TryAddWithoutValidation("Authorization",
                    VnasToken.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase) ? VnasToken : "Bearer " + VnasToken);
            if (VnasCookie is { Length: > 0 })
                req.Headers.TryAddWithoutValidation("Cookie", VnasCookie);

            using var resp = await _http.SendAsync(req);
            if (resp.IsSuccessStatusCode) return await resp.Content.ReadAsByteArrayAsync();
            Console.WriteLine($"[STARS] video map {artccId}/{mapId} -> {(int)resp.StatusCode}");
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[STARS] video map {artccId}/{mapId}: {ex.Message}");
        }
        return null;
    }

    /// <summary>Re-pull cached maps the catalog says have changed. Only ARTCCs we already hold.</summary>
    private async Task SweepStaleMapsAsync()
    {
        int seen = 0, stale = 0, updated = 0, failed = 0, rejected = 0;
        bool capped = false;
        foreach (var artccId in await GetArtccIdsAsync())
        {
            var dir = Path.Combine(_crcExportRoot, artccId, "VideoMaps");
            if (!Directory.Exists(dir)) continue;          // only maintain what this box already mirrors
            Dictionary<string, DateTime> stamps;
            try { stamps = await GetMapStampsAsync(artccId); }
            catch { continue; }
            if (stamps.Count == 0) continue;               // no catalog → nothing to compare against

            foreach (var file in Directory.GetFiles(dir, "*.geojson"))
            {
                var mapId = Path.GetFileNameWithoutExtension(file);
                // Not in the catalog any more: keep it. A map we hold and vNAS forgot is exactly
                // the copy worth having.
                if (!stamps.TryGetValue(mapId, out var published)) continue;
                seen++;
                if (File.GetLastWriteTimeUtc(file) >= published) continue;
                stale++;
                if (updated + failed + rejected >= SweepMaxDownloads) { capped = true; continue; }

                var bytes = await DownloadMapAsync(artccId, mapId);
                if (bytes is null) { failed++; }
                else if (StoreMap(file, bytes, artccId, mapId)) { updated++; }
                else { rejected++; }
                await Task.Delay(SweepPace);
            }
        }
        _sync = new SyncStatus(DateTime.UtcNow, seen, stale, updated, failed, rejected, capped);
        Console.WriteLine($"[STARS] video map sweep: {seen} checked, {stale} stale, "
            + $"{updated} updated, {failed} failed, {rejected} rejected"
            + (capped ? $" (capped at {SweepMaxDownloads}; next sweep continues)" : ""));
    }

    /// <summary>Every video-map id this ARTCC publishes, whether or not we hold a copy.</summary>
    public async Task<string[]> ListPublishedVideoMapIdsAsync(string artccId)
        => (await GetMapStampsAsync(artccId)).Keys.ToArray();

    public async Task<(string contentType, byte[] bytes)?> GetVideoMapGeoJsonAsync(
        string artccId, string mapId)
    {
        artccId = artccId.ToUpperInvariant();
        var path = Path.Combine(_crcExportRoot, artccId, "VideoMaps", mapId + ".geojson");
        var have = File.Exists(path);

        // Serve the cached copy only if it is at least as new as the published map. Presence alone
        // is not freshness: a seeded export tree goes stale silently, and the maps on the Pi had
        // drifted from the current catalog by dozens of files per ARTCC before this.
        if (have)
        {
            DateTime? published = null;
            try
            {
                if ((await GetMapStampsAsync(artccId)).TryGetValue(mapId, out var t)) published = t;
            }
            catch { /* no catalog → trust what we have rather than refetch everything */ }

            if (published is null || File.GetLastWriteTimeUtc(path) >= published)
                return ("application/geo+json", await File.ReadAllBytesAsync(path));
        }

        var fetched = await DownloadMapAsync(artccId, mapId);
        if (fetched is not null && StoreMap(path, fetched, artccId, mapId))
            return ("application/geo+json", fetched);

        // Download failed, or the replacement was rejected. A stale copy still draws the right
        // airport, which beats a blank scope; after that, last generation's backup.
        if (have) return ("application/geo+json", await File.ReadAllBytesAsync(path));
        var bak = BackupPath(artccId, mapId);
        if (File.Exists(bak)) return ("application/geo+json", await File.ReadAllBytesAsync(bak));
        return null;
    }

    /// <summary>Video map IDs currently cached on disk for an ARTCC.</summary>
    public string[] ListAvailableVideoMapIds(string artccId)
    {
        var dir = Path.Combine(_crcExportRoot, artccId, "VideoMaps");
        if (!Directory.Exists(dir)) return Array.Empty<string>();
        return Directory.GetFiles(dir, "*.geojson")
            .Select(p => Path.GetFileNameWithoutExtension(p))
            .Where(s => s is not null)
            .ToArray()!;
    }

    /// <summary>Path to the user's local CRC install video map directory.
    /// Matches what github.com/yanjz124/DGScope-profile-manager reads from.
    /// Default %LOCALAPPDATA%/CRC/VideoMaps; can be overridden.</summary>
    public string CrcInstallVideoMapsDir { get; set; } =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "CRC", "VideoMaps");

    /// <summary>Import an ARTCC's video maps from the local CRC install
    /// (%LOCALAPPDATA%/CRC/VideoMaps/{artccId}/*.geojson) into our crc-export
    /// tree. Returns the count of imported files.</summary>
    public ImportResult ImportFromCrcInstall(string artccId)
    {
        var src = Path.Combine(CrcInstallVideoMapsDir, artccId);
        if (!Directory.Exists(src))
            return new ImportResult(0, $"Source not found: {src}");

        var dst = Path.Combine(_crcExportRoot, artccId, "VideoMaps");
        Directory.CreateDirectory(dst);

        int imported = 0;
        foreach (var file in Directory.GetFiles(src, "*.geojson"))
        {
            var destPath = Path.Combine(dst, Path.GetFileName(file));
            File.Copy(file, destPath, overwrite: true);
            imported++;
        }
        return new ImportResult(imported, null);
    }

    public record ImportResult(int Imported, string? Error);

    // ── DGScope profile XML import (Phase 4 polish) ─────────────────────────
    /// <summary>Profile root: %LOCALAPPDATA%/DGScope Profile Manager/profiles/profiles/{ARTCC}/*.xml</summary>
    public string ProfileRoot { get; set; } =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "DGScope Profile Manager", "profiles", "profiles");

    public string[] ListProfiles(string artccId)
    {
        var dir = Path.Combine(ProfileRoot, artccId);
        if (!Directory.Exists(dir)) return Array.Empty<string>();
        return Directory.GetFiles(dir, "*.xml")
            .Select(p => Path.GetFileNameWithoutExtension(p)!)
            .OrderBy(s => s)
            .ToArray();
    }

    /// <summary>Parse a DGScope profile XML into the subset of fields the
    /// web port honors. Keys mirror scope/RadarWindow.cs + STARS/PrefSet.cs
    /// + STARS/TCP.cs property names so the frontend can apply them
    /// directly to its PrefSet copy.</summary>
    public object? LoadProfile(string artccId, string profileName)
    {
        var path = Path.Combine(ProfileRoot, artccId, profileName + ".xml");
        if (!File.Exists(path)) return null;
        var doc = System.Xml.Linq.XDocument.Load(path);
        var root = doc.Root;
        if (root is null) return null;

        string? S(string name) => root.Element(name)?.Value;
        int? I(string name) { var v = S(name); return int.TryParse(v, out var n) ? n : (int?)null; }
        double? D(string name) { var v = S(name); return double.TryParse(v, out var n) ? n : (double?)null; }
        bool? B(string name) { var v = S(name); return bool.TryParse(v, out var n) ? n : (bool?)null; }

        // PrefSet wrapper - DGScope profiles store the active set as
        // <CurrentPrefSet> with all PrefSet fields nested inside it.
        var prefSet = root.Element("CurrentPrefSet")
                  ?? root.Element("PrefSet")
                  ?? root.Elements("PrefSet").FirstOrDefault();
        var psSrc = prefSet ?? root;

        // ScreenCenterPoint - lives inside <CurrentPrefSet>, not at root.
        var sc = psSrc.Element("ScreenCenterPoint") ?? root.Element("ScreenCenterPoint");
        var center = sc is null ? null : new
        {
            Latitude = double.TryParse(sc.Element("Latitude")?.Value, out var la) ? la : 0,
            Longitude = double.TryParse(sc.Element("Longitude")?.Value, out var lo) ? lo : 0,
        };

        int? PI(string name) { var v = psSrc.Element(name)?.Value; return int.TryParse(v, out var n) ? n : (int?)null; }
        double? PD(string name) { var v = psSrc.Element(name)?.Value; return double.TryParse(v, out var n) ? n : (double?)null; }
        bool? PB(string name) { var v = psSrc.Element(name)?.Value; return bool.TryParse(v, out var n) ? n : (bool?)null; }

        // DCBMapList — TCP.DCBMapList[i] = starsId
        var tcp = root.Element("TCP");
        var dcbMapList = tcp?.Element("DCBMapList")?.Elements("int")
            .Select(e => int.TryParse(e.Value, out var n) ? n : -1).ToArray()
            ?? Array.Empty<int>();

        // DisplayedMaps — initially visible starsIds
        var displayed = psSrc.Element("DisplayedMaps")?.Elements()
            .Select(e => int.TryParse(e.Value, out var n) ? n : -1).Where(n => n >= 0).ToArray()
            ?? Array.Empty<int>();

        // Brightness — match field names from PrefSet.cs BrightnessSettings
        var brSrc = psSrc.Element("Brightness");
        Dictionary<string, int> brightness = new();
        if (brSrc is not null)
        {
            foreach (var e in brSrc.Elements())
                if (int.TryParse(e.Value, out var n))
                    brightness[e.Name.LocalName] = n;
        }

        return new
        {
            artccId,
            profileName,
            screenRotation = D("ScreenRotation"),
            screenCenterPoint = center,
            displayedMaps = displayed,
            tcp = new
            {
                dcbMapList,
            },
            prefSet = new
            {
                Range = PI("Range"),
                RangeRingSpacing = PI("RangeRingSpacing"),
                DCBLocation = psSrc.Element("DCBLocation")?.Value,
                DCBVisible = PB("DCBVisible"),
                HistoryNum = PI("HistoryNum"),
                HistoryRate = PD("HistoryRate"),
                LeaderLength = PI("LeaderLength"),
                PTLLength = PD("PTLLength"),
                AltitudeFilterAssociatedMin = PI("AltitudeFilterAssociatedMin"),
                AltitudeFilterAssociatedMax = PI("AltitudeFilterAssociatedMax"),
                AltitudeFilterUnAssociatedMin = PI("AltitudeFilterUnAssociatedMin"),
                AltitudeFilterUnAssociatedMax = PI("AltitudeFilterUnAssociatedMax"),
                Brightness = brightness,
            },
        };
    }

    /// <summary>The airports a TRACON works, from its vNAS config — the candidates for a feed id
    /// when the facility's own id isn't what the track feed publishes.</summary>
    private static string[] InternalAirports(JsonElement? starsConfig)
    {
        if (starsConfig is not { } sc || sc.ValueKind != JsonValueKind.Object
            || !sc.TryGetProperty("internalAirports", out var ia)
            || ia.ValueKind != JsonValueKind.Array)
            return Array.Empty<string>();
        return ia.EnumerateArray()
                 .Select(e => e.GetString())
                 .Where(x => !string.IsNullOrWhiteSpace(x))
                 .Select(x => x!.Trim().ToUpperInvariant())
                 .Distinct(StringComparer.OrdinalIgnoreCase)
                 .ToArray();
    }

    private static JsonElement? FindFacility(JsonElement node, string targetId)
    {
        // Case-insensitive: the route accepts any case, and /stars/zma/pbi is a URL people type.
        // This used to be `==`, so a lowercase facility id 404'd here while the ARTCC id (looked up
        // in an OrdinalIgnoreCase dictionary) worked — the scope then got a 404 body where it
        // expected a facility and drew an empty screen without saying why.
        if (node.TryGetProperty("id", out var idEl)
            && string.Equals(idEl.GetString(), targetId, StringComparison.OrdinalIgnoreCase))
            return node;
        if (node.TryGetProperty("childFacilities", out var children)
            && children.ValueKind == JsonValueKind.Array)
        {
            foreach (var child in children.EnumerateArray())
            {
                var found = FindFacility(child, targetId);
                if (found.HasValue) return found;
            }
        }
        return null;
    }
}
