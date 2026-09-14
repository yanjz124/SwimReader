using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace SwimServer;

/// <summary>
/// Airline research: per-carrier route network, fleet utilization and operating patterns, computed from the permanent
/// per-tail flight log (<see cref="AircraftFlightLog"/>) joined with the aircraft database.
///
/// Carriers are identified by the ICAO prefix of each flight's callsign (SKW5296 → SKW). Regionals fly under their
/// own prefix whichever mainline brand they operate for, so each regional is its own carrier. The operator filed with
/// each flight (OPR) is the cross-check: usually the same designator, sometimes a legal name ("MESA AIRLINES",
/// "AIR TRANSPORT INTL 19373665555"), resolved against the curated Part 121 catalog in wwwroot/airlines/carriers.json.
///
/// Data model: the last <see cref="WindowDays"/> days of logged flights for every tail, held in memory packed
/// (~28 bytes per flight, strings interned). Loaded once at startup from the log shards, then kept current by the
/// log's <see cref="AircraftFlightLog.Appended"/> event. Each tail's flights get the same merge and data fixes as the
/// FLIGHTS tab (cached until that tail logs another flight). Summaries are computed on request, cached five minutes.
///
/// Estimates, named so they're read correctly: air time = last seen − actual departure (the feed's last message comes
/// within minutes of touchdown); ground time = next departure − previous last seen; a ground stop of five hours or
/// more is a "long stop" (overnight, maintenance or spare) attributed to the airport the tail was sitting at.
/// </summary>
sealed class AirlineResearch
{
    public sealed record TailMeta(string Key, string? Reg, string? Hex, string? Type, string? Operator, bool Blocked);

    public sealed class Carrier
    {
        public string Icao { get; set; } = "";
        public string Callsign { get; set; } = "";
        public string Name { get; set; } = "";
        public string Category { get; set; } = "";
        public string[] Partners { get; set; } = Array.Empty<string>();
        public string Status { get; set; } = "active";
        public string Confidence { get; set; } = "";
        public string Note { get; set; } = "";
        public string[] Aliases { get; set; } = Array.Empty<string>();
    }

    public sealed class CeasedCarrier
    {
        public string Icao { get; set; } = "";
        public string Name { get; set; } = "";
        public string Ceased { get; set; } = "";
        public string Note { get; set; } = "";
    }

    private sealed class Catalog
    {
        public string? AsOf { get; set; }
        public List<Carrier> Carriers { get; set; } = new();
        public List<CeasedCarrier> CeasedSince2020 { get; set; } = new();
    }

    private readonly record struct Packed(int Dep, int First, int Last, int Cs, int O, int D, int Op);

    private sealed class Tail
    {
        public readonly List<Packed> Raw = new();
        public AircraftFlightLog.Entry[]? Merged;
    }

    private sealed class AptAcc { public string Code = ""; public long Dep, Arr, Stops; }
    private sealed class RouteAcc
    {
        public string A = "", B = "";
        public long AB, BA, AirMin, Timed, Recent, Earlier;
        public readonly HashSet<string> Tails = new(StringComparer.Ordinal);
    }
    private sealed class DayAcc { public long Flights; public readonly HashSet<string> Tails = new(StringComparer.Ordinal); }
    private sealed class TypeAcc { public long Tails, Flights, AirMin, ActiveDays; }
    private sealed class DirAcc
    {
        public long Flights, AirMin, OpKnown, OpMatch;
        public readonly HashSet<string> Tails = new(StringComparer.Ordinal), Airports = new(StringComparer.Ordinal), Routes = new(StringComparer.Ordinal);
        public readonly Dictionary<string, long> Types = new(StringComparer.Ordinal), OpOther = new(StringComparer.Ordinal);
    }
    private sealed class TailRow
    {
        public string Key = "", Reg = "", Type = "", LastAt = "", LastCs = "";
        public string? Hex, Op;
        public long Flights, AirMin, Stops, LongestStop, LastSeen, TurnSec = -1;
        public int Days, Idle;
        public double Share;
        public string[] Other = Array.Empty<string>();
    }

    private const long EpochBase = 1577836800;          // 2020-01-01Z; packed times are seconds since then
    private const long LongStop = 5 * 3600;             // ground ≥ 5 h = overnight / maintenance / spare
    private static readonly HashSet<string> DomesticCountries = new() { "US", "PR", "VI", "GU", "AS", "MP", "UM" };
    private static readonly HashSet<string> NameNoise = new() { "INC", "LLC", "LP", "LTD", "CORP", "CORPORATION", "CO", "THE", "DBA" };
    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly AircraftFlightLog _log;
    private readonly Func<string, TailMeta?> _meta;
    private readonly Func<string?, AirportDirectory.Airport?> _airport;
    private readonly string _catalogPath;
    private readonly Func<long> _now;
    public int WindowDays { get; }

