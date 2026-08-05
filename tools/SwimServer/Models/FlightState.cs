using System.Collections.Concurrent;

namespace SwimServer;

class FlightState
{
    public string Gufi { get; set; } = "";
    public string? FdpsGufi { get; set; }
    public string? Callsign { get; set; }
    public string? ComputerId { get; set; }
    public ConcurrentDictionary<string, string> ComputerIds { get; } = new();
    public string? Operator { get; set; }
    public string? Originator { get; set; }
    public string? FlightStatus { get; set; }
    public string? Origin { get; set; }
    public string? Destination { get; set; }
    public string? AlternateAerodrome { get; set; }
    public string? AircraftType { get; set; }
    public string? Registration { get; set; }
    public string? WakeCategory { get; set; }
    public string? ModeSCode { get; set; }
    public string? EquipmentQualifier { get; set; }
    public string? AircraftPerformance { get; set; } // ICAO performance category (A-E)
    public string? Squawk { get; set; }            // Current/received beacon code
    public string? AssignedSquawk { get; set; }     // Controller-assigned beacon code (from BA/RE messages)
    public string? FlightRules { get; set; }
    public string? FlightType { get; set; }     // SCHEDULED, NON_SCHEDULED, GENERAL, MILITARY, OTHER
    public string? Route { get; set; }
    public string? OriginalRoute { get; set; }  // First route received (before ATC amendments)
    public string? STAR { get; set; }
    public string? Remarks { get; set; }

    // Altitude
    public double? AssignedAltitude { get; set; }
    public bool AssignedVfr { get; set; }          // true for <vfr/> or <vfrPlus>
    public double? BlockFloor { get; set; }        // block altitude lower bound (feet)
    public double? BlockCeiling { get; set; }      // block altitude upper bound (feet)
    public double? InterimAltitude { get; set; }
    public double? ReportedAltitude { get; set; }
    // First assigned altitude observed (initial flight-plan filing). Never
    // overwritten after first set, so we keep the original even after ATC
    // amends the cleared altitude later. Mirrors how OriginalRoute works.
    public double? OriginalAssignedAltitude { get; set; }
    public bool OriginalAssignedVfr { get; set; }
    // Filed cruise altitude from the pilot's flight plan
    // (field-15 N{TAS}A{alt/100} → SFDPS <requestedAltitude><simple>).
    // Distinct from AssignedAltitude (what ATC has cleared) — used by the
    // flight table to fill a value for PROPOSED plans not yet assigned.
    public double? RequestedAltitude { get; set; }

    // Position
    public double? Latitude { get; set; }
    public double? Longitude { get; set; }
    public double? GroundSpeed { get; set; }
    public double? RequestedSpeed { get; set; }
    public double? TrackVelocityX { get; set; }
    public double? TrackVelocityY { get; set; }

    // ERAM position enrichment (from position sub-elements)
    public bool CoastIndicator { get; set; }           // from @coastIndicator on <position>
    public double? TargetLatitude { get; set; }        // ERAM-predicted next position
    public double? TargetLongitude { get; set; }
    public double? TargetAltitude { get; set; }        // ERAM-predicted altitude (feet)

    // Times
    public string? ActualDepartureTime { get; set; }
    public string? ETA { get; set; }
    public string? CoordinationTime { get; set; }
    public string? CoordinationFix { get; set; }
    /// <summary>EDCT (Expected Departure Clearance Time) — assigned by GDP/CTOP/Ground Stop. ISO 8601 string.</summary>
    public string? EdctTime { get; set; }

    // Ownership / handoff
    public string? ReportingFacility { get; set; }
    public string? ControllingFacility { get; set; }
    public string? ControllingSector { get; set; }
    /// <summary>UTC of the last controllingUnit change — i.e. when the current sector took the
    /// handoff. Lets a client that connects (or opens a sector) mid-flight know how long the track
    /// has already been under that sector's control instead of starting the clock at page load.
    /// Persisted in the flight cache so it survives restarts.</summary>
    public DateTime? ControlSince { get; set; }
    public string? HandoffEvent { get; set; }
    public string? HandoffReceiving { get; set; }
    public string? HandoffTransferring { get; set; }
    public string? HandoffAccepting { get; set; }
    public bool HandoffForced { get; set; } // true when handoff accepted via /OK (AH message)

