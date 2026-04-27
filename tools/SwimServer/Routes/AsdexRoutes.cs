using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text.Json;

namespace SwimServer;

/// <summary>
/// ASDE-X endpoints: page handlers, /asdex/ws/{airport} WebSocket, and /api/asdex/* REST.
/// Route registration order is important — the literal "ws" must register BEFORE the
/// "{airport}" parameter route so ASP.NET Core gives WebSocket priority.
/// </summary>
static class AsdexRoutes
{
    public static void Register(WebApplication app, ServerContext ctx)
    {
        // Directory page
        app.MapGet("/asdex", async (HttpContext c) =>
        {
            c.Response.ContentType = "text/html";
            await c.Response.SendFileAsync(Path.Combine(ctx.WebRootPath, "asdex", "directory.html"));
        });

        // Register /asdex/ws/{airport} BEFORE /asdex/{airport} so the literal "ws" segment wins
        app.Map("/asdex/ws/{airport:regex(^[A-Za-z0-9]+$)}", async (HttpContext c, string airport) =>
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

            var clientId = ctx.Asdex.AddClient(airport, client);
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
                ctx.Asdex.RemoveClient(airport, clientId);
                client.Queue.Writer.TryComplete();
                await sendTask;
            }
        });

        // Airport scope page
        app.MapGet("/asdex/{airport:regex(^[A-Za-z0-9]+$)}", async (HttpContext c, string airport) =>
        {
            c.Response.ContentType = "text/html";
            await c.Response.SendFileAsync(Path.Combine(ctx.WebRootPath, "asdex", "scope.html"));
        });

        // ASDEX directory — list of airports with track counts and centroids
        app.MapGet("/api/asdex", () => Results.Json(ctx.Asdex.GetDirectory(), ctx.JsonOpts));

        // ASDEX airport snapshot — all current tracks for one airport
        app.MapGet("/api/asdex/{airport}", (string airport) =>
            Results.Json(ctx.Asdex.GetSnapshot(airport.ToUpperInvariant()), ctx.JsonOpts));

        // ASDEX scratchpad config — pattern→code mapping, shared across all clients.
        // Pattern can be any substring matched against the route (SID, fix, SID+transition, airway, etc.)
        app.MapGet("/api/asdex/{airport}/gatecodes", (string airport) =>
        {
            airport = airport.ToUpperInvariant();
            if (ctx.GateCodes.TryGetValue(airport, out var codes))
                return Results.Json(codes.ToDictionary(kv => kv.Key, kv => kv.Value), ctx.JsonOpts);
            return Results.Json(new Dictionary<string, string>(), ctx.JsonOpts);
        });

        app.MapPut("/api/asdex/{airport}/gatecodes", async (HttpContext c, string airport) =>
        {
            airport = airport.ToUpperInvariant();
            using var reader = new StreamReader(c.Request.Body);
            var body = await reader.ReadToEndAsync();
            var entries = JsonSerializer.Deserialize<Dictionary<string, string>>(body);
            if (entries is null) return Results.BadRequest();
            var map = new ConcurrentDictionary<string, string>();
            foreach (var (pattern, code) in entries)
            {
                var k = pattern.Trim().ToUpperInvariant();
                var v = code.Trim().ToUpperInvariant();
                if (k.Length > 0 && v.Length > 0 && v.Length <= 10)
                    map[k] = v;
            }
            if (map.IsEmpty)
                ctx.GateCodes.TryRemove(airport, out _);
            else
                ctx.GateCodes[airport] = map;
            Task.Run(ctx.SaveGateCodes);
            return Results.Ok();
        });

        // vNAS fix rules (auto-fetched, read-only) — returned as ordered array to preserve rule priority
        app.MapGet("/api/asdex/{airport}/vnasrules", (string airport) =>
        {
            airport = airport.ToUpperInvariant();
            if (ctx.VnasFixRules.TryGetValue(airport, out var rules))
                return Results.Json(rules.Select(kv => new { pattern = kv.Key, code = kv.Value }), ctx.JsonOpts);
            return Results.Json(Array.Empty<object>(), ctx.JsonOpts);
        });

        // Holdbar GeoJSON (vNAS runway safety logic geometry)
        app.MapGet("/api/asdex/{airport}/holdbar-geo", (string airport) =>
        {
            var icao = airport.ToUpperInvariant();
            if (!icao.StartsWith("K") && !icao.StartsWith("P")) icao = "K" + icao;
            var path = Path.Combine(ctx.WebRootPath, "asdex", "holdbar-geo", icao + ".geojson");
            if (!File.Exists(path)) return Results.NotFound();
            return Results.File(path, "application/json");
        });

        // Holdbar bit mapping (learned from empirical correlation)
        app.MapGet("/api/asdex/{airport}/holdbar-map", (string airport) =>
        {
            var icao = airport.ToUpperInvariant();
            if (!icao.StartsWith("K") && !icao.StartsWith("P")) icao = "K" + icao;
            var mapping = ctx.Asdex.GetHoldbarMapping(icao);
            if (mapping is null || mapping.Count == 0) return Results.Json(new { }, ctx.JsonOpts);
            return Results.Json(mapping.ToDictionary(kv => kv.Key.ToString(), kv => kv.Value), ctx.JsonOpts);
        });

        // Reset holdbar mapping for an airport (wipe learned data, start fresh)
        app.MapDelete("/api/asdex/{airport}/holdbar-map", (string airport) =>
        {
            var icao = airport.ToUpperInvariant();
            if (!icao.StartsWith("K") && !icao.StartsWith("P")) icao = "K" + icao;
            ctx.Asdex.ResetHoldbarMapping(icao);
            return Results.Ok(new { reset = icao });
        });
    }
}
