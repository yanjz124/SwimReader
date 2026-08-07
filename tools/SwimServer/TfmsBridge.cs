using System.Collections.Concurrent;
using System.Globalization;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Xml.Linq;
using SolaceSystems.Solclient.Messaging;
using SwimServer;

/// <summary>
/// Manages TFMS (Traffic Flow Management System) data ingestion and WebSocket broadcasting.
///
/// Connects to TFMS Solace broker (own session, VPN "TFMS"), parses tfmDataService XML,
/// maintains per-flight state and TMI (Traffic Management Initiative) state.
///
/// Two output types:
///   fltdOutput — flight track/plan data (batches of fltdMessage): position, route traversal, ETD/ETA, sectors
///   fiOutput   — flow information: TMI flight lists, FCAs, ground stops, GDPs
/// </summary>
class TfmsBridge
{
    private readonly string _user, _pass, _queue, _host, _vpn;
    private readonly JsonSerializerOptions _jsonOpts;

    // callsign → TfmsFlight (latest track/route data from TFMS)
    private readonly ConcurrentDictionary<string, TfmsFlight> _flights = new();
    // tmiId → TfmsTmi (active TMIs)
    private readonly ConcurrentDictionary<string, TfmsTmi> _tmis = new();
    // callsign → flightRef key (for O(1) lookup by callsign)
    private readonly ConcurrentDictionary<string, string> _callsignIndex = new(StringComparer.OrdinalIgnoreCase);
    // flights modified since last flush
    private readonly ConcurrentDictionary<string, byte> _dirtyFlights = new();
    // TMIs modified since last flush
    private readonly ConcurrentDictionary<string, byte> _dirtyTmis = new();

    // WS clients for /tfms/ws (flight stream)
    private readonly ConcurrentDictionary<string, WsClient> _flightClients = new();
    // WS clients for /tfms/ws/tmi (TMI stream)
    private readonly ConcurrentDictionary<string, WsClient> _tmiClients = new();

    // Stats
    public long MessageCount;
    public long FltdCount;
    public long FiCount;
    public bool Connected;

    // Raw XML element discovery (for investigating available TFMS fields)
    private readonly ConcurrentDictionary<string, string> _elementPaths = new();
    private int _rawSampleCount = 0;
    private readonly ConcurrentDictionary<string, string> _rawSamples = new(); // msgType → XML sample

    // APTC airport configuration: airport (FAA LID, e.g. "ATL") → latest config
    private readonly ConcurrentDictionary<string, AirportConfig> _aptc = new();

    public TfmsBridge(string user, string pass, string queue, string host, string vpn,
        JsonSerializerOptions jsonOpts)
    {
        _user = user; _pass = pass; _queue = queue; _host = host; _vpn = vpn;
        _jsonOpts = jsonOpts;
    }

    public void Start()
    {
        if (string.IsNullOrEmpty(_user))
        {
            Console.WriteLine("[TFMS] No credentials configured — TFMS disabled");
            return;
        }
        var t = new Thread(Run) { IsBackground = true, Name = "TfmsReceiver" };
        t.Start();
    }

    // ── Solace receive loop ──────────────────────────────────────────────────

    private void Run()
    {
        while (true)
        {
            long lastMsgTicks = DateTime.UtcNow.Ticks;
            try
            {
                using var context = ContextFactory.Instance.CreateContext(new ContextProperties(), null);
                var sessionProps = new SessionProperties
                {
                    Host = _host, VPNName = _vpn, UserName = _user, Password = _pass,
                    ReconnectRetries = 100, ReconnectRetriesWaitInMsecs = 5000,
                    SSLValidateCertificate = false,
                    CompressionLevel = 1   // FAA SCDS requires compressed data; minimum level (decompression cost is level-independent)
                };

                using var session = context.CreateSession(sessionProps, null,
                    (_, e) => Console.WriteLine($"[TFMS] {e.Event} - {e.Info}"));

                var rc = session.Connect();
                if (rc != ReturnCode.SOLCLIENT_OK)
                {
                    Console.Error.WriteLine($"[TFMS] Connect returned {rc}, retrying...");
                    Thread.Sleep(10000);
                    continue;
                }

                Console.WriteLine("[TFMS] Connected to TFMS");
                Connected = true;
                Interlocked.Exchange(ref lastMsgTicks, DateTime.UtcNow.Ticks);

                var solQueue = ContextFactory.Instance.CreateQueue(_queue);
                using var flow = session.CreateFlow(
                    new FlowProperties { AckMode = MessageAckMode.AutoAck }, solQueue, null,
                    (_, msgArgs) =>
                    {
                        using var m = msgArgs.Message;
                        Interlocked.Exchange(ref lastMsgTicks, DateTime.UtcNow.Ticks);
                        ProcessMessage(m);
                    },
                    (_, flowArgs) => Console.WriteLine($"[TFMS Flow] {flowArgs.Event} - {flowArgs.Info}"));

                flow.Start();
                Console.WriteLine("[TFMS] Listening on TFMS queue");

                int watchdogCycles = 0;
                while (true)
                {
                    Thread.Sleep(10000);
                    watchdogCycles++;
                    var silence = (DateTime.UtcNow -
                        new DateTime(Interlocked.Read(ref lastMsgTicks), DateTimeKind.Utc)).TotalSeconds;
                    if (silence > 90)
                    {
                        Console.WriteLine($"[TFMS] No messages for {silence:F0}s — reconnecting");
                        break;
                    }
                    // Log stats every ~60s
                    if (watchdogCycles % 6 == 0)
                    {
                        Console.WriteLine($"[TFMS] {_flights.Count} flights, {_tmis.Count} TMIs, " +
                            $"{Interlocked.Read(ref MessageCount)} msgs ({Interlocked.Read(ref FltdCount)} fltd, {Interlocked.Read(ref FiCount)} fi)");
                    }
                }

                Connected = false;
                try { session.Disconnect(); }
                catch (Exception ex) { Console.WriteLine($"[TFMS] Disconnect: {ex.Message}"); }
            }
            catch (Exception ex) { Console.Error.WriteLine($"[TFMS] Error: {ex.Message}"); }

            Console.WriteLine("[TFMS] Reconnecting in 10 seconds...");
            Thread.Sleep(10000);
        }
    }

    // ── Message processing ──────────────────────────────────────────────────