    // Point-out
    public string? PointoutOriginatingUnit { get; set; }
    public string? PointoutReceivingUnit { get; set; }
    public DateTime? PointoutTimestamp { get; set; }

    // Clearance data (from NasClearedFlightInformationType — heading, speed, text)
    public string? ClearanceHeading { get; set; }
    public string? ClearanceSpeed { get; set; }
    public string? ClearanceText { get; set; }
    public string? FourthAdaptedField { get; set; }

    // Traffic Management Initiatives
    public string? TmiIds { get; set; }

    // Datalink / CPDLC
    public string? CommunicationCode { get; set; }
    public string? DataLinkCode { get; set; }
    public string? OtherDataLink { get; set; }
    public string? OtherCommunicationCapabilities { get; set; }
    public string? SELCAL { get; set; }
    public string? NavigationCode { get; set; }
    public string? PBNCode { get; set; }
    public string? SurveillanceCode { get; set; }
    public string? OtherNavigationCapabilities { get; set; }
    public string? OtherSurveillanceCapabilities { get; set; }
    public string? EstimatedElapsedTimes { get; set; }

    // Meta
    public DateTime LastSeen { get; set; }
    public DateTime LastPositionTime { get; set; }
    public string? LastMsgSource { get; set; }

    // Position history (server-side, survives client refresh)
    private readonly List<PositionRecord> _posHistory = new();
    private const int MaxPosHistory = 20;

    public void AddPosition(double lat, double lon, char sym)
    {
        lock (_posHistory)
        {
            _posHistory.Add(new PositionRecord(lat, lon, DateTime.UtcNow.Ticks, sym));
            if (_posHistory.Count > MaxPosHistory) _posHistory.RemoveAt(0);
        }
    }

    public List<PositionRecord> GetPositionHistory()
    {
        lock (_posHistory) { return new(_posHistory); }
    }

    private readonly List<FlightEvent> _events = new();
    private readonly List<FlightEvent> _allEvents = new();
    private const int MaxEvents = 50;
    private const int MaxAllEvents = 100;
    private const int MaxXmlEvents = 20;     // Only keep RawXml on the most recent N events (RawXml dominates per-flight RAM; trimmed for the 3.7 GB Pi)

    public void AddEvent(FlightEvent e)
    {
        lock (_events)
        {
            _events.Add(e);
            if (_events.Count > MaxEvents) _events.RemoveAt(0);
        }
        lock (_allEvents)
        {
            _allEvents.Add(e);
            if (_allEvents.Count > MaxAllEvents) _allEvents.RemoveAt(0);
            // Strip RawXml from older events beyond the most recent MaxXmlEvents with XML
            int kept = 0;
            for (int i = _allEvents.Count - 1; i >= 0; i--)
            {
                if (_allEvents[i].RawXml is not null)
                {
                    if (++kept > MaxXmlEvents) _allEvents[i].RawXml = null;
                }
            }
        }
    }

    public List<FlightEvent> GetEvents()
    {
        lock (_events) { return new(_events); }
    }

    public List<FlightEvent> GetAllEvents()
    {
        lock (_allEvents) { return new(_allEvents); }
    }

    public FlightEvent? GetEvent(int index)
    {
        lock (_allEvents)
        {
            return index >= 0 && index < _allEvents.Count ? _allEvents[index] : null;
        }
    }

    public int AllEventCount { get { lock (_allEvents) { return _allEvents.Count; } } }

    public void RestorePosition(PositionRecord rec)
    {
        lock (_posHistory) { _posHistory.Add(rec); }
    }

    /// Backfill FlightType from stored FH events — tries RawXml first, then summary text
    public void BackfillFromEvents()
    {
        if (FlightType is not null) return;
        lock (_allEvents)
        {
            foreach (var e in _allEvents)
            {
                if (e.Source != "FH") continue;
                // Try RawXml first (available before cache save, gone after restore)
                if (e.RawXml is not null)
                {
                    try
                    {
                        var doc = System.Xml.Linq.XDocument.Parse(e.RawXml);
                        var flight = doc.Descendants().FirstOrDefault(x => x.Name.LocalName == "flight");
                        var ft = flight?.Attribute("flightType")?.Value;
                        if (!string.IsNullOrEmpty(ft)) { FlightType = ft; return; }
                    }
                    catch { }
                }
                // Fallback: parse from summary text "[SCHEDULED]", "[NON_SCHEDULED]", etc.
                var match = System.Text.RegularExpressions.Regex.Match(e.Summary, @"\[([A-Z_]+)\]");
                if (match.Success) { FlightType = match.Groups[1].Value; return; }
            }
        }
    }

