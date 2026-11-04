using System.Collections.Concurrent;
using SolaceSystems.Solclient.Messaging;

namespace SwimServer;

/// <summary>
/// Answers "are we actually receiving everything SWIM is sending?" with numbers instead of a feeling.
///
/// Two things can cost us messages, and neither is visible without this:
///
/// 1. <b>Broker-side congestion discards.</b> Solace sets <c>DiscardIndication</c> on the next message
///    it delivers after it has thrown some away. That is a direct, authoritative "you lost data here"
///    from the broker, so any non-zero <c>discardEvents</c> is real loss — not an estimate.
///
/// 2. <b>Falling behind.</b> Every feed parses inline on its Solace callback thread, which is a SINGLE
///    thread per session. That design is deliberately lossless: if parsing is slower than arrival the
///    flow window fills and the broker spools for us rather than dropping. But a queue that spools
///    long enough hits its quota, and then the broker discards. <c>busyPct</c> is the share of wall
///    time that thread spends parsing, so it is the early warning: sustained high busyPct means the
///    only thing standing between us and data loss is the broker's spool.
///
/// Counters are cumulative; a 10s timer also records the most recent interval so the endpoint can
/// report a current rate without the caller holding state.
/// </summary>
static class FeedHealth
{
    internal sealed class Counters
    {
        public long Msgs;                 // total messages handed to us
        public long Bytes;                // payload bytes handed to us (post-decompression)
        public long DiscardEvents;        // messages flagged DiscardIndication (= a gap before them)
        public long BusyTicks;            // Stopwatch ticks spent PARSING (inside the process gate)
        // Stopwatch ticks spent BLOCKED waiting for the feed's process gate, which is a
        // completely different problem from parsing being slow — see WaitPct below.
        public long WaitTicks;
        // Set once the feed's handler calls Scope.Locked(). A gated feed's BusyTicks can never
        // exceed wall time (one thread holds the lock at a time), so it must NOT be divided by
        // the flow count — see Sample().
        public bool Gated;
        public long LastDiscardTicks;     // UTC ticks of the most recent discard indication
        // End-to-end lag: the publisher's own timestamp vs when we got the message. This is the
        // metric whose absence hid a halved feed for months — PosAge counts from RECEIPT, so a
        // consumer draining an hours-old backlog still stamps every record "fresh".
        public long LagMsSum, LagSamples, LagMsMax;
        // Snapshot of the previous 10s interval, written by the timer.
        public long PrevMsgs, PrevBusyTicks, PrevWaitTicks, PrevBytes;
        public double RateMsgs, BusyPct, WaitPct, RateBytes, LagMsMean;
        public long LagMsPeak;            // max lag seen in the last window
        public DateTime WindowStart = DateTime.UtcNow;

        public long LastMsgTicks;         // UTC ticks of the most recent message
        public long Reconnects;           // times this feed's receivers rebuilt their session
        public int Flows;                 // receivers bound to the queue (see SolaceTuning)
        public DateTime FirstMsg;         // for a lifetime average alongside the live sample

        // Rolling per-sample history, newest last. Written only by the timer, read under lock.
        public readonly List<Window> History = new();
    }

    /// <summary>One 10s window. Kept so the endpoint can answer "is this lag draining?".</summary>
    internal readonly record struct Window(double Rate, double KbPerSec, double BusyPct, double WaitPct, double LagSec);

    // 10 minutes at one sample per 10s. Enough to see a sawtooth cycle; small enough that six
    // feeds' worth still serializes to a few kB on a dashboard poll.
    private const int HistoryLen = 60;

    private static readonly ConcurrentDictionary<string, Counters> _feeds = new(StringComparer.OrdinalIgnoreCase);
    private static readonly double TicksPerMs = System.Diagnostics.Stopwatch.Frequency / 1000.0;
    private static Timer? _timer;
    // For a lifetime average alongside the live sample — the two diverge a lot over a day,
    // which is exactly what made the home page's old number look like a halved feed.
    private static readonly DateTime _started = DateTime.UtcNow;

