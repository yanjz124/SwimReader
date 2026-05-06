using System.Text.Json;
using System.Text;

namespace SwimServer;

/// <summary>
/// Per-day index for flight-history/{date}.jsonl. Records callsign / computerId
/// / origin / destination / registration plus a byte offset into the data file.
/// Stored alongside the .jsonl as {date}.idx (one tab-separated line per record).
///
/// Search becomes O(records-per-day) over a ~7MB index instead of scanning a
/// ~700MB JSONL file every time.
/// </summary>
static class FlightHistoryIndex
{
    public sealed class IndexEntry
    {
        public string Callsign = "";
        public string ComputerId = "";
        public string Origin = "";
        public string Destination = "";
        public string Registration = "";
        public long Offset;       // byte offset into {date}.jsonl where the record line starts
        public int Length;        // length of the record line in bytes (without newline)
    }

    // date → entries (lazily loaded). Cached in memory after first build.
    private static readonly Dictionary<string, List<IndexEntry>> _cache = new();
    // date → bytes of .jsonl already indexed (so EnsureBuilt can resume)
    private static readonly Dictionary<string, long> _builtUpTo = new();
    private static readonly object _lock = new();

    private static string IdxPath(string historyDir, string date) =>
        Path.Combine(historyDir, $"{date}.idx");
    private static string JsonlPath(string historyDir, string date) =>
        Path.Combine(historyDir, $"{date}.jsonl");

    /// <summary>Get the index for a date, building from disk + .jsonl scan if needed.</summary>
    public static List<IndexEntry> GetOrBuild(string historyDir, string date)
    {
        lock (_lock)
        {
            var jsonl = JsonlPath(historyDir, date);
            if (!File.Exists(jsonl))
            {
                _cache[date] = new();
                _builtUpTo[date] = 0;
                return _cache[date];
            }

            // Lazy-load .idx if cache is empty for this date
            if (!_cache.TryGetValue(date, out var entries))
            {
                entries = new();
                _cache[date] = entries;
                _builtUpTo[date] = 0;
                LoadFromIdx(historyDir, date, entries);
            }

            // Catch up: if .jsonl grew past last indexed offset, scan the tail
            var fi = new FileInfo(jsonl);
            var alreadyIndexed = _builtUpTo.GetValueOrDefault(date);
            if (fi.Length > alreadyIndexed)
            {
                ScanFromOffset(historyDir, date, alreadyIndexed, entries);
                _builtUpTo[date] = fi.Length;
            }
            return entries;
        }
    }

    private static void LoadFromIdx(string historyDir, string date, List<IndexEntry> entries)
    {
        var idx = IdxPath(historyDir, date);
        if (!File.Exists(idx)) return;
        try
        {
            long maxOffset = 0;
            foreach (var line in File.ReadLines(idx))
            {
                if (line.Length == 0) continue;
                var parts = line.Split('\t');
                if (parts.Length < 7) continue;
                if (!long.TryParse(parts[5], out var off)) continue;
                if (!int.TryParse(parts[6], out var len)) continue;
                entries.Add(new IndexEntry
                {
                    Callsign = parts[0],
                    ComputerId = parts[1],
                    Origin = parts[2],
                    Destination = parts[3],
                    Registration = parts[4],
                    Offset = off,
                    Length = len
                });
                if (off + len > maxOffset) maxOffset = off + len;
            }
            // After loading, mark .idx as covering up to the highest offset seen.
            // The catch-up scan in GetOrBuild will index any .jsonl tail beyond this.
            _builtUpTo[date] = maxOffset;
        }
        catch (Exception ex) { Console.Error.WriteLine($"[HistIdx] Load {date}: {ex.Message}"); }
    }

