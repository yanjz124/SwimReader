using SwimReader.Core.Bus;
using SwimReader.Core.Events;
using SwimReader.Core.Models;
using Microsoft.Extensions.Logging.Abstractions;

namespace SwimReader.Core.Tests;

public class ChannelEventBusTests
{
    [Fact]
    public async Task PublishAsync_DeliversToSubscriber()
    {
        var bus = new ChannelEventBus(NullLogger<ChannelEventBus>.Instance);
        var received = new List<ISwimEvent>();

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));

        // Start subscriber in background
        var subscriberTask = Task.Run(async () =>
        {
            await foreach (var evt in bus.SubscribeAsync("test", cts.Token))
            {
                received.Add(evt);
                if (received.Count >= 2) break;
            }
        }, cts.Token);

        await WaitForSubscribers(bus, 1, cts.Token);

        // Publish events
        var event1 = new TrackPositionEvent
        {
            Timestamp = DateTime.UtcNow,
            Source = "TEST",
            Position = new GeoPosition(40.7128, -74.0060)
        };

        var event2 = new FlightPlanDataEvent
        {
            Timestamp = DateTime.UtcNow,
            Source = "TEST",
            Callsign = "TEST123"
        };

        await bus.PublishAsync(event1);
        await bus.PublishAsync(event2);

        await subscriberTask;

        Assert.Equal(2, received.Count);
        Assert.IsType<TrackPositionEvent>(received[0]);
        Assert.IsType<FlightPlanDataEvent>(received[1]);
    }

    [Fact]
    public async Task PublishAsync_MultipleSubscribers_EachGetsAllEvents()
    {
        var bus = new ChannelEventBus(NullLogger<ChannelEventBus>.Instance);
        var received1 = new List<ISwimEvent>();
        var received2 = new List<ISwimEvent>();

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));

        var sub1 = Task.Run(async () =>
        {
            await foreach (var evt in bus.SubscribeAsync("sub1", cts.Token))
            {
                received1.Add(evt);
                if (received1.Count >= 1) break;
            }
        }, cts.Token);

        var sub2 = Task.Run(async () =>
        {
            await foreach (var evt in bus.SubscribeAsync("sub2", cts.Token))
            {
                received2.Add(evt);
                if (received2.Count >= 1) break;
            }
        }, cts.Token);

        await WaitForSubscribers(bus, 2, cts.Token);

        await bus.PublishAsync(new TrackPositionEvent
        {
            Timestamp = DateTime.UtcNow,
            Source = "TEST",
            Position = new GeoPosition(40.0, -74.0)
        });

        await Task.WhenAll(sub1, sub2);

        Assert.Single(received1);
        Assert.Single(received2);
    }

    /// <summary>
    /// Wait until the bus actually has <paramref name="expected"/> subscribers attached.
    ///
    /// These tests used to sleep 100ms and publish, which is a race: SubscribeAsync is a lazy
    /// IAsyncEnumerable, so a subscriber isn't attached until its consumer starts enumerating.
    /// On a loaded CI runner the publish landed first, that subscriber received nothing, and the
    /// test sat out the full 5s cancellation before failing. Waiting on the real condition is
    /// deterministic; a longer sleep would only have made it rarer.
    /// </summary>
    private static async Task WaitForSubscribers(ChannelEventBus bus, int expected, CancellationToken ct)
    {
        while (bus.SubscriberCount < expected && !ct.IsCancellationRequested)
            await Task.Delay(5, CancellationToken.None);
        Assert.Equal(expected, bus.SubscriberCount);
    }
}
