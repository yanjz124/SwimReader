using System.Runtime.CompilerServices;
using System.Threading.Channels;
using Microsoft.Extensions.Logging;
using SwimReader.Core.Events;

namespace SwimReader.Core.Bus;

/// <summary>
/// Channel-based pub/sub event bus. Each subscriber gets a bounded channel.
/// When a subscriber falls behind, oldest messages are dropped (backpressure).
/// Uses volatile snapshot for lock-free publish path.
/// </summary>
public sealed class ChannelEventBus : IEventBus
{
    private readonly ILogger<ChannelEventBus> _logger;
    private readonly object _subLock = new();
    private readonly int _capacity;

    // Volatile snapshot: publish reads this without locking.
    // Subscribe/unsubscribe replaces the entire array under _subLock.
    private volatile Subscriber[] _snapshot = [];

    public ChannelEventBus(ILogger<ChannelEventBus> logger, int capacity = 10_000)
    {
        _logger = logger;
        _capacity = capacity;
    }

    public ValueTask PublishAsync(ISwimEvent swimEvent, CancellationToken ct = default)
    {
        // Lock-free read of subscriber snapshot
        var subs = _snapshot;

        foreach (var sub in subs)
        {
            if (!sub.Channel.Writer.TryWrite(swimEvent))
            {
                // Channel full — drop oldest by reading one and re-trying
                if (sub.Channel.Reader.TryRead(out _))
                {
                    sub.Channel.Writer.TryWrite(swimEvent);
                    _logger.LogWarning("Subscriber {Name} fell behind, dropped oldest event", sub.Name);
                }
            }
        }

        return ValueTask.CompletedTask;
    }

    public async IAsyncEnumerable<ISwimEvent> SubscribeAsync(
        string subscriberName,
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        var channel = Channel.CreateBounded<ISwimEvent>(new BoundedChannelOptions(_capacity)
        {
            FullMode = BoundedChannelFullMode.DropOldest,
            SingleReader = true,
            SingleWriter = false
        });

        var subscriber = new Subscriber(subscriberName, channel);

        lock (_subLock)
        {
            _snapshot = [.. _snapshot, subscriber];
        }

        _logger.LogInformation("Subscriber {Name} connected to event bus", subscriberName);

        try
        {
            await foreach (var evt in channel.Reader.ReadAllAsync(ct))
            {
                yield return evt;
            }
        }
        finally
        {
            lock (_subLock)
            {
                _snapshot = _snapshot.Where(s => s != subscriber).ToArray();
            }

            _logger.LogInformation("Subscriber {Name} disconnected from event bus", subscriberName);
        }
    }

    private sealed record Subscriber(string Name, Channel<ISwimEvent> Channel);
}
