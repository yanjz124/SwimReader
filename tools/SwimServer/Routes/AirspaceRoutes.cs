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

        // ERAM Fixed Airspace Volumes from vNAS. Registered BEFORE "/api/airspace/{facility}" so
        // the literal "favs" can't be taken for a facility id (same rule as /asdex/ws/{airport}).
        app.MapGet("/api/airspace/favs", () => Results.Json(ctx.EramAirspace.Status(), ctx.JsonOpts));

        // Whole-center lateral boundaries, one Polygon per ARTCC (properties.id), ~32 KB. Served
        // verbatim from vNAS's own ArtccBoundaries.geojson. There is deliberately no altitude
        // filter: unlike a FAV, an ARTCC boundary has no high/low variants to choose between.
        // Registered before "/api/airspace/{facility}" for the same reason "favs" is.
        app.MapGet("/api/airspace/artcc-boundaries", () =>
            ctx.EramAirspace.ArtccBoundaries() is { } geo
                ? Results.Content(geo, "application/geo+json")
                : Results.NotFound(new { error = "ARTCC boundaries not fetched yet" }));

        // GeoJSON for one ARTCC. ?lowFt=&highFt= keeps only the modules overlapping that band —
        // which is the whole point of FAVs over the KML: a sector's shape changes with altitude.
        app.MapGet("/api/airspace/favs/{artcc}", (string artcc, int? lowFt, int? highFt,
                                                  string? sector, bool? sentinel) =>
            ctx.EramAirspace.GeoJson(artcc.Trim().ToUpperInvariant(), lowFt, highFt, sector,
                                     sentinel ?? false) is { } g
                ? Results.Json(g, ctx.JsonOpts)
                : Results.NotFound(new { error = $"no FAV data held for {artcc.ToUpperInvariant()}" }));

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
