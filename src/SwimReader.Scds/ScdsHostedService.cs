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
    private readonly IOptions<ScdsConnectionOptions> _optionsAccessor;
    private readonly ILoggerFactory _loggerFactory;
    private int _connectedFlows;

    /// <summary>
    /// Receivers to bind to the queue, from SCDS_FLOWS (1-8, default 1).
    ///
    /// This service had no flow support at all while the other five bridges had had it for
    /// months, and it is the LARGEST consumer of the STDDS queue — measured at ~525 msg/s
    /// against SwimServer's ~74. A Solace queue is competing-consumers, so N flows drain it N
    /// times faster with no duplication; one session also has a hard transport ceiling, because
    /// SCDS mandates compression and a compressed session is a single serial stream. With one
    /// flow here and one in SwimServer, a queue needing ~600 msg/s was being drained by two
    /// sessions and both sat at a lag floor that never reached zero.
    ///
    /// Each receiver needs its own context (a context owns one dispatch thread) and therefore
    /// its own session and ScdsConnectionManager. Processing is untouched: every flow writes
    /// into the same bounded channel, which is already SingleWriter=false, and one loop drains
    /// it — so only the transport is parallel, which is the only part that was the bottleneck.
    /// </summary>
    private int Receivers()
    {
        var raw = Environment.GetEnvironmentVariable("SCDS_FLOWS");
        return int.TryParse(raw, out var v) ? Math.Clamp(v, 1, 8) : 1;
    }

    /// <summary>
    /// Internal buffer for raw messages extracted from Solace callbacks.
    /// The callback writes (topic, body) tuples; the processing loop reads them.
    /// </summary>
    /// <summary>Raw messages dropped because the parse loop fell behind — real data loss.</summary>
    private long _inboundDropped;

    private readonly Channel<(string topic, string body)> _inbound;

    /// <summary>Count of inbound messages discarded by the buffer since start.</summary>
    public long InboundDropped => Interlocked.Read(ref _inboundDropped);

    /// <summary>Whether ANY of this service's flows is currently bound. Surfaced by GET /feed.</summary>
    public bool Connected => Volatile.Read(ref _connectedFlows) > 0;

    /// <summary>Receivers bound to the queue, so GET /feed can show it beside the lag.</summary>
    public int Flows => Receivers();

    /// <summary>The queue this service binds — shown by GET /feed so a shared queue is obvious.</summary>
    public string QueueName => _options.QueueName;

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
        ILogger<ScdsHostedService> logger,
        ILoggerFactory loggerFactory)
    {
        _connectionManager = connectionManager;
        _eventBus = eventBus;
        _options = options.Value;
        _optionsAccessor = options;
        _logger = logger;
        _loggerFactory = loggerFactory;
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

        var receivers = Receivers();
        _logger.LogInformation("SCDS hosted service starting with {Receivers} receiver(s) on queue {Queue}",
            receivers, _options.QueueName);
        StddsFeedHealth.Start();

        // One drain loop for all receivers: the channel decouples transport from processing, so
        // parallelising the transport needs no change here.
        _ = ProcessLoopAsync(stoppingToken);

        // Receiver 0 uses the injected manager so DI owns its disposal as before; the rest get
        // their own, because one context = one dispatch thread = one session = one flow.
        var loops = new List<Task>(receivers);
        for (var i = 0; i < receivers; i++)
        {
            var index = i;
            var manager = index == 0
                ? _connectionManager
                : new ScdsConnectionManager(_optionsAccessor,
                    _loggerFactory.CreateLogger<ScdsConnectionManager>());
            loops.Add(Task.Run(() => ReceiveLoopAsync(manager, index, stoppingToken), stoppingToken));
        }

        try { await Task.WhenAll(loops); }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { /* shutting down */ }

        _logger.LogInformation("SCDS hosted service stopped");
    }

    /// <summary>
    /// One receiver: its own session and flow on the shared queue, with its own reconnect loop
    /// so a single dead flow is rebuilt while its siblings keep draining.
    /// </summary>
    private async Task ReceiveLoopAsync(ScdsConnectionManager manager, int index, CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            IFlow? flow = null;
            try
            {
                manager.Connect();

                flow = manager.CreateQueueFlow(
                    (_, args) => HandleMessage(args),
                    (_, args) => HandleFlowEvent(args));

                _logger.LogInformation("Receiver {Index} listening for SCDS messages on queue {Queue}",
                    index, _options.QueueName);
                Interlocked.Increment(ref _connectedFlows);

                // Block until cancellation — messages arrive via callback
                await Task.Delay(Timeout.Infinite, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "SCDS receiver {Index} connection error, reconnecting in {Delay}s",
                    index, _options.ReconnectDelay.TotalSeconds);

                if (flow is not null)
                {
                    try { flow.Dispose(); } catch { /* best effort */ }
                }

                manager.Disconnect();
                Interlocked.Decrement(ref _connectedFlows);
                StddsFeedHealth.NoteReconnect();

                await Task.Delay(_options.ReconnectDelay, stoppingToken);
            }
        }
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

            // Count it before queueing. This process had no throughput instrumentation at all,
            // which mattered more than it sounds: it shares one competing-consumers queue with
            // SwimServer, so each of them sees part of the STDDS stream and the only way to know
            // the real queue rate is to add the two together. See StddsFeedHealth.
            StddsFeedHealth.Note(InferServiceType(topic), message, body.Length);

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
