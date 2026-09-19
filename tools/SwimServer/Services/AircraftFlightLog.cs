using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Channels;

namespace SwimServer;

/// <summary>
/// Permanent, dated flight log for every airframe in the aircraft database: one entry per flight with its
/// departure time, callsign, origin, destination and filed operator. Kept forever (deliberately not budget-managed).
/// Only flights that actually flew are logged — a position report or an actual departure time; ~45% of purged
/// flight plans have neither (mostly PROPOSED plans that were refiled, cancelled or never activated) and would show
/// as phantom flights.
///
/// Storage: append-only CSV lines <c>key,dep,first,last,callsign,origin,dest,operator,registration</c> (epoch seconds;
/// dep is 0 when the feed never gave an actual departure time). The registration is stored per entry, not just per
/// key, because the key is normally the Mode S hex and operators do file the wrong one: ~0.7% of hex codes turn up
/// against two or more registrations (a one-digit typo like N604SK/N606SK, or a placeholder hex shared by a dozen
/// unrelated airframes), which otherwise fuses two aeroplanes into one impossible tail. With the registration on the
/// row, a conflicted key can be split back apart. Rows are sharded by a hash of the airframe key into 1,024 files under
/// aircraft-db/flights/. Sharding avoids one tiny file per tail (tens of thousands of 4 KB blocks on the SD card)
/// while keeping a tail lookup to a scan of ~1/1024 of the log.
///
/// Duplicates: one physical flight is purged once per ARTCC that tracked it (~1.6 GUFIs per flight), so the
/// same flight arrives several times. A small per-tail memory of recent entries drops most duplicates before
/// they are written; anything that slips through (e.g. across a restart) is merged on read. Two entries are the
/// same flight when callsign + origin + destination match and their actual departure times are within 20 min —
/// or, when either lacks one, their best times are within 12 h.
///
/// Backfill: on first start the whole flight-history archive is scanned newest day first on a background thread,
/// throttled for the shared Pi, using fast field extraction instead of a full JSON parse of each multi-KB history
/// line. Finished day files are recorded, so a restart resumes rather than starting over.
/// </summary>
sealed class AircraftFlightLog
{
    public readonly record struct Entry(long Dep, long First, long Last, string Cs, string O, string D, string Op = "",
        string Reg = "")
    {
        /// <summary>Best time for the flight: actual departure, else first seen, else last seen.</summary>
        public long T => Dep > 0 ? Dep : First > 0 ? First : Last;
    }

    /// <summary>One flight-history line reduced to the airframe + flight fields (fed to AircraftDb).</summary>
    public sealed record HistoryRow(string Key, string? Hex, string? Reg, string? Selcal, string? Type,
        string? Op, string? Wake, string? Equip, string? Cs, string? O, string? D, DateTime Seen);

    public const int Shards = 1024;
    private const int RecentPerKey = 6;
    private const long SameDepWindow = 20 * 60;
    private const long SameTimeWindow = 12 * 3600;

    private readonly string _dir;
    private readonly string _historyDir;
    private readonly object[] _shardLocks;
    private readonly Channel<(string Key, Entry E)> _queue = Channel.CreateUnbounded<(string Key, Entry E)>();
    private readonly ConcurrentDictionary<string, List<Entry>> _recent = new();
    private int _started;

    private volatile int _backfillDone, _backfillTotal;
    private volatile bool _backfillRunning;
    public int BackfillDone => _backfillDone;
    public int BackfillTotal => _backfillTotal;
    public bool BackfillRunning => _backfillRunning;

    /// <summary>
    /// Raised for every flight accepted into the log (live purges and the history backfill), after duplicate
    /// filtering and before it reaches disk — lets in-memory indexes (airline research) stay current without
    /// re-reading the shards.
    /// </summary>
    public event Action<string, Entry>? Appended;

    public AircraftFlightLog(string dir, string historyDir)
    {
        _dir = dir;
        _historyDir = historyDir;
        _shardLocks = new object[Shards];
        for (int i = 0; i < Shards; i++) _shardLocks[i] = new object();
    }

    // ── Keys (the single source of truth, shared with AircraftDb so log keys always match record keys) ──
    // ICAO 24-bit Mode S address is the stable per-airframe key; registration is the fallback.
    public static string? NormHex(string? modeS)
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

    public static string? NormReg(string? reg) =>
        string.IsNullOrWhiteSpace(reg) ? null : reg.Trim().ToUpperInvariant();