    private readonly ConcurrentDictionary<string, Tail> _tails = new(StringComparer.Ordinal);
    private readonly object _internLock = new();
    private readonly Dictionary<string, int> _ids = new(StringComparer.Ordinal) { [""] = 0 };
    private volatile string[] _strs = new string[1 << 14];
    private int _strCount = 1;
    private long _flights, _oldest = long.MaxValue, _lastPrune;
    private volatile bool _ready;
    private volatile string _state = "starting";

    private readonly object _catalogLock = new();
    private volatile List<Carrier> _carriers = new();
    private volatile Dictionary<string, Carrier> _carrierByIcao = new(StringComparer.Ordinal);
    private volatile List<CeasedCarrier> _ceased = new();
    private DateTime _catalogStamp;
    private string? _catalogAsOf;
    private readonly ConcurrentDictionary<string, string> _opResolved = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, (DateTime At, byte[] Json)> _cache = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, object> _buildLocks = new(StringComparer.Ordinal);

    public AirlineResearch(AircraftFlightLog log, Func<string, TailMeta?> meta, Func<string?, AirportDirectory.Airport?> airport,
        string catalogPath, int windowDays = 90, Func<long>? now = null)
    {
        _log = log;
        _meta = meta;
        _airport = airport;
        _catalogPath = catalogPath;
        WindowDays = Math.Max(1, windowDays);
        _now = now ?? (() => DateTimeOffset.UtcNow.ToUnixTimeSeconds());
        _strs[0] = "";
    }

    public bool Ready => _ready;
    public int ClampDays(int? days) => Math.Clamp(days ?? 7, 1, WindowDays);

    // ── Index ────────────────────────────────────────────────────────────────────
    /// <summary>
    /// Subscribe to new flights, then load the window from the log shards on a background thread and pre-merge
    /// every tail. A flight logged during the scan can arrive twice (event + shard); the merge folds it.
    /// </summary>
    public void Start()
    {
        LoadCatalogIfChanged();
        _log.Appended += (key, e) => Add(key, e);
        var t = new Thread(() =>
        {
            try
            {
                var sw = Stopwatch.StartNew();
                _state = "loading flight log";
                long n = _log.ScanAll(_now() - WindowDays * 86400L, Add);
                _state = "indexing tails";
                var burst = Stopwatch.StartNew();
                foreach (var tail in _tails.Values)
                {
                    MergedOf(tail);
                    if (burst.ElapsedMilliseconds >= 100) { Thread.Sleep(100); burst.Restart(); }
                }
                _ready = true;
                _state = "ready";
                _cache.Clear();
                Console.WriteLine($"[AIRLINES] Indexed {n:N0} logged flights across {_tails.Count:N0} tails " +
                                  $"({WindowDays}-day window) in {sw.Elapsed.TotalSeconds:F0}s");
            }
            catch (Exception ex)
            {
                _state = "error: " + ex.Message;
                Console.WriteLine($"[AIRLINES] Index error: {ex.Message}");
            }
        })
        { IsBackground = true, Name = "airline-research-index" };
        t.Start();
    }

    private void Add(string key, AircraftFlightLog.Entry e)
    {
        long t = e.T;
        if (t < EpochBase || t < _now() - WindowDays * 86400L) return;
        var p = new Packed(Pack(e.Dep), Pack(e.First), Pack(e.Last), Intern(e.Cs), Intern(e.O), Intern(e.D), Intern(e.Op));
        var tail = _tails.GetOrAdd(key, _ => new Tail());
        lock (tail)
        {
            tail.Raw.Add(p);
            tail.Merged = null;
        }
        Interlocked.Increment(ref _flights);
        long o;
        while (t < (o = Interlocked.Read(ref _oldest)) && Interlocked.CompareExchange(ref _oldest, t, o) != o) { }
    }

    private static int Pack(long t) => t <= EpochBase ? 0 : (int)(t - EpochBase);
    private static long Unpack(int v) => v == 0 ? 0 : v + EpochBase;
    private static long Best(Packed p) => Unpack(p.Dep != 0 ? p.Dep : p.First != 0 ? p.First : p.Last);

    private int Intern(string s)
    {
        if (string.IsNullOrEmpty(s)) return 0;
        lock (_internLock)
        {
            if (_ids.TryGetValue(s, out var id)) return id;
            var arr = _strs;
            if (_strCount == arr.Length)
            {
                var bigger = new string[arr.Length * 2];
                Array.Copy(arr, bigger, _strCount);
                _strs = arr = bigger;
            }
            id = _strCount;
            arr[id] = s;
            _ids[s] = id;
            _strCount = id + 1;
            return id;
        }
    }

    private string Str(int id) => _strs[id];

