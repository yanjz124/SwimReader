using System.Collections.Concurrent;
using SolaceSystems.Solclient.Messaging;

namespace SwimReader.Scds;

/// <summary>
/// Feed health for the STDDS service, reported per STDDS sub-service (TAIS / TDES / SMES /
/// APDS / ISMC) plus a rolled-up total.
///
/// <para><b>Why this exists at all.</b> This process had no throughput instrumentation of any
/// kind — not a message count, not a rate, no discard-indication check — while binding a live
/// SCDS queue. Everything we knew about "is the STDDS feed healthy" came from the OTHER process
/// (SwimServer's <c>FeedHealth</c>), which consumes the SAME queue. So the dashboard could show
/// a number for STDDS and be describing only part of it.</para>
///
/// <para><b>And that matters, because a Solace queue is competing-consumers.</b> Each message
/// goes to exactly ONE bound consumer. Both services pass the <c>SWIM_FEED_HOST</c> guard on the
/// deployment host (it was written to stop a second HOST binding the queue, which is a different
/// thing), so on the Pi the two of them split the STDDS stream between them and neither sees all
/// of it. Nothing errors; each just reports a healthy-looking fraction. Counting here is what
/// makes the split visible instead of inferred — compare this total against SwimServer's STDDS
/// figure and the sum is the real queue rate.</para>
///
/// <para>Deliberately mirrors the field names SwimServer's FeedHealth emits, so the two can be
/// rendered side by side and compared without a translation layer.</para>
/// </summary>
public static class StddsFeedHealth
{
    private sealed class Counters
    {
        public long Msgs, Bytes, Discards, LastDiscardTicks, LastMsgTicks;
        public long PrevMsgs, PrevBytes;
        public double RateMsgs, RateBytes;
        public DateTime WindowStart = DateTime.UtcNow;
        // End-to-end lag: the broker's own send timestamp vs when we took delivery. See the
        // class remarks for why this was the missing metric rather than a nice-to-have.
        public long LagMsSum, LagSamples, LagMsMax;
        public double LagMsMean;
        public long LagMsPeak;
        // Retained windows, newest last, so the endpoint can report a lag FLOOR. A single lag
        // reading cannot tell a backlog from a burst; only the minimum over a window can.
        public readonly List<Window> History = new();
    }

    /// <summary>One 10s window, kept so "is this lag draining?" is answerable.</summary>
    private readonly record struct Window(double Rate, double KbPerSec, double LagSec);

    // 10 minutes at one sample per 10s — matches SwimServer's FeedHealth so the two line up.
    private const int HistoryLen = 60;

    // 5 minutes of windows. Below this a floor has not had time to see a trough, and a bursty
    // feed is indistinguishable from a pinned one.
    private const int FloorMinSamples = 30;

    private static readonly ConcurrentDictionary<string, Counters> _svcs =
        new(StringComparer.OrdinalIgnoreCase);
    private static readonly DateTime _started = DateTime.UtcNow;
    private static Timer? _timer;
    private static long _reconnects;

    public static void Start() => _timer ??= new Timer(_ => Sample(), null, 10_000, 10_000);
    public static void NoteReconnect() => Interlocked.Increment(ref _reconnects);

    /// <summary>
    /// Count one delivered message. <paramref name="serviceType"/> is the inferred STDDS
    /// sub-service; "TOTAL" is maintained alongside it so the rolled-up rate is directly
    /// comparable with the single "STDDS" bucket SwimServer reports.
    /// </summary>
    public static void Note(string serviceType, IMessage msg, int bytes)
    {
        bool discarded = false;
        try { discarded = msg.DiscardIndication; } catch { /* not all message types expose it */ }
        // The broker stamps SCDS messages; this is the same source SwimServer's FeedHealth uses
        // for its STDDS bucket, so the two numbers are directly comparable.
        long lagMs = -1;
        try
        {
            var st = msg.SenderTimestamp;
            if (st > 0) lagMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - st;
        }
        catch { /* publisher did not set it */ }
        Bump("TOTAL", bytes, discarded, lagMs);
        Bump(string.IsNullOrEmpty(serviceType) ? "UNKNOWN" : serviceType, bytes, discarded, lagMs);
    }

    private static void Bump(string key, int bytes, bool discarded, long lagMs)
    {
        var c = _svcs.GetOrAdd(key, _ => new Counters());
        Interlocked.Increment(ref c.Msgs);
        if (bytes > 0) Interlocked.Add(ref c.Bytes, bytes);
        Interlocked.Exchange(ref c.LastMsgTicks, DateTime.UtcNow.Ticks);
        // Clock skew or a malformed stamp would otherwise poison the mean.
        if (lagMs >= -5_000 && lagMs <= 6 * 3600_000)
        {
            Interlocked.Add(ref c.LagMsSum, lagMs);
            Interlocked.Increment(ref c.LagSamples);
            long seen;
            while (lagMs > (seen = Interlocked.Read(ref c.LagMsMax)))
                if (Interlocked.CompareExchange(ref c.LagMsMax, lagMs, seen) == seen) break;
        }
        if (discarded)
        {
            Interlocked.Increment(ref c.Discards);
            Interlocked.Exchange(ref c.LastDiscardTicks, DateTime.UtcNow.Ticks);
        }
    }