    /// <summary>
    /// Normalized registration, or null when it isn't one. Some operators file a type designator or placeholder
    /// in the registration field — Cape Air sends "P212" on its Tecnam P2012s AND on its Cessna 402 flights —
    /// and keyed as a tail that merges a whole fleet into one fake airframe. Rejected: a value equal to the
    /// flight's own type, and any 2–4 character value that isn't a US N-number (real registrations elsewhere are
    /// 5+ characters once the hyphen is dropped: G-ABCD, C-GABC, PJ-WII, B-1234). Short N-numbers (N1, N12) stay.
    /// </summary>
    public static string? CleanReg(string? reg, string? type)
    {
        var r = NormReg(reg);
        if (r == null) return null;
        if (!string.IsNullOrWhiteSpace(type) && string.Equals(r, type.Trim(), StringComparison.OrdinalIgnoreCase)) return null;
        if (r.Replace("-", "").Length <= 4 && r[0] != 'N') return null;
        return r;
    }

    public static string KeyFor(string? hex, string? reg) => hex ?? "REG:" + reg;

    /// <summary>FNV-1a hash of the key → shard index.</summary>
    public static int ShardOf(string key)
    {
        uint h = 2166136261;
        foreach (var c in key) { h ^= c; h *= 16777619; }
        return (int)(h & (Shards - 1));
    }

    private string ShardPath(int shard) => Path.Combine(_dir, shard.ToString("x3") + ".csv");

    // ── Entries ──
    public static long ParseEpoch(string? s)
    {
        if (string.IsNullOrWhiteSpace(s)) return 0;
        return DateTimeOffset.TryParse(s, CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var t) ? t.ToUnixTimeSeconds() : 0;
    }

    public static long Epoch(DateTime t) =>
        t == default ? 0 : new DateTimeOffset(DateTime.SpecifyKind(t, DateTimeKind.Utc)).ToUnixTimeSeconds();

    private static string Clean(string? s) =>
        string.IsNullOrWhiteSpace(s) ? "" : s.Trim().ToUpperInvariant().Replace(',', ' ').Replace('\n', ' ').Replace('\r', ' ');

    public static Entry MakeEntry(long dep, long first, long last, string? cs, string? o, string? d, string? op = null,
        string? reg = null)
    {
        long cap = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 300;   // a stray future time never sorts first
        long Fix(long v) => v <= 0 ? 0 : Math.Min(v, cap);
        return new Entry(Fix(dep), Fix(first), Fix(last), Clean(cs), Clean(o), Clean(d), Clean(op), Clean(reg));
    }

    /// <summary>
    /// Airport code for comparison. ARTCCs mix the ICAO and FAA forms of the same US airport ("K26N" vs "26N",
    /// "PHNL" vs "HNL"), so a 4-character K/P code compares as its 3-character LID.
    /// </summary>
    public static string AptKey(string a) =>
        a.Length == 4 && (a[0] == 'K' || a[0] == 'P') ? a.Substring(1) : a;

    public static bool SameFlight(in Entry a, in Entry b)
    {
        if (a.Cs != b.Cs || AptKey(a.O) != AptKey(b.O) || AptKey(a.D) != AptKey(b.D)) return false;
        if (a.Dep > 0 && b.Dep > 0) return Math.Abs(a.Dep - b.Dep) <= SameDepWindow;
        return Math.Abs(a.T - b.T) <= SameTimeWindow;
    }

    // ── Write ──
    /// <summary>Queue a flight for the log; dropped if it duplicates one recently logged for this tail.</summary>
    public void Record(string key, Entry e)
    {
        if (e.T <= 0 || key.Contains(',') || SeenRecently(key, e)) return;
        _queue.Writer.TryWrite((key, e));
        RaiseAppended(key, e);
    }

    private void RaiseAppended(string key, in Entry e)
    {
        try { Appended?.Invoke(key, e); }
        catch (Exception ex) { Console.WriteLine($"[AIRCRAFT] Flight-log subscriber error: {ex.Message}"); }
    }

    private bool SeenRecently(string key, in Entry e)
    {
        var list = _recent.GetOrAdd(key, _ => new List<Entry>(RecentPerKey));
        lock (list)
        {
            foreach (var x in list)
                if (SameFlight(x, e)) return true;
            list.Add(e);
            if (list.Count > RecentPerKey) list.RemoveAt(0);
            return false;
        }
    }

