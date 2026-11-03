namespace SwimServer;

/// <summary>
/// Airline research API: carrier directory, per-carrier network / fleet / intel, per-tail flights, and airport
/// coordinates. LADD-blocked tails are left out unless the request carries the reveal key.
/// </summary>
static class AirlineRoutes
{
    public static void Register(WebApplication app, AirlineResearch research, AirportDirectory airports,
                                Func<NasrData?> getNasr)
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

        // Which airport identifiers in our hand-maintained config have stopped meaning anything.
        //
        // An identifier that no longer resolves matches nothing and reports no error — which is
        // exactly what PBI did in destination-codes.json after it became DJT: the ERAM destination
        // letter simply stopped appearing.
        //
        // NASR is the authority here, not OurAirports. These files hold FAA LIDs and NASR is the
        // FAA's own list, which has already dropped PBI — whereas OurAirports still resolves it,
        // because a retired code lives on as the airport's IATA code. Checking OurAirports alone
        // (the first attempt) sailed straight past the rename that prompted this.
        //
        // So: NASR decides whether an id is stale, and OurAirports — which does still recognize
        // the old code — is then asked what it has become, giving a replacement to apply rather
        // than just a complaint. Re-run after a NASR cycle (28 days).
        app.MapGet("/api/airports/audit", () =>
        {
            var nasr = getNasr();
            // NASR not loaded yet: say so rather than reporting every id as stale.
            if (nasr is null)
                return Results.Json(new { error = "nasr_not_loaded", retry = true });

            bool KnownToNasr(string id)
            {
                var u = id.ToUpperInvariant();
                if (nasr.AirportInfo.ContainsKey(u) || nasr.AirportInfoIcao.ContainsKey(u)) return true;
                // K-prefixed ICAO vs bare FAA LID, in both directions.
                if (u.Length == 4 && u[0] == 'K' && nasr.AirportInfo.ContainsKey(u[1..])) return true;
                if (u.Length == 3 && nasr.AirportInfoIcao.ContainsKey("K" + u)) return true;
                return false;
            }

            // What is the airport at this spot called now?
            //
            // Follow POSITION, not identifier. The identifier is the thing in question — and
            // OurAirports proves why: it renamed KPBI's airport but kept the old ident, so
            // "what does OurAirports call it" answers with the very code we're trying to replace.
            // The NASR record sitting at the same coordinates is the current id, whatever it is,
            // which works for the next rename without knowing anything about this one.
            string? NasrIdAt(double lat, double lon)
            {
                string? best = null;
                double bestNm = 1.5;        // airports don't move; anything further is a different field
                foreach (var (lid, p) in nasr.Airports)
                {
                    var dLat = (p.Lat - lat) * 60.0;
                    var dLon = (p.Lon - lon) * 60.0 * Math.Cos(lat * Math.PI / 180);
                    var nm = Math.Sqrt(dLat * dLat + dLon * dLon);
                    if (nm < bestNm) { bestNm = nm; best = lid; }
                }
                return best;
            }
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
                                if (KnownToNasr(id)) continue;
                                // Stale. What did it become? OurAirports still carries the retired
                                // code, so it can point at the current airport.
                                var a = airports.Find(id);
                                var replacement = a is null ? null : NasrIdAt(a.Lat, a.Lon);
                                unknown.Add(new
                                {
                                    facility = fac.Name,
                                    key = entry.Name,
                                    id,
                                    nowKnownAs = replacement,
                                    name = replacement is not null
                                           && nasr.AirportInfo.TryGetValue(replacement, out var ri)
                                               ? ri.Name : a?.Name,
                                    note = a is null
                                        ? "unknown to NASR and to OurAirports — likely decommissioned or a typo"
                                        : replacement is null
                                            ? "unknown to NASR; no NASR airport at its coordinates either"
                                            : $"retired — the field at these coordinates is now {replacement}",
                                });
                            }
                        }
                    }
                }
                catch (Exception ex) { report.Add(new { file = name, error = ex.Message }); continue; }
                report.Add(new { file = name, idsChecked = seen, unknown = unknown.Count, entries = unknown });
            }
            return Results.Json(new
            {
                nasrAirports = nasr.AirportInfo.Count,
                directoryLoaded = airports.Count,
                files = report,
            });
        });
    }
}
