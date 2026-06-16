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
            await Task.Delay(TimeSpan.FromHours(24));
        }
    }

    private async Task RefreshOnce()
    {
        var listJson = await _http.GetStringAsync("https://data-api.vnas.vatsim.net/api/artccs/");
        using var doc = JsonDocument.Parse(listJson);
        var ids = new List<string>();
        foreach (var item in doc.RootElement.EnumerateArray())
        {
            if (item.TryGetProperty("id", out var idEl) && idEl.GetString() is string id)
                ids.Add(id);
        }
        _artccIds = ids.OrderBy(x => x).ToArray();
        Console.WriteLine($"[STARS] vNAS: {_artccIds.Length} ARTCCs available");
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

    /// <summary>List of facilities (with their parents) that have a STARS
    /// configuration. CRCMapImporter.cs auto-picks if there's exactly one;
    /// the frontend handles that same logic.</summary>
    public async Task<object?> GetStarsFacilitiesAsync(string artccId)
    {
        var doc = await GetArtccAsync(artccId);
        if (doc is null) return null;
        var root = doc.RootElement;
        var results = new List<object>();
        if (root.TryGetProperty("facility", out var facility))
            CollectStarsFacilities(facility, parentId: null, results);
        return new { artccId, facilities = results };
    }

    private static void CollectStarsFacilities(JsonElement facility, string? parentId, List<object> results)
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
            int? areaCount = null;
            if (sc.TryGetProperty("videoMapIds", out var vmIds) && vmIds.ValueKind == JsonValueKind.Array)
                videoMapCount = vmIds.GetArrayLength();
            if (sc.TryGetProperty("areas", out var areas) && areas.ValueKind == JsonValueKind.Array)
                areaCount = areas.GetArrayLength();

            results.Add(new
            {
                id,
                name,
                type,
                parentId,
                videoMapCount,
                areaCount,
            });
        }

        if (facility.TryGetProperty("childFacilities", out var children)
            && children.ValueKind == JsonValueKind.Array)
        {
            foreach (var child in children.EnumerateArray())
                CollectStarsFacilities(child, id, results);
        }
    }

    /// <summary>Returns the STARS configuration for one facility, plus its
    /// location (for screen-center default) and the list of associated
    /// video map IDs. Mirrors what CRCMapImporter pulls from CRCARTCC.</summary>
    public async Task<object?> GetFacilityAsync(string artccId, string facilityId)
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
            videoMaps,
        };
    }

    // ── Video-map content (Phase 2) ─────────────────────────────────────────
    //
    // CRCMapImporter.cs lines 28-30 builds the path from a sibling VideoMaps
    // folder of the artcc JSON file. We replicate that layout:
    //   <crcExportRoot>/<artccId>/VideoMaps/<mapId>.geojson

    public async Task<(string contentType, byte[] bytes)?> GetVideoMapGeoJsonAsync(
        string artccId, string mapId)
    {
        var path = Path.Combine(_crcExportRoot, artccId, "VideoMaps", mapId + ".geojson");
        if (File.Exists(path))
        {
            var bytes = await File.ReadAllBytesAsync(path);
            return ("application/geo+json", bytes);
        }

        // Cache miss → fetch from the vNAS data API if a token/cookie is configured,
        // then cache to disk so future requests (and token expiry) are covered.
        if (VnasToken is { Length: > 0 } || VnasCookie is { Length: > 0 })
        {
            try
            {
                var url = $"https://data-api.vnas.vatsim.net/api/artccs/{artccId}/video-maps/{mapId}";
                using var req = new HttpRequestMessage(HttpMethod.Get, url);
                if (VnasToken is { Length: > 0 })
                    req.Headers.TryAddWithoutValidation("Authorization",
                        VnasToken.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase) ? VnasToken : "Bearer " + VnasToken);
                if (VnasCookie is { Length: > 0 })
                    req.Headers.TryAddWithoutValidation("Cookie", VnasCookie);

                using var resp = await _http.SendAsync(req);
                if (resp.IsSuccessStatusCode)
                {
                    var bytes = await resp.Content.ReadAsByteArrayAsync();
                    try
                    {
                        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                        await File.WriteAllBytesAsync(path, bytes);
                    }
                    catch { /* cache best-effort */ }
                    return ("application/geo+json", bytes);
                }
                Console.WriteLine($"[STARS] video map fetch {artccId}/{mapId} -> {(int)resp.StatusCode}");
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[STARS] video map fetch error {artccId}/{mapId}: {ex.Message}");
            }
        }
        return null;
    }

    /// <summary>List of video map IDs the export tree actually contains for an ARTCC.</summary>
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

    private static JsonElement? FindFacility(JsonElement node, string targetId)
    {
        if (node.TryGetProperty("id", out var idEl) && idEl.GetString() == targetId)
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