    /// <summary>Starts the 10s sampler. Safe to call once at startup.</summary>
    public static void Start() => _timer ??= new Timer(_ => Sample(), null, 10_000, 10_000);

    /// <summary>
    /// Declare a feed before its first message, with how many receivers it binds to the queue.
    ///
    /// The flow count is here because it is half of the diagnosis. A Solace queue is
    /// competing-consumers and one session has a hard transport ceiling, so the signature of a
    /// feed that needs more flows is "lag sits high and never drains while busyPct is low" —
    /// and the next question is always "how many has it got?". Both SFDPS and TBFM hit that
    /// ceiling in production (see CLAUDE.md); knowing the current N is what turns the symptom
    /// into an action. Calling this also makes a configured-but-silent feed visible at all,
    /// instead of it being absent from the snapshot and indistinguishable from "not enabled".
    /// </summary>
    public static void Register(string feed, int flows)
    {
        var c = _feeds.GetOrAdd(feed, _ => new Counters());
        c.Flows = flows;
    }

    /// <summary>
    /// One of a feed's receivers tore down its session and rebuilt it — either the 90s silence
    /// watchdog fired or the session threw. Worth counting separately from throughput: a feed
    /// that reconnects every few minutes delivers a respectable average rate with real gaps in
    /// it, and nothing else on the dashboard would show that.
    /// </summary>
    public static void NoteReconnect(string feed)
    {
        var c = _feeds.GetOrAdd(feed, _ => new Counters());
        Interlocked.Increment(ref c.Reconnects);
    }

    /// <summary>
    /// Wraps one message handler: counts the message, notes a broker discard indication, and times
    /// the work. A struct, so `using var` costs no allocation on a 250 msg/s path.
    /// </summary>
    public static Scope Track(string feed, IMessage msg)
    {
        var c = _feeds.GetOrAdd(feed, _ => new Counters());
        Interlocked.Increment(ref c.Msgs);
        Interlocked.Exchange(ref c.LastMsgTicks, DateTime.UtcNow.Ticks);
        // Payload size after the API has decompressed it. Combined with the rate this gives the
        // throughput actually crossing one session, which is what a compressed (and therefore
        // strictly serial, single-stream) transport caps.
        try
        {
            // SCDS publishes the document in either slot — SFDPS uses the XML payload, the
            // STDDS-family feeds the binary attachment. Counting only one of them silently
            // reported 0 B/s, which is useless exactly when throughput is the question.
            var n = msg.BinaryAttachment?.Length ?? 0;
            if (n == 0) n = msg.XmlContent?.Length ?? 0;
            if (n > 0) Interlocked.Add(ref c.Bytes, n);
        }
        catch { /* some message types carry neither */ }
        // The broker stamps most SCDS messages; where it doesn't, the feed reports its own
        // document timestamp through NoteLag and this is simply skipped.
        try
        {
            var st = msg.SenderTimestamp;
            if (st > 0) NoteLagMs(c, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - st);
        }
        catch { /* SenderTimestamp not set by this publisher */ }
        bool discarded = false;
        try { discarded = msg.DiscardIndication; } catch { /* not all message types expose it */ }
        if (discarded)
        {
            var n = Interlocked.Increment(ref c.DiscardEvents);
            Interlocked.Exchange(ref c.LastDiscardTicks, DateTime.UtcNow.Ticks);
            // Loud on the first one and then sparsely — this is real, unrecoverable data loss.
            if (n == 1 || n % 100 == 0)
                Console.Error.WriteLine($"[FEED] {feed}: broker discarded messages before delivery " +
                                        $"(discard indication #{n}) — we are not keeping up, or the queue spool filled.");
        }
        return new Scope(c);
    }