    public FlightSnapshot ToSnapshot() => new()
    {
        Gufi = Gufi, FdpsGufi = FdpsGufi, Callsign = Callsign,
        ComputerId = ComputerId,
        ComputerIds = ComputerIds.IsEmpty ? null : new Dictionary<string, string>(ComputerIds),
        Operator = Operator, Originator = Originator, FlightStatus = FlightStatus,
        Origin = Origin, Destination = Destination, AlternateAerodrome = AlternateAerodrome, AircraftType = AircraftType,
        Registration = Registration, WakeCategory = WakeCategory,
        ModeSCode = ModeSCode, EquipmentQualifier = EquipmentQualifier, AircraftPerformance = AircraftPerformance,
        Squawk = Squawk, AssignedSquawk = AssignedSquawk, FlightRules = FlightRules, FlightType = FlightType,
        Route = Route, OriginalRoute = OriginalRoute, STAR = STAR, Remarks = Remarks,
        AssignedAltitude = AssignedAltitude, AssignedVfr = AssignedVfr,
        BlockFloor = BlockFloor, BlockCeiling = BlockCeiling,
        OriginalAssignedAltitude = OriginalAssignedAltitude, OriginalAssignedVfr = OriginalAssignedVfr,
        RequestedAltitude = RequestedAltitude,
        InterimAltitude = InterimAltitude, ReportedAltitude = ReportedAltitude,
        Latitude = Latitude, Longitude = Longitude,
        GroundSpeed = GroundSpeed, RequestedSpeed = RequestedSpeed,
        TrackVelocityX = TrackVelocityX, TrackVelocityY = TrackVelocityY,
        ActualDepartureTime = ActualDepartureTime, ETA = ETA, EdctTime = EdctTime,
        CoordinationTime = CoordinationTime, CoordinationFix = CoordinationFix,
        ReportingFacility = ReportingFacility,
        ControllingFacility = ControllingFacility, ControllingSector = ControllingSector,
        ControlSince = ControlSince,
        HandoffEvent = HandoffEvent, HandoffReceiving = HandoffReceiving,
        HandoffTransferring = HandoffTransferring, HandoffAccepting = HandoffAccepting,
        HandoffForced = HandoffForced,
        PointoutOriginatingUnit = PointoutOriginatingUnit, PointoutReceivingUnit = PointoutReceivingUnit,
        ClearanceHeading = ClearanceHeading, ClearanceSpeed = ClearanceSpeed,
        ClearanceText = ClearanceText, FourthAdaptedField = FourthAdaptedField,
        TmiIds = TmiIds,
        CommunicationCode = CommunicationCode, DataLinkCode = DataLinkCode,
        OtherDataLink = OtherDataLink, OtherCommunicationCapabilities = OtherCommunicationCapabilities,
        SELCAL = SELCAL,
        NavigationCode = NavigationCode, PBNCode = PBNCode, SurveillanceCode = SurveillanceCode,
        OtherNavigationCapabilities = OtherNavigationCapabilities,
        OtherSurveillanceCapabilities = OtherSurveillanceCapabilities,
        EstimatedElapsedTimes = EstimatedElapsedTimes,
        LastSeen = LastSeen, LastMsgSource = LastMsgSource,
        PosHistory = GetPositionHistory(),
        Events = GetEvents()
    };

