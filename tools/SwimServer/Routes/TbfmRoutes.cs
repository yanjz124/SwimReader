namespace SwimServer;

/// <summary>
/// TBFM metering endpoints. The ERAM scope polls <c>/api/tbfm/eram</c> for the STA / DELAY RDBs.
/// <c>/api/tbfm/flight/{callsign}</c>, <c>/centers</c> and <c>/adaptation/{center}</c> expose the
/// rest of the feed; <c>/api/tbfm/debug</c> has raw samples and the element names seen.
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

        // Everything every centre's TBFM holds for one callsign (flt / mrp / sch blocks, all times).
        app.MapGet("/api/tbfm/flight/{callsign}", (string callsign) =>
            Results.Json(ctx.Tbfm.FlightDetail(callsign), ctx.JsonOpts));

        // One row per TBFM system: heartbeat, schedule count, adaptation size, acceptance rates.
        app.MapGet("/api/tbfm/centers", () => Results.Json(ctx.Tbfm.CentersSnapshot(), ctx.JsonOpts));

        // A centre's adaptation: meter points (type, lat/lon, arc radius/angles), airports, gates.
        app.MapGet("/api/tbfm/adaptation/{center}", (string center) =>
            ctx.Tbfm.Adaptation(center) is { } a ? Results.Json(a, ctx.JsonOpts) : Results.NotFound());

        app.MapGet("/api/tbfm/debug", () => Results.Json(ctx.Tbfm.DebugSnapshot(), ctx.JsonOpts));
    }
}
