using System.Collections.Concurrent;
using System.Globalization;
using System.Net.WebSockets;
using System.Text.Json;
using System.Xml.Linq;

/// <summary>
/// Manages TDES (Tower Departure Event Service) data: CPDLC clearances and departure events.
///
/// Receives forwarded TDES messages from AsdexBridge (shared STDDS Solace session),
/// maintains per-airport, per-aircraft message history, and broadcasts new messages
/// to /tdls/ws/{airport} WebSocket clients.
///
/// Three TDES root element types:
///   TDLSCSPMessage            — CPDLC clearance datalink (PDC/DCL)
///   TowerDepartureEventMessage — gate, taxi, takeoff event times
///   DATISData                  — D-ATIS (ignored, airport-level)
/// </summary>
class TdlsBridge
{
    private readonly JsonSerializerOptions _jsonOpts;

    // airport → aircraftId → aircraft with message history
    private readonly ConcurrentDictionary<string, ConcurrentDictionary<string, TdlsAircraft>> _state = new();
    // airport → clientId → WebSocket client
    private readonly ConcurrentDictionary<string, ConcurrentDictionary<string, WsClient>> _clients = new();
    // airport → list of new messages since last FlushDirty()
    private readonly ConcurrentDictionary<string, ConcurrentBag<TdlsMessage>> _pending = new();

    public TdlsBridge(JsonSerializerOptions jsonOpts) => _jsonOpts = jsonOpts;

    // ── Message processing ─────────────────────────────────────────────────────