    public static FlightState FromSnapshot(FlightSnapshot s)
    {
        var f = new FlightState
        {
            Gufi = s.Gufi, FdpsGufi = s.FdpsGufi, Callsign = s.Callsign,
            ComputerId = s.ComputerId,
            Operator = s.Operator, Originator = s.Originator, FlightStatus = s.FlightStatus,
            Origin = s.Origin, Destination = s.Destination, AlternateAerodrome = s.AlternateAerodrome, AircraftType = s.AircraftType,
            Registration = s.Registration, WakeCategory = s.WakeCategory,
            ModeSCode = s.ModeSCode, EquipmentQualifier = s.EquipmentQualifier, AircraftPerformance = s.AircraftPerformance,
            Squawk = s.Squawk, AssignedSquawk = s.AssignedSquawk, FlightRules = s.FlightRules, FlightType = s.FlightType,
            Route = s.Route, OriginalRoute = s.OriginalRoute, STAR = s.STAR, Remarks = s.Remarks,
            AssignedAltitude = s.AssignedAltitude, AssignedVfr = s.AssignedVfr,
            BlockFloor = s.BlockFloor, BlockCeiling = s.BlockCeiling,
            OriginalAssignedAltitude = s.OriginalAssignedAltitude, OriginalAssignedVfr = s.OriginalAssignedVfr,
            RequestedAltitude = s.RequestedAltitude,
            InterimAltitude = s.InterimAltitude, ReportedAltitude = s.ReportedAltitude,
            Latitude = s.Latitude, Longitude = s.Longitude,
            GroundSpeed = s.GroundSpeed, RequestedSpeed = s.RequestedSpeed,
            TrackVelocityX = s.TrackVelocityX, TrackVelocityY = s.TrackVelocityY,
            ActualDepartureTime = s.ActualDepartureTime, ETA = s.ETA, EdctTime = s.EdctTime,
            CoordinationTime = s.CoordinationTime, CoordinationFix = s.CoordinationFix,
            ReportingFacility = s.ReportingFacility,
            ControllingFacility = s.ControllingFacility, ControllingSector = s.ControllingSector,
            ControlSince = s.ControlSince,
            HandoffEvent = s.HandoffEvent, HandoffReceiving = s.HandoffReceiving,
            HandoffTransferring = s.HandoffTransferring, HandoffAccepting = s.HandoffAccepting,
            HandoffForced = s.HandoffForced,
            PointoutOriginatingUnit = s.PointoutOriginatingUnit, PointoutReceivingUnit = s.PointoutReceivingUnit,
            ClearanceHeading = s.ClearanceHeading, ClearanceSpeed = s.ClearanceSpeed,
            ClearanceText = s.ClearanceText, FourthAdaptedField = s.FourthAdaptedField,
            TmiIds = s.TmiIds,
            CommunicationCode = s.CommunicationCode, DataLinkCode = s.DataLinkCode,
            OtherDataLink = s.OtherDataLink, OtherCommunicationCapabilities = s.OtherCommunicationCapabilities,
            SELCAL = s.SELCAL,
            NavigationCode = s.NavigationCode, PBNCode = s.PBNCode, SurveillanceCode = s.SurveillanceCode,
            OtherNavigationCapabilities = s.OtherNavigationCapabilities,
            OtherSurveillanceCapabilities = s.OtherSurveillanceCapabilities,
            EstimatedElapsedTimes = s.EstimatedElapsedTimes,
            LastSeen = s.LastSeen, LastMsgSource = s.LastMsgSource,
            LastPositionTime = s.Latitude.HasValue ? s.LastSeen : default
        };
        if (s.ComputerIds is not null)
            foreach (var kv in s.ComputerIds) f.ComputerIds[kv.Key] = kv.Value;
        if (s.PosHistory is not null)
            foreach (var p in s.PosHistory) f.RestorePosition(p);
        if (s.Events is not null)
            foreach (var e in s.Events) f.AddEvent(e);
        return f;
    }

