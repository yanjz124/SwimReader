using System.Collections.Concurrent;
using System.Text.Json;

namespace SwimServer;

/// <summary>
/// A searchable aircraft database built from the data SwimReader already sees on the live SWIM feed.
/// Every SFDPS flight carries a registration, Mode S code (ICAO 24-bit address), SELCAL, aircraft
/// type, operator and equipment; as flights are purged to flight-history they pass through here and
/// get rolled up per airframe. The result is one record per aircraft — keyed by ICAO 24 (falling back
/// to registration when no Mode S code was ever seen) — that people can search by tail number, hex,
/// SELCAL, callsign, operator or type.
///
/// This is deliberately self-contained: no external registry download, it fits the Pi, and it carries
/// SELCAL — which almost no public static database has, because SELCAL is only visible in the live
/// flight-plan feed. Coverage is "aircraft seen in US airspace since history retention began" rather
/// than "every airframe ever built"; a static FAA/OpenSky import could enrich it later.
///
/// Real identities are stored on disk (like flight-history already does); the API masks LADD-blocked
/// aircraft on output unless the request carries the reveal key.
/// </summary>
sealed class AircraftDb
{
    public static AircraftDb? Instance { get; private set; }

    private readonly ConcurrentDictionary<string, AircraftRecord> _byKey = new();
    private readonly string _dir;
    private readonly string _file;
    private readonly string _historyDir;
    private volatile bool _dirty;
    private const int MaxCallsigns = 24;
    private const int MaxRoutes = 40;

    public AircraftDb(string baseDir, string historyDir)
    {
        _dir = Path.Combine(baseDir, "aircraft-db");
        _file = Path.Combine(_dir, "aircraft.jsonl");
        _historyDir = historyDir;
        Instance = this;
    }

    public int Count => _byKey.Count;

    // ── Identity ────────────────────────────────────────────────────────────────
    // ICAO 24-bit Mode S address is the stable per-airframe key (never reused within a country's
    // scheme); registration is the human key. Prefer the hex; fall back to REG: when no hex is known.
    private static string? NormHex(string? modeS)
    {
        if (string.IsNullOrWhiteSpace(modeS)) return null;
        var s = modeS.Trim().TrimStart('-').ToUpperInvariant();
        // Keep only hex digits; SFDPS occasionally prefixes/pads the value.
        Span<char> buf = stackalloc char[s.Length];
        int n = 0;
        foreach (var c in s)
            if ((c >= '0' && c <= '9') || (c >= 'A' && c <= 'F')) buf[n++] = c;
        return n == 0 ? null : new string(buf[..n]);
    }

    private static string? NormReg(string? reg) =>
        string.IsNullOrWhiteSpace(reg) ? null : reg.Trim().ToUpperInvariant();

    private static string KeyFor(string? hex, string? reg) =>
        hex != null ? hex : "REG:" + reg;

    // ── Ingest ────────────────────────────────────────────────────────────────
    /// <summary>Roll a live/purged flight into the database.</summary>
    public void Observe(FlightState f) => Upsert(
        NormHex(f.ModeSCode), NormReg(f.Registration), f.SELCAL, f.AircraftType, f.Operator,
        f.WakeCategory, f.EquipmentQualifier, f.Callsign, f.Origin, f.Destination,
        f.LastSeen == default ? DateTime.UtcNow : f.LastSeen);

    /// <summary>Roll one flight-history JSON record into the database (used by the backfill).</summary>
    private void ObserveHistory(JsonElement r)
    {
        string? S(string k) => r.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        var hex = NormHex(S("modeSCode"));
        var reg = NormReg(S("registration"));
        if (hex == null && reg == null) return;   // can't identify the airframe
        DateTime last = DateTime.UtcNow;
        if (r.TryGetProperty("lastSeen", out var ls) && ls.ValueKind == JsonValueKind.String
            && DateTime.TryParse(ls.GetString(), out var dt)) last = dt.ToUniversalTime();
        Upsert(hex, reg, S("selcal"), S("aircraftType"), S("operator"), S("wakeCategory"),
            S("equipmentQualifier"), S("callsign"), S("origin"), S("destination"), last);
    }