    private AircraftFlightLog.Entry[] MergedOf(Tail tail)
    {
        lock (tail)
        {
            if (tail.Merged == null)
            {
                var list = new List<AircraftFlightLog.Entry>(tail.Raw.Count);
                foreach (var p in tail.Raw)
                    list.Add(new AircraftFlightLog.Entry(Unpack(p.Dep), Unpack(p.First), Unpack(p.Last),
                                                         Str(p.Cs), Str(p.O), Str(p.D), Str(p.Op)));
                tail.Merged = AircraftFlightLog.Merge(list).ToArray();
            }
            return tail.Merged;
        }
    }

    /// <summary>Drop flights that aged out of the window (at most every 6 h) and recompute the oldest flight.</summary>
    private void PruneIfDue()
    {
        long now = _now();
        if (now - Interlocked.Read(ref _lastPrune) < 6 * 3600) return;
        Interlocked.Exchange(ref _lastPrune, now);
        long cutoff = now - WindowDays * 86400L, removed = 0, oldest = long.MaxValue;
        foreach (var tail in _tails.Values)
        {
            lock (tail)
            {
                int before = tail.Raw.Count;
                tail.Raw.RemoveAll(p => Best(p) < cutoff);
                if (tail.Raw.Count != before) { tail.Merged = null; removed += before - tail.Raw.Count; }
                foreach (var p in tail.Raw) oldest = Math.Min(oldest, Best(p));
            }
        }
        Interlocked.Add(ref _flights, -removed);
        Interlocked.Exchange(ref _oldest, oldest);
    }

    /// <summary>Days of data actually available in the requested window (history may be younger than the window).</summary>
    private double SpanDays(int days, long now)
    {
        long oldest = Interlocked.Read(ref _oldest);
        double have = oldest == long.MaxValue ? days : (now - oldest) / 86400.0;
        return Math.Max(1.0 / 24, Math.Min(days, have));
    }

    public object Status() => new
    {
        ready = _ready,
        state = _state,
        windowDays = WindowDays,
        flights = Interlocked.Read(ref _flights),
        tails = _tails.Count,
        carriers = _carriers.Count,
        catalogAsOf = _catalogAsOf,
    };

    // ── Catalog + operator resolution ───────────────────────────────────────────────
    private void LoadCatalogIfChanged()
    {
        lock (_catalogLock)
        {
            try
            {
                if (!File.Exists(_catalogPath)) return;
                var stamp = File.GetLastWriteTimeUtc(_catalogPath);
                if (stamp == _catalogStamp) return;
                var cat = JsonSerializer.Deserialize<Catalog>(File.ReadAllText(_catalogPath), new JsonSerializerOptions
                {
                    PropertyNameCaseInsensitive = true,
                    ReadCommentHandling = JsonCommentHandling.Skip,
                    AllowTrailingCommas = true,
                });
                if (cat == null) return;
                var list = new List<Carrier>();
                var byIcao = new Dictionary<string, Carrier>(StringComparer.Ordinal);
                foreach (var c in cat.Carriers)
                {
                    c.Icao = (c.Icao ?? "").Trim().ToUpperInvariant();
                    if (c.Icao.Length == 0 || byIcao.ContainsKey(c.Icao)) continue;
                    c.Partners ??= Array.Empty<string>();
                    c.Aliases ??= Array.Empty<string>();
                    byIcao[c.Icao] = c;
                    list.Add(c);
                }
                _carriers = list;
                _carrierByIcao = byIcao;
                _ceased = cat.CeasedSince2020 ?? new();
                _catalogAsOf = cat.AsOf;
                _catalogStamp = stamp;
                _opResolved.Clear();
                _cache.Clear();
                Console.WriteLine($"[AIRLINES] Carrier catalog: {list.Count} carriers (as of {cat.AsOf})");
            }
            catch (Exception ex) { Console.WriteLine($"[AIRLINES] Carrier catalog error: {ex.Message}"); }
        }
    }

    private static string NormName(string? s)
    {
        if (string.IsNullOrWhiteSpace(s)) return "";
        var sb = new StringBuilder(s.Length);
        foreach (var ch in s.ToUpperInvariant()) sb.Append(ch >= 'A' && ch <= 'Z' ? ch : ' ');
        return string.Join(' ', sb.ToString().Split(' ', StringSplitOptions.RemoveEmptyEntries).Where(w => !NameNoise.Contains(w)));
    }