    private static void Sample()
    {
        var now = DateTime.UtcNow;
        foreach (var c in _svcs.Values)
        {
            var elapsed = (now - c.WindowStart).TotalSeconds;
            if (elapsed <= 0) continue;
            var msgs = Interlocked.Read(ref c.Msgs);
            var bytes = Interlocked.Read(ref c.Bytes);
            c.RateMsgs = (msgs - c.PrevMsgs) / elapsed;
            c.RateBytes = (bytes - c.PrevBytes) / elapsed;
            // Mean over the window then reset. A running mean since startup would hide a lag
            // that is growing right now, which is the whole point of the metric.
            var n = Interlocked.Exchange(ref c.LagSamples, 0);
            var sum = Interlocked.Exchange(ref c.LagMsSum, 0);
            c.LagMsMean = n > 0 ? (double)sum / n : double.NaN;
            c.LagMsPeak = Interlocked.Exchange(ref c.LagMsMax, 0);
            c.PrevMsgs = msgs;
            c.PrevBytes = bytes;
            c.WindowStart = now;
            lock (c.History)
            {
                c.History.Add(new Window(
                    Math.Round(c.RateMsgs, 1),
                    Math.Round(c.RateBytes / 1024.0, 1),
                    double.IsNaN(c.LagMsMean) ? -1 : Math.Round(c.LagMsMean / 1000.0, 1)));
                if (c.History.Count > HistoryLen) c.History.RemoveRange(0, c.History.Count - HistoryLen);
            }
        }
    }

    /// <summary>
    /// Lowest mean lag over the retained window, plus how many windows it came from.
    ///
    /// <para>The floor is the number that matters. A feed keeping up in bursts sawtooths and its
    /// floor touches ~0; a queue pinned at a ceiling never drains, so its floor stays high. The
    /// two are identical in a snapshot and have opposite answers — SFDPS sat at a flat 60 s floor
    /// for hours and read as upstream latency until the floor was looked at.</para>
    /// </summary>
    private static (double? floor, int samples) LagFloor(Counters c)
    {
        lock (c.History)
        {
            double? min = null;
            var n = 0;
            foreach (var h in c.History)
            {
                if (h.LagSec < 0) continue;   // no lag samples in that window
                n++;
                if (min is null || h.LagSec < min) min = h.LagSec;
            }
            return (min, n);
        }
    }

    /// <summary>
    /// Snapshot for the service's <c>/feed</c> endpoint. <paramref name="inboundDropped"/> is
    /// the host service's own drop-oldest counter — loss we cause, which has to be separable
    /// from loss the broker causes if "where did the data go" is to be answerable.
    /// </summary>
    public static object Snapshot(long inboundDropped, bool connected, string? queue, int flows = 1) => new
    {
        service = "STDDS",
        host = Environment.MachineName,
        connected,
        queue,
        // Receivers this service binds (SCDS_FLOWS). Shown beside the lag because the answer to
        // a lag floor that never drains is almost always a higher flow count, and this service
        // ran on a single hardcoded flow while being the queue's largest consumer.
        flows,
        reconnects = Interlocked.Read(ref _reconnects),
        // Our own bounded channel discarding because the parse loop fell behind. Distinct from
        // the broker's discards below: this one is entirely on us and is fixable here.
        inboundDropped,
        uptimeSec = (int)(DateTime.UtcNow - _started).TotalSeconds,
        services = _svcs
            .OrderBy(kv => kv.Key == "TOTAL" ? 0 : 1)
            .ThenBy(kv => kv.Key, StringComparer.Ordinal)
            .Select(kv =>
            {
                var c = kv.Value;
                var lastMsg = Interlocked.Read(ref c.LastMsgTicks);
                var lastDiscard = Interlocked.Read(ref c.LastDiscardTicks);
                var up = (DateTime.UtcNow - _started).TotalSeconds;
                var (floor, floorSamples) = LagFloor(c);
                return (object)new
                {
                    feed = kv.Key,
                    msgs = Interlocked.Read(ref c.Msgs),
                    msgsPerSec = Math.Round(c.RateMsgs, 1),
                    avgMsgsPerSec = up > 1 ? Math.Round(Interlocked.Read(ref c.Msgs) / up, 1) : 0,
                    kbPerSec = Math.Round(c.RateBytes / 1024.0, 1),
                    avgMsgBytes = Interlocked.Read(ref c.Msgs) > 0
                        ? (int)(Interlocked.Read(ref c.Bytes) / Interlocked.Read(ref c.Msgs)) : 0,
                    lastMsgAgeSec = lastMsg == 0 ? (double?)null
                        : Math.Round((DateTime.UtcNow - new DateTime(lastMsg, DateTimeKind.Utc)).TotalSeconds, 1),
                    // Authoritative: Solace sets DiscardIndication on the next message after it
                    // has thrown some away.
                    discardEvents = Interlocked.Read(ref c.Discards),
                    lastDiscard = lastDiscard == 0 ? null
                        : new DateTime(lastDiscard, DateTimeKind.Utc).ToString("o"),
                    // How far behind the broker's own send time we are, this window.
                    lagSec = double.IsNaN(c.LagMsMean) ? (double?)null : Math.Round(c.LagMsMean / 1000.0, 1),
                    lagPeakSec = c.LagMsPeak == 0 ? (double?)null : Math.Round(c.LagMsPeak / 1000.0, 1),
                    // The one to read: floor ~0 means the lag drains between bursts, floor close
                    // to lagSec means it never does. Meaningless until floorSamples is up.
                    lagFloorSec = floor,
                    floorSamples,
                    floorSettled = floorSamples >= FloorMinSamples,
                };
            })
            .ToArray(),
    };
}
