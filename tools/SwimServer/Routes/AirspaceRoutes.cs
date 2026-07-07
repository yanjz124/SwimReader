namespace SwimServer;

static class AirspaceRoutes
{
    public static void Register(WebApplication app, ServerContext ctx)
    {
        app.MapGet("/api/airspace", () =>
        {
            var all = ctx.Airspace.GetAll();
            return Results.Json(new
            {
                facilities = all.Select(m => new
                {
                    facility = m.Facility,
                    updatedAt = m.UpdatedAt,
                    source = m.Source,
                    positionCount = m.Positions.Length,
                    ageMinutes = Math.Round((DateTime.UtcNow - m.UpdatedAt).TotalMinutes, 1),
                }),
            }, ctx.JsonOpts);
        });

        app.MapGet("/api/airspace/{facility}", (string facility) =>
        {
            var map = ctx.Airspace.Get(facility);
            if (map is null)
                return Results.Json(new { facility = facility.ToUpperInvariant(), positions = Array.Empty<object>(), sectorToGroup = new Dictionary<string, string>() }, ctx.JsonOpts);
            return Results.Json(map, ctx.JsonOpts);
        });

        app.MapGet("/api/debug/aixm", () => Results.Json(ctx.Airspace.DebugInfo(), ctx.JsonOpts));

        app.MapGet("/api/debug/aixm/sample", () =>
        {
            var xml = ctx.Airspace.GetSampleXml();
            if (xml is null) return Results.NotFound(new { error = "no AIXM sample captured yet" });
            return Results.Content(xml, "application/xml");
        });
    }
}