    /// <summary>
    /// ICAO designator for a filed operator: a 3-letter designator as-is; otherwise the catalog carrier whose name,
    /// alias or callsign the text begins with (longest match wins, so "EASTERN AIR EXPRESS" isn't read as Eastern
    /// Airlines). "" when unrecognized.
    /// </summary>
    private string ResolveOperator(string op)
    {
        if (op.Length == 0) return "";
        return _opResolved.GetOrAdd(op, o =>
        {
            if (o.Length == 3 && o.All(ch => ch >= 'A' && ch <= 'Z')) return o;
            var n = NormName(o);
            if (n.Length == 0) return "";
            string best = "";
            int bestLen = 0;
            foreach (var c in _carriers)
            {
                if (n.StartsWith(c.Icao + " ", StringComparison.Ordinal) && 3 > bestLen) { best = c.Icao; bestLen = 3; }
                foreach (var name in c.Aliases.Prepend(c.Name).Append(c.Callsign))
                {
                    var cn = NormName(name);
                    if (cn.Length >= 4 && cn.Length > bestLen
                        && (n == cn || n.StartsWith(cn + " ", StringComparison.Ordinal)))
                    {
                        best = c.Icao;
                        bestLen = cn.Length;
                    }
                }
            }
            return best;
        });
    }

    // ── Helpers ─────────────────────────────────────────────────────────────────────
    /// <summary>ICAO airline prefix of a callsign ("SKW5296" → "SKW"), or "" for registrations and the like.</summary>
    public static string Prefix(string cs) =>
        cs.Length >= 4 && IsUpper(cs[0]) && IsUpper(cs[1]) && IsUpper(cs[2]) && cs[3] >= '0' && cs[3] <= '9' ? cs[..3] : "";

    private static bool IsUpper(char c) => c >= 'A' && c <= 'Z';

    private static long StartOf(in AircraftFlightLog.Entry e) => e.Dep > 0 ? e.Dep : e.First > 0 ? e.First : e.Last;

    /// <summary>Estimated air minutes (last seen − actual departure), or 0 when there's no usable departure time.</summary>
    private static long AirMinutes(in AircraftFlightLog.Entry e)
    {
        if (e.Dep <= 0 || e.Last <= e.Dep) return 0;
        long s = e.Last - e.Dep;
        return s >= 300 && s < 18 * 3600 ? s / 60 : 0;
    }

    private static string Day(long t) => DateTimeOffset.FromUnixTimeSeconds(t).UtcDateTime.ToString("yyyy-MM-dd");

    private static string PairKey(string o, string d)
    {
        string a = AircraftFlightLog.AptKey(o), b = AircraftFlightLog.AptKey(d);
        return string.CompareOrdinal(a, b) <= 0 ? a + "-" + b : b + "-" + a;
    }

    private static int LowerBound(AircraftFlightLog.Entry[] a, long t)
    {
        int lo = 0, hi = a.Length;
        while (lo < hi)
        {
            int mid = (lo + hi) >> 1;
            if (a[mid].T < t) lo = mid + 1; else hi = mid;
        }
        return lo;
    }

    private static double Nm(double lat1, double lon1, double lat2, double lon2)
    {
        const double R = 3440.065;
        double dLat = (lat2 - lat1) * Math.PI / 180, dLon = (lon2 - lon1) * Math.PI / 180;
        double h = Math.Sin(dLat / 2) * Math.Sin(dLat / 2)
                   + Math.Cos(lat1 * Math.PI / 180) * Math.Cos(lat2 * Math.PI / 180) * Math.Sin(dLon / 2) * Math.Sin(dLon / 2);
        return R * 2 * Math.Atan2(Math.Sqrt(h), Math.Sqrt(1 - h));
    }

    private byte[]? Cached(string key, Func<object?> build)
    {
        var ttl = _ready ? TimeSpan.FromMinutes(5) : TimeSpan.FromSeconds(15);   // partial results while indexing
        if (_cache.TryGetValue(key, out var hit) && DateTime.UtcNow - hit.At < ttl) return hit.Json;
        lock (_buildLocks.GetOrAdd(key, _ => new object()))
        {
            if (_cache.TryGetValue(key, out hit) && DateTime.UtcNow - hit.At < ttl) return hit.Json;
            var obj = build();
            if (obj == null) return null;
            var json = JsonSerializer.SerializeToUtf8Bytes(obj, JsonOpts);
            _cache[key] = (DateTime.UtcNow, json);
            return json;
        }
    }

    // ── Directory ───────────────────────────────────────────────────────────────────
    /// <summary>Every catalog carrier plus other airline prefixes seen, with headline numbers for the window.</summary>
    public byte[] DirectoryJson(int days, bool reveal) => Cached($"dir|{days}|{reveal}", () => BuildDirectory(days, reveal))!;

    private object BuildDirectory(int days, bool reveal)
    {
        LoadCatalogIfChanged();
        PruneIfDue();
        long now = _now(), start = now - days * 86400L;
        double span = SpanDays(days, now);
        var acc = new Dictionary<string, DirAcc>(StringComparer.Ordinal);

