using SolaceSystems.Solclient.Messaging;

namespace SwimServer;

/// <summary>
/// Shared Solace flow/session tuning for the SCDS feeds.
///
/// <para><b>Why this exists.</b> With the API defaults, SFDPS egress sat at ~35 msg/s against
/// ~85 msg/s of ingress, all day, every day. The SCDS portal showed the queue pinned at its
/// 5-6k limit and <b>120-170k messages expiring per sample bucket</b> — continuous, permanent
/// data loss that nothing on our side reported, because the broker drops them before delivery
/// and our handler was 95% idle the whole time.</para>
///
/// <para><b>The mechanism is acknowledgement latency, not throughput.</b> A guaranteed flow may
/// only have <c>WindowSize</c> messages in transit un-acknowledged, and that window is further
/// capped by the endpoint's own <c>max-delivered-unacked-msgs-per-flow</c>, which SCDS sets and
/// we cannot change. Under <see cref="MessageAckMode.AutoAck"/> the API acks after the callback
/// returns, but it only *flushes* those acks when either <c>AckThreshold</c> percent of the
/// window is outstanding or <c>AckTimerInMsecs</c> expires — and that timer defaults to a full
/// <b>second</b>. Below the threshold, delivery therefore settles at
/// <c>effective_window ÷ 1 s</c> however fast we consume. Our handler takes 1.4 ms; the ceiling
/// had nothing to do with us.</para>
///
/// <para>So: ack on a 50 ms timer instead of 1000 ms, and flush after 10% of the window rather
/// than 60%. Both are pure latency reductions — no message is acked that wasn't already
/// processed, so the lossless back-pressure property is unchanged. If the consumer genuinely
/// cannot keep up, the window still fills and the broker still spools for us.</para>
/// </summary>
static class SolaceTuning
{
    /// <summary>
    /// Flow settings for an SCDS queue consumer. <paramref name="ackTimerMs"/> and the window can
    /// be overridden per deployment via SWIM_ACK_TIMER_MS / SWIM_FLOW_WINDOW for A/B testing
    /// against the portal's egress graph without a rebuild.
    /// </summary>
    public static FlowProperties Flow() => new()
    {
        AckMode = MessageAckMode.AutoAck,
        // Max in-transit messages. The endpoint may cap this lower; asking for the maximum simply
        // means we are never the smaller of the two.
        WindowSize = EnvInt("SWIM_FLOW_WINDOW", 255, 1, 255),
        // Flush acks after 10% of the window rather than 60%, so a modest flow still frees
        // transit slots promptly instead of waiting for the timer.
        AckThreshold = EnvInt("SWIM_ACK_THRESHOLD", 10, 1, 75),
        // The important one: 1000 ms -> 50 ms. Valid range is 20..1500.
        AckTimerInMsecs = EnvInt("SWIM_ACK_TIMER_MS", 50, 20, 1500),
    };

    /// <summary>
    /// Socket receive buffer for an SCDS session. The default is 150 kB; SFDPS alone pushes
    /// ~2.5 MB/s of FIXM at ~30 kB a message, so give the kernel room to absorb a burst while a
    /// GC pause or a disk stall has the dispatch thread suspended.
    /// </summary>
    public static int ReceiveBufferBytes => EnvInt("SWIM_RCV_BUF_BYTES", 4 * 1024 * 1024, 1024, 64 * 1024 * 1024);

    static int EnvInt(string name, int fallback, int min, int max)
    {
        var raw = Environment.GetEnvironmentVariable(name);
        if (!int.TryParse(raw, out var v)) return fallback;
        return Math.Clamp(v, min, max);
    }
}
