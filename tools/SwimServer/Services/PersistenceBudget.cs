namespace SwimServer;

/// <summary>
/// Single shared disk budget for ALL persisted data: replay recordings, flight history,
/// TDLS history, etc. When the combined size exceeds the cap, the oldest files across
/// all watched directories are deleted (by file modification time) until under cap.
///
/// Configure once at startup with a hard byte cap and the directories to watch.
/// Call <see cref="Enforce"/> periodically (once per hour is plenty).
/// </summary>
static class PersistenceBudget
{
    private static long _maxBytes = long.MaxValue;
    private static readonly List<DirSpec> _dirs = new();
    private static readonly object _lock = new();

    private record DirSpec(string Path, string Pattern);

    /// <summary>Hard cap on combined size of all watched directories, in bytes.</summary>
    public static void SetCap(long maxBytes) => _maxBytes = maxBytes;

    /// <summary>Register a directory to watch. Pattern e.g. "*.jsonl.gz" or "*.jsonl".</summary>
    public static void Watch(string path, string pattern = "*")
    {
        lock (_lock) _dirs.Add(new DirSpec(path, pattern));
    }

    public static long CurrentTotalBytes()
    {
        lock (_lock)
        {
            long total = 0;
            foreach (var d in _dirs)
            {
                if (!Directory.Exists(d.Path)) continue;
                foreach (var f in Directory.GetFiles(d.Path, d.Pattern, SearchOption.AllDirectories))
                {
                    try { total += new FileInfo(f).Length; } catch { }
                }
            }
            return total;
        }
    }

    public static long MaxBytes => _maxBytes;

    /// <summary>
    /// If combined size of all watched directories exceeds the cap, delete oldest files
    /// (by mtime) until back under cap.
    /// </summary>
    public static void Enforce()
    {
        try
        {
            DirSpec[] dirs;
            lock (_lock) dirs = _dirs.ToArray();

            var all = new List<FileInfo>();
            foreach (var d in dirs)
            {
                if (!Directory.Exists(d.Path)) continue;
                foreach (var f in Directory.GetFiles(d.Path, d.Pattern, SearchOption.AllDirectories))
                {
                    try { all.Add(new FileInfo(f)); } catch { }
                }
            }

            long total = 0;
            foreach (var fi in all) total += fi.Length;

            var capMb = _maxBytes / (1024 * 1024);
            var totalMb = total / (1024 * 1024);
            Console.WriteLine($"[BUDGET] {totalMb} MB used across {all.Count} files (cap: {capMb} MB)");

            if (total <= _maxBytes) return;

            // Sort by modification time, oldest first.
            all.Sort((a, b) => a.LastWriteTimeUtc.CompareTo(b.LastWriteTimeUtc));

            int deleted = 0;
            long freed = 0;
            foreach (var fi in all)
            {
                if (total <= _maxBytes) break;
                try
                {
                    var size = fi.Length;
                    fi.Delete();
                    total -= size;
                    freed += size;
                    deleted++;
                }
                catch (Exception ex)
                {
                    Console.WriteLine($"[BUDGET] Delete failed {fi.FullName}: {ex.Message}");
                }
            }
            Console.WriteLine($"[BUDGET] Deleted {deleted} oldest files, freed {freed / (1024 * 1024)} MB; now at {total / (1024 * 1024)} MB");
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[BUDGET] Enforce error: {ex.Message}");
        }
    }
}
