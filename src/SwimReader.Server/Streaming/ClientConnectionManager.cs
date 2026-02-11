using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Threading.Channels;
using Microsoft.Extensions.Logging;

namespace SwimReader.Server.Streaming;

/// <summary>
/// Manages connected DGScope clients (both HTTP streaming and WebSocket).
/// Each client gets a bounded Channel for backpressure-safe delivery.
/// The controller's request thread reads from the channel and writes to the response.
/// </summary>
public sealed class ClientConnectionManager
{
    private readonly ConcurrentDictionary<string, ClientChannel> _clients = new();
    private readonly ILogger<ClientConnectionManager> _logger;

    public ClientConnectionManager(ILogger<ClientConnectionManager> logger)
    {
        _logger = logger;
    }

    public int ClientCount => _clients.Count;

    /// <summary>
    /// Register a new client and return its channel for reading.
    /// </summary>
    public ClientChannel AddClient(string clientId, string facility)
    {
        var client = new ClientChannel(clientId, facility);
        _clients.TryAdd(clientId, client);
        _logger.LogInformation("Client {Id} connected for facility {Facility}", clientId, facility);
        return client;
    }

    /// <summary>
    /// Remove a disconnected client.
    /// </summary>
    public void RemoveClient(string clientId)
    {
        if (_clients.TryRemove(clientId, out var client))
        {
            client.Complete();
            _logger.LogInformation("Client {Id} disconnected", clientId);
        }
    }

    /// <summary>
    /// Broadcast a JSON line to all connected clients via their channels.
    /// Non-blocking: if a client's channel is full, the oldest message is dropped.
    /// </summary>
    public void Broadcast(string jsonLine)
    {
        foreach (var kvp in _clients)
        {
            kvp.Value.TryWrite(jsonLine);
        }
    }

    /// <summary>
    /// Broadcast a JSON line only to clients subscribed to the given facility.
    /// If facility is null, broadcasts to all clients.
    /// </summary>
    public void Broadcast(string jsonLine, string? facility)
    {
        if (facility is null)
        {
            Broadcast(jsonLine);
            return;
        }

        foreach (var kvp in _clients)
        {
            if (string.Equals(kvp.Value.Facility, facility, StringComparison.OrdinalIgnoreCase))
            {
                kvp.Value.TryWrite(jsonLine);
            }
        }
    }
}

/// <summary>
/// Per-client bounded channel for delivering JSON updates.
/// </summary>
public sealed class ClientChannel
{
    private readonly Channel<string> _channel;

    public string Id { get; }
    public string Facility { get; }

    public ClientChannel(string id, string facility, int capacity = 5000)
    {
        Id = id;
        Facility = facility;
        _channel = Channel.CreateBounded<string>(new BoundedChannelOptions(capacity)
        {
            FullMode = BoundedChannelFullMode.DropOldest,
            SingleReader = true,
            SingleWriter = false
        });
    }

    public bool TryWrite(string jsonLine) => _channel.Writer.TryWrite(jsonLine);

    public void Complete() => _channel.Writer.TryComplete();

    public IAsyncEnumerable<string> ReadAllAsync(CancellationToken ct)
        => _channel.Reader.ReadAllAsync(ct);
}
