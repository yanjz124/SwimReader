using System.Collections.Concurrent;
using System.Text;

namespace SwimServer;

/// <summary>
/// Callsign → the exact byte offsets of its lines in the TDLS history, so "find this callsign
/// anywhere" reads only those lines instead of the archive.
///
/// The archive is ~6.5 MB/day over 128 days (1.5 GB, ~2.4M lines) and grows daily.
///
/// A first version indexed callsign → DAYS, on the assumption a callsign occupies a day or two.
/// That is true of GA tails and false of the thing people actually search: a scheduled flight
/// number flies daily, so UAL1862 hit 110 of 128 days and the "narrowed" search still read 715 MB
/// and took 4-5 s on the Pi. Offsets remove the file size from the equation entirely — a lookup
/// reads one line per occurrence, so cost tracks the number of matches, not the size of history.
///
/// Each occurrence packs into one long: day index in the high bits, byte offset in the low 40
/// (a day file would have to exceed 1 TB to overflow). ~2.4M occurrences ≈ 19 MB of longs.
///
/// Built in the background on first use (never blocking a request), persisted next to the history,
/// and kept live by <see cref="Note"/> on every append. On load only files whose size changed are
/// re-scanned, so a restart costs a read of the index rather than a read of 1.5 GB.
///
/// Scope: this indexes aircraftId only. A query it can answer returns that callsign's messages; a
/// query it cannot (free text, gate, clearance wording) falls back to a scan in TdlsHistoryService.
/// </summary>
static class TdlsCallsignIndex
{
    private const string FileName = ".callsign-index";
    private static readonly byte[] Magic = "TDLSIDX3"u8.ToArray();
    // One occurrence per long: airport(16) | day(16) | offset(32). 4 GB files, 65k days, 65k
    // airports — all far beyond anything this will see.
    private const long OffsetMask = 0xFFFFFFFFL;
    private static long Pack(int airportId, int dayIdx, long offset) =>
        ((long)(ushort)airportId << 48) | ((long)(ushort)dayIdx << 32) | (offset & OffsetMask);
    private static int UnpackAirport(long p) => (int)((p >> 48) & 0xFFFF);
    private static int UnpackDay(long p) => (int)((p >> 32) & 0xFFFF);

    public enum BuildState { NotStarted, Building, Ready, Failed }

    private static readonly object _gate = new();
    private static readonly ConcurrentDictionary<string, List<long>> _hits = new(StringComparer.OrdinalIgnoreCase);
    private static readonly List<string> _dates = new();                 // day index → date
    private static readonly Dictionary<string, int> _dateIdx = new(StringComparer.Ordinal);
    private static readonly Dictionary<string, long> _scanned = new(StringComparer.Ordinal);  // date → size when scanned
    private static readonly List<string> _airports = new();                 // airport index → ICAO
    private static readonly Dictionary<string, int> _airportIdx = new(StringComparer.OrdinalIgnoreCase);
    private static volatile BuildState _state = BuildState.NotStarted;

    public static BuildState State => _state;
    public static int CallsignCount => _hits.Count;
    public static int DayCount { get { lock (_gate) return _scanned.Count; } }

    private static int AirportIndex(string airport)
    {
        lock (_gate)
        {
            if (_airportIdx.TryGetValue(airport, out var i)) return i;
            i = _airports.Count;
            _airports.Add(airport);
            _airportIdx[airport] = i;
            return i;
        }
    }

    private static int DayIndex(string date)
    {
        lock (_gate)
        {
            if (_dateIdx.TryGetValue(date, out var i)) return i;
            i = _dates.Count;
            _dates.Add(date);
            _dateIdx[date] = i;
            return i;
        }
    }

    /// <summary>Record one occurrence. Called on append with the offset the line was written at.</summary>
    public static void Note(string? callsign, string date, string? airport, long offset)
    {
        if (string.IsNullOrEmpty(callsign) || _state == BuildState.NotStarted) return;
        if (LaddService.IsBlocked(callsign, null)) return;      // see the note in Emit

        Add(callsign, DayIndex(date), AirportIndex(airport ?? ""), offset);
    }