    private void ProcessMessage(IMessage message)
    {
        string? body = null;
        if (message.BinaryAttachment is { Length: > 0 })
            body = Encoding.UTF8.GetString(message.BinaryAttachment);
        else if (message.XmlContent is { Length: > 0 })
            body = Encoding.UTF8.GetString(message.XmlContent);
        if (body is null) return;

        Interlocked.Increment(ref MessageCount);

        try
        {
            var doc = XDocument.Parse(body);
            var root = doc.Root;
            if (root is null) return;

            // fltdOutput — flight track/plan data
            foreach (var fltdOutput in root.Elements().Where(e => e.Name.LocalName == "fltdOutput"))
            {
                foreach (var msg in fltdOutput.Elements().Where(e => e.Name.LocalName == "fltdMessage"))
                {
                    Interlocked.Increment(ref FltdCount);
                    ProcessFltdMessage(msg);
                }
            }

            // fiOutput — flow information (TMI, FCA, etc.)
            foreach (var fiOutput in root.Elements().Where(e => e.Name.LocalName == "fiOutput"))
            {
                foreach (var msg in fiOutput.Elements().Where(e => e.Name.LocalName == "fiMessage"))
                {
                    Interlocked.Increment(ref FiCount);
                    ProcessFiMessage(msg);
                }
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[TFMS] Parse error: {ex.Message}");
        }
    }

    private void ProcessFltdMessage(XElement msg)
    {
        // Element discovery: capture unique XML paths from first 500 messages
        if (_rawSampleCount < 500)
        {
            Interlocked.Increment(ref _rawSampleCount);
            void DiscoverPaths(XElement el, string prefix)
            {
                var path = prefix + "/" + el.Name.LocalName;
                foreach (var attr in el.Attributes())
                    _elementPaths.TryAdd(path + "/@" + attr.Name.LocalName, attr.Value);
                if (!el.HasElements && !string.IsNullOrEmpty(el.Value))
                    _elementPaths.TryAdd(path, el.Value);
                foreach (var child in el.Elements())
                    DiscoverPaths(child, path);
            }
            DiscoverPaths(msg, "fltdMessage");
            // Capture one raw sample per msgType
            var mt = msg.Attribute("msgType")?.Value;
            if (mt is not null && !_rawSamples.ContainsKey(mt))
                _rawSamples[mt] = msg.ToString();
        }

        var acid = msg.Attribute("acid")?.Value;
        if (acid is null) return;

        var flightRef = msg.Attribute("flightRef")?.Value;
        var airline = msg.Attribute("airline")?.Value;
        var depArpt = msg.Attribute("depArpt")?.Value;
        var arrArpt = msg.Attribute("arrArpt")?.Value;
        var msgType = msg.Attribute("msgType")?.Value;
        var sourceFacility = msg.Attribute("sourceFacility")?.Value;
        var sourceTs = msg.Attribute("sourceTimeStamp")?.Value;
        var fdTrigger = msg.Attribute("fdTrigger")?.Value;
        var sensitivity = msg.Attribute("sensitivity")?.Value;
        var cdmPart = msg.Attribute("cdmPart")?.Value;

        // Find primary info block (trackInformation or flightPlanInformation take precedence)
        var trackInfo = msg.Elements().FirstOrDefault(e => e.Name.LocalName == "trackInformation");
        var planInfo = msg.Elements().FirstOrDefault(e => e.Name.LocalName == "flightPlanInformation");
        var depInfo = msg.Elements().FirstOrDefault(e => e.Name.LocalName == "departureInformation");
        var arrInfo = msg.Elements().FirstOrDefault(e => e.Name.LocalName == "arrivalInformation");
        var modInfo = msg.Elements().FirstOrDefault(e => e.Name.LocalName == "ncsmFlightModify");
        var routeInfo = msg.Elements().FirstOrDefault(e => e.Name.LocalName == "ncsmFlightRoute");
        var timesInfo = msg.Elements().FirstOrDefault(e => e.Name.LocalName == "ncsmFlightTimes");
        var amendInfo = msg.Elements().FirstOrDefault(e => e.Name.LocalName == "flightPlanAmendmentInformation");
        var info = trackInfo ?? planInfo ?? depInfo ?? arrInfo ?? modInfo ?? routeInfo ?? timesInfo ?? amendInfo;
        if (info is null) return;

        var qid = info.Elements().FirstOrDefault(e => e.Name.LocalName == "qualifiedAircraftId");
        var gufi = qid?.Elements().FirstOrDefault(e => e.Name.LocalName == "gufi")?.Value;
        var igtdStr = qid?.Elements().FirstOrDefault(e => e.Name.LocalName == "igtd")?.Value;
        DateTime? igtd = null;
        if (igtdStr is not null && DateTime.TryParse(igtdStr, null, DateTimeStyles.AdjustToUniversal, out var igtdT))
            igtd = igtdT;
        var category = qid?.Attribute("aircraftCategory")?.Value;
        var userCategory = qid?.Attribute("userCategory")?.Value;
        var cid = qid?.Elements().FirstOrDefault(e => e.Name.LocalName == "computerId");
        var facility = cid?.Elements().FirstOrDefault(e => e.Name.LocalName == "facilityIdentifier")?.Value;
        var idNumber = cid?.Elements().FirstOrDefault(e => e.Name.LocalName == "idNumber")?.Value;

        // Use flightRef as key (stable across messages for same flight)
        var key = flightRef ?? acid;
        var flight = _flights.GetOrAdd(key, _ => new TfmsFlight { FlightRef = flightRef ?? "" });

        // If the flight's callsign changed (amendment), remove the old index entry
        // so old-callsign lookups don't return this flight under its new identity.
        var prevCallsign = flight.Callsign;
        if (prevCallsign is not null
            && !string.Equals(prevCallsign, acid, StringComparison.OrdinalIgnoreCase)
            && _callsignIndex.TryGetValue(prevCallsign, out var prevKey)
            && prevKey == key)
        {
            _callsignIndex.TryRemove(prevCallsign, out _);
        }
        flight.Callsign = acid;
        _callsignIndex[acid] = key;  // O(1) callsign lookup
        flight.Airline = airline;
        flight.LastSeen = DateTime.UtcNow;
        if (depArpt is not null) flight.DepArpt = depArpt;
        if (arrArpt is not null) flight.ArrArpt = arrArpt;
        if (gufi is not null) flight.Gufi = gufi;
        if (category is not null) flight.AircraftCategory = category;
        if (userCategory is not null) flight.UserCategory = userCategory;
        if (facility is not null) flight.Facility = facility;
        if (idNumber is not null) flight.IdNumber = idNumber;

        // Aircraft type — from flightAircraftSpecs (planInfo/depInfo) or aircraftSpecification (ncsm blocks)
        string? acType = null;
        foreach (var block in new[] { planInfo, depInfo, amendInfo })
        {
            if (block is null) continue;
            var specs = block.Elements().FirstOrDefault(e => e.Name.LocalName == "flightAircraftSpecs");
            if (specs is not null) { acType = specs.Value; break; }
            // Amendment uses newFlightAircraftSpecs inside amendmentData
            var amendData = block.Elements().FirstOrDefault(e => e.Name.LocalName == "amendmentData");
            var newSpecs = amendData?.Elements().FirstOrDefault(e => e.Name.LocalName == "newFlightAircraftSpecs");
            if (newSpecs is not null) { acType = newSpecs.Value; break; }
        }
        if (acType is null)
        {
            foreach (var block in new[] { modInfo, routeInfo, timesInfo })
            {
                var fss = block?.Elements().FirstOrDefault(e => e.Name.LocalName == "flightStatusAndSpec");
                var spec = fss?.Elements().FirstOrDefault(e => e.Name.LocalName == "aircraftSpecification");
                if (spec is not null) { acType = spec.Value; break; }
            }
        }
        if (!string.IsNullOrEmpty(acType)) flight.AircraftType = acType;
        if (igtd is not null) flight.Igtd = igtd;

        // Message-level attributes
        if (fdTrigger is not null) flight.FdTrigger = fdTrigger;
        if (sensitivity is not null) flight.Sensitivity = sensitivity;
        if (cdmPart is not null) flight.CdmPart = cdmPart;
        if (sourceFacility is not null) flight.SourceFacility = sourceFacility;

        // FlightStatus & aircraft details from flightStatusAndSpec blocks
        // In ncsmFlightModify, flightStatusAndSpec is nested under airlineData
        var modAirlineData = modInfo?.Elements().FirstOrDefault(e => e.Name.LocalName == "airlineData");
        foreach (var block in new[] { modAirlineData, routeInfo, timesInfo })
        {
            var fss = block?.Elements().FirstOrDefault(e => e.Name.LocalName == "flightStatusAndSpec");
            if (fss is null) continue;
            var status = fss.Elements().FirstOrDefault(e => e.Name.LocalName == "flightStatus")?.Value;
            if (status is not null) flight.FlightStatus = status;
            var model = fss.Elements().FirstOrDefault(e => e.Name.LocalName == "aircraftModel")?.Value;
            if (model is not null) flight.AircraftModel = model;
            var saq = fss.Elements().FirstOrDefault(e => e.Name.LocalName == "specialAircraftQualifier")?.Value;
            if (saq is not null) flight.SpecialAircraftQualifier = saq;
            var engine = fss.Elements().FirstOrDefault(e => e.Name.LocalName == "aircraftEngineClass")?.Value;
            if (engine is not null) flight.AircraftEngineClass = engine;
        }

        // CDM airline times from ncsmFlightModify/airlineData
        if (modInfo is not null) ParseCdmTimes(flight, modInfo);

        // Flight plan extras — these can appear in any of these message blocks.
        // ParseFlightPlanExtras only writes fields it finds, so it's safe to call
        // on every block (later blocks won't clobber earlier extracted values
        // unless they actually have new data for those fields).
        foreach (var block in new[] { planInfo, depInfo, modInfo, routeInfo, timesInfo, trackInfo })
        {
            if (block is not null) ParseFlightPlanExtras(flight, block);
        }
        if (amendInfo is not null)
        {
            var amendData = amendInfo.Elements().FirstOrDefault(e => e.Name.LocalName == "amendmentData");
            if (amendData is not null) ParseFlightPlanExtras(flight, amendData);
        }

        // Boundary crossing from boundaryCrossingUpdate (inside trackInfo or as its own block)
        var bcUpdate = msg.Elements().FirstOrDefault(e => e.Name.LocalName == "boundaryCrossingUpdate");
        if (bcUpdate is not null) ParseBoundaryCrossing(flight, bcUpdate);

        // SID / departure procedure from ncsmFlightRoute
        if (routeInfo is not null) ParseDepartureProc(flight, routeInfo);

        // Reported altitude raw (with conformance suffix)
        var rawAlt = info.Elements().FirstOrDefault(e => e.Name.LocalName == "reportedAltitude");
        var simpleRaw = rawAlt?.Descendants().FirstOrDefault(e => e.Name.LocalName == "simpleAltitude")?.Value;
        if (simpleRaw is not null) flight.ReportedAltitudeRaw = simpleRaw;

        // Track data extras (nextEvent position)
        var ncsmTrack = info.Elements().FirstOrDefault(e => e.Name.LocalName == "ncsmTrackData");
        if (ncsmTrack is not null)
        {
            var nextEvent = ncsmTrack.Elements().FirstOrDefault(e => e.Name.LocalName == "nextEvent");
            if (nextEvent is not null)
            {
                var lat = ParseDms(nextEvent, "latitude", "latitudeDMS");
                var lon = ParseDms(nextEvent, "longitude", "longitudeDMS");
                if (lat.HasValue) flight.NextEventLat = lat.Value;
                if (lon.HasValue) flight.NextEventLon = lon.Value;
            }
        }

        // Assigned beacon code
        var beaconCode = info.Elements().FirstOrDefault(e => e.Name.LocalName == "assignedBeaconCode")?.Value;
        if (beaconCode is null)
        {
            // Also check in flightPlanInformation
            beaconCode = planInfo?.Elements().FirstOrDefault(e => e.Name.LocalName == "assignedBeaconCode")?.Value;
        }
        if (beaconCode is not null) flight.AssignedBeaconCode = beaconCode;

        // Ground speed (from ncsmFlightRoute or ncsmFlightModify)
        foreach (var block in new[] { routeInfo, modInfo })
        {
            var gsStr = block?.Elements().FirstOrDefault(e => e.Name.LocalName == "groundSpeed")?.Value;
            if (int.TryParse(gsStr, out var gs)) { flight.GroundSpeed = gs; break; }
        }

        // Speed
        var speedStr = info.Elements().FirstOrDefault(e => e.Name.LocalName == "speed")?.Value;
        if (int.TryParse(speedStr, out var spd)) flight.Speed = spd;

        // Altitude (simpleAltitude is in hundreds of feet, like "360" = FL360)
        var altEl = info.Elements().FirstOrDefault(e => e.Name.LocalName == "reportedAltitude");
        var simpleAlt = altEl?.Descendants().FirstOrDefault(e => e.Name.LocalName == "simpleAltitude")?.Value;
        if (simpleAlt is not null)
        {
            // Remove trailing 'C' (climbing) or other suffixes
            var altClean = simpleAlt.TrimEnd('C', 'D', 'A');
            if (int.TryParse(altClean, out var alt)) flight.Altitude = alt * 100;
        }

        // Position (DMS format)
        var posEl = info.Elements().FirstOrDefault(e => e.Name.LocalName == "position");
        if (posEl is not null)
        {
            var lat = ParseDms(posEl, "latitude", "latitudeDMS");
            var lon = ParseDms(posEl, "longitude", "longitudeDMS");
            if (lat.HasValue && lon.HasValue)
            {
                flight.Latitude = lat.Value;
                flight.Longitude = lon.Value;
            }
        }

        var timeAtPos = info.Elements().FirstOrDefault(e => e.Name.LocalName == "timeAtPosition")?.Value;
        if (timeAtPos is not null && DateTime.TryParse(timeAtPos, null, DateTimeStyles.AdjustToUniversal, out var tap))
            flight.PositionTime = tap;

        // Route data (ncsmRouteData — full route with traversal)
        // Search all info blocks since route may appear in flightPlanInformation, ncsmFlightRoute, etc.
        XElement? routeData = null;
        foreach (var block in new[] { info, planInfo, routeInfo, trackInfo })
        {
            routeData = block?.Elements().FirstOrDefault(e => e.Name.LocalName == "ncsmRouteData");
            if (routeData is not null) break;
        }
        if (routeData is not null) ParseRouteData(flight, routeData);

        // Track data (ncsmTrackData — lighter, ETA only)
        var trackData = info.Elements().FirstOrDefault(e => e.Name.LocalName == "ncsmTrackData");
        if (trackData is not null) ParseTrackData(flight, trackData);

        _dirtyFlights[key] = 0;
    }

    private void ParseRouteData(TfmsFlight flight, XElement routeData)
    {
        // ETD/ETA
        var etd = routeData.Elements().FirstOrDefault(e => e.Name.LocalName == "etd");
        if (etd is not null)
        {
            var tv = etd.Attribute("timeValue")?.Value;
            if (tv is not null && DateTime.TryParse(tv, null, DateTimeStyles.AdjustToUniversal, out var t))
                flight.Etd = t;
        }

        var eta = routeData.Elements().FirstOrDefault(e => e.Name.LocalName == "eta");
        if (eta is not null)
        {
            var tv = eta.Attribute("timeValue")?.Value;
            if (tv is not null && DateTime.TryParse(tv, null, DateTimeStyles.AdjustToUniversal, out var t))
                flight.Eta = t;
        }

        // STAR
        var star = routeData.Elements().FirstOrDefault(e => e.Name.LocalName == "star");
        if (star is not null) flight.Star = star.Attribute("routeName")?.Value;

        // Star transition fix
        var starTrans = routeData.Elements().FirstOrDefault(e => e.Name.LocalName == "starTransitionFix")?.Value;
        if (starTrans is not null) flight.StarTransitionFix = starTrans;

        // Departure procedure (sibling of star inside ncsmRouteData):
        //   <dp routeName="ALTNN2" routeType="DIRECT" />
        //   <dpTransitionFix>DUCEN</dpTransitionFix>
        var dp = routeData.Elements().FirstOrDefault(e => e.Name.LocalName == "dp");
        if (dp is not null)
        {
            var dpName = dp.Attribute("routeName")?.Value;
            if (!string.IsNullOrEmpty(dpName)) flight.DpName = dpName;
            var dpType = dp.Attribute("routeType")?.Value;
            if (!string.IsNullOrEmpty(dpType)) flight.DpType = dpType;
        }
        var dpTrans = routeData.Elements().FirstOrDefault(e => e.Name.LocalName == "dpTransitionFix")?.Value;
        if (!string.IsNullOrEmpty(dpTrans)) flight.DpTransitionFix = dpTrans;

        // Route of flight (legacyFormat attribute is the human-readable string,
        // e.g. "KDFW.JASPA7.WINDU.QERVO3.KSAT/2051"). Element text is empty.
        var routeOfFlightEl = routeData.Elements().FirstOrDefault(e => e.Name.LocalName == "routeOfFlight");
        var routeText = routeOfFlightEl?.Attribute("legacyFormat")?.Value;
        if (string.IsNullOrEmpty(routeText)) routeText = routeOfFlightEl?.Value;
        if (!string.IsNullOrEmpty(routeText)) flight.RouteOfFlight = routeText;
        // Amendments use newRouteOfFlight under flightPlanAmendmentInformation/amendmentData
        var amendData = routeData.Parent?.Elements().FirstOrDefault(e => e.Name.LocalName == "amendmentData");
        var newRoute = amendData?.Elements().FirstOrDefault(e => e.Name.LocalName == "newRouteOfFlight")?.Attribute("legacyFormat")?.Value;
        if (!string.IsNullOrEmpty(newRoute)) flight.RouteOfFlight = newRoute;

        // Arrival fix + time
        var arrFix = routeData.Elements().FirstOrDefault(e => e.Name.LocalName == "arrivalFixAndTime");
        if (arrFix is not null)
        {
            flight.ArrivalFix = arrFix.Attribute("fixName")?.Value;
            var arrTime = arrFix.Attribute("arrTime")?.Value;
            if (arrTime is not null && DateTime.TryParse(arrTime, null, DateTimeStyles.AdjustToUniversal, out var at))
                flight.ArrivalFixTime = at;
        }

        // Departure fix + time
        var depFix = routeData.Elements().FirstOrDefault(e => e.Name.LocalName == "departureFixAndTime");
        if (depFix is not null)
        {
            flight.DepartureFix = depFix.Attribute("fixName")?.Value;
            var depTime = depFix.Attribute("arrTime")?.Value;
            if (depTime is not null && DateTime.TryParse(depTime, null, DateTimeStyles.AdjustToUniversal, out var dt))
                flight.DepartureFixTime = dt;
        }

        // Diversion indicator
        var div = routeData.Elements().FirstOrDefault(e => e.Name.LocalName == "diversionIndicator")?.Value;
        if (div is not null) flight.DiversionIndicator = div;

        // Flight traversal data (fix-by-fix route with lat/lon waypoints + sector crossings)
        var traversal = routeData.Elements().FirstOrDefault(e => e.Name.LocalName == "flightTraversalData2");
        if (traversal is not null) ParseTraversal(flight, traversal);
    }

    private void ParseTraversal(TfmsFlight flight, XElement traversal)
    {
        // Fixes (named waypoints with elapsed time from departure)
        var fixes = new List<TfmsRouteFix>();
        foreach (var fix in traversal.Elements().Where(e => e.Name.LocalName == "fix"))
        {
            var name = fix.Value;
            var seqStr = fix.Attribute("sequenceNumber")?.Value;
            var etStr = fix.Attribute("elapsedTime")?.Value;
            int.TryParse(seqStr, out var seq);
            int? elapsed = int.TryParse(etStr, out var et) ? et : null;
            fixes.Add(new TfmsRouteFix { Name = name, SequenceNumber = seq, ElapsedTime = elapsed });
        }
        if (fixes.Count > 0) flight.Fixes = fixes;

        // Waypoints (lat/lon with elapsed time — pre-resolved route points)
        var waypoints = new List<TfmsWaypoint>();
        foreach (var wp in traversal.Elements().Where(e => e.Name.LocalName == "waypoint"))
        {
            var latStr = wp.Attribute("latitudeDecimal")?.Value;
            var lonStr = wp.Attribute("longitudeDecimal")?.Value;
            var etStr = wp.Attribute("elapsedTime")?.Value;
            if (double.TryParse(latStr, NumberStyles.Any, CultureInfo.InvariantCulture, out var lat)
                && double.TryParse(lonStr, NumberStyles.Any, CultureInfo.InvariantCulture, out var lon))
            {
                int? elapsed = int.TryParse(etStr, out var et) ? et : null;
                waypoints.Add(new TfmsWaypoint { Lat = lat, Lon = lon, ElapsedTime = elapsed });
            }
        }
        if (waypoints.Count > 0) flight.Waypoints = waypoints;

        // Airways
        var airways = new List<string>();
        foreach (var aw in traversal.Elements().Where(e => e.Name.LocalName == "airway"))
            if (!string.IsNullOrEmpty(aw.Value)) airways.Add(aw.Value);
        if (airways.Count > 0) flight.Airways = airways;

        // Centers (ARTCC crossings with entry time)
        var centers = new List<TfmsSectorEntry>();
        foreach (var c in traversal.Elements().Where(e => e.Name.LocalName == "center"))
        {
            var etStr = c.Attribute("elapsedEntryTime")?.Value;
            int? elapsed = int.TryParse(etStr, out var et) ? et : null;
            centers.Add(new TfmsSectorEntry { Name = c.Value, ElapsedEntryTime = elapsed });
        }
        if (centers.Count > 0) flight.Centers = centers;

        // Sectors (sector-by-sector traversal with entry time)
        var sectors = new List<TfmsSectorEntry>();
        foreach (var s in traversal.Elements().Where(e => e.Name.LocalName == "sector"))
        {
            var etStr = s.Attribute("elapsedEntryTime")?.Value;
            int? elapsed = int.TryParse(etStr, out var et) ? et : null;
            sectors.Add(new TfmsSectorEntry { Name = s.Value, ElapsedEntryTime = elapsed });
        }
        if (sectors.Count > 0) flight.Sectors = sectors;
    }

    private void ParseTrackData(TfmsFlight flight, XElement trackData)
    {
        // ETA (lighter messages without full route)
        var eta = trackData.Elements().FirstOrDefault(e => e.Name.LocalName == "eta");
        if (eta is not null)
        {
            var tv = eta.Attribute("timeValue")?.Value;
            if (tv is not null && DateTime.TryParse(tv, null, DateTimeStyles.AdjustToUniversal, out var t))
                flight.Eta = t;
        }

        var arrFix = trackData.Elements().FirstOrDefault(e => e.Name.LocalName == "arrivalFixAndTime");
        if (arrFix is not null)
        {
            flight.ArrivalFix = arrFix.Attribute("fixName")?.Value;
            var arrTime = arrFix.Attribute("arrTime")?.Value;
            if (arrTime is not null && DateTime.TryParse(arrTime, null, DateTimeStyles.AdjustToUniversal, out var at))
                flight.ArrivalFixTime = at;
        }

        var depFix = trackData.Elements().FirstOrDefault(e => e.Name.LocalName == "departureFixAndTime");
        if (depFix is not null)
        {
            flight.DepartureFix = depFix.Attribute("fixName")?.Value;
            var depTime = depFix.Attribute("arrTime")?.Value;
            if (depTime is not null && DateTime.TryParse(depTime, null, DateTimeStyles.AdjustToUniversal, out var dt))
                flight.DepartureFixTime = dt;
        }
    }

    private void ParseCdmTimes(TfmsFlight flight, XElement modInfo)
    {
        var airlineData = modInfo.Elements().FirstOrDefault(e => e.Name.LocalName == "airlineData");
        if (airlineData is null) return;

        // flightTimeData carries all CDM times as attributes
        var ftd = airlineData.Elements().FirstOrDefault(e => e.Name.LocalName == "flightTimeData");
        if (ftd is not null)
        {
            void SetAttr(string attr, Action<TfmsFlight, DateTime> setter)
            {
                var val = ftd.Attribute(attr)?.Value;
                if (val is not null && DateTime.TryParse(val, null, DateTimeStyles.AdjustToUniversal, out var t))
                    setter(flight, t);
            }
            SetAttr("airlineOutTime", (f, t) => f.AirlineOutTime = t);
            SetAttr("airlineOffTime", (f, t) => f.AirlineOffTime = t);
            SetAttr("airlineOnTime", (f, t) => f.AirlineOnTime = t);
            SetAttr("airlineInTime", (f, t) => f.AirlineInTime = t);
            SetAttr("gateDeparture", (f, t) => f.GateDeparture = t);
            SetAttr("gateArrival", (f, t) => f.GateArrival = t);
            SetAttr("runwayDeparture", (f, t) => f.RunwayDeparture = t);
            SetAttr("runwayArrival", (f, t) => f.RunwayArrival = t);
            SetAttr("originalDeparture", (f, t) => f.OriginalDeparture = t);
            SetAttr("originalArrival", (f, t) => f.OriginalArrival = t);
            SetAttr("flightCreation", (f, t) => f.FlightCreation = t);
        }

        // ETD/ETA from airlineData (may be more accurate than outer level)
        SetTimeAttr(airlineData, "etd", "timeValue", ref flight, (f, t) => f.Etd = t);
        SetTimeAttr(airlineData, "eta", "timeValue", ref flight, (f, t) => f.Eta = t);
    }

    private static void SetTime(XElement parent, string name, ref TfmsFlight flight, Action<TfmsFlight, DateTime> setter)
    {
        var val = parent.Elements().FirstOrDefault(e => e.Name.LocalName == name)?.Value;
        if (val is not null && DateTime.TryParse(val, null, DateTimeStyles.AdjustToUniversal, out var t))
            setter(flight, t);
    }

    private static void SetTimeAttr(XElement parent, string elemName, string attrName, ref TfmsFlight flight, Action<TfmsFlight, DateTime> setter)
    {
        var el = parent.Elements().FirstOrDefault(e => e.Name.LocalName == elemName);
        var val = el?.Attribute(attrName)?.Value ?? el?.Value;
        if (val is not null && DateTime.TryParse(val, null, DateTimeStyles.AdjustToUniversal, out var t))
            setter(flight, t);
    }

    private void ParseFlightPlanExtras(TfmsFlight flight, XElement planBlock)
    {
        // Altitudes are nested as: planBlock/altitude/requestedAltitude/simpleAltitude
        // Amendments use:           planBlock/newAltitude/assignedAltitude/simpleAltitude
        // Track info uses:          trackInformation/reportedAltitude/assignedAltitude/simpleAltitude
        // Use Descendants() to walk through the nested wrappers.
        string? AltText(string elementName)
        {
            var el = planBlock.Descendants().FirstOrDefault(e => e.Name.LocalName == elementName);
            if (el is null) return null;
            // simpleAltitude under it (preferred), else element's text value
            var simple = el.Descendants().FirstOrDefault(e => e.Name.LocalName == "simpleAltitude")?.Value;
            return !string.IsNullOrEmpty(simple) ? simple : el.Value;
        }
        int? AltFeet(string elementName)
        {
            var v = AltText(elementName);
            if (string.IsNullOrEmpty(v)) return null;
            // Trim suffix letters like "C" (cleared), "D" (descend), "A" (assigned)
            var clean = new string(v.TrimEnd().TakeWhile(char.IsDigit).ToArray());
            if (int.TryParse(clean, out var n)) return n * 100;
            return null;
        }

        var req = AltFeet("requestedAltitude");
        if (req.HasValue) flight.RequestedAltitude = req.Value;
        var asg = AltFeet("assignedAltitude");
        if (asg.HasValue) flight.AssignedAltitude = asg.Value;

        // Coordination point
        var coordPt = planBlock.Descendants().FirstOrDefault(e => e.Name.LocalName == "coordinationPoint");
        if (coordPt is not null)
        {
            var fix = coordPt.Descendants().FirstOrDefault(e => e.Name.LocalName == "fixRadialDistance")
                ?? coordPt.Descendants().FirstOrDefault(e => e.Name.LocalName == "fix");
            flight.CoordinationFix = fix?.Value ?? coordPt.Value;
        }
        var coordTime = planBlock.Descendants().FirstOrDefault(e => e.Name.LocalName == "coordinationTime");
        if (coordTime is not null)
        {
            var tv = coordTime.Attribute("timeValue")?.Value ?? coordTime.Value;
            if (tv is not null && DateTime.TryParse(tv, null, DateTimeStyles.AdjustToUniversal, out var ct))
                flight.CoordinationTime = ct;
        }

        // Speed nested as: planBlock/speed/filedTrueAirSpeed (or under newSpeed for amendments)
        var tasStr = planBlock.Descendants().FirstOrDefault(e => e.Name.LocalName == "filedTrueAirSpeed")?.Value;
        if (int.TryParse(tasStr, out var tas)) flight.FiledTrueAirSpeed = tas;

        var machStr = planBlock.Descendants().FirstOrDefault(e => e.Name.LocalName == "filedMach")?.Value;
        if (!string.IsNullOrEmpty(machStr)) flight.FiledMach = machStr;

        // Equipment qualifier + special aircraft qualifier — both ATTRIBUTES on
        // flightAircraftSpecs (or newFlightAircraftSpecs in amendments).
        //   <flightAircraftSpecs equipmentQualifier="L" specialAircraftQualifier="HEAVY JET">A319</flightAircraftSpecs>
        var specsEl = planBlock.Descendants()
            .FirstOrDefault(e => e.Name.LocalName == "flightAircraftSpecs" || e.Name.LocalName == "newFlightAircraftSpecs");
        if (specsEl is not null)
        {
            var eq = specsEl.Attribute("equipmentQualifier")?.Value;
            if (!string.IsNullOrEmpty(eq)) flight.EquipmentQualifier = eq;
            var saq = specsEl.Attribute("specialAircraftQualifier")?.Value;
            if (!string.IsNullOrEmpty(saq)) flight.SpecialAircraftQualifier = saq;
        }

        // Aircraft engine class — under aircraftSpecification (in ncsm blocks)
        var engineClass = planBlock.Descendants()
            .FirstOrDefault(e => e.Name.LocalName == "aircraftSpecification")?.Attribute("aircraftEngineClass")?.Value;
        if (!string.IsNullOrEmpty(engineClass)) flight.AircraftEngineClass = engineClass;

        // Note: TFMS R14 does NOT publish beacon codes — they live in SFDPS only.
    }

    private void ParseBoundaryCrossing(TfmsFlight flight, XElement bc)
    {
        var info = bc.Elements().FirstOrDefault(e => e.Name.LocalName == "boundaryCrossingInformation")
            ?? bc;

        var timeVal = info.Elements().FirstOrDefault(e => e.Name.LocalName == "boundaryCrossingTime");
        var tv = timeVal?.Attribute("timeValue")?.Value ?? timeVal?.Value;
        if (tv is not null && DateTime.TryParse(tv, null, DateTimeStyles.AdjustToUniversal, out var bct))
            flight.BoundaryCrossingTime = bct;

        var fix = info.Elements().FirstOrDefault(e => e.Name.LocalName == "boundaryCrossingFix")?.Value;
        if (fix is not null) flight.BoundaryFix = fix;

        var radStr = info.Elements().FirstOrDefault(e => e.Name.LocalName == "boundaryCrossingRadial")?.Value;
        if (int.TryParse(radStr, out var rad)) flight.BoundaryRadial = rad;

        var distStr = info.Elements().FirstOrDefault(e => e.Name.LocalName == "boundaryCrossingDistance")?.Value;
        if (int.TryParse(distStr, out var dist)) flight.BoundaryDistance = dist;
    }

    private void ParseDepartureProc(TfmsFlight flight, XElement routeInfo)
    {
        var dp = routeInfo.Elements().FirstOrDefault(e => e.Name.LocalName == "dp");
        if (dp is null) return;
        flight.DpName = dp.Attribute("routeName")?.Value;
        flight.DpType = dp.Attribute("routeType")?.Value;

        var transFix = routeInfo.Elements().FirstOrDefault(e => e.Name.LocalName == "dpTransitionFix")?.Value;
        if (transFix is not null) flight.DpTransitionFix = transFix;
    }

    private void ProcessFiMessage(XElement msg)
    {
        var msgType = msg.Attribute("msgType")?.Value;
        var sourceTs = msg.Attribute("sourceTimeStamp")?.Value;

        // Element discovery: capture unique XML paths from first 500 fiMessages.
        // Stored under "fiMessage:<msgType>" raw samples and into _elementPaths.
        if (_rawSampleCount < 500)
        {
            Interlocked.Increment(ref _rawSampleCount);
            void DiscoverPaths(XElement el, string prefix)
            {
                var path = prefix + "/" + el.Name.LocalName;
                foreach (var attr in el.Attributes())
                    _elementPaths.TryAdd(path + "/@" + attr.Name.LocalName, attr.Value);
                if (!el.HasElements && !string.IsNullOrEmpty(el.Value))
                    _elementPaths.TryAdd(path, el.Value);
                foreach (var child in el.Elements())
                    DiscoverPaths(child, path);
            }
            DiscoverPaths(msg, "fiMessage");
            var key = "fi:" + (msgType ?? "?");
            if (!_rawSamples.ContainsKey(key))
                _rawSamples[key] = msg.ToString();
        }

        // APTC — Airport Configuration message (current AAR/ADR rates, runway config, weather)
        var apt = msg.Elements().FirstOrDefault(e => e.Name.LocalName == "airportConfigMessage");
        if (apt is not null)
        {
            string? El(string n) => apt.Elements().FirstOrDefault(e => e.Name.LocalName == n)?.Value;
            int? IntEl(string n) => int.TryParse(El(n), out var v) ? v : null;
            DateTime? TimeEl(string n) => DateTime.TryParse(El(n), null, DateTimeStyles.AdjustToUniversal, out var v) ? v : null;
            var airport = El("airport");
            if (!string.IsNullOrEmpty(airport))
            {
                var cfg = _aptc.GetOrAdd(airport, _ => new AirportConfig { Airport = airport });
                cfg.Facility = El("facility") ?? cfg.Facility;
                cfg.EnteringFacility = El("enteringFacility") ?? cfg.EnteringFacility;
                cfg.ArrRate = IntEl("arrRate") ?? cfg.ArrRate;
                cfg.DepRate = IntEl("depRate") ?? cfg.DepRate;
                cfg.ArrRunwayConf = El("arrRunwayConf") ?? cfg.ArrRunwayConf;
                cfg.DepRunwayConf = El("depRunwayConf") ?? cfg.DepRunwayConf;
                cfg.StratAar = IntEl("stratAar") ?? cfg.StratAar;
                cfg.Weather = El("weather") ?? cfg.Weather;
                cfg.ArrUserSpecified = El("arrUserSpecified");
                cfg.DepUserSpecified = El("depUserSpecified");
                cfg.AdrEnteredOnPanel = El("adrEnteredOnPanel");
                cfg.DynArrEnteredOnPanel = El("dynArrEnteredOnPanel");
                cfg.AirportInFile = El("airportInFile");
                cfg.RemarksGroupColor = El("remarksGroupColor");
                cfg.EventTime = TimeEl("eventTime") ?? cfg.EventTime;
                cfg.EntryTime = TimeEl("entryTime") ?? cfg.EntryTime;
                cfg.UpdateTime = TimeEl("updateTime") ?? cfg.UpdateTime;
                cfg.LastSeen = DateTime.UtcNow;
            }
        }

        // TMI_FLIGHT_LIST — flights affected by a TMI
        var tmiFlightDataList = msg.Elements().FirstOrDefault(e => e.Name.LocalName == "tmiFlightDataList");
        if (tmiFlightDataList is not null)
        {
            foreach (var fd in tmiFlightDataList.Elements().Where(e => e.Name.LocalName == "flightData"))
            {
                var flightEl = fd.Elements().FirstOrDefault(e => e.Name.LocalName == "flight");
                if (flightEl is null) continue;

                var acid = flightEl.Elements().FirstOrDefault(e => e.Name.LocalName == "aircraftId")?.Value;
                var gufi = flightEl.Elements().FirstOrDefault(e => e.Name.LocalName == "gufi")?.Value;
                var dep = flightEl.Elements().FirstOrDefault(e => e.Name.LocalName == "departurePoint")
                    ?.Elements().FirstOrDefault(e => e.Name.LocalName == "airport")?.Value;
                var arr = flightEl.Elements().FirstOrDefault(e => e.Name.LocalName == "arrivalPoint")
                    ?.Elements().FirstOrDefault(e => e.Name.LocalName == "airport")?.Value;
                var status = fd.Elements().FirstOrDefault(e => e.Name.LocalName == "status")?.Value;
                var flightRef = fd.Elements().FirstOrDefault(e => e.Name.LocalName == "flightReference")?.Value;

                // TMI info
                var tmiInfoList = fd.Elements().FirstOrDefault(e => e.Name.LocalName == "tmiFlightInfoList");
                if (tmiInfoList is null) continue;

                foreach (var tmi in tmiInfoList.Elements().Where(e => e.Name.LocalName == "tmi"))
                {
                    var fcaId = tmi.Elements().FirstOrDefault(e => e.Name.LocalName == "fcaId")?.Value;
                    if (fcaId is null) continue;

                    var updateType = tmi.Attribute("updateType")?.Value;

                    // Create/update TMI
                    var tmiState = _tmis.GetOrAdd(fcaId, _ => new TfmsTmi { FcaId = fcaId });

                    // FXA flight data (entry/exit times for this FCA)
                    var fxaData = tmiInfoList.Elements().FirstOrDefault(e => e.Name.LocalName == "fxaFlightData");
                    if (fxaData is not null)
                    {
                        var fxaFlight = fxaData.Elements().FirstOrDefault(e => e.Name.LocalName == "fxaFlight");
                        if (fxaFlight is not null)
                        {
                            var fxaId = fxaFlight.Elements().FirstOrDefault(e => e.Name.LocalName == "fxaId");
                            var fcaName = fxaId?.Elements().FirstOrDefault(e => e.Name.LocalName == "fcaName")?.Value;
                            if (fcaName is not null) tmiState.FcaName = fcaName;

                            // Entry/exit times
                            var entryTm = fxaFlight.Elements().FirstOrDefault(e => e.Name.LocalName == "entryTm")?.Value;
                            var exitTm = fxaFlight.Elements().FirstOrDefault(e => e.Name.LocalName == "exitTm")?.Value;
                            var entryLat = fxaFlight.Elements().FirstOrDefault(e => e.Name.LocalName == "entryLat")?.Value;
                            var entryLon = fxaFlight.Elements().FirstOrDefault(e => e.Name.LocalName == "entryLon")?.Value;

                            // Add/update flight in TMI
                            if (acid is not null)
                            {
                                var tmiFlight = new TfmsTmiFlight
                                {
                                    Callsign = acid,
                                    DepArpt = dep,
                                    ArrArpt = arr,
                                    Status = status,
                                    FlightRef = flightRef,
                                    Gufi = gufi,
                                    UpdateType = updateType
                                };
                                if (entryTm is not null && DateTime.TryParse(entryTm, null, DateTimeStyles.AdjustToUniversal, out var et))
                                    tmiFlight.EntryTime = et;
                                if (exitTm is not null && DateTime.TryParse(exitTm, null, DateTimeStyles.AdjustToUniversal, out var xt))
                                    tmiFlight.ExitTime = xt;
                                if (double.TryParse(entryLat, NumberStyles.Any, CultureInfo.InvariantCulture, out var elat))
                                    tmiFlight.EntryLat = elat;
                                if (double.TryParse(entryLon, NumberStyles.Any, CultureInfo.InvariantCulture, out var elon))
                                    tmiFlight.EntryLon = elon;

                                tmiState.Flights[acid] = tmiFlight;
                            }
                        }
                    }

                    tmiState.LastUpdated = DateTime.UtcNow;
                    _dirtyTmis[fcaId] = 0;
                }
            }
        }
    }

    // ── DMS coordinate parsing ──────────────────────────────────────────────

    private static double? ParseDms(XElement parent, string containerName, string dmsName)
    {
        var container = parent.Elements().FirstOrDefault(e => e.Name.LocalName == containerName);
        if (container is null) return null;
        var dms = container.Elements().FirstOrDefault(e => e.Name.LocalName == dmsName);
        if (dms is null) return null;

        var degStr = dms.Attribute("degrees")?.Value;
        var minStr = dms.Attribute("minutes")?.Value;
        var secStr = dms.Attribute("seconds")?.Value;
        var dir = dms.Attribute("direction")?.Value;

        if (!int.TryParse(degStr, out var deg)) return null;
        int.TryParse(minStr, out var min);
        int.TryParse(secStr, out var sec);

        double val = deg + min / 60.0 + sec / 3600.0;
        if (dir is "SOUTH" or "WEST") val = -val;
        return val;
    }

    // ── Client management ───────────────────────────────────────────────────

    public string AddFlightClient(WsClient client)
    {
        var id = Guid.NewGuid().ToString("N");
        _flightClients[id] = client;

        // Send snapshot
        var snapshot = _flights.Values
            .Where(f => f.Latitude != 0 && f.Longitude != 0)
            .Select(f => f.ToJson(client.Reveal))
            .ToArray();
        var json = JsonSerializer.SerializeToUtf8Bytes(
            new { type = "snapshot", data = snapshot }, _jsonOpts);
        client.Queue.Writer.TryWrite(json);
        return id;
    }

    public void RemoveFlightClient(string id) => _flightClients.TryRemove(id, out _);

    /// <summary>TFMS flight for a callsign (O(1) via the callsign index), or null.</summary>
    public object? GetFlightByCallsign(string callsign)
    {
        if (_callsignIndex.TryGetValue(callsign, out var key) &&
            _flights.TryGetValue(key, out var f))
            return f.ToJson();
        return null;
    }

    public string AddTmiClient(WsClient client)
    {
        var id = Guid.NewGuid().ToString("N");
        _tmiClients[id] = client;

        var snapshot = _tmis.Values.Select(t => t.ToJson()).ToArray();
        var json = JsonSerializer.SerializeToUtf8Bytes(
            new { type = "snapshot", data = snapshot }, _jsonOpts);
        client.Queue.Writer.TryWrite(json);
        return id;
    }

    public void RemoveTmiClient(string id) => _tmiClients.TryRemove(id, out _);

    // ── Periodic flush/purge ────────────────────────────────────────────────

    public void FlushDirty()
    {
        // Flush dirty flights
        if (!_dirtyFlights.IsEmpty)
        {
            var keys = _dirtyFlights.Keys.ToList();
            foreach (var k in keys) _dirtyFlights.TryRemove(k, out _);

            if (!_flightClients.IsEmpty)
            {
                var flights = keys
                    .Where(k => _flights.ContainsKey(k))
                    .Select(k => _flights[k])
                    .ToList();
                if (flights.Count > 0)
                {
                    // Signed-in clients get real identities; everyone else the masked view.
                    byte[]? maskedJson = null, revealJson = null;
                    foreach (var c in _flightClients.Values)
                    {
                        byte[] json;
                        if (c.Reveal)
                            json = revealJson ??= JsonSerializer.SerializeToUtf8Bytes(
                                new { type = "batch", data = flights.Select(f => f.ToJson(true)).ToArray() }, _jsonOpts);
                        else
                            json = maskedJson ??= JsonSerializer.SerializeToUtf8Bytes(
                                new { type = "batch", data = flights.Select(f => f.ToJson(false)).ToArray() }, _jsonOpts);
                        c.Queue.Writer.TryWrite(json);
                    }
                }
            }
        }

        // Flush dirty TMIs
        if (!_dirtyTmis.IsEmpty)
        {
            var keys = _dirtyTmis.Keys.ToList();
            foreach (var k in keys) _dirtyTmis.TryRemove(k, out _);

            if (!_tmiClients.IsEmpty)
            {
                var updates = keys
                    .Where(k => _tmis.TryGetValue(k, out _))
                    .Select(k => _tmis[k].ToJson())
                    .ToArray();
                if (updates.Length > 0)
                {
                    var json = JsonSerializer.SerializeToUtf8Bytes(
                        new { type = "update", data = updates }, _jsonOpts);
                    foreach (var c in _tmiClients.Values)
                        c.Queue.Writer.TryWrite(json);
                }
            }
        }
    }

    public void PurgeStale()
    {
        var cutoff = DateTime.UtcNow.AddMinutes(-30);
        foreach (var (key, f) in _flights)
        {
            if (f.LastSeen < cutoff)
            {
                _flights.TryRemove(key, out _);
                // Only remove the callsign index entry if it still points to THIS flight.
                // Another flight may have reused the callsign and rebound the index.
                if (f.Callsign is not null
                    && _callsignIndex.TryGetValue(f.Callsign, out var indexedKey)
                    && indexedKey == key)
                {
                    _callsignIndex.TryRemove(f.Callsign, out _);
                }
            }
        }

        // Purge TMIs not updated in 24 hours
        var tmiCutoff = DateTime.UtcNow.AddHours(-24);
        foreach (var (key, t) in _tmis)
        {
            if (t.LastUpdated < tmiCutoff)
                _tmis.TryRemove(key, out _);
        }
    }

    // ── API helpers ──────────────────────────────────────────────────────────

    public object GetStats() => new
    {
        connected = Connected,
        messageCount = Interlocked.Read(ref MessageCount),
        fltdCount = Interlocked.Read(ref FltdCount),
        fiCount = Interlocked.Read(ref FiCount),
        flightCount = _flights.Count,
        tmiCount = _tmis.Count,
        clientCount = _flightClients.Count + _tmiClients.Count
    };

    public object[] GetFlights(bool reveal = false) => _flights.Values
        .Where(f => f.Latitude != 0 && f.Longitude != 0)
        .OrderBy(f => f.Callsign)
        .Select(f => f.ToJson(reveal))
        .ToArray();

    /// <summary>
    /// Return ALL TFMS flights (including prefiled with no position yet) with the rich
    /// fields most useful for a FIDO-style table.
    /// </summary>
    public object[] GetAllFlights(bool reveal = false) => _flights.Values
        .OrderBy(f => f.Igtd ?? f.Etd ?? DateTime.MaxValue)
        .Select(f => new
        {
            flightRef = f.FlightRef,
            callsign = LaddService.MaskCallsign(f.Callsign, null, reveal),
            airline = f.Airline,
            gufi = f.Gufi,
            depArpt = f.DepArpt,
            arrArpt = f.ArrArpt,
            // Aircraft (full strip-equivalent set)
            acType = f.AircraftType,
            acModel = f.AircraftModel,
            engineClass = f.AircraftEngineClass,
            specialQual = f.SpecialAircraftQualifier,
            equipmentQualifier = f.EquipmentQualifier,
            category = f.AircraftCategory,
            userCategory = f.UserCategory,
            // Identity & ownership
            facility = f.Facility,
            cid = f.IdNumber,
            status = f.FlightStatus,
            sourceFacility = f.SourceFacility,
            // Position & speed
            lat = f.Latitude == 0 ? (double?)null : f.Latitude,
            lon = f.Longitude == 0 ? (double?)null : f.Longitude,
            altitude = f.Altitude,
            reportedAlt = f.ReportedAltitudeRaw,
            speed = f.Speed,
            groundSpeed = f.GroundSpeed,
            // Filed / assigned
            assignedAlt = f.AssignedAltitude,
            requestedAlt = f.RequestedAltitude,
            beaconCode = f.AssignedBeaconCode,
            filedTas = f.FiledTrueAirSpeed,
            filedMach = f.FiledMach,
            // Procedures
            dpName = f.DpName,
            dpType = f.DpType,
            dpTransitionFix = f.DpTransitionFix,
            star = f.Star,
            starTransitionFix = f.StarTransitionFix,
            depFix = f.DepartureFix,
            arrFix = f.ArrivalFix,
            route = f.RouteOfFlight,
            // Coordination
            coordinationFix = f.CoordinationFix,
            coordinationTime = f.CoordinationTime?.ToString("o"),
            boundaryFix = f.BoundaryFix,
            boundaryCrossingTime = f.BoundaryCrossingTime?.ToString("o"),
            // Times
            igtd = f.Igtd?.ToString("o"),
            etd = f.Etd?.ToString("o"),
            eta = f.Eta?.ToString("o"),
            originalDeparture = f.OriginalDeparture?.ToString("o"),
            originalArrival = f.OriginalArrival?.ToString("o"),
            gateDeparture = f.GateDeparture?.ToString("o"),
            gateArrival = f.GateArrival?.ToString("o"),
            runwayDeparture = f.RunwayDeparture?.ToString("o"),
            runwayArrival = f.RunwayArrival?.ToString("o"),
            airlineOutTime = f.AirlineOutTime?.ToString("o"),
            airlineOffTime = f.AirlineOffTime?.ToString("o"),
            airlineOnTime = f.AirlineOnTime?.ToString("o"),
            airlineInTime = f.AirlineInTime?.ToString("o"),
            departureFixTime = f.DepartureFixTime?.ToString("o"),
            arrivalFixTime = f.ArrivalFixTime?.ToString("o"),
            flightCreation = f.FlightCreation?.ToString("o"),
            // Misc
            diversionIndicator = f.DiversionIndicator,
            fdTrigger = f.FdTrigger,
            cdmPart = f.CdmPart,
            ageSec = (int)(DateTime.UtcNow - f.LastSeen).TotalSeconds
        })
        .ToArray();

    public object? GetFlight(string key)
    {
        if (_flights.TryGetValue(key, out var f)) return f.ToDetailJson();
        // Also try callsign match
        var byCs = _flights.Values.FirstOrDefault(f2 =>
            string.Equals(f2.Callsign, key, StringComparison.OrdinalIgnoreCase));
        return byCs?.ToDetailJson();
    }

    /// <summary>Latest APTC airport configuration for every airport reporting one.</summary>
    public object[] GetAirportConfigs() => _aptc.Values
        .OrderBy(c => c.Airport)
        .Select(c => c.ToJson())
        .ToArray();

    public object[] GetTmis() => _tmis.Values
        .OrderByDescending(t => t.Flights.Count)
        .Select(t => t.ToJson())
        .ToArray();

    public object? GetTmi(string fcaId)
    {
        if (_tmis.TryGetValue(fcaId, out var t)) return t.ToDetailJson();
        return null;
    }

    /// <summary>All discovered XML element paths (for investigation).</summary>
    public object GetDiscoveredElements(string? filter = null)
    {
        var paths = _elementPaths.Keys.AsEnumerable();
        if (!string.IsNullOrEmpty(filter))
            paths = paths.Where(p => p.Contains(filter, StringComparison.OrdinalIgnoreCase));
        return new
        {
            totalPaths = _elementPaths.Count,
            sampled = _rawSampleCount,
            elements = paths.OrderBy(p => p).Select(p => new { path = p, sample = _elementPaths[p] }).ToArray()
        };
    }

    /// <summary>Raw XML sample for a message type.</summary>
    public string? GetRawSample(string msgType) =>
        _rawSamples.TryGetValue(msgType, out var xml) ? xml : null;

    /// <summary>List all captured message types with sample availability.</summary>
    public string[] GetMessageTypes() => _rawSamples.Keys.OrderBy(k => k).ToArray();

    /// <summary>Find a TFMS flight by callsign (O(1) via index), for ASDE-X enrichment.</summary>
    public TfmsFlight? FindByCallsign(string callsign)
    {
        if (_callsignIndex.TryGetValue(callsign, out var key) && _flights.TryGetValue(key, out var f))
            return f;
        return null;
    }

    /// <summary>Find TFMS flight by callsign, preferring one whose origin or destination
    /// matches the given airport. Falls back to the index entry if none match.</summary>
    public TfmsFlight? FindByCallsign(string callsign, string airportFaaOrIcao)
    {
        // Common-case fast path: check the indexed entry first to avoid O(n) scan.
        var indexed = FindByCallsign(callsign);
        if (indexed is null) return null;

        string apt = airportFaaOrIcao;
        string aptShort = apt.Length == 4 && (apt[0] == 'K' || apt[0] == 'P') ? apt[1..] : apt;
        bool matches(TfmsFlight f) =>
            (f.DepArpt is not null &&
                (f.DepArpt.Equals(apt, StringComparison.OrdinalIgnoreCase) ||
                 f.DepArpt.Equals(aptShort, StringComparison.OrdinalIgnoreCase))) ||
            (f.ArrArpt is not null &&
                (f.ArrArpt.Equals(apt, StringComparison.OrdinalIgnoreCase) ||
                 f.ArrArpt.Equals(aptShort, StringComparison.OrdinalIgnoreCase)));

        // If the indexed flight matches the airport, return it (O(1) common case)
        if (matches(indexed)) return indexed;

        // Otherwise scan for a sibling with same callsign + matching airport.
        // This is O(n) but only fires when the indexed entry was the wrong leg.
        TfmsFlight? best = null;
        foreach (var f in _flights.Values)
        {
            if (!string.Equals(f.Callsign, callsign, StringComparison.OrdinalIgnoreCase)) continue;
            if (!matches(f)) continue;
            if (best is null || f.LastSeen > best.LastSeen) best = f;
        }
        return best ?? indexed;
    }

    /// <summary>Get all flights transiting a sector (predicted).</summary>
    public object[] GetSectorFlights(string sector)
    {
        var now = DateTime.UtcNow;
        var results = new List<object>();
        foreach (var f in _flights.Values)
        {
            if (f.Sectors is null || f.Etd is null) continue;
            var etd = f.Etd.Value;
            foreach (var s in f.Sectors)
            {
                if (!string.Equals(s.Name, sector, StringComparison.OrdinalIgnoreCase)) continue;
                var entryTime = s.ElapsedEntryTime.HasValue
                    ? etd.AddSeconds(s.ElapsedEntryTime.Value) : (DateTime?)null;
                results.Add(new
                {
                    callsign = f.Callsign,
                    depArpt = f.DepArpt,
                    arrArpt = f.ArrArpt,
                    altitude = f.Altitude,
                    entryTime = entryTime?.ToString("o"),
                    sector = s.Name
                });
                break;
            }
        }
        return results.OrderBy(r => ((dynamic)r).entryTime).ToArray();
    }

    /// <summary>Get all unique sectors seen in traversal data, with flight count per sector.</summary>
    public object[] GetSectorSummary()
    {
        var counts = new Dictionary<string, int>();
        var now = DateTime.UtcNow;
        foreach (var f in _flights.Values)
        {
            if (f.Sectors is null) continue;
            foreach (var s in f.Sectors)
            {
                counts.TryGetValue(s.Name, out var c);
                counts[s.Name] = c + 1;
            }
        }
        return counts.OrderByDescending(kv => kv.Value)
            .Select(kv => new { sector = kv.Key, count = kv.Value })
            .ToArray();
    }
}

// ── Data models ─────────────────────────────────────────────────────────────

class TfmsFlight
{
    public string FlightRef { get; set; } = "";
    public string? Callsign { get; set; }
    public string? Airline { get; set; }
    public string? Gufi { get; set; }
    public string? DepArpt { get; set; }
    public string? ArrArpt { get; set; }
    public string? AircraftType { get; set; }      // ICAO type (B738, A319, C210, etc.)
    public string? AircraftCategory { get; set; }
    public string? UserCategory { get; set; }
    public string? Facility { get; set; }
    public string? IdNumber { get; set; }
    public double Latitude { get; set; }
    public double Longitude { get; set; }
    public int? Speed { get; set; }
    public int? Altitude { get; set; }
    public DateTime? PositionTime { get; set; }
    public DateTime? Etd { get; set; }
    public DateTime? Eta { get; set; }
    /// <summary>Initial Gate Time of Departure — from TFMS qualifiedAircraftId/igtd. Filed/intended departure time.</summary>
    public DateTime? Igtd { get; set; }
    public string? Star { get; set; }
    public string? StarTransitionFix { get; set; }
    public string? RouteOfFlight { get; set; }
    public string? ArrivalFix { get; set; }
    public DateTime? ArrivalFixTime { get; set; }
    public string? DepartureFix { get; set; }
    public DateTime? DepartureFixTime { get; set; }
    public string? DiversionIndicator { get; set; }
    public List<TfmsRouteFix>? Fixes { get; set; }
    public List<TfmsWaypoint>? Waypoints { get; set; }
    public List<string>? Airways { get; set; }
    public List<TfmsSectorEntry>? Centers { get; set; }
    public List<TfmsSectorEntry>? Sectors { get; set; }

