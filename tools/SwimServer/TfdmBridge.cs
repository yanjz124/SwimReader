using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text.Json;
using System.Xml.Linq;
using SolaceSystems.Solclient.Messaging;
using SwimServer;

/// <summary>
/// TFDM (Terminal Flight Data Manager) ingestion + WebSocket broadcast.
///
/// Connects a Solace session to the TFDM VPN (ems3) and parses three services:
///   - Flight Data  (NasMessage / TfdmFlightType)         → per-flight SURFACE state
///     (off-block/TOBT, clearance, earliest/estimated runway-departure ≈ TSAT, runway
///      assigned/predicted/actual, ramp spot, taxi-out estimate, departure delay, state)
///   - Airport Information (airportInformationData)        → runway departure-queue lengths,
///     predicted gridlock, per-runway demand forecast
///   - Traffic Management Restrictions (trafficManagementRestrictions) → terminal APREQ/CFR TMIs
///
/// State is grouped by the flight's owning TFDM airport (tfdmIdCreatorAirport) and broadcast to
/// /tfdm/ws/{airport} clients, mirroring AsdexBridge. FlightUpdate messages are partial, so every
/// field merges (non-null overwrite) onto the existing record keyed by tfdmId.
/// </summary>
class TfdmBridge
{
    private readonly string _user, _pass, _queue, _host, _vpn;
    private readonly JsonSerializerOptions _jsonOpts;

    // airport → tfdmId → flight
    private readonly ConcurrentDictionary<string, ConcurrentDictionary<string, TfdmFlight>> _state = new();
    // airport → info (queues/demand/gridlock)
    private readonly ConcurrentDictionary<string, TfdmAirportInfo> _airportInfo = new();
    // airport → tmi-id → TMI
    private readonly ConcurrentDictionary<string, ConcurrentDictionary<string, TfdmTmi>> _tmis = new();
    // airport → clientId → WebSocket client
    private readonly ConcurrentDictionary<string, ConcurrentDictionary<string, WsClient>> _clients = new();
    // airports modified since last FlushDirty()
    private readonly ConcurrentDictionary<string, byte> _dirty = new();

    private long _msgCount;

    public TfdmBridge(string user, string pass, string queue, string host, string vpn, JsonSerializerOptions jsonOpts)
    {
        _user = user; _pass = pass; _queue = queue; _host = host; _vpn = vpn; _jsonOpts = jsonOpts;
    }

    public void Start()
    {
        var t = new Thread(Run) { IsBackground = true, Name = "TfdmReceiver" };
        t.Start();
    }

    // ── Solace receive loop ──────────────────────────────────────────────────
    private void Run()
    {
        if (string.IsNullOrEmpty(_user))
        {
            Console.WriteLine("[TFDM] No credentials configured — TFDM disabled");
            return;
        }
        while (true)
        {
            try
            {
                using var context = ContextFactory.Instance.CreateContext(new ContextProperties(), null);
                var sessionProps = new SessionProperties
                {
                    Host = _host, VPNName = _vpn, UserName = _user, Password = _pass,
                    ReconnectRetries = 100, ReconnectRetriesWaitInMsecs = 5000,
                    SSLValidateCertificate = false,
                    CompressionLevel = 9   // FAA SCDS requires compressed data products
                };
                using var session = context.CreateSession(sessionProps, null,
                    (_, e) => Console.WriteLine($"[TFDM] {e.Event} - {e.Info}"));

                if (session.Connect() != ReturnCode.SOLCLIENT_OK)
                {
                    Console.Error.WriteLine("[TFDM] connect failed, retrying in 10s");
                    Thread.Sleep(10000);
                    continue;
                }
                Console.WriteLine("[TFDM] Connected to TFDM");

                var solQueue = ContextFactory.Instance.CreateQueue(_queue);
                using var flow = session.CreateFlow(
                    new FlowProperties { AckMode = MessageAckMode.AutoAck }, solQueue, null,
                    (_, msgArgs) =>
                    {
                        using var m = msgArgs.Message;
                        try
                        {
                            string? body = null;
                            if (m.BinaryAttachment is { Length: > 0 } ba)
                                body = System.Text.Encoding.UTF8.GetString(ba);
                            else if (m.XmlContent is { Length: > 0 } xc)
                                body = System.Text.Encoding.UTF8.GetString(xc);
                            if (!string.IsNullOrWhiteSpace(body)) Process(body!);
                        }
                        catch (Exception ex) { Console.Error.WriteLine("[TFDM] parse: " + ex.Message); }
                    },
                    (_, __) => { });
                flow.Start();
                Console.WriteLine($"[TFDM] Listening on queue {_queue}");

                // Block this thread while the flow runs; watchdog reconnect if silent.
                while (true) Thread.Sleep(60000);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("[TFDM] session error: " + ex.Message + " — reconnecting in 10s");
                Thread.Sleep(10000);
            }
        }
    }