        foreach (var (key, tail) in _tails)
        {
            var all = MergedOf(tail);
            int i0 = LowerBound(all, start);
            if (i0 >= all.Length) continue;
            TailMeta? meta = null;
            bool metaLoaded = false;
            for (int i = i0; i < all.Length; i++)
            {
                var f = all[i];
                var p = Prefix(f.Cs);
                if (p.Length == 0 || f.T > now + 300) continue;
                if (!metaLoaded)
                {
                    meta = _meta(key);
                    metaLoaded = true;
                    if (!reveal && meta?.Blocked == true) break;
                }
                if (!acc.TryGetValue(p, out var a)) acc[p] = a = new DirAcc();
                a.Flights++;
                a.Tails.Add(key);
                if (f.O.Length > 0) a.Airports.Add(AircraftFlightLog.AptKey(f.O));
                if (f.D.Length > 0) a.Airports.Add(AircraftFlightLog.AptKey(f.D));
                if (f.O.Length > 0 && f.D.Length > 0) a.Routes.Add(PairKey(f.O, f.D));
                a.AirMin += AirMinutes(f);
                if (meta?.Type is { Length: > 0 } type) a.Types[type] = a.Types.GetValueOrDefault(type) + 1;
                if (f.Op.Length > 0)
                {
                    // Only an operator that resolves to a designator can confirm or contradict the callsign. A name the
                    // catalog doesn't know ("WESTJET" for a non-catalog carrier) is unverifiable, not a mismatch — it's
                    // still kept in OpOther as the display hint.
                    var res = ResolveOperator(f.Op);
                    if (res.Length > 0) { a.OpKnown++; if (res == p) a.OpMatch++; }
                    if (res != p) a.OpOther[f.Op] = a.OpOther.GetValueOrDefault(f.Op) + 1;
                }
            }
        }

        object Row(string icao, Carrier? c, DirAcc? a) => new
        {
            icao,
            name = c?.Name,
            callsign = c?.Callsign,
            category = c?.Category ?? "other",
            partners = c?.Partners,
            confidence = c?.Confidence,
            note = c?.Note,
            inCatalog = c != null,
            flights = a?.Flights ?? 0,
            perDay = Math.Round((a?.Flights ?? 0) / span, 1),
            tails = a?.Tails.Count ?? 0,
            airports = a?.Airports.Count ?? 0,
            routes = a?.Routes.Count ?? 0,
            hpd = a != null && a.Tails.Count > 0 ? Math.Round(a.AirMin / 60.0 / span / a.Tails.Count, 2) : (double?)null,
            topTypes = a?.Types.OrderByDescending(t => t.Value).Take(4).Select(t => t.Key).ToArray(),
            opMatchPct = a != null && a.OpKnown > 0 ? Math.Round(100.0 * a.OpMatch / a.OpKnown, 1) : (double?)null,
            opOther = a?.OpOther.OrderByDescending(o => o.Value).Take(3).Select(o => o.Key).ToArray(),
        };

        var catalog = _carrierByIcao;
        var carriers = _carriers.Select(c => Row(c.Icao, c, acc.GetValueOrDefault(c.Icao))).ToList();
        long minOther = Math.Max(3, (long)Math.Ceiling(span * 2));   // "other" prefixes need ~2 flights/day to be listed
        var others = acc.Where(kv => !catalog.ContainsKey(kv.Key) && kv.Value.Flights >= minOther)
            .OrderByDescending(kv => kv.Value.Flights).Take(200)
            .Select(kv => Row(kv.Key, null, kv.Value)).ToList();
        return new
        {
            generated = now, days, span = Math.Round(span, 2), windowDays = WindowDays,
            ready = _ready, state = _state, catalogAsOf = _catalogAsOf,
            carriers, others,
            ceased = _ceased.Select(c => new { icao = c.Icao, name = c.Name, ceased = c.Ceased, note = c.Note }).ToList(),
        };
    }

    // ── One carrier ─────────────────────────────────────────────────────────────────
    public byte[]? CarrierJson(string icao, int days, bool reveal)
    {
        icao = (icao ?? "").Trim().ToUpperInvariant();
        if (icao.Length is < 2 or > 4) return null;
        return Cached($"carrier|{icao}|{days}|{reveal}", () => BuildCarrier(icao, days, reveal));
    }

    private object? BuildCarrier(string icao, int days, bool reveal)
    {
        LoadCatalogIfChanged();
        PruneIfDue();
        long now = _now(), start = now - days * 86400L, recentCut = now - 7 * 86400L;
        double span = SpanDays(days, now);
        _carrierByIcao.TryGetValue(icao, out var carrier);

