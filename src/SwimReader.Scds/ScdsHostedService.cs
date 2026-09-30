using System.Text;
using System.Threading.Channels;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using SolaceSystems.Solclient.Messaging;
using SwimReader.Core.Bus;
using SwimReader.Core.Events;
using SwimReader.Scds.Configuration;
using SwimReader.Scds.Connection;

namespace SwimReader.Scds;

/// <summary>
/// Background service that maintains SCDS connection, receives Solace messages,
/// and dispatches them as RawMessageEvents onto the event bus.
/// Uses an internal Channel to decouple the Solace callback from processing,
/// ensuring the callback returns immediately for maximum throughput.
/// </summary>
public sealed class ScdsHostedService : BackgroundService
{
    private readonly ScdsConnectionManager _connectionManager;
    private readonly IEventBus _eventBus;
    private readonly ScdsConnectionOptions _options;
    private readonly ILogger<ScdsHostedService> _logger;

    /// <summary>
    /// Internal buffer for raw messages extracted from Solace callbacks.
    /// The callback writes (topic, body) tuples; the processing loop reads them.
    /// </summary>
    /// <summary>Raw messages dropped because the parse loop fell behind — real data loss.</summary>
    private long _inboundDropped;

    private readonly Channel<(string topic, string body)> _inbound;

    /// <summary>Count of inbound messages discarded by the buffer since start.</summary>
    public long InboundDropped => Interlocked.Read(ref _inboundDropped);

    private Channel<(string topic, string body)> BuildInbound() =>
        // DropOldest stops a slow parse loop from blocking the Solace callback thread, but it
        // silently throws messages away. Count them so "the feed looks thin" is answerable.
        Channel.CreateBounded<(string, string)>(new BoundedChannelOptions(50_000)
        {
            FullMode = BoundedChannelFullMode.DropOldest,
            SingleReader = true,
            SingleWriter = false
        }, _ =>
        {
            var n = Interlocked.Increment(ref _inboundDropped);
            if (n == 1 || n % 10_000 == 0)
                _logger.LogError("SCDS inbound buffer overflow: {Dropped} raw messages dropped — " +
                                 "the parse loop is not keeping up, data is being lost", n);
        });

    public ScdsHostedService(
        ScdsConnectionManager connectionManager,
        IEventBus eventBus,
        IOptions<ScdsConnectionOptions> options,
        ILogger<ScdsHostedService> logger)
    {
        _connectionManager = connectionManager;
        _eventBus = eventBus;
        _options = options.Value;
        _logger = logger;
        _inbound = BuildInbound();   // after _logger: the drop callback reports through it
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Only the host named by SWIM_FEED_HOST may bind the shared SCDS queue. A Solace queue
        // delivers each message to ONE consumer, so a second instance splits the deployed
        // server's feed instead of duplicating it — measured on the Pi, per-flight refresh went
        // 9.6s to 16.1s and coasting tracks 13% to 31%. Same rule and same env vars as
        // tools/SwimServer/Services/FeedGuard.cs, which carries the full rationale.
        // Unset = no guard (old behavior); SWIM_ALLOW_SHARED_QUEUE=1 overrides.
        var feedHost = (Environment.GetEnvironmentVariable("SWIM_FEED_HOST") ?? "").Trim();
        var allowShared = (Environment.GetEnvironmentVariable("SWIM_ALLOW_SHARED_QUEUE") ?? "").Trim();
        if (feedHost.Length > 0
            && !string.Equals(feedHost, Environment.MachineName, StringComparison.OrdinalIgnoreCase)
            && allowShared is not ("1" or "true" or "TRUE" or "yes"))
        {
            _logger.LogWarning(
                "SCDS feed NOT started: this host is '{Here}' but the SWIM feed belongs to '{Owner}'. " +
                "Binding the same queue here would split the deployed server's feed. " +
                "Set SWIM_ALLOW_SHARED_QUEUE=1 to override.",
                Environment.MachineName, feedHost);
            return;
        }

        _logger.LogInformation("SCDS hosted service starting");

        // Start the processing loop that drains the inbound channel
        _ = ProcessLoopAsync(stoppingToken);

        while (!stoppingToken.IsCancellationRequested)
        {
            IFlow? flow = null;
            try
            {
                _connectionManager.Connect();

                flow = _connectionManager.CreateQueueFlow(
                    (_, args) => HandleMessage(args),
                    (_, args) => HandleFlowEvent(args));

                _logger.LogInformation("Listening for SCDS messages on queue {Queue}", _options.QueueName);

                // Block until cancellation — messages arrive via callback
                await Task.Delay(Timeout.Infinite, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "SCDS connection error, reconnecting in {Delay}s",
                    _options.ReconnectDelay.TotalSeconds);

                if (flow is not null)
                {
                    try { flow.Dispose(); } catch { /* best effort */ }
                }

                _connectionManager.Disconnect();

                await Task.Delay(_options.ReconnectDelay, stoppingToken);
            }
        }

        _logger.LogInformation("SCDS hosted service stopped");
    }

    /// <summary>
    /// Solace callback — extract body and topic, queue for processing, return immediately.
    /// </summary>
    private void HandleMessage(MessageEventArgs args)
    {
        try
        {
            using var message = args.Message;
            var body = ExtractBody(message);
            if (body is null) return;

            var topic = message.Destination?.Name ?? "unknown";

            // Non-blocking write to channel; drops oldest if full
            _inbound.Writer.TryWrite((topic, body));
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error extracting SCDS message");
        }
    }

    /// <summary>
    /// Background loop that drains the inbound channel and publishes to the event bus.
    /// </summary>
    private async Task ProcessLoopAsync(CancellationToken ct)
    {
        await foreach (var (topic, body) in _inbound.Reader.ReadAllAsync(ct))
        {
            try
            {
                var serviceType = InferServiceType(topic);

                var rawEvent = new RawMessageEvent
                {
                    Timestamp = DateTime.UtcNow,
                    Source = "SCDS",
                    Topic = topic,
                    XmlContent = body,
                    ServiceType = serviceType
                };

                _ = _eventBus.PublishAsync(rawEvent);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error processing SCDS message");
            }
        }
    }

    private void HandleFlowEvent(FlowEventArgs args)
    {
        _logger.LogInformation("Flow event: {Event} - {Info}", args.Event, args.Info);
    }

    private static string? ExtractBody(IMessage message)
    {
        // Solace messages can carry data as binary attachment or XML content
        if (message.BinaryAttachment is { Length: > 0 })
        {
            return Encoding.UTF8.GetString(message.BinaryAttachment);
        }

        var xmlContent = message.XmlContent;
        if (xmlContent is { Length: > 0 })
        {
            return Encoding.UTF8.GetString(xmlContent);
        }

        return null;
    }

    private static string InferServiceType(string topic)
    {
        var upper = topic.ToUpperInvariant();
        if (upper.Contains("TAIS")) return "TAIS";
        if (upper.Contains("TDES")) return "TDES";
        if (upper.Contains("SMES")) return "SMES";
        if (upper.Contains("APDS")) return "APDS";
        if (upper.Contains("ISMC")) return "ISMC";
        return "UNKNOWN";
    }
}
