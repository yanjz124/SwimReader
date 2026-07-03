using System.Net;
using System.Text;

namespace SwimServer;

/// <summary>
/// Aggregates everything the server knows about a single callsign across every data source —
/// SFDPS en-route, TFMS flow, EDCT, TDLS/CPDLC, TAIS/STARS terminal, ASDE-X surface — for the
/// mobile "track my flight" page at /track. One GET returns a combined JSON snapshot; the page
/// polls it. A callsign can appear as several SFDPS GUFIs (one per ARTCC tracking it).
/// </summary>
static class TrackRoutes
{
    public static void Register(WebApplication app, ServerContext ctx)
    {
        app.MapGet("/api/track/{callsign}", (string callsign) =>
        {
            callsign = (callsign ?? "").Trim().ToUpperInvariant();
            if (callsign.Length == 0) return Results.BadRequest(new { error = "empty callsign" });

            // Frequency lookup for any "FAC/SECTOR": exact match, else (STARS TCPs like
            // "3B") retry with the trailing sub-position letter stripped → "FAC/3".
            Func<string, string?> lookupFreq = key =>
            {
                return FreqOf(ctx, key);
            };
            Func<string?, string?, string?> secFreq = (fac, sec) =>
                (!string.IsNullOrEmpty(fac) && !string.IsNullOrEmpty(sec)) ? lookupFreq(fac + "/" + sec) : null;

            // freqs: every sector referenced anywhere (controlling, handoff, point-out,
            // STARS owner) → freq. The page appends it wherever a "FAC/SECTOR" is shown.
            var freqs = new Dictionary<string, string>();
            void AddFreqKey(string? key)
            {
                if (string.IsNullOrEmpty(key) || freqs.ContainsKey(key)) return;
                var v = lookupFreq(key.Trim());
                if (v != null) freqs[key.Trim()] = v;
            }

            // SFDPS — en-route flight(s). Multiple GUFIs possible (one per ARTCC).
            var sfdps = new List<object>();
            string? edct = null;
            var hoEvents = new List<(string time, string source, string centre, string summary)>();
            foreach (var f in ctx.Flights.Values)
            {
                if (!string.Equals(f.Callsign, callsign, StringComparison.OrdinalIgnoreCase)) continue;
                if (f.FlightStatus == "CANCELLED") continue;
                string? hoFreq = null;
                if (!string.IsNullOrEmpty(f.HandoffReceiving)) { var hp = f.HandoffReceiving.Split('/'); if (hp.Length == 2) hoFreq = secFreq(hp[0], hp[1]); }
                sfdps.Add(SfdpsProjection(f, secFreq(f.ControllingFacility, f.ControllingSector), hoFreq));
                if (!string.IsNullOrEmpty(f.ControllingFacility) && !string.IsNullOrEmpty(f.ControllingSector)) AddFreqKey(f.ControllingFacility + "/" + f.ControllingSector);
                foreach (var u in new[] { f.HandoffReceiving, f.HandoffTransferring, f.PointoutOriginatingUnit, f.PointoutReceivingUnit })
                    if (!string.IsNullOrEmpty(u)) foreach (var part in u.Split(',')) AddFreqKey(part);
                if (edct is null && !string.IsNullOrEmpty(f.EdctTime)) edct = f.EdctTime;
                foreach (var e in f.GetAllEvents())
                    if (HandoffSources.Contains(e.Source))
                        hoEvents.Add((e.Time, e.Source, e.Centre, e.Summary));
            }
            // STARS terminal ownership (TAIS owner-TCP) → position frequency, best-effort.
            foreach (var (fac, owner) in ctx.Tais.OwnersByCallsign(callsign)) AddFreqKey(fac + "/" + owner);
            // Handoff/point-out history across all GUFIs — deduped, newest first.
            var handoffHistory = hoEvents
                .GroupBy(x => x.time + "|" + x.source + "|" + x.summary).Select(g => g.First())
                .OrderByDescending(x => x.time)
                .Take(30)
                .Select(x => new { time = x.time, source = x.source, centre = x.centre, summary = x.summary })
                .ToList();

            var tdls  = ctx.Tdls.FindByCallsign(callsign);
            var tais  = ctx.Tais.FindByCallsign(callsign);
            var asdex = ctx.Asdex.FindByCallsign(callsign);
            var tfms  = ctx.Tfms.GetFlightByCallsign(callsign);

            var found = sfdps.Count > 0 || tdls.Count > 0 || tais.Count > 0 || asdex.Count > 0 || tfms is not null;

            return Results.Json(new
            {
                callsign,
                found,
                ts = DateTime.UtcNow.ToString("o"),
                sfdps,
                freqs,
                tfms,
                edct,
                handoffHistory,
                tdls,
                tais,
                asdex,
            }, ctx.JsonOpts);
        });

        // Ultra-light, no-JS, server-rendered text version for constrained/inflight wifi.
        // Auto-refreshes via a meta tag; ~2 KB; works with JS disabled.
        app.MapGet("/t", (HttpContext c) => TextPage(ctx, c.Request.Query["cs"].FirstOrDefault()));
        app.MapGet("/t/{callsign:regex(^[A-Za-z0-9]+$)}", (string callsign) => TextPage(ctx, callsign));
    }