        var apts = new Dictionary<string, AptAcc>(StringComparer.Ordinal);
        AptAcc Apt(string code)
        {
            var k = AircraftFlightLog.AptKey(code);
            if (!apts.TryGetValue(k, out var a)) apts[k] = a = new AptAcc { Code = code };
            else if (code.Length > a.Code.Length) a.Code = code;   // prefer the ICAO spelling
            return a;
        }
        var routes = new Dictionary<(string, string), RouteAcc>();
        var daily = new SortedDictionary<string, DayAcc>(StringComparer.Ordinal);
        var hourly = new long[24];
        var dow = new long[7];
        var types = new Dictionary<string, TypeAcc>(StringComparer.Ordinal);
        var ops = new Dictionary<string, long>(StringComparer.Ordinal);
        long flights = 0, timed = 0, airMin = 0, opKnown = 0, opMatch = 0, turnSum = 0, turns = 0, nonRevCount = 0, activeDaysSum = 0;
        var nonRev = new List<(long T, string Cs, string O, string D, string Reg, string Key)>();
        var tailRows = new List<TailRow>();

        foreach (var (key, tail) in _tails)
        {
            var all = MergedOf(tail);
            int i0 = LowerBound(all, start);
            bool flies = false;
            for (int i = i0; i < all.Length && !flies; i++) flies = Prefix(all[i].Cs) == icao;
            if (!flies) continue;
            var meta = _meta(key);
            if (!reveal && meta?.Blocked == true) continue;

            var row = new TailRow
            {
                Key = key,
                Reg = meta?.Reg ?? (key.StartsWith("REG:", StringComparison.Ordinal) ? key[4..] : ""),
                Hex = meta?.Hex,
                Type = meta?.Type ?? "",
                Op = meta?.Operator,
            };
            var tailDays = new HashSet<string>(StringComparer.Ordinal);
            var active = new HashSet<string>(StringComparer.Ordinal);
            var others = new Dictionary<string, long>(StringComparer.Ordinal);
            long tTurnSum = 0, tTurns = 0, tAll = 0, firstT = 0, lastT = 0;
            AircraftFlightLog.Entry prev = default;
            bool hasPrev = false;

            for (int i = i0; i < all.Length; i++)
            {
                var f = all[i];
                long ft = f.T;
                if (ft > now + 300) continue;
                tAll++;
                var day = Day(ft);
                tailDays.Add(day);
                if (f.Last > 0) tailDays.Add(Day(f.Last));   // arrival day counts as active too (overnight legs)
                if (firstT == 0) firstT = ft;
                lastT = Math.Max(lastT, Math.Max(ft, f.Last));
                var p = Prefix(f.Cs);
                bool mine = p == icao;

                if (hasPrev)
                {
                    long aEnd = prev.Last, bStart = StartOf(f);
                    if (aEnd > 0 && bStart > aEnd)
                    {
                        long gap = bStart - aEnd;
                        bool related = mine || Prefix(prev.Cs) == icao;
                        if (gap < LongStop)
                        {
                            tTurnSum += gap;
                            tTurns++;
                            if (related) { turnSum += gap; turns++; }
                        }
                        else
                        {
                            row.Stops++;
                            if (gap > row.LongestStop) row.LongestStop = gap;
                            if (related && prev.D.Length > 0) Apt(prev.D).Stops++;
                        }
                    }
                }
                prev = f;
                hasPrev = true;

                if (!mine)
                {
                    if (p.Length == 3) others[p] = others.GetValueOrDefault(p) + 1;
                    else
                    {
                        nonRevCount++;
                        nonRev.Add((ft, f.Cs, f.O, f.D, row.Reg, key));
                    }
                    continue;
                }

                flights++;
                row.Flights++;
                active.Add(day);
                long am = AirMinutes(f);
                if (am > 0) { airMin += am; timed++; row.AirMin += am; }
                var utc = DateTimeOffset.FromUnixTimeSeconds(ft).UtcDateTime;
                hourly[utc.Hour]++;
                dow[(int)utc.DayOfWeek]++;
                if (!daily.TryGetValue(day, out var da)) daily[day] = da = new DayAcc();
                da.Flights++;
                da.Tails.Add(key);
                if (f.O.Length > 0) Apt(f.O).Dep++;
                if (f.D.Length > 0) Apt(f.D).Arr++;
                if (f.O.Length > 0 && f.D.Length > 0)
                {
                    string ka = AircraftFlightLog.AptKey(f.O), kb = AircraftFlightLog.AptKey(f.D);
                    bool fwd = string.CompareOrdinal(ka, kb) <= 0;
                    var rk = fwd ? (ka, kb) : (kb, ka);
                    if (!routes.TryGetValue(rk, out var r)) routes[rk] = r = new RouteAcc { A = fwd ? f.O : f.D, B = fwd ? f.D : f.O };
                    if (fwd) r.AB++; else r.BA++;
                    if (am > 0) { r.AirMin += am; r.Timed++; }
                    r.Tails.Add(key);
                    if (ft >= recentCut) r.Recent++; else r.Earlier++;
                }
                if (f.Op.Length > 0)
                {
                    ops[f.Op] = ops.GetValueOrDefault(f.Op) + 1;
                    var res = ResolveOperator(f.Op);   // unresolvable names are unverifiable, not mismatches
                    if (res.Length > 0) { opKnown++; if (res == icao) opMatch++; }
                }
                if (f.Last >= row.LastSeen) { row.LastSeen = f.Last; row.LastAt = f.D; row.LastCs = f.Cs; }
            }
            if (row.Flights == 0) continue;

            row.Days = active.Count;
            activeDaysSum += row.Days;
            row.TurnSec = tTurns > 0 ? tTurnSum / tTurns : -1;
            row.Share = tAll > 0 ? 100.0 * row.Flights / tAll : 0;
            row.Other = others.OrderByDescending(x => x.Value).Select(x => $"{x.Key}:{x.Value}").ToArray();
            if (firstT > 0)
            {
                var d0 = DateTimeOffset.FromUnixTimeSeconds(firstT).UtcDateTime.Date;
                var d1 = DateTimeOffset.FromUnixTimeSeconds(lastT).UtcDateTime.Date;
                for (var d = d0; d <= d1; d = d.AddDays(1))
                    if (!tailDays.Contains(d.ToString("yyyy-MM-dd"))) row.Idle++;
            }
            tailRows.Add(row);
            if (row.Type.Length > 0)
            {
                if (!types.TryGetValue(row.Type, out var ta)) types[row.Type] = ta = new TypeAcc();
                ta.Tails++;
                ta.Flights += row.Flights;
                ta.AirMin += row.AirMin;
                ta.ActiveDays += row.Days;
            }
        }
        if (flights == 0 && carrier == null) return null;

