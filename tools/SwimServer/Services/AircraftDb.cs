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
    private readonly AircraftFlightLog _log;
    private readonly HashSet<string> _backfillCreated = new();   // keys the history backfill created

    public AircraftDb(string baseDir, string historyDir)
    {
        _dir = Path.Combine(baseDir, "aircraft-db");
        _file = Path.Combine(_dir, "aircraft.jsonl");
        _historyDir = historyDir;
        _log = new AircraftFlightLog(Path.Combine(_dir, "flights"), _historyDir);
        Instance = this;
    }

    public int Count => _byKey.Count;

    // ── Identity ────────────────────────────────────────────────────────────────
    // ICAO 24-bit Mode S address is the stable per-airframe key (never reused within a country's
    // scheme); registration is the human key. Prefer the hex; fall back to REG: when no hex is known.
    // Key rules live in AircraftFlightLog so the flight log and these records can never disagree on a key.
    private static string? NormHex(string? modeS) => AircraftFlightLog.NormHex(modeS);
    private static string? NormReg(string? reg) => AircraftFlightLog.NormReg(reg);
    private static string KeyFor(string? hex, string? reg) => AircraftFlightLog.KeyFor(hex, reg);

    // ── Ingest ────────────────────────────────────────────────────────────────
    /// <summary>Roll a live/purged flight into the database and its permanent flight log.</summary>
    public void Observe(FlightState f)
    {
        var hex = NormHex(f.ModeSCode);
        var reg = AircraftFlightLog.CleanReg(f.Registration, f.AircraftType);   // type-as-registration isn't a tail
        var seen = f.LastSeen == default ? DateTime.UtcNow : f.LastSeen;
        Upsert(hex, reg, f.SELCAL, f.AircraftType, f.Operator, f.WakeCategory, f.EquipmentQualifier,
            f.Callsign, f.Origin, f.Destination, seen);
        if (hex == null && reg == null) return;

        // Log only flights that actually flew. ~45% of purged flight plans never got a position or an actual
        // departure (mostly PROPOSED plans that were refiled, cancelled or never activated).
        if (!f.Latitude.HasValue && string.IsNullOrEmpty(f.ActualDepartureTime)) return;

        var events = f.GetAllEvents();   // chronological — the first is when the feed first saw this GUFI
        long firstSeen = events.Count > 0 ? AircraftFlightLog.ParseEpoch(events[0].Time) : 0;
        _log.Record(KeyFor(hex, reg), AircraftFlightLog.MakeEntry(
            AircraftFlightLog.ParseEpoch(f.ActualDepartureTime), firstSeen, AircraftFlightLog.Epoch(seen),
            f.Callsign, f.Origin, f.Destination, f.Operator, reg));
    }

    private void Upsert(string? hex, string? reg, string? selcal, string? type, string? op,
        string? wake, string? equip, string? callsign, string? origin, string? dest, DateTime seen)
    {
        if (hex == null && reg == null) return;
        // A few flights carry a LastSeen ahead of now (e.g. plan-only records); never let one sort
        // to the top of "last seen" as if it were in the future.
        var nowUtc = DateTime.UtcNow;
        if (seen > nowUtc) seen = nowUtc;
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

    /// <summary>
    /// Browse the database as a table: optional substring filter, sort by a column, and return one
    /// page plus the total match count. All server-side over the in-memory dictionary (~tens of
    /// thousands of rows sorts in a few ms), so the client fetches only the page it shows.
    /// </summary>
    public (int total, List<AircraftRecord> page) Browse(
        string? q, string? field, string? wake, string sort, bool desc, int offset, int limit, bool reveal)
    {
        IEnumerable<AircraftRecord> items = _byKey.Values;
        if (!reveal) items = items.Where(r => !LaddService.IsBlocked(null, r.Registration, r.Icao24));

        var w = (wake ?? "").Trim().ToUpperInvariant();
        if (w.Length > 0) items = items.Where(r => r.Wake == w);

        // Same search semantics as the flight table: whitespace-separated terms are AND'd, each matched
        // against the chosen field ("all" = any field). Plain terms are substring matches; terms with *
        // are anchored wildcards (N12*, *DN, A3*N).
        var terms = (q ?? "").ToUpperInvariant().Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
        if (terms.Length > 0)
        {
            var fld = (field ?? "all").Trim().ToLowerInvariant();
            var matchers = terms.Select(BuildMatcher).ToArray();
            items = items.Where(r =>
            {
                bool ok;
                lock (r) ok = matchers.All(m => FieldMatches(r, fld, m));   // Callsigns is mutated under this lock
                return ok;
            });
        }

        var list = items.ToList();
        int total = list.Count;

        static Func<string?, bool> BuildMatcher(string term)
        {
            if (!term.Contains('*')) return s => s != null && s.Contains(term, StringComparison.Ordinal);
            var rx = new System.Text.RegularExpressions.Regex(
                "^" + System.Text.RegularExpressions.Regex.Escape(term).Replace("\\*", ".*") + "$",
                System.Text.RegularExpressions.RegexOptions.CultureInvariant);
            return s => s != null && rx.IsMatch(s);
        }

        static bool FieldMatches(AircraftRecord r, string fld, Func<string?, bool> m) => fld switch
        {
            "registration" => m(r.Registration),
            "icao24"       => m(r.Icao24),
            "selcal"       => m(r.Selcal),
            "type"         => m(r.Type),
            "operator"     => m(r.Operator?.ToUpperInvariant()),
            "callsign"     => r.Callsigns.Any(c => m(c)),
            _              => m(r.Registration) || m(r.Icao24) || m(r.Selcal) || m(r.Type)
                              || m(r.Operator?.ToUpperInvariant()) || r.Callsigns.Any(c => m(c)),
        };

        Func<AircraftRecord, IComparable> key = sort switch
        {
            "registration" => r => r.Registration ?? "",
            "icao24"       => r => r.Icao24 ?? "",
            "type"         => r => r.Type ?? "",
            "operator"     => r => r.Operator ?? "",
            "selcal"       => r => r.Selcal ?? "",
            "wake"         => r => r.Wake ?? "",
            "sightings"    => r => r.Sightings,
            "firstSeen"    => r => r.FirstSeenUtc,
            _              => r => r.LastSeenUtc,   // default: most recently seen
        };
        // Stable tiebreak on last-seen so equal keys page deterministically.
        var ordered = desc
            ? list.OrderByDescending(key).ThenByDescending(r => r.LastSeenUtc)
            : list.OrderBy(key).ThenByDescending(r => r.LastSeenUtc);
        var page = ordered.Skip(Math.Max(0, offset)).Take(limit).ToList();
        return (total, page);
    }

    // ── Whole-table payload ─────────────────────────────────────────────────────
    private static readonly TimeSpan AllCacheTtl = TimeSpan.FromSeconds(60);
    private readonly object _allLock = new();
    private byte[]? _all, _allReveal;
    private DateTime _allAt, _allRevealAt;

    private static long Epoch(DateTime t) =>
        t == default ? 0 : new DateTimeOffset(DateTime.SpecifyKind(t, DateTimeKind.Utc)).ToUnixTimeSeconds();

    /// <summary>
    /// Every aircraft in one compact JSON payload for the table page, which sorts and filters in the
    /// browser. Rows are positional arrays (cols lists the order) with epoch-second timestamps to keep
    /// it small and fast to parse, and the serialized bytes are cached for a minute so repeated page
    /// loads don't re-walk the dictionary. LADD-blocked aircraft are omitted unless revealed.
    /// </summary>
    public byte[] AllCompactJson(bool reveal)
    {
        lock (_allLock)
        {
            var now = DateTime.UtcNow;
            if (reveal && _allReveal != null && now - _allRevealAt < AllCacheTtl) return _allReveal;
            if (!reveal && _all != null && now - _allAt < AllCacheTtl) return _all;

            using var ms = new MemoryStream();
            using (var w = new Utf8JsonWriter(ms))
            {
                void Str(string? s) { if (s == null) w.WriteNullValue(); else w.WriteStringValue(s); }

                w.WriteStartObject();
                w.WriteString("generated", now.ToString("o"));
                w.WriteStartArray("cols");
                foreach (var col in new[] { "id", "registration", "icao24", "selcal", "type", "operator",
                                            "callsigns", "sightings", "firstSeen", "lastSeen" })
                    w.WriteStringValue(col);
                w.WriteEndArray();
                w.WriteStartArray("rows");
                foreach (var r in _byKey.Values)
                {
                    if (!reveal && LaddService.IsBlocked(null, r.Registration, r.Icao24)) continue;
                    string? reg, hex, sel, type, op; string cs; long seen; DateTime first, last;
                    lock (r)
                    {
                        reg = r.Registration; hex = r.Icao24; sel = r.Selcal; type = r.Type; op = r.Operator;
                        cs = string.Join(' ', r.Callsigns.OrderBy(x => x));
                        seen = r.Sightings; first = r.FirstSeenUtc; last = r.LastSeenUtc;
                    }
                    w.WriteStartArray();
                    w.WriteStringValue(hex ?? reg ?? r.Key);   // id used for the detail lookup
                    Str(reg); Str(hex); Str(sel); Str(type); Str(op);
                    w.WriteStringValue(cs);
                    w.WriteNumberValue(seen);
                    w.WriteNumberValue(Epoch(first));
                    w.WriteNumberValue(Epoch(last));
                    w.WriteEndArray();
                }
                w.WriteEndArray();
                w.WriteEndObject();
            }
            var bytes = ms.ToArray();
            if (reveal) { _allReveal = bytes; _allRevealAt = now; } else { _all = bytes; _allAt = now; }
            return bytes;
        }
    }

    /// <summary>Look up one aircraft by ICAO 24 hex or registration.</summary>
    public AircraftRecord? Get(string id)
    {
        var q = (id ?? "").Trim();
        // Only treat the id as a Mode S code when it IS one (6 hex digits) — otherwise NormHex would
        // pull the hex-looking characters out of a registration (N850AN → 850A) and could hit the
        // wrong airframe.
        var hex = System.Text.RegularExpressions.Regex.IsMatch(q, "^-?[0-9A-Fa-f]{6}$") ? NormHex(q) : null;
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
            int n = 0, dropped = 0, cleared = 0;
            foreach (var line in File.ReadLines(_file))
            {
                if (line.Length == 0) continue;
                try
                {
                    var rec = JsonSerializer.Deserialize<AircraftRecord>(line, opts);
                    if (rec != null && !string.IsNullOrEmpty(rec.Key))
                    {
                        // Repair any future-dated rows saved before Upsert clamped them.
                        var nowUtc = DateTime.UtcNow;
                        if (rec.LastSeenUtc > nowUtc) rec.LastSeenUtc = nowUtc;
                        if (rec.FirstSeenUtc > rec.LastSeenUtc) rec.FirstSeenUtc = rec.LastSeenUtc;
                        // Records saved before type-as-registration was rejected (e.g. one fake "P212" tail for all
                        // of Cape Air's P2012s): drop it when that was its only identity, else just clear the field
                        // so a real hex-keyed airframe can't pull the whole fleet's REG: flight log into its own.
                        if (rec.Registration != null && AircraftFlightLog.CleanReg(rec.Registration, rec.Type) == null)
                        {
                            if (rec.Icao24 == null) { dropped++; continue; }
                            rec.Registration = null;
                            cleared++;
                        }
                        _byKey[rec.Key] = rec; n++;
                    }
                }
                catch { }
            }
            Console.WriteLine($"[AIRCRAFT] Loaded {n} aircraft from {Path.GetFileName(_file)}");
            if (dropped + cleared > 0)
            {
                Console.WriteLine($"[AIRCRAFT] Type-as-registration cleanup: dropped {dropped} fake tail(s), cleared {cleared} registration(s)");
                _dirty = true;   // rewrite the snapshot without them
            }
        }
        catch (Exception ex) { Console.WriteLine($"[AIRCRAFT] Load error: {ex.Message}"); }
    }

    /// <summary>Rewrite the on-disk snapshot if anything changed since the last save.</summary>
    public void Save()
    {
        _log.Flush();   // append any queued flight-log lines (independent of the records' dirty flag)
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

    // ── Flight log ──────────────────────────────────────────────────────────────
    public AircraftFlightLog Log => _log;

    /// <summary>
    /// Start the flight-log writer and its one-time, resumable scan of the whole flight-history archive. The
    /// scan also creates records for airframes that only appear in older history, so every logged tail is
    /// browsable (this replaces the old 60-second first-run seed).
    /// </summary>
    public void StartFlightLog() => _log.Start(OnBackfillRow, () =>
    {
        lock (_backfillCreated) _backfillCreated.Clear();
        Save();
    });

    /// <summary>Every dated flight for this airframe, oldest first. Also reads the other key form it may have been
    /// logged under (Mode S hex vs REG:) before its Mode S code was known.</summary>
    public List<AircraftFlightLog.Entry> FlightsFor(AircraftRecord rec)
    {
        var keys = new List<string> { rec.Key };
        if (rec.Icao24 != null) keys.Add(rec.Icao24);
        if (rec.Registration != null) keys.Add("REG:" + rec.Registration);
        var all = _log.Read(keys);
        // A Mode S code the feed files for two different airframes (see AircraftFlightLog) would otherwise
        // list both aircraft's flights here as if one aeroplane flew them all. When the rows disagree on
        // registration, show only this airframe's. Rows from before the registration column can't be placed
        // either way, so they're left out rather than credited to whichever record holds the key.
        if (rec.Registration != null && all.Select(e => e.Reg).Where(r => r.Length > 0).Distinct().Take(2).Count() > 1)
            all = all.Where(e => e.Reg == rec.Registration).ToList();
        return all;
    }

    /// <summary>Identity for one flight-log key, for airline research (null when no record exists).</summary>
    public AirlineResearch.TailMeta? TailMeta(string key)
    {
        if (!_byKey.TryGetValue(key, out var r)) return null;
        string? reg, hex, type, op;
        lock (r) { reg = r.Registration; hex = r.Icao24; type = r.Type; op = r.Operator; }
        return new AirlineResearch.TailMeta(key, reg, hex, type, op, LaddService.IsBlocked(null, reg, hex));
    }

    // Records the backfill creates get full upserts from every history line; records that already existed only
    // have FirstSeen pulled earlier, so their sightings aren't double-counted.
    private void OnBackfillRow(AircraftFlightLog.HistoryRow h)
    {
        bool create;
        lock (_backfillCreated)
        {
            create = _backfillCreated.Contains(h.Key) || !_byKey.ContainsKey(h.Key);
            if (create) _backfillCreated.Add(h.Key);
        }
        if (create)
        {
            Upsert(h.Hex, h.Reg, h.Selcal, h.Type, h.Op, h.Wake, h.Equip, h.Cs, h.O, h.D, h.Seen);
        }
        else if (_byKey.TryGetValue(h.Key, out var rec))
        {
            lock (rec)
            {
                if (h.Seen < rec.FirstSeenUtc) { rec.FirstSeenUtc = h.Seen; _dirty = true; }
            }
        }
    }

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
                wake = r.Wake, sightings = r.Sightings, callsigns,
                firstSeen = r.FirstSeenUtc.ToString("o"),
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
