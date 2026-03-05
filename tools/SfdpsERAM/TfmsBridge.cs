using System.Collections.Concurrent;
using System.Globalization;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Xml.Linq;
using SolaceSystems.Solclient.Messaging;

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
                    SSLValidateCertificate = false
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

                while (true)
                {
                    Thread.Sleep(10000);
                    var silence = (DateTime.UtcNow -
                        new DateTime(Interlocked.Read(ref lastMsgTicks), DateTimeKind.Utc)).TotalSeconds;
                    if (silence > 90)
                    {
                        Console.WriteLine($"[TFMS] No messages for {silence:F0}s — reconnecting");
                        break;
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
        var acid = msg.Attribute("acid")?.Value;
        if (acid is null) return;

        var flightRef = msg.Attribute("flightRef")?.Value;
        var airline = msg.Attribute("airline")?.Value;
        var depArpt = msg.Attribute("depArpt")?.Value;
        var arrArpt = msg.Attribute("arrArpt")?.Value;
        var msgType = msg.Attribute("msgType")?.Value;
        var sourceFacility = msg.Attribute("sourceFacility")?.Value;
        var sourceTs = msg.Attribute("sourceTimeStamp")?.Value;

        // Find qualifiedAircraftId (nested in trackInformation or flightPlanInformation)
        var trackInfo = msg.Elements().FirstOrDefault(e => e.Name.LocalName == "trackInformation");
        var planInfo = msg.Elements().FirstOrDefault(e => e.Name.LocalName == "flightPlanInformation");
        var info = trackInfo ?? planInfo;
        if (info is null) return;

        var qid = info.Elements().FirstOrDefault(e => e.Name.LocalName == "qualifiedAircraftId");
        var gufi = qid?.Elements().FirstOrDefault(e => e.Name.LocalName == "gufi")?.Value;
        var igtd = qid?.Elements().FirstOrDefault(e => e.Name.LocalName == "igtd")?.Value;
        var category = qid?.Attribute("aircraftCategory")?.Value;
        var userCategory = qid?.Attribute("userCategory")?.Value;
        var cid = qid?.Elements().FirstOrDefault(e => e.Name.LocalName == "computerId");
        var facility = cid?.Elements().FirstOrDefault(e => e.Name.LocalName == "facilityIdentifier")?.Value;
        var idNumber = cid?.Elements().FirstOrDefault(e => e.Name.LocalName == "idNumber")?.Value;

        // Use flightRef as key (stable across messages for same flight)
        var key = flightRef ?? acid;
        var flight = _flights.GetOrAdd(key, _ => new TfmsFlight { FlightRef = flightRef ?? "" });

        flight.Callsign = acid;
        flight.Airline = airline;
        flight.LastSeen = DateTime.UtcNow;
        if (depArpt is not null) flight.DepArpt = depArpt;
        if (arrArpt is not null) flight.ArrArpt = arrArpt;
        if (gufi is not null) flight.Gufi = gufi;
        if (category is not null) flight.AircraftCategory = category;
        if (userCategory is not null) flight.UserCategory = userCategory;
        if (facility is not null) flight.Facility = facility;
        if (idNumber is not null) flight.IdNumber = idNumber;

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
        var routeData = info.Elements().FirstOrDefault(e => e.Name.LocalName == "ncsmRouteData");
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

        // Route of flight (text)
        var routeText = routeData.Elements().FirstOrDefault(e => e.Name.LocalName == "routeOfFlight")?.Value;
        if (routeText is not null) flight.RouteOfFlight = routeText;

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

    private void ProcessFiMessage(XElement msg)
    {
        var msgType = msg.Attribute("msgType")?.Value;
        var sourceTs = msg.Attribute("sourceTimeStamp")?.Value;

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
            .Select(f => f.ToJson())
            .ToArray();
        var json = JsonSerializer.SerializeToUtf8Bytes(
            new { type = "snapshot", data = snapshot }, _jsonOpts);
        client.Queue.Writer.TryWrite(json);
        return id;
    }

    public void RemoveFlightClient(string id) => _flightClients.TryRemove(id, out _);

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
                var updates = keys
                    .Where(k => _flights.TryGetValue(k, out _))
                    .Select(k => _flights[k].ToJson())
                    .ToArray();
                if (updates.Length > 0)
                {
                    var json = JsonSerializer.SerializeToUtf8Bytes(
                        new { type = "batch", data = updates }, _jsonOpts);
                    foreach (var c in _flightClients.Values)
                        c.Queue.Writer.TryWrite(json);
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
                _flights.TryRemove(key, out _);
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

    public object[] GetFlights() => _flights.Values
        .Where(f => f.Latitude != 0 && f.Longitude != 0)
        .OrderBy(f => f.Callsign)
        .Select(f => f.ToJson())
        .ToArray();

    public object? GetFlight(string key)
    {
        if (_flights.TryGetValue(key, out var f)) return f.ToDetailJson();
        // Also try callsign match
        var byCs = _flights.Values.FirstOrDefault(f2 =>
            string.Equals(f2.Callsign, key, StringComparison.OrdinalIgnoreCase));
        return byCs?.ToDetailJson();
    }

    public object[] GetTmis() => _tmis.Values
        .OrderByDescending(t => t.Flights.Count)
        .Select(t => t.ToJson())
        .ToArray();

    public object? GetTmi(string fcaId)
    {
        if (_tmis.TryGetValue(fcaId, out var t)) return t.ToDetailJson();
        return null;
    }

    /// <summary>Get flights by airport (departing or arriving), for ASDE-X enrichment.</summary>
    public TfmsFlight? FindByCallsign(string callsign)
    {
        return _flights.Values.FirstOrDefault(f =>
            string.Equals(f.Callsign, callsign, StringComparison.OrdinalIgnoreCase));
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
    public DateTime LastSeen { get; set; } = DateTime.UtcNow;

    public object ToJson() => new
    {
        flightRef = FlightRef,
        callsign = Callsign,
        depArpt = DepArpt,
        arrArpt = ArrArpt,
        lat = Latitude,
        lon = Longitude,
        speed = Speed,
        altitude = Altitude,
        eta = Eta?.ToString("o"),
        star = Star,
        category = AircraftCategory,
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
