using System.Diagnostics;

namespace SwimServer;

/// <summary>
/// Runs shutdown work in priority order under a wall-clock budget.
///
/// <para>Shutdown time is not free: while the process is stopping, nothing is bound to the SCDS
/// queues, and those queues hold very little. TFDM's holds ~150 messages — under a second at
/// 190 msg/s — so every second of shutdown is thousands of messages expired at the broker and
/// gone for good. The portal's "Expired Message Count" spikes line up with
/// <c>Started sfdps-eram</c> to the minute.</para>
///
/// <para>Before this, shutdown ran everything unconditionally, overran systemd's
/// <c>TimeoutStopSec</c>, and the process was SIGKILLed — so the expensive work was paid for and
/// then thrown away anyway. Now the cheap, valuable things run first, each step is timed so the
/// log says what actually costs, and anything past the budget is skipped rather than half-done.</para>
///
/// <para>Ordering principle: flush what cannot be rebuilt (replay recorders, the aircraft DB)
/// before what can (the flight cache, which the live feed refills within seconds of restart).</para>
/// </summary>
static class GracefulShutdown
{
    public static void Run(TimeSpan budget, params (string Name, Action Work)[] steps)
    {
        var sw = Stopwatch.StartNew();
        foreach (var (name, work) in steps)
        {
            if (sw.Elapsed >= budget)
            {
                Console.WriteLine($"[Shutdown] budget spent after {sw.ElapsedMilliseconds}ms — skipping {name}");
                continue;
            }
            var t0 = sw.Elapsed;
            try { work(); }
            catch (Exception ex) { Console.Error.WriteLine($"[Shutdown] {name} failed: {ex.Message}"); }
            Console.WriteLine($"[Shutdown] {name} {(sw.Elapsed - t0).TotalMilliseconds:F0}ms");
        }
        Console.WriteLine($"[Shutdown] done in {sw.ElapsedMilliseconds}ms (budget {budget.TotalSeconds:F0}s)");
    }
}
