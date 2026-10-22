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
        public long BusyTicks;            // Stopwatch ticks spent inside the handler
        public long LastDiscardTicks;     // UTC ticks of the most recent discard indication
        // End-to-end lag: the publisher's own timestamp vs when we got the message. This is the
        // metric whose absence hid a halved feed for months — PosAge counts from RECEIPT, so a
        // consumer draining an hours-old backlog still stamps every record "fresh".
        public long LagMsSum, LagSamples, LagMsMax;
        // Snapshot of the previous 10s interval, written by the timer.
        public long PrevMsgs, PrevBusyTicks, PrevBytes;
        public double RateMsgs, BusyPct, RateBytes, LagMsMean;
        public long LagMsPeak;            // max lag seen in the last window
        public DateTime WindowStart = DateTime.UtcNow;
    }

    private static readonly ConcurrentDictionary<string, Counters> _feeds = new(StringComparer.OrdinalIgnoreCase);
    private static readonly double TicksPerMs = System.Diagnostics.Stopwatch.Frequency / 1000.0;
    private static Timer? _timer;

    /// <summary>Starts the 10s sampler. Safe to call once at startup.</summary>
    public static void Start() => _timer ??= new Timer(_ => Sample(), null, 10_000, 10_000);

    /// <summary>
    /// Wraps one message handler: counts the message, notes a broker discard indication, and times
    /// the work. A struct, so `using var` costs no allocation on a 250 msg/s path.
    /// </summary>
    public static Scope Track(string feed, IMessage msg)
    {
        var c = _feeds.GetOrAdd(feed, _ => new Counters());
        Interlocked.Increment(ref c.Msgs);
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

    public readonly struct Scope : IDisposable
    {
        private readonly Counters _c;
        private readonly long _t0;
        internal Scope(Counters c) { _c = c; _t0 = System.Diagnostics.Stopwatch.GetTimestamp(); }
        public void Dispose() =>
            Interlocked.Add(ref _c.BusyTicks, System.Diagnostics.Stopwatch.GetTimestamp() - _t0);
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
            var bytes = Interlocked.Read(ref c.Bytes);
            c.RateMsgs = (msgs - c.PrevMsgs) / elapsed;
            c.RateBytes = (bytes - c.PrevBytes) / elapsed;
            c.BusyPct = Math.Round((busy - c.PrevBusyTicks) / TicksPerMs / (elapsed * 1000.0) * 100.0, 1);
            // Mean over the window, then reset — a running mean since startup would hide a lag
            // that is growing right now, which is the whole point of the metric.
            var n = Interlocked.Exchange(ref c.LagSamples, 0);
            var sum = Interlocked.Exchange(ref c.LagMsSum, 0);
            c.LagMsMean = n > 0 ? (double)sum / n : double.NaN;
            c.LagMsPeak = Interlocked.Exchange(ref c.LagMsMax, 0);
            c.PrevMsgs = msgs;
            c.PrevBytes = bytes;
            c.PrevBusyTicks = busy;
            c.WindowStart = now;
        }
    }

    public static object Snapshot() => _feeds
        .OrderBy(kv => kv.Key, StringComparer.Ordinal)
        .Select(kv =>
        {
            var c = kv.Value;
            var lastDiscard = Interlocked.Read(ref c.LastDiscardTicks);
            return (object)new
            {
                feed = kv.Key,
                msgs = Interlocked.Read(ref c.Msgs),
                msgsPerSec = Math.Round(c.RateMsgs, 1),
                // Share of the feed's single callback thread spent parsing. Sustained high values
                // mean only the broker's spool is keeping us lossless.
                busyPct = c.BusyPct,
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
            };
        })
        .ToArray();
}
