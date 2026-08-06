using System.Net.WebSockets;

namespace SwimServer;

/// <summary>
/// TFDM endpoints: directory + per-airport departure board pages, the
/// /tfdm/ws/{airport} WebSocket, and /api/tfdm/* REST. Mirrors AsdexRoutes;
/// the literal "ws" route registers before the "{airport}" route.
/// </summary>
static class TfdmRoutes
{
    public static void Register(WebApplication app, ServerContext ctx)
    {
        app.MapGet("/tfdm", async (HttpContext c) =>
        {
            c.Response.ContentType = "text/html";
            await c.Response.SendFileAsync(Path.Combine(ctx.WebRootPath, "tfdm", "directory.html"));
        });

        app.Map("/tfdm/ws/{airport:regex(^[A-Za-z0-9]+$)}", async (HttpContext c, string airport) =>
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
            var clientId = ctx.Tfdm.AddClient(airport, client);
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
                ctx.Tfdm.RemoveClient(airport, clientId);
                client.Queue.Writer.TryComplete();
                await sendTask;
            }
        });

        app.MapGet("/tfdm/{airport:regex(^[A-Za-z0-9]+$)}", async (HttpContext c, string airport) =>
        {
            c.Response.ContentType = "text/html";
            await c.Response.SendFileAsync(Path.Combine(ctx.WebRootPath, "tfdm", "airport.html"));
        });

        app.MapGet("/api/tfdm", () => Results.Json(ctx.Tfdm.GetDirectory(), ctx.JsonOpts));
        app.MapGet("/api/tfdm/{airport}", (string airport) =>
            Results.Json(ctx.Tfdm.GetSnapshot(airport.ToUpperInvariant()), ctx.JsonOpts));
    }
}
