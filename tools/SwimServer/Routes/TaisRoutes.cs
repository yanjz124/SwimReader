using System.Net.WebSockets;

namespace SwimServer;

/// <summary>
/// TAIS endpoints: directory + facility pages, /tais/ws/{facility} WebSocket, /api/tais/* REST.
/// </summary>
static class TaisRoutes
{
    public static void Register(WebApplication app, ServerContext ctx)
    {
        // Directory page
        app.MapGet("/tais", async (HttpContext c) =>
        {
            c.Response.ContentType = "text/html";
            await c.Response.SendFileAsync(Path.Combine(ctx.WebRootPath, "tais", "directory.html"));
        });

        // /tais/ws/{facility} BEFORE /tais/{facility} so the literal segment wins
        app.Map("/tais/ws/{facility:regex(^[A-Za-z0-9]+$)}", async (HttpContext c, string facility) =>
        {
            if (!c.WebSockets.IsWebSocketRequest) { c.Response.StatusCode = 400; return; }
            facility = facility.ToUpperInvariant();
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

            var clientId = ctx.Tais.AddClient(facility, client);
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
                ctx.Tais.RemoveClient(facility, clientId);
                client.Queue.Writer.TryComplete();
                await sendTask;
            }
        });

        // Facility detail page
        app.MapGet("/tais/{facility:regex(^[A-Za-z0-9]+$)}", async (HttpContext c, string facility) =>
        {
            c.Response.ContentType = "text/html";
            await c.Response.SendFileAsync(Path.Combine(ctx.WebRootPath, "tais", "facility.html"));
        });

        // REST
        app.MapGet("/api/tais", () => Results.Json(ctx.Tais.GetDirectory(), ctx.JsonOpts));
        // Active controller positions (TCPs) owning tracks. Registered before the
        // {facility} route so the literal "tcps" wins.
        app.MapGet("/api/tais/tcps", () => Results.Json(ctx.Tais.GetActiveTcps(), ctx.JsonOpts));
        app.MapGet("/api/tais/{facility}", (string facility) =>
            Results.Json(ctx.Tais.GetSnapshot(facility.ToUpperInvariant()), ctx.JsonOpts));
    }
}
