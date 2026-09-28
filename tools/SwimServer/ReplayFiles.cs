using System.Globalization;
using System.IO.Compression;

namespace SwimServer;

/// <summary>
/// Replay hour files come in two encodings:
///   {hour}.jsonl.gz   — what ReplayRecorder writes (gzip Fastest, flushed often so the live hour is readable)
///   {hour}.jsonl.zst  — the same data re-encoded by <see cref="ReplayCompactor"/> once the hour is finished
/// zstd's multi-MB window sees the repetition between track records that gzip's 32 KB window can't:
/// a STARS hour goes 25 MB → ~2.5 MB, and it decompresses faster than gzip too. Every reader goes
/// through here so it doesn't care which one a given hour is in.
/// </summary>
static class ReplayFiles
{
    public const string Gz = ".jsonl.gz";
    public const string Zst = ".jsonl.zst";
    /// <summary>Glob matching both encodings (the compactor's temp files end in .partial, so they don't match).</summary>
    public const string Pattern = "*.jsonl.*";

    public static bool IsReplayFile(string name) =>
        name.EndsWith(Gz, StringComparison.Ordinal) || name.EndsWith(Zst, StringComparison.Ordinal);

    /// <summary>"2026-09-28T14-2.jsonl.zst" → "2026-09-28T14-2".</summary>
    public static string Stem(string pathOrName)
    {
        var n = Path.GetFileName(pathOrName);
        if (n.EndsWith(Gz, StringComparison.Ordinal)) return n[..^Gz.Length];
        if (n.EndsWith(Zst, StringComparison.Ordinal)) return n[..^Zst.Length];
        return n;
    }

    /// <summary>The hour a file covers, from the first 13 chars of its stem ("yyyy-MM-ddTHH").</summary>
    public static DateTime? Hour(string pathOrName)
    {
        var s = Stem(pathOrName);
        if (s.Length < 13) return null;
        return DateTime.TryParseExact(s[..13], "yyyy-MM-dd'T'HH", CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var h) ? h : null;
    }

    /// <summary>Replay files in a directory, one per stem. While the compactor is mid-swap both encodings
    /// of an hour can exist for a moment; the .zst wins so no hour is read twice.</summary>
    public static List<string> List(string dir, SearchOption opt = SearchOption.TopDirectoryOnly)
    {
        if (!Directory.Exists(dir)) return new();
        var byStem = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var f in Directory.GetFiles(dir, Pattern, opt))
        {
            if (!IsReplayFile(f)) continue;
            var key = Path.Combine(Path.GetDirectoryName(f) ?? "", Stem(f));
            if (!byStem.ContainsKey(key) || f.EndsWith(Zst, StringComparison.Ordinal))
                byStem[key] = f;
        }
        return byStem.Values.ToList();
    }

    /// <summary>Path of the file for a stem in either encoding, or null.</summary>
    public static string? Find(string dir, string stem)
    {
        var z = Path.Combine(dir, stem + Zst);
        if (File.Exists(z)) return z;
        var g = Path.Combine(dir, stem + Gz);
        return File.Exists(g) ? g : null;
    }

    /// <summary>Open a replay file for reading as decompressed JSONL.</summary>
    public static Stream OpenRead(string path)
    {
        var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 1 << 16);
        try
        {
            return path.EndsWith(Zst, StringComparison.Ordinal)
                ? new ZstdSharp.DecompressionStream(fs, leaveOpen: false)
                : new GZipStream(fs, CompressionMode.Decompress, leaveOpen: false);
        }
        catch { fs.Dispose(); throw; }
    }
}

/// <summary>
/// Background re-encoder: turns finished replay hours (.jsonl.gz) into .jsonl.zst, one file at a time on a
/// below-normal-priority thread (the Pi's CPU is shared). The hour being recorded is never touched — a
/// file is only compacted once its hour ended over 20 minutes ago and it hasn't been written for 20 minutes.
/// The swap is write-temp → rename → delete .gz, and the new file keeps the original's mtime because the
/// budget enforcer trims oldest-by-mtime.
/// </summary>
static class ReplayCompactor
{
    private static int _level = 6;
    private static long _savedBytes, _files;
    // Files that failed to convert (corrupt source, verify mismatch) — not retried until restart.
    private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, byte> _skip = new();
    public static long SavedBytes => Interlocked.Read(ref _savedBytes);
    public static long FilesCompacted => Interlocked.Read(ref _files);

    public static void Start(string replayDir, CancellationToken ct)
    {
        if (int.TryParse(Environment.GetEnvironmentVariable("REPLAY_ZSTD_LEVEL"), out var lv)) _level = Math.Clamp(lv, 1, 19);
        if (Environment.GetEnvironmentVariable("REPLAY_COMPACT") == "0") { Console.WriteLine("[COMPACT] disabled"); return; }
        var t = new Thread(() => Loop(replayDir, ct)) { IsBackground = true, Priority = ThreadPriority.BelowNormal, Name = "replay-compactor" };
        t.Start();
    }