    // ── Parsing ──────────────────────────────────────────────────────────────
    private void Process(string xml)
    {
        Interlocked.Increment(ref _msgCount);
        XElement root;
        try { root = XElement.Parse(xml); } catch { return; }
        switch (root.Name.LocalName)
        {
            case "NasMessage": ProcessFlight(root); break;
            case "airportInformationData": ProcessAirportInfo(root); break;
            case "trafficManagementRestrictions": ProcessTmr(root); break;
            // TTP_FlightDelay heartbeats / other → ignored for now
        }
    }

    // helpers: first descendant/attribute by local name (null-safe on the parent so
    // chained lookups like El(El(x,"a"),"b") never throw when "a" is absent)
    private static XElement? El(XElement? p, string ln) =>
        p?.Descendants().FirstOrDefault(e => e.Name.LocalName == ln);
    private static XElement? Child(XElement? p, string ln) =>
        p?.Elements().FirstOrDefault(e => e.Name.LocalName == ln);
    private static string? Val(XElement? e) => string.IsNullOrWhiteSpace(e?.Value) ? null : e!.Value.Trim();
    private static string? Attr(XElement? e, string a) => e?.Attributes().FirstOrDefault(x => x.Name.LocalName == a)?.Value;
    // A <foo><estimated|earliest source=..><time>T</time></...></foo> nested time
    private static string? NestedTime(XElement? parent, string kind)
    {
        if (parent == null) return null;
        var k = El(parent, kind);
        return k == null ? null : Val(El(k, "time"));
    }