    private static void AppendLine(StringBuilder sb, string key, in Entry e) =>
        sb.Append(key).Append(',').Append(e.Dep).Append(',').Append(e.First).Append(',').Append(e.Last)
          .Append(',').Append(e.Cs).Append(',').Append(e.O).Append(',').Append(e.D).Append(',').Append(e.Op)
          .Append(',').Append(e.Reg).Append('\n');

    private void WriteBatch(Dictionary<int, StringBuilder> batch)
    {
        if (batch.Count == 0) return;
        // Idempotent and cheap: keeps appends working if the directory was never created (Record/Flush before
        // Start) or was removed while running, instead of every write failing.
        try { Directory.CreateDirectory(_dir); } catch { }
        foreach (var (shard, sb) in batch)
        {
            if (sb.Length == 0) continue;
            try
            {
                lock (_shardLocks[shard]) File.AppendAllText(ShardPath(shard), sb.ToString());
            }
            catch (Exception ex) { Console.WriteLine($"[AIRCRAFT] Flight-log write error ({shard:x3}): {ex.Message}"); }
            sb.Clear();
        }
    }

    private int DrainQueue(Dictionary<int, StringBuilder> batch)
    {
        int n = 0;
        while (_queue.Reader.TryRead(out var item))
        {
            int s = ShardOf(item.Key);
            if (!batch.TryGetValue(s, out var sb)) batch[s] = sb = new StringBuilder();
            AppendLine(sb, item.Key, item.E);
            n++;
        }
        return n;
    }

    /// <summary>Write everything queued now (called on the periodic save and at shutdown).</summary>
    public void Flush()
    {
        var batch = new Dictionary<int, StringBuilder>();
        if (DrainQueue(batch) > 0) WriteBatch(batch);
    }

    private async Task WriterLoop()
    {
        var batch = new Dictionary<int, StringBuilder>();
        try
        {
            while (await _queue.Reader.WaitToReadAsync())
            {
                await Task.Delay(2000);            // let a purge burst collect, then touch each shard once
                if (DrainQueue(batch) > 0) WriteBatch(batch);
            }
        }
        catch (Exception ex) { Console.WriteLine($"[AIRCRAFT] Flight-log writer stopped: {ex.Message}"); }
    }

    // ── Read ──
    private static bool TryParseLine(string line, out string key, out Entry e)
    {
        key = "";
        e = default;
        var p = line.Split(',');
        // 9 fields now (registration); 8-field lines predate it (v3, operator) and 7-field lines predate that.
        // Widening the row rather than bumping LogVersion keeps every existing line readable — a bump wipes the
        // shards and re-imports, which silently loses anything older than the flight-history archive.
        if ((p.Length < 7 || p.Length > 9)
            || !long.TryParse(p[1], out var dep) || !long.TryParse(p[2], out var first) || !long.TryParse(p[3], out var last))
            return false;
        key = p[0];
        e = new Entry(dep, first, last, p[4], p[5], p[6], p.Length >= 8 ? p[7] : "", p.Length >= 9 ? p[8] : "");
        return true;
    }

    private static string? ReadShardText(string path)
    {
        if (!File.Exists(path)) return null;
        try
        {
            using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var sr = new StreamReader(fs);
            return sr.ReadToEnd();
        }
        catch (IOException) { return null; }
    }

    /// <summary>All logged flights for these keys, duplicates merged, oldest first.</summary>
    public List<Entry> Read(IEnumerable<string> keys)
    {
        var all = new List<Entry>();
        foreach (var key in keys.Distinct())
        {
            var text = ReadShardText(ShardPath(ShardOf(key)));
            if (text == null) continue;

            // Only lines terminated by '\n' — anything after the last newline is an append still in progress.
            int limit = text.LastIndexOf('\n');
            var prefix = key + ",";
            for (int pos = 0; pos < limit;)
            {
                int nl = text.IndexOf('\n', pos);
                if (nl < 0 || nl > limit) break;
                if (nl - pos > prefix.Length && string.CompareOrdinal(text, pos, prefix, 0, prefix.Length) == 0
                    && TryParseLine(text.Substring(pos, nl - pos), out _, out var entry))
                    all.Add(entry);
                pos = nl + 1;
            }
        }
        return Merge(all);
    }

