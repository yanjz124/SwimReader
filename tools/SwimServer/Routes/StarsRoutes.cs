namespace SwimServer;

/// <summary>
/// STARS frontend routes: the scope SPA + vNAS profile REST.
///
/// Phase 1 ships: facility-picker landing page, scope page, vNAS profile
/// API. Subsequent phases append video map / track stream / DCB / etc.
/// </summary>
static class StarsRoutes
{
    public static void Register(WebApplication app, ServerContext ctx)
    {
        // Landing page: ARTCC + facility picker
        app.MapGet("/stars", async (HttpContext c) =>
        {
            c.Response.ContentType = "text/html";
            await c.Response.SendFileAsync(Path.Combine(ctx.WebRootPath, "stars", "index.html"));
        });

        // Scope page: /stars/{artcc}/{facility}
        app.MapGet("/stars/{artcc:regex(^[A-Za-z0-9]+$)}/{facility:regex(^[A-Za-z0-9]+$)}",
            async (HttpContext c, string artcc, string facility) =>
            {
                c.Response.ContentType = "text/html";
                await c.Response.SendFileAsync(Path.Combine(ctx.WebRootPath, "stars", "scope.html"));
            });

        // ── vNAS profile REST ────────────────────────────────────────────────
        app.MapGet("/api/stars/artccs", async () =>
        {
            var ids = await ctx.Stars.GetArtccIdsAsync();
            return Results.Json(ids, ctx.JsonOpts);
        });

        app.MapGet("/api/stars/artcc/{artccId}", async (string artccId) =>
        {
            var fac = await ctx.Stars.GetStarsFacilitiesAsync(artccId);
            return fac is not null ? Results.Json(fac, ctx.JsonOpts) : Results.NotFound();
        });

        app.MapGet("/api/stars/facility/{artccId}/{facilityId}",
            async (string artccId, string facilityId) =>
            {
                var fac = await ctx.Stars.GetFacilityAsync(artccId, facilityId);
                return fac is not null ? Results.Json(fac, ctx.JsonOpts) : Results.NotFound();
            });
    }
}