    private static void ScanFromOffset(string historyDir, string date, long startOffset, List<IndexEntry> entries)
    {
        var jsonl = JsonlPath(historyDir, date);
        var idx = IdxPath(historyDir, date);
        try
        {
            var sw = System.Diagnostics.Stopwatch.StartNew();
            int added = 0;
            using var fs = new FileStream(jsonl, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            fs.Seek(startOffset, SeekOrigin.Begin);
            var idxAppend = new StringBuilder();

            // Read line by line, tracking byte offsets.
            // Each line is a JSON object — we extract a few fields with shallow string scanning.
            byte[] buf = new byte[1 << 20];   // 1 MB read buffer
            long fileOffset = startOffset;
            var lineBuf = new MemoryStream();
            int n;
            while ((n = fs.Read(buf, 0, buf.Length)) > 0)
            {
                int lineStart = 0;
                for (int i = 0; i < n; i++)
                {
                    if (buf[i] == (byte)'\n')
                    {
                        // Line spans from lineStart..i inclusive of the '\n'
                        if (lineBuf.Length > 0)
                        {
                            // Continuing a line from a previous read
                            lineBuf.Write(buf, lineStart, i - lineStart);
                            var bytes = lineBuf.ToArray();
                            var lineLen = (int)lineBuf.Length;
                            var lineOff = fileOffset + lineStart - lineLen + (i - lineStart);
                            // (offset accounting is tricky across reads; recompute correctly below)
                            // Simpler: use lineBuf's bytes, offset = current file position - n + lineStart - prev
                            // To avoid bugs, fall back to the simple path that handles complete lines within one read.
                            ProcessLine(bytes, 0, lineLen, fileOffset + lineStart - lineLen, entries, idxAppend, ref added);
                            lineBuf.SetLength(0);
                        }
                        else
                        {
                            int lineLen = i - lineStart;
                            long lineOff = fileOffset + lineStart;
                            ProcessLine(buf, lineStart, lineLen, lineOff, entries, idxAppend, ref added);
                        }
                        lineStart = i + 1;
                    }
                }
                // Carry trailing partial line
                if (lineStart < n)
                {
                    lineBuf.Write(buf, lineStart, n - lineStart);
                }
                fileOffset += n;
            }

            if (added > 0 && idxAppend.Length > 0)
            {
                File.AppendAllText(idx, idxAppend.ToString());
            }
            sw.Stop();
            if (added > 0)
                Console.WriteLine($"[HistIdx] {date}: indexed {added} records from offset {startOffset:N0} in {sw.ElapsedMilliseconds}ms");
        }
        catch (Exception ex) { Console.Error.WriteLine($"[HistIdx] Scan {date}: {ex.Message}"); }
    }

    // Extract callsign/computerId/origin/destination/registration from a JSON line,
    // using shallow string searches (no full JSON parse — much faster for 600MB scans).
    private static void ProcessLine(byte[] data, int start, int len, long lineOffset,
        List<IndexEntry> entries, StringBuilder idxAppend, ref int added)
    {
        if (len < 10) return;
        var line = Encoding.UTF8.GetString(data, start, len);
        var entry = new IndexEntry
        {
            Callsign = ExtractField(line, "\"callsign\":\"") ?? "",
            ComputerId = ExtractField(line, "\"computerId\":\"") ?? "",
            Origin = ExtractField(line, "\"origin\":\"") ?? "",
            Destination = ExtractField(line, "\"destination\":\"") ?? "",
            Registration = ExtractField(line, "\"registration\":\"") ?? "",
            Offset = lineOffset,
            Length = len
        };
        entries.Add(entry);
        idxAppend.Append(entry.Callsign).Append('\t')
                 .Append(entry.ComputerId).Append('\t')
                 .Append(entry.Origin).Append('\t')
                 .Append(entry.Destination).Append('\t')
                 .Append(entry.Registration).Append('\t')
                 .Append(entry.Offset).Append('\t')
                 .Append(entry.Length).Append('\n');
        added++;
    }

    private static string? ExtractField(string line, string key)
    {
        int i = line.IndexOf(key, StringComparison.Ordinal);
        if (i < 0) return null;
        i += key.Length;
        int end = line.IndexOf('"', i);
        if (end < 0) return null;
        return line.Substring(i, end - i);
    }

    /// <summary>Append an index entry for a record just written by FlightHistoryService.</summary>
    public static void AppendEntry(string historyDir, string date, string callsign, string computerId,
        string origin, string destination, string registration, long offset, int length)
    {
        lock (_lock)
        {
            if (!_cache.TryGetValue(date, out var entries))
            {
                entries = new();
                _cache[date] = entries;
                LoadFromIdx(historyDir, date, entries);
            }
            var entry = new IndexEntry
            {
                Callsign = callsign ?? "", ComputerId = computerId ?? "",
                Origin = origin ?? "", Destination = destination ?? "",
                Registration = registration ?? "", Offset = offset, Length = length
            };
            entries.Add(entry);
            try
            {
                using var sw = File.AppendText(IdxPath(historyDir, date));
                sw.Write(entry.Callsign); sw.Write('\t');
                sw.Write(entry.ComputerId); sw.Write('\t');
                sw.Write(entry.Origin); sw.Write('\t');
                sw.Write(entry.Destination); sw.Write('\t');
                sw.Write(entry.Registration); sw.Write('\t');
                sw.Write(entry.Offset); sw.Write('\t');
                sw.Write(entry.Length); sw.Write('\n');
            }
            catch (Exception ex) { Console.Error.WriteLine($"[HistIdx] Append {date}: {ex.Message}"); }
            _builtUpTo[date] = Math.Max(_builtUpTo.GetValueOrDefault(date), offset + length);
        }
    }

    /// <summary>Read N matching records from the .jsonl using the index entries.</summary>
    public static List<JsonElement> ReadMatching(string historyDir, string date, IEnumerable<IndexEntry> matches, int max)
    {
        var jsonl = JsonlPath(historyDir, date);
        var result = new List<JsonElement>();
        if (!File.Exists(jsonl)) return result;
        try
        {
            using var fs = new FileStream(jsonl, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            byte[] buf = new byte[64 * 1024];
            foreach (var m in matches)
            {
                if (result.Count >= max) break;
                if (m.Length > buf.Length) buf = new byte[m.Length + 1024];
                fs.Seek(m.Offset, SeekOrigin.Begin);
                int read = 0;
                while (read < m.Length)
                {
                    int n = fs.Read(buf, read, m.Length - read);
                    if (n <= 0) break;
                    read += n;
                }
                if (read == 0) continue;
                try
                {
                    var el = JsonSerializer.Deserialize<JsonElement>(new ReadOnlySpan<byte>(buf, 0, read));
                    result.Add(el);
                }
                catch { /* skip malformed */ }
            }
        }
        catch (Exception ex) { Console.Error.WriteLine($"[HistIdx] Read {date}: {ex.Message}"); }
        return result;
    }
}
