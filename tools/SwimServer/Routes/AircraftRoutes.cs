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
        app.MapGet("/api/aircraft/stats", () => Results.Json(new
        {
            count = db.Count,
            flightLog = new
            {
                backfillDone = db.Log.BackfillDone,
                backfillTotal = db.Log.BackfillTotal,
                backfillRunning = db.Log.BackfillRunning,
                // One-off pass that recovers registrations for rows written before the log stored them.
                repair = db.Log.RepairState,
                repairDetail = db.Log.LastRepair,
                repairDaysLeft = db.Log.RepairDaysLeft,
            },
        }));

        // Permanent dated flight log for one tail — oldest first, duplicates across ARTCCs merged.
        app.MapGet("/api/aircraft/{id}/flights", (HttpContext c, string id) =>
        {
            bool reveal = LaddService.Reveal(c);
            var rec = db.Get(id);
            if (rec is null || (!reveal && LaddService.IsBlocked(null, rec.Registration, rec.Icao24)))
                return Results.NotFound();
            var flights = db.FlightsFor(rec);
            return Results.Json(new
            {
                total = flights.Count,
                flights = flights.Select(e => new { dep = e.Dep, first = e.First, last = e.Last, cs = e.Cs, o = e.O, d = e.D }),
            });
        });

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

        // Browse as a table: filter (optional) + sort + page. total lets the client show "X–Y of Z".
        // Paged/filtered API access. field = all|registration|icao24|selcal|callsign|operator|type;
        // wake = J|H|M|L. (The /aircraft page itself loads /api/aircraft/all and works in the browser.)
        app.MapGet("/api/aircraft/list", (HttpContext c, string? q, string? field, string? wake,
            string? sort, string? dir, int? offset, int? limit) =>
        {
            bool reveal = LaddService.Reveal(c);
            int off = Math.Max(0, offset ?? 0);
            int lim = Math.Clamp(limit ?? 100, 1, 500);
            string s = sort ?? "lastSeen";
            bool desc = !string.Equals(dir, "asc", StringComparison.OrdinalIgnoreCase);
            var (total, page) = db.Browse(q, field, wake, s, desc, off, lim, reveal);
            return Results.Json(new
            {
                total, offset = off, limit = lim, sort = s, dir = desc ? "desc" : "asc",
                results = page.Select(r => db.ToJson(r, reveal, detail: false)).ToArray(),
            });
        });

        // The whole table in one compact, cached payload — the page sorts/filters it client-side.
        app.MapGet("/api/aircraft/all", (HttpContext c) =>
            Results.Bytes(db.AllCompactJson(LaddService.Reveal(c)), "application/json"));

        app.MapGet("/api/aircraft/{id}", (HttpContext c, string id) =>
        {
            bool reveal = LaddService.Reveal(c);
            var rec = db.Get(id);
            return rec is null ? Results.NotFound() : Results.Json(db.ToJson(rec, reveal, detail: true));
        });
    }
}
