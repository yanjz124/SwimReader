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

    /// <summary>True if at least one client is connected for the given facility. Lets the
    /// adapter skip per-facility work (e.g. Conflict Alert) that has no viewer.</summary>
    public bool HasClients(string facility)
    {
        foreach (var kvp in _clients)
            if (string.Equals(kvp.Value.Facility, facility, StringComparison.OrdinalIgnoreCase))
                return true;
        return false;
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

    /// <summary>Broadcast a UT=0 / UT=1 update for a specific guid. Each
    /// client records that guid so a later UT=2 for it gets delivered.</summary>
    public void BroadcastTracked(string jsonLine, string facility, Guid guid)
    {
        foreach (var kvp in _clients)
        {
            if (string.Equals(kvp.Value.Facility, facility, StringComparison.OrdinalIgnoreCase))
            {
                kvp.Value.TryWriteTracked(jsonLine, guid);
            }
        }
    }

    /// <summary>Broadcast a UT=2 deletion. Per-client filter suppresses it
    /// for clients that never saw a UT=0/UT=1 for this guid.</summary>
    public void BroadcastDeletion(string jsonLine, string facility, Guid guid)
    {
        foreach (var kvp in _clients)
        {
            if (string.Equals(kvp.Value.Facility, facility, StringComparison.OrdinalIgnoreCase))
            {
                if (kvp.Value.TryWriteDeletion(jsonLine, guid))
                    System.Threading.Interlocked.Increment(ref _deletionAccepted);
                else
                    System.Threading.Interlocked.Increment(ref _deletionRejected);
            }
        }
    }

    private long _deletionAccepted;
    private long _deletionRejected;

    /// <summary>Returns (accepted, rejected) UT=2 counts since last call and
    /// resets both. Used by a diagnostic timer to expose per-client filter
    /// effectiveness.</summary>
    public (long Accepted, long Rejected) DrainDeletionStats()
        => (System.Threading.Interlocked.Exchange(ref _deletionAccepted, 0),
            System.Threading.Interlocked.Exchange(ref _deletionRejected, 0));
}

/// <summary>
/// Per-client bounded channel for delivering JSON updates.
/// Also tracks which Guids have been delivered as UT=0 / UT=1 so that UT=2
/// deletions for never-seen Guids can be filtered. Without this, a purge
/// firing between AddClient and GetSnapshot writes a UT=2 to a client that
/// will never see the corresponding UT=0 (the purged Guid was already
/// removed from _facilityTracks before snapshot read it).
/// </summary>
public sealed class ClientChannel
{
    private readonly Channel<string> _channel;
    private readonly ConcurrentDictionary<Guid, byte> _knownGuids = new();

    public string Id { get; }
    public string Facility { get; }

    // Capacity bumped 5000 → 50000 (2026-06-26) after PCT recording showed
    // 835 phantom UT=2 in 120s — channel was DropOldest-evicting earlier
    // UT=0/UT=1 from the queue while their guids were still tracked in
    // _knownGuids, so the matching UT=2 passed the per-client filter.
    // Larger queue tolerates burstier writers without silent eviction.
    public ClientChannel(string id, string facility, int capacity = 50000)
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

    /// <summary>Untyped write — used by callers that don't carry guid context
    /// (e.g. weather updates, stats). Always enqueued.</summary>
    public bool TryWrite(string jsonLine) => _channel.Writer.TryWrite(jsonLine);

    /// <summary>Write a UT=0 / UT=1 update for <paramref name="guid"/>.
    /// Marks the guid as seen by this client so the matching UT=2 deletion
    /// (whenever it eventually fires) will be delivered.</summary>
    public bool TryWriteTracked(string jsonLine, Guid guid)
    {
        _knownGuids[guid] = 0;
        return _channel.Writer.TryWrite(jsonLine);
    }

    /// <summary>Write a UT=2 deletion. Suppressed if the client has never
    /// seen the matching UT=0/UT=1 — preventing the "phantom delete" race
    /// where a purge fires after AddClient but before GetSnapshot.</summary>
    public bool TryWriteDeletion(string jsonLine, Guid guid)
    {
        if (!_knownGuids.TryRemove(guid, out _)) return false;
        return _channel.Writer.TryWrite(jsonLine);
    }

    public void Complete() => _channel.Writer.TryComplete();

    public IAsyncEnumerable<string> ReadAllAsync(CancellationToken ct)
        => _channel.Reader.ReadAllAsync(ct);
}
