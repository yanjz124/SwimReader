using System.Text.Json;
using System.Text.Json.Serialization;

namespace SwimServer;

/// <summary>
/// ERAM sector geometry from vNAS: <b>Fixed Airspace Volumes</b> (FAVs), the thing ERAM actually
/// sectorizes with.
///
/// <para><b>Why this exists.</b> The ERAM scope's boundaries come from <c>AllSectors.kml</c> — a
/// 4.5 MB file dated April 2025, not in the repo, parsed in the browser on every page load. It is
/// flat 2-D rings bucketed into four categories by scraping a KML folder name, with altitude as a
/// free-text string (<c>"240-ABV"</c>, 27 distinct spellings for ZDC alone), and it needs a regex
/// fallback for the western ARTCCs because 204 of its 2,124 placemarks carry no folder path at
/// all. A sector whose shape changes with altitude cannot be expressed in it.</para>
///
/// <para><b>What FAVs give instead</b>, measured 2026-11-03 over all 24 ARTCCs: 2,641 volumes,
/// 4,504 modules, 75,185 boundary points. A FAV is one sector's airspace; its <b>modules</b> are
/// altitude slabs, each with its own polygon and explicit <c>lowerAlt</c>/<c>upperAlt</c> in feet.
/// ZDC's Gordonsville 32 is three stacked slabs — 21,100-23,000 / 23,100-27,000 / 27,100-33,400,
/// each a different shape. For ZDC that is 141 volumes and 365 modules against the KML's 78
/// placemarks, and vNAS's ERAM data is stamped 2026-10-22 against the KML's April 2025.</para>
///
/// <para><b>Endpoint:</b> <c>{dataApiBaseUrl}/favs/{ARTCC}</c> — public, no auth. The base URL is
/// resolved from <c>configuration.vnas.vatsim.net</c> rather than hardcoded, for the same reason
/// <see cref="StarsBridge"/> resolves the video-map base: CRC hardcodes no endpoints.</para>
///
/// <para><b>The API filters on User-Agent.</b> curl gets 200, <c>Python-urllib/3.x</c> gets 403.
/// Our HttpClient sets one explicitly — without it this would fail in a way that looks like the
/// ARTCC having no data.</para>
///
/// <para><b>These ids are the join to the live picture.</b> <see cref="AirspaceBridge"/>'s AIXM
/// feed already reports, per ERAM position, the 5-digit volume ids that position owns — e.g. ZDV
/// position 07 owning <c>00701, 00702, 00703, 00800, 06100, 06700</c>. Sampled against ZDV's FAV
/// set, <b>28 of 28 matched</b>. So AIXM says who owns which volume right now and this says what
/// shape that volume is; together they are the actual combined/decombined sectorization, which no
/// static KML can express. Nothing consumes the join yet.</para>
///
/// 20 of 24 ARTCCs publish FAVs. The four that don't (ZAN, ZHN, ZSU, ZUA — Anchorage, Honolulu,
/// San Juan, Guam) return an empty array, not an error.
/// </summary>
class VnasAirspace
{
    private const string ConfigUrl = "https://configuration.vnas.vatsim.net/";
    private const string DefaultApiBase = "https://data-api.vnas.vatsim.net/api";

    /// <summary>
    /// Altitudes at or above this are ERAM's "and above" encoding, not real feet. Evidence: no
    /// module has a *normal* ceiling above 98,990, while 464 modules pair a normal floor with a
    /// ceiling of 99,000-99,900 — e.g. ZAB 06701 runs 30,000 to 99,100, which is "FL300 and
    /// above". Those 464 are real airspace and dropping them would delete the top of every high
    /// sector; their ceiling is reported as unlimited instead.
    /// </summary>
    private const int UnlimitedAlt = 99000;

    /// <summary>
    /// ERAM states a module's ceiling as the last 100 ft level it includes, and the slab above
    /// starts 100 ft higher — measured, 1,805 of ~1,830 consecutive module pairs gap by exactly
    /// +100 ft. So 23,000 and 23,100 are adjacent, not 100 ft apart with a void between them, and
    /// an overlap test taken literally returns NOTHING for an aircraft reporting 23,050. Queries
    /// therefore treat a ceiling of C as covering up to C+99; the reported upperAlt is untouched.
    /// </summary>
    private const int BandStepFt = 100;

    private readonly HttpClient _http;
    private readonly string _cacheDir;
    private string _apiBase = DefaultApiBase;