    // SFDPS message sources that represent a handoff or point-out event (for the history timeline).
    private static readonly HashSet<string> HandoffSources =
        new(StringComparer.OrdinalIgnoreCase) { "OH", "HP", "AH", "HU", "HX", "HF", "HV", "RH", "DH", "PT", "HT" };

    // Lean per-flight projection (no events/history) with the fields the track page needs:
    // full ICAO flight plan, ownership/handoff, position, clearance, times — enough to render
    // the flight-plan card and the mock ERAM/STARS data blocks.
    private static object SfdpsProjection(FlightState f, string? sectorFreq, string? handoffFreq) => new
    {
        gufi = f.Gufi, callsign = f.Callsign, cid = f.ComputerId, status = f.FlightStatus,
        sectorFreq, handoffFreq,
        cids = f.ComputerIds.IsEmpty ? null : new Dictionary<string, string>(f.ComputerIds),
        // flight plan / identity
        origin = f.Origin, dest = f.Destination, alternate = f.AlternateAerodrome,
        acType = f.AircraftType, wake = f.WakeCategory, equip = f.EquipmentQualifier,
        registration = f.Registration, rules = f.FlightRules, flightType = f.FlightType,
        route = f.Route, originalRoute = f.OriginalRoute, star = f.STAR, remarks = f.Remarks,
        oper = f.Operator, originator = f.Originator,
        // ICAO field 10/18 capabilities
        pbn = f.PBNCode, nav = f.NavigationCode, comm = f.CommunicationCode, surv = f.SurveillanceCode,
        otherNav = f.OtherNavigationCapabilities, otherComm = f.OtherCommunicationCapabilities,
        otherSurv = f.OtherSurveillanceCapabilities, otherDataLink = f.OtherDataLink,
        dataLink = f.DataLinkCode, selcal = f.SELCAL, perf = f.AircraftPerformance,
        eet = f.EstimatedElapsedTimes,
        // altitude
        assignedAlt = f.AssignedAltitude, assignedVfr = f.AssignedVfr,
        blockFloor = f.BlockFloor, blockCeil = f.BlockCeiling,
        interimAlt = f.InterimAltitude, reportedAlt = f.ReportedAltitude,
        reqAlt = f.RequestedAltitude, reqSpeed = f.RequestedSpeed,
        // position / ownership
        lat = f.Latitude, lon = f.Longitude, gs = f.GroundSpeed,
        reportingFacility = f.ReportingFacility, controllingFacility = f.ControllingFacility,
        controllingSector = f.ControllingSector,
        handoffEvent = f.HandoffEvent, handoffReceiving = f.HandoffReceiving, handoffTransferring = f.HandoffTransferring,
        pointoutOrig = f.PointoutOriginatingUnit, pointoutRecv = f.PointoutReceivingUnit,
        squawk = f.Squawk, assignedSquawk = f.AssignedSquawk, coast = f.CoastIndicator,
        // clearance (HSF)
        clrHeading = f.ClearanceHeading, clrSpeed = f.ClearanceSpeed, clrText = f.ClearanceText,
        // times
        depTime = f.ActualDepartureTime, eta = f.ETA, edct = f.EdctTime,
        coordTime = f.CoordinationTime, coordFix = f.CoordinationFix,
        lastMsg = f.LastMsgSource,
        posAgeSec = f.LastPositionTime == default ? (int?)null : (int)(DateTime.UtcNow - f.LastPositionTime).TotalSeconds,
        lastSeen = f.LastSeen.ToString("o"),
    };

    // Frequency for a "FAC/SECTOR" — ERAM sector (e.g. ZDC/32) or STARS TCP code
    // (subset+sectorId, e.g. PCT/1J), both keyed exactly as vNAS/TAIS report them.
    private static string? FreqOf(ServerContext ctx, string? key)
    {
        if (string.IsNullOrEmpty(key)) return null;
        return ctx.SectorFreqs.TryGetValue(key.Trim(), out var v) ? v : null;
    }