    private static void Loop(string replayDir, CancellationToken ct)
    {
        // Let startup (cache load, NASR, Solace) settle first.
        if (ct.WaitHandle.WaitOne(TimeSpan.FromMinutes(2))) return;
        while (!ct.IsCancellationRequested)
        {
            int done = 0;
            try
            {
                var now = DateTime.UtcNow;
                var todo = Directory.Exists(replayDir)
                    ? Directory.GetFiles(replayDir, "*" + ReplayFiles.Gz, SearchOption.AllDirectories)
                        .Where(f => !_skip.ContainsKey(f) && ReplayFiles.Hour(f) is { } h && h.AddHours(1) < now.AddMinutes(-20))
                        .Where(f => { try { return File.GetLastWriteTimeUtc(f) < now.AddMinutes(-20); } catch { return false; } })
                        // Newest finished hours first: the most-replayed data gets small soonest, and the
                        // oldest may be trimmed by the budget before it's worth re-encoding.
                        .OrderByDescending(f => ReplayFiles.Hour(f))
                        .ToList()
                    : new List<string>();
                foreach (var f in todo)
                {
                    if (ct.IsCancellationRequested) return;
                    var sw = System.Diagnostics.Stopwatch.StartNew();
                    if (Compact(f)) done++;
                    // Breathe at least as long as the file took (≤ ~half a core) so the co-tenant services
                    // and the live feed keep their CPU while the backlog is worked through.
                    if (ct.WaitHandle.WaitOne(TimeSpan.FromMilliseconds(Math.Max(2000, sw.ElapsedMilliseconds)))) return;
                }
            }
            catch (Exception ex) { Console.WriteLine($"[COMPACT] pass error: {ex.Message}"); }
            if (done > 0)
                Console.WriteLine($"[COMPACT] {done} file(s) this pass; {FilesCompacted} total, saved {SavedBytes / (1024 * 1024)} MB");
            if (ct.WaitHandle.WaitOne(TimeSpan.FromMinutes(done > 0 ? 1 : 10))) return;
        }
    }

    /// <summary>Re-encode one .jsonl.gz as .jsonl.zst. Returns true when swapped.</summary>
    public static bool Compact(string gzPath)
    {
        var dir = Path.GetDirectoryName(gzPath)!;
        var stem = ReplayFiles.Stem(gzPath);
        var zst = Path.Combine(dir, stem + ReplayFiles.Zst);
        var tmp = Path.Combine(dir, stem + ".partial");
        try
        {
            if (File.Exists(zst)) { TryDelete(gzPath); return false; }   // an earlier swap was interrupted after rename
            var mtime = File.GetLastWriteTimeUtc(gzPath);
            long before = new FileInfo(gzPath).Length;
            long lines = 0;
            using (var src = ReplayFiles.OpenRead(gzPath))
            using (var outFs = new FileStream(tmp, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 16))
            using (var z = new ZstdSharp.CompressionStream(outFs, _level, leaveOpen: false))
            {
                // Copy line-wise-agnostic: bytes are the same JSONL. A gzip file cut short by a crash
                // throws at the torn end — keep everything before it, like the readers do.
                var buf = new byte[1 << 16];
                try
                {
                    int n;
                    while ((n = src.Read(buf, 0, buf.Length)) > 0)
                    {
                        z.Write(buf, 0, n);
                        for (int i = 0; i < n; i++) if (buf[i] == (byte)'\n') lines++;
                    }
                }
                catch (InvalidDataException) { /* truncated gzip tail */ }
                catch (IOException) { /* truncated gzip tail */ }
            }
            if (lines == 0) { TryDelete(tmp); _skip[gzPath] = 0; return false; }
            // Verify before the original goes: the new file must decode to the same number of lines.
            long check = 0;
            using (var v = new ZstdSharp.DecompressionStream(File.OpenRead(tmp), leaveOpen: false))
            {
                var buf = new byte[1 << 16]; int n;
                while ((n = v.Read(buf, 0, buf.Length)) > 0)
                    for (int i = 0; i < n; i++) if (buf[i] == (byte)'\n') check++;
            }
            if (check != lines)
            {
                Console.WriteLine($"[COMPACT] {Path.GetFileName(gzPath)}: verify failed ({check} vs {lines} lines) — kept .gz");
                _skip[gzPath] = 0;
                TryDelete(tmp);
                return false;
            }
            File.SetLastWriteTimeUtc(tmp, mtime);
            File.Move(tmp, zst);
            File.SetLastWriteTimeUtc(zst, mtime);
            long after = new FileInfo(zst).Length;
            TryDelete(gzPath);
            Interlocked.Add(ref _savedBytes, before - after);
            Interlocked.Increment(ref _files);
            return true;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[COMPACT] {Path.GetFileName(gzPath)}: {ex.Message}");
            _skip[gzPath] = 0;
            TryDelete(tmp);
            return false;
        }
    }

    private static void TryDelete(string p) { try { if (File.Exists(p)) File.Delete(p); } catch { } }
}
