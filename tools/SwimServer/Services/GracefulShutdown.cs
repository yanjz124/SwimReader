using System.Diagnostics;

namespace SwimServer;

/// <summary>
/// Runs shutdown work in priority order, with a wall-clock budget AND a per-step deadline.
///
/// <para>Shutdown time is not free: while the process is stopping, nothing is bound to the SCDS
/// queues, and those queues hold very little. TFDM's holds ~150 messages — under a second at
/// 190 msg/s — so every second of shutdown is thousands of messages expired at the broker and
/// gone for good. The portal's "Expired Message Count" spikes line up with
/// <c>Started sfdps-eram</c> to the minute.</para>
///
/// <para>A budget checked only <i>between</i> steps is not enough: the first measured shutdown
/// logged <c>stop timers 0ms</c> and then died inside the next step, because disposing the replay
/// recorders on its own outlasts systemd's <c>TimeoutStopSec</c>. So each step also gets a
/// deadline and is abandoned if it overruns — the process is going away regardless, and the two
/// things that would be unsafe to interrupt are not: the flight cache writes to a temp file and
/// renames, and the replay streams are flushed as they are written so their files stay readable
/// up to the last flush.</para>
///
/// <para>Ordering principle: flush what cannot be rebuilt (the aircraft DB, ITWS history) before
/// what can (replay tails, and the flight cache, which the live feed refills within seconds).</para>
/// </summary>
static class GracefulShutdown
{
    public static void Run(TimeSpan budget, params (string Name, Action Work)[] steps)
    {
        var sw = Stopwatch.StartNew();
        foreach (var (name, work) in steps)
        {
            var left = budget - sw.Elapsed;
            if (left <= TimeSpan.Zero)
            {
                Console.WriteLine($"[Shutdown] budget spent after {sw.ElapsedMilliseconds}ms — skipping {name}");
                continue;
            }

            var t0 = sw.Elapsed;
            // Background thread so an overrunning step can be abandoned rather than taking the
            // whole shutdown past the point where systemd SIGKILLs us mid-way through everything.
            var t = new Thread(() =>
            {
                try { work(); }
                catch (Exception ex) { Console.Error.WriteLine($"[Shutdown] {name} failed: {ex.Message}"); }
            })
            { IsBackground = true, Name = "Shutdown:" + name };
            t.Start();

            if (t.Join(left))
                Console.WriteLine($"[Shutdown] {name} {(sw.Elapsed - t0).TotalMilliseconds:F0}ms");
            else
                Console.WriteLine($"[Shutdown] {name} still running after {left.TotalMilliseconds:F0}ms — abandoned");
        }
        Console.WriteLine($"[Shutdown] done in {sw.ElapsedMilliseconds}ms (budget {budget.TotalSeconds:F0}s)");
    }
}