    // LADD: mask identity for public output. _ladd == blocked && !reveal.
    public object ToSummary(bool includeHistory = false, bool reveal = false)
    {
        bool _ladd = LaddService.ShouldMask(Callsign, Registration, reveal);
        return new
    {
        Gufi,
        Callsign = _ladd ? LaddService.Label : Callsign,
        ComputerId,
        ComputerIds = ComputerIds.IsEmpty ? null : new Dictionary<string, string>(ComputerIds),
        Operator = _ladd ? null : Operator,
        Originator, FlightStatus,
        Origin, Destination, AircraftType, WakeCategory,
        AssignedAltitude, AssignedVfr, BlockFloor, BlockCeiling,
        InterimAltitude, ReportedAltitude,
        Latitude, Longitude, GroundSpeed, Squawk, AssignedSquawk,
        TrackVelocityX, TrackVelocityY,
        CoastIndicator = CoastIndicator ? true : (bool?)null,       // only send when true
        TargetLatitude, TargetLongitude, TargetAltitude,
        ControllingFacility, ControllingSector,
        // Seconds the current sector has held the track. Sent as an age (not a
        // timestamp) so it stays correct across clock skew, like PosAge.
        ControlAgeSec = ControlSince.HasValue ? (int)(DateTime.UtcNow - ControlSince.Value).TotalSeconds : (int?)null,
        ReportingFacility,
        HandoffEvent, HandoffReceiving, HandoffTransferring, HandoffAccepting, HandoffForced,
        PointoutOriginatingUnit, PointoutReceivingUnit,
        ClearanceHeading, ClearanceSpeed, ClearanceText,
        DataLinkCode, OtherDataLink,
        OriginalAssignedAltitude, OriginalAssignedVfr,
        RequestedAltitude,
        Route, OriginalRoute, FlightRules, FlightType, STAR, Remarks,
        Registration = _ladd ? null : Registration,
        EquipmentQualifier, AircraftPerformance, RequestedSpeed,
        OtherNavigationCapabilities, OtherSurveillanceCapabilities, EstimatedElapsedTimes,
        CoordinationFix, CoordinationTime,
        ETA, ActualDepartureTime, EdctTime,
        LastMsgSource,
        LastSeen = LastSeen.ToString("HH:mm:ss"),
        PosAge = LastPositionTime == default ? (int?)null : (int)(DateTime.UtcNow - LastPositionTime).TotalSeconds,
        History = includeHistory ? HistoryWithAge() : null
        };
    }

    private object[] HistoryWithAge()
    {
        var nowTicks = DateTime.UtcNow.Ticks;
        return GetPositionHistory().Select(h => new {
            h.Lat, h.Lon, Sym = h.Sym.ToString(),
            Age = (int)((nowTicks - h.Ticks) / TimeSpan.TicksPerSecond)
        }).ToArray();
    }

    public object ToDetail(bool reveal = false)
    {
        bool _ladd = LaddService.ShouldMask(Callsign, Registration, reveal);
        List<object> allEvents;
        lock (_allEvents)
        {
            allEvents = _allEvents.Select((e, i) => (object)new
            {
                index = i, e.Time, e.Source, e.Centre, e.Summary,
                hasXml = e.RawXml is not null
            }).ToList();
        }
        return new
        {
            Gufi, FdpsGufi,
            Callsign = _ladd ? LaddService.Label : Callsign,
            ComputerId,
            ComputerIds = ComputerIds.IsEmpty ? null : new Dictionary<string, string>(ComputerIds),
            Operator = _ladd ? null : Operator,
            Originator, FlightStatus,
            Origin, Destination, AlternateAerodrome, AircraftType,
            Registration = _ladd ? null : Registration,
            WakeCategory,
            ModeSCode = _ladd ? null : ModeSCode,
            EquipmentQualifier, AircraftPerformance, Squawk, AssignedSquawk, FlightRules, FlightType,
            Route, OriginalRoute, STAR, Remarks,
            AssignedAltitude, AssignedVfr, BlockFloor, BlockCeiling,
            OriginalAssignedAltitude, OriginalAssignedVfr,
            RequestedAltitude,
            InterimAltitude, ReportedAltitude,
            Latitude, Longitude, GroundSpeed, RequestedSpeed,
            ActualDepartureTime, ETA, EdctTime, CoordinationTime, CoordinationFix,
            ReportingFacility, ControllingFacility, ControllingSector,
            HandoffEvent, HandoffReceiving, HandoffTransferring, HandoffAccepting, HandoffForced,
            PointoutOriginatingUnit, PointoutReceivingUnit,
            ClearanceHeading, ClearanceSpeed, ClearanceText, FourthAdaptedField, TmiIds,
            CommunicationCode, DataLinkCode, OtherDataLink, OtherCommunicationCapabilities, SELCAL,
            NavigationCode, PBNCode, SurveillanceCode,
            OtherNavigationCapabilities, OtherSurveillanceCapabilities, EstimatedElapsedTimes,
            LastMsgSource, LastSeen = LastSeen.ToString("o"),
            Events = allEvents,
            History = HistoryWithAge()
        };
    }
}

