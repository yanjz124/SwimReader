namespace SwimServer;

/// <summary>
/// How much CPU the CURRENT THREAD has burned, from <c>/proc/thread-self/stat</c>.
///
/// <para><b>Why this exists.</b> This repo has now misread a wall-clock-flavoured number as a
/// cost three times — <c>busyPct</c> charging lock-wait to parsing, <c>ps %CPU</c> being a
/// lifetime average, and the NAS fusion pass's 250 ms "cost" that turned out to be mostly
/// scheduler delay. The Pi runs four cores at load 5–10 with co-tenant services, so on a
/// contended box <b>wall time measures contention and tells you nothing about work.</b></para>
///
/// <para>The obvious alternative — differencing the whole process's CPU counters across an idle
/// window and a busy one — is also wrong here, and measurably so: two such measurements of the
/// same code gave <b>3.7%</b> and <b>21.7%</b> of a core, because the idle baseline itself moved
/// 17% of a core between the runs. A difference of two noisy numbers is noise.</para>
///
/// <para>Reading the thread's own counters immediately either side of the work needs no
/// baseline, no second window and no assumption that the box is otherwise quiet. It is the only
/// one of the three that answers the question asked.</para>
///
/// <para><b>Granularity is one clock tick — 10 ms</b> (CLK_TCK is 100 on Linux, verified on the
/// Pi). A single short measurement is therefore coarse, which is why callers should average over
/// several samples rather than quote one.</para>
/// </summary>
static class ThreadCpu
{
    // CLK_TCK. sysconf(3) isn't exposed to managed code without a P/Invoke, and this is 100 on
    // every Linux the server runs on (confirmed: `getconf CLK_TCK` on the Pi). If that ever
    // stops being true the numbers scale linearly and look obviously wrong, not subtly wrong.
    private const double TicksPerSecond = 100.0;

    private static readonly bool Supported = OperatingSystem.IsLinux() && File.Exists("/proc/thread-self/stat");

    /// <summary>
    /// Total (user + system) CPU milliseconds for the calling thread, or null where
    /// <c>/proc</c> is unavailable — Windows dev machines, notably, where every caller must
    /// cope with not getting an answer rather than reporting a fabricated one.
    /// </summary>
    public static double? Ms()
    {
        if (!Supported) return null;
        try { return Parse(File.ReadAllText("/proc/thread-self/stat")); }
        catch { return null; }
    }

    /// <summary>
    /// Pull user+system ticks out of one <c>/proc/.../stat</c> line.
    ///
    /// <para>Separate from <see cref="Ms"/>, and internal, because the parse has a trap worth a
    /// test and <c>/proc</c> does not exist on the Windows machine this is developed on. Field 2
    /// is the thread name <b>in parentheses, and it may contain spaces and parentheses of its
    /// own</b> — .NET thread names routinely do. Splitting the line on spaces, or scanning to the
    /// FIRST ')', shifts every subsequent field and yields a plausible wrong number rather than
    /// an error. The only safe anchor is the LAST ')'.</para>
    /// </summary>
    internal static double? Parse(string stat)
    {
        var close = stat.LastIndexOf(')');
        if (close < 0 || close + 2 >= stat.Length) return null;
        // The first token after "') '" is field 3 (state), so field n sits at index n-3.
        var f = stat[(close + 2)..].Split(' ');
        if (f.Length < 13) return null;
        if (!long.TryParse(f[11], out var utime)) return null;   // field 14
        if (!long.TryParse(f[12], out var stime)) return null;   // field 15
        return (utime + stime) * 1000.0 / TicksPerSecond;
    }

    /// <summary>
    /// CPU milliseconds since <paramref name="start"/>, where <paramref name="start"/> came from
    /// <see cref="Ms"/> on the SAME thread. Null in, null out.
    /// </summary>
    public static double? Since(double? start)
    {
        if (start is null) return null;
        var now = Ms();
        return now is null ? null : Math.Max(0, now.Value - start.Value);
    }
}
