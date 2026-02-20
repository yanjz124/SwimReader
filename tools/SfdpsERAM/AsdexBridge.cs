using System.Collections.Concurrent;
using System.Globalization;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Xml.Linq;
using SolaceSystems.Solclient.Messaging;

/// <summary>
/// Manages STDDS/SMES (ASDE-X) data ingestion and WebSocket broadcasting.
///
/// Connects to STDDS Solace broker, filters SMES/* topics, parses asdexMsg XML,
/// maintains per-airport track state, and broadcasts to /asdex/ws/{airport} clients.
///
/// Two asdexMsg sub-types are parsed:
///   positionReport — full/partial surface position (AT/SE topics); uses latitude/longitude
///   adsbReport     — ADS-B delta update (AD topics); uses lat/lon
/// SafetyLogicHoldBar root elements are silently ignored.
/// </summary>
class AsdexBridge
{
    private readonly string _user, _pass, _queue, _host, _vpn;
    private readonly JsonSerializerOptions _jsonOpts;

    // airport → trackId → track
    private readonly ConcurrentDictionary<string, ConcurrentDictionary<string, AsdexTrack>> _state = new();
    // airport → clientId → WebSocket client
    private readonly ConcurrentDictionary<string, ConcurrentDictionary<string, WsClient>> _clients = new();
    // airports modified since last FlushDirty() call
    private readonly ConcurrentDictionary<string, byte> _dirty = new();

    /// <summary>Callback for non-SMES messages (topic, xmlBody). Set before Start().</summary>
    public Action<string, string>? OnOtherMessage { get; set; }

    public AsdexBridge(string user, string pass, string queue, string host, string vpn,
        JsonSerializerOptions jsonOpts)
    {
        _user = user; _pass = pass; _queue = queue; _host = host; _vpn = vpn;
        _jsonOpts = jsonOpts;
    }

    public void Start()
    {
        var t = new Thread(Run) { IsBackground = true, Name = "StddsReceiver" };
        t.Start();
    }

    // ── Solace receive loop ──────────────────────────────────────────────────

    private void Run()
    {
        if (string.IsNullOrEmpty(_user))
        {
            Console.WriteLine("[STDDS] No credentials configured — ASDE-X disabled");
            return;
        }

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
                    (_, e) => Console.WriteLine($"[STDDS] {e.Event} - {e.Info}"));

                var rc = session.Connect();
                if (rc != ReturnCode.SOLCLIENT_OK)
                {
                    Console.Error.WriteLine($"[STDDS] Connect returned {rc}, retrying...");
                    Thread.Sleep(10000);
                    continue;
                }

                Console.WriteLine("[STDDS] Connected to STDDS");
                Interlocked.Exchange(ref lastMsgTicks, DateTime.UtcNow.Ticks);

                var solQueue = ContextFactory.Instance.CreateQueue(_queue);
                using var flow = session.CreateFlow(
                    new FlowProperties { AckMode = MessageAckMode.AutoAck }, solQueue, null,
                    (_, msgArgs) =>
                    {
                        using var m = msgArgs.Message;
                        var topic = m.Destination?.Name ?? "";
                        Interlocked.Exchange(ref lastMsgTicks, DateTime.UtcNow.Ticks);
                        if (topic.StartsWith("SMES/", StringComparison.OrdinalIgnoreCase))
                        {
                            ProcessSmes(m);
                        }
                        else if (OnOtherMessage is not null)
                        {
                            string? body = null;
                            if (m.BinaryAttachment is { Length: > 0 })
                                body = Encoding.UTF8.GetString(m.BinaryAttachment);
                            else if (m.XmlContent is { Length: > 0 })
                                body = Encoding.UTF8.GetString(m.XmlContent);
                            if (body is not null) OnOtherMessage(topic, body);
                        }
                    },
                    (_, flowArgs) => Console.WriteLine($"[STDDS Flow] {flowArgs.Event} - {flowArgs.Info}"));

                flow.Start();
                Console.WriteLine("[STDDS] Listening on STDDS queue");