class FlightEvent
{
    public string Time { get; set; } = "";
    public string Source { get; set; } = "";
    public string Centre { get; set; } = "";
    public string Summary { get; set; } = "";
    [System.Text.Json.Serialization.JsonIgnore]
    public string? RawXml { get; set; }
}

class FlightSnapshot
{
    public string Gufi { get; set; } = "";
    public string? FdpsGufi { get; set; }
    public string? Callsign { get; set; }
    public string? ComputerId { get; set; }
    public Dictionary<string, string>? ComputerIds { get; set; }
    public string? Operator { get; set; }
    public string? Originator { get; set; }
    public string? FlightStatus { get; set; }
    public string? Origin { get; set; }
    public string? Destination { get; set; }
    public string? AlternateAerodrome { get; set; }
    public string? AircraftType { get; set; }
    public string? Registration { get; set; }
    public string? WakeCategory { get; set; }
    public string? ModeSCode { get; set; }
    public string? EquipmentQualifier { get; set; }
    public string? AircraftPerformance { get; set; }
    public string? Squawk { get; set; }
    public string? AssignedSquawk { get; set; }
    public string? FlightRules { get; set; }
    public string? FlightType { get; set; }
    public string? Route { get; set; }
    public string? OriginalRoute { get; set; }
    public string? STAR { get; set; }
    public string? Remarks { get; set; }
    public double? AssignedAltitude { get; set; }
    public bool AssignedVfr { get; set; }
    public double? BlockFloor { get; set; }
    public double? BlockCeiling { get; set; }
    public double? OriginalAssignedAltitude { get; set; }
    public bool OriginalAssignedVfr { get; set; }
    public double? RequestedAltitude { get; set; }
    public double? InterimAltitude { get; set; }
    public double? ReportedAltitude { get; set; }
    public double? Latitude { get; set; }
    public double? Longitude { get; set; }
    public double? GroundSpeed { get; set; }
    public double? RequestedSpeed { get; set; }
    public double? TrackVelocityX { get; set; }
    public double? TrackVelocityY { get; set; }
    public string? ActualDepartureTime { get; set; }
    public string? ETA { get; set; }
    public string? EdctTime { get; set; }
    public string? CoordinationTime { get; set; }
    public string? CoordinationFix { get; set; }
    public string? ReportingFacility { get; set; }
    public string? ControllingFacility { get; set; }
    public string? ControllingSector { get; set; }
    public DateTime? ControlSince { get; set; }
    public string? HandoffEvent { get; set; }
    public string? HandoffReceiving { get; set; }
    public string? HandoffTransferring { get; set; }
    public string? HandoffAccepting { get; set; }
    public bool HandoffForced { get; set; }
    public string? PointoutOriginatingUnit { get; set; }
    public string? PointoutReceivingUnit { get; set; }
    public string? ClearanceHeading { get; set; }
    public string? ClearanceSpeed { get; set; }
    public string? ClearanceText { get; set; }
    public string? FourthAdaptedField { get; set; }
    public string? TmiIds { get; set; }
    public string? CommunicationCode { get; set; }
    public string? DataLinkCode { get; set; }
    public string? OtherDataLink { get; set; }
    public string? OtherCommunicationCapabilities { get; set; }
    public string? SELCAL { get; set; }
    public string? NavigationCode { get; set; }
    public string? PBNCode { get; set; }
    public string? SurveillanceCode { get; set; }
    public string? OtherNavigationCapabilities { get; set; }
    public string? OtherSurveillanceCapabilities { get; set; }
    public string? EstimatedElapsedTimes { get; set; }
    public DateTime LastSeen { get; set; }
    public string? LastMsgSource { get; set; }
    public List<PositionRecord>? PosHistory { get; set; }
    public List<FlightEvent>? Events { get; set; }
}

class FlightCache
{
    public DateTime SavedAt { get; set; }
    public List<FlightSnapshot> Flights { get; set; } = new();
}