    /// <summary>Called by AsdexBridge for non-SMES messages.</summary>
    public void ProcessMessage(string topic, string body)
    {
        if (!topic.StartsWith("TDES/", StringComparison.OrdinalIgnoreCase)) return;

        try
        {
            var doc = XDocument.Parse(body);
            var root = doc.Root;
            if (root is null) return;

            var rootName = root.Name.LocalName;
            switch (rootName)
            {
                case "TDLSCSPMessage":
                    ProcessCpdlc(root);
                    break;
                case "TowerDepartureEventMessage":
                    ProcessDeparture(root);
                    break;
                // DATISData — airport-level, skip
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[TDLS] {ex.GetType().Name}: {ex.Message}");
        }
    }

    private void ProcessCpdlc(XElement root)
    {
        var airport = El(root, "airportID");
        var aircraftId = El(root, "aircraftID");
        if (airport is null || aircraftId is null) return;

        var enhanced = root.Elements().FirstOrDefault(e => e.Name.LocalName == "enhancedData");

        var msg = new TdlsMessage
        {
            Type = "CPDLC",
            Time = ParseTdlsTime(El(root, "time")) ?? DateTime.UtcNow,
            Airport = airport,
            AircraftId = aircraftId,
            BeaconCode = El(root, "beaconCode"),
            AircraftType = El(root, "aircraftType"),
            ComputerId = El(root, "computerID"),
            DataHeader = El(root, "dataHeader"),
            DataBody = El(root, "dataBody"),
            Destination = El(enhanced, "destinationAirport"),
            EramGufi = El(enhanced, "eramGufi"),
            SfdpsGufi = El(enhanced, "sfdpsGufi"),
        };

        AddMessage(airport, aircraftId, msg);
        Console.WriteLine($"[TDLS] CPDLC {airport} {aircraftId} → {msg.Destination}");
    }

    private void ProcessDeparture(XElement root)
    {
        var airport = El(root, "departureAirport");
        var aircraftId = El(root, "aircraftID");
        if (airport is null || aircraftId is null) return;

        var enhanced = root.Elements().FirstOrDefault(e => e.Name.LocalName == "enhancedData");

        // Parse takeoff runway: <takeoffRunway><numericRunwayID>09</numericRunwayID><runwaySubID>R</runwaySubID></takeoffRunway>
        var rwyEl = root.Elements().FirstOrDefault(e => e.Name.LocalName == "takeoffRunway");
        string? runway = null;
        if (rwyEl is not null)
        {
            var num = El(rwyEl, "numericRunwayID");
            var sub = El(rwyEl, "runwaySubID");
            runway = num + sub;
        }

        var msg = new TdlsMessage
        {
            Type = "DEPART",
            Time = ParseIsoTime(El(root, "eventTime")) ?? DateTime.UtcNow,
            Airport = airport,
            AircraftId = aircraftId,
            BeaconCode = El(root, "beaconCode"),
            AircraftType = El(root, "aircraftType"),
            ComputerId = El(root, "computerID"),
            Destination = El(enhanced, "destinationAirport"),
            EramGufi = El(enhanced, "eramGufi"),
            SfdpsGufi = El(enhanced, "sfdpsGufi"),
            Gate = El(root, "parkingGate"),
            TakeoffRunway = runway,
            ClearanceTime = ParseIsoTime(El(root, "clearanceDeliveryTime")),
            TaxiTime = ParseIsoTime(El(root, "taxiStartTime")),
            TakeoffTime = ParseIsoTime(El(root, "takeoffTime")),
        };

        AddMessage(airport, aircraftId, msg);
        Console.WriteLine($"[TDLS] DEPART {airport} {aircraftId} Gate:{msg.Gate} Rwy:{runway}");
    }

    private void AddMessage(string airport, string aircraftId, TdlsMessage msg)
    {
        var airportAircraft = _state.GetOrAdd(airport,
            _ => new ConcurrentDictionary<string, TdlsAircraft>());
        var aircraft = airportAircraft.GetOrAdd(aircraftId,
            id => new TdlsAircraft { Airport = airport, AircraftId = id });

        lock (aircraft.Messages)
        {
            aircraft.Messages.Add(msg);
        }
        aircraft.LastSeen = DateTime.UtcNow;

        // Merge metadata from latest message
        if (msg.AircraftType is not null) aircraft.AircraftType = msg.AircraftType;
        if (msg.Destination is not null) aircraft.Destination = msg.Destination;
        if (msg.BeaconCode is not null) aircraft.BeaconCode = msg.BeaconCode;

        _pending.GetOrAdd(airport, _ => new ConcurrentBag<TdlsMessage>()).Add(msg);
    }

    // ── XML helpers ────────────────────────────────────────────────────────────

    private static string? El(XElement? parent, string localName) =>
        parent?.Elements().FirstOrDefault(e => e.Name.LocalName == localName)?.Value;

    /// <summary>Parse TDLSCSP time format: MMddyyyyHHmmss (e.g., "02202026024831")</summary>
    private static DateTime? ParseTdlsTime(string? s) =>
        s is not null && DateTime.TryParseExact(s, "MMddyyyyHHmmss",
            CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var dt)
            ? dt : null;

    /// <summary>Parse ISO 8601 time (e.g., "2026-02-20T02:48:30.308Z")</summary>
    private static DateTime? ParseIsoTime(string? s) =>
        s is not null && DateTime.TryParse(s, CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var dt)
            ? dt : null;

    // ── Timer callbacks ────────────────────────────────────────────────────────

    /// <summary>Called every 1s. Sends new messages to WebSocket clients.</summary>
    public void FlushDirty()
    {
        if (_pending.IsEmpty || _clients.IsEmpty) return;

        foreach (var airport in _pending.Keys.ToArray())
        {
            if (!_pending.TryRemove(airport, out var bag)) continue;
            if (!_clients.TryGetValue(airport, out var airportClients) || airportClients.IsEmpty) continue;

            var messages = bag.ToArray();
            var json = JsonSerializer.SerializeToUtf8Bytes(
                new WsMsg("new", messages.Select(m => m.ToJson()).ToArray()), _jsonOpts);
            foreach (var (_, client) in airportClients)
            {
                if (client.Ws.State != WebSocketState.Open) continue;
                client.Enqueue(json);
            }
        }
    }

    /// <summary>Called every 60s. Removes aircraft not seen in 2 hours.</summary>
    public void PurgeStale()
    {
        var cutoff = DateTime.UtcNow.AddHours(-2);
        foreach (var (airport, aircraft) in _state)
        {
            var stale = aircraft.Where(kv => kv.Value.LastSeen < cutoff)
                                .Select(kv => kv.Key).ToList();
            foreach (var id in stale)
                aircraft.TryRemove(id, out _);
            if (aircraft.IsEmpty)
                _state.TryRemove(airport, out _);
        }
    }

    // ── WebSocket client management ────────────────────────────────────────────

    public string AddClient(string airport, WsClient client)
    {
        var clientId = Guid.NewGuid().ToString("N");
        _clients.GetOrAdd(airport, _ => new ConcurrentDictionary<string, WsClient>())[clientId] = client;

        // Send full snapshot
        var data = GetAirport(airport);
        var json = JsonSerializer.SerializeToUtf8Bytes(new WsMsg("snapshot", data), _jsonOpts);
        client.Enqueue(json);

        return clientId;
    }

    public void RemoveClient(string airport, string clientId)
    {
        if (!_clients.TryGetValue(airport, out var ac)) return;
        ac.TryRemove(clientId, out _);
        if (ac.IsEmpty) _clients.TryRemove(airport, out _);
    }

    // ── REST helpers ───────────────────────────────────────────────────────────

    /// <summary>Airport directory: [{airport, aircraftCount, messageCount}]</summary>
    public object GetDirectory() =>
        _state
            .Where(kv => !kv.Value.IsEmpty)
            .Select(kv =>
            {
                var aircraft = kv.Value.Values.ToArray();
                return new
                {
                    airport = kv.Key,
                    aircraftCount = aircraft.Length,
                    messageCount = aircraft.Sum(a => { lock (a.Messages) { return a.Messages.Count; } })
                };
            })
            .OrderByDescending(x => x.messageCount)
            .ToArray();

    /// <summary>Full airport data with all aircraft and their messages.</summary>
    public object GetAirport(string airport)
    {
        if (!_state.TryGetValue(airport, out var aircraft))
            return new { airport, aircraft = Array.Empty<object>() };

        var list = aircraft.Values
            .OrderByDescending(a => a.LastSeen)
            .Select(a => a.ToJson())
            .ToArray();

        return new { airport, aircraft = list };
    }

    /// <summary>Single aircraft message history.</summary>
    public object GetAircraftMessages(string airport, string aircraftId)
    {
        if (!_state.TryGetValue(airport, out var aircraft) ||
            !aircraft.TryGetValue(aircraftId, out var ac))
            return new { airport, aircraftId, messages = Array.Empty<object>() };

        return new { airport, aircraftId, messages = ac.MessagesToJson() };
    }
}

// ── Data models ──────────────────────────────────────────────────────────────

class TdlsMessage
{
    public string Type { get; set; } = "";          // "CPDLC" or "DEPART"
    public DateTime Time { get; set; }
    public string Airport { get; set; } = "";
    public string AircraftId { get; set; } = "";
    public string? BeaconCode { get; set; }
    public string? AircraftType { get; set; }
    public string? ComputerId { get; set; }
    public string? Destination { get; set; }
    // CPDLC fields
    public string? DataHeader { get; set; }
    public string? DataBody { get; set; }
    // Departure fields
    public string? Gate { get; set; }
    public string? TakeoffRunway { get; set; }
    public DateTime? ClearanceTime { get; set; }
    public DateTime? TaxiTime { get; set; }
    public DateTime? TakeoffTime { get; set; }
    // Cross-reference
    public string? EramGufi { get; set; }
    public string? SfdpsGufi { get; set; }

