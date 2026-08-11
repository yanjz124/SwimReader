using System.Text.Json;

namespace SwimServer;

/// <summary>
/// Flight-sim route finder ("dispatch"). Searches persisted flight-history for
/// real flights matching a route / airline / aircraft type and returns dispatch-
/// ready records (callsign, filed route, cruise, airframe, gate) that the front
/// end can hand to SimBrief or a VATSIM prefile.
///
/// Reuses the existing flight-history index (callsign / origin / destination /
/// registration indexed; aircraft type filtered on the loaded record) across the
/// last N day-files, dedupes by callsign, and enriches with the live TDLS gate.
/// </summary>
static class DispatchRoutes
{
    public static void Register(WebApplication app, ServerContext ctx)
    {
        // GET /api/dispatch/search?orig=&dest=&airline=&type=&days=&limit=
        //   orig/dest  — airport code (ICAO or FAA; K/P-prefix tolerant)
        //   airline    — ICAO 3-letter operator (callsign prefix, e.g. AAL, UAL)
        //   type       — aircraft ICAO type (e.g. B738, A320); substring match
        //   days       — how many recent day-files to search (1-7, default 3)
        //   limit      — max results (default 60, max 200)
        app.MapGet("/api/dispatch/search", (string? orig, string? dest, string? airline,
            string? type, int? days, int? limit, HttpContext http) =>
        {
            var reveal = LaddService.Reveal(http);
            var dir = ctx.HistoryDir;
            if (!Directory.Exists(dir)) return Results.Json(Array.Empty<object>(), ctx.JsonOpts);

            orig = Norm(orig); dest = Norm(dest);
            var air = Norm(airline); var acType = Norm(type);
            if (orig.Length == 0 && dest.Length == 0 && air.Length == 0 && acType.Length == 0)
                return Results.Json(new { error = "give at least one of orig/dest/airline/type" }, ctx.JsonOpts);

            int dayN = Math.Clamp(days ?? 3, 1, 7);
            int cap = Math.Clamp(limit ?? 60, 1, 200);

            // Newest day-files first so the most recent instance of a callsign wins the dedup.
            var dates = Directory.GetFiles(dir, "*.jsonl")
                .Select(Path.GetFileNameWithoutExtension)
                .Where(d => d is not null && d != "pinned")
                .OrderByDescending(d => d)
                .Take(dayN)
                .ToList();

            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);   // callsign dedup
            var results = new List<object>();

            foreach (var date in dates)
            {
                if (results.Count >= cap) break;
                var index = FlightHistoryIndex.GetOrBuild(dir, date!);

                var candidates = index.Where(e =>
                    (orig.Length == 0 || AirportMatch(e.Origin, orig)) &&
                    (dest.Length == 0 || AirportMatch(e.Destination, dest)) &&
                    (air.Length == 0 || e.Callsign.StartsWith(air, StringComparison.OrdinalIgnoreCase)) &&
                    e.Callsign.Length > 0 && !seen.Contains(e.Callsign))
                    .Take(1000)
                    .ToList();
                if (candidates.Count == 0) continue;

                var records = FlightHistoryIndex.ReadMatching(dir, date!, candidates, 1000);
                foreach (var el in records)
                {
                    if (results.Count >= cap) break;
                    var callsign = Str(el, "callsign");
                    if (callsign.Length == 0 || seen.Contains(callsign)) continue;
                    // LADD: a blocked flight is masked (not dropped) — show it as "LADD"
                    // with no identifying registration, unless this request has the bypass.
                    var registration = Str(el, "registration");
                    bool ladd = LaddService.ShouldMask(callsign, registration, reveal);

                    // Prefer the pilot's FILED route (before ATC/ERAM amendments) — the ERAM
                    // "route" is expanded with radials/fixes (…OTT248017…) that don't refile cleanly.
                    var route = Str(el, "originalRoute");
                    if (route.Length == 0) route = Str(el, "route");
                    if (route.Length == 0) continue;                       // want a filable plan
                    var recType = Str(el, "aircraftType");
                    if (acType.Length > 0 && !recType.Contains(acType, StringComparison.OrdinalIgnoreCase)) continue;

                    var origin = Str(el, "origin");
                    var destination = Str(el, "destination");
                    // Gate/runway: prefer what was captured into history at save time (works for
                    // old flights); fall back to live TDLS for flights still in the current session.
                    string? gate = Str(el, "gate") is { Length: > 0 } sg ? sg : null;
                    string? runway = Str(el, "runway") is { Length: > 0 } sr ? sr : null;
                    if (gate is null)
                    {
                        var td = ctx.Tdls.FindAircraft(origin, callsign);
                        if (td is { } t) { gate = t.gate; runway ??= t.runway; }
                    }

                    seen.Add(callsign);
                    var (airl, fltnum) = ladd ? ("", "") : SplitCallsign(callsign);
                    results.Add(new
                    {
                        callsign = ladd ? LaddService.Label : callsign,
                        airline = airl,
                        fltnum,
                        orig = origin,
                        dest = destination,
                        type = recType,
                        reg = ladd ? "" : registration,
                        wake = Str(el, "wakeCategory"),
                        equip = Str(el, "equipmentQualifier"),
                        rules = Str(el, "flightRules"),
                        route,
                        // FILED cruise, not the last-known ERAM altitude: pilot's requested → first
                        // ATC-assigned (snapshotted) → current assigned as a last resort.
                        cruise = Num(el, "requestedAltitude") ?? Num(el, "originalAssignedAltitude") ?? Num(el, "assignedAltitude"),
                        altn = Str(el, "alternateAerodrome"),
                        star = Str(el, "STAR"),
                        remarks = Str(el, "remarks"),
                        // ICAO field 10/18 bits for a complete plan
                        nav = Str(el, "navigationCode"),
                        surv = Str(el, "surveillanceCode"),
                        pbn = Str(el, "pbnCode"),
                        datalink = Str(el, "dataLinkCode"),
                        gate,
                        runway,
                        date,
                        lastSeen = Str(el, "lastSeen")
                    });
                }
            }

            return Results.Json(results, ctx.JsonOpts);
        });
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    private static string Norm(string? s) => (s ?? "").Trim().ToUpperInvariant();