    /// <summary>
    /// Report end-to-end lag for a feed whose publisher timestamp lives in the payload rather
    /// than the Solace header (SFDPS carries it as the FIXM message `timestamp` attribute).
    /// </summary>
    public static void NoteLag(string feed, DateTime publishedUtc)
    {
        if (publishedUtc == default) return;
        var c = _feeds.GetOrAdd(feed, _ => new Counters());
        NoteLagMs(c, (long)(DateTime.UtcNow - publishedUtc).TotalMilliseconds);
    }

    private static void NoteLagMs(Counters c, long lagMs)
    {
        // Clock skew or a malformed stamp would otherwise poison the mean.
        if (lagMs < -5_000 || lagMs > 6 * 3600_000) return;
        Interlocked.Add(ref c.LagMsSum, lagMs);
        Interlocked.Increment(ref c.LagSamples);
        long seen;
        while (lagMs > (seen = Interlocked.Read(ref c.LagMsMax)))
            if (Interlocked.CompareExchange(ref c.LagMsMax, lagMs, seen) == seen) break;
    }

    /// <summary>
    /// Times one message. NOT a readonly struct: <see cref="Locked"/> mutates it, which is what
    /// lets the same scope report wait and parse separately. `using var` on a struct calls
    /// Dispose on the variable itself, so the mutation is visible.
    ///
    /// <para><b>Why this exists.</b> Every feed's handler is created BEFORE it takes the feed's
    /// process gate, so the original single timer charged lock-wait to parse time. That made
    /// busyPct unreadable on exactly the feed that most needed it: SFDPS runs 3 receivers against
    /// one <c>sfdpsProcessGate</c>, so two of them are usually blocked, and the feed reported 76.6%
    /// "busy" while the actual parsing might be a fraction of that. Worse, it inverted the signal —
    /// adding flows is the documented fix for a transport ceiling, and each extra flow piles onto
    /// the same lock and pushes measured busyPct UP, toward the reading that says stop adding
    /// flows. A metric that moves against the fix is worse than no metric.</para>
    /// </summary>
    public struct Scope : IDisposable
    {
        private readonly Counters? _c;
        private readonly long _t0;
        private long _acquired;   // when the gate was taken; 0 = this feed has no gate

        internal Scope(Counters c) { _c = c; _t0 = System.Diagnostics.Stopwatch.GetTimestamp(); _acquired = 0; }

        /// <summary>
        /// Call as the FIRST statement inside the feed's <c>lock (_processGate)</c>. Everything
        /// before it counts as wait, everything after as parse. A feed that never calls it has
        /// all of its handler time charged to parse, which is correct for an ungated feed.
        /// </summary>
        public void Locked()
        {
            _acquired = System.Diagnostics.Stopwatch.GetTimestamp();
            if (_c is not null) _c.Gated = true;
        }

        public void Dispose()
        {
            if (_c is null) return;
            var end = System.Diagnostics.Stopwatch.GetTimestamp();
            if (_acquired == 0)
            {
                Interlocked.Add(ref _c.BusyTicks, end - _t0);
            }
            else
            {
                Interlocked.Add(ref _c.WaitTicks, _acquired - _t0);
                Interlocked.Add(ref _c.BusyTicks, end - _acquired);
            }
        }
    }

