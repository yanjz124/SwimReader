using System.Net.WebSockets;

namespace SwimServer;

/// <summary>
/// ITWS endpoints: directory page, /itws/ws and /itws/ws/{airport} WebSockets,
/// and /api/itws/* REST. The REST API is designed to be consumed by both the
/// in-browser frontend and external clients (e.g. X-Plane weather plugin).
/// </summary>
static class ItwsRoutes
{
    public static void Register(WebApplication app, ServerContext ctx)
    {
        // Directory page
        app.MapGet("/itws", async (HttpContext c) =>
        {
            c.Response.ContentType = "text/html";
            await c.Response.SendFileAsync(Path.Combine(ctx.WebRootPath, "itws", "index.html"));
        });

        // Register literal /itws/ws BEFORE /itws/ws/{airport}
        app.Map("/itws/ws", async (HttpContext c) =>
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

            var clientId = ctx.Itws.AddAllClient(client);
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
                ctx.Itws.RemoveAllClient(clientId);
                client.Queue.Writer.TryComplete();
                await sendTask;
            }
        });

        app.Map("/itws/ws/{airport:regex(^[A-Za-z0-9]+$)}", async (HttpContext c, string airport) =>
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

            var clientId = ctx.Itws.AddAirportClient(airport, client);
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
                ctx.Itws.RemoveAirportClient(airport, clientId);
                client.Queue.Writer.TryComplete();
                await sendTask;
            }
        });

        // Airport-scoped page reuses the same SPA (frontend reads the URL segment)
        app.MapGet("/itws/{airport:regex(^[A-Za-z0-9]+$)}", async (HttpContext c, string airport) =>
        {
            c.Response.ContentType = "text/html";
            await c.Response.SendFileAsync(Path.Combine(ctx.WebRootPath, "itws", "index.html"));
        });

        // REST API — all endpoints return JSON unless otherwise noted.
        app.MapGet("/api/itws/stats", () => Results.Json(ctx.Itws.GetStats(), ctx.JsonOpts));
        app.MapGet("/api/itws/products", () => Results.Json(ctx.Itws.GetProducts(), ctx.JsonOpts));
        app.MapGet("/api/itws/airports", () => Results.Json(ctx.Itws.GetAirports(), ctx.JsonOpts));
        app.MapGet("/api/itws/latest", () => Results.Json(ctx.Itws.GetLatest(), ctx.JsonOpts));
        app.MapGet("/api/itws/airport/{airport}", (string airport) =>
            Results.Json(ctx.Itws.GetAirport(airport), ctx.JsonOpts));
        app.MapGet("/api/itws/product/{productType}", (string productType) =>
            Results.Json(ctx.Itws.GetProduct(productType), ctx.JsonOpts));

        // Raw XML for one product+site combo — primary consumer endpoint for X-Plane plugin.
        // When sub-IDs (runway/sensor) exist for the same product+site, this returns the
        // most recent variant. For exact sub-ID lookup, use /api/itws/raw-by-key.
        app.MapGet("/api/itws/raw/{productType}/{site}", (string productType, string site) =>
        {
            var xml = ctx.Itws.GetRaw(productType, site);
            return xml is not null ? Results.Text(xml, "application/xml") : Results.NotFound();
        });

        // Exact-key lookup — key is "{productType}|{site}" or "{productType}|{site}|{subId}".
        // Get the key from /api/itws/latest or the WebSocket update payload.
        // Use query string to avoid path-encoding issues with '|' and special chars.
        app.MapGet("/api/itws/raw-by-key", (string key) =>
        {
            var xml = ctx.Itws.GetRawByKey(key);
            return xml is not null ? Results.Text(xml, "application/xml") : Results.NotFound();
        });

        // 24h time-series history for the trend graphs (wind / storms / precip).
        // Server-side captured so all clients share the same trend and reloads keep data.
        app.MapGet("/api/itws/history/{airport}", (string airport) =>
            Results.Json(ctx.Itws.GetHistory(airport), ctx.JsonOpts));

        // Discovery aids
        app.MapGet("/api/itws/topics", () => Results.Json(ctx.Itws.GetTopics(), ctx.JsonOpts));
        app.MapGet("/api/itws/sample/{productType}", (string productType) =>
        {
            var xml = ctx.Itws.GetSample(productType);
            return xml is not null ? Results.Text(xml, "application/xml") : Results.NotFound();
        });
    }
}
