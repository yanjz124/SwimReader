using System.Net.WebSockets;

namespace SwimServer;

/// <summary>
/// TDLS endpoints: page handlers, /tdls/ws/{airport} WebSocket, and /api/tdls/* REST.
/// </summary>
static class TdlsRoutes
{
    public static void Register(WebApplication app, ServerContext ctx)
    {
        // Directory page
        app.MapGet("/tdls", async (HttpContext c) =>
        {
            c.Response.ContentType = "text/html";
            await c.Response.SendFileAsync(Path.Combine(ctx.WebRootPath, "tdls", "directory.html"));
        });

        // /tdls/ws/{airport} BEFORE /tdls/{airport} so the literal segment wins
        app.Map("/tdls/ws/{airport:regex(^[A-Za-z0-9]+$)}", async (HttpContext c, string airport) =>
        {
            if (!c.WebSockets.IsWebSocketRequest) { c.Response.StatusCode = 400; return; }
            airport = airport.ToUpperInvariant();
            using var ws = await c.WebSockets.AcceptWebSocketAsync();
            var client = new WsClient(ws);

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

            var clientId = ctx.Tdls.AddClient(airport, client);
            try
            {
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
                ctx.Tdls.RemoveClient(airport, clientId);
                client.Queue.Writer.TryComplete();
                await sendTask;
            }
        });

        // Airport detail page
        app.MapGet("/tdls/{airport:regex(^[A-Za-z0-9]+$)}", async (HttpContext c, string airport) =>
        {
            c.Response.ContentType = "text/html";
            await c.Response.SendFileAsync(Path.Combine(ctx.WebRootPath, "tdls", "airport.html"));
        });

        // REST: directory + airport detail + per-aircraft messages
        app.MapGet("/api/tdls", () => Results.Json(ctx.Tdls.GetDirectory(), ctx.JsonOpts));
        app.MapGet("/api/tdls/{airport}", (string airport) =>
            Results.Json(ctx.Tdls.GetAirport(airport.ToUpperInvariant()), ctx.JsonOpts));
        app.MapGet("/api/tdls/{airport}/{aircraftId}", (string airport, string aircraftId) =>
            Results.Json(ctx.Tdls.GetAircraftMessages(airport.ToUpperInvariant(), aircraftId.ToUpperInvariant()), ctx.JsonOpts));
    }
}