    // ── New fields (CDM, status, flight plan, boundary, departure, track) ──
    // CDM / Airline times
    public DateTime? AirlineOutTime { get; set; }
    public DateTime? AirlineOffTime { get; set; }
    public DateTime? AirlineOnTime { get; set; }
    public DateTime? AirlineInTime { get; set; }
    public DateTime? GateDeparture { get; set; }
    public DateTime? GateArrival { get; set; }
    public DateTime? RunwayDeparture { get; set; }
    public DateTime? RunwayArrival { get; set; }
    public DateTime? OriginalDeparture { get; set; }
    public DateTime? OriginalArrival { get; set; }
    public DateTime? FlightCreation { get; set; }

    // Status & aircraft
    public string? FlightStatus { get; set; }
    public string? AircraftModel { get; set; }
    public string? SpecialAircraftQualifier { get; set; }
    public string? AircraftEngineClass { get; set; }
    /// <summary>Equipment qualifier code (L/H/X/etc) — single-letter ICAO equipment suffix.</summary>
    public string? EquipmentQualifier { get; set; }

    // Flight plan extras
    public int? RequestedAltitude { get; set; }
    public string? CoordinationFix { get; set; }
    public DateTime? CoordinationTime { get; set; }
    public int? FiledTrueAirSpeed { get; set; }
    public string? FiledMach { get; set; }
    public string? AssignedBeaconCode { get; set; }

