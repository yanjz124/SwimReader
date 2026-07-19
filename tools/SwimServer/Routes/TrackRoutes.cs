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
                // Map SFDPS TRACON NAS codes (e.g. ORT) to real ids (C90), scoped by reporting ARTCC.
                var ctrlTracon = ResolveTracon(ctx, f.ReportingFacility, f.ControllingFacility);
                var ctrlFac = ctrlTracon ?? f.ControllingFacility;
                string? hoFreq = null, hoRecvMapped = null;
                if (!string.IsNullOrEmpty(f.HandoffReceiving))
                {
                    var (recvText, recvTracon) = MapFacToken(ctx, f.ReportingFacility, f.HandoffReceiving);
                    hoRecvMapped = recvTracon != null ? recvText : null;
                    var hp = recvText.Split('/'); if (hp.Length == 2) hoFreq = secFreq(hp[0], hp[1]);
                }
                sfdps.Add(SfdpsProjection(f, secFreq(ctrlFac, f.ControllingSector), hoFreq, ctrlTracon, hoRecvMapped));
                if (!string.IsNullOrEmpty(ctrlFac) && !string.IsNullOrEmpty(f.ControllingSector)) AddFreqKey(ctrlFac + "/" + f.ControllingSector);
                foreach (var u in new[] { f.HandoffReceiving, hoRecvMapped, f.HandoffTransferring, f.PointoutOriginatingUnit, f.PointoutReceivingUnit })
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
            // Frequencies for every sector named in the history summaries too.
            foreach (var h in handoffHistory)
                foreach (System.Text.RegularExpressions.Match mm in System.Text.RegularExpressions.Regex.Matches(h.summary ?? "", @"[A-Z]{2,4}/[0-9A-Z]{1,3}"))
                    AddFreqKey(mm.Value);

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
    private static object SfdpsProjection(FlightState f, string? sectorFreq, string? handoffFreq,
        string? controllingTracon = null, string? handoffReceivingMapped = null) => new
    {
        gufi = f.Gufi, callsign = f.Callsign, cid = f.ComputerId, status = f.FlightStatus,
        sectorFreq, handoffFreq,
        // Real TRACON id for an SFDPS NAS code (null when unmapped/an ARTCC sector); raw code stays in controllingFacility.
        controllingTracon, handoffReceivingMapped,
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
        key = key.Trim();
        if (ctx.SectorFreqs.TryGetValue(key, out var v)) return v;
        // Numeric sectors may differ only by a leading zero (SFDPS "ZOB/01" vs vNAS "ZOB/1").
        var i = key.IndexOf('/');
        if (i > 0 && i < key.Length - 1)
        {
            var fac = key[..i]; var sec = key[(i + 1)..];
            if (sec.Length > 0 && sec.All(char.IsDigit))
            {
                var stripped = sec.TrimStart('0'); if (stripped.Length == 0) stripped = "0";
                foreach (var alt in new[] { stripped, stripped.PadLeft(2, '0') })
                    if (alt != sec && ctx.SectorFreqs.TryGetValue(fac + "/" + alt, out var v2)) return v2;
            }
        }
        return null;
    }

    // Map an SFDPS controlling/handoff facility NAS code (e.g. "ORT") to the real TRACON id ("C90"),
    // scoped by the reporting ARTCC — the code is only unique within that ARTCC's ERAM adaptation.
    // Returns null when unmapped (an ARTCC sector, or a facility the reporting ARTCC didn't adapt).
    private static string? ResolveTracon(ServerContext ctx, string? reportingFacility, string? code) =>
        !string.IsNullOrEmpty(reportingFacility) && !string.IsNullOrEmpty(code)
        && ctx.TraconIds.TryGetValue(reportingFacility + "/" + code, out var id) ? id : null;

    // Rewrite the facility half of a "FAC/SEC" token (e.g. "ORT/1J" → "C90/1J") when it maps to a
    // TRACON; leaves ARTCC sectors and unmapped codes untouched. Returns (display, mapped-or-null).
    private static (string text, string? tracon) MapFacToken(ServerContext ctx, string? reportingFacility, string facSlashSec)
    {
        var i = facSlashSec.IndexOf('/');
        var fac = i > 0 ? facSlashSec[..i] : facSlashSec;
        var tracon = ResolveTracon(ctx, reportingFacility, fac);
        return tracon == null ? (facSlashSec, null) : (tracon + (i > 0 ? facSlashSec[i..] : ""), tracon);
    }

    // Annotate each "FAC/SECTOR" token in free text with its frequency, if known.
    private static string AnnotateFreqs(ServerContext ctx, string? text) =>
        string.IsNullOrEmpty(text) ? "" : System.Text.RegularExpressions.Regex.Replace(
            text, @"[A-Z]{2,4}/[0-9A-Z]{1,3}",
            m => { var f = FreqOf(ctx, m.Value); return f != null ? m.Value + " [" + f + "]" : m.Value; });

    // ── Text-only version (/t) ────────────────────────────────────────────────
    private static List<FlightState> Matching(ServerContext ctx, string cs) =>
        ctx.Flights.Values.Where(f => string.Equals(f.Callsign, cs, StringComparison.OrdinalIgnoreCase) && f.FlightStatus != "CANCELLED").ToList();

    // Pick the flight record that represents the *current* leg. A callsign is reused across the
    // day (e.g. ORD-BNA earlier, then ORD-XNA), and a just-landed prior leg lingers in memory with
    // a stale position; ordering by "has position" would surface that dead leg and show its
    // destination (KBNA) for the flight actually sitting at the gate (KXNA). So prefer a live
    // (non-DROPPED) record, then the freshest-updated one — the active leg always updates most
    // recently, whether it's airborne or a proposed plan being amended pre-departure.
    private static FlightState? BestFlight(List<FlightState> flights) => flights
        .OrderBy(f => f.FlightStatus == "DROPPED" ? 1 : 0)
        .ThenByDescending(f => f.LastSeen)
        .FirstOrDefault();

    private static string Trunc(string s, int max) => s.Length <= max ? s : s[..(max - 1)] + "…";

    // One STARS track per facility (freshest), so a flight straddling two TRACONs shows both — but a
    // facility that re-sends the same track many times doesn't spam. Capped at 3 facilities.
    private static IEnumerable<TaisTrack> StarsTracks(List<TaisTrack> tracks) => tracks
        .GroupBy(t => t.Facility)
        .Select(g => g.OrderByDescending(t => t.LastSeen).First())
        .OrderByDescending(t => t.LastSeen)
        .Take(3);

    private static string FmtAlt(double feet)
    {
        int hundreds = (int)Math.Round(feet / 100.0);
        return feet >= 18000 ? "FL" + hundreds.ToString("000") : (hundreds * 100).ToString("#,0") + " ft";
    }

    /// Concise plain-text status for the Telegram bot (same aggregation the /t page uses).
    /// Kept short so it fits one chat message and works over inflight free-messaging wifi.
    internal static string TelegramSummary(ServerContext ctx, string cs, string? prevRoute = null)
    {
        cs = (cs ?? "").Trim().ToUpperInvariant();
        if (cs.Length == 0) return "Send a callsign, e.g. AAL123";
        var flights = Matching(ctx, cs);
        var tdlsAc = ctx.Tdls.AircraftByCallsign(cs);
        var taisTracks = ctx.Tais.TracksByCallsign(cs);
        var asdexTracks = ctx.Asdex.TracksByCallsign(cs);
        var tfms = ctx.Tfms.FindByCallsign(cs);
        if (flights.Count == 0 && tdlsAc.Count == 0 && taisTracks.Count == 0 && asdexTracks.Count == 0 && tfms == null)
            return $"Nothing is tracking {cs} right now.";

        var best = BestFlight(flights);
        var tais0 = taisTracks.FirstOrDefault();
        var asd0 = asdexTracks.FirstOrDefault();

        var sb = new StringBuilder(256);
        sb.Append("✈ ").Append(cs).Append('\n');
        var org = best?.Origin ?? tais0?.Origin ?? asd0?.FpOrigin ?? tfms?.DepArpt;
        var dst = best?.Destination ?? tais0?.Destination ?? asd0?.FpDestination ?? tfms?.ArrArpt;
        var type = best?.AircraftType ?? tais0?.AircraftType ?? asd0?.AircraftType ?? tfms?.AircraftType;
        sb.Append(string.IsNullOrEmpty(org) ? "????" : org).Append(" ▸ ").Append(string.IsNullOrEmpty(dst) ? "????" : dst);
        if (!string.IsNullOrEmpty(type)) sb.Append(" · ").Append(type + (string.IsNullOrEmpty(best?.EquipmentQualifier) ? "" : "/" + best!.EquipmentQualifier)); // FAA equipment suffix (e.g. /L), not wake
        sb.Append('\n');

        sb.Append("Phase: ").Append(PhaseOf(best, asd0, tais0).label).Append('\n');

        // Next frequency (en-route SFDPS handoff, else STARS/TAIS pending handoff)
        var hoF = flights.FirstOrDefault(f => !string.IsNullOrEmpty(f.HandoffEvent) && !string.IsNullOrEmpty(f.HandoffReceiving));
        if (hoF != null)
        {
            var (recv, tracon) = MapFacToken(ctx, hoF.ReportingFacility, hoF.HandoffReceiving!);
            var rf = FreqOf(ctx, recv);
            sb.Append("Next: ").Append(recv).Append(tracon != null ? " (" + hoF.HandoffReceiving + ")" : "").Append(rf != null ? " · " + rf : "").Append('\n');
        }
        else if (tais0 != null && !string.IsNullOrEmpty(tais0.PendingHandoff))
        {
            var recv = tais0.Facility + "/" + tais0.PendingHandoff; var rf = FreqOf(ctx, recv);
            sb.Append("Next: ").Append(recv).Append(rf != null ? " · " + rf : "").Append('\n');
        }

        // Current controlling sector + frequency (+ CID). SFDPS reports a TRACON's NAS code (e.g.
        // "ORT") — map it to the real id ("C90") scoped by reportingFacility, keeping the raw code shown.
        if (best != null && !string.IsNullOrEmpty(best.ControllingFacility))
        {
            var tracon = ResolveTracon(ctx, best.ReportingFacility, best.ControllingFacility);
            var fac = tracon ?? best.ControllingFacility!;
            var now = fac + (string.IsNullOrEmpty(best.ControllingSector) ? "" : "/" + best.ControllingSector);
            var nf = FreqOf(ctx, now);
            var cid = (best.ControllingFacility != null && best.ComputerIds.TryGetValue(best.ControllingFacility, out var cc)) ? cc : best.ComputerId;
            sb.Append("Now: ").Append(now).Append(tracon != null ? " (" + best.ControllingFacility + ")" : "").Append(nf != null ? " · " + nf : "").Append(!string.IsNullOrEmpty(cid) ? " · CID " + cid : "").Append('\n');
        }

        // Altitude (assigned/reported + climb/descent trend) and Line-4 HSF (heading/speed/free text)
        if (best != null)
        {
            var at = AltText(best);
            if (!string.IsNullOrEmpty(at)) sb.Append("Alt: ").Append(at).Append('\n');
            var l4 = HsfText(best);
            if (!string.IsNullOrEmpty(l4)) sb.Append("Line 4: ").Append(l4).Append('\n');
            if (!string.IsNullOrEmpty(best.PointoutOriginatingUnit) || !string.IsNullOrEmpty(best.PointoutReceivingUnit))
                sb.Append("Point-out: ").Append(best.PointoutOriginatingUnit ?? "?").Append(" ▸ ").Append(best.PointoutReceivingUnit ?? "?").Append('\n');
        }

        // Route (SFDPS, else ASDE-X flight-plan route). If it changed since we last pushed, show the
        // previous route underneath so a follower sees the amendment.
        var route = best?.Route ?? asd0?.FpRoute;
        if (!string.IsNullOrEmpty(route))
        {
            sb.Append("Route: ").Append(Trunc(route, 200)).Append('\n');
            if (!string.IsNullOrEmpty(prevRoute) && prevRoute != route)
                sb.Append("  (was: ").Append(Trunc(prevRoute, 200)).Append(")\n");
        }

        // Ground speed / squawk / coast
        var parts = new List<string>();
        var gs = best?.GroundSpeed ?? (tais0?.GroundSpeedKnots is int gk ? (double?)gk : null);
        if (gs is > 0) parts.Add((int)gs + " kt");
        var sq = best?.Squawk ?? asd0?.Squawk;
        if (!string.IsNullOrEmpty(sq)) parts.Add("sq " + sq);
        if (!string.IsNullOrEmpty(best?.AssignedSquawk) && best!.AssignedSquawk != best.Squawk) parts.Add("asgn " + best.AssignedSquawk);
        if (best?.CoastIndicator == true) parts.Add("COAST");
        if (parts.Count > 0) sb.Append(string.Join(" · ", parts)).Append('\n');

        // Position + age
        if (best?.Latitude is double la && best?.Longitude is double lo)
        {
            var age = best.LastPositionTime == default ? "" : " · " + (int)(DateTime.UtcNow - best.LastPositionTime).TotalSeconds + "s ago";
            sb.Append($"Pos: {la:0.000}, {lo:0.000}{age}").Append('\n');
        }
        if (!string.IsNullOrEmpty(best?.ETA)) sb.Append("ETA: ").Append(Hm(best!.ETA)).Append('\n');

        // Terminal (STARS/TAIS) — one line per facility (a flight can be in two TRACONs during a
        // handoff, e.g. SBN then C90, and each carries its own owner/handoff). Owner is the STARS
        // TCP/position ID (e.g. "1Z"), not a facility; handoff state comes from <ocr>. Entry/exit
        // fixes are labelled so they're never mistaken for the destination airport.
        foreach (var t in StarsTracks(taisTracks))
        {
            var tf = FreqOf(ctx, t.Facility + "/" + (t.Owner ?? ""));
            sb.Append("STARS ").Append(t.Facility);
            if (!string.IsNullOrEmpty(t.Owner)) sb.Append(" · owner ").Append(t.Owner).Append(tf != null ? " " + tf : "");
            if (!string.IsNullOrEmpty(t.HandoffOcr) && t.HandoffOcr != "no change") sb.Append(" · ").Append(t.HandoffOcr);
            var tm = new List<string>();
            if (!string.IsNullOrEmpty(t.EntryFix) || !string.IsNullOrEmpty(t.ExitFix)) tm.Add("gates " + (t.EntryFix ?? "—") + "▸" + (t.ExitFix ?? "—"));
            var spd = string.Join(" ", new[] { t.Scratchpad1, t.Scratchpad2 }.Where(x => !string.IsNullOrEmpty(x)));
            if (!string.IsNullOrEmpty(spd)) tm.Add("SP " + spd);
            if (!string.IsNullOrEmpty(t.Runway)) tm.Add("RWY " + t.Runway);
            if (tm.Count > 0) sb.Append(" · ").Append(string.Join(" · ", tm));
            sb.Append('\n');
        }

        // TDLS: most recent clearance/departure line
        var tdls0 = tdlsAc.FirstOrDefault();
        if (tdls0 != null)
        {
            var m = tdls0.MessagesTyped().OrderByDescending(x => x.Time).FirstOrDefault();
            if (m != null)
            {
                if (m.Type == "DEPART")
                {
                    var dp = new List<string>();
                    if (!string.IsNullOrEmpty(m.Gate)) dp.Add("Gate " + m.Gate);
                    if (!string.IsNullOrEmpty(m.TakeoffRunway)) dp.Add("RWY " + m.TakeoffRunway);
                    sb.Append("TDLS DEP: ").Append(dp.Count > 0 ? string.Join(" · ", dp) : m.Time.ToString("HHmm") + "Z").Append('\n');
                }
                else sb.Append("TDLS CPDLC @ ").Append(m.Time.ToString("HHmm")).Append("Z\n");
            }
        }

        // Surface (ASDE-X): gate / runway
        if (asd0 != null)
        {
            var surf = new List<string>();
            if (!string.IsNullOrEmpty(asd0.TdlsGate)) surf.Add("gate " + asd0.TdlsGate);
            if (!string.IsNullOrEmpty(asd0.TdlsRunway)) surf.Add("rwy " + asd0.TdlsRunway);
            if (surf.Count > 0) sb.Append("Surface: ").Append(string.Join(" · ", surf)).Append('\n');
        }

        var edct = flights.Select(f => f.EdctTime).FirstOrDefault(e => !string.IsNullOrEmpty(e));
        if (!string.IsNullOrEmpty(edct)) sb.Append("EDCT: ").Append(Hm(edct)).Append('\n');

        // Sources present
        var srcs = new List<string>();
        if (flights.Count > 0) srcs.Add("SFDPS");
        if (tfms != null) srcs.Add("TFMS");
        if (tdlsAc.Count > 0) srcs.Add("TDLS");
        if (taisTracks.Count > 0) srcs.Add("STARS");
        if (asdexTracks.Count > 0) srcs.Add("ASDE-X");
        if (srcs.Count > 0) sb.Append("in: ").Append(string.Join(" · ", srcs));

        return sb.ToString().TrimEnd();
    }

    /// The route the summary would currently display for a callsign — so the push loop can remember
    /// it and show "previous vs new" when it changes. Same source order as the summary's Route line.
    internal static string? TelegramRoute(ServerContext ctx, string cs)
    {
        cs = (cs ?? "").Trim().ToUpperInvariant();
        return BestFlight(Matching(ctx, cs))?.Route ?? ctx.Asdex.TracksByCallsign(cs).FirstOrDefault()?.FpRoute;
    }

    /// A signature of only the *meaningful* state — for the Telegram push loop to decide whether
    /// anything worth notifying changed. We push only on genuine flight-plan / control events
    /// (handoffs, point-outs, Line-4 HSF, EDCT, squawk assignment, status, STARS, TDLS), NOT on
    /// position, ground speed, or altitude drift. Altitude is deliberately excluded entirely
    /// (assigned, interim, and reported all move without being "news" for a follower).
    ///
    /// The flight is selected *stably* (by controlling-facility presence then GUFI, never by
    /// freshest position): when several centres track the same callsign, a position-freshness pick
    /// would flip between GUFIs every scan and churn the sector/handoff fields — which read to the
    /// user as spurious "position/altitude" notifications. Stable selection kills that.
    internal static string TelegramChangeKey(ServerContext ctx, string cs)
    {
        cs = (cs ?? "").Trim().ToUpperInvariant();
        var flights = Matching(ctx, cs);
        var taisTracks = ctx.Tais.TracksByCallsign(cs);
        var asdexTracks = ctx.Asdex.TracksByCallsign(cs);
        var tdlsAc = ctx.Tdls.AircraftByCallsign(cs);
        var best = flights
            .OrderByDescending(f => string.IsNullOrEmpty(f.ControllingFacility) ? 0 : 1)
            .ThenBy(f => f.Gufi, StringComparer.Ordinal).FirstOrDefault();
        var tais0 = taisTracks.FirstOrDefault();
        var asd0 = asdexTracks.FirstOrDefault();

        var sb = new StringBuilder(128);
        sb.Append(PhaseOf(best, asd0, tais0).label).Append('|');
        if (best != null)
        {
            sb.Append(best.ControllingFacility).Append('/').Append(best.ControllingSector).Append('|');
            sb.Append(best.HandoffEvent).Append('>').Append(best.HandoffReceiving).Append('|');
            // Altitude (assigned/interim/reported) intentionally omitted — not a push-worthy change.
            sb.Append(best.Squawk).Append('/').Append(best.AssignedSquawk).Append('|');
            sb.Append(best.FlightStatus).Append('|');
            sb.Append(best.PointoutOriginatingUnit).Append('>').Append(best.PointoutReceivingUnit).Append('|');
            sb.Append(best.ClearanceHeading).Append(';').Append(best.ClearanceSpeed).Append(';').Append(best.ClearanceText).Append('|');
        }
        // Route amendment is push-worthy — use the same value the summary displays.
        sb.Append(BestFlight(flights)?.Route ?? asd0?.FpRoute).Append('|');
        // Every STARS facility's owner/handoff (a flight straddling two TRACONs — SBN then C90 — must
        // push when the second facility takes ownership, which a single-track key missed).
        foreach (var t in taisTracks.OrderBy(x => x.Facility, StringComparer.Ordinal))
            sb.Append(t.Facility).Append(':').Append(t.Owner).Append('/').Append(t.HandoffOcr).Append('/').Append(t.PendingHandoff)
              .Append('/').Append(t.Scratchpad1).Append(t.Scratchpad2).Append('/').Append(t.Runway).Append('|');
        sb.Append(flights.Select(f => f.EdctTime).FirstOrDefault(e => !string.IsNullOrEmpty(e))).Append('|');
        var tm = tdlsAc.FirstOrDefault()?.MessagesTyped().OrderByDescending(m => m.Time).FirstOrDefault();
        if (tm != null) sb.Append(tm.Time.Ticks);
        sb.Append('|').Append(flights.Count > 0 ? 'S' : '-').Append(taisTracks.Count > 0 ? 'T' : '-')
          .Append(asdexTracks.Count > 0 ? 'A' : '-').Append(tdlsAc.Count > 0 ? 'D' : '-');
        return sb.ToString();
    }

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
    // Flight phase — mirrors phaseOf() in track.js so the text page labels flights the same way.
    private static (string label, string cls) PhaseOf(FlightState? f, AsdexTrack? asd, TaisTrack? tais)
    {
        if (f != null)
        {
            if (f.FlightStatus == "DROPPED") return ("DROPPED", "r");
            if (f.Latitude != null && (f.GroundSpeed ?? 0) > 40) return ("AIRBORNE", "g");
            if (f.FlightStatus == "PROPOSED" || f.Latitude == null) return ("PRE-DEPARTURE", "");
        }
        if (asd != null && (asd.SpeedKts ?? 0) < 40) return ("ON SURFACE", "g");
        if (tais != null) return ("TERMINAL", "g");
        return ("TRACKED", "");
    }

    // Line-4 HSF (heading / speed / free text) — mirrors hsf() in track.js.
    private static string? HsfText(FlightState f)
    {
        var p = new List<string>();
        if (!string.IsNullOrEmpty(f.ClearanceHeading)) p.Add("H" + f.ClearanceHeading);
        if (!string.IsNullOrEmpty(f.ClearanceSpeed)) p.Add("S" + f.ClearanceSpeed);
        if (!string.IsNullOrEmpty(f.ClearanceText)) p.Add(f.ClearanceText);
        return p.Count > 0 ? string.Join(" ", p) : null;
    }

    private static void Row(StringBuilder sb, string k, string? v) { if (!string.IsNullOrEmpty(v)) sb.Append(He(k)).Append(": ").Append(He(v)).Append("<br>"); }

    private static string HmDt(DateTime? dt) => dt == null ? "" : dt.Value.ToString("HHmm") + "Z";

    private static IResult TextPage(ServerContext ctx, string? cs)
    {
        cs = (cs ?? "").Trim().ToUpperInvariant();
        string? Freq(string? key) => FreqOf(ctx, key);
        var sb = new StringBuilder(2048);
        sb.Append("<!doctype html><html><head><meta charset=utf-8><meta name=viewport content=\"width=device-width,initial-scale=1\">");
        if (cs.Length > 0) sb.Append("<meta http-equiv=refresh content=30>");
        sb.Append("<title>").Append(cs.Length > 0 ? He(cs) : "Track").Append("</title>");
        sb.Append("<style>body{background:#000;color:#cc4;font:14px/1.55 monospace;margin:8px;max-width:680px}h2{font-size:12px;color:#888;border-bottom:1px solid #333;margin:15px 0 5px;letter-spacing:1px}b{color:#fff}.w{color:#f80}.g{color:#4c4}.r{color:#f44}.d{color:#888}a{color:#4af}input{background:#111;color:#cc4;border:1px solid #444;padding:8px;text-transform:uppercase;width:9em}button{background:#123;color:#bcf;border:1px solid #356;padding:8px 12px}.rt{color:#dda;word-break:break-all}.ban{background:#2a1e0a;border:1px solid #5a4010;color:#f80;padding:6px 9px;border-radius:6px;margin:9px 0;font-weight:bold}.frq{margin:5px 0}.frq b{font-size:16px}.blk{margin-top:9px}.ph{display:inline-block;padding:2px 9px;border:1px solid #333;border-radius:5px;margin-top:7px;font-weight:bold}</style>");
        sb.Append("</head><body>");
        sb.Append("<form action=/t><input name=cs value=\"").Append(He(cs)).Append("\" placeholder=CALLSIGN> <button>TRACK</button>");
        if (cs.Length > 0) sb.Append(" &nbsp;<a href=/track/").Append(He(cs)).Append(">full page</a>");
        sb.Append("</form>");

        if (cs.Length == 0) { sb.Append("<p class=d>Enter a callsign to follow a flight.<br>This is the light text-only version (no JS, auto-refresh 30s) for slow wifi.</p></body></html>"); return Results.Content(sb.ToString(), "text/html; charset=utf-8"); }

        var flights = Matching(ctx, cs);
        var tdlsAc = ctx.Tdls.AircraftByCallsign(cs);
        var taisTracks = ctx.Tais.TracksByCallsign(cs);
        var asdexTracks = ctx.Asdex.TracksByCallsign(cs);
        var tfms = ctx.Tfms.FindByCallsign(cs);
        var ho = new List<FlightEvent>();
        string? edct = null;
        foreach (var f in flights) { foreach (var e in f.GetAllEvents()) if (HandoffSources.Contains(e.Source)) ho.Add(e); if (edct == null && !string.IsNullOrEmpty(f.EdctTime)) edct = f.EdctTime; }

        if (flights.Count == 0 && tdlsAc.Count == 0 && taisTracks.Count == 0 && asdexTracks.Count == 0 && tfms == null)
        { sb.Append("<p class=w>Nothing is tracking ").Append(He(cs)).Append(" right now.</p></body></html>"); return Results.Content(sb.ToString(), "text/html; charset=utf-8"); }

        var best = flights.OrderBy(f => f.Latitude.HasValue ? 0 : 1)
            .ThenBy(f => f.LastPositionTime == default ? 9999 : (DateTime.UtcNow - f.LastPositionTime).TotalSeconds).FirstOrDefault();
        var tais0 = taisTracks.FirstOrDefault();
        var asd0 = asdexTracks.FirstOrDefault();

        // ── Hero: callsign, route, type, phase, prominent frequencies ──
        sb.Append("<div style=font-size:22px;color:#fff;margin:8px 0 2px>").Append(He(cs)).Append("</div>");
        var org = best?.Origin ?? tais0?.Origin ?? asd0?.FpOrigin ?? tfms?.DepArpt;
        var dst = best?.Destination ?? tais0?.Destination ?? asd0?.FpDestination ?? tfms?.ArrArpt;
        var type = best?.AircraftType ?? tais0?.AircraftType ?? asd0?.AircraftType ?? tfms?.AircraftType;
        var wake = best?.WakeCategory;
        sb.Append("<div>").Append(He(string.IsNullOrEmpty(org) ? "????" : org)).Append(" &#9656; ").Append(He(string.IsNullOrEmpty(dst) ? "????" : dst));
        var sub = new List<string>();
        if (!string.IsNullOrEmpty(type)) sub.Add(type + (string.IsNullOrEmpty(wake) ? "" : "/" + wake));
        if (!string.IsNullOrEmpty(best?.Registration)) sub.Add(best!.Registration!);
        if (sub.Count > 0) sb.Append(" · ").Append(He(string.Join(" · ", sub)));
        sb.Append("</div>");

        var ph = PhaseOf(best, asd0, tais0);
        sb.Append("<div class=\"ph ").Append(ph.cls).Append("\">").Append(He(ph.label)).Append("</div>");

        // Prominent "next frequency" handoff banner (en-route SFDPS, else STARS/TAIS).
        var hoF = flights.FirstOrDefault(f => !string.IsNullOrEmpty(f.HandoffEvent) && !string.IsNullOrEmpty(f.HandoffReceiving));
        if (hoF != null)
        {
            var he = hoF.HandoffEvent!.ToUpperInvariant();
            var label = (he.Contains("INITIAT") || he.Contains("PROPOS")) ? "HANDOFF PENDING"
                      : he.Contains("ACCEPT") ? "HANDOFF ACCEPTED"
                      : he.Contains("EXECUT") ? "HANDING OFF" : "HANDOFF";
            var (recv, recvTracon) = MapFacToken(ctx, hoF.ReportingFacility, hoF.HandoffReceiving!);
            var rf = Freq(recv);
            var recvDisp = recvTracon != null ? recv + " (" + hoF.HandoffReceiving + ")" : recv;
            sb.Append("<div class=ban>").Append(He(label)).Append(" NEXT &#9656; <b>").Append(He(recvDisp)).Append("</b>");
            if (rf != null) sb.Append(" &#183; <b>").Append(He(rf)).Append("</b>");
            sb.Append("</div>");
        }
        else if (tais0 != null && !string.IsNullOrEmpty(tais0.PendingHandoff))
        {
            var recv = tais0.Facility + "/" + tais0.PendingHandoff;
            var rf = Freq(recv);
            sb.Append("<div class=ban>STARS HANDOFF NEXT &#9656; <b>").Append(He(recv)).Append("</b>");
            if (rf != null) sb.Append(" &#183; <b>").Append(He(rf)).Append("</b>");
            sb.Append("</div>");
        }

        // Current controller frequency (center + terminal), up front. Map a TRACON NAS code to its
        // real id (raw code kept in parens).
        if (best?.ControllingFacility != null)
        {
            var tracon = ResolveTracon(ctx, best.ReportingFacility, best.ControllingFacility);
            var fac = tracon ?? best.ControllingFacility;
            var cf = Freq(fac + "/" + (best.ControllingSector ?? ""));
            var disp = fac + (best.ControllingSector != null ? "/" + best.ControllingSector : "") + (tracon != null ? " (" + best.ControllingFacility + ")" : "");
            if (cf != null) sb.Append("<div class=frq>&#9673; <b>").Append(He(cf)).Append("</b> <span class=d>")
                .Append(He(disp)).Append(" · center</span></div>");
        }
        if (tais0?.Owner != null)
        {
            var tf = Freq(tais0.Facility + "/" + tais0.Owner);
            if (tf != null) sb.Append("<div class=frq><span class=g>&#9673; <b>").Append(He(tf)).Append("</b></span> <span class=d>")
                .Append(He(tais0.Facility + "/" + tais0.Owner)).Append(" · terminal</span></div>");
        }

        // Source presence line.
        var srcs = new List<string>();
        if (flights.Count > 0) srcs.Add("SFDPS");
        if (tfms != null) srcs.Add("TFMS");
        if (tdlsAc.Count > 0) srcs.Add("TDLS");
        if (taisTracks.Count > 0) srcs.Add("STARS");
        if (asdexTracks.Count > 0) srcs.Add("ASDE-X");
        if (!string.IsNullOrEmpty(edct)) srcs.Add("EDCT");
        if (srcs.Count > 0) sb.Append("<div class=d style=margin-top:7px>in: <span class=g>").Append(He(string.Join(" · ", srcs))).Append("</span></div>");

        // ── POSITION / OWNERSHIP ──
        if (flights.Count > 0)
        {
            sb.Append("<h2>POSITION / OWNERSHIP</h2>");
            var artccs = new List<string>();
            foreach (var f in flights) { AddU(artccs, ResolveTracon(ctx, f.ReportingFacility, f.ControllingFacility) ?? f.ControllingFacility); AddU(artccs, f.ReportingFacility); foreach (var k in f.ComputerIds.Keys) AddU(artccs, k); }
            sb.Append("Tracked by: <b>").Append(He(string.Join(" ", artccs))).Append("</b>");
            bool first = true;
            foreach (var f in flights)
            {
                var fTracon = ResolveTracon(ctx, f.ReportingFacility, f.ControllingFacility);
                var fFac = fTracon ?? f.ControllingFacility;
                sb.Append("<div class=blk><b>").Append(He(fFac ?? f.ReportingFacility ?? "?"));
                if (f.ControllingSector != null) sb.Append("/").Append(He(f.ControllingSector));
                sb.Append("</b>");
                if (fTracon != null) sb.Append(" <span class=d>(").Append(He(f.ControllingFacility!)).Append(")</span>");
                if (!first) sb.Append(" <span class=d>(also tracking)</span>");
                first = false;
                var cid = (f.ControllingFacility != null && f.ComputerIds.TryGetValue(f.ControllingFacility, out var cc)) ? cc : f.ComputerId;
                if (!string.IsNullOrEmpty(cid)) sb.Append(" CID ").Append(He(cid));
                var freq = Freq((fFac ?? "") + "/" + (f.ControllingSector ?? ""));
                if (freq != null) sb.Append(" &#183; <b>").Append(He(freq)).Append("</b>");
                sb.Append("<br>");
                if (!string.IsNullOrEmpty(f.HandoffEvent) && !string.IsNullOrEmpty(f.HandoffReceiving))
                {
                    var (hrecv, hrecvTracon) = MapFacToken(ctx, f.ReportingFacility, f.HandoffReceiving!);
                    var hrFreq = Freq(hrecv);
                    var hrecvDisp = hrecvTracon != null ? hrecv + " (" + f.HandoffReceiving + ")" : hrecv;
                    sb.Append("<span class=w>Handoff ").Append(He(HoStatus(f.HandoffEvent))).Append(": ").Append(He(f.HandoffTransferring ?? "?")).Append(" &#9656; ").Append(He(hrecvDisp));
                    if (hrFreq != null) sb.Append(" (").Append(He(hrFreq)).Append(")");
                    sb.Append("</span><br>");
                }
                else if (!string.IsNullOrEmpty(f.HandoffEvent))
                {
                    sb.Append("<span class=w>Handoff ").Append(He(HoStatus(f.HandoffEvent))).Append(": ").Append(He(f.HandoffTransferring ?? "?")).Append(" &#9656; ?</span><br>");
                }
                if (!string.IsNullOrEmpty(f.PointoutOriginatingUnit) || !string.IsNullOrEmpty(f.PointoutReceivingUnit))
                    sb.Append("Point-out: ").Append(He(AnnotateFreqs(ctx, (f.PointoutOriginatingUnit ?? "?") + " ▸ " + (f.PointoutReceivingUnit ?? "?")))).Append("<br>");
                sb.Append(He(AltText(f)));
                if (f.GroundSpeed != null) sb.Append(" · ").Append((int)Math.Round(f.GroundSpeed.Value)).Append(" kt");
                if (!string.IsNullOrEmpty(f.Squawk)) sb.Append(" · sqk ").Append(He(f.Squawk));
                if (!string.IsNullOrEmpty(f.AssignedSquawk) && f.AssignedSquawk != f.Squawk) sb.Append(" <span class=d>(asgn ").Append(He(f.AssignedSquawk)).Append(")</span>");
                sb.Append("<br>");
                var l4 = HsfText(f);
                if (l4 != null) sb.Append("<span class=w>Line 4: ").Append(He(l4)).Append("</span><br>");
                if (f.Latitude != null)
                {
                    sb.Append("Pos ").Append(f.Latitude.Value.ToString("F3")).Append(", ").Append(f.Longitude!.Value.ToString("F3"));
                    if (f.LastPositionTime != default) sb.Append(" <span class=d>(").Append((int)(DateTime.UtcNow - f.LastPositionTime).TotalSeconds).Append("s old)</span>");
                    sb.Append("<br>");
                }
                if (f.CoastIndicator) sb.Append("<span class=w>COAST</span><br>");
                if (!string.IsNullOrEmpty(f.FlightStatus) && f.FlightStatus != "ACTIVE") sb.Append("Status: ").Append(He(f.FlightStatus)).Append("<br>");
                if (!f.ComputerIds.IsEmpty) sb.Append("<span class=d>CIDs ").Append(He(string.Join("  ", f.ComputerIds.Select(kv => kv.Key + ":" + kv.Value)))).Append("</span><br>");
                sb.Append("</div>");
            }
        }

        // ── TERMINAL (STARS / TAIS) ──
        if (taisTracks.Count > 0)
        {
            sb.Append("<h2>TERMINAL (STARS)</h2>");
            foreach (var t in taisTracks)
            {
                sb.Append("<div class=blk><b>").Append(He(t.Facility));
                if (!string.IsNullOrEmpty(t.Owner)) sb.Append("/").Append(He(t.Owner));
                sb.Append("</b>");
                var tf = Freq(t.Facility + "/" + (t.Owner ?? ""));
                if (tf != null) sb.Append(" &#183; <b>").Append(He(tf)).Append("</b>");
                if (!string.IsNullOrEmpty(t.TrackNum)) sb.Append(" <span class=d>#").Append(He(t.TrackNum)).Append("</span>");
                sb.Append("<br>");
                if (!string.IsNullOrEmpty(t.EntryFix) || !string.IsNullOrEmpty(t.ExitFix))
                    sb.Append(He(string.IsNullOrEmpty(t.EntryFix) ? "—" : t.EntryFix)).Append(" &#9656; ").Append(He(string.IsNullOrEmpty(t.ExitFix) ? "—" : t.ExitFix)).Append("<br>");
                var sp = string.Join(" ", new[] { t.Scratchpad1, t.Scratchpad2 }.Where(x => !string.IsNullOrEmpty(x)));
                var meta = new List<string>();
                if (!string.IsNullOrEmpty(sp)) meta.Add("SP " + sp);
                if (!string.IsNullOrEmpty(t.Runway)) meta.Add("RWY " + t.Runway);
                if (meta.Count > 0) sb.Append(He(string.Join(" · ", meta))).Append("<br>");
                if (!string.IsNullOrEmpty(t.PendingHandoff))
                {
                    var hf = Freq(t.Facility + "/" + t.PendingHandoff);
                    sb.Append("<span class=w>H/O &#9656; ").Append(He(t.PendingHandoff)).Append(hf != null ? " (" + He(hf) + ")" : "").Append("</span><br>");
                }
                var tl = new List<string>();
                if (t.AltitudeFeet != null) tl.Add("FL" + Math.Round(t.AltitudeFeet.Value / 100.0));
                if (t.GroundSpeedKnots != null) tl.Add(t.GroundSpeedKnots + " kt");
                if (!string.IsNullOrEmpty(t.AssignedSquawk)) tl.Add("sqk " + t.AssignedSquawk);
                if (tl.Count > 0) sb.Append(He(string.Join(" · ", tl))).Append("<br>");
                sb.Append("</div>");
            }
        }

        // ── HANDOFF / POINT-OUT HISTORY ──
        if (ho.Count > 0)
        {
            sb.Append("<h2>HANDOFF / POINT-OUT HISTORY</h2>");
            foreach (var e in ho.GroupBy(x => x.Time + x.Summary).Select(g => g.First()).OrderByDescending(x => x.Time).Take(12))
                sb.Append(He(Hm(e.Time))).Append(" <span class=g>").Append(He(e.Source)).Append("</span> ").Append(He(AnnotateFreqs(ctx, e.Summary))).Append("<br>");
        }

        if (!string.IsNullOrEmpty(edct)) sb.Append("<h2>EDCT</h2>Controlled departure <b>").Append(He(Hm(edct))).Append("</b>");

        // ── FLIGHT PLAN ──
        if (best != null)
        {
            sb.Append("<h2>FLIGHT PLAN</h2>");
            Row(sb, "Origin", best.Origin); Row(sb, "Destination", best.Destination); Row(sb, "Alternate", best.AlternateAerodrome);
            Row(sb, "Rules", best.FlightRules); Row(sb, "Type", best.FlightType); Row(sb, "STAR", best.STAR);
            Row(sb, "Altitude", AltText(best));
            if (best.RequestedAltitude != null) Row(sb, "Req. Alt", Fl(best.RequestedAltitude));
            if (best.RequestedSpeed != null) Row(sb, "Req. Speed", (int)Math.Round(best.RequestedSpeed.Value) + " kt");
            Row(sb, "EET", best.EstimatedElapsedTimes); Row(sb, "Operator", best.Operator); Row(sb, "Originator", best.Originator);
            var rmk = best.Remarks?.Replace('|', ' ').Trim();
            Row(sb, "Remarks", string.IsNullOrEmpty(rmk) ? null : rmk);
            var route = best.OriginalRoute ?? best.Route;
            if (!string.IsNullOrEmpty(route)) sb.Append("Route:<br><span class=rt>").Append(He(route)).Append("</span><br>");
            sb.Append("<div class=d style=margin-top:6px>EQUIPMENT / CAPABILITIES</div>");
            Row(sb, "Equipment", best.EquipmentQualifier); Row(sb, "PBN", best.PBNCode);
            Row(sb, "Navigation", string.Join("  ", new[] { best.NavigationCode, best.OtherNavigationCapabilities }.Where(x => !string.IsNullOrEmpty(x))));
            Row(sb, "Comm", string.Join("  ", new[] { best.CommunicationCode, best.OtherCommunicationCapabilities }.Where(x => !string.IsNullOrEmpty(x))));
            Row(sb, "Data Link", string.Join("  ", new[] { best.DataLinkCode, best.OtherDataLink }.Where(x => !string.IsNullOrEmpty(x))));
            Row(sb, "Surveillance", string.Join("  ", new[] { best.SurveillanceCode, best.OtherSurveillanceCapabilities }.Where(x => !string.IsNullOrEmpty(x))));
            Row(sb, "SELCAL", best.SELCAL); Row(sb, "Performance", best.AircraftPerformance);
        }

        // ── TDLS (clearance / departure) ──
        if (tdlsAc.Count > 0)
        {
            sb.Append("<h2>TDLS</h2>");
            foreach (var ac in tdlsAc)
            {
                sb.Append("<div class=d style=margin-top:6px>").Append(He(ac.Airport)).Append(" · ").Append(He(ac.AircraftType ?? ""));
                if (!string.IsNullOrEmpty(ac.Destination)) sb.Append(" &#8594; ").Append(He(ac.Destination));
                sb.Append("</div>");
                foreach (var m in ac.MessagesTyped().OrderByDescending(m => m.Time).Take(8))
                {
                    if (m.Type == "DEPART")
                    {
                        var parts = new List<string>();
                        if (!string.IsNullOrEmpty(m.Gate)) parts.Add("Gate " + m.Gate);
                        if (m.ClearanceTime != null) parts.Add("CLR " + HmDt(m.ClearanceTime));
                        if (m.TaxiTime != null) parts.Add("TAXI " + HmDt(m.TaxiTime));
                        if (m.TakeoffTime != null) parts.Add("T/O " + HmDt(m.TakeoffTime));
                        if (!string.IsNullOrEmpty(m.TakeoffRunway)) parts.Add("RWY " + m.TakeoffRunway);
                        sb.Append("<span class=w>DEP</span> ").Append(He(m.Time.ToString("HHmm"))).Append("Z ").Append(He(string.Join(" · ", parts))).Append("<br>");
                    }
                    else
                    {
                        var body = System.Text.RegularExpressions.Regex.Replace(m.DataBody ?? "", @"^\d{3}\s*", "");
                        sb.Append("<span class=g>CPDLC</span> ").Append(He(m.Time.ToString("HHmm"))).Append("Z<br><span class=rt>").Append(He(body)).Append("</span><br>");
                    }
                }
            }
        }

        // ── SURFACE (ASDE-X) ──
        if (asdexTracks.Count > 0)
        {
            sb.Append("<h2>SURFACE (ASDE-X)</h2>");
            foreach (var t in asdexTracks)
            {
                sb.Append("<div class=d style=margin-top:6px>").Append(He(t.Airport)).Append(" · SURFACE</div>");
                var p = new List<string>();
                if (!string.IsNullOrEmpty(t.TargetType)) p.Add(t.TargetType);
                var gate = t.TdlsGate ?? t.GateCode; if (!string.IsNullOrEmpty(gate)) p.Add("gate " + gate);
                if (!string.IsNullOrEmpty(t.TdlsRunway)) p.Add("rwy " + t.TdlsRunway);
                if (t.SpeedKts != null) p.Add(t.SpeedKts + " kt");
                if (t.HeadingDegrees != null) p.Add(Math.Round(t.HeadingDegrees.Value) + "°");
                if (t.AltitudeFeet != null) p.Add(Math.Round(t.AltitudeFeet.Value) + " ft");
                if (!string.IsNullOrEmpty(t.Squawk)) p.Add("sqk " + t.Squawk);
                sb.Append(He(string.Join(" · ", p))).Append("<br>");
                sb.Append("Pos ").Append(t.Latitude.ToString("F4")).Append(", ").Append(t.Longitude.ToString("F4"))
                  .Append(" <span class=d>(").Append((int)(DateTime.UtcNow - t.LastSeen).TotalSeconds).Append("s old)</span><br>");
            }
        }

        // ── TRAFFIC FLOW (TFMS) ──
        if (tfms != null)
        {
            sb.Append("<h2>TRAFFIC FLOW (TFMS)</h2>");
            Row(sb, "Departure", tfms.DepArpt); Row(sb, "Arrival", tfms.ArrArpt); Row(sb, "Status", tfms.FlightStatus);
            Row(sb, "ETA", HmDt(tfms.Eta)); Row(sb, "STAR", tfms.Star); Row(sb, "Type", tfms.AircraftType ?? tfms.AircraftModel);
            if (tfms.Altitude != null) Row(sb, "Altitude", tfms.Altitude + " ft");
            if (tfms.Speed != null) Row(sb, "Speed", tfms.Speed + " kt");
        }

        sb.Append("<p class=d style=margin-top:16px>text mode · auto-refresh 30s · ").Append(DateTime.UtcNow.ToString("HHmm")).Append("Z</p></body></html>");
        return Results.Content(sb.ToString(), "text/html; charset=utf-8");
    }
}
