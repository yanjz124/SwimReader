namespace SwimServer;

/// <summary>
/// TBFM metering endpoints. The ERAM scope polls <c>/api/tbfm/eram</c> for the STA / DELAY RDBs.
/// <c>/api/tbfm/flight/{callsign}</c>, <c>/centers</c> and <c>/adaptation/{center}</c> expose the
/// rest of the feed; <c>/api/tbfm/debug</c> has raw samples and the element names seen.
///
/// The <c>/tbfm</c> pages are the dashboard over the same state: a directory of metered airports
/// and centers, one airport's arrival metering board, and one center's meter-point board with its
/// adaptation geometry. Projections live in TbfmDashboard.cs.
/// </summary>
static class TbfmRoutes
{
    /// <summary>Oldest SFDPS fix the center map will plot a metered flight from.</summary>
    private const int MaxPosAgeSec = 120;

    public static void Register(WebApplication app, ServerContext ctx)
    {
        app.MapGet("/api/tbfm/eram", () => Results.Json(new
        {
            configured = ctx.Tbfm.Configured,
            flights = ctx.Tbfm.EramSnapshot(),
        }, ctx.JsonOpts));

        // Everything every center's TBFM holds for one callsign (flt / mrp / sch blocks, all times).
        app.MapGet("/api/tbfm/flight/{callsign}", (string callsign) =>
            Results.Json(ctx.Tbfm.FlightDetail(callsign), ctx.JsonOpts));

        // One row per TBFM system: heartbeat, schedule count, adaptation size, acceptance rates.
        app.MapGet("/api/tbfm/centers", () => Results.Json(ctx.Tbfm.CentersSnapshot(), ctx.JsonOpts));

        // A center's adaptation: meter points (type, lat/lon, arc radius/angles), airports, gates.
        app.MapGet("/api/tbfm/adaptation/{center}", (string center) =>
            ctx.Tbfm.Adaptation(center) is { } a ? Results.Json(a, ctx.JsonOpts) : Results.NotFound());

        app.MapGet("/api/tbfm/debug", () => Results.Json(ctx.Tbfm.DebugSnapshot(), ctx.JsonOpts));

        // ── Dashboard ────────────────────────────────────────────────────────
        app.MapGet("/api/tbfm/stats", () => Results.Json(ctx.Tbfm.Stats(), ctx.JsonOpts));
        app.MapGet("/api/tbfm/airports", () => Results.Json(ctx.Tbfm.AirportsSnapshot(), ctx.JsonOpts));
        app.MapGet("/api/tbfm/airport/{apt}", (string apt) =>
            Results.Json(ctx.Tbfm.AirportBoard(apt), ctx.JsonOpts));
        app.MapGet("/api/tbfm/center/{center}", (string center) =>
            ctx.Tbfm.CenterBoard(center) is { } b ? Results.Json(b, ctx.JsonOpts) : Results.NotFound());

        // One center's metered flights WITH a position, for the map's traffic layer.
        //
        // TBFM publishes no position at all (see TbfmTarget), so every target here is a TBFM
        // schedule joined to SFDPS by callsign. The join is done HERE rather than inside
        // CenterBoard because TbfmBridge holds no SFDPS state and TbfmDashboard is documented as
        // read-only over the TBFM state — and because positions move on SFDPS's ~12 s cadence
        // while the board's aggregates barely do, so the page refreshes this on its own timer
        // instead of re-rendering tables, rates and adaptation to move a dot.
        //
        // Deliberately NOT a bulk position dump: it emits only the callsigns this center is
        // metering, which is why it needs no operator gate where /api/enrich/aircraft does. Both
        // sides already drop LADD — CenterTraffic through IsLive, and the SFDPS lookup below via
        // LaddService.IsBlocked — so a blocked aircraft cannot be given a position by combining
        // them, which is the thing that endpoint's gate exists to prevent.
        app.MapGet("/api/tbfm/center/{center}/traffic", (string center) =>
        {
            var now = DateTime.UtcNow;
            var targets = ctx.Tbfm.CenterTraffic(center);
            if (targets.Count == 0 && ctx.Tbfm.CenterBoard(center) is null) return Results.NotFound();

            // One pass over SFDPS, keeping the current leg per callsign. CurrentLegFirst is the
            // shared rule (TrackRoutes) — a just-landed earlier leg lingers in memory with a stale
            // position, and picking it would park the target at the wrong airport.
            var want = targets.Select(t => t.Aid).ToHashSet(StringComparer.OrdinalIgnoreCase);
            var byCs = new Dictionary<string, List<FlightState>>(StringComparer.OrdinalIgnoreCase);
            foreach (var f in ctx.Flights.Values)
            {
                if (string.IsNullOrEmpty(f.Callsign) || !want.Contains(f.Callsign)) continue;
                if (LaddService.IsBlocked(f.Callsign, f.Registration)) continue;
                if (!byCs.TryGetValue(f.Callsign, out var l)) byCs[f.Callsign] = l = new();
                l.Add(f);
            }
            var pos = new Dictionary<string, FlightState>(StringComparer.OrdinalIgnoreCase);
            int stale = 0;
            foreach (var (cs, l) in byCs)
            {
                var best = TrackRoutes.CurrentLegFirst(l).FirstOrDefault(f => f.Latitude.HasValue
                                                                              && f.Longitude.HasValue);
                if (best == null) continue;
                // A position too old to plot is worse than no position: SFDPS keeps a flight for
                // 60 minutes after its last update, and the first live run drew SKW3759 from a
                // 55-minute-old fix — several hundred miles from where that aircraft actually was,
                // on a map whose whole subject is proximity to a meter fix. The median age here is
                // 6 s and p90 is 9 s, so 120 s is many missed scans and still well short of a
                // ghost. Counted separately from the oceanic case: they look identical on the map
                // and have nothing to do with each other.
                if ((now - best.LastSeen).TotalSeconds > MaxPosAgeSec) { stale++; continue; }
                pos[cs] = best;
            }

            var rows = new List<object>(targets.Count);
            int located = 0;
            foreach (var t in targets)
            {
                pos.TryGetValue(t.Aid, out var f);
                if (f != null) located++;
                rows.Add(new
                {
                    aid = t.Aid, apt = t.Apt, dep = t.Dep, type = t.Type, status = t.Status,
                    point = t.Point, pointType = t.PointType,
                    sta = t.Sta, eta = t.Eta, delayMin = t.DelayMin,
                    pointLat = t.PointLat, pointLon = t.PointLon,
                    holdCtr = t.HoldCtr, holdPoint = t.HoldPoint, holdMin = t.HoldMin,
                    rwy = t.Rwy, staRwy = t.StaRwy,
                    centers = t.Centers, frozen = t.Frozen, suspended = t.Suspended,
                    // SFDPS half. Null throughout for an oceanic inbound TBFM is already metering.
                    lat = f?.Latitude, lon = f?.Longitude,
                    alt = f?.ReportedAltitude, gs = f?.GroundSpeed,
                    vx = f?.TrackVelocityX, vy = f?.TrackVelocityY,
                    ctrl = f?.ControllingFacility, sector = f?.ControllingSector,
                    posAgeSec = f is null ? (int?)null : (int)(now - f.LastSeen).TotalSeconds,
                });
            }
            return Results.Json(new
            {
                ctr = center.ToUpperInvariant(), ts = now,
                scheduled = targets.Count, located,
                // The page says both of these out loud: an oceanic inbound is metered but has no
                // position at all, which is not the same thing as one whose position went stale.
                unlocated = targets.Count - located - stale,
                stale,
                flights = rows,
            }, ctx.JsonOpts);
        });

        app.MapGet("/tbfm", async (HttpContext c) => await Page(c, ctx, "directory.html"));
        // Literal before parameter, so "center" can't be taken for an airport id.
        app.MapGet("/tbfm/center/{center:regex(^[A-Za-z0-9]+$)}", async (HttpContext c, string center) =>
            await Page(c, ctx, "center.html"));
        app.MapGet("/tbfm/{apt:regex(^[A-Za-z0-9]+$)}", async (HttpContext c, string apt) =>
            await Page(c, ctx, "airport.html"));
    }

    private static async Task Page(HttpContext c, ServerContext ctx, string file)
    {
        c.Response.ContentType = "text/html";
        await c.Response.SendFileAsync(Path.Combine(ctx.WebRootPath, "tbfm", file));
    }
}