    // ARTCC → its volumes. Replaced wholesale per ARTCC on refresh, so readers never see a partial set.
    private readonly Dictionary<string, ArtccAirspace> _byArtcc = new(StringComparer.OrdinalIgnoreCase);
    private readonly object _gate = new();

    private DateTime? _lastRefresh;
    private string? _lastError;

    public VnasAirspace(HttpClient http, string cacheDir)
    {
        _http = http;
        _cacheDir = cacheDir;
    }

    // ── Model ────────────────────────────────────────────────────────────────

    private sealed record ArtccAirspace(
        string Artcc, List<Fav> Favs, string? EramDataUpdatedAt, DateTime FetchedAt, bool FromCache);

    private sealed class Fav
    {
        public string FavId { get; set; } = "";
        public List<Module> Modules { get; set; } = new();
        public List<Module> ExcludeModules { get; set; } = new();

        /// <summary>
        /// <c>favId</c> is five characters, <c>{sector:3}{volume:2}</c>: ZDC's 00701 and 00702 are
        /// the two volumes of sector 7. Verified against the published sector list — all 54 ZDC
        /// sectors have at least one FAV, and the prefix matches
        /// <c>eramConfiguration.sectors[].sectorId</c> exactly.
        /// </summary>
        public string? Sector => FavId.Length == 5 ? FavId[..3] : null;
    }

    private sealed class Module
    {
        public int ModuleId { get; set; }
        public int LowerAlt { get; set; }
        public int UpperAlt { get; set; }
        public Boundary? Boundary { get; set; }
    }

    private sealed class Boundary
    {
        public List<Pt>? Points { get; set; }
    }

    private sealed class Pt
    {
        public double Lat { get; set; }
        public double Lon { get; set; }
    }