    // ── Text-only version (/t) ────────────────────────────────────────────────
    private static List<FlightState> Matching(ServerContext ctx, string cs) =>
        ctx.Flights.Values.Where(f => string.Equals(f.Callsign, cs, StringComparison.OrdinalIgnoreCase) && f.FlightStatus != "CANCELLED").ToList();

    private static string He(string? s) => WebUtility.HtmlEncode(s ?? "");
    private static void AddU(List<string> l, string? x) { if (!string.IsNullOrEmpty(x) && !l.Contains(x)) l.Add(x); }
    private static string Hm(string? iso)
    {
        if (string.IsNullOrEmpty(iso)) return "";
        return DateTime.TryParse(iso, null, System.Globalization.DateTimeStyles.AdjustToUniversal, out var d) ? d.ToString("HHmm") + "Z" : iso;
    }
    private static string? Fl(double? a) => a == null ? null : "FL" + Math.Round(a.Value / 100);
    private static string AltText(FlightState f)
    {
        if (f.AssignedVfr) return "VFR" + (f.ReportedAltitude != null ? " / at " + Fl(f.ReportedAltitude) : "");
        if (f.BlockFloor != null && f.BlockCeiling != null) return $"block {Fl(f.BlockFloor)}-{Fl(f.BlockCeiling)}";
        var p = new List<string>();
        if (f.AssignedAltitude != null) p.Add("assigned " + Fl(f.AssignedAltitude));
        if (f.InterimAltitude != null) p.Add("interim " + Fl(f.InterimAltitude));
        if (f.ReportedAltitude != null) p.Add("at " + Fl(f.ReportedAltitude));
        return p.Count > 0 ? string.Join(" · ", p) : "—";
    }
    private static string HoStatus(string e)
    {
        e = e.ToUpperInvariant();
        if (e.Contains("ACCEPT")) return "ACCEPTED (transferring)";
        if (e.Contains("INITIAT") || e.Contains("PROPOS")) return "PENDING (proposed)";
        if (e.Contains("EXECUT")) return "EXECUTING";
        if (e.Contains("RETRACT")) return "RETRACTED";
        if (e.Contains("FAIL")) return "FAILED";
        return e;
    }
    private static string EramText(FlightState f)
    {
        var cid = (f.ControllingFacility != null && f.ComputerIds.TryGetValue(f.ControllingFacility, out var c)) ? c : (f.ComputerId ?? "----");
        string aFL = f.AssignedAltitude != null ? ((int)Math.Round(f.AssignedAltitude.Value / 100)).ToString("000") : "";
        string rFL = f.ReportedAltitude != null ? ((int)Math.Round(f.ReportedAltitude.Value / 100)).ToString("000") : "";
        string l2 = aFL.Length > 0 ? (rFL.Length > 0 && Math.Abs(int.Parse(aFL) - int.Parse(rFL)) > 2 ? $"{aFL}{(int.Parse(rFL) < int.Parse(aFL) ? "^" : "v")}{rFL}" : aFL + "C") : (rFL.Length > 0 ? rFL : "---");
        string fe = f.GroundSpeed != null ? Math.Round(f.GroundSpeed.Value).ToString() : "";
        if (!string.IsNullOrEmpty(f.HandoffEvent) && !string.IsNullOrEmpty(f.HandoffReceiving))
        {
            var sec = f.HandoffReceiving; var i = sec.IndexOf('/'); if (i >= 0) sec = sec[(i + 1)..];
            fe = (f.HandoffEvent.ToUpperInvariant().Contains("ACCEPT") ? "O" : "H") + sec + " (=" + fe + ")";
        }
        string dest = f.Destination != null && f.Destination.Length == 4 && f.Destination[0] == 'K' ? f.Destination[1..] : (f.Destination ?? "");
        return $"{f.Callsign}\n{l2}\n{cid} {fe}\n{dest}";
    }
    private static void Row(StringBuilder sb, string k, string? v) { if (!string.IsNullOrEmpty(v)) sb.Append(He(k)).Append(": ").Append(He(v)).Append("<br>"); }