    private static void Add(string callsign, int dayIdx, int airportIdx, long offset)
    {
        var list = _hits.GetOrAdd(callsign, _ => new List<long>(4));
        lock (list) list.Add(Pack(airportIdx, dayIdx, offset));
    }

    /// <summary>True when the index holds this callsign — lets a caller tell "no hits here" from
    /// "I can't answer", so a known callsign filtered to the wrong airport doesn't trigger a scan.</summary>
    public static bool Knows(string callsign) => _state == BuildState.Ready && _hits.ContainsKey(callsign);

    /// <summary>One located message: day file, airport, and the byte offset of its line.</summary>
    public readonly record struct Hit(string Date, string Airport, long Offset);

    /// <summary>Where a callsign appears, grouped — answered entirely from memory, no file reads.</summary>
    public readonly record struct Occurrence(string Date, string Airport, int Count);

    /// <summary>
    /// The grouped "where has this callsign been" answer, straight out of the index.
    ///
    /// This exists because reading the messages is the expensive part: a daily flight number spans
    /// ~110 day files, and opening 110 cold files on the Pi's contended SD card measured 54 s (vs
    /// milliseconds once cached). The directory's search only ever renders day + airport + count,
    /// so it never needed the messages at all.
    /// </summary>
    public static IReadOnlyList<Occurrence>? Occurrences(string callsign)
    {
        if (_state != BuildState.Ready) return null;
        if (!_hits.TryGetValue(callsign, out var list)) return Array.Empty<Occurrence>();
        long[] packed;
        lock (list) packed = list.ToArray();
        var counts = new Dictionary<(int d, int a), int>();
        foreach (var p in packed)
        {
            var k = (UnpackDay(p), UnpackAirport(p));
            counts[k] = counts.TryGetValue(k, out var n) ? n + 1 : 1;
        }
        var outp = new List<Occurrence>(counts.Count);
        lock (_gate)
            foreach (var ((d, a), n) in counts)
                if (d < _dates.Count && a < _airports.Count)
                    outp.Add(new Occurrence(_dates[d], _airports[a], n));
        outp.Sort((x, y) => string.CompareOrdinal(y.Date, x.Date) is var c && c != 0
            ? c : string.CompareOrdinal(x.Airport, y.Airport));
        return outp;
    }

    /// <summary>
    /// Every recorded occurrence of a callsign, newest first, or null when the index can't answer
    /// yet (still building, or failed) — the caller then falls back to scanning.
    /// </summary>
    /// <param name="airport">When given, hits at other airports are dropped BEFORE any file is
    /// opened — which is the whole point: the airport page would otherwise open all 110 of a daily
    /// flight's day files only to discard most of what it read.</param>
    public static IReadOnlyList<Hit>? Find(string callsign, string? airport = null)
    {
        if (_state != BuildState.Ready) return null;
        if (!_hits.TryGetValue(callsign, out var list)) return Array.Empty<Hit>();
        long[] packed;
        lock (list) packed = list.ToArray();
        var outp = new List<Hit>(packed.Length);
        lock (_gate)
        {
            int wantAirport = -1;
            if (!string.IsNullOrEmpty(airport) && !_airportIdx.TryGetValue(airport, out wantAirport))
                return Array.Empty<Hit>();                   // airport never seen → no hits
            foreach (var p in packed)
            {
                var d = UnpackDay(p);
                var a = UnpackAirport(p);
                if (wantAirport >= 0 && a != wantAirport) continue;
                if (d < _dates.Count && a < _airports.Count)
                    outp.Add(new Hit(_dates[d], _airports[a], p & OffsetMask));
            }
        }
        // Newest day first, but ASCENDING by offset inside a day: the reader opens each file once and
        // walks it forwards, which lets the OS read ahead. Seeking backwards through a 6.5 MB file on
        // the Pi's SD card is markedly slower. The reader reverses each file's results afterwards so
        // the output is still newest-first.
        outp.Sort((a, b) => string.CompareOrdinal(b.Date, a.Date) is var c && c != 0 ? c : a.Offset.CompareTo(b.Offset));
        return outp;
    }