                // Watchdog: reconnect after 90s of silence
                while (true)
                {
                    Thread.Sleep(10000);
                    var silence = (DateTime.UtcNow -
                        new DateTime(Interlocked.Read(ref lastMsgTicks), DateTimeKind.Utc)).TotalSeconds;
                    if (silence > 90)
                    {
                        Console.WriteLine($"[STDDS] No messages for {silence:F0}s — reconnecting");
                        break;
                    }
                }

                try { session.Disconnect(); }
                catch (Exception ex) { Console.WriteLine($"[STDDS] Disconnect: {ex.Message}"); }
            }
            catch (Exception ex) { Console.Error.WriteLine($"[STDDS] Error: {ex.Message}"); }

            Console.WriteLine("[STDDS] Reconnecting in 10 seconds...");
            Thread.Sleep(10000);
        }
    }

    // ── SMES XML parsing ────────────────────────────────────────────────────

    private void ProcessSmes(IMessage message)
    {
        string? body = null;
        if (message.BinaryAttachment is { Length: > 0 })
            body = Encoding.UTF8.GetString(message.BinaryAttachment);
        else if (message.XmlContent is { Length: > 0 })
            body = Encoding.UTF8.GetString(message.XmlContent);
        if (body is null) return;

        try
        {
            var doc = XDocument.Parse(body);
            var root = doc.Root;
            if (root is null || root.Name.LocalName != "asdexMsg") return; // skip SafetyLogicHoldBar

            var airport = root.Elements().FirstOrDefault(e => e.Name.LocalName == "airport")?.Value;
            if (string.IsNullOrEmpty(airport)) return;

            var airportTracks = _state.GetOrAdd(airport,
                _ => new ConcurrentDictionary<string, AsdexTrack>());
            bool changed = false;

            // positionReport (AT/SE topic type) — coordinate elements: latitude, longitude
            foreach (var report in root.Elements().Where(e => e.Name.LocalName == "positionReport"))
            {
                var trackId = report.Elements().FirstOrDefault(e => e.Name.LocalName == "track")?.Value;
                if (trackId is null) continue;

                var pos = report.Elements().FirstOrDefault(e => e.Name.LocalName == "position");
                if (pos is null) continue;

                if (!TryParseCoord(pos, "latitude", "longitude", out var lat, out var lon)) continue;

                var altStr = pos.Elements().FirstOrDefault(e => e.Name.LocalName == "altitude")?.Value;
                double? alt = ParseDouble(altStr);

                var flightId = report.Elements().FirstOrDefault(e => e.Name.LocalName == "flightId");
                var callsign = flightId?.Elements().FirstOrDefault(e => e.Name.LocalName == "aircraftId")?.Value;
                var squawk   = flightId?.Elements().FirstOrDefault(e => e.Name.LocalName == "mode3ACode")?.Value;

                var info   = report.Elements().FirstOrDefault(e => e.Name.LocalName == "flightInfo");
                var acType = info?.Elements().FirstOrDefault(e => e.Name.LocalName == "acType")?.Value;
                var tgtType = info?.Elements().FirstOrDefault(e => e.Name.LocalName == "tgtType")?.Value;

                var movement = report.Elements().FirstOrDefault(e => e.Name.LocalName == "movement");
                int? speed = ParseInt(movement?.Elements().FirstOrDefault(e => e.Name.LocalName == "speed")?.Value);
                double? hdg = ParseDouble(movement?.Elements().FirstOrDefault(e => e.Name.LocalName == "heading")?.Value);

                var eramGufi = report.Elements().FirstOrDefault(e => e.Name.LocalName == "enhancedData")
                    ?.Elements().FirstOrDefault(e => e.Name.LocalName == "eramGufi")?.Value;

                var track = airportTracks.GetOrAdd(trackId,
                    id => new AsdexTrack { Airport = airport, TrackId = id });
                track.MergeFrom(lat, lon, callsign, squawk, acType, tgtType, alt, speed, hdg, eramGufi);
                changed = true;
            }

            // adsbReport (AD topic type) — coordinate elements: lat, lon (different names)
            foreach (var report in root.Elements().Where(e => e.Name.LocalName == "adsbReport"))
            {
                var basicReport = report.Elements().FirstOrDefault(e => e.Name.LocalName == "report")
                    ?.Elements().FirstOrDefault(e => e.Name.LocalName == "basicReport");
                if (basicReport is null) continue;

                var trackId = basicReport.Elements().FirstOrDefault(e => e.Name.LocalName == "track")?.Value;
                if (trackId is null) continue;

                var pos = basicReport.Elements().FirstOrDefault(e => e.Name.LocalName == "position");
                if (pos is null) continue;

                if (!TryParseCoord(pos, "lat", "lon", out var lat, out var lon)) continue;

                var eramGufi = report.Elements().FirstOrDefault(e => e.Name.LocalName == "enhancedData")
                    ?.Elements().FirstOrDefault(e => e.Name.LocalName == "eramGufi")?.Value;

                var track = airportTracks.GetOrAdd(trackId,
                    id => new AsdexTrack { Airport = airport, TrackId = id });
                track.MergeFrom(lat, lon, null, null, null, null, null, null, null, eramGufi);
                changed = true;
            }

            if (changed) _dirty.TryAdd(airport, 0);
        }
        catch (Exception ex) { Console.Error.WriteLine($"[SMES] {ex.GetType().Name}: {ex.Message}"); }
    }

    private static bool TryParseCoord(XElement pos, string latName, string lonName,
        out double lat, out double lon)
    {
        lat = lon = 0;
        return double.TryParse(pos.Elements().FirstOrDefault(e => e.Name.LocalName == latName)?.Value,
                   NumberStyles.Float, CultureInfo.InvariantCulture, out lat)
            && double.TryParse(pos.Elements().FirstOrDefault(e => e.Name.LocalName == lonName)?.Value,
                   NumberStyles.Float, CultureInfo.InvariantCulture, out lon);
    }

    private static int? ParseInt(string? v) => int.TryParse(v, out var i) ? i : null;
    private static double? ParseDouble(string? v) =>
        double.TryParse(v, NumberStyles.Float, CultureInfo.InvariantCulture, out var d) ? d : null;

    // ── Timer callbacks ──────────────────────────────────────────────────────

    /// <summary>Called every 1s. Sends batch updates to clients of dirty airports.</summary>
    public void FlushDirty()
    {
        if (_dirty.IsEmpty || _clients.IsEmpty) return;

        foreach (var airport in _dirty.Keys.ToArray())
        {
            _dirty.TryRemove(airport, out _);
            if (!_clients.TryGetValue(airport, out var airportClients) || airportClients.IsEmpty) continue;
            if (!_state.TryGetValue(airport, out var tracks)) continue;

            var arr = tracks.Values.Select(t => t.ToJson()).ToArray();
            var json = JsonSerializer.SerializeToUtf8Bytes(new WsMsg("batch", arr), _jsonOpts);
            foreach (var (_, client) in airportClients)
            {
                if (client.Ws.State != WebSocketState.Open) continue;
                client.Enqueue(json);
            }
        }
    }

    /// <summary>Called every 10s. Removes tracks not seen in 45s and notifies clients.</summary>
    public void PurgeStaleTracks()
    {
        var cutoff = DateTime.UtcNow.AddSeconds(-45);
        foreach (var (airport, tracks) in _state)
        {
            var stale = tracks.Where(kv => kv.Value.LastSeen < cutoff)
                              .Select(kv => kv.Key).ToList();
            foreach (var trackId in stale)
            {
                tracks.TryRemove(trackId, out _);
                if (_clients.TryGetValue(airport, out var ac))
                {
                    var json = JsonSerializer.SerializeToUtf8Bytes(
                        new WsMsg("remove", new { airport, trackId }), _jsonOpts);
                    foreach (var (_, cl) in ac) cl.Enqueue(json);
                }
            }
            if (tracks.IsEmpty) _state.TryRemove(airport, out _);
        }
    }

    // ── WebSocket client management ──────────────────────────────────────────

    /// <summary>
    /// Registers a new WebSocket client for an airport, sends an immediate snapshot,
    /// and returns the client ID needed for later removal.
    /// </summary>
    public string AddClient(string airport, WsClient client)
    {
        var clientId = Guid.NewGuid().ToString("N");
        _clients.GetOrAdd(airport, _ => new ConcurrentDictionary<string, WsClient>())[clientId] = client;

        // Immediate full snapshot so the client doesn't wait for the next dirty flush
        var tracks = _state.TryGetValue(airport, out var t)
            ? t.Values.Select(x => x.ToJson()).ToArray()
            : Array.Empty<object>();
        var json = JsonSerializer.SerializeToUtf8Bytes(
            new WsMsg("snapshot", new { airport, tracks }), _jsonOpts);
        client.Enqueue(json);

        return clientId;
    }

    public void RemoveClient(string airport, string clientId)
    {
        if (!_clients.TryGetValue(airport, out var ac)) return;
        ac.TryRemove(clientId, out _);
        if (ac.IsEmpty) _clients.TryRemove(airport, out _);
    }

    // ── REST helpers ─────────────────────────────────────────────────────────

    /// <summary>Airport directory: list of {airport, count, lat, lon} sorted by traffic.</summary>
    public object GetDirectory() =>
        _state
            .Where(kv => !kv.Value.IsEmpty)
            .Select(kv =>
            {
                var t = kv.Value.Values.ToArray();
                return new { airport = kv.Key, count = t.Length,
                             lat = t.Average(x => x.Latitude),
                             lon = t.Average(x => x.Longitude) };
            })
            .OrderByDescending(x => x.count)
            .ToArray();

    /// <summary>Full snapshot of all tracks for one airport.</summary>
    public object GetSnapshot(string airport)
    {
        var tracks = _state.TryGetValue(airport, out var t)
            ? t.Values.Select(x => x.ToJson()).ToArray()
            : Array.Empty<object>();
        return new { airport, tracks };
    }
}