    private sealed record Summary(
        [property: JsonPropertyName("id")] string Id,
        [property: JsonPropertyName("eramDataLastUpdatedAt")] string? EramDataLastUpdatedAt);

    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNameCaseInsensitive = true,
    };

    // ── Refresh ──────────────────────────────────────────────────────────────

    /// <summary>
    /// The <c>eramDataLastUpdatedAt</c> each cached file was fetched for. Without it a restart
    /// cannot tell a current cache from a stale one, so it re-downloads all 20 ARTCCs — 4.3 MB —
    /// every time, and the auto-deploy timer restarts on every backend push. Kept as one small
    /// sidecar rather than inside each file so the cached body stays byte-identical to what vNAS
    /// served.
    /// </summary>
    private const string StampFile = "_fetched.json";

    /// <summary>Load whatever is cached on disk, so a restart serves geometry before any fetch.</summary>
    public void LoadCache()
    {
        if (!Directory.Exists(_cacheDir)) return;
        Dictionary<string, string> stamps;
        try
        {
            var sp = Path.Combine(_cacheDir, StampFile);
            stamps = File.Exists(sp)
                ? JsonSerializer.Deserialize<Dictionary<string, string>>(File.ReadAllText(sp), Json) ?? new()
                : new();
        }
        catch { stamps = new(); }

        int n = 0, vols = 0, stamped = 0;
        foreach (var path in Directory.EnumerateFiles(_cacheDir, "*.json"))
        {
            var artcc = Path.GetFileNameWithoutExtension(path).ToUpperInvariant();
            if (string.Equals(Path.GetFileName(path), StampFile, StringComparison.OrdinalIgnoreCase)) continue;
            try
            {
                var favs = JsonSerializer.Deserialize<List<Fav>>(File.ReadAllText(path), Json);
                if (favs is null) continue;
                stamps.TryGetValue(artcc, out var stamp);
                if (stamp != null) stamped++;
                lock (_gate)
                    _byArtcc[artcc] = new ArtccAirspace(artcc, favs, stamp, File.GetLastWriteTimeUtc(path), true);
                n++; vols += favs.Count;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[FAV] cached {artcc} unreadable: {ex.Message}");
            }
        }
        if (n > 0)
            Console.WriteLine($"[FAV] loaded {vols} FAVs for {n} ARTCC(s) from cache ({stamped} with a freshness stamp)");
    }

    private void SaveStamps()
    {
        try
        {
            Dictionary<string, string> stamps;
            lock (_gate)
                stamps = _byArtcc.Values.Where(a => a.EramDataUpdatedAt != null)
                    .ToDictionary(a => a.Artcc, a => a.EramDataUpdatedAt!);
            var path = Path.Combine(_cacheDir, StampFile);
            var tmp = path + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(stamps));
            File.Move(tmp, path, overwrite: true);
        }
        catch (Exception ex) { Console.Error.WriteLine($"[FAV] stamps: {ex.Message}"); }
    }

    public async Task RunAsync(CancellationToken ct = default)
    {
        LoadCache();
        while (!ct.IsCancellationRequested)
        {
            try { await RefreshAsync(ct); }
            catch (Exception ex) { _lastError = ex.Message; Console.Error.WriteLine($"[FAV] refresh: {ex.Message}"); }
            try { await Task.Delay(TimeSpan.FromHours(24), ct); }
            catch (OperationCanceledException) { return; }
        }
    }

    private async Task ResolveApiBaseAsync(CancellationToken ct)
    {
        try
        {
            using var doc = JsonDocument.Parse(await _http.GetStringAsync(ConfigUrl, ct));
            if (doc.RootElement.TryGetProperty("dataApiBaseUrl", out var v)
                && v.GetString() is { Length: > 0 } url)
            {
                url = url.TrimEnd('/');
                if (!string.Equals(url, _apiBase, StringComparison.Ordinal))
                    Console.WriteLine($"[FAV] vNAS dataApiBaseUrl = {url}");
                _apiBase = url;
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[FAV] vNAS config: {ex.Message} (keeping {_apiBase})");
        }
    }

    public async Task RefreshAsync(CancellationToken ct = default)
    {
        await ResolveApiBaseAsync(ct);
        var summaries = JsonSerializer.Deserialize<List<Summary>>(
            await _http.GetStringAsync($"{_apiBase}/artcc-summaries", ct), Json) ?? new();

        int fetched = 0, skipped = 0, empty = 0, failed = 0;
        foreach (var s in summaries.OrderBy(s => s.Id))
        {
            ct.ThrowIfCancellationRequested();
            // Freshness is the ARTCC's own eramDataLastUpdatedAt, the same rule the video-map
            // cache uses: presence on disk is not freshness.
            lock (_gate)
            {
                if (_byArtcc.TryGetValue(s.Id, out var held)
                    && held.EramDataUpdatedAt is { } have
                    && string.Equals(have, s.EramDataLastUpdatedAt, StringComparison.Ordinal))
                { skipped++; continue; }
            }

            try
            {
                var body = await _http.GetStringAsync($"{_apiBase}/favs/{s.Id}", ct);
                var favs = JsonSerializer.Deserialize<List<Fav>>(body, Json);
                if (favs is null) { failed++; continue; }
                if (favs.Count == 0)
                {
                    // ZAN / ZHN / ZSU / ZUA publish none. That is the real answer, not a failure,
                    // but it must not overwrite a cached set that does have geometry.
                    empty++;
                    lock (_gate)
                    {
                        if (_byArtcc.TryGetValue(s.Id, out var prev) && prev.Favs.Count > 0) continue;
                        _byArtcc[s.Id] = new ArtccAirspace(s.Id, favs, s.EramDataLastUpdatedAt, DateTime.UtcNow, false);
                    }
                    continue;
                }

                lock (_gate)
                    _byArtcc[s.Id] = new ArtccAirspace(s.Id, favs, s.EramDataLastUpdatedAt, DateTime.UtcNow, false);
                SaveCache(s.Id, body);
                fetched++;
            }
            catch (Exception ex)
            {
                failed++;
                Console.Error.WriteLine($"[FAV] {s.Id}: {ex.Message}");
            }
            await Task.Delay(100, ct);   // paced, same courtesy as the video-map sweep
        }

        _lastRefresh = DateTime.UtcNow;
        _lastError = failed > 0 ? $"{failed} ARTCC(s) failed" : null;
        SaveStamps();
        Console.WriteLine($"[FAV] {fetched} fetched, {skipped} unchanged, {empty} publish none, {failed} failed");
    }

    private void SaveCache(string artcc, string body)
    {
        try
        {
            Directory.CreateDirectory(_cacheDir);
            var path = Path.Combine(_cacheDir, artcc.ToUpperInvariant() + ".json");
            var tmp = path + ".tmp";
            File.WriteAllText(tmp, body);
            File.Move(tmp, path, overwrite: true);
        }
        catch (Exception ex) { Console.Error.WriteLine($"[FAV] cache {artcc}: {ex.Message}"); }
    }

    // ── Queries ──────────────────────────────────────────────────────────────

    public object Status()
    {
        lock (_gate)
        {
            var rows = _byArtcc.Values.OrderBy(a => a.Artcc).Select(a =>
            {
                var mods = a.Favs.SelectMany(f => f.Modules).ToList();
                return (object)new
                {
                    artcc = a.Artcc,
                    favs = a.Favs.Count,
                    modules = mods.Count,
                    sectors = a.Favs.Select(f => f.Sector).Where(s => s != null).Distinct().Count(),
                    points = mods.Sum(m => m.Boundary?.Points?.Count ?? 0),
                    unlimitedCeiling = mods.Count(m => m.UpperAlt >= UnlimitedAlt && m.LowerAlt < UnlimitedAlt),
                    sentinelOnly = mods.Count(m => m.LowerAlt >= UnlimitedAlt),
                    eramDataUpdatedAt = a.EramDataUpdatedAt,
                    fetchedAt = a.FetchedAt,
                    fromCache = a.FromCache,
                };
            }).ToArray();
            return new
            {
                artccs = rows.Length,
                withGeometry = _byArtcc.Values.Count(a => a.Favs.Count > 0),
                lastRefresh = _lastRefresh,
                error = _lastError,
                apiBase = _apiBase,
                rows,
            };
        }
    }

    /// <summary>
    /// One ARTCC's airspace as a GeoJSON FeatureCollection, one Feature per module.
    ///
    /// <para><paramref name="lowFt"/>/<paramref name="highFt"/> keep only the modules that overlap
    /// that band. Bands are <b>inclusive</b> and tile with a 100 ft step — measured, 1,805 of
    /// ~1,830 consecutive module pairs gap by exactly +100 — so the overlap test is
    /// <c>lower &lt;= high &amp;&amp; upper &gt;= low</c> and a slab ending at 23,000 does not
    /// hide a request for 23,050.</para>
    /// </summary>
    public object? GeoJson(string artcc, int? lowFt = null, int? highFt = null,
                           string? sector = null, bool includeSentinel = false)
    {
        ArtccAirspace? a;
        lock (_gate) { if (!_byArtcc.TryGetValue(artcc, out a)) return null; }

        var features = new List<object>();
        foreach (var fav in a.Favs)
        {
            if (sector != null && !string.Equals(fav.Sector, sector.PadLeft(3, '0'), StringComparison.OrdinalIgnoreCase))
                continue;
            foreach (var m in fav.Modules) Add(m, false);
            // Exclude modules are a 3-D subtraction with their OWN altitude band, not a hole in
            // the polygon: only 38 of 382 share a band with any parent module, and ZAU 01101
            // subtracts just the bottom 100 ft of a 0-10,000 volume. Emitting them as GeoJSON
            // interior rings would remove that area at every altitude of the feature, so they
            // travel as their own features and the consumer decides.
            foreach (var m in fav.ExcludeModules) Add(m, true);

            void Add(Module m, bool exclude)
            {
                var ring = Ring(m);
                if (ring is null) return;
                bool sentinel = m.LowerAlt >= UnlimitedAlt;
                if (sentinel && !includeSentinel) return;
                bool unlimited = m.UpperAlt >= UnlimitedAlt;
                if (!sentinel && (lowFt.HasValue || highFt.HasValue))
                {
                    int lo = lowFt ?? int.MinValue;
                    int hi = highFt ?? int.MaxValue;
                    int top = unlimited ? int.MaxValue : m.UpperAlt + BandStepFt - 1;
                    if (m.LowerAlt > hi || top < lo) return;
                }
                features.Add(new
                {
                    type = "Feature",
                    geometry = new { type = "Polygon", coordinates = new[] { ring } },
                    properties = new
                    {
                        artcc = a.Artcc,
                        favId = fav.FavId,
                        sector = fav.Sector,
                        moduleId = m.ModuleId,
                        lowerAlt = m.LowerAlt,
                        upperAlt = unlimited ? (int?)null : m.UpperAlt,
                        unlimitedCeiling = unlimited,
                        exclude,
                        sentinel,
                    },
                });
            }
        }

        return new
        {
            type = "FeatureCollection",
            artcc = a.Artcc,
            eramDataUpdatedAt = a.EramDataUpdatedAt,
            features,
        };
    }

    /// <summary>
    /// A module's boundary as a GeoJSON linear ring. <b>Nothing arrives closed</b> — all 4,886
    /// rings in the feed end at a different point from where they start — so the first point is
    /// repeated here; without that the polygon is invalid and renderers disagree about what to do
    /// with it.
    /// </summary>
    private static double[][]? Ring(Module m)
    {
        var pts = m.Boundary?.Points;
        if (pts is null || pts.Count < 3) return null;
        var ring = new double[pts.Count + 1][];
        for (int i = 0; i < pts.Count; i++) ring[i] = new[] { pts[i].Lon, pts[i].Lat };
        ring[pts.Count] = ring[0];
        return ring;
    }
}
