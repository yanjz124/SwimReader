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
        // Flow restrictions per airport, for the map's FLOW overlay: what TBFM is metering and
        // what TFDM says is constraining the field, joined to a NASR position so it can be drawn.
        //
        // Not operator-gated, same reasoning as the targets: this is air traffic, and both
        // /api/tbfm/airports and /api/tfdm/{apt} already serve it ungated. It is an aggregation
        // of those, not a new exposure.
        //
        // The two halves answer different questions and are deliberately NOT merged into one
        // "delay" number: TBFM's hold is airborne arrival metering (and is a chain MAXIMUM, never
        // a sum — a center that has absorbed the hold reads ~0 one point downstream), while
        // TFDM's is surface and departure constraint. An airport can have one without the other.
        app.MapGet("/api/nas/flow", (HttpContext http) =>
        {
            var nasr = ctx.GetNasr();
            var rows = new List<object>();

            // THE TWO SOURCES KEY AIRPORTS DIFFERENTLY: TFDM publishes ICAO (KLAS) and TBFM the
            // FAA LID (LAS). Joining them raw matched almost nothing — LAS appeared twice, once
            // with metering and no field data and once with field data and no metering, which
            // reads as two different airports rather than a failed join. Both sides are
            // normalized to the LID, the same way TbfmDashboard.AirportBoard already does.
            var tfdm = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);
            foreach (var (k, v) in ctx.Tfdm.FlowSnapshot()) tfdm[Lid(k)] = v;

            // TBFM first: it names the airports with arrival metering.
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var o in ctx.Tbfm.AirportsSnapshot())
            {
                var j = System.Text.Json.JsonSerializer.SerializeToElement(o, ctx.JsonOpts);
                var apt = Lid(j.GetProperty("apt").GetString() ?? "");
                if (apt.Length == 0 || !seen.Add(apt)) continue;
                rows.Add(FlowRow(ctx, nasr, apt, j, tfdm.GetValueOrDefault(apt)));
            }
            // Then any airport TFDM is restricting that TBFM is not metering at all.
            foreach (var (apt, t) in tfdm)
            {
                if (seen.Contains(apt)) continue;
                rows.Add(FlowRow(ctx, nasr, apt, null, t));
            }

            return Results.Json(new { ts = DateTime.UtcNow.ToString("o"), airports = rows }, ctx.JsonOpts);
        });

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
        // ?payload=1 also serializes the whole snapshot in the streaming (positional-array) form
        // and reports its byte length. That is measured on request rather than every pass because
        // serializing ~12k targets twice a second to produce a number nobody reads would be the
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

    /// <summary>
    /// Normalize an airport identifier to the FAA LID the NAS map keys on: KLAS -> LAS.
    /// Only a 4-character identifier beginning with K is stripped, which is the same rule
    /// TbfmDashboard uses — PANC and PHNL must keep their prefix.
    /// </summary>
    internal static string Lid(string apt)
    {
        apt = apt.Trim().ToUpperInvariant();
        return apt.Length == 4 && apt[0] == 'K' ? apt[1..] : apt;
    }

    /// <summary>
    /// One airport's flow row. The position comes from NASR, and an airport we cannot place is
    /// still returned WITHOUT coordinates rather than dropped — the map skips it, but a caller
    /// counting restrictions should not silently lose one because the identifier is unknown.
    /// </summary>
    private static object FlowRow(ServerContext ctx, NasrData? nasr, string apt,
                                  System.Text.Json.JsonElement? tbfm, object? tfdm)
    {
        double? lat = null, lon = null;
        if (nasr is not null)
        {
            // TBFM uses the bare FAA LID (ORD); NASR answers to either, so try both.
            var p = ctx.LookupAirport(apt, nasr) ?? ctx.LookupAirport("K" + apt, nasr);
            if (p is not null) { lat = p.Lat; lon = p.Lon; }
        }

        int? metered = null, delayed = null;
        double? maxDelay = null, aar = null;
        bool aarRestricted = false;
        string? tracon = null;
        if (tbfm is { } j)
        {
            if (j.TryGetProperty("metered", out var m)) metered = m.GetInt32();
            if (j.TryGetProperty("delayed", out var d)) delayed = d.GetInt32();
            if (j.TryGetProperty("maxDelayMin", out var x) && x.ValueKind != System.Text.Json.JsonValueKind.Null)
                maxDelay = x.GetDouble();
            if (j.TryGetProperty("aar", out var a) && a.ValueKind != System.Text.Json.JsonValueKind.Null)
                aar = a.GetDouble();
            if (j.TryGetProperty("aarRestricted", out var ar)) aarRestricted = ar.GetBoolean();
            if (j.TryGetProperty("tracon", out var tr) && tr.ValueKind == System.Text.Json.JsonValueKind.String)
                tracon = tr.GetString();
        }

        return new
        {
            apt, lat, lon,
            metered, delayed,
            maxDelayMin = maxDelay,
            // 3,600/hour is TBFM's "no restriction" default, not a rate: 53 of 57 published AARs
            // sat at exactly that, including fields that could not take one an hour. `restricted`
            // is the flag worth reading.
            aar, aarRestricted, tracon,
            tfdm,
        };
    }
}