    private void Upsert(string? hex, string? reg, string? selcal, string? type, string? op,
        string? wake, string? equip, string? callsign, string? origin, string? dest, DateTime seen)
    {
        if (hex == null && reg == null) return;
        var key = KeyFor(hex, reg);
        var rec = _byKey.GetOrAdd(key, k => new AircraftRecord { Key = k, Icao24 = hex, FirstSeenUtc = seen });
        lock (rec)
        {
            // Latest non-null wins for the descriptive fields (identity is essentially stable).
            if (hex != null) rec.Icao24 = hex;
            if (reg != null) rec.Registration = reg;
            if (!string.IsNullOrWhiteSpace(selcal)) rec.Selcal = selcal.Trim().ToUpperInvariant();
            if (!string.IsNullOrWhiteSpace(type)) rec.Type = type.Trim().ToUpperInvariant();
            if (!string.IsNullOrWhiteSpace(op)) rec.Operator = op.Trim();
            if (!string.IsNullOrWhiteSpace(wake)) rec.Wake = wake.Trim().ToUpperInvariant();
            if (!string.IsNullOrWhiteSpace(equip)) rec.Equipment = equip.Trim().ToUpperInvariant();
            if (!string.IsNullOrWhiteSpace(callsign) && rec.Callsigns.Count < MaxCallsigns)
                rec.Callsigns.Add(callsign.Trim().ToUpperInvariant());
            if (!string.IsNullOrWhiteSpace(origin) && !string.IsNullOrWhiteSpace(dest) && rec.Routes.Count < MaxRoutes)
                rec.Routes.Add($"{origin.Trim().ToUpperInvariant()}-{dest.Trim().ToUpperInvariant()}");
            rec.Sightings++;
            if (seen > rec.LastSeenUtc) rec.LastSeenUtc = seen;
            if (seen < rec.FirstSeenUtc) rec.FirstSeenUtc = seen;
        }
        _dirty = true;
    }

    // ── Search ────────────────────────────────────────────────────────────────
    /// <summary>Match aircraft by registration, ICAO 24 hex, SELCAL, callsign, operator or type.
    /// Ranked: exact identity hit first, then prefix, then substring; most-recently-seen breaks ties.</summary>
    public List<AircraftRecord> Search(string query, int limit, bool reveal)
    {
        var q = (query ?? "").Trim().ToUpperInvariant();
        if (q.Length == 0) return new();
        var hits = new List<(int rank, DateTime seen, AircraftRecord rec)>();
        foreach (var rec in _byKey.Values)
        {
            if (!reveal && LaddService.IsBlocked(null, rec.Registration, rec.Icao24)) continue;
            // Lock while matching: MatchRank enumerates the Callsigns set, which Upsert mutates
            // under the same lock, so an unlocked read here could throw mid-enumeration.
            int rank;
            lock (rec) rank = MatchRank(rec, q);
            if (rank < int.MaxValue) hits.Add((rank, rec.LastSeenUtc, rec));
        }
        return hits
            .OrderBy(h => h.rank).ThenByDescending(h => h.seen)
            .Take(limit).Select(h => h.rec).ToList();
    }

    private static int MatchRank(AircraftRecord r, string q)
    {
        // 0 = exact identity, 1 = identity prefix, 2 = substring/other-field. Lower is better.
        bool ExactId(string? s) => s != null && s == q;
        bool PrefixId(string? s) => s != null && s.StartsWith(q, StringComparison.Ordinal);
        if (ExactId(r.Registration) || ExactId(r.Icao24) || ExactId(r.Selcal)) return 0;
        if (r.Callsigns.Contains(q)) return 0;
        if (PrefixId(r.Registration) || PrefixId(r.Icao24) || PrefixId(r.Selcal)) return 1;
        if (r.Callsigns.Any(c => c.StartsWith(q, StringComparison.Ordinal))) return 1;
        if ((r.Registration?.Contains(q) ?? false) || (r.Icao24?.Contains(q) ?? false)
            || (r.Selcal?.Contains(q) ?? false) || (r.Type?.Contains(q) ?? false)
            || (r.Operator?.ToUpperInvariant().Contains(q) ?? false)
            || r.Callsigns.Any(c => c.Contains(q))) return 2;
        return int.MaxValue;
    }

    /// <summary>Look up one aircraft by ICAO 24 hex or registration.</summary>
    public AircraftRecord? Get(string id)
    {
        var q = (id ?? "").Trim();
        var hex = NormHex(q);
        if (hex != null && _byKey.TryGetValue(hex, out var byHex)) return byHex;
        var reg = NormReg(q);
        if (reg != null)
        {
            if (_byKey.TryGetValue("REG:" + reg, out var byReg)) return byReg;
            var m = _byKey.Values.FirstOrDefault(r => r.Registration == reg);
            if (m != null) return m;
        }
        return null;
    }

    // ── Persistence ─────────────────────────────────────────────────────────────
    public void Load()
    {
        try
        {
            if (!File.Exists(_file)) return;
            var opts = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
            int n = 0;
            foreach (var line in File.ReadLines(_file))
            {
                if (line.Length == 0) continue;
                try
                {
                    var rec = JsonSerializer.Deserialize<AircraftRecord>(line, opts);
                    if (rec != null && !string.IsNullOrEmpty(rec.Key)) { _byKey[rec.Key] = rec; n++; }
                }
                catch { }
            }
            Console.WriteLine($"[AIRCRAFT] Loaded {n} aircraft from {Path.GetFileName(_file)}");
        }
        catch (Exception ex) { Console.WriteLine($"[AIRCRAFT] Load error: {ex.Message}"); }
    }

