using SwimReader.Core.Events;

namespace SwimReader.Core.Bus;

/// <summary>
/// Publish/subscribe event bus for SWIM events.
/// Producers publish events; multiple consumers can subscribe independently.
/// </summary>
public interface IEventBus
{
    /// <summary>
    /// Publish an event to all subscribers.
    /// </summary>
    ValueTask PublishAsync(ISwimEvent swimEvent, CancellationToken ct = default);

    /// <summary>
    /// Subscribe and receive events. Each subscriber gets its own independent stream.
    /// </summary>
    IAsyncEnumerable<ISwimEvent> SubscribeAsync(string subscriberName, CancellationToken ct = default);
}