// ── Track model ──────────────────────────────────────────────────────────────

class AsdexTrack
{
    public string Airport   { get; set; } = "";
    public string TrackId   { get; set; } = "";
    public string? Callsign  { get; set; }
    public string? Squawk    { get; set; }
    public string? AircraftType { get; set; }
    public string? TargetType   { get; set; }   // "aircraft", "vehicle", "unknown"
    public double  Latitude  { get; set; }
    public double  Longitude { get; set; }
    public double? AltitudeFeet   { get; set; }
    public int?    SpeedKts       { get; set; }
    public double? HeadingDegrees { get; set; }
    public string? EramGufi { get; set; }
    public DateTime LastSeen { get; set; } = DateTime.UtcNow;

    /// <summary>
    /// Merges incoming data. Position (lat/lon) is always updated.
    /// All other fields only overwrite when the incoming value is non-null.
    /// </summary>
    public void MergeFrom(double lat, double lon,
        string? callsign, string? squawk, string? acType, string? tgtType,
        double? alt, int? speed, double? heading, string? eramGufi)
    {
        Latitude  = lat;
        Longitude = lon;
        if (callsign is not null) Callsign    = callsign;
        if (squawk   is not null) Squawk      = squawk;
        if (acType   is not null) AircraftType = acType;
        if (tgtType  is not null) TargetType   = tgtType;
        if (alt.HasValue)     AltitudeFeet   = alt;
        if (speed.HasValue)   SpeedKts        = speed;
        if (heading.HasValue) HeadingDegrees  = heading;
        if (eramGufi is not null) EramGufi    = eramGufi;
        LastSeen = DateTime.UtcNow;
    }

    /// <summary>JSON-serializable representation for WebSocket / REST.</summary>
    public object ToJson() => new
    {
        trackId  = TrackId,
        callsign = Callsign,
        squawk   = Squawk,
        acType   = AircraftType,
        tgtType  = TargetType,
        lat      = Latitude,
        lon      = Longitude,
        altFt    = AltitudeFeet,
        spdKts   = SpeedKts,
        hdg      = HeadingDegrees,
        eramGufi = EramGufi,
        ageSec   = (int)(DateTime.UtcNow - LastSeen).TotalSeconds
    };
}
