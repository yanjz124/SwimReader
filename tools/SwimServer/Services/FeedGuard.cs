namespace SwimServer;

/// <summary>
/// Stops a second machine from quietly eating the live SWIM feed the deployed server is using.
///
/// SCDS delivers over Solace <b>queues</b>, which are point-to-point: each message goes to exactly
/// ONE consumer. Two instances bound to the same queue therefore SPLIT the stream instead of each
/// receiving all of it — and nothing anywhere reports an error, so the deployed site just looks
/// starved while the laptop looks perfect.
///
/// Measured on the Pi, 90-second windows, with and without a laptop instance on the same queue:
///   position updates      255.6/s → 146.8/s
///   refresh per flight       9.6s → 16.1s   (past the 12s radar cycle, so scans get missed)
///   tracks past the scope's 26s coast threshold   13.4% → 31.0%
///
/// So name the host that owns the feed in SWIM_FEED_HOST. Anywhere else the Solace consumers do
/// not start: the server still serves every page, API, cached flight and replay recording, which
/// is what local UI work actually needs.
///
/// Fail-safe by design — SWIM_FEED_HOST unset means no guard at all, so a deployment that never
/// sets it keeps working exactly as before. Set SWIM_ALLOW_SHARED_QUEUE=1 to override for a
/// deliberate local session against live data (and remember the site is paying for it).
/// </summary>
static class FeedGuard
{
    /// <summary>False when this host must not bind the shared SWIM queues.</summary>
    public static bool LiveFeed { get; private set; } = true;

    /// <summary>Why the live feed is off, for the API and the startup banner. Null when it's on.</summary>
    public static string? BlockedReason { get; private set; }

    /// <summary>The host that owns the feed, as configured. Null when no guard is configured.</summary>
    public static string? FeedHost { get; private set; }

    /// <summary>Call once at startup, before any Solace consumer is started.</summary>
    public static void Evaluate()
    {
        var want = (Environment.GetEnvironmentVariable("SWIM_FEED_HOST") ?? "").Trim();
        FeedHost = want.Length > 0 ? want : null;
        if (want.Length == 0) return;                                  // no guard configured

        var here = Environment.MachineName;
        if (string.Equals(want, here, StringComparison.OrdinalIgnoreCase)) return;   // this is the feed host

        var over = (Environment.GetEnvironmentVariable("SWIM_ALLOW_SHARED_QUEUE") ?? "").Trim();
        if (over is "1" or "true" or "TRUE" or "yes")
        {
            Console.WriteLine($"[FEED] SWIM_ALLOW_SHARED_QUEUE set — consuming the live feed from '{here}' " +
                              $"even though '{want}' owns it. This SPLITS the feed with the deployed server.");
            return;
        }

        LiveFeed = false;
        BlockedReason = $"host is '{here}', feed belongs to '{want}'";
        Console.WriteLine();
        Console.WriteLine("  ┌──────────────────────────────────────────────────────────────────────┐");
        Console.WriteLine("  │  LIVE SWIM FEED OFF — this host does not own it                      │");
        Console.WriteLine($"  │  running on '{here,-20}'  feed host '{want,-18}' │");
        Console.WriteLine("  │                                                                      │");
        Console.WriteLine("  │  A Solace queue delivers each message to ONE consumer, so running    │");
        Console.WriteLine("  │  here as well would halve the deployed server's feed and push its    │");
        Console.WriteLine("  │  tracks into coast. Pages, APIs, the flight cache and replay all     │");
        Console.WriteLine("  │  still work — only the live consumers are stopped.                   │");
        Console.WriteLine("  │                                                                      │");
        Console.WriteLine("  │  Really want live data here?  SWIM_ALLOW_SHARED_QUEUE=1              │");
        Console.WriteLine("  └──────────────────────────────────────────────────────────────────────┘");
        Console.WriteLine();
    }
}
