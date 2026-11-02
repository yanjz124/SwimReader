namespace SwimServer;

/// <summary>
/// TBFM metering endpoints. The ERAM scope polls <c>/api/tbfm/eram</c> for the STA / DELAY RDBs;
/// <c>/api/tbfm/debug</c> exposes raw samples and the element names seen, for checking the parser's
/// field mapping against the live feed (see <see cref="TbfmBridge"/>).
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

        app.MapGet("/api/tbfm/debug", () => Results.Json(ctx.Tbfm.DebugSnapshot(), ctx.JsonOpts));
    }
}