    private static void Sample()
    {
        var now = DateTime.UtcNow;
        foreach (var c in _feeds.Values)
        {
            var elapsed = (now - c.WindowStart).TotalSeconds;
            if (elapsed <= 0) continue;
            var msgs = Interlocked.Read(ref c.Msgs);
            var busy = Interlocked.Read(ref c.BusyTicks);
            var wait = Interlocked.Read(ref c.WaitTicks);
            var bytes = Interlocked.Read(ref c.Bytes);
            c.RateMsgs = (msgs - c.PrevMsgs) / elapsed;
            c.RateBytes = (bytes - c.PrevBytes) / elapsed;
            // Divide by the receiver count. BusyTicks is summed across every one of this feed's
            // Solace callback threads, so with N flows the figure ran to N x 100% — TFMS showed
            // 153.6% on two receivers, which is not a percentage of anything. Normalizing gives
            // the documented quantity: the average share of ONE parse thread, which is what the
            // "sustained high busy means only the spool is keeping us lossless" reading needs,
            // and what makes the number comparable between a 1-flow and a 6-flow feed.
            var threads = Math.Max(1, c.Flows);
            // BUSY is gate UTILIZATION for a gated feed: the share of wall time some thread was
            // inside the critical section. Deliberately NOT divided by the flow count.
            //
            // Dividing it was right while BusyTicks included lock-wait (TFMS read 153.6% on two
            // receivers, which is not a percentage of anything). Once wait moved to its own
            // counter the division became a bug, because only one thread can hold the gate, so
            // BusyTicks <= elapsed and the quotient caps at 100/N. SFDPS's maximum was therefore
            // 33% and TBFM's, on six flows, 16.7% — which made the `saturated` threshold (>= 60)
            // UNREACHABLE on every multi-flow feed, i.e. the one verdict about parsing being the
            // bottleneck could never fire. Undivided, 60% means 60% of a serial resource on any
            // feed, and the figure stays comparable across flow counts.
            var busyDivisor = c.Gated ? 1 : threads;
            c.BusyPct = Math.Round((busy - c.PrevBusyTicks) / TicksPerMs / (elapsed * 1000.0 * busyDivisor) * 100.0, 1);
            // WAIT stays per-thread: it is time spent by each receiver, and N receivers can block
            // concurrently, so the sum genuinely can reach N x elapsed. Near 100% means every
            // receiver is queueing on the gate and extra flows would buy nothing.
            c.WaitPct = Math.Round((wait - c.PrevWaitTicks) / TicksPerMs / (elapsed * 1000.0 * threads) * 100.0, 1);
            // Mean over the window, then reset — a running mean since startup would hide a lag
            // that is growing right now, which is the whole point of the metric.
            var n = Interlocked.Exchange(ref c.LagSamples, 0);
            var sum = Interlocked.Exchange(ref c.LagMsSum, 0);
            c.LagMsMean = n > 0 ? (double)sum / n : double.NaN;
            c.LagMsPeak = Interlocked.Exchange(ref c.LagMsMax, 0);
            c.PrevMsgs = msgs;
            c.PrevBytes = bytes;
            c.PrevBusyTicks = busy;
            c.PrevWaitTicks = wait;
            c.WindowStart = now;
            // Keep the window so the endpoint can report a lag FLOOR, not just a sample. See
            // LagFloor below for why one reading cannot answer the question anyone is asking.
            lock (c.History)
            {
                c.History.Add(new Window(
                    Math.Round(c.RateMsgs, 1),
                    Math.Round(c.RateBytes / 1024.0, 1),
                    c.BusyPct,
                    c.WaitPct,
                    double.IsNaN(c.LagMsMean) ? -1 : Math.Round(c.LagMsMean / 1000.0, 1)));
                if (c.History.Count > HistoryLen) c.History.RemoveRange(0, c.History.Count - HistoryLen);
            }
        }
    }

    /// <summary>
    /// The LOWEST mean lag over the retained window, and the single most useful number here.
    ///
    /// A lag sample on its own cannot distinguish the two things you need to tell apart, and
    /// this repo has got it wrong in both directions:
    ///
    ///   * a feed whose queue is pinned at the broker's ceiling reports a lag that is high and
    ///     CONSTANT — constant precisely because delivery is capped — which reads like fixed
    ///     upstream latency. SFDPS sat like that for months.
    ///   * a feed that is keeping up but receives in bursts reports a SAWTOOTH: it climbs while
    ///     a burst lands and falls back to ~0 between. TBFM does this, and a single 12s sample
    ///     of one was read here as a regression in a fix that was actually working.
    ///
    /// The floor separates them. A sawtooth touches zero, so its floor is ~0. A pinned queue
    /// never drains, so its floor stays high. "Is this lag draining?" is a question about the
    /// window, not the instant, and the dashboard should not make someone watch for ten minutes
    /// to answer it.
    /// </summary>
    private static double? LagFloor(Counters c) => LagFloorWith(c).floor;