    /// <summary>
    /// Every stored entry whose best time is at or after <paramref name="sinceEpoch"/>, shard by shard — raw (not
    /// merged), for building an in-memory index at startup. Throttled like the backfill. Returns the count.
    /// </summary>
    public long ScanAll(long sinceEpoch, Action<string, Entry> sink)
    {
        long n = 0;
        var burst = Stopwatch.StartNew();
        for (int shard = 0; shard < Shards; shard++)
        {
            var text = ReadShardText(ShardPath(shard));
            if (text == null) continue;
            int limit = text.LastIndexOf('\n');
            for (int pos = 0; pos < limit;)
            {
                int nl = text.IndexOf('\n', pos);
                if (nl < 0 || nl > limit) break;
                if (TryParseLine(text.Substring(pos, nl - pos), out var key, out var e) && e.T >= sinceEpoch)
                {
                    sink(key, e);
                    n++;
                }
                pos = nl + 1;
            }
            if (burst.ElapsedMilliseconds >= 100) { Thread.Sleep(50); burst.Restart(); }
        }
        return n;
    }

    public static List<Entry> Merge(List<Entry> all)
    {
        all.Sort((a, b) => a.T.CompareTo(b.T));
        var merged = new List<Entry>(all.Count);
        var latest = new Dictionary<(string, string, string), int>();
        foreach (var e in all)
        {
            var k = (e.Cs, AptKey(e.O), AptKey(e.D));
            if (latest.TryGetValue(k, out var i) && SameFlight(merged[i], e))
            {
                var m = merged[i];
                merged[i] = new Entry(m.Dep > 0 ? m.Dep : e.Dep, MinPositive(m.First, e.First),
                                      Math.Max(m.Last, e.Last), m.Cs, Longer(m.O, e.O), Longer(m.D, e.D),   // keep ICAO form
                                      m.Op.Length > 0 ? m.Op : e.Op, m.Reg.Length > 0 ? m.Reg : e.Reg);
            }
            else
            {
                latest[k] = merged.Count;
                merged.Add(e);
            }
        }
        FixSharedDepartures(merged);
        // Merges and departure fixes change best times — re-order.
        merged.Sort((a, b) => a.T.CompareTo(b.T));
        return merged;
    }

    private static long MinPositive(long a, long b) => a <= 0 ? b : b <= 0 ? a : Math.Min(a, b);
    private static string Longer(string a, string b) => b.Length > a.Length ? b : a;
    private static long SeenTime(in Entry e) => e.First > 0 ? e.First : e.Last;
    private const long SharedDepWindow = 120;

    /// <summary>
    /// One tail can't depart twice within two minutes, yet some flight plans carry the actual departure time of the
    /// tail's EARLIER leg (NetJets EJA480: KHVN→CYQA and the later CYQA→KPIT both "departed" 12:09Z, the second first
    /// seen 3½ h later). For legs sharing a departure time, keep it on the leg the feed saw closest to it; a leg on
    /// the same route under another callsign is the same flight and is folded in; legs on other routes lose the
    /// borrowed time and fall back to when they were first seen.
    /// </summary>
    private static void FixSharedDepartures(List<Entry> list)
    {
        var idx = Enumerable.Range(0, list.Count).Where(i => list[i].Dep > 0).OrderBy(i => list[i].Dep).ToList();
        var remove = new HashSet<int>();
        for (int s = 0; s < idx.Count;)
        {
            int e = s + 1;
            while (e < idx.Count && list[idx[e]].Dep - list[idx[e - 1]].Dep <= SharedDepWindow) e++;
            if (e - s > 1)
            {
                var cluster = idx.GetRange(s, e - s);
                int keep = cluster.OrderBy(i => Math.Abs(SeenTime(list[i]) - list[i].Dep)).First();
                var k = list[keep];
                foreach (var i in cluster)
                {
                    if (i == keep) continue;
                    var x = list[i];
                    if (AptKey(x.O) == AptKey(k.O) && AptKey(x.D) == AptKey(k.D))
                    {
                        k = new Entry(k.Dep, MinPositive(k.First, x.First), Math.Max(k.Last, x.Last), k.Cs,
                                      Longer(k.O, x.O), Longer(k.D, x.D), k.Op.Length > 0 ? k.Op : x.Op,
                                      k.Reg.Length > 0 ? k.Reg : x.Reg);
                        remove.Add(i);
                    }
                    else
                    {
                        list[i] = new Entry(0, x.First, x.Last, x.Cs, x.O, x.D, x.Op, x.Reg);
                    }
                }
                list[keep] = k;
            }
            s = e;
        }
        if (remove.Count > 0)
        {
            var kept = list.Where((_, i) => !remove.Contains(i)).ToList();
            list.Clear();
            list.AddRange(kept);
        }
    }

