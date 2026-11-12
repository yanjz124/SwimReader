using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;

namespace SwimServer;

/// <summary>
/// The socket layer behind the NAS map: a registry of connected clients, each with its own
/// <see cref="NasView"/>, broadcast once per fusion pass.
///
/// <para><b>Why a full snapshot per tick is not an option.</b> Measured on the live midday feed,
/// the whole fused picture is <b>690 kB raw and ~96 kB deflated</b> at ~17,500 targets. At a 2 s
/// cadence that is ~48 kB/s per client of which almost nothing has changed — and this repo
/// already learned from the ERAM scope that a large repeated payload is what makes a page feel
/// broken (its opening snapshot was 17.6 MB before <c>historyMax</c> and deflate). So each client
/// declares a viewport and receives only what is inside it, and of that only what moved.</para>
///
/// <para>All the decisions live in <see cref="NasView"/>, which is testable without a socket.
/// This class is deliberately thin: register, hand a received command to the view, serialize what
/// the view returns.</para>
/// </summary>
class NasStream
{
    public const int DefaultCap = NasView.DefaultCap;
    public const int MaxCap = NasView.MaxCap;

    private readonly NasFusion _fusion;
    private readonly ConcurrentDictionary<string, (WsClient Ws, NasView View)> _clients = new();

    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
    };

    public NasStream(NasFusion fusion) => _fusion = fusion;

    public int ClientCount => _clients.Count;

    public string AddClient(WsClient ws)
    {
        var id = Guid.NewGuid().ToString("N");
        _clients[id] = (ws, new NasView());
        return id;
    }

    public void RemoveClient(string id) => _clients.TryRemove(id, out _);

    /// <summary>Hand a received <c>{cmd:"view", ...}</c> to that client's view.</summary>
    public bool SetView(string clientId, string json) =>
        _clients.TryGetValue(clientId, out var c) && c.View.Apply(json);

    /// <summary>
    /// One tick. Called on the fusion timer, immediately after the pass, so every client diffs
    /// against the snapshot that was just built rather than one a tick old.
    /// </summary>
    public void Tick()
    {
        if (_clients.IsEmpty) return;
        var snap = _fusion.Snapshot();
        if (snap.Built == DateTime.MinValue) return;

        foreach (var (id, c) in _clients)
        {
            try
            {
                var payload = c.View.Compute(snap);
                if (payload is null) continue;
                c.Ws.Enqueue(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(payload, Json)));
            }
            catch (Exception ex)
            {
                // One client's failure must not stop the broadcast to the others.
                Console.WriteLine($"[NAS-WS] client {id[..8]}: {ex.Message}");
            }
        }
    }
}
