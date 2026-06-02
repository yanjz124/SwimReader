namespace SwimServer;

/// <summary>
/// Per-category disk budgets for persisted data. Each category ("bucket") has its OWN
/// hard cap and its own set of watched directories, and is enforced independently of the
/// others. This lets small, high-value text data (flight-history, tdls-history) be retained
/// for a long time while large binary replay recordings (eram/asdex) are pruned aggressively
/// on a much smaller cap — instead of all data competing for one shared budget where the tiny
/// text files could be deleted before the huge replay files.
///
/// Define each bucket once at startup with <see cref="DefineBucket"/> + <see cref="Watch"/>,
/// then call <see cref="Enforce"/> periodically (once per hour is plenty). Directories that
/// belong to no bucket (e.g. other apps' data) are never touched.
/// </summary>
static class PersistenceBudget
{
    private record DirSpec(string Path, string Pattern);

    private sealed class Bucket
    {
        public string Name = "";
        public long MaxBytes = long.MaxValue;
        public readonly List<DirSpec> Dirs = new();
    }

    // Insertion order preserved so log output is stable/readable.
    private static readonly Dictionary<string, Bucket> _buckets = new();
    private static readonly object _lock = new();

    private static Bucket GetOrAdd(string name)
    {
        if (!_buckets.TryGetValue(name, out var b))
        {
            b = new Bucket { Name = name };
            _buckets[name] = b;
        }
        return b;
    }

    /// <summary>Define (or update) a bucket's hard cap, in bytes.</summary>
    public static void DefineBucket(string name, long maxBytes)
    {
        lock (_lock) GetOrAdd(name).MaxBytes = maxBytes;
    }

    /// <summary>
    /// Register a directory under a bucket. Pattern e.g. "*.jsonl.gz" or "*.jsonl".
    /// Multiple directories can share a bucket (their combined size is capped together).
    /// </summary>
    public static void Watch(string bucket, string path, string pattern = "*")
    {
        lock (_lock) GetOrAdd(bucket).Dirs.Add(new DirSpec(path, pattern));
    }

    /// <summary>Combined size of one bucket's watched directories, in bytes.</summary>
    public static long CurrentBytes(string bucket)
    {
        lock (_lock)
        {
            if (!_buckets.TryGetValue(bucket, out var b)) return 0;
            return SumBytes(b);
        }
    }

    private static long SumBytes(Bucket b)
    {
        long total = 0;
        foreach (var d in b.Dirs)
        {
            if (!Directory.Exists(d.Path)) continue;
            foreach (var f in Directory.GetFiles(d.Path, d.Pattern, SearchOption.AllDirectories))
            {
                try { total += new FileInfo(f).Length; } catch { }
            }
        }
        return total;
    }

    /// <summary>Enforce every bucket's cap independently.</summary>
    public static void Enforce()
    {
        Bucket[] buckets;
        lock (_lock) buckets = _buckets.Values.ToArray();
        foreach (var b in buckets) EnforceBucket(b);
    }

    /// <summary>
    /// If a bucket's combined size exceeds its cap, delete the oldest files (by mtime)
    /// within that bucket only, until back under cap.
    /// </summary>
    private static void EnforceBucket(Bucket b)
    {
        try
        {
            var all = new List<FileInfo>();
            foreach (var d in b.Dirs)
            {
                if (!Directory.Exists(d.Path)) continue;
                foreach (var f in Directory.GetFiles(d.Path, d.Pattern, SearchOption.AllDirectories))
                {
                    try { all.Add(new FileInfo(f)); } catch { }
                }
            }

            long total = 0;
            foreach (var fi in all) total += fi.Length;

            var capMb = b.MaxBytes == long.MaxValue ? -1 : b.MaxBytes / (1024 * 1024);
            var totalMb = total / (1024 * 1024);
            Console.WriteLine($"[BUDGET:{b.Name}] {totalMb} MB used across {all.Count} files (cap: {(capMb < 0 ? "none" : capMb + " MB")})");

            if (total <= b.MaxBytes) return;

            // Sort by modification time, oldest first.
            all.Sort((a, c) => a.LastWriteTimeUtc.CompareTo(c.LastWriteTimeUtc));

            int deleted = 0;
            long freed = 0;
            foreach (var fi in all)
            {
                if (total <= b.MaxBytes) break;
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
                    Console.WriteLine($"[BUDGET:{b.Name}] Delete failed {fi.FullName}: {ex.Message}");
                }
            }
            Console.WriteLine($"[BUDGET:{b.Name}] Deleted {deleted} oldest files, freed {freed / (1024 * 1024)} MB; now at {total / (1024 * 1024)} MB");
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[BUDGET:{b.Name}] Enforce error: {ex.Message}");
        }
    }
}
