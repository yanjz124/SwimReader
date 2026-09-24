using System.Diagnostics;

namespace SwimServer;

/// <summary>
/// Process-level performance metrics for the server status UI: CPU%, memory, GC,
/// threads, uptime, and disk. CPU% is computed as the share of processor time used
/// between successive calls, so the first call returns 0 (no baseline yet) and later
/// calls report the average over the polling interval (home dashboard polls ~10s).
///
/// The client count is a sum over EVERY live feed, not just SFDPS. SwimServer serves
/// sixteen WebSocket routes plus the proxied DGScope/STARS HTTP stream, each with its
/// own client registry; counting only /ws (as this did originally) reported 0 while a
/// room full of people watched ASDE-X, STARS, TDLS, TAIS, TFDM or ITWS. Callers pass
/// the per-feed counts and get both the total and the breakdown.
/// </summary>
static class SystemStats
{
    private static readonly object _lock = new();
    private static TimeSpan _prevCpu;
    private static DateTime _prevTime;
    private static bool _primed;

    /// <param name="feeds">(label, live client count) per feed, in display order.</param>
    public static object Snapshot(IReadOnlyList<(string Label, int Count)> feeds, int flights)
    {
        var wsClients = 0;
        foreach (var f in feeds) wsClients += f.Count;
        var proc = Process.GetCurrentProcess();

        // CPU%: delta of total processor time over wall-clock, normalized by core count.
        double cpuPercent = 0;
        lock (_lock)
        {
            var nowCpu = proc.TotalProcessorTime;
            var nowTime = DateTime.UtcNow;
            if (_primed)
            {
                var cpuDeltaMs = (nowCpu - _prevCpu).TotalMilliseconds;
                var wallMs = (nowTime - _prevTime).TotalMilliseconds;
                var cores = Environment.ProcessorCount;
                if (wallMs > 0 && cores > 0)
                    cpuPercent = Math.Clamp(cpuDeltaMs / (wallMs * cores) * 100.0, 0, 100);
            }
            _prevCpu = nowCpu;
            _prevTime = nowTime;
            _primed = true;
        }

        var gcInfo = GC.GetGCMemoryInfo();

        // Uptime from the actual process start time.
        TimeSpan up = TimeSpan.Zero;
        try { up = DateTime.UtcNow - proc.StartTime.ToUniversalTime(); } catch { }

        // Disk usage for the drive hosting the working directory (replay/history live here).
        double diskFreeGb = 0, diskTotalGb = 0;
        try
        {
            var root = Path.GetPathRoot(Directory.GetCurrentDirectory());
            if (!string.IsNullOrEmpty(root))
            {
                var di = new DriveInfo(root);
                diskFreeGb = Math.Round(di.AvailableFreeSpace / (1024.0 * 1024 * 1024), 1);
                diskTotalGb = Math.Round(di.TotalSize / (1024.0 * 1024 * 1024), 1);
            }
        }
        catch { }

        return new
        {
            cpuPercent = Math.Round(cpuPercent, 1),
            cores = Environment.ProcessorCount,
            memWorkingSetMB = proc.WorkingSet64 / (1024 * 1024),
            memManagedMB = GC.GetTotalMemory(false) / (1024 * 1024),
            gcHeapMB = gcInfo.HeapSizeBytes / (1024 * 1024),
            gen0 = GC.CollectionCount(0),
            gen1 = GC.CollectionCount(1),
            gen2 = GC.CollectionCount(2),
            threads = proc.Threads.Count,
            wsClients,
            // Only the feeds with someone on them — the card lists these under the total.
            wsByFeed = feeds.Where(f => f.Count > 0).Select(f => new { feed = f.Label, count = f.Count }).ToArray(),
            flights,
            uptimeSec = (long)up.TotalSeconds,
            uptime = FormatUptime(up),
            diskFreeGB = diskFreeGb,
            diskTotalGB = diskTotalGb,
            pid = proc.Id,
            machine = Environment.MachineName,
            dotnet = Environment.Version.ToString(),
        };
    }

    private static string FormatUptime(TimeSpan up)
    {
        if (up <= TimeSpan.Zero) return "--";
        return up.TotalDays >= 1
            ? $"{(int)up.TotalDays}d {up.Hours:D2}:{up.Minutes:D2}:{up.Seconds:D2}"
            : $"{up.Hours:D2}:{up.Minutes:D2}:{up.Seconds:D2}";
    }
}