    /// <summary>
    /// The floor plus how many windows it was computed from, because the count decides whether
    /// the floor means anything yet. A feed that started 50 s ago has 5 samples; TBFM's sawtooth
    /// has a period longer than that, so its floor has not seen a trough and equals its current
    /// lag — which is indistinguishable from a pinned queue. Measured on a fresh restart, SFDPS
    /// and TBFM both read "behind" for the first few minutes purely from draining their startup
    /// backlog. Verdict() therefore withholds that call until the window is reasonably full.
    /// </summary>
    private static (double? floor, int samples) LagFloorWith(Counters c)
    {
        lock (c.History)
        {
            double? min = null;
            int n = 0;
            foreach (var h in c.History)
            {
                if (h.LagSec < 0) continue;            // no lag samples in that window
                n++;
                if (min is null || h.LagSec < min) min = h.LagSec;
            }
            return (min, n);
        }
    }

    // 5 minutes of windows. Long enough to contain a trough of the slowest sawtooth observed
    // here, and to outlast the backlog a restart drains.
    private const int FloorMinSamples = 30;

    /// <summary>
    /// One word for what this feed is doing, so every caller reaches the same conclusion from
    /// the same numbers instead of each re-deriving the thresholds.
    ///
    ///   loss       the broker threw messages away. Authoritative and unrecoverable.
    ///   silent     nothing for 90s+ — the watchdog's own reconnect threshold.
    ///   saturated  our parse thread is the bottleneck. Still lossless (the broker spools for
    ///              us) but the spool is all that stands between us and discards.
    ///   gated      lag is high and never drains, the parse thread is NOT the bottleneck, but
    ///              the receivers are queueing on this feed's process gate. Processing is
    ///              serialized, so MORE FLOWS WILL NOT HELP — the fix is to shorten the
    ///              critical section or move work out of it.
    ///   behind     lag is high AND never drains, while the parse thread is idle AND the gate
    ///              is not contended — the signature of one session's transport ceiling. More
    ///              flows is the fix.
    ///   lagging    lag is high but the floor is low: bursty arrival, keeping up. Not a fault.
    ///   idle       registered, no messages yet.
    ///   ok         everything else.
    ///
    /// The `behind` vs `lagging` split is the whole point: they look identical in a snapshot and
    /// have completely different answers.
    /// </summary>
    private static string Verdict(Counters c, double ageSec, double? floor, int floorSamples)
    {
        if (Interlocked.Read(ref c.DiscardEvents) > 0) return "loss";
        if (Interlocked.Read(ref c.Msgs) == 0) return "idle";
        if (ageSec > 90) return "silent";
        if (c.BusyPct >= 60) return "saturated";
        var lag = c.LagMsMean;
        if (!double.IsNaN(lag) && lag / 1000.0 >= 5.0)
        {
            // "behind" is a claim about the SHAPE of the lag over time, so it needs enough
            // windows to have seen a trough if there is one. Below that, say "lagging" — the
            // honest reading of a high lag we cannot yet characterize.
            var settled = floorSamples >= FloorMinSamples;
            if (!settled || floor is null || floor < 5.0) return "lagging";
            // Both of the remaining cases are "lag high and not draining". What separates them
            // is WHERE the time goes, and they have opposite answers — so this is the one branch
            // worth getting right. Contention is judged against a full thread (100%) rather than
            // the per-thread average, because on an N-flow feed N-1 receivers can be blocked
            // while the normalized figure still looks moderate.
            if (c.WaitPct >= 25 && c.BusyPct < 60) return "gated";
            return c.BusyPct < 25 ? "behind" : "lagging";
        }
        return "ok";
    }

