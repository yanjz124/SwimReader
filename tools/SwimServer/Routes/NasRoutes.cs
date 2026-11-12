using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

namespace SwimServer;

/// <summary>
/// The fused NAS picture. Step one is deliberately headless: these endpoints exist so the
/// question "can this box carry a whole-NAS map" is answered by measurement rather than by
/// argument, before any pixel is drawn.
///
/// <para><b>Only <c>/api/nas/stats</c> is operator-gated</b>, and that is because of what it
/// reports rather than what it is about: CPU and allocation per pass, key-map size, flow-ish
/// internals. That is deployment state, which is the line this repo already draws for the SYSTEM
/// group.</para>
///
/// <para><c>/api/nas/targets</c> and the socket are <b>not</b> gated, because they are air
/// traffic — and the precedent is unambiguous: <c>/ws</c> already serves every SFDPS flight with
/// its full flight plan (a ~2 MB snapshot) to anyone who can reach the site, as do
/// <c>/api/asdex</c> and <c>/api/tais</c>. Gating the fused view would be inconsistent rather
/// than careful. (It was gated on the first pass, before that comparison was made.)
/// <c>/api/enrich/aircraft</c> stays gated for a different reason: it exists to hand one
/// position-and-beacon-code pair to a correlator, which is the pairing LADD exists to prevent.
/// LADD-blocked aircraft are omitted inside <see cref="NasFusion"/> for every consumer.</para>
/// </summary>
static class NasRoutes
{
    public static void Register(WebApplication app, ServerContext ctx)
    {
        // The map itself. Served through AssetVersion.Stamp rather than SendFileAsync, so the
        // ?v= on nas.js/nas.css is always the newest asset mtime and a returning browser cannot
        // be left on a cached build. The pages that hand-maintain a ?v=N are the ones that got
        // this wrong for two months; a new page has no reason to repeat it.
        app.MapGet("/nas", async (HttpContext c) =>
        {
            var dir = Path.Combine(ctx.WebRootPath, "nas");
            var html = await File.ReadAllTextAsync(Path.Combine(dir, "index.html"));
            long ver = 0;
            foreach (var f in Directory.EnumerateFiles(dir)
                         .Where(f => f.EndsWith(".js") || f.EndsWith(".css")))
                ver = Math.Max(ver, File.GetLastWriteTimeUtc(f).Ticks);
            c.Response.Headers.CacheControl = "no-cache";
            c.Response.ContentType = "text/html";
            await c.Response.WriteAsync(AssetVersion.Stamp(html, ver));
        });

        // Viewport-bounded delta stream. Registered before any /nas/{...} parameter route would
        // be, so the literal segment wins (the same ordering trap as /asdex/ws/{airport}).
        app.Map("/nas/ws", async (HttpContext c) =>
        {
            if (!c.WebSockets.IsWebSocketRequest) { c.Response.StatusCode = 400; return; }
            using var ws = await SwimWs.AcceptAsync(c);
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

            var clientId = ctx.NasStream.AddClient(client);
            try
            {
                // The client drives its own viewport, so unlike every other socket here this one
                // actually reads. Messages are small ({cmd:"view", bbox, cap, cls, q}); anything
                // bigger than the buffer is a client bug and is dropped rather than reassembled.
                var buf = new byte[8192];
                while (ws.State == WebSocketState.Open)
                {
                    var result = await ws.ReceiveAsync(buf, CancellationToken.None);
                    if (result.MessageType == WebSocketMessageType.Close) break;
                    if (result.MessageType != WebSocketMessageType.Text || !result.EndOfMessage) continue;
                    // A malformed command is ignored, never fatal: a socket that dies on bad
                    // input looks exactly like a server that stopped responding.
                    ctx.NasStream.SetView(clientId, Encoding.UTF8.GetString(buf, 0, result.Count));
                }
            }
            catch (WebSocketException) { }
            finally
            {
                ctx.NasStream.RemoveClient(clientId);
                client.Queue.Writer.TryComplete();
                await sendTask;
            }
        });

        // What the pass did: entity count, per-class split, per-tier match counts and cost.
        //
        // ?payload=1 also serialises the whole snapshot in the streaming (positional-array) form
        // and reports its byte length. That is measured on request rather than every pass because
        // serialising ~12k targets twice a second to produce a number nobody reads would be the
        // sort of self-inflicted cost this index is trying to avoid.
        app.MapGet("/api/nas/stats", (HttpContext http, int? payload) =>
        {
            if (!LaddService.OperatorView(http)) return LaddService.OperatorOnly();
            var snap = ctx.Nas.Snapshot();
            var raw = snap.Stats.SfdpsRecords + snap.Stats.TaisRecords + snap.Stats.AsdexRecords;
            object? wire = null;
            if (payload == 1)
            {
                var deltas = new List<object[]>(snap.Entities.Count);
                foreach (var e in snap.Entities.Values)
                    if (e.Positioned) deltas.Add(e.ToDelta());
                var json = JsonSerializer.Serialize(deltas);
                wire = new
                {
                    bytes = json.Length,
                    perTarget = deltas.Count == 0 ? 0 : Math.Round((double)json.Length / deltas.Count, 1),
                    kb = Math.Round(json.Length / 1024.0, 1),
                    // Every socket in this repo negotiates permessage-deflate, measured at 7.2x
                    // on the /ws snapshot. Reported as an estimate, not a measurement.
                    estDeflatedKb = Math.Round(json.Length / 1024.0 / 7.2, 1),
                };
            }
            return Results.Json(new
            {
                built = snap.Built == DateTime.MinValue ? null : snap.Built.ToString("o"),
                ageMs = snap.Built == DateTime.MinValue ? (double?)null
                      : Math.Round((DateTime.UtcNow - snap.Built).TotalMilliseconds, 0),
                stats = snap.Stats.ToJson(raw),
                wire,
            }, ctx.JsonOpts);
        });

        // The fused targets themselves, for eyeballing the index before there is a map.
        //   ?cls=enroute,terminal,...   restrict to these classes
        //   ?bbox=s,w,n,e               restrict to a viewport (what the stream will do per client)
        //   ?limit=                     cap (default 2000, so a hand curl doesn't pull 12k rows)
        //   ?delta=1                    emit the positional-array wire form instead of objects
        //   ?held=1                     also include entities with NO position (flight plans)
        app.MapGet("/api/nas/targets", (HttpContext http, string? cls, string? bbox, int? limit, int? delta, int? held) =>
        {
            var snap = ctx.Nas.Snapshot();

            HashSet<string>? want = null;
            if (!string.IsNullOrWhiteSpace(cls))
                want = new HashSet<string>(cls!.Split(',', StringSplitOptions.RemoveEmptyEntries
                                                         | StringSplitOptions.TrimEntries),
                                           StringComparer.OrdinalIgnoreCase);

            double s = -90, w = -180, n = 90, e = 180;
            if (!string.IsNullOrWhiteSpace(bbox))
            {
                var p = bbox!.Split(',');
                if (p.Length == 4 && double.TryParse(p[0], out s) && double.TryParse(p[1], out w)
                                  && double.TryParse(p[2], out n) && double.TryParse(p[3], out e)) { }
                else { s = -90; w = -180; n = 90; e = 180; }
            }

            var cap = Math.Clamp(limit ?? 2000, 1, 50000);
            var rows = new List<object>(Math.Min(cap, 4096));
            int matched = 0;
            foreach (var ent in snap.Entities.Values)
            {
                // An unpositioned entity is a flight plan, not a target: it has no lat/lon, so
                // emitting it puts it at (0, 0). ?held=1 includes them for inspection.
                if (!ent.Positioned && held != 1) continue;
                if (want is not null && !want.Contains(ent.Cls.ToString())) continue;
                if (ent.Positioned && (ent.Lat < s || ent.Lat > n || ent.Lon < w || ent.Lon > e)) continue;
                matched++;
                if (rows.Count >= cap) continue;
                rows.Add(delta == 1 ? ent.ToDelta() : ent.ToJson());
            }
            return Results.Json(new
            {
                built = snap.Built == DateTime.MinValue ? null : snap.Built.ToString("o"),
                matched,
                returned = rows.Count,
                truncated = matched > rows.Count,
                targets = rows,
            }, ctx.JsonOpts);
        });
    }
}
