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

        // Per-facility/sector active-track breakdown.
        //   Returns: [{ facility, totalTracks, sectorCount,
        //                sectors: [{ id, tracks, handoffsIn, handoffsOut }] }, ...]
        // A flight contributes one track to its controllingFacility/sector. Handoff
        // legs that name a facility add to handoffsIn (this facility is receiving)
        // or handoffsOut (this facility is transferring) so the page can flag
        // sectors currently in transition. Anything without a controllingFacility
        // falls under "(none)".
        app.MapGet("/api/sectors", () =>
        {
            var byFac = new Dictionary<string, Dictionary<string, (int tracks, int hIn, int hOut)>>(StringComparer.OrdinalIgnoreCase);
            string Norm(string? s) => string.IsNullOrEmpty(s) ? "" : s.Trim().ToUpperInvariant();
            (string fac, string sec) Split(string? raw)
            {
                if (string.IsNullOrEmpty(raw)) return ("", "");
                var slash = raw.IndexOf('/');
                if (slash < 0) return (Norm(raw), "");
                return (Norm(raw[..slash]), Norm(raw[(slash + 1)..]));
            }
            void Bump(string fac, string sec, bool isOwn, bool hIn, bool hOut)
            {
                if (string.IsNullOrEmpty(fac)) fac = "(none)";
                if (string.IsNullOrEmpty(sec)) sec = "(none)";
                if (!byFac.TryGetValue(fac, out var inner))
                {
                    inner = new(StringComparer.OrdinalIgnoreCase);
                    byFac[fac] = inner;
                }
                inner.TryGetValue(sec, out var cur);
                cur.tracks    += isOwn ? 1 : 0;
                cur.hIn       += hIn   ? 1 : 0;
                cur.hOut      += hOut  ? 1 : 0;
                inner[sec] = cur;
            }
            foreach (var f in ctx.Flights.Values)
            {
                if (f.FlightStatus is "CANCELLED" or "COMPLETED") continue;
                var fac = Norm(f.ControllingFacility);
                var sec = Norm(f.ControllingSector);
                if (!string.IsNullOrEmpty(fac)) Bump(fac, sec, isOwn: true, hIn: false, hOut: false);
                var (rFac, rSec) = Split(f.HandoffReceiving);
                if (!string.IsNullOrEmpty(rFac))  Bump(rFac, rSec, false, true,  false);
                var (tFac, tSec) = Split(f.HandoffTransferring);
                if (!string.IsNullOrEmpty(tFac) && (tFac != fac || tSec != sec))
                    Bump(tFac, tSec, false, false, true);
            }
            var rows = byFac
                .Select(kv => new
                {
                    facility    = kv.Key,
                    totalTracks = kv.Value.Values.Sum(v => v.tracks),
                    sectorCount = kv.Value.Count(s => s.Value.tracks > 0),
                    sectors = kv.Value
                        .OrderByDescending(s => s.Value.tracks)
                        .ThenBy(s => s.Key, StringComparer.OrdinalIgnoreCase)
                        .Select(s => new
                        {
                            id          = s.Key,
                            tracks      = s.Value.tracks,
                            handoffsIn  = s.Value.hIn,
                            handoffsOut = s.Value.hOut,
                        })
                        .ToArray()
                })
                .OrderByDescending(r => r.totalTracks)
                .ThenBy(r => r.facility, StringComparer.OrdinalIgnoreCase)
                .ToArray();
            return Results.Json(rows, ctx.JsonOpts);
        });

        // Server performance / health: CPU, memory, GC, threads, uptime, WS clients, disk.
        app.MapGet("/api/system", () => Results.Json(SystemStats.Snapshot(ctx.Clients.Count, ctx.Flights.Count), ctx.JsonOpts));

        // Deployed build: current git commit + commit time (so the homepage can show what's live).
        app.MapGet("/api/version", () => Results.Json(VersionInfo.Get(ctx.RepoRoot), ctx.JsonOpts));

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
