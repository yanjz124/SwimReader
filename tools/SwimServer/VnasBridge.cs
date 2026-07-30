using System.Collections.Concurrent;
using System.Net.Http;
using System.Text.Json;

namespace SwimServer;

/// <summary>
/// Centralized vNAS adaptation data — everything we derive from data-api.vnas.vatsim.net's ARTCC
/// definitions in one place:
///   • <see cref="FixRules"/>     ICAO airport → ordered (pattern, code) for ASDE-X departure gate codes
///   • <see cref="SectorFreqs"/>  "FAC/SECTOR" → controller frequency (ERAM sectors and STARS TCPs)
///   • <see cref="TraconIds"/>    "ARTCC/starsId" → real TRACON id (SFDPS NAS-code resolution)
///
/// Fetched on startup and refreshed every 24h. Every healthy fetch is also written to a local cache
/// file, and the cache is loaded on startup — so a vNAS outage, an unreachable API, or a corrupt /
/// incomplete response falls back to the last known-good data instead of leaving the app blank. A
/// fetch is only committed (and cached) when it's complete and sane; a partial run keeps the
/// previous data rather than pruning airports it simply didn't reach this time.
///
/// (StarsBridge fetches vNAS STARS *profiles* and video-maps separately — that's per-facility scope
/// adaptation, a different concern, and stays there.)
/// </summary>
class VnasBridge
{
    public ConcurrentDictionary<string, List<KeyValuePair<string, string>>> FixRules { get; } =
        new(StringComparer.OrdinalIgnoreCase);
    public ConcurrentDictionary<string, string> SectorFreqs { get; } = new();
    public ConcurrentDictionary<string, string> TraconIds { get; } = new();