    private void ProcessFlight(XElement root)
    {
        var flight = El(root, "flight");
        if (flight is null) return;
        var fid = El(flight, "flightIdentification");
        var tfdmId = Val(El(fid ?? flight, "tfdmId"));
        if (string.IsNullOrEmpty(tfdmId)) return;

        var airport = Attr(El(fid ?? flight, "tfdmIdCreatorAirport"), "locationIndicator");
        var callsign = Attr(fid, "aircraftIdentification");
        var dep = flight.Descendants().FirstOrDefault(e => e.Name.LocalName == "departure");
        var arr = flight.Descendants().FirstOrDefault(e => e.Name.LocalName == "arrival");
        var msgType = Attr(El(root, "metadata"), "messageType");

        // Airport can be absent on rare partials — key still needs a home; skip if unknown & new.
        var apts = _state.GetOrAdd(airport ?? "UNKN", _ => new ConcurrentDictionary<string, TfdmFlight>());
        var f = apts.GetOrAdd(tfdmId!, id => new TfdmFlight { Airport = airport ?? "UNKN", TfdmId = id });

        f.LastSeen = DateTime.UtcNow;
        if (msgType is not null) f.MsgType = msgType;
        Merge(ref f.Callsign, callsign);
        Merge(ref f.ComputerId, Val(El(fid ?? flight, "computerId")));
        Merge(ref f.FlightState, Val(El(flight, "tfdmFlightState")));

        if (dep is not null)
        {
            Merge(ref f.Origin, Attr(dep, "departurePointText"));
            Merge(ref f.OffBlockTime, Val(El(El(dep, "offBlockTime"), "initial")));
            Merge(ref f.ClearanceDeliveryTime, Val(El(dep, "clearanceDeliveryTime")));
            Merge(ref f.EstDepartureTime, NestedTime(El(dep, "runwayDepartureTime"), "estimated"));
            Merge(ref f.EarliestDepartureTime, NestedTime(El(dep, "runwayDepartureTime"), "earliest"));
            Merge(ref f.DepartureFix, Val(El(El(dep, "departureFix"), "designatedPoint")));
            Merge(ref f.RunwayAssigned, Attr(El(dep, "runwayAssigned"), "runwayDesignator"));
            Merge(ref f.RunwayPredicted, Attr(El(dep, "runwayPredicted"), "runwayDesignator"));
            Merge(ref f.RunwayActual, Attr(El(dep, "runwayActual"), "runwayDesignator"));
            Merge(ref f.PredictedSpot, Attr(El(dep, "predictedDepartureSpot"), "spotRegion"));
            Merge(ref f.ActualSpot, Val(El(dep, "actualDepartureSpot")));
            Merge(ref f.MoveAreaEntryTime, Val(El(dep, "movementAreaActualEntryTime")));
            Merge(ref f.TaxiOutEst, Val(El(El(dep, "departureTaxiTime"), "totalEstimatedTaxiOutTime")));
            Merge(ref f.ElapsedTaxi, Val(El(dep, "elapsedDepartureTaxiTime")));
            Merge(ref f.DepSeq, Val(El(dep, "departureSequenceNumber")));
            Merge(ref f.ApreqReleaseTime, Val(El(dep, "approvalRequestReleaseTime")));
            var delay = El(dep, "departureDelay");
            if (delay is not null)
            {
                Merge(ref f.DelayPredicted, Val(El(delay, "predictedDelay")));
                Merge(ref f.DelayCurrent, Val(El(delay, "currentDelay")));
                Merge(ref f.DelayActual, Val(El(delay, "actualDelay")));
            }
        }
        if (arr is not null)
        {
            Merge(ref f.Dest, Attr(arr, "destinationPointText"));
            Merge(ref f.ArrivalEstTime, NestedTime(El(arr, "runwayArrivalTime"), "estimated"));
        }
        _dirty[f.Airport] = 1;
    }

    private static void Merge(ref string? field, string? incoming)
    {
        if (!string.IsNullOrWhiteSpace(incoming)) field = incoming;
    }

    private void ProcessAirportInfo(XElement root)
    {
        var apt = Val(El(root, "aerodrome"));
        if (string.IsNullOrEmpty(apt)) return;
        var info = _airportInfo.GetOrAdd(apt!, a => new TfdmAirportInfo { Airport = a });
        info.LastSeen = DateTime.UtcNow;

        // runway departure queue lengths
        var rq = new Dictionary<string, int>();
        foreach (var e in root.Descendants().Where(e => e.Name.LocalName == "departureRunwayQueueLength"))
        {
            var rwy = Val(El(e, "runwayDesignator"));
            var len = Val(e.Elements().FirstOrDefault(x => x.Name.LocalName == "departureRunwayQueueLength"));
            if (rwy is not null && int.TryParse(len, out var n)) rq[rwy] = n;
        }
        if (rq.Count > 0) info.RunwayQueues = rq;
        var aq = Val(El(root, "departureAirportQueueLength"));
        if (int.TryParse(aq, out var aqn)) info.AirportQueue = aqn;
        info.Gridlock = Val(El(El(root, "airportPredictedGridlock"), "gridlockState")) ?? info.Gridlock;
        info.AmaGridlock = Val(El(El(root, "amaPredictedGridlock"), "gridlockState")) ?? info.AmaGridlock;

        var demand = new List<object>();
        foreach (var d in root.Descendants().Where(e => e.Name.LocalName == "demandInformation").Take(8))
        {
            var ad = El(d, "airportDemandInformation");
            demand.Add(new
            {
                start = Val(El(d, "startTime")),
                end = Val(El(d, "endTime")),
                arr = Val(El(ad, "arrivalDemandCount")),
                dep = Val(El(ad, "departureDemandCount"))
            });
        }
        if (demand.Count > 0) info.Demand = demand;
        _dirty[apt!] = 1;
    }