    // ── Start / backfill ──

    // Log format version. Bump ONLY for a change that makes existing lines wrong or incomplete: a bump wipes the log
    // and re-imports it from flight-history, which is budget-capped — once history has rolled past the log's oldest
    // day, bumping would PERMANENTLY lose those flights.
    //   v1: every purged flight plan.   v2: only flights that flew (position report or actual departure).
    //   v3: + filed operator per flight (for airline research; bumped while the log was still fully rebuildable).
    private const int LogVersion = 3;

    private void MigrateFormat()
    {
        var verFile = Path.Combine(_dir, "format-version.txt");
        int ver;
        if (File.Exists(verFile) && int.TryParse(File.ReadAllText(verFile).Trim(), out var v)) ver = v;
        else ver = Directory.EnumerateFiles(_dir, "*.csv").Any() ? 1 : LogVersion;   // no file: v1 log, or brand new

        if (ver < LogVersion)
        {
            int n = 0;
            foreach (var f in Directory.GetFiles(_dir, "*.csv")) { File.Delete(f); n++; }
            var done = Path.Combine(_dir, "backfill-done.txt");
            if (File.Exists(done)) File.Delete(done);
            Console.WriteLine($"[AIRCRAFT] Flight log format v{ver} → v{LogVersion}: cleared {n} shard(s), rebuilding from flight-history");
        }
        if (ver < LogVersion || !File.Exists(verFile)) File.WriteAllText(verFile, LogVersion + "\n");
    }

    /// <summary>Start the background writer and the one-time, resumable history backfill.</summary>
    /// <param name="onRepaired">
    /// Called once if the registration repair actually recovered rows — in-memory indexes built from the log
    /// (airline research) are stale at that point and need rebuilding to see them.
    /// </param>
    public void Start(Action<HistoryRow>? onBackfillRow = null, Action? onBackfillComplete = null, Action? onRepaired = null)
    {
        if (Interlocked.Exchange(ref _started, 1) == 1) return;
        Directory.CreateDirectory(_dir);
        MigrateFormat();
        RepairTornTails();
        _ = Task.Run(WriterLoop);
        var t = new Thread(() =>
        {
            Backfill(onBackfillRow, onBackfillComplete);
            RepairRegistrationsOnce(onRepaired);
        })
        {
            IsBackground = true,
            Name = "flightlog-backfill",
        };
        try { t.Priority = ThreadPriority.BelowNormal; } catch { }
        t.Start();
    }

