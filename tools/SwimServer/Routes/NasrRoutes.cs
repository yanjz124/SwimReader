namespace SwimServer;

/// <summary>
/// NASR data endpoints under /api/nasr/* and the route resolver at /api/route/{gufi}.
///
/// All endpoints return 503 when NASR data hasn't finished loading yet (it loads
/// asynchronously on startup) — caller is expected to retry. The /api/nasr/status
/// endpoint reports load progress.
/// </summary>
static class NasrRoutes
{
    public static void Register(WebApplication app, ServerContext ctx)
    {
        // REST API for resolved route waypoints
        app.MapGet("/api/route/{*gufi}", (string gufi) =>
        {
            var nasr = ctx.GetNasr();
            if (nasr is null)
                return Results.Json(new { waypoints = Array.Empty<double[]>(), debug = "NASR not loaded" }, ctx.JsonOpts);
            if (!ctx.Flights.TryGetValue(gufi, out var f))
                return Results.Json(new { waypoints = Array.Empty<double[]>(), debug = "Flight not found" }, ctx.JsonOpts);
            if (string.IsNullOrEmpty(f.Route))
                return Results.Json(new { waypoints = Array.Empty<double[]>(), debug = "No route string" }, ctx.JsonOpts);

            var key = $"{f.Origin}:{f.Destination}:{f.Route}";
            var wps = ctx.RouteCache.GetOrAdd(key, _ => ctx.ResolveRoute(f.Route, f.Origin, f.Destination, nasr));
            return Results.Json(new { waypoints = wps, route = f.Route, origin = f.Origin, destination = f.Destination }, ctx.JsonOpts);
        });

        // REST API for NASR data status
        app.MapGet("/api/nasr/status", () =>
        {
            var nasr = ctx.GetNasr();
            return Results.Json(new
            {
                loaded = nasr is not null,
                effectiveDate = nasr?.EffectiveDate,
                navaids = nasr?.Navaids.Count ?? 0,
                fixes = nasr?.Fixes.Count ?? 0,
                airports = nasr?.Airports.Count ?? 0,
                airways = nasr?.Airways.Count ?? 0,
                procedures = nasr?.Procedures.Count ?? 0,
                cachedRoutes = ctx.RouteCache.Count
            }, ctx.JsonOpts);
        });

        // NASR point lookup (fix/navaid/airport)
        app.MapGet("/api/nasr/find/{ident}", (string ident) =>
        {
            var nasr = ctx.GetNasr();
            if (nasr is null) return Results.Json(new { error = "NASR data not loaded" }, statusCode: 503);
            ident = ident.ToUpperInvariant();
            var pt = ctx.LookupPoint(ident, null, nasr);
            if (pt is null)
            {
                // Also try with K prefix for airports
                pt = ctx.LookupAirport(ident, nasr);
            }
            if (pt is null) return Results.Json(new { error = "NOT FOUND" }, statusCode: 404);
            return Results.Json(new { ident = pt.Ident, lat = pt.Lat, lon = pt.Lon }, ctx.JsonOpts);
        });

        // NASR airways — resolved to lat/lon polylines
        app.MapGet("/api/nasr/airways", (string? type) =>
        {
            var nasr = ctx.GetNasr();
            if (nasr is null) return Results.Json(new { error = "NASR data not loaded" }, statusCode: 503);
            var airways = nasr.Airways.Values.AsEnumerable();
            if (!string.IsNullOrEmpty(type))
            {
                var t = type.ToUpperInvariant();
                if (t == "HI" || t == "HIGH")
                    airways = airways.Where(a => a.Id.StartsWith("J", StringComparison.OrdinalIgnoreCase) ||
                                                 a.Id.StartsWith("Q", StringComparison.OrdinalIgnoreCase) ||
                                                 a.Id.StartsWith("T", StringComparison.OrdinalIgnoreCase));
                else if (t == "LO" || t == "LOW")
                    airways = airways.Where(a => a.Id.StartsWith("V", StringComparison.OrdinalIgnoreCase));
                else
                    airways = airways.Where(a => a.Id.StartsWith(t, StringComparison.OrdinalIgnoreCase));
            }
            var result = airways.Select(a =>
            {
                var pts = a.Fixes.Select(f => ctx.LookupPoint(f, null, nasr))
                    .Where(p => p is not null)
                    .Select(p => new[] { p!.Lat, p!.Lon })
                    .ToList();
                return new { id = a.Id, points = pts };
            }).Where(a => a.points.Count >= 2).ToList();
            return Results.Json(result, ctx.JsonOpts);
        });

        // NASR SID/STAR procedures for an airport
        app.MapGet("/api/nasr/procedures", (string airport, string? type) =>
        {
            var nasr = ctx.GetNasr();
            if (nasr is null) return Results.Json(new { error = "NASR data not loaded" }, statusCode: 503);
            airport = airport.ToUpperInvariant();
            // Strip K prefix for ICAO codes
            var faaId = airport.Length == 4 && airport.StartsWith("K") ? airport[1..] : airport;
            var procs = nasr.Procedures.Values.SelectMany(list => list)
                .Where(p =>
                {
                    var pApt = p.Airport.Length == 4 && p.Airport.StartsWith("K") ? p.Airport[1..] : p.Airport;
                    return pApt.Equals(faaId, StringComparison.OrdinalIgnoreCase);
                });
            if (!string.IsNullOrEmpty(type))
                procs = procs.Where(p => p.Type.Equals(type, StringComparison.OrdinalIgnoreCase));
            var result = procs.Select(p =>
            {
                var pts = p.Fixes.Select(f => ctx.LookupPoint(f, null, nasr))
                    .Where(pt => pt is not null)
                    .Select(pt => new[] { pt!.Lat, pt!.Lon })
                    .ToList();
                return new { id = p.Id, airport = p.Airport, type = p.Type, points = pts };
            }).Where(p => p.points.Count >= 2).ToList();
            return Results.Json(result, ctx.JsonOpts);
        });

        // Full procedure geometry for map overlay (all body legs + transitions)
        // Searches by airport code OR procedure base name; type filter: STAR or DP
        app.MapGet("/api/nasr/procgeo", (string q, string? type) =>
        {
            var nasr = ctx.GetNasr();
            if (nasr is null) return Results.Json(new { error = "NASR data not loaded" }, statusCode: 503);
            q = q.Trim().ToUpperInvariant();
            var faaId = q.Length == 4 && q.StartsWith("K") ? q[1..] : q;

            var matches = new List<ProcedureFullDef>();

            // Try airport match first
            foreach (var list in nasr.ProceduresFull.Values)
                foreach (var p in list)
                {
                    var pApt = p.Airport.Length == 4 && p.Airport.StartsWith("K") ? p.Airport[1..] : p.Airport;
                    if (pApt.Equals(faaId, StringComparison.OrdinalIgnoreCase))
                        matches.Add(p);
                }

            // If no airport match, search by procedure name
            if (matches.Count == 0)
            {
                foreach (var kv in nasr.ProceduresFull)
                {
                    if (kv.Key.Equals(q, StringComparison.OrdinalIgnoreCase))
                    {
                        matches.AddRange(kv.Value);
                        continue;
                    }
                    // Base name match: strip trailing digits, compare
                    var baseName = System.Text.RegularExpressions.Regex.Replace(kv.Key, @"\d+$", "");
                    if (baseName.Length > 0 && baseName.Equals(q, StringComparison.OrdinalIgnoreCase))
                        matches.AddRange(kv.Value);
                }
            }

            if (!string.IsNullOrEmpty(type))
                matches = matches.Where(p => p.Type.Equals(type, StringComparison.OrdinalIgnoreCase)).ToList();

            // Deduplicate by (Id, Airport) — same procedure registered under multiple keys
            matches = matches.GroupBy(p => (p.Id, p.Airport)).Select(g => g.First()).ToList();

            var result = matches.Select(p =>
            {
                var resolvedLegs = p.Legs.Select(leg =>
                {
                    NavPoint? lastPt = null;
                    var pts = new List<double[]>();
                    foreach (var fix in leg)
                    {
                        var pt = ctx.LookupPoint(fix, lastPt, nasr);
                        if (pt is not null) { pts.Add(new[] { pt.Lat, pt.Lon }); lastPt = pt; }
                    }
                    return pts;
                }).Where(pts => pts.Count >= 2).ToList();
                return new { id = p.Id, airport = p.Airport, type = p.Type, legs = resolvedLegs };
            }).Where(p => p.legs.Count > 0).ToList();

            return Results.Json(result, ctx.JsonOpts);
        });

        // NASR VOR/VORTAC navaids (for plotting circles) — excludes NDBs and fan markers
        app.MapGet("/api/nasr/navaids", () =>
        {
            var nasr = ctx.GetNasr();
            if (nasr is null) return Results.Json(new { error = "NASR data not loaded" }, statusCode: 503);
            // Return first non-NDB point for each navaid identifier (dedup same-name navaids)
            var result = nasr.Navaids
                .Where(kv => kv.Value.Any(n => !n.Type.Contains("NDB", StringComparison.OrdinalIgnoreCase)
                                            && !n.Type.Equals("FAN MARKER", StringComparison.OrdinalIgnoreCase)))
                .Select(kv =>
                {
                    var nav = kv.Value.First(n => !n.Type.Contains("NDB", StringComparison.OrdinalIgnoreCase)
                                               && !n.Type.Equals("FAN MARKER", StringComparison.OrdinalIgnoreCase));
                    return new { id = kv.Key, lat = nav.Lat, lon = nav.Lon };
                }).ToList();
            return Results.Json(result, ctx.JsonOpts);
        });

        app.MapGet("/api/nasr/airports", () =>
        {
            var nasr = ctx.GetNasr();
            if (nasr is null) return Results.Json(new { error = "NASR data not loaded" }, statusCode: 503);
            return Results.Json(nasr.AirportOverlay, ctx.JsonOpts);
        });

        app.MapGet("/api/nasr/centerlines", () =>
        {
            var nasr = ctx.GetNasr();
            if (nasr is null) return Results.Json(new { error = "NASR data not loaded" }, statusCode: 503);
            return Results.Json(nasr.Centerlines, ctx.JsonOpts);
        });
    }
}