    // Boundary crossing
    public DateTime? BoundaryCrossingTime { get; set; }
    public string? BoundaryFix { get; set; }
    public int? BoundaryRadial { get; set; }
    public int? BoundaryDistance { get; set; }

    // SID / Departure procedure
    public string? DpName { get; set; }
    public string? DpType { get; set; }
    public string? DpTransitionFix { get; set; }
    public int? AssignedAltitude { get; set; }
    public int? GroundSpeed { get; set; }

    // Track extras
    public string? ReportedAltitudeRaw { get; set; }
    public double? NextEventLat { get; set; }
    public double? NextEventLon { get; set; }

    // Message metadata
    public string? FdTrigger { get; set; }
    public string? Sensitivity { get; set; }
    public string? CdmPart { get; set; }
    public string? SourceFacility { get; set; }

    public DateTime LastSeen { get; set; } = DateTime.UtcNow;

    public object ToJson(bool reveal = false) => new
    {
        flightRef = FlightRef,
        callsign = LaddService.MaskCallsign(Callsign, null, reveal),
        depArpt = DepArpt,
        arrArpt = ArrArpt,
        lat = Latitude,
        lon = Longitude,
        speed = Speed,
        altitude = Altitude,
        eta = Eta?.ToString("o"),
        star = Star,
        acType = AircraftType,
        acModel = AircraftModel,
        category = AircraftCategory,
        status = FlightStatus,
        ageSec = (int)(DateTime.UtcNow - LastSeen).TotalSeconds
    };

