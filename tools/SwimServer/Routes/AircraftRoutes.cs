namespace SwimServer;

/// <summary>
/// Aircraft database API — search the airframes SwimReader has seen on the live SWIM feed, by tail
/// number, ICAO 24 hex, SELCAL, callsign, operator or type. Identities are LADD-masked unless the
/// request carries the reveal key (same gate as the rest of the site).
/// </summary>
static class AircraftRoutes
{
    public static void Register(WebApplication app, AircraftDb db)
    {
        app.MapGet("/api/aircraft/stats", () => Results.Json(new { count = db.Count }));

        app.MapGet("/api/aircraft/search", (HttpContext c, string? q, int? limit) =>
        {
            var query = (q ?? "").Trim();
            if (query.Length < 1) return Results.Json(new { query = "", count = 0, results = Array.Empty<object>() });
            bool reveal = LaddService.Reveal(c);
            int lim = Math.Clamp(limit ?? 50, 1, 200);
            var hits = db.Search(query, lim, reveal);
            return Results.Json(new
            {
                query,
                count = hits.Count,
                results = hits.Select(r => db.ToJson(r, reveal, detail: false)).ToArray(),
            });
        });

        app.MapGet("/api/aircraft/{id}", (HttpContext c, string id) =>
        {
            bool reveal = LaddService.Reveal(c);
            var rec = db.Get(id);
            return rec is null ? Results.NotFound() : Results.Json(db.ToJson(rec, reveal, detail: true));
        });
    }
}