        // Routes with distance; stage length and international share come from the located ones.
        double nmSum = 0, nmFlights = 0;
        long intl = 0, located = 0;
        var routeRows = new List<object>(routes.Count);
        foreach (var r in routes.Values.OrderByDescending(r => r.AB + r.BA))
        {
            var ia = _airport(r.A);
            var ib = _airport(r.B);
            long total = r.AB + r.BA;
            double? nm = null;
            if (ia != null && ib != null)
            {
                nm = Math.Round(Nm(ia.Lat, ia.Lon, ib.Lat, ib.Lon));
                nmSum += nm.Value * total;
                nmFlights += total;
                if (ia.Country.Length > 0 && ib.Country.Length > 0)
                {
                    located += total;
                    if (!DomesticCountries.Contains(ia.Country) || !DomesticCountries.Contains(ib.Country)) intl += total;
                }
            }
            routeRows.Add(new
            {
                a = r.A, b = r.B, ab = r.AB, ba = r.BA, total,
                perWeek = Math.Round(total * 7 / span, 1),
                avgMin = r.Timed > 0 ? r.AirMin / r.Timed : (long?)null,
                nm, tails = r.Tails.Count, recent = r.Recent, earlier = r.Earlier,
            });
        }

        var aptRows = apts.Values.OrderByDescending(a => a.Dep + a.Arr).Select(a =>
        {
            var info = _airport(a.Code);
            return new
            {
                code = a.Code, name = info?.Name, city = info?.City, country = info?.Country,
                lat = info?.Lat, lon = info?.Lon, dep = a.Dep, arr = a.Arr, stops = a.Stops,
            };
        }).ToList();

        var typeRows = types.OrderByDescending(t => t.Value.Tails).Select(t => new
        {
            type = t.Key, tails = t.Value.Tails, flights = t.Value.Flights,
            hours = Math.Round(t.Value.AirMin / 60.0),
            hpd = Math.Round(t.Value.AirMin / 60.0 / span / Math.Max(1, t.Value.Tails), 2),
            flightsPerDay = Math.Round((double)t.Value.Flights / Math.Max(1, t.Value.ActiveDays), 2),
        }).ToList();

        var opRows = ops.OrderByDescending(o => o.Value).Take(20).Select(o =>
        {
            var res = ResolveOperator(o.Key);
            return new { op = o.Key, flights = o.Value, resolved = res.Length > 0 ? res : null, match = res == icao };
        }).ToList();

        bool compare = days >= 14 && span >= 14;   // new/dropped routes need an earlier period to compare against
        var intel = new
        {
            newRoutes = compare
                ? routes.Values.Where(r => r.Recent > 0 && r.Earlier == 0).OrderByDescending(r => r.Recent).Take(30)
                    .Select(r => new { a = r.A, b = r.B, recent = r.Recent }).ToList()
                : null,
            droppedRoutes = compare
                ? routes.Values.Where(r => r.Earlier > 0 && r.Recent == 0).OrderByDescending(r => r.Earlier).Take(30)
                    .Select(r => new { a = r.A, b = r.B, earlier = r.Earlier }).ToList()
                : null,
            sharedTails = tailRows.Where(t => t.Other.Length > 0).OrderByDescending(t => t.Flights).Take(50)
                .Select(t => new { key = t.Key, reg = t.Reg, type = t.Type, flights = t.Flights, other = t.Other }).ToList(),
            nonRevenue = new
            {
                count = nonRevCount,
                examples = nonRev.OrderByDescending(x => x.T).Take(40)
                    .Select(x => new { t = x.T, cs = x.Cs, o = x.O, d = x.D, reg = x.Reg, key = x.Key }).ToList(),
            },
        };