    public object ToDetailJson() => new
    {
        flightRef = FlightRef,
        callsign = Callsign,
        airline = Airline,
        gufi = Gufi,
        depArpt = DepArpt,
        arrArpt = ArrArpt,
        acType = AircraftType,
        acModel = AircraftModel,
        category = AircraftCategory,
        userCategory = UserCategory,
        facility = Facility,
        idNumber = IdNumber,
        lat = Latitude,
        lon = Longitude,
        speed = Speed,
        altitude = Altitude,
        positionTime = PositionTime?.ToString("o"),
        etd = Etd?.ToString("o"),
        eta = Eta?.ToString("o"),
        star = Star,
        starTransitionFix = StarTransitionFix,
        routeOfFlight = RouteOfFlight,
        arrivalFix = ArrivalFix,
        arrivalFixTime = ArrivalFixTime?.ToString("o"),
        departureFix = DepartureFix,
        departureFixTime = DepartureFixTime?.ToString("o"),
        diversionIndicator = DiversionIndicator,
        airways = Airways,
        fixes = Fixes?.Select(f => new { f.Name, f.SequenceNumber, f.ElapsedTime }),
        waypoints = Waypoints?.Select(w => new { w.Lat, w.Lon, w.ElapsedTime }),
        centers = Centers?.Select(c => new { c.Name, c.ElapsedEntryTime }),
        sectors = Sectors?.Select(s => new { s.Name, s.ElapsedEntryTime }),
        // CDM / airline times
        airlineOutTime = AirlineOutTime?.ToString("o"),
        airlineOffTime = AirlineOffTime?.ToString("o"),
        airlineOnTime = AirlineOnTime?.ToString("o"),
        airlineInTime = AirlineInTime?.ToString("o"),
        gateDeparture = GateDeparture?.ToString("o"),
        gateArrival = GateArrival?.ToString("o"),
        runwayDeparture = RunwayDeparture?.ToString("o"),
        runwayArrival = RunwayArrival?.ToString("o"),
        originalDeparture = OriginalDeparture?.ToString("o"),
        originalArrival = OriginalArrival?.ToString("o"),
        flightCreation = FlightCreation?.ToString("o"),
        // Status & aircraft
        flightStatus = FlightStatus,
        specialAircraftQualifier = SpecialAircraftQualifier,
        aircraftEngineClass = AircraftEngineClass,
        equipmentQualifier = EquipmentQualifier,
        // Flight plan extras
        requestedAltitude = RequestedAltitude,
        coordinationFix = CoordinationFix,
        coordinationTime = CoordinationTime?.ToString("o"),
        filedTrueAirSpeed = FiledTrueAirSpeed,
        filedMach = FiledMach,
        assignedBeaconCode = AssignedBeaconCode,
        // Boundary crossing
        boundaryCrossingTime = BoundaryCrossingTime?.ToString("o"),
        boundaryFix = BoundaryFix,
        boundaryRadial = BoundaryRadial,
        boundaryDistance = BoundaryDistance,
        // SID / DP
        dpName = DpName,
        dpType = DpType,
        dpTransitionFix = DpTransitionFix,
        assignedAltitude = AssignedAltitude,
        groundSpeed = GroundSpeed,
        // Track extras
        reportedAltitudeRaw = ReportedAltitudeRaw,
        nextEventLat = NextEventLat,
        nextEventLon = NextEventLon,
        // Message meta
        fdTrigger = FdTrigger,
        sensitivity = Sensitivity,
        cdmPart = CdmPart,
        sourceFacility = SourceFacility,
        ageSec = (int)(DateTime.UtcNow - LastSeen).TotalSeconds
    };
}

class TfmsRouteFix
{
    public string Name { get; set; } = "";
    public int SequenceNumber { get; set; }
    public int? ElapsedTime { get; set; }
}

class TfmsWaypoint
{
    public double Lat { get; set; }
    public double Lon { get; set; }
    public int? ElapsedTime { get; set; }
}

class TfmsSectorEntry
{
    public string Name { get; set; } = "";
    public int? ElapsedEntryTime { get; set; }
}

class TfmsTmi
{
    public string FcaId { get; set; } = "";
    public string? FcaName { get; set; }
    public ConcurrentDictionary<string, TfmsTmiFlight> Flights { get; set; } = new();
    public DateTime LastUpdated { get; set; } = DateTime.UtcNow;

