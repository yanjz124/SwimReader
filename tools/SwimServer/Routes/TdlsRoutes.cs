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

        // The separate history page is folded into /tdls (LIVE / HISTORY toggle). Old links land there
        // in history mode. Registered BEFORE /tdls/{airport} so the literal segment wins.
        app.MapGet("/tdls/history", () => Results.Redirect("/tdls?mode=history"));

        // History API: list dates and search
        app.MapGet("/api/tdls/history/dates", () =>
            Results.Json(TdlsHistoryService.ListDates(ctx.TdlsHistoryDir), ctx.JsonOpts));
        // date is optional: omitted (or "all") searches every recorded day, newest first. A callsign
        // query is resolved through the callsign index so that costs a couple of files, not 1.5 GB.
        app.MapGet("/api/tdls/history", (string? date, string? q, string? type, string? airport, int? limit, HttpContext http) =>
        {
            http.Response.Headers.CacheControl = "no-store";   // reveal-sensitive (see /api/history)
            return Results.Json(TdlsHistoryService.Search(ctx.TdlsHistoryDir, date, q, type, airport,
                Math.Clamp(limit ?? 500, 1, 5000), LaddService.Reveal(http)), ctx.JsonOpts);
        });

        // Index status, so the UI can tell "no matches" from "still warming up".
        app.MapGet("/api/tdls/history/index", () =>
        {
            TdlsCallsignIndex.EnsureBuilt(ctx.TdlsHistoryDir);
            return Results.Json(new
            {
                state = TdlsCallsignIndex.State.ToString(),
                callsigns = TdlsCallsignIndex.CallsignCount,
                days = TdlsCallsignIndex.DayCount,
            }, ctx.JsonOpts);
        });
        app.MapGet("/api/tdls/history/airports", (string? date) =>
            Results.Json(TdlsHistoryService.AirportsForDate(ctx.TdlsHistoryDir,
                date ?? DateTime.UtcNow.ToString("yyyy-MM-dd")), ctx.JsonOpts));

        // /tdls/ws/{airport} BEFORE /tdls/{airport} so the literal segment wins
        app.Map("/tdls/ws/{airport:regex(^[A-Za-z0-9]+$)}", async (HttpContext c, string airport) =>
        {
            if (!c.WebSockets.IsWebSocketRequest) { c.Response.StatusCode = 400; return; }
            airport = airport.ToUpperInvariant();
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
        app.MapGet("/api/tdls/{airport}", (string airport, HttpContext http) =>
            Results.Json(ctx.Tdls.GetAirport(airport.ToUpperInvariant(), LaddService.Reveal(http)), ctx.JsonOpts));
        app.MapGet("/api/tdls/{airport}/{aircraftId}", (string airport, string aircraftId, HttpContext http) =>
            Results.Json(ctx.Tdls.GetAircraftMessages(airport.ToUpperInvariant(), aircraftId.ToUpperInvariant(), LaddService.Reveal(http)), ctx.JsonOpts));
    }
}
