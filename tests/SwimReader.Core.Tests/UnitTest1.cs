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

        // Give subscriber time to register
        await Task.Delay(100);

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

        await Task.Delay(100);

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
}
