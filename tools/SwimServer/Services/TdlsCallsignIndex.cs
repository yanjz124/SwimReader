using System.Collections.Concurrent;

namespace SwimServer;

/// <summary>
/// Callsign → which days it appears in, so "find this callsign anywhere in TDLS history" doesn't
/// have to read the history.
///
/// The archive is ~6.5 MB per day and 128 days (1.5 GB, ~2.4M lines) and grows daily. A blind
/// all-days scan is ~30 s of SD-card reads on the Pi — fine as a one-off, useless interactively.
/// With this index a callsign search touches only the handful of files that callsign actually
/// appears in, which is normally one or two days.
///
/// Deliberately coarse: it maps to DAYS, not byte offsets. A day list costs a couple of bytes per
/// entry instead of eight, survives files being rewritten or trimmed by the budget service, and the
/// per-file scan that follows is already cheap because Search pre-filters raw lines before parsing.
///
/// Built in the background on first use (never blocking a request), persisted next to the history so
/// a restart doesn't re-read 1.5 GB, and kept live by <see cref="Note"/> on every append. On load,
/// only files that are new or have changed size are re-scanned.
/// </summary>
static class TdlsCallsignIndex
{
    private const string FileName = ".callsign-index";
    private const string Magic = "TDLSIDX1";

    public enum BuildState { NotStarted, Building, Ready, Failed }

    private static readonly object _gate = new();
    private static readonly ConcurrentDictionary<string, HashSet<string>> _days = new(StringComparer.OrdinalIgnoreCase);
    private static readonly Dictionary<string, long> _scanned = new(StringComparer.Ordinal);   // date → file size when scanned
    private static volatile BuildState _state = BuildState.NotStarted;
    private static Task? _build;

    public static BuildState State => _state;
    public static int CallsignCount => _days.Count;
    public static int DayCount { get { lock (_gate) return _scanned.Count; } }

    /// <summary>Record a callsign seen on a date. Called on every append so the index never goes stale.</summary>
    public static void Note(string? callsign, string date)
    {
        if (string.IsNullOrEmpty(callsign) || _state == BuildState.NotStarted) return;
        var set = _days.GetOrAdd(callsign, _ => new HashSet<string>(StringComparer.Ordinal));
        lock (set) set.Add(date);
    }

    /// <summary>
    /// Dates (newest first) where this callsign appears, or null when the index can't answer yet —
    /// the caller then falls back to scanning.
    /// </summary>
    public static IReadOnlyList<string>? DatesFor(string callsign)
    {
        if (_state != BuildState.Ready) return null;
        if (!_days.TryGetValue(callsign, out var set)) return Array.Empty<string>();
        lock (set) return set.OrderByDescending(d => d, StringComparer.Ordinal).ToArray();
    }

    /// <summary>Starts the background build if it hasn't run. Returns immediately.</summary>
    public static void EnsureBuilt(string historyDir)
    {
        if (_state is BuildState.Ready or BuildState.Building) return;
        lock (_gate)
        {
            if (_state is BuildState.Ready or BuildState.Building) return;
            _state = BuildState.Building;
            _build = Task.Run(() => Build(historyDir));
        }
    }

