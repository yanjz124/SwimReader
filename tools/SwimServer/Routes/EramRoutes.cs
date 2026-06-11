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

        // Server performance / health: CPU, memory, GC, threads, uptime, WS clients, disk.
        app.MapGet("/api/system", () => Results.Json(SystemStats.Snapshot(ctx.Clients.Count, ctx.Flights.Count), ctx.JsonOpts));

        // EDCT (Expected Departure Clearance Time) — flights currently under a GDP/CTOP/Ground Stop slot.
        // Returns ALL flights with EdctTime set, regardless of whether they've already departed.
        // Client can filter as needed.
        app.MapGet("/api/edct", () =>
        {
            var now = DateTime.UtcNow;
            var rows = new List<object>();
            foreach (var f in ctx.Flights.Values)
            {
                if (string.IsNullOrEmpty(f.EdctTime)) continue;
                DateTime? edctDt = null;
                if (DateTime.TryParse(f.EdctTime, null,
                    System.Globalization.DateTimeStyles.AdjustToUniversal | System.Globalization.DateTimeStyles.AssumeUniversal,
                    out var dt)) edctDt = dt;
                bool departed = !string.IsNullOrEmpty(f.ActualDepartureTime);
                int? minutesUntil = edctDt.HasValue ? (int)(edctDt.Value - now).TotalMinutes : null;
                rows.Add(new
                {
                    gufi = f.Gufi,
                    callsign = f.Callsign,
                    origin = f.Origin,
                    destination = f.Destination,
                    aircraftType = f.AircraftType,
                    edct = f.EdctTime,
                    minutesUntil,
                    actualDeparture = f.ActualDepartureTime,
                    departed,
                    eta = f.ETA,
                    route = f.Route,
                    star = f.STAR,
                    controllingFacility = f.ControllingFacility,
                    controllingSector = f.ControllingSector,
                    flightStatus = f.FlightStatus,
                    lastSeen = f.LastSeen.ToString("o")
                });
            }
            // Sort by EDCT ascending (soonest first)
            rows = rows.OrderBy(r => ((dynamic)r).edct as string).ToList();
            return Results.Json(new { count = rows.Count, flights = rows }, ctx.JsonOpts);
        });
    }
}