    public object ToJson() => new
    {
        fcaId = FcaId,
        fcaName = FcaName,
        flightCount = Flights.Count,
        lastUpdated = LastUpdated.ToString("o")
    };

    public object ToDetailJson() => new
    {
        fcaId = FcaId,
        fcaName = FcaName,
        flightCount = Flights.Count,
        lastUpdated = LastUpdated.ToString("o"),
        flights = Flights.Values.Select(f => new
        {
            f.Callsign, f.DepArpt, f.ArrArpt, f.Status, f.FlightRef,
            entryTime = f.EntryTime?.ToString("o"),
            exitTime = f.ExitTime?.ToString("o"),
            entryLat = f.EntryLat, entryLon = f.EntryLon,
            f.UpdateType
        }).OrderBy(f => f.entryTime).ToArray()
    };
}

class TfmsTmiFlight
{
    public string? Callsign { get; set; }
    public string? DepArpt { get; set; }
    public string? ArrArpt { get; set; }
    public string? Status { get; set; }
    public string? FlightRef { get; set; }
    public string? Gufi { get; set; }
    public string? UpdateType { get; set; }
    public DateTime? EntryTime { get; set; }
    public DateTime? ExitTime { get; set; }
    public double? EntryLat { get; set; }
    public double? EntryLon { get; set; }
}

class AirportConfig
{
    public string Airport { get; set; } = "";
    public string? Facility { get; set; }
    public string? EnteringFacility { get; set; }
    public int? ArrRate { get; set; }
    public int? DepRate { get; set; }
    public string? ArrRunwayConf { get; set; }
    public string? DepRunwayConf { get; set; }
    public int? StratAar { get; set; }
    public string? Weather { get; set; }
    public string? ArrUserSpecified { get; set; }
    public string? DepUserSpecified { get; set; }
    public string? AdrEnteredOnPanel { get; set; }
    public string? DynArrEnteredOnPanel { get; set; }
    public string? AirportInFile { get; set; }
    public string? RemarksGroupColor { get; set; }
    public DateTime? EventTime { get; set; }
    public DateTime? EntryTime { get; set; }
    public DateTime? UpdateTime { get; set; }
    public DateTime LastSeen { get; set; } = DateTime.UtcNow;

    public object ToJson() => new
    {
        airport = Airport,
        facility = Facility,
        enteringFacility = EnteringFacility,
        arrRate = ArrRate,
        depRate = DepRate,
        arrRunwayConf = ArrRunwayConf,
        depRunwayConf = DepRunwayConf,
        stratAar = StratAar,
        weather = Weather,
        arrUserSpecified = ArrUserSpecified,
        depUserSpecified = DepUserSpecified,
        adrEnteredOnPanel = AdrEnteredOnPanel,
        dynArrEnteredOnPanel = DynArrEnteredOnPanel,
        airportInFile = AirportInFile,
        remarksGroupColor = RemarksGroupColor,
        eventTime = EventTime?.ToString("o"),
        entryTime = EntryTime?.ToString("o"),
        updateTime = UpdateTime?.ToString("o"),
        ageSec = (int)(DateTime.UtcNow - LastSeen).TotalSeconds
    };
}
