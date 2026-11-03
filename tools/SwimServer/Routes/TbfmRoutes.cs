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