    private void ProcessTmr(XElement root)
    {
        var apt = Val(El(root, "aerodrome"));
        if (string.IsNullOrEmpty(apt)) return;
        var list = _tmis.GetOrAdd(apt!, _ => new ConcurrentDictionary<string, TfdmTmi>());
        foreach (var t in root.Descendants().Where(e => e.Name.LocalName == "tmi"))
        {
            var id = Val(El(El(t, "tfdmTmiId"), "identification"));
            if (id is null) continue;
            var action = Val(El(t, "tmrAction"));
            var status = Val(El(t, "tmiStatus"));
            if (action == "DELETE" || status == "TERMINATED" || status == "EXPIRED")
            {
                list.TryRemove(id, out _);
                continue;
            }
            list[id] = new TfdmTmi
            {
                Id = id,
                Name = Val(El(t, "tmiName")),
                Type = Val(El(t, "tmiType")),
                Status = status,
                ControlledElement = Val(El(t, "controlledElement")),
                Restriction = Val(El(t, "restriction")),
                ProvidingFacility = Val(El(t, "providingFacility")),
                Reason = Val(El(t, "reason")),
                MinutesInTrail = Val(El(t, "minutesInTrailSpacing")),
                MilesInTrail = Val(El(t, "milesInTrailSpacing")),
                StartTime = Val(El(t, "startTime")),
                Ufn = Val(El(t, "untilFurtherNotice")) == "true",
                LastSeen = DateTime.UtcNow
            };
        }
        _dirty[apt!] = 1;
    }

    // ── Timers ───────────────────────────────────────────────────────────────
    public void FlushDirty()
    {
        if (_dirty.IsEmpty) return;
        foreach (var airport in _dirty.Keys.ToArray())
        {
            _dirty.TryRemove(airport, out _);
            if (!_clients.TryGetValue(airport, out var ac) || ac.IsEmpty) continue;
            var json = JsonSerializer.SerializeToUtf8Bytes(new WsMsg("snapshot", SnapshotObj(airport)), _jsonOpts);
            foreach (var (_, c) in ac)
                if (c.Ws.State == WebSocketState.Open) c.Enqueue(json);
        }
    }

    public void PurgeStale()
    {
        var cutoff = DateTime.UtcNow.AddMinutes(-30);   // surface records: 30 min without an update
        foreach (var (apt, flights) in _state)
            foreach (var (id, f) in flights)
                if (f.LastSeen < cutoff) flights.TryRemove(id, out _);
        var tmiCut = DateTime.UtcNow.AddHours(-6);
        foreach (var (_, list) in _tmis)
            foreach (var (id, t) in list)
                if (!t.Ufn && t.LastSeen < tmiCut) list.TryRemove(id, out _);
    }

    // ── Clients ──────────────────────────────────────────────────────────────
    public string AddClient(string airport, WsClient client)
    {
        var id = Guid.NewGuid().ToString("N");
        _clients.GetOrAdd(airport, _ => new ConcurrentDictionary<string, WsClient>())[id] = client;
        client.Enqueue(JsonSerializer.SerializeToUtf8Bytes(new WsMsg("snapshot", SnapshotObj(airport)), _jsonOpts));
        return id;
    }
    public void RemoveClient(string airport, string clientId)
    {
        if (_clients.TryGetValue(airport, out var ac)) { ac.TryRemove(clientId, out _); if (ac.IsEmpty) _clients.TryRemove(airport, out _); }
    }

    // ── REST ─────────────────────────────────────────────────────────────────
    public object GetDirectory() =>
        _state.Where(kv => !kv.Value.IsEmpty)
            .Select(kv => new { airport = kv.Key, count = kv.Value.Count })
            .OrderByDescending(x => x.count).ToArray();

    public object GetSnapshot(string airport) => SnapshotObj(airport);