    public object ToJson() => new
    {
        type = Type,
        time = Time.ToString("o"),
        airport = Airport,
        aircraftId = AircraftId,
        beaconCode = BeaconCode,
        acType = AircraftType,
        cid = ComputerId,
        destination = Destination,
        dataHeader = DataHeader,
        dataBody = DataBody,
        gate = Gate,
        runway = TakeoffRunway,
        clearanceTime = ClearanceTime?.ToString("o"),
        taxiTime = TaxiTime?.ToString("o"),
        takeoffTime = TakeoffTime?.ToString("o"),
        eramGufi = EramGufi,
    };
}

class TdlsAircraft
{
    public string Airport { get; set; } = "";
    public string AircraftId { get; set; } = "";
    public string? AircraftType { get; set; }
    public string? Destination { get; set; }
    public string? BeaconCode { get; set; }
    public List<TdlsMessage> Messages { get; } = new();
    public DateTime LastSeen { get; set; } = DateTime.UtcNow;

    public object ToJson()
    {
        lock (Messages)
        {
            return new
            {
                aircraftId = AircraftId,
                acType = AircraftType,
                destination = Destination,
                beaconCode = BeaconCode,
                messageCount = Messages.Count,
                lastSeen = LastSeen.ToString("o"),
                messages = Messages.Select(m => m.ToJson()).ToArray()
            };
        }
    }

    public object[] MessagesToJson()
    {
        lock (Messages)
        {
            return Messages.Select(m => m.ToJson()).ToArray();
        }
    }
}