    private static IResult TextPage(ServerContext ctx, string? cs)
    {
        cs = (cs ?? "").Trim().ToUpperInvariant();
        var sb = new StringBuilder(2048);
        sb.Append("<!doctype html><html><head><meta charset=utf-8><meta name=viewport content=\"width=device-width,initial-scale=1\">");
        if (cs.Length > 0) sb.Append("<meta http-equiv=refresh content=30>");
        sb.Append("<title>").Append(cs.Length > 0 ? He(cs) : "Track").Append("</title>");
        sb.Append("<style>body{background:#000;color:#cc4;font:14px/1.55 monospace;margin:8px;max-width:680px}h2{font-size:12px;color:#888;border-bottom:1px solid #333;margin:15px 0 5px;letter-spacing:1px}b{color:#fff}.w{color:#f80}.g{color:#4c4}pre{white-space:pre-wrap;margin:5px 0;color:#cc4}a{color:#4af}input{background:#111;color:#cc4;border:1px solid #444;padding:8px;text-transform:uppercase;width:9em}button{background:#123;color:#bcf;border:1px solid #356;padding:8px 12px}.rt{color:#dda;word-break:break-all}</style>");
        sb.Append("</head><body>");
        sb.Append("<form action=/t><input name=cs value=\"").Append(He(cs)).Append("\" placeholder=CALLSIGN> <button>TRACK</button>");
        if (cs.Length > 0) sb.Append(" &nbsp;<a href=/track/").Append(He(cs)).Append(">full page</a>");
        sb.Append("</form>");

        if (cs.Length == 0) { sb.Append("<p style=color:#888>Enter a callsign to follow a flight.<br>This is the light text-only version (no JS, auto-refresh 30s) for slow / inflight wifi.</p></body></html>"); return Results.Content(sb.ToString(), "text/html; charset=utf-8"); }

        var flights = Matching(ctx, cs);
        var tdls = ctx.Tdls.FindByCallsign(cs); var tais = ctx.Tais.FindByCallsign(cs); var asdex = ctx.Asdex.FindByCallsign(cs);
        var tfms = ctx.Tfms.GetFlightByCallsign(cs);
        var ho = new List<FlightEvent>();
        string? edct = null;
        foreach (var f in flights) { foreach (var e in f.GetAllEvents()) if (HandoffSources.Contains(e.Source)) ho.Add(e); if (edct == null && !string.IsNullOrEmpty(f.EdctTime)) edct = f.EdctTime; }

        if (flights.Count == 0 && tdls.Count == 0 && tais.Count == 0 && asdex.Count == 0 && tfms == null)
        { sb.Append("<p class=w>Nothing is tracking ").Append(He(cs)).Append(" right now.</p></body></html>"); return Results.Content(sb.ToString(), "text/html; charset=utf-8"); }

        var best = flights.OrderBy(f => f.Latitude.HasValue ? 0 : 1)
            .ThenBy(f => f.LastPositionTime == default ? 9999 : (DateTime.UtcNow - f.LastPositionTime).TotalSeconds).FirstOrDefault();

        sb.Append("<div style=font-size:20px;color:#fff;margin:8px 0 2px>").Append(He(cs)).Append("</div>");
        var org = best?.Origin; var dst = best?.Destination;
        sb.Append("<div>").Append(He(string.IsNullOrEmpty(org) ? "????" : org)).Append(" &#9656; ").Append(He(string.IsNullOrEmpty(dst) ? "????" : dst));
        if (!string.IsNullOrEmpty(best?.AircraftType)) sb.Append(" · ").Append(He(best!.AircraftType));
        sb.Append("</div>");

        if (flights.Count > 0)
        {
            sb.Append("<h2>POSITION / OWNERSHIP</h2>");
            var artccs = new List<string>();
            foreach (var f in flights) { AddU(artccs, f.ControllingFacility); AddU(artccs, f.ReportingFacility); foreach (var k in f.ComputerIds.Keys) AddU(artccs, k); }
            sb.Append("Tracked by: <b>").Append(He(string.Join(" ", artccs))).Append("</b>");
            foreach (var f in flights)
            {
                sb.Append("<div style=margin-top:7px><b>").Append(He(f.ControllingFacility ?? "?"));
                if (f.ControllingSector != null) sb.Append("/").Append(He(f.ControllingSector));
                sb.Append("</b>");
                var cid = (f.ControllingFacility != null && f.ComputerIds.TryGetValue(f.ControllingFacility, out var cc)) ? cc : f.ComputerId;
                if (!string.IsNullOrEmpty(cid)) sb.Append(" CID ").Append(He(cid));
                var freq = FreqOf(ctx, (f.ControllingFacility ?? "") + "/" + (f.ControllingSector ?? ""));
                if (freq != null) sb.Append(" &#183; <b>").Append(He(freq)).Append("</b>");
                sb.Append("<br>");
                if (!string.IsNullOrEmpty(f.HandoffEvent))
                {
                    var hrFreq = FreqOf(ctx, f.HandoffReceiving);
                    sb.Append("<span class=w>Handoff ").Append(He(HoStatus(f.HandoffEvent))).Append(": ").Append(He(f.HandoffTransferring ?? "?")).Append(" &#9656; ").Append(He(f.HandoffReceiving ?? "?"));
                    if (hrFreq != null) sb.Append(" (").Append(He(hrFreq)).Append(")");
                    sb.Append("</span><br>");
                }
                sb.Append(He(AltText(f)));
                if (f.GroundSpeed != null) sb.Append(" · ").Append((int)Math.Round(f.GroundSpeed.Value)).Append(" kt");
                if (!string.IsNullOrEmpty(f.Squawk)) sb.Append(" · sqk ").Append(He(f.Squawk));
                sb.Append("<br>");
                if (f.Latitude != null) sb.Append("Pos ").Append(f.Latitude.Value.ToString("F3")).Append(", ").Append(f.Longitude!.Value.ToString("F3")).Append("<br>");
                if (!f.ComputerIds.IsEmpty) sb.Append("CIDs ").Append(He(string.Join("  ", f.ComputerIds.Select(kv => kv.Key + ":" + kv.Value)))).Append("<br>");
                sb.Append("</div>");
            }
        }

        if (best != null) sb.Append("<h2>ERAM DATA BLOCK</h2><pre>").Append(He(EramText(best))).Append("</pre>");

        var taisOwners = ctx.Tais.OwnersByCallsign(cs).GroupBy(x => x.facility + "/" + x.owner).Select(g => g.First()).ToList();
        if (taisOwners.Count > 0)
        {
            sb.Append("<h2>STARS (TERMINAL)</h2>");
            foreach (var (fac, owner) in taisOwners)
            {
                sb.Append("<b>").Append(He(fac)).Append("/").Append(He(owner)).Append("</b>");
                var tf = FreqOf(ctx, fac + "/" + owner);
                if (tf != null) sb.Append(" &#183; <b>").Append(He(tf)).Append("</b>");
                sb.Append("<br>");
            }
        }

        if (ho.Count > 0)
        {
            sb.Append("<h2>HANDOFF HISTORY</h2>");
            foreach (var e in ho.GroupBy(x => x.Time + x.Summary).Select(g => g.First()).OrderByDescending(x => x.Time).Take(12))
                sb.Append(He(Hm(e.Time))).Append(" <span class=g>").Append(He(e.Source)).Append("</span> ").Append(He(e.Summary)).Append("<br>");
        }

        if (!string.IsNullOrEmpty(edct)) sb.Append("<h2>EDCT</h2>Controlled departure <b>").Append(He(Hm(edct))).Append("</b>");

        if (best != null)
        {
            sb.Append("<h2>FLIGHT PLAN</h2>");
            Row(sb, "Rules", best.FlightRules); Row(sb, "Altitude", AltText(best)); Row(sb, "Alternate", best.AlternateAerodrome);
            Row(sb, "PBN", best.PBNCode); Row(sb, "Equip", best.EquipmentQualifier); Row(sb, "SELCAL", best.SELCAL);
            Row(sb, "EET", best.EstimatedElapsedTimes);
            var route = best.OriginalRoute ?? best.Route;
            if (!string.IsNullOrEmpty(route)) sb.Append("Route:<br><span class=rt>").Append(He(route)).Append("</span><br>");
        }

        var extra = new List<string>();
        if (tdls.Count > 0) extra.Add("TDLS(" + tdls.Count + ")");
        if (tais.Count > 0) extra.Add("STARS(" + tais.Count + ")");
        if (asdex.Count > 0) extra.Add("ASDE-X(" + asdex.Count + ")");
        if (tfms != null) extra.Add("TFMS");
        if (extra.Count > 0) sb.Append("<h2>ALSO IN</h2>").Append(He(string.Join(" · ", extra))).Append(" — <a href=/track/").Append(He(cs)).Append(">full page has detail</a>");

        sb.Append("<p style=color:#555;margin-top:16px>text mode · auto-refresh 30s · ").Append(DateTime.UtcNow.ToString("HHmm")).Append("Z</p></body></html>");
        return Results.Content(sb.ToString(), "text/html; charset=utf-8");
    }
}