    private object SnapshotObj(string airport)
    {
        var flights = _state.TryGetValue(airport, out var fs)
            ? fs.Values.OrderBy(f => f.EstDepartureTime ?? f.OffBlockTime ?? "~").Select(f => f.ToJson()).ToArray()
            : Array.Empty<object>();
        _airportInfo.TryGetValue(airport, out var info);
        var tmis = _tmis.TryGetValue(airport, out var tl)
            ? tl.Values.OrderBy(t => t.Name).Select(t => t.ToJson()).ToArray() : Array.Empty<object>();
        return new { airport, flights, info = info?.ToJson(), tmis };
    }

    /// <summary>TFDM surface record(s) for a callsign across all airports (for Track-a-Flight).</summary>
    public List<object> FindByCallsign(string callsign) =>
        FlightsByCallsign(callsign).Select(f => f.ToJson()).ToList();

    /// <summary>Typed variant for the server-rendered /t text page.</summary>
    public List<TfdmFlight> FlightsByCallsign(string callsign)
    {
        var res = new List<TfdmFlight>();
        foreach (var (_, fs) in _state)
            foreach (var f in fs.Values)
                if (string.Equals(f.Callsign, callsign, StringComparison.OrdinalIgnoreCase))
                    res.Add(f);
        return res;
    }
}

// ── Models ───────────────────────────────────────────────────────────────────
class TfdmFlight
{
    public string Airport = "", TfdmId = "";
    public string? Callsign, ComputerId, Origin, Dest, FlightState, MsgType;
    public string? OffBlockTime, ClearanceDeliveryTime, EstDepartureTime, EarliestDepartureTime, ArrivalEstTime;
    public string? RunwayAssigned, RunwayPredicted, RunwayActual, DepartureFix, PredictedSpot, ActualSpot, MoveAreaEntryTime;
    public string? TaxiOutEst, ElapsedTaxi, DelayPredicted, DelayCurrent, DelayActual, DepSeq, ApreqReleaseTime;
    public DateTime LastSeen;

    public object ToJson() => new
    {
        tfdmId = TfdmId, airport = Airport, callsign = Callsign, cid = ComputerId,
        origin = Origin, dest = Dest, state = FlightState,
        offBlock = OffBlockTime, clearance = ClearanceDeliveryTime,
        estDeparture = EstDepartureTime, earliestDeparture = EarliestDepartureTime, arrivalEst = ArrivalEstTime,
        rwyAssigned = RunwayAssigned, rwyPredicted = RunwayPredicted, rwyActual = RunwayActual,
        depFix = DepartureFix, spot = ActualSpot ?? PredictedSpot, moveAreaEntry = MoveAreaEntryTime,
        taxiOutEst = TaxiOutEst, elapsedTaxi = ElapsedTaxi,
        depSeq = DepSeq, apreqRelease = ApreqReleaseTime,
        delay = DelayActual ?? DelayCurrent ?? DelayPredicted,
        ageSec = (int)(DateTime.UtcNow - LastSeen).TotalSeconds
    };
}

class TfdmAirportInfo
{
    public string Airport = "";
    public Dictionary<string, int>? RunwayQueues;
    public int? AirportQueue;
    public string? Gridlock, AmaGridlock;
    public List<object>? Demand;
    public DateTime LastSeen;
    public object ToJson() => new
    {
        airport = Airport, airportQueue = AirportQueue, runwayQueues = RunwayQueues,
        gridlock = Gridlock, amaGridlock = AmaGridlock, demand = Demand,
        ageSec = (int)(DateTime.UtcNow - LastSeen).TotalSeconds
    };
}

class TfdmTmi
{
    public string Id = "";
    public string? Name, Type, Status, ControlledElement, Restriction, ProvidingFacility, Reason, MinutesInTrail, MilesInTrail, StartTime;
    public bool Ufn;
    public DateTime LastSeen;
    public object ToJson() => new
    {
        id = Id, name = Name, type = Type, status = Status, controlledElement = ControlledElement,
        restriction = Restriction, providingFacility = ProvidingFacility, reason = Reason,
        minutesInTrail = MinutesInTrail, milesInTrail = MilesInTrail, startTime = StartTime, ufn = Ufn
    };
}