        var summary = new
        {
            flights,
            perDay = Math.Round(flights / span, 1),
            tails = tailRows.Count,
            airports = apts.Count,
            routes = routes.Count,
            airHours = Math.Round(airMin / 60.0),
            timedPct = flights > 0 ? Math.Round(100.0 * timed / flights) : 0,
            hpd = tailRows.Count > 0 ? Math.Round(airMin / 60.0 / span / tailRows.Count, 2) : 0,
            flightsPerTailDay = activeDaysSum > 0 ? Math.Round((double)flights / activeDaysSum, 2) : 0,
            turnMin = turns > 0 ? turnSum / turns / 60 : (long?)null,
            stageNm = nmFlights > 0 ? Math.Round(nmSum / nmFlights) : (double?)null,
            intlPct = located > 0 ? Math.Round(100.0 * intl / located, 1) : (double?)null,
            opKnown,
            opMatchPct = opKnown > 0 ? Math.Round(100.0 * opMatch / opKnown, 1) : (double?)null,
            nonRevenue = nonRevCount,
        };

        return new
        {
            icao, generated = now, days, span = Math.Round(span, 2), windowDays = WindowDays, ready = _ready,
            carrier = carrier == null ? null : new
            {
                name = carrier.Name, callsign = carrier.Callsign, category = carrier.Category,
                partners = carrier.Partners, confidence = carrier.Confidence, note = carrier.Note,
            },
            summary,
            daily = daily.Select(d => new { d = d.Key, n = d.Value.Flights, tails = d.Value.Tails.Count }).ToList(),
            hourly,
            dow,
            types = typeRows,
            ops = opRows,
            airports = aptRows,
            routes = routeRows,
            tails = tailRows.OrderByDescending(t => t.Flights).Select(t => new
            {
                key = t.Key, reg = t.Reg, hex = t.Hex, type = t.Type, op = t.Op,
                flights = t.Flights, days = t.Days,
                hours = Math.Round(t.AirMin / 60.0, 1),
                hpd = Math.Round(t.AirMin / 60.0 / span, 2),
                turnMin = t.TurnSec >= 0 ? t.TurnSec / 60 : (long?)null,
                stops = t.Stops, idle = t.Idle,
                longestH = Math.Round(t.LongestStop / 3600.0, 1),
                lastAt = t.LastAt, lastSeen = t.LastSeen, lastCs = t.LastCs,
                share = Math.Round(t.Share),
                other = t.Other,
            }).ToList(),
            intel,
        };
    }

    // ── One tail ────────────────────────────────────────────────────────────────────
    /// <summary>Every flight of one tail in the window (any callsign), with airport coordinates, for the tail view.</summary>
    public byte[]? TailJson(string key, int days, bool reveal)
    {
        if (string.IsNullOrWhiteSpace(key) || !_tails.TryGetValue(key, out var tail)) return null;
        var meta = _meta(key);
        if (!reveal && meta?.Blocked == true) return null;
        long now = _now(), start = now - days * 86400L;
        var all = MergedOf(tail);
        int i0 = LowerBound(all, start);
        var codes = new HashSet<string>(StringComparer.Ordinal);
        var flights = new List<object>(Math.Max(0, all.Length - i0));
        for (int i = i0; i < all.Length; i++)
        {
            var f = all[i];
            if (f.T > now + 300) continue;
            flights.Add(new
            {
                dep = f.Dep, first = f.First, last = f.Last, cs = f.Cs, o = f.O, d = f.D, op = f.Op,
                carrier = Prefix(f.Cs), airMin = AirMinutes(f),
            });
            if (f.O.Length > 0) codes.Add(f.O);
            if (f.D.Length > 0) codes.Add(f.D);
        }
        var airports = codes.Select(c =>
        {
            var a = _airport(c);
            return new { code = c, name = a?.Name, city = a?.City, country = a?.Country, lat = a?.Lat, lon = a?.Lon };
        }).ToList();
        return JsonSerializer.SerializeToUtf8Bytes(new
        {
            key,
            reg = meta?.Reg ?? (key.StartsWith("REG:", StringComparison.Ordinal) ? key[4..] : null),
            hex = meta?.Hex, type = meta?.Type, op = meta?.Operator,
            days, generated = now, flights, airports,
        }, JsonOpts);
    }
}
