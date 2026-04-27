using System.Net.WebSockets;

namespace SwimServer;

/// <summary>
/// ERAM-related endpoints: the main /ws WebSocket (flight snapshot/batch/remove),
/// /api/event-xml/{eventIndex}/{gufi} (lazy-loaded raw FIXM XML),
/// /api/flights/{gufi} (full flight detail), and /api/stats.
///
/// The /eram clean-URL page handler lives in StaticRoutes since it's a pure file send.
/// </summary>
static class EramRoutes
{
    public static void Register(WebApplication app, ServerContext ctx)
    {
        // WebSocket — streams flight updates to browser
        app.Map("/ws", async (HttpContext c) =>
        {
            if (!c.WebSockets.IsWebSocketRequest) { c.Response.StatusCode = 400; return; }

            using var ws = await c.WebSockets.AcceptWebSocketAsync();
            var clientId = Guid.NewGuid().ToString("N");
            var client = new WsClient(ws);
            ctx.Clients[clientId] = client;

            // Background send pump — serializes all writes through a single task
            var sendTask = Task.Run(async () =>
            {
                try
                {
                    await foreach (var data in client.Queue.Reader.ReadAllAsync())
                    {
                        if (ws.State != WebSocketState.Open) break;
                        await ws.SendAsync(data, WebSocketMessageType.Text, true, CancellationToken.None);
                    }
                }
                catch (WebSocketException) { }
                catch (OperationCanceledException) { }
            });

            try
            {
                // Send initial snapshot of all flights
                ctx.SendSnapshot(client);

                var buf = new byte[4096];
                while (ws.State == WebSocketState.Open)
                {
                    var result = await ws.ReceiveAsync(buf, CancellationToken.None);
                    if (result.MessageType == WebSocketMessageType.Close) break;
                }
            }
            catch (WebSocketException) { }
            finally
            {
                ctx.Clients.TryRemove(clientId, out _);
                client.Queue.Writer.TryComplete();
                await sendTask;
            }
        });

        // REST API for event raw XML (must be before catch-all route)
        app.MapGet("/api/event-xml/{eventIndex}/{*gufi}", (int eventIndex, string gufi) =>
        {
            if (!ctx.Flights.TryGetValue(gufi, out var f)) return Results.NotFound();
            var evt = f.GetEvent(eventIndex);
            if (evt is null) return Results.NotFound();
            if (evt.RawXml is null) return Results.Json(new { xml = (string?)null }, ctx.JsonOpts);
            return Results.Json(new { xml = evt.RawXml }, ctx.JsonOpts);
        });

        // REST API for flight detail (full state + event log)
        app.MapGet("/api/flights/{*gufi}", (string gufi) =>
        {
            if (!ctx.Flights.TryGetValue(gufi, out var f)) return Results.NotFound();
            return Results.Json(f.ToDetail(), ctx.JsonOpts);
        });

        // REST API for stats
        app.MapGet("/api/stats", () => Results.Json(ctx.Stats.Snapshot(ctx.Flights.Count), ctx.JsonOpts));
    }
}
