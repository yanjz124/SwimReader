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
            var pending = new List<(int idx, string reg, string callsign, string dest, string date, DateTime? arr)>();

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
                    var depStr = Str(el, "actualDepartureTime");
                    DateTime? depT = Time(depStr);
                    // Gate/runway: the TDLS departure event nearest this flight's departure, from the
                    // persisted TDLS history (live TDLS forgets everything on restart); else what was
                    // captured into history at save time; else live TDLS.
                    string? gate = null, runway = null;
                    var near = depT ?? Time(Str(el, "lastSeen"));
                    if (near is { } n0 && TdlsGateIndex.Find(ctx.TdlsHistoryDir, origin, callsign, n0,
                            TimeSpan.FromHours(depT is null ? 10 : 3)) is { } tg)
                    { gate = tg.Gate; runway = tg.Runway; }
                    gate ??= Str(el, "gate") is { Length: > 0 } sg ? sg : null;
                    runway ??= Str(el, "runway") is { Length: > 0 } sr ? sr : null;
                    if (gate is null && near is { } n1 &&
                        ctx.Tdls.FindDepartureNear(origin, callsign, n1, TimeSpan.FromHours(3)) is { } lt)
                    { gate = lt.gate; runway ??= lt.runway; }

                    // Airline CDM gate times (TFMS): captured into history at save time, or live.
                    string gOut = Str(el, "gateOut"), gIn = Str(el, "gateIn"),
                           gOutS = Str(el, "gateOutSched"), gInS = Str(el, "gateInSched");
                    if (gOut.Length + gIn.Length + gOutS.Length + gInS.Length == 0 &&
                        ctx.Tfms.GateTimesFor(callsign, origin) is { } gt &&
                        (depT is null || gt.SchedOut is null || Math.Abs((gt.SchedOut.Value - depT.Value).TotalHours) < 12))
                    {
                        gOut = Iso(gt.Out); gIn = Iso(gt.In); gOutS = Iso(gt.SchedOut); gInS = Iso(gt.SchedIn);
                    }

                    seen.Add(callsign);
                    var (airl, fltnum) = ladd ? ("", "") : SplitCallsign(callsign);
                    var eta = Str(el, "eta");
                    if (!ladd && registration.Length > 0 && destination.Length > 0)
                        pending.Add((results.Count, registration, callsign, destination, date!,
                            Time(gIn) ?? Time(eta) ?? depT ?? near));
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
                        arrGate = (string?)null,     // filled below (inferred from the next leg)
                        arrGateFrom = (string?)null,
                        date,
                        // Timetable times: actual departure (SFDPS, ~9 in 10 flights) and ETA.
                        dep = depStr,
                        eta,
                        lastSeen = Str(el, "lastSeen"),
                        // TFMS airline gate times: airline out/in (estimate → actual), and scheduled out/in
                        gateOut = gOut, gateIn = gIn, gateOutSched = gOutS, gateInSched = gInS,
                    });
                }
            }

            // Arrival gate. No feed publishes arrival gates, so infer it from the airframe's NEXT
            // departure from the destination (the turn): same tail, leaving that airport within 12 h of
            // arriving — its TDLS departure gate is very likely where it parked. Only returned when the
            // next leg's gate is actually known.
            var rows = results.Cast<object>().ToList();
            if (pending.Count > 0)
            {
                var inferred = InferArrivalGates(ctx, dir, pending);
                foreach (var (idx, g, via) in inferred)
                    rows[idx] = WithArrGate(results[idx], g, via, ctx.JsonOpts);
            }

            return Results.Json(rows, ctx.JsonOpts);
        });
    }

    private static object WithArrGate(object row, string gate, string via, JsonSerializerOptions opts)
    {
        // Anonymous types are immutable — round-trip through a JSON node to set two fields.
        var node = System.Text.Json.Nodes.JsonNode.Parse(JsonSerializer.Serialize(row, opts))!.AsObject();
        node["arrGate"] = gate; node["arrGateFrom"] = via;
        return node;
    }

    private static List<(int idx, string gate, string via)> InferArrivalGates(ServerContext ctx, string dir,
        List<(int idx, string reg, string callsign, string dest, string date, DateTime? arr)> pending)
    {
        var outp = new List<(int, string, string)>();
        var regs = pending.Select(p => p.reg).ToHashSet(StringComparer.OrdinalIgnoreCase);

        // Next legs still live (not yet purged into history): the flight plan is on file, and TDLS may
        // already have its departure gate.
        var live = ctx.Flights.Values
            .Where(f => f.Registration is { Length: > 0 } r && regs.Contains(r) && !string.IsNullOrEmpty(f.Callsign))
            .Select(f => (reg: f.Registration!, cs: f.Callsign!, orig: f.Origin ?? "",
                          t: Time(f.ActualDepartureTime) ?? (DateTime?)null))
            .ToList();

        // Next legs already in history: that day's file and the next one.
        var dates = pending.SelectMany(p => new[] { p.date, NextDate(p.date) }).Distinct().ToList();
        var hist = new List<(string reg, string cs, string orig, DateTime? t, string gate)>();
        foreach (var date in dates)
        {
            if (!File.Exists(Path.Combine(dir, date + ".jsonl"))) continue;
            var idx = FlightHistoryIndex.GetOrBuild(dir, date);
            var cand = idx.Where(e => e.Registration.Length > 0 && regs.Contains(e.Registration)).Take(2000).ToList();
            if (cand.Count == 0) continue;
            foreach (var el in FlightHistoryIndex.ReadMatching(dir, date, cand, 2000))
                hist.Add((Str(el, "registration"), Str(el, "callsign"), Str(el, "origin"),
                          Time(Str(el, "actualDepartureTime")) ?? Time(Str(el, "lastSeen")), Str(el, "gate")));
        }

        foreach (var p in pending)
        {
            if (p.arr is not { } arr) continue;
            var lo = arr.AddMinutes(-20); var hi = arr.AddHours(12);
            // Earliest departure of this tail from the destination after it arrived.
            var nexts = hist.Where(h => h.reg.Equals(p.reg, StringComparison.OrdinalIgnoreCase) && AirportMatch(h.orig, p.dest)
                                        && h.t is { } t && t > lo && t < hi)
                            .Select(h => (h.cs, t: h.t!.Value, h.gate))
                .Concat(live.Where(l => l.reg.Equals(p.reg, StringComparison.OrdinalIgnoreCase) && AirportMatch(l.orig, p.dest)
                                        && (l.t is null ? DateTime.UtcNow < hi : l.t > lo && l.t < hi))
                            .Select(l => (l.cs, t: l.t ?? DateTime.UtcNow, gate: "")))
                .OrderBy(x => x.t)
                .ToList();
            foreach (var nx in nexts)
            {
                var g = TdlsGateIndex.Find(ctx.TdlsHistoryDir, p.dest, nx.cs, nx.t, TimeSpan.FromHours(4))?.Gate
                        ?? ctx.Tdls.FindDepartureNear(p.dest, nx.cs, nx.t, TimeSpan.FromHours(4))?.gate
                        ?? (nx.gate.Length > 0 ? nx.gate : null);
                if (g is { Length: > 0 } && !g.Equals("N/A", StringComparison.OrdinalIgnoreCase))
                {
                    outp.Add((p.idx, g, nx.cs));
                    break;
                }
                // The very next leg had no gate — don't reach past it to a later turn.
                break;
            }
        }
        return outp;
    }

    private static string NextDate(string date) =>
        DateTime.TryParse(date, out var d) ? d.AddDays(1).ToString("yyyy-MM-dd") : date;

    private static DateTime? Time(string? s) =>
        !string.IsNullOrEmpty(s) && DateTime.TryParse(s, null, System.Globalization.DateTimeStyles.AdjustToUniversal, out var t)
            ? t : null;

    private static string Iso(DateTime? t) => t?.ToString("o") ?? "";

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
