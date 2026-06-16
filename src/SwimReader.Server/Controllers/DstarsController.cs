using System.Text;
using Microsoft.AspNetCore.Mvc;
using SwimReader.Server.Adapters;
using SwimReader.Server.Streaming;

namespace SwimReader.Server.Controllers;

/// <summary>
/// Implements the Dstars ScopeServer protocol endpoint.
/// DGScope connects to GET /dstars/{facility}/updates for streaming JSON updates.
/// Supports both HTTP streaming and WebSocket upgrade.
/// </summary>
[ApiController]
[Route("dstars")]
public sealed class DstarsController : ControllerBase
{
    private readonly ClientConnectionManager _clients;
    private readonly ILogger<DstarsController> _logger;
    private readonly DgScopeAdapter _adapter;

    public DstarsController(ClientConnectionManager clients, ILogger<DstarsController> logger,
        DgScopeAdapter adapter)
    {
        _clients = clients;
        _logger = logger;
        _adapter = adapter;
    }

    /// <summary>
    /// Streaming endpoint for DGScope clients.
    /// GET /dstars/{facility}/updates — streams newline-delimited JSON
    /// WS  /dstars/{facility}/updates — WebSocket with same format
    /// </summary>
    [HttpGet("{facility}/updates")]
    public async Task GetUpdates(string facility, CancellationToken ct)
    {
        var clientId = Guid.NewGuid().ToString("N");
        var client = _clients.AddClient(clientId, facility);

        // Seed the new client's channel with the adapter's current snapshot
        // (FPs first, then Tracks - so callsigns are present before symbols
        // render). This means a freshly-loaded scope sees the full state on
        // connect instead of waiting for the next sweep / TAIS batch.
        int seedCount = 0;
        foreach (var jsonLine in _adapter.GetSnapshot(facility))
        {
            client.TryWrite(jsonLine);
            seedCount++;
        }
        if (seedCount > 0)
            _logger.LogInformation("Seeded client {Id} with {N} snapshot updates", clientId, seedCount);

        if (HttpContext.WebSockets.IsWebSocketRequest)
        {
            var ws = await HttpContext.WebSockets.AcceptWebSocketAsync();

            _logger.LogInformation("WebSocket client {Id} streaming for facility {Facility}",
                clientId, facility);

            try
            {
                // Start a background task to read (and discard) incoming WS frames
                // so we detect client disconnect
                var receiveTask = Task.Run(async () =>
                {
                    var buffer = new byte[256];
                    try
                    {
                        while (ws.State == System.Net.WebSockets.WebSocketState.Open && !ct.IsCancellationRequested)
                        {
                            var result = await ws.ReceiveAsync(buffer, ct);
                            if (result.MessageType == System.Net.WebSockets.WebSocketMessageType.Close)
                                break;
                        }
                    }
                    catch { }
                }, ct);

                // Read from channel and send to WebSocket
                await foreach (var jsonLine in client.ReadAllAsync(ct))
                {
                    if (ws.State != System.Net.WebSockets.WebSocketState.Open)
                        break;

                    var bytes = Encoding.UTF8.GetBytes(jsonLine + "\n");
                    await ws.SendAsync(bytes, System.Net.WebSockets.WebSocketMessageType.Text, true, ct);
                }
            }
            catch (OperationCanceledException) { }
            catch (Exception ex)
            {
                _logger.LogDebug(ex, "WebSocket client {Id} error", clientId);
            }
            finally
            {
                _clients.RemoveClient(clientId);
                if (ws.State == System.Net.WebSockets.WebSocketState.Open)
                {
                    try
                    {
                        await ws.CloseAsync(
                            System.Net.WebSockets.WebSocketCloseStatus.NormalClosure,
                            "Server closing", CancellationToken.None);
                    }
                    catch { }
                }
            }
        }
        else
        {
            // HTTP streaming response (newline-delimited JSON)
            Response.ContentType = "application/json";

            await Response.StartAsync(ct);

            _logger.LogInformation("HTTP stream client {Id} streaming for facility {Facility}",
                clientId, facility);

            try
            {
                // Read from channel and write to response body on the request thread
                await foreach (var jsonLine in client.ReadAllAsync(ct))
                {
                    var bytes = Encoding.UTF8.GetBytes(jsonLine + "\n");
                    await Response.Body.WriteAsync(bytes, ct);
                    await Response.Body.FlushAsync(ct);
                }
            }
            catch (OperationCanceledException) { }
            catch (Exception ex)
            {
                _logger.LogDebug(ex, "HTTP stream client {Id} error", clientId);
            }
            finally
            {
                _clients.RemoveClient(clientId);
            }
        }
    }
}
