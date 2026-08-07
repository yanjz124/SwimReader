using System.Net.WebSockets;

namespace SwimServer;

/// <summary>
/// TFMS endpoints: WebSocket flight + TMI streams plus /api/tfms/* REST.
/// (Static page handlers /tfm/* live in StaticRoutes.)
/// </summary>
static class TfmsRoutes
{
    public static void Register(WebApplication app, ServerContext ctx)
    {
        // TFMS WebSocket — flight stream
        app.Map("/tfms/ws", async (HttpContext c) =>
        {
            if (!c.WebSockets.IsWebSocketRequest) { c.Response.StatusCode = 400; return; }
            using var ws = await c.WebSockets.AcceptWebSocketAsync();
            var client = new WsClient(ws) { Reveal = LaddService.Reveal(c) };

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

            var clientId = ctx.Tfms.AddFlightClient(client);
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
                ctx.Tfms.RemoveFlightClient(clientId);
                client.Queue.Writer.TryComplete();
                await sendTask;
            }
        });

        // TFMS WebSocket — TMI stream
        app.Map("/tfms/ws/tmi", async (HttpContext c) =>
        {
            if (!c.WebSockets.IsWebSocketRequest) { c.Response.StatusCode = 400; return; }
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

            var clientId = ctx.Tfms.AddTmiClient(client);
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
                ctx.Tfms.RemoveTmiClient(clientId);
                client.Queue.Writer.TryComplete();
                await sendTask;
            }
        });

        // REST API
        app.MapGet("/api/tfms/stats", () => Results.Json(ctx.Tfms.GetStats(), ctx.JsonOpts));
        app.MapGet("/api/tfms/flights", (HttpContext http) => Results.Json(ctx.Tfms.GetFlights(LaddService.Reveal(http)), ctx.JsonOpts));
        // All flights including prefiled / no-position — pure TFMS data, no merge.
        app.MapGet("/api/tfms/all", (HttpContext http) => Results.Json(ctx.Tfms.GetAllFlights(LaddService.Reveal(http)), ctx.JsonOpts));
        // Airport configurations from APTC messages (current AAR/ADR, runway config, weather)
        app.MapGet("/api/tfms/aptc", () => Results.Json(ctx.Tfms.GetAirportConfigs(), ctx.JsonOpts));
        app.MapGet("/api/tfms/flights/{key}", (string key) =>
        {
            var f = ctx.Tfms.GetFlight(key);
            return f is not null ? Results.Json(f, ctx.JsonOpts) : Results.NotFound();
        });
        app.MapGet("/api/tfms/tmis", () => Results.Json(ctx.Tfms.GetTmis(), ctx.JsonOpts));
        app.MapGet("/api/tfms/tmis/{fcaId}", (string fcaId) =>
        {
            var t = ctx.Tfms.GetTmi(fcaId);
            return t is not null ? Results.Json(t, ctx.JsonOpts) : Results.NotFound();
        });
        app.MapGet("/api/tfms/sectors", () => Results.Json(ctx.Tfms.GetSectorSummary(), ctx.JsonOpts));
        app.MapGet("/api/tfms/sectors/{sector}", (string sector) =>
            Results.Json(ctx.Tfms.GetSectorFlights(sector), ctx.JsonOpts));

        // TFMS element discovery (investigation)
        app.MapGet("/api/tfms/elements", (string? filter) =>
            Results.Json(ctx.Tfms.GetDiscoveredElements(filter), ctx.JsonOpts));
        app.MapGet("/api/tfms/raw/{msgType}", (string msgType) =>
        {
            var xml = ctx.Tfms.GetRawSample(msgType);
            return xml is not null ? Results.Text(xml, "application/xml") : Results.NotFound();
        });
        app.MapGet("/api/tfms/msgtypes", () => Results.Json(ctx.Tfms.GetMessageTypes(), ctx.JsonOpts));
    }
}