    public static object Snapshot() => _feeds
        .OrderBy(kv => kv.Key, StringComparer.Ordinal)
        .Select(kv =>
        {
            var c = kv.Value;
            var lastDiscard = Interlocked.Read(ref c.LastDiscardTicks);
            var lastMsg = Interlocked.Read(ref c.LastMsgTicks);
            var ageSec = lastMsg == 0 ? double.MaxValue
                : (DateTime.UtcNow - new DateTime(lastMsg, DateTimeKind.Utc)).TotalSeconds;
            var (floor, floorSamples) = LagFloorWith(c);
            var upSec = (DateTime.UtcNow - _started).TotalSeconds;
            object[] hist;
            lock (c.History)
                hist = c.History.Select(h => (object)new
                { rate = h.Rate, kbPerSec = h.KbPerSec, busyPct = h.BusyPct, lagSec = h.LagSec }).ToArray();
            return (object)new
            {
                feed = kv.Key,
                msgs = Interlocked.Read(ref c.Msgs),
                msgsPerSec = Math.Round(c.RateMsgs, 1),
                // Share of the feed's single callback thread spent parsing. Sustained high values
                // mean only the broker's spool is keeping us lossless.
                busyPct = c.BusyPct,
                // Share of a receiver thread spent BLOCKED on this feed's process gate. High
                // waitPct with low busyPct means processing is serialized, not slow, and adding
                // flows cannot help — see Scope for why these must be measured apart.
                waitPct = c.WaitPct,
                // Throughput over one session. A compressed Solace session is a single serial
                // zlib stream, so this is the number to compare against when throughput looks
                // capped rather than bursty.
                kbPerSec = Math.Round(c.RateBytes / 1024.0, 1),
                avgMsgBytes = Interlocked.Read(ref c.Msgs) > 0
                    ? (int)(Interlocked.Read(ref c.Bytes) / Interlocked.Read(ref c.Msgs)) : 0,
                // How far behind the publisher we are, this window. Seconds, not milliseconds,
                // because what matters is "are we minutes behind", not jitter.
                lagSec = double.IsNaN(c.LagMsMean) ? (double?)null : Math.Round(c.LagMsMean / 1000.0, 1),
                lagPeakSec = c.LagMsPeak == 0 ? (double?)null : Math.Round(c.LagMsPeak / 1000.0, 1),
                // Non-zero = the broker threw messages away before handing us the next one.
                discardEvents = Interlocked.Read(ref c.DiscardEvents),
                lastDiscard = lastDiscard == 0 ? null : new DateTime(lastDiscard, DateTimeKind.Utc).ToString("o"),
                // The lowest mean lag in the retained window. Compare with lagSec: floor ~0 is a
                // sawtooth that drains, floor ~= lagSec is a queue that never does. See LagFloor.
                lagFloorSec = floor,
                // Receivers bound to this feed's queue. The answer to "behind" is usually to
                // raise this (SFDPS_FLOWS / TBFM_FLOWS / ...), so show what it already is.
                flows = c.Flows,
                reconnects = Interlocked.Read(ref c.Reconnects),
                // Since the last message, not since the last position fix — this is what the
                // 90s silence watchdog in each bridge is measuring.
                lastMsgAgeSec = Interlocked.Read(ref c.LastMsgTicks) == 0 ? (double?)null : Math.Round(ageSec, 1),
                avgMsgsPerSec = upSec > 1 ? Math.Round(Interlocked.Read(ref c.Msgs) / upSec, 1) : 0,
                state = Verdict(c, ageSec, floor, floorSamples),
                // How many 10s windows the floor was computed from. Below ~30 the floor has not
                // had time to show a trough, so a high floor does not yet mean a pinned queue.
                floorSamples,
                // 10 minutes of 10s samples so a caller can draw the shape rather than trust a
                // point. rate/kbPerSec/busyPct/lagSec per window; lagSec -1 = no samples.
                history = hist,
            };
        })
        .ToArray();
}
