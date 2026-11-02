namespace SwimServer;

/// <summary>
/// Airline research API: carrier directory, per-carrier network / fleet / intel, per-tail flights, and airport
/// coordinates. LADD-blocked tails are left out unless the request carries the reveal key.
/// </summary>
static class AirlineRoutes
{
    public static void Register(WebApplication app, AirlineResearch research, AirportDirectory airports)
    {
        app.MapGet("/api/airlines/status", () => Results.Json(research.Status()));

        app.MapGet("/api/airlines", (HttpContext c, int? days) =>
            Results.Bytes(research.DirectoryJson(research.ClampDays(days), LaddService.Reveal(c)), "application/json"));

        app.MapGet("/api/airlines/{icao}", (HttpContext c, string icao, int? days) =>
        {
            var json = research.CarrierJson(icao, research.ClampDays(days), LaddService.Reveal(c));
            return json is null ? Results.NotFound() : Results.Bytes(json, "application/json");
        });

        app.MapGet("/api/airlines/tails/{key}", (HttpContext c, string key, int? days) =>
        {
            var json = research.TailJson(key, research.ClampDays(days), LaddService.Reveal(c));
            return json is null ? Results.NotFound() : Results.Bytes(json, "application/json");
        });

        // Coordinates for a comma-separated list of flight-plan airport codes (ICAO, FAA or IATA).
        app.MapGet("/api/airports/find", (string? codes) =>
        {
            var list = (codes ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Distinct(StringComparer.OrdinalIgnoreCase).Take(500)
                .Select(code =>
                {
                    var a = airports.Find(code);
                    return new { code, name = a?.Name, city = a?.City, country = a?.Country, lat = a?.Lat, lon = a?.Lon };
                });
            return Results.Json(new { count = airports.Count, airports = list });
        });

        // Which airport identifiers in our hand-maintained config no longer resolve.
        //
        // Nothing can guess a rename — but an identifier that has stopped meaning anything is worth
        // surfacing rather than silently matching nothing, which is what PBI did in
        // destination-codes.json after it became DJT: the ERAM destination letter just stopped
        // appearing, with no error anywhere. Run this after a NASR/OurAirports cycle.
        app.MapGet("/api/airports/audit", () =>
        {
            var files = new[] { "destination-codes.json", "handoff-codes.json" };
            var root = app.Environment.WebRootPath
                       ?? Path.Combine(Directory.GetCurrentDirectory(), "wwwroot");
            var report = new List<object>();
            foreach (var name in files)
            {
                var path = Path.Combine(root, name);
                if (!File.Exists(path)) { report.Add(new { file = name, error = "not found" }); continue; }
                var unknown = new List<object>();
                int seen = 0;
                try
                {
                    using var doc = System.Text.Json.JsonDocument.Parse(File.ReadAllText(path));
                    // Both files are {facility: {letter: [ids…]}}; we only care about the leaf ids.
                    foreach (var fac in doc.RootElement.EnumerateObject())
                    {
                        if (fac.Value.ValueKind != System.Text.Json.JsonValueKind.Object) continue;
                        foreach (var entry in fac.Value.EnumerateObject())
                        {
                            if (entry.Value.ValueKind != System.Text.Json.JsonValueKind.Array) continue;
                            foreach (var el in entry.Value.EnumerateArray())
                            {
                                if (el.GetString() is not { Length: > 0 } id) continue;
                                seen++;
                                if (airports.Find(id) is null)
                                    unknown.Add(new { facility = fac.Name, key = entry.Name, id });
                            }
                        }
                    }
                }
                catch (Exception ex) { report.Add(new { file = name, error = ex.Message }); continue; }
                report.Add(new { file = name, idsChecked = seen, unknown = unknown.Count, entries = unknown });
            }
            return Results.Json(new { directoryLoaded = airports.Count, files = report });
        });
    }
}
