using System.Text;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using SolaceSystems.Solclient.Messaging;
using SwimReader.Scds.Configuration;

namespace SwimReader.Scds.Connection;

/// <summary>
/// Manages the Solace SMF connection to FAA SCDS over TLS.
/// Handles connection lifecycle, authentication, and flow-based message consumption.
/// </summary>
public sealed class ScdsConnectionManager : IDisposable
{
    private readonly ScdsConnectionOptions _options;
    private readonly ILogger<ScdsConnectionManager> _logger;
    private IContext? _context;
    private ISession? _session;
    private bool _initialized;

    public ScdsConnectionManager(
        IOptions<ScdsConnectionOptions> options,
        ILogger<ScdsConnectionManager> logger)
    {
        _options = options.Value;
        _logger = logger;
    }

    public bool IsConnected => _session is not null;

    /// <summary>
    /// Initialize the Solace context factory (call once at startup).
    /// </summary>
    public void InitializeSolace()
    {
        if (_initialized) return;

        var cfp = new ContextFactoryProperties
        {
            SolClientLogLevel = SolLogLevel.Warning
        };
        cfp.LogToConsoleError();
        ContextFactory.Instance.Init(cfp);
        _initialized = true;

        _logger.LogInformation("Solace context factory initialized");
    }

    /// <summary>
    /// Establish Solace SMF connection to SCDS over TLS.
    /// </summary>
    public void Connect()
    {
        InitializeSolace();

        _logger.LogInformation("Connecting to SCDS at {Host} as {User}@{Vpn}",
            _options.Host, _options.Username, _options.MessageVpn);

        _context = ContextFactory.Instance.CreateContext(new ContextProperties(), null);

        var sessionProps = new SessionProperties
        {
            Host = _options.Host,
            VPNName = _options.MessageVpn,
            UserName = _options.Username,
            Password = _options.Password,
            ReconnectRetries = _options.MaxReconnectAttempts == 0 ? -1 : _options.MaxReconnectAttempts,
            ReconnectRetriesWaitInMsecs = (int)_options.ReconnectDelay.TotalMilliseconds,
            SSLValidateCertificate = false // Accept SCDS certificates
        };

        _session = _context.CreateSession(sessionProps,
            HandleSessionMessage,
            HandleSessionEvent);

        var returnCode = _session.Connect();
        if (returnCode != ReturnCode.SOLCLIENT_OK)
        {
            throw new InvalidOperationException($"Solace connection failed: {returnCode}");
        }

        _logger.LogInformation("Connected to SCDS successfully");
    }

    /// <summary>
    /// Create a flow to consume messages from the configured queue.
    /// </summary>
    public IFlow CreateQueueFlow(
        EventHandler<MessageEventArgs> messageHandler,
        EventHandler<FlowEventArgs> flowEventHandler)
    {
        if (_session is null)
            throw new InvalidOperationException("Not connected. Call Connect first.");

        var queue = ContextFactory.Instance.CreateQueue(_options.QueueName);

        var flowProps = new FlowProperties
        {
            AckMode = MessageAckMode.ClientAck
        };

        var flow = _session.CreateFlow(flowProps, queue, null, messageHandler, flowEventHandler);
        flow.Start();

        _logger.LogInformation("Created flow on queue {Queue}", _options.QueueName);
        return flow;
    }

    private void HandleSessionMessage(object? sender, MessageEventArgs args)
    {
        // Session-level messages (not from flows) — typically not used with queue flows
        _logger.LogDebug("Session message received (non-flow)");
    }

    private void HandleSessionEvent(object? sender, SessionEventArgs args)
    {
        _logger.LogInformation("Session event: {Event} - {Info}",
            args.Event, args.Info);
    }

    public void Disconnect()
    {
        if (_session is not null)
        {
            try { _session.Disconnect(); } catch { /* best effort */ }
            try { _session.Dispose(); } catch { /* best effort */ }
            _session = null;
        }

        if (_context is not null)
        {
            try { _context.Dispose(); } catch { /* best effort */ }
            _context = null;
        }

        _logger.LogInformation("SCDS connection disconnected");
    }

    public void Dispose()
    {
        Disconnect();
        if (_initialized)
        {
            try { ContextFactory.Instance.Cleanup(); } catch { /* best effort */ }
            _initialized = false;
        }
    }
}
