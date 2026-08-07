namespace SwimServer;

/// <summary>
/// Scratchpad collector — a table of every live TAIS/STARS track's controller data
/// (primary + secondary scratchpads, owner, entry/exit fix, runway, origin/dest, handoff)
/// with the filed route merged in from SFDPS. Scratchpads carry gate/runway/route intent,
/// so this is a one-glance view of what every terminal facility is doing.
///
/// The route is trimmed to the relevant end: departures (outbound) show the first few route
/// elements (the departure path); arrivals (inbound) show the last few (the arrival path).
/// Direction comes from TAIS entry/exit fixes — a departure leaves the TRACON via an exit
/// fix, an arrival enters via an entry fix.
/// </summary>
static class ScratchpadRoutes
{
    private const int RouteKeep = 5;

    public static void Register(WebApplication app, ServerContext ctx)
    {
        app.MapGet("/scratchpads", (HttpContext c) =>
        {
            c.Response.ContentType = "text/html";
            return c.Response.SendFileAsync(Path.Combine(ctx.WebRootPath, "scratchpads", "index.html"));
        });

        app.MapGet("/api/scratchpads", (HttpContext http) =>
        {
            var reveal = LaddService.Reveal(http);

            // callsign → filed SFDPS route (first non-empty seen). Built once per request.
            var routeByCs = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var f in ctx.Flights.Values)
            {
                if (string.IsNullOrWhiteSpace(f.Callsign) || string.IsNullOrWhiteSpace(f.Route)) continue;
                if (!routeByCs.ContainsKey(f.Callsign!)) routeByCs[f.Callsign!] = f.Route!;
            }

            var rows = new List<object>();
            foreach (var (facility, t) in ctx.Tais.AllTracks())
            {
                if (string.IsNullOrWhiteSpace(t.Callsign)) continue;

                var dir = Direction(t, facility);
                routeByCs.TryGetValue(t.Callsign!, out var route);

                rows.Add(new
                {
                    facility,
                    // Mask only the identity (callsign) for LADD; scratchpads/route are
                    // operational data, consistent with the other feeds.
                    callsign = LaddService.MaskCallsign(t.Callsign, null, reveal),
                    acType = t.AircraftType,
                    wake = t.WakeCategory,
                    rules = t.FlightRules,
                    dir,                                   // "OUT" | "IN" | "?"
                    origin = t.Origin,
                    dest = t.Destination,
                    sp1 = t.Scratchpad1,                   // primary scratchpad
                    sp2 = t.Scratchpad2,                   // secondary scratchpad
                    runway = t.Runway,
                    owner = t.Owner,                       // CPS controller
                    entryFix = t.EntryFix,
                    exitFix = t.ExitFix,
                    squawk = t.ReportedSquawk,
                    assigned = t.AssignedSquawk,
                    handoff = t.PendingHandoff,
                    // Route trimmed to the relevant end (out → first N, in → last N fixes).
                    routeKey = RouteKey(route, dir),
                    route,                                 // full filed route (for expand)
                    ageSec = (int)(DateTime.UtcNow - t.LastSeen).TotalSeconds,
                });
            }

            return Results.Json(rows, ctx.JsonOpts);
        });
    }

    // Departure vs arrival. TAIS sets BOTH entry and exit fixes on nearly every track (they
    // mark where it crosses the TRACON boundary), so those can't distinguish. Vertical rate is
    // the clean signal — a departure is climbing, an arrival descending — and isn't position.
    // For level flights, fall back to matching origin/destination against the facility's own
    // airport (works for single-airport TRACONs like BHM=KBHM); overflights stay unknown.
    private static string Direction(TaisTrack t, string facility)
    {
        int vr = t.VerticalRateFpm ?? 0;
        if (vr >= 250) return "OUT";
        if (vr <= -250) return "IN";

        bool destLocal = AirportMatchesFacility(t.Destination, facility);
        bool origLocal = AirportMatchesFacility(t.Origin, facility);
        if (destLocal && !origLocal) return "IN";
        if (origLocal && !destLocal) return "OUT";
        return "?";
    }

    private static bool AirportMatchesFacility(string? airport, string? facility)
    {
        if (string.IsNullOrWhiteSpace(airport) || string.IsNullOrWhiteSpace(facility)) return false;
        var a = airport.Trim().ToUpperInvariant();
        if (a.Length == 4 && (a[0] == 'K' || a[0] == 'P')) a = a[1..];
        return string.Equals(a, facility.Trim().ToUpperInvariant(), StringComparison.Ordinal);
    }

    // Trim the route string to the relevant end: first N elements for a departure, last N for
    // an arrival. Splits on the usual route separators and drops DCT.
    private static string? RouteKey(string? route, string dir)
    {
        if (string.IsNullOrWhiteSpace(route)) return null;
        var toks = route.Split(new[] { ' ', '.', '\t', '\n' }, StringSplitOptions.RemoveEmptyEntries)
                        .Where(x => !x.Equals("DCT", StringComparison.OrdinalIgnoreCase))
                        .ToArray();
        if (toks.Length == 0) return null;
        var sel = dir == "IN" ? toks.Skip(Math.Max(0, toks.Length - RouteKeep)) : toks.Take(RouteKeep);
        return string.Join(" ", sel);
    }
}
