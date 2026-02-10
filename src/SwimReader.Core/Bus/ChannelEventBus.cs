using System.Runtime.CompilerServices;
using System.Threading.Channels;
using Microsoft.Extensions.Logging;
using SwimReader.Core.Events;

namespace SwimReader.Core.Bus;

/// <summary>
/// Channel-based pub/sub event bus. Each subscriber gets a bounded channel.
/// When a subscriber falls behind, oldest messages are dropped (backpressure).
/// </summary>
public sealed class ChannelEventBus : IEventBus
{
    private readonly ILogger<ChannelEventBus> _logger;
    private readonly List<Subscriber> _subscribers = [];
    private readonly object _lock = new();
    private readonly int _capacity;

    public ChannelEventBus(ILogger<ChannelEventBus> logger, int capacity = 10_000)
    {
        _logger = logger;
        _capacity = capacity;
    }

    public ValueTask PublishAsync(ISwimEvent swimEvent, CancellationToken ct = default)
    {
        lock (_lock)
        {
            // Remove dead subscribers
            _subscribers.RemoveAll(s => s.Channel.Reader.Completion.IsCompleted);

            foreach (var sub in _subscribers)
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

        lock (_lock)
        {
            _subscribers.Add(subscriber);
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
            lock (_lock)
            {
                _subscribers.Remove(subscriber);
            }

            _logger.LogInformation("Subscriber {Name} disconnected from event bus", subscriberName);
        }
    }

    private sealed record Subscriber(string Name, Channel<ISwimEvent> Channel);
}