    private static void Build(string historyDir)
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        try
        {
            if (!Directory.Exists(historyDir)) { _state = BuildState.Ready; return; }
            Load(historyDir);

            var files = Directory.GetFiles(historyDir, "*.jsonl").OrderByDescending(f => f).ToArray();
            var present = new HashSet<string>(StringComparer.Ordinal);
            long scannedBytes = 0;
            int rescanned = 0;

            foreach (var path in files)
            {
                var date = Path.GetFileNameWithoutExtension(path);
                present.Add(date);
                var len = new FileInfo(path).Length;
                bool known;
                lock (_gate) known = _scanned.TryGetValue(date, out var prev) && prev == len;
                if (known) continue;                       // unchanged since the saved index
                ScanFile(path, date);
                scannedBytes += len;
                rescanned++;
                lock (_gate) _scanned[date] = len;
            }

            // Days the budget service has trimmed away: drop them so stale dates aren't searched.
            lock (_gate)
                foreach (var gone in _scanned.Keys.Where(d => !present.Contains(d)).ToArray())
                    _scanned.Remove(gone);

            _state = BuildState.Ready;
            Save(historyDir);
            Console.WriteLine($"[TDLS-IDX] ready: {_days.Count:N0} callsigns over {DayCount} days " +
                              $"({rescanned} file(s), {scannedBytes / 1024 / 1024} MB scanned, {sw.ElapsedMilliseconds} ms)");
        }
        catch (Exception ex)
        {
            _state = BuildState.Failed;
            Console.Error.WriteLine($"[TDLS-IDX] build failed: {ex.Message}");
        }
    }

    /// <summary>
    /// Pull aircraftId out of each line by raw substring — no JSON parse. The whole point is to read
    /// the archive once as fast as the disk allows.
    /// </summary>
    private static void ScanFile(string path, string date)
    {
        const string key = "\"aircraftId\":\"";
        foreach (var line in File.ReadLines(path))
        {
            var i = line.IndexOf(key, StringComparison.Ordinal);
            if (i < 0) continue;
            i += key.Length;
            var j = line.IndexOf('"', i);
            if (j <= i) continue;
            var cs = line[i..j];
            if (cs.Length == 0) continue;
            var set = _days.GetOrAdd(cs, _ => new HashSet<string>(StringComparer.Ordinal));
            lock (set) set.Add(date);
        }
    }

    // ── persistence ──────────────────────────────────────────────────────────
    // Plain text, written only after a build. Re-reading this beats re-reading 1.5 GB of history.

    private static void Load(string historyDir)
    {
        var path = Path.Combine(historyDir, FileName);
        if (!File.Exists(path)) return;
        try
        {
            using var sr = new StreamReader(path);
            if (sr.ReadLine() != Magic) return;
            string? line;
            var section = 0;
            while ((line = sr.ReadLine()) != null)
            {
                if (line == "#days") { section = 1; continue; }
                if (line == "#callsigns") { section = 2; continue; }
                var tab = line.IndexOf('\t');
                if (tab < 0) continue;
                if (section == 1)
                {
                    if (long.TryParse(line[(tab + 1)..], out var len))
                        lock (_gate) _scanned[line[..tab]] = len;
                }
                else if (section == 2)
                {
                    var cs = line[..tab];
                    var set = _days.GetOrAdd(cs, _ => new HashSet<string>(StringComparer.Ordinal));
                    lock (set)
                        foreach (var d in line[(tab + 1)..].Split(',', StringSplitOptions.RemoveEmptyEntries))
                            set.Add(d);
                }
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[TDLS-IDX] load failed, rebuilding: {ex.Message}");
            _days.Clear();
            lock (_gate) _scanned.Clear();
        }
    }

    private static void Save(string historyDir)
    {
        var path = Path.Combine(historyDir, FileName);
        var tmp = path + ".tmp";
        try
        {
            using (var sw = new StreamWriter(tmp, false))
            {
                sw.WriteLine(Magic);
                sw.WriteLine("#days");
                lock (_gate)
                    foreach (var (d, len) in _scanned.OrderBy(k => k.Key, StringComparer.Ordinal))
                        sw.WriteLine($"{d}\t{len}");
                sw.WriteLine("#callsigns");
                foreach (var (cs, set) in _days.OrderBy(k => k.Key, StringComparer.Ordinal))
                {
                    string joined;
                    lock (set) joined = string.Join(',', set.OrderBy(x => x, StringComparer.Ordinal));
                    sw.WriteLine($"{cs}\t{joined}");
                }
            }
            File.Move(tmp, path, overwrite: true);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[TDLS-IDX] save failed: {ex.Message}");
            try { File.Delete(tmp); } catch { }
        }
    }
}