    /// <summary>Rewrite the on-disk snapshot if anything changed since the last save.</summary>
    public void Save()
    {
        if (!_dirty) return;
        _dirty = false;
        try
        {
            Directory.CreateDirectory(_dir);
            var opts = new JsonSerializerOptions
            {
                PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
                DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
            };
            var tmp = _file + ".tmp";
            using (var sw = new StreamWriter(tmp, false))
                foreach (var rec in _byKey.Values)
                {
                    lock (rec) sw.WriteLine(JsonSerializer.Serialize(rec, opts));
                }
            File.Move(tmp, _file, overwrite: true);
        }
        catch (Exception ex) { Console.WriteLine($"[AIRCRAFT] Save error: {ex.Message}"); _dirty = true; }
    }

    /// <summary>
    /// One-time seed from existing flight-history, newest file first, on a background task so it never
    /// blocks startup. Bounded by a wall-clock budget so a huge history archive can't peg the Pi — the
    /// live save path keeps the DB current regardless of how far back the backfill reaches.
    /// </summary>
    public void BackfillAsync(TimeSpan budget) => Task.Run(() =>
    {
        try
        {
            if (!Directory.Exists(_historyDir)) return;
            var files = Directory.GetFiles(_historyDir, "*.jsonl")
                .OrderByDescending(f => f, StringComparer.Ordinal).ToList();   // newest day first
            var deadline = DateTime.UtcNow + budget;
            long lines = 0; int filesDone = 0;
            foreach (var file in files)
            {
                if (DateTime.UtcNow > deadline) break;
                try
                {
                    foreach (var line in File.ReadLines(file))
                    {
                        if (line.Length == 0) continue;
                        try { using var doc = JsonDocument.Parse(line); ObserveHistory(doc.RootElement); }
                        catch { }
                        if ((++lines & 0x3FFF) == 0 && DateTime.UtcNow > deadline) break;
                    }
                }
                catch { }
                filesDone++;
            }
            Console.WriteLine($"[AIRCRAFT] Backfill scanned {lines} history records from {filesDone} file(s) → {_byKey.Count} aircraft");
            Save();
        }
        catch (Exception ex) { Console.WriteLine($"[AIRCRAFT] Backfill error: {ex.Message}"); }
    });

    // ── API projection (masked) ──────────────────────────────────────────────────
    public object ToJson(AircraftRecord r, bool reveal, bool detail)
    {
        bool masked = !reveal && LaddService.IsBlocked(null, r.Registration, r.Icao24);
        var reg = masked ? LaddService.Label : r.Registration;
        var op = masked ? null : r.Operator;
        var selcal = masked ? null : r.Selcal;
        // Snapshot the sets under the record lock (Upsert mutates them concurrently).
        string[] callsigns, routes;
        lock (r)
        {
            callsigns = masked ? Array.Empty<string>() : r.Callsigns.OrderBy(c => c).ToArray();
            routes = masked ? Array.Empty<string>() : r.Routes.OrderBy(x => x).ToArray();
        }
        if (!detail)
            return new
            {
                icao24 = r.Icao24, registration = reg, selcal, type = r.Type, @operator = op,
                wake = r.Wake, sightings = r.Sightings,
                lastSeen = r.LastSeenUtc.ToString("o"),
            };
        return new
        {
            icao24 = r.Icao24, registration = reg, selcal, type = r.Type, @operator = op,
            wake = r.Wake, equipment = r.Equipment, sightings = r.Sightings,
            firstSeen = r.FirstSeenUtc.ToString("o"), lastSeen = r.LastSeenUtc.ToString("o"),
            callsigns,
            routes,
        };
    }
}

/// <summary>One airframe's rolled-up record. Sets serialize as arrays; deserialization tolerates that.</summary>
sealed class AircraftRecord
{
    public string Key { get; set; } = "";
    public string? Icao24 { get; set; }
    public string? Registration { get; set; }
    public string? Selcal { get; set; }
    public string? Type { get; set; }
    public string? Operator { get; set; }
    public string? Wake { get; set; }
    public string? Equipment { get; set; }
    public HashSet<string> Callsigns { get; set; } = new();
    public HashSet<string> Routes { get; set; } = new();
    public long Sightings { get; set; }
    public DateTime FirstSeenUtc { get; set; }
    public DateTime LastSeenUtc { get; set; }
}