    public static void EnsureBuilt(string historyDir)
    {
        if (_state is BuildState.Ready or BuildState.Building) return;
        lock (_gate)
        {
            if (_state is BuildState.Ready or BuildState.Building) return;
            _state = BuildState.Building;
        }
        _ = Task.Run(() => Build(historyDir));
    }

    private static void Build(string historyDir)
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        try
        {
            if (!Directory.Exists(historyDir)) { _state = BuildState.Ready; return; }
            Load(historyDir);

            var present = new HashSet<string>(StringComparer.Ordinal);
            long bytes = 0;
            int rescanned = 0;
            foreach (var path in Directory.GetFiles(historyDir, "*.jsonl").OrderByDescending(f => f))
            {
                var date = Path.GetFileNameWithoutExtension(path);
                present.Add(date);
                var len = new FileInfo(path).Length;
                bool known;
                lock (_gate) known = _scanned.TryGetValue(date, out var prev) && prev == len;
                if (known) continue;
                DropDay(date);                       // partial/stale data for this day, if any
                ScanFile(path, DayIndex(date));
                bytes += len; rescanned++;
                lock (_gate) _scanned[date] = len;
            }
            lock (_gate)
                foreach (var gone in _scanned.Keys.Where(d => !present.Contains(d)).ToArray())
                    _scanned.Remove(gone);           // trimmed by the budget service

            _state = BuildState.Ready;
            Save(historyDir);
            Console.WriteLine($"[TDLS-IDX] ready: {_hits.Count:N0} callsigns, {DayCount} days " +
                              $"({rescanned} file(s), {bytes / 1024 / 1024} MB, {sw.ElapsedMilliseconds} ms)");
        }
        catch (Exception ex)
        {
            _state = BuildState.Failed;
            Console.Error.WriteLine($"[TDLS-IDX] build failed: {ex.Message}");
        }
    }

    private static void DropDay(string date)
    {
        int idx;
        lock (_gate) { if (!_dateIdx.TryGetValue(date, out idx)) return; }
        foreach (var list in _hits.Values)
            lock (list) list.RemoveAll(p => UnpackDay(p) == idx);
    }

    /// <summary>
    /// Byte-offset scan: read the file as raw bytes, split on '\n', and pull aircraftId out by
    /// substring. No StreamReader (its buffering hides the true offset) and no JSON parse — the
    /// point is to cross the archive once at disk speed.
    /// </summary>
    private static void ScanFile(string path, int dayIdx)
    {
        ReadOnlySpan<byte> key = "\"aircraftId\":\""u8;
        using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite, 1 << 16);
        var buf = new byte[1 << 20];
        var carry = new List<byte>(512);
        long lineStart = 0, pos = 0;
        int n;
        while ((n = fs.Read(buf, 0, buf.Length)) > 0)
        {
            var span = buf.AsSpan(0, n);
            int from = 0;
            while (true)
            {
                var nl = span[from..].IndexOf((byte)'\n');
                if (nl < 0)
                {
                    carry.AddRange(span[from..].ToArray());
                    pos += span.Length - from;
                    break;
                }
                var seg = span.Slice(from, nl);
                if (carry.Count > 0)
                {
                    carry.AddRange(seg.ToArray());
                    Emit(CollectionsMarshalSpan(carry), lineStart, dayIdx, key);
                    carry.Clear();
                }
                else Emit(seg, lineStart, dayIdx, key);
                pos += nl + 1;
                lineStart = pos;
                from += nl + 1;
            }
        }
        if (carry.Count > 0) Emit(CollectionsMarshalSpan(carry), lineStart, dayIdx, key);
    }

    private static ReadOnlySpan<byte> CollectionsMarshalSpan(List<byte> l) =>
        System.Runtime.InteropServices.CollectionsMarshal.AsSpan(l);

    private static void Emit(ReadOnlySpan<byte> line, long offset, int dayIdx, ReadOnlySpan<byte> key)
    {
        var i = line.IndexOf(key);
        if (i < 0) return;
        i += key.Length;
        var rest = line[i..];
        var j = rest.IndexOf((byte)'"');
        if (j <= 0) return;
        // Skip anything flagged LADD at write time. That flag outlives the live list (which is why
        // the reader masks on it), so indexing these would let the summary endpoint confirm a
        // blocked aircraft's movements even after the list stopped covering it.
        if (line.IndexOf("\"ladd\":true"u8) >= 0) return;
        var cs = Encoding.UTF8.GetString(rest[..j]);
        Add(cs, dayIdx, AirportIndex(ReadField(line, "\"airport\":\""u8) ?? ""), offset);
    }

    /// <summary>Pull one string field out of a raw JSON line by substring; null when absent.</summary>
    private static string? ReadField(ReadOnlySpan<byte> line, ReadOnlySpan<byte> key)
    {
        var i = line.IndexOf(key);
        if (i < 0) return null;
        i += key.Length;
        var rest = line[i..];
        var j = rest.IndexOf((byte)'"');
        return j <= 0 ? null : Encoding.UTF8.GetString(rest[..j]);
    }

    // ── persistence (binary: 2.4M offsets would be clumsy as text) ────────────

    private static void Load(string historyDir)
    {
        var path = Path.Combine(historyDir, FileName);
        if (!File.Exists(path)) return;
        try
        {
            using var fs = File.OpenRead(path);
            using var br = new BinaryReader(fs, Encoding.UTF8);
            var magic = br.ReadBytes(Magic.Length);
            if (!magic.AsSpan().SequenceEqual(Magic)) return;      // old/foreign format → rebuild
            var dayN = br.ReadInt32();
            for (int i = 0; i < dayN; i++)
            {
                var date = br.ReadString();
                var size = br.ReadInt64();
                DayIndex(date);
                lock (_gate) _scanned[date] = size;
            }
            var apN = br.ReadInt32();
            for (int i = 0; i < apN; i++) AirportIndex(br.ReadString());
            var csN = br.ReadInt32();
            for (int i = 0; i < csN; i++)
            {
                var cs = br.ReadString();
                var cnt = br.ReadInt32();
                var list = new List<long>(cnt);
                for (int k = 0; k < cnt; k++) list.Add(br.ReadInt64());
                _hits[cs] = list;
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[TDLS-IDX] load failed, rebuilding: {ex.Message}");
            _hits.Clear();
            lock (_gate) { _scanned.Clear(); _dates.Clear(); _dateIdx.Clear(); }
        }
    }

    private static void Save(string historyDir)
    {
        var path = Path.Combine(historyDir, FileName);
        var tmp = path + ".tmp";
        try
        {
            using (var fs = File.Create(tmp))
            using (var bw = new BinaryWriter(fs, Encoding.UTF8))
            {
                bw.Write(Magic);
                string[] dates;
                long[] sizes;
                lock (_gate)
                {
                    dates = _dates.ToArray();
                    sizes = dates.Select(d => _scanned.TryGetValue(d, out var s) ? s : -1).ToArray();
                }
                bw.Write(dates.Length);
                for (int i = 0; i < dates.Length; i++) { bw.Write(dates[i]); bw.Write(sizes[i]); }
                string[] aps;
                lock (_gate) aps = _airports.ToArray();
                bw.Write(aps.Length);
                foreach (var a in aps) bw.Write(a);
                bw.Write(_hits.Count);
                foreach (var (cs, list) in _hits)
                {
                    long[] packed;
                    lock (list) packed = list.ToArray();
                    bw.Write(cs);
                    bw.Write(packed.Length);
                    foreach (var p in packed) bw.Write(p);
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