    private static string Str(JsonElement el, string name) =>
        el.TryGetProperty(name, out var p) && p.ValueKind == JsonValueKind.String
            ? (p.GetString() ?? "") : "";

    private static double? Num(JsonElement el, string name) =>
        el.TryGetProperty(name, out var p) && p.ValueKind == JsonValueKind.Number
            ? p.GetDouble() : (double?)null;

    // Airport code matches if equal, or across ICAO K/P prefix (KORD == ORD, PHNL == HNL).
    private static bool AirportMatch(string field, string query)
    {
        if (field.Equals(query, StringComparison.OrdinalIgnoreCase)) return true;
        if (field.Length == 4 && (field[0] == 'K' || field[0] == 'P') &&
            field.AsSpan(1).Equals(query.AsSpan(), StringComparison.OrdinalIgnoreCase)) return true;
        if (query.Length == 4 && (query[0] == 'K' || query[0] == 'P') &&
            field.AsSpan().Equals(query.AsSpan(1), StringComparison.OrdinalIgnoreCase)) return true;
        return false;
    }

    // "AAL1234" -> ("AAL","1234"); "N123AB" -> ("",""). Airline = leading letters when
    // followed by digits and 2-3 chars (ICAO telephony); otherwise treat as GA (no split).
    private static (string airline, string fltnum) SplitCallsign(string cs)
    {
        int i = 0;
        while (i < cs.Length && char.IsLetter(cs[i])) i++;
        if (i < 2 || i > 3 || i >= cs.Length) return ("", "");
        var rest = cs[i..];
        foreach (var c in rest) if (!char.IsLetterOrDigit(c)) return ("", "");
        // fltnum is the digit-run; keep trailing letters (e.g. AAL123A) out of fltnum
        int j = 0; while (j < rest.Length && char.IsDigit(rest[j])) j++;
        if (j == 0) return ("", "");
        return (cs[..i].ToUpperInvariant(), rest[..j]);
    }
}