    /// <summary>
    /// A crash mid-append can leave a shard ending in a partial line; the next append would fuse onto it and
    /// corrupt that entry too. Truncate each shard back to its last complete line.
    /// </summary>
    private void RepairTornTails()
    {
        foreach (var path in Directory.GetFiles(_dir, "*.csv"))
        {
            try
            {
                using var fs = new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.Read);
                if (fs.Length == 0) continue;
                fs.Seek(-1, SeekOrigin.End);
                if (fs.ReadByte() == '\n') continue;

                long pos = fs.Length - 1, cut = 0;
                var buf = new byte[4096];
                while (pos > 0)
                {
                    int len = (int)Math.Min(buf.Length, pos);
                    fs.Seek(pos - len, SeekOrigin.Begin);
                    fs.ReadExactly(buf, 0, len);
                    int nl = Array.LastIndexOf(buf, (byte)'\n', len - 1);
                    if (nl >= 0) { cut = pos - len + nl + 1; break; }
                    pos -= len;
                }
                fs.SetLength(cut);
                Console.WriteLine($"[AIRCRAFT] Flight log {Path.GetFileName(path)}: dropped a torn final line");
            }
            catch (IOException) { }
        }
    }

    private static readonly Regex DayFile = new(@"^\d{4}-\d{2}-\d{2}\.jsonl$", RegexOptions.Compiled);

    public readonly record struct RepairResult(int SharedKeys, int RowsFilled, int ShardsRewritten, long HistoryLines);

    // Bump to re-run the repair on an existing log (e.g. after more shared codes have come to light).
    private const int RepairVersion = 2;

    /// <summary>What the one-off registration repair did, for /api/aircraft/stats — the only way to see it on
    /// a deployed box without reading the log file.</summary>
    public string RepairState { get; private set; } = "pending";
    public RepairResult LastRepair { get; private set; }

    /// <summary>
    /// Runs <see cref="RepairRegistrations"/> once per log, after the backfill, recording that it ran so a
    /// restart doesn't re-scan the whole archive. Costs one pass over the history files, throttled the same way.
    /// </summary>
    private void RepairRegistrationsOnce(Action? onRepaired = null)
    {
        var marker = Path.Combine(_dir, "registration-repair.txt");
        try
        {
            if (File.Exists(marker) && int.TryParse(File.ReadAllText(marker).Trim(), out var v) && v >= RepairVersion)
            {
                RepairState = $"already run (v{v})";
                return;
            }
            RepairState = "running";
            var r = RepairRegistrations();
            LastRepair = r;
            File.WriteAllText(marker, RepairVersion + "\n");
            RepairState = $"done: {r.RowsFilled:N0} row(s) filled under {r.SharedKeys:N0} shared code(s) "
                          + $"from {r.HistoryLines:N0} history line(s), {r.ShardsRewritten:N0} shard(s) rewritten";
            Console.WriteLine("[AIRCRAFT] Registration repair " + RepairState);
            if (r.RowsFilled > 0) onRepaired?.Invoke();
        }
        catch (Exception ex)
        {
            RepairState = "error: " + ex.Message;
            Console.WriteLine($"[AIRCRAFT] Registration repair failed: {ex}");
        }
    }

    /// <summary>
    /// Fills in the registration on rows written before the log recorded one, but only under Mode S codes the
    /// feed files for more than one airframe — those are the rows that can't otherwise be attributed to either
    /// aircraft, and the ones that make a tail look like two aeroplanes at once. Other reg-less rows are left
    /// alone: their key is unambiguous, so nothing is gained by touching them.
    ///
    /// Safe to re-run (a row that already has a registration is never modified) and safe to run while the log
    /// is being appended to: each shard is read, rewritten and replaced while holding that shard's lock, which
    /// is the same lock the writer takes, so a queued append lands either before the read or after the replace.
    /// </summary>
    public RepairResult RepairRegistrations(Action<string>? log = null)
    {
        log ??= s => Console.WriteLine("[AIRCRAFT] " + s);
        if (!Directory.Exists(_historyDir) || !Directory.Exists(_dir)) return default;
        var days = Directory.GetFiles(_historyDir, "*.jsonl")
            .Select(Path.GetFileName).Where(n => n != null && DayFile.IsMatch(n)).Select(n => n!)
            .OrderByDescending(n => n, StringComparer.Ordinal).ToList();
        if (days.Count == 0) return default;

        // Pass 1 — which Mode S codes does the feed file against more than one registration?
        var firstReg = new Dictionary<string, string>(StringComparer.Ordinal);
        var shared = new HashSet<string>(StringComparer.Ordinal);
        long lines = 0;
        var burst = Stopwatch.StartNew();
        foreach (var name in days)
            ReadDay(name, line =>
            {
                lines++;
                var hex = NormHex(Field(line, "modeSCode", 0, line.Length));
                if (hex == null) return;
                var reg = NormReg(Field(line, "registration", 0, line.Length));
                if (reg == null) return;
                if (!firstReg.TryGetValue(hex, out var seen)) firstReg[hex] = reg;
                else if (seen != reg) shared.Add(hex);
            }, burst);
        if (shared.Count == 0)
        {
            log($"Registration repair: no shared Mode S codes in {days.Count} history day(s) ({lines:N0} lines)");
            return new RepairResult(0, 0, 0, lines);
        }

        // Pass 2 — collect the flights of those codes, with the registration that flew each one.
        var byKey = new Dictionary<string, List<(Entry E, string Reg)>>(StringComparer.Ordinal);
        foreach (var name in days)
            ReadDay(name, line =>
            {
                // Cheap field extraction first: only a handful of codes are shared, so this skips the full
                // parse for virtually every line.
                var hex = NormHex(Field(line, "modeSCode", 0, line.Length));
                if (hex == null || !shared.Contains(hex)) return;
                var h = ParseHistoryLine(line);
                if (h == null || !h.Value.Flew) return;
                var row = h.Value.Row;
                if (string.IsNullOrEmpty(row.Reg) || !shared.Contains(row.Key)) return;
                var e = MakeEntry(h.Value.Dep, h.Value.First, h.Value.Last, row.Cs, row.O, row.D, row.Op, row.Reg);
                if (e.T <= 0) return;
                if (!byKey.TryGetValue(row.Key, out var list)) byKey[row.Key] = list = new List<(Entry, string)>();
                list.Add((e, e.Reg));
            }, burst);

        // Pass 3 — rewrite only the shards holding those codes, filling the blank registration where a history
        // flight matches the row. Matching is the same rule the log uses for duplicates.
        int filled = 0, shards = 0;
        foreach (var shard in byKey.Keys.Select(ShardOf).Distinct())
        {
            var path = ShardPath(shard);
            lock (_shardLocks[shard])
            {
                string? text;
                try { text = File.Exists(path) ? File.ReadAllText(path) : null; }
                catch (IOException) { continue; }
                if (string.IsNullOrEmpty(text)) continue;
                var sb = new StringBuilder(text.Length + 4096);
                int before = filled;
                foreach (var line in text.Split('\n'))
                {
                    if (line.Length == 0) continue;
                    if (TryParseLine(line, out var key, out var e) && e.Reg.Length == 0
                        && byKey.TryGetValue(key, out var candidates))
                    {
                        var hit = candidates.FirstOrDefault(c => SameFlight(c.E, e));
                        if (hit.Reg is { Length: > 0 })
                        {
                            AppendLine(sb, key, e with { Reg = hit.Reg });
                            filled++;
                            continue;
                        }
                    }
                    sb.Append(line).Append('\n');
                }
                if (filled == before) continue;
                try
                {
                    var tmp = path + ".repair";
                    File.WriteAllText(tmp, sb.ToString());
                    File.Move(tmp, path, overwrite: true);   // same volume → atomic replace
                    shards++;
                }
                catch (Exception ex) { log($"Registration repair: shard {shard:x3} failed: {ex.Message}"); }
            }
            if (burst.ElapsedMilliseconds >= 100) { Thread.Sleep(100); burst.Restart(); }
        }
        log($"Registration repair: {shared.Count:N0} shared Mode S code(s); filled {filled:N0} row(s) across {shards:N0} shard(s)");
        return new RepairResult(shared.Count, filled, shards, lines);
    }

    /// <summary>Streams one history day through <paramref name="onLine"/>, throttled like the backfill.</summary>
    private void ReadDay(string name, Action<string> onLine, Stopwatch burst)
    {
        try
        {
            using var fs = new FileStream(Path.Combine(_historyDir, name), FileMode.Open, FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete, 1 << 16);
            using var sr = new StreamReader(fs);
            string? line;
            while ((line = sr.ReadLine()) != null)
            {
                if (burst.ElapsedMilliseconds >= 100) { Thread.Sleep(100); burst.Restart(); }
                onLine(line);
            }
        }
        catch (IOException) { }
    }

    private void Backfill(Action<HistoryRow>? onRow, Action? onComplete)
    {
        var doneFile = Path.Combine(_dir, "backfill-done.txt");
        try
        {
            if (!Directory.Exists(_historyDir)) return;
            var done = File.Exists(doneFile)
                ? new HashSet<string>(File.ReadAllLines(doneFile).Select(l => l.Trim()).Where(l => l.Length > 0))
                : new HashSet<string>();
            var days = Directory.GetFiles(_historyDir, "*.jsonl")
                .Select(Path.GetFileName).Where(n => n != null && DayFile.IsMatch(n)).Select(n => n!)
                .OrderByDescending(n => n, StringComparer.Ordinal).ToList();
            var todo = days.Where(n => !done.Contains(n)).ToList();
            _backfillTotal = days.Count;
            _backfillDone = days.Count - todo.Count;
            if (todo.Count == 0) return;

            _backfillRunning = true;
            Console.WriteLine($"[AIRCRAFT] Flight-log backfill: {todo.Count} of {days.Count} history day(s) to scan");
            var batch = new Dictionary<int, StringBuilder>();
            // Duty-cycle throttle: work 100 ms, rest 100 ms → at most ~half of one core. Thread priority is
            // effectively ignored on Linux, and this Pi's CPU is shared with the live SWIM pipeline, so the
            // one-time import takes longer rather than competing with it.
            var burst = Stopwatch.StartNew();
            foreach (var name in todo)
            {
                var sw = Stopwatch.StartNew();
                long lines = 0, logged = 0;
                try
                {
                    using var fs = new FileStream(Path.Combine(_historyDir, name), FileMode.Open, FileAccess.Read,
                        FileShare.ReadWrite | FileShare.Delete, 1 << 16);
                    using var sr = new StreamReader(fs);
                    string? line;
                    while ((line = sr.ReadLine()) != null)
                    {
                        lines++;
                        if (burst.ElapsedMilliseconds >= 100) { WriteBatch(batch); Thread.Sleep(100); burst.Restart(); }
                        var h = ParseHistoryLine(line);
                        if (h == null) continue;
                        onRow?.Invoke(h.Value.Row);          // the airframe is real even if this plan never flew
                        if (!h.Value.Flew) continue;          // …but only flights that flew go in the log
                        var row = h.Value.Row;
                        var e = MakeEntry(h.Value.Dep, h.Value.First, h.Value.Last, row.Cs, row.O, row.D, row.Op, row.Reg);
                        var key = row.Key;
                        if (e.T <= 0 || key.Contains(',') || SeenRecently(key, e)) continue;
                        int s = ShardOf(key);
                        if (!batch.TryGetValue(s, out var sb)) batch[s] = sb = new StringBuilder();
                        AppendLine(sb, key, e);
                        RaiseAppended(key, e);
                        logged++;
                    }
                }
                catch (IOException ex)
                {
                    Console.WriteLine($"[AIRCRAFT] Flight-log backfill skipped {name} (will retry next start): {ex.Message}");
                    continue;
                }
                WriteBatch(batch);
                File.AppendAllText(doneFile, name + "\n");
                _backfillDone++;
                if (_recent.Count > 300_000) _recent.Clear();   // bound memory; read-time merge covers the rest
                Console.WriteLine($"[AIRCRAFT] Flight-log backfill {name}: {logged:N0} flights from {lines:N0} records " +
                                  $"in {sw.Elapsed.TotalSeconds:F0}s ({_backfillDone}/{_backfillTotal})");
            }
            onComplete?.Invoke();
        }
        catch (Exception ex) { Console.WriteLine($"[AIRCRAFT] Flight-log backfill error: {ex.Message}"); }
        finally { _backfillRunning = false; }
    }

    private readonly record struct Parsed(HistoryRow Row, long Dep, long First, long Last, bool Flew);

    /// <summary>
    /// Pull the needed fields out of one flight-history JSON line without parsing all of it. The airframe/flight
    /// fields come from the part before "events" (so text inside event summaries can never be mistaken for them);
    /// the first event's time is the moment the feed first saw the flight.
    /// </summary>
    private static Parsed? ParseHistoryLine(string line)
    {
        if (line.Length < 32 || line[0] != '{') return null;
        int ev = line.IndexOf("\"events\":", StringComparison.Ordinal);
        int end = ev < 0 ? line.Length : ev;
        var hex = NormHex(Field(line, "modeSCode", 0, end));
        var type = Field(line, "aircraftType", 0, end);
        var reg = CleanReg(Field(line, "registration", 0, end), type);
        if (hex == null && reg == null) return null;
        long dep = ParseEpoch(Field(line, "actualDepartureTime", 0, end));
        long last = ParseEpoch(Field(line, "lastSeen", 0, end));
        long first = ev < 0 ? 0 : ParseEpoch(Field(line, "time", ev, line.Length));
        long seen = last > 0 ? last : first > 0 ? first : dep;
        if (seen <= 0) return null;
        var row = new HistoryRow(KeyFor(hex, reg), hex, reg,
            Field(line, "selcal", 0, end), type, Field(line, "operator", 0, end),
            Field(line, "wakeCategory", 0, end), Field(line, "equipmentQualifier", 0, end),
            Field(line, "callsign", 0, end), Field(line, "origin", 0, end), Field(line, "destination", 0, end),
            DateTimeOffset.FromUnixTimeSeconds(seen).UtcDateTime);
        // Flew = an actual departure, or any position report. History is written with nulls omitted, so a
        // "latitude" key means a position existed ("targetLatitude" can't match: case + the leading quote).
        bool flew = dep > 0 || line.IndexOf("\"latitude\":", 0, end, StringComparison.Ordinal) >= 0;
        return new Parsed(row, dep, first, last, flew);
    }

    /// <summary>Value of the first <c>"key":"…"</c> string property within [start, end).</summary>
    private static string? Field(string s, string key, int start, int end)
    {
        var pat = "\"" + key + "\":\"";
        if (end - start < pat.Length) return null;
        int i = s.IndexOf(pat, start, end - start, StringComparison.Ordinal);
        if (i < 0) return null;
        i += pat.Length;
        int j = i;
        while (j < s.Length && s[j] != '"') j += s[j] == '\\' ? 2 : 1;
        return s.Substring(i, Math.Min(j, s.Length) - i);
    }
}
