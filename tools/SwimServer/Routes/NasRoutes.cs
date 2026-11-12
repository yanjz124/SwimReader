using System.Text.Json;

namespace SwimServer;

/// <summary>
/// The fused NAS picture. Step one is deliberately headless: these endpoints exist so the
/// question "can this box carry a whole-NAS map" is answered by measurement rather than by
/// argument, before any pixel is drawn.
///
/// <para><b>Both are operator-gated.</b> They are bulk dumps of every target in the country with
/// its identity attached — the same material as <c>/api/enrich/aircraft</c>, and far more than
/// anything on the public site needs. (LADD-blocked aircraft are omitted inside
/// <see cref="NasFusion"/> regardless, so the gate is defence in depth, not the only defence.)</para>
/// </summary>
static class NasRoutes
{
    public static void Register(WebApplication app, ServerContext ctx)
    {
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
                foreach (var e in snap.Entities.Values) deltas.Add(e.ToDelta());
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
        app.MapGet("/api/nas/targets", (HttpContext http, string? cls, string? bbox, int? limit, int? delta) =>
        {
            if (!LaddService.OperatorView(http)) return LaddService.OperatorOnly();
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
                if (want is not null && !want.Contains(ent.Cls.ToString())) continue;
                if (ent.Lat < s || ent.Lat > n || ent.Lon < w || ent.Lon > e) continue;
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
