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
    }

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
        Bump("TOTAL", bytes, discarded);
        Bump(string.IsNullOrEmpty(serviceType) ? "UNKNOWN" : serviceType, bytes, discarded);
    }

    private static void Bump(string key, int bytes, bool discarded)
    {
        var c = _svcs.GetOrAdd(key, _ => new Counters());
        Interlocked.Increment(ref c.Msgs);
        if (bytes > 0) Interlocked.Add(ref c.Bytes, bytes);
        Interlocked.Exchange(ref c.LastMsgTicks, DateTime.UtcNow.Ticks);
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
            c.PrevMsgs = msgs;
            c.PrevBytes = bytes;
            c.WindowStart = now;
        }
    }

    /// <summary>
    /// Snapshot for the service's <c>/feed</c> endpoint. <paramref name="inboundDropped"/> is
    /// the host service's own drop-oldest counter — loss we cause, which has to be separable
    /// from loss the broker causes if "where did the data go" is to be answerable.
    /// </summary>
    public static object Snapshot(long inboundDropped, bool connected, string? queue) => new
    {
        service = "STDDS",
        host = Environment.MachineName,
        connected,
        queue,
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
                };
            })
            .ToArray(),
    };
}
