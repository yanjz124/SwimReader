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
    }
}
