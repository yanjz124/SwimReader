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

            // SFDPS — en-route flight(s). Multiple GUFIs possible (one per ARTCC).
            var sfdps = new List<object>();
            string? edct = null;
            foreach (var f in ctx.Flights.Values)
            {
                if (!string.Equals(f.Callsign, callsign, StringComparison.OrdinalIgnoreCase)) continue;
                if (f.FlightStatus == "CANCELLED") continue;
                sfdps.Add(SfdpsProjection(f));
                if (edct is null && !string.IsNullOrEmpty(f.EdctTime)) edct = f.EdctTime;
            }

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
                tfms,
                edct,
                tdls,
                tais,
                asdex,
            }, ctx.JsonOpts);
        });
    }

    // Lean per-flight projection (no events/history) with the fields the track page needs:
    // full ICAO flight plan, ownership/handoff, position, clearance, times — enough to render
    // the flight-plan card and the mock ERAM/STARS data blocks.
    private static object SfdpsProjection(FlightState f) => new
    {
        gufi = f.Gufi, callsign = f.Callsign, cid = f.ComputerId, status = f.FlightStatus,
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
}