    private readonly string _cachePath;
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(30) };
    private const string ApiBase = "https://data-api.vnas.vatsim.net/api/artccs/";

    public VnasBridge(string cachePath) => _cachePath = cachePath;

    public void Start()
    {
        LoadCache();                 // seed from last-good so there's data even if the first fetch fails
        _ = Task.Run(RefreshLoop);
    }

    private async Task RefreshLoop()
    {
        while (true)
        {
            try { await FetchAll(); }
            catch (Exception ex) { Console.WriteLine($"[vNAS] refresh error: {ex.Message}"); }
            await Task.Delay(TimeSpan.FromHours(24));
        }
    }

    // ── fetch ────────────────────────────────────────────────────────────────
    private async Task FetchAll()
    {
        // Build into temp dicts so a partial/corrupt fetch never clobbers the live (cached) data.
        var fix = new ConcurrentDictionary<string, List<KeyValuePair<string, string>>>(StringComparer.OrdinalIgnoreCase);
        var freq = new ConcurrentDictionary<string, string>();
        var tracon = new ConcurrentDictionary<string, string>();

        var artccIds = new List<string>();
        var listJson = await _http.GetStringAsync(ApiBase);
        foreach (var a in JsonSerializer.Deserialize<JsonElement>(listJson).EnumerateArray())
            if (a.TryGetProperty("id", out var idEl) && idEl.GetString() is { Length: > 0 } id) artccIds.Add(id);
        if (artccIds.Count == 0) { Console.WriteLine("[vNAS] empty ARTCC list — keeping cached data"); return; }

        Console.WriteLine($"[vNAS] fetching {artccIds.Count} ARTCCs...");
        int totalRules = 0, totalAirports = 0, ok = 0;
        var sem = new SemaphoreSlim(4);
        var tasks = artccIds.Select(async artccId =>
        {
            await sem.WaitAsync();
            try
            {
                var json = await _http.GetStringAsync(ApiBase + artccId + "/");
                var facility = JsonSerializer.Deserialize<JsonElement>(json).GetProperty("facility");
                Scan(facility, fix, freq, tracon, ref totalRules, ref totalAirports);
                Interlocked.Increment(ref ok);
            }
            catch (Exception ex) { Console.Error.WriteLine($"[vNAS] {artccId}: {ex.Message}"); }
            finally { sem.Release(); }
        });
        await Task.WhenAll(tasks);

        // Commit only a complete, sane fetch. A partial run (vNAS flaky) would prune good data via
        // Replace()'s key removal, so keep the previous (cached) data instead.
        bool healthy = ok >= artccIds.Count * 0.9 && tracon.Count >= 20 && freq.Count >= 50;
        if (!healthy)
        {
            Console.WriteLine($"[vNAS] fetch incomplete ({ok}/{artccIds.Count} ARTCCs, {freq.Count} freqs, {tracon.Count} tracons) — keeping cached data");
            return;
        }
        Replace(FixRules, fix); Replace(SectorFreqs, freq); Replace(TraconIds, tracon);
        SaveCache();
        Console.WriteLine($"[vNAS] loaded {totalRules} fix rules ({totalAirports} airports), {freq.Count} sector freqs, {tracon.Count} TRACON ids — cached");
    }

    // Overwrite live from src, then drop keys src no longer carries — never leaves live emptier than src.
    private static void Replace<TV>(ConcurrentDictionary<string, TV> live, ConcurrentDictionary<string, TV> src)
    {
        foreach (var kv in src) live[kv.Key] = kv.Value;
        foreach (var k in live.Keys.ToList()) if (!src.ContainsKey(k)) live.TryRemove(k, out _);
    }

    // ── per-facility scan (recurses into child facilities) ─────────────────────
    private static void Scan(JsonElement facility,
        ConcurrentDictionary<string, List<KeyValuePair<string, string>>> fix,
        ConcurrentDictionary<string, string> freq,
        ConcurrentDictionary<string, string> tracon,
        ref int totalRules, ref int totalAirports)
    {
        // ARTCC ERAM adaptation → NAS-code-to-TRACON map (only on the ARTCC node, which carries
        // eramConfiguration). Keyed "ARTCC/starsId" so SFDPS (reportingFacility, controllingFacility)
        // resolves to the real TRACON id without the cross-ARTCC placeholder collisions.
        if (facility.TryGetProperty("eramConfiguration", out var eramCfg) && eramCfg.ValueKind == JsonValueKind.Object
            && facility.TryGetProperty("id", out var artccIdEl) && artccIdEl.GetString() is { Length: > 0 } artccId
            && eramCfg.TryGetProperty("neighboringStarsConfigurations", out var nsc) && nsc.ValueKind == JsonValueKind.Array)
        {
            foreach (var n in nsc.EnumerateArray())
                if (n.TryGetProperty("starsId", out var sidEl) && sidEl.GetString() is { Length: > 0 } starsId
                    && n.TryGetProperty("facilityId", out var facEl) && facEl.GetString() is { Length: > 0 } facId)
                    tracon[$"{artccId}/{starsId}"] = facId;
        }

        // Scan controller positions for sector frequencies (ARTCC ERAM sectors and TRACON STARS TCPs
        // → freq), keyed "FAC/SECTOR". Wrapped so a malformed vNAS position can't abort the fix-rule scan.
        var posFacId = facility.TryGetProperty("id", out var fidEl) ? fidEl.GetString() ?? "" : "";
        if (posFacId.Length > 0)
        {
            try
            {
                // STARS: resolve tcpId → TCP code from starsConfiguration.tcps. The TCP code is
                // subset+sectorId (e.g. subset 1 + sectorId "J" = "1J"), which is exactly the "owner"
                // code STARS/TAIS reports (e.g. PCT/1J).
                var tcpToSector = new Dictionary<string, string>();
                if (facility.TryGetProperty("starsConfiguration", out var starsCfg) && starsCfg.ValueKind == JsonValueKind.Object
                    && starsCfg.TryGetProperty("tcps", out var tcps) && tcps.ValueKind == JsonValueKind.Array)
                {
                    foreach (var tcp in tcps.EnumerateArray())
                    {
                        if (tcp.TryGetProperty("id", out var tid) && tid.GetString() is { Length: > 0 } tidS
                            && tcp.TryGetProperty("sectorId", out var tsec) && tsec.GetString() is { Length: > 0 } tsecS)
                        {
                            var sub = tcp.TryGetProperty("subset", out var tsub) && tsub.ValueKind == JsonValueKind.Number
                                ? tsub.GetInt32().ToString() : "";
                            tcpToSector[tidS] = sub + tsecS;
                        }
                    }
                }

                if (facility.TryGetProperty("positions", out var positions) && positions.ValueKind == JsonValueKind.Array)
                {
                    foreach (var p in positions.EnumerateArray())
                    {
                        if (!p.TryGetProperty("frequency", out var fq) || fq.ValueKind != JsonValueKind.Number) continue;
                        var hz = fq.GetInt64();
                        if (hz <= 0) continue;
                        var mhz = (hz / 1_000_000.0).ToString("0.000");

                        // ERAM (ARTCC) sector.
                        if (p.TryGetProperty("eramConfiguration", out var eram) && eram.ValueKind == JsonValueKind.Object
                            && eram.TryGetProperty("sectorId", out var sid) && sid.GetString() is { Length: > 0 } sector)
                            freq[$"{posFacId}/{sector}"] = mhz;

                        // STARS (TRACON) TCP code → freq. First position wins so a combined-up position
                        // doesn't clobber the sector's own primary frequency.
                        if (p.TryGetProperty("starsConfiguration", out var pstars) && pstars.ValueKind == JsonValueKind.Object
                            && pstars.TryGetProperty("tcpId", out var ptcp) && ptcp.GetString() is { Length: > 0 } ptcpS
                            && tcpToSector.TryGetValue(ptcpS, out var pcode))
                            freq.TryAdd($"{posFacId}/{pcode}", mhz);
                    }
                }
            }
            catch { /* never let a frequency-scan hiccup break fix rules */ }
        }

        // asdexConfiguration.fixRules → departure gate codes.
        if (facility.TryGetProperty("asdexConfiguration", out var asdexConfig)
            && asdexConfig.TryGetProperty("fixRules", out var fixRulesArr)
            && fixRulesArr.GetArrayLength() > 0)
        {
            var facId = facility.GetProperty("id").GetString() ?? "";
            var icao = FaaToIcao(facId);
            var list = new List<KeyValuePair<string, string>>();
            foreach (var rule in fixRulesArr.EnumerateArray())
            {
                var pattern = rule.GetProperty("searchPattern").GetString()?.Trim().ToUpperInvariant();
                var code = rule.GetProperty("fixId").GetString()?.Trim().ToUpperInvariant();
                if (pattern is not null && code is not null && pattern.Length > 0 && code.Length > 0)
                    list.Add(new(pattern, code));
            }
            if (list.Count > 0)
            {
                fix[icao] = list;
                Interlocked.Add(ref totalRules, list.Count);
                Interlocked.Increment(ref totalAirports);
            }
        }

        // Recurse into child facilities.
        if (facility.TryGetProperty("childFacilities", out var children))
            foreach (var child in children.EnumerateArray())
                Scan(child, fix, freq, tracon, ref totalRules, ref totalAirports);
    }

    // ── local cache (fallback for vNAS outages) ────────────────────────────────
    private record Cache(
        Dictionary<string, List<KeyValuePair<string, string>>> FixRules,
        Dictionary<string, string> SectorFreqs,
        Dictionary<string, string> TraconIds);

    private void LoadCache()
    {
        try
        {
            if (!File.Exists(_cachePath)) return;
            var c = JsonSerializer.Deserialize<Cache>(File.ReadAllText(_cachePath));
            if (c is null) return;
            if (c.FixRules is { Count: > 0 }) foreach (var kv in c.FixRules) FixRules[kv.Key] = kv.Value;
            if (c.SectorFreqs is { Count: > 0 }) foreach (var kv in c.SectorFreqs) SectorFreqs[kv.Key] = kv.Value;
            if (c.TraconIds is { Count: > 0 }) foreach (var kv in c.TraconIds) TraconIds[kv.Key] = kv.Value;
            Console.WriteLine($"[vNAS] loaded cache: {FixRules.Count} airports, {SectorFreqs.Count} freqs, {TraconIds.Count} TRACON ids");
        }
        catch (Exception ex) { Console.WriteLine($"[vNAS] cache load error: {ex.Message}"); }
    }

    private void SaveCache()
    {
        try
        {
            var c = new Cache(
                FixRules.ToDictionary(kv => kv.Key, kv => kv.Value),
                SectorFreqs.ToDictionary(kv => kv.Key, kv => kv.Value),
                TraconIds.ToDictionary(kv => kv.Key, kv => kv.Value));
            var tmp = _cachePath + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(c));
            File.Move(tmp, _cachePath, overwrite: true);
        }
        catch (Exception ex) { Console.Error.WriteLine($"[vNAS] cache save error: {ex.Message}"); }
    }

    // FAA LID → ICAO (Alaska = PA, Hawaii = PH, else K; 4-char assumed already ICAO).
    private static string FaaToIcao(string faaLid)
    {
        if (faaLid.Length == 3)
        {
            if (faaLid is "HNL" or "OGG" or "LIH" or "KOA" or "ITO" or "MKK" or "LNY" or "JHM" or "HNM")
                return "PH" + faaLid;
            if (faaLid is "ANC" or "FAI" or "JNU" or "BET" or "SCC" or "ADQ" or "AKN" or "DLG" or "OME"
                or "OTZ" or "BRW" or "SIT" or "KTN" or "CDV" or "YAK" or "VDZ" or "MRI" or "ENA")
                return "PA" + faaLid;
            return "K" + faaLid;
        }
        return faaLid;
    }
}
