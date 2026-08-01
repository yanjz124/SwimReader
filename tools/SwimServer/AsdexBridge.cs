using System.Collections.Concurrent;
using System.Globalization;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Xml.Linq;
using SolaceSystems.Solclient.Messaging;
using SwimServer;

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
    private string? _webRootPath;

    // airport → trackId → track
    private readonly ConcurrentDictionary<string, ConcurrentDictionary<string, AsdexTrack>> _state = new();
    // airport → clientId → WebSocket client
    private readonly ConcurrentDictionary<string, ConcurrentDictionary<string, WsClient>> _clients = new();
    // airports modified since last FlushDirty() call
    private readonly ConcurrentDictionary<string, byte> _dirty = new();
    // airport → hold bar state {control, status hex, timestamp}
    private readonly ConcurrentDictionary<string, HoldBarState> _holdBars = new();

    // ── Holdbar bit mapping (empirical correlation) ──
    // airport → HoldbarMapper
    private readonly ConcurrentDictionary<string, HoldbarMapper> _holdbarMappers = new();

    /// <summary>Callback for non-SMES messages (topic, xmlBody). Set before Start().</summary>
    public Action<string, string>? OnOtherMessage { get; set; }

    /// <summary>Called for each track during FlushDirty to enrich with SFDPS/TDLS data. Set before Start().</summary>
    public Action<AsdexTrack>? OnEnrich { get; set; }

    // Replay recording — per-airport recorders created on demand
    private readonly ConcurrentDictionary<string, SwimServer.ReplayRecorder> _recorders = new();
    private string? _replayBaseDir;
    private string? _replayCleanupDir;
    private long _replayBudget;

    /// <summary>Enable replay recording. Call before Start().</summary>
    public void SetReplayDir(string baseDir, long budgetBytes = 0, string? cleanupDir = null)
    {
        _replayBaseDir = baseDir;
        _replayCleanupDir = cleanupDir ?? Directory.GetParent(baseDir)?.FullName ?? baseDir;
        _replayBudget = budgetBytes > 0 ? budgetBytes : 5L * 1024 * 1024 * 1024;
    }

    private SwimServer.ReplayRecorder? GetRecorder(string airport)
    {
        if (_replayBaseDir == null) return null;
        return _recorders.GetOrAdd(airport, a =>
            new SwimServer.ReplayRecorder(Path.Combine(_replayBaseDir, a), _replayBudget, _replayCleanupDir));
    }

    public AsdexBridge(string user, string pass, string queue, string host, string vpn,
        JsonSerializerOptions jsonOpts)
    {
        _user = user; _pass = pass; _queue = queue; _host = host; _vpn = vpn;
        _jsonOpts = jsonOpts;
    }

    /// <summary>Set webroot path so holdbar mapper can find GeoJSON files. Call before Start().</summary>
    public void SetWebRoot(string webRootPath) => _webRootPath = webRootPath;

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
                            // FAA TAIS publishes XML declared as encoding="UTF-8" but
                            // stuffs raw single-byte sector codes (0x80-0xFF) into
                            // <scratchPad2> and <runway> on inter-facility handoffs.
                            // UTF-8 decode replaces those bytes with U+FFFD, losing
                            // the receiver-TCP data. Decode as ISO-8859-1 instead —
                            // round-trips every byte 0x00-0xFF to U+0000-U+00FF
                            // losslessly. The XML body is essentially ASCII + a
                            // handful of high bytes, so Latin-1 is safe here even
                            // though the declared encoding lies.
                            var enc = Encoding.GetEncoding(28591); // ISO-8859-1
                            if (m.BinaryAttachment is { Length: > 0 })
                                body = enc.GetString(m.BinaryAttachment);
                            else if (m.XmlContent is { Length: > 0 })
                                body = enc.GetString(m.XmlContent);
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
            if (root is null || root.Name.LocalName != "asdexMsg")
            {
                if (root?.Name.LocalName == "SafetyLogicHoldBar")
                    ProcessHoldBar(root);
                return;
            }

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
                var wake   = info?.Elements().FirstOrDefault(e => e.Name.LocalName == "wake")?.Value;

                var movement = report.Elements().FirstOrDefault(e => e.Name.LocalName == "movement");
                int? speed = ParseInt(movement?.Elements().FirstOrDefault(e => e.Name.LocalName == "speed")?.Value);
                double? hdg = ParseDouble(movement?.Elements().FirstOrDefault(e => e.Name.LocalName == "heading")?.Value);

                var eramGufi = report.Elements().FirstOrDefault(e => e.Name.LocalName == "enhancedData")
                    ?.Elements().FirstOrDefault(e => e.Name.LocalName == "eramGufi")?.Value;

                // Position-based dedup for unidentified tracks or duplicate squawks.
                // When an aircraft lacks a proper GUFI, or multiple reports share the same squawk,
                // position reports can create duplicate tracks. Check for nearby candidates.
                string effectiveTrackId = trackId;
                if (eramGufi is null || squawk is not null)
                {
                    var nearbyTrack = FindNearbyTrack(airportTracks, lat, lon, squawk);
                    if (nearbyTrack is not null)
                    {
                        effectiveTrackId = nearbyTrack.TrackId;
                    }
                }

                var track = airportTracks.GetOrAdd(effectiveTrackId,
                    id => new AsdexTrack { Airport = airport, TrackId = id });

                // If this AT track just gained a callsign, absorb any standalone AD track
                // with the same callsign (AT+AD dedup — reverse direction of the AD→AT merge below)
                if (callsign is not null && track.Callsign is null)
                {
                    var adDupe = airportTracks.Values.FirstOrDefault(t =>
                        t.TrackId != trackId &&
                        string.Equals(t.Callsign, callsign, StringComparison.OrdinalIgnoreCase));
                    if (adDupe is not null)
                    {
                        // Absorb enrichment from the AD track
                        if (adDupe.AircraftType is not null && acType is null) acType = adDupe.AircraftType;
                        if (adDupe.Squawk is not null && squawk is null) squawk = adDupe.Squawk;
                        if (adDupe.EramGufi is not null) track.EramGufi = adDupe.EramGufi;
                        if (adDupe.SfdpsGufi is not null) track.SfdpsGufi = adDupe.SfdpsGufi;
                        if (adDupe.AdDeparture is not null) track.AdDeparture = adDupe.AdDeparture;
                        if (adDupe.AdDestination is not null) track.AdDestination = adDupe.AdDestination;
                        // Remove the now-redundant AD track
                        airportTracks.TryRemove(adDupe.TrackId, out _);
                    }
                }

                track.MergeFrom(lat, lon, callsign, squawk, acType, tgtType, alt, speed, hdg, eramGufi, wake);
                changed = true;
            }

            // adsbReport (AD topic type) — coordinate elements: lat, lon (different names)
            // full=true reports carry enriched identity in enhancedData + descriptor
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

                var enhanced = report.Elements().FirstOrDefault(e => e.Name.LocalName == "enhancedData");
                var eramGufi = enhanced?.Elements().FirstOrDefault(e => e.Name.LocalName == "eramGufi")?.Value;
                var adCallsign = enhanced?.Elements().FirstOrDefault(e => e.Name.LocalName == "callsign")?.Value;
                var adAcType = enhanced?.Elements().FirstOrDefault(e => e.Name.LocalName == "aircraftType")?.Value;
                var sfdpsGufi = enhanced?.Elements().FirstOrDefault(e => e.Name.LocalName == "sfdpsGufi")?.Value;
                var adDep = enhanced?.Elements().FirstOrDefault(e => e.Name.LocalName == "departureAirport")?.Value;
                var adDest = enhanced?.Elements().FirstOrDefault(e => e.Name.LocalName == "destinationAirport")?.Value;

                // squawk from report/mode3ACode/code
                var adSquawk = report.Elements().FirstOrDefault(e => e.Name.LocalName == "report")
                    ?.Elements().FirstOrDefault(e => e.Name.LocalName == "mode3ACode")
                    ?.Elements().FirstOrDefault(e => e.Name.LocalName == "code")?.Value;

                // tgtType from descriptor/tot
                var adTgtType = report.Elements().FirstOrDefault(e => e.Name.LocalName == "descriptor")
                    ?.Elements().FirstOrDefault(e => e.Name.LocalName == "tot")?.Value;

                // AD and AT reports use different track numbers for the same aircraft.
                // If an AT track with the same callsign already exists, merge enrichment
                // data into it instead of creating a duplicate AD-only track.
                AsdexTrack? track = null;
                if (adCallsign is not null)
                {
                    track = airportTracks.Values.FirstOrDefault(t =>
                        t.TrackId != trackId &&
                        string.Equals(t.Callsign, adCallsign, StringComparison.OrdinalIgnoreCase));
                }
                // Fallback: when an aircraft just turned its transponder on, the AD report
                // arrives with a callsign before the AT primary track has been tagged. Match
                // by proximity (same airport, within ~50m) to a nearby untagged AT track.
                if (track is null && adCallsign is not null)
                {
                    track = airportTracks.Values.FirstOrDefault(t =>
                        t.TrackId != trackId &&
                        t.Callsign is null &&
                        IsClose(t.Latitude, t.Longitude, lat, lon));
                    if (track is not null)
                    {
                        // Adopt AD's callsign onto the AT track
                        track.Callsign = adCallsign;
                    }
                }
                if (track is not null)
                {
                    // Merge enrichment fields into the AT track (position comes from AT reports)
                    if (adAcType   is not null) track.AircraftType = adAcType;
                    if (adSquawk   is not null) track.Squawk       = adSquawk;
                    if (eramGufi   is not null) track.EramGufi     = eramGufi;
                    if (sfdpsGufi  is not null) track.SfdpsGufi    = sfdpsGufi;
                    if (adDep      is not null) track.AdDeparture  = adDep;
                    if (adDest     is not null) track.AdDestination = adDest;
                    track.LastSeen = DateTime.UtcNow;
                    // Remove any standalone AD track for this ID (now merged into AT)
                    airportTracks.TryRemove(trackId, out _);
                }
                else
                {
                    // No matching AT track — create/update AD track
                    // Apply position-based dedup for null-callsign or duplicate-squawk AD reports
                    string effectiveAdTrackId = trackId;
                    if (adCallsign is null || adSquawk is not null)
                    {
                        var nearbyTrack = FindNearbyTrack(airportTracks, lat, lon, adSquawk);
                        if (nearbyTrack is not null)
                        {
                            effectiveAdTrackId = nearbyTrack.TrackId;
                        }
                    }

                    track = airportTracks.GetOrAdd(effectiveAdTrackId,
                        id => new AsdexTrack { Airport = airport, TrackId = id });
                    track.MergeFrom(lat, lon, adCallsign, adSquawk, adAcType, adTgtType, null, null, null, eramGufi,
                        sfdpsGufi: sfdpsGufi, adDep: adDep, adDest: adDest);
                }
                changed = true;
            }

            if (changed) _dirty.TryAdd(airport, 0);
        }
        catch (Exception ex) { Console.Error.WriteLine($"[SMES] {ex.GetType().Name}: {ex.Message}"); }
    }

    private void ProcessHoldBar(XElement root)
    {
        var airport = root.Elements().FirstOrDefault(e => e.Name.LocalName == "airport")?.Value;
        if (string.IsNullOrEmpty(airport)) return;

        var control = root.Elements().FirstOrDefault(e => e.Name.LocalName == "control")?.Value;
        var status = root.Elements().FirstOrDefault(e => e.Name.LocalName == "status")?.Value;
        if (status is null) return;

        var state = new HoldBarState
        {
            Airport = airport,
            Control = int.TryParse(control, out var c) ? c : 0,
            Status = status,
            Timestamp = DateTime.UtcNow
        };

        var prev = _holdBars.GetValueOrDefault(airport);
        _holdBars[airport] = state;
        var statusChanged = prev?.Status != status;

        // Empirical holdbar bit correlation:
        // Continuously correlate ALL currently-active bits with runway-occupying aircraft
        // (fast on ground, or airborne). The Correlate() method itself filters out taxiing
        // and parked aircraft, so only real runway traffic contributes to the mapping.
        if (_webRootPath is not null)
        {
            var mapper = _holdbarMappers.GetOrAdd(airport,
                a => HoldbarMapper.Load(a, _webRootPath));
            if (mapper.HasGeo)
            {
                var newBits = ParseBits(status);
                var activeBits = new List<int>();
                for (int i = 0; i < 256 && i < newBits.Length; i++)
                {
                    if (newBits[i]) activeBits.Add(i);
                }
                if (activeBits.Count > 0 && _state.TryGetValue(airport, out var tracks))
                {
                    var trackList = tracks.Values
                        .Where(t => (DateTime.UtcNow - t.LastSeen).TotalSeconds < 10)
                        .ToArray();
                    if (trackList.Length > 0)
                        mapper.Correlate(activeBits, trackList);
                }
            }
        }

        // Only broadcast/log/record when status actually changed
        if (!statusChanged) return;

        // Count active bits
        var activeBitCount = CountBits(status);
        Console.WriteLine($"[HOLDBAR] {airport} ctrl={state.Control} bits={activeBitCount} status={status}");

        // Record holdbar state for replay
        GetRecorder(airport)?.RecordHoldbar(state.ToJson(), DateTime.UtcNow);

        // Broadcast to connected clients for this airport
        if (_clients.TryGetValue(airport, out var airportClients) && !airportClients.IsEmpty)
        {
            var json = JsonSerializer.SerializeToUtf8Bytes(
                new WsMsg("holdbar", state.ToJson()), _jsonOpts);
            foreach (var (_, client) in airportClients)
            {
                if (client.Ws.State != WebSocketState.Open) continue;
                client.Enqueue(json);
            }
        }
    }

    private static bool[] ParseBits(string hex)
    {
        var bits = new bool[hex.Length * 4];
        for (int i = 0; i < hex.Length; i++)
        {
            if (int.TryParse(hex[i].ToString(), NumberStyles.HexNumber, null, out var nibble))
            {
                bits[i * 4]     = (nibble & 8) != 0;
                bits[i * 4 + 1] = (nibble & 4) != 0;
                bits[i * 4 + 2] = (nibble & 2) != 0;
                bits[i * 4 + 3] = (nibble & 1) != 0;
            }
        }
        return bits;
    }

    /// <summary>Get the learned holdbar bit→line mapping for an airport.</summary>
    public Dictionary<int, int>? GetHoldbarMapping(string airport)
    {
        if (_holdbarMappers.TryGetValue(airport, out var mapper))
            return mapper.GetMapping();
        // Try loading from disk even if no holdbar data received yet
        if (_webRootPath is not null)
        {
            var m = HoldbarMapper.Load(airport, _webRootPath);
            if (m.HasMapping) return m.GetMapping();
        }
        return null;
    }

    public void ResetHoldbarMapping(string airport)
    {
        if (_holdbarMappers.TryRemove(airport, out _) && _webRootPath is not null)
        {
            var saveDir = Path.Combine(Path.GetDirectoryName(_webRootPath)!, "holdbar-map");
            var savePath = Path.Combine(saveDir, airport + ".json");
            if (File.Exists(savePath)) File.Delete(savePath);
            Console.WriteLine($"[HOLDBAR-MAP] {airport}: reset — deleted mapping file");
        }
    }

    private static int CountBits(string hex)
    {
        int count = 0;
        foreach (var ch in hex)
        {
            if (int.TryParse(ch.ToString(), NumberStyles.HexNumber, null, out var nibble))
                count += int.PopCount(nibble);
        }
        return count;
    }

    /// <summary>Get hold bar state for an airport (for REST API / snapshot).</summary>
    public HoldBarState? GetHoldBar(string airport) =>
        _holdBars.TryGetValue(airport, out var s) ? s : null;

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

    // Surface-radar proximity check: ~50m horizontal. Used to merge AT/AD tracks
    // for the same aircraft when one has callsign and the other doesn't.
    private static bool IsClose(double aLat, double aLon, double bLat, double bLon)
    {
        if (aLat == 0 && aLon == 0) return false;
        if (bLat == 0 && bLon == 0) return false;
        const double maxLatDeg = 0.00045;  // ~50m latitude
        const double maxLonDeg = 0.00060;  // ~50m longitude at ~40°N (slightly looser is fine)
        return Math.Abs(aLat - bLat) < maxLatDeg && Math.Abs(aLon - bLon) < maxLonDeg;
    }

    // Position-based deduplication: finds an existing track near the given position.
    // For unidentified aircraft (no callsign, null GUFI), searches for nearby tracks
    // regardless of squawk. For identified aircraft with a squawk, searches for nearby
    // tracks with the same squawk to catch duplicate transponder reports.
    // Tight 20m range ensures only truly duplicate reports merge, not adjacent aircraft.
    private static AsdexTrack? FindNearbyTrack(ConcurrentDictionary<string, AsdexTrack> tracks, double lat, double lon, string? squawk)
    {
        const double maxLatDeg = 0.00018;  // ~20m latitude (tight threshold for same aircraft only)
        const double maxLonDeg = 0.00024;  // ~20m longitude

        AsdexTrack? best = null;
        foreach (var t in tracks.Values)
        {
            // Position proximity check first (tight range)
            if (Math.Abs(t.Latitude - lat) >= maxLatDeg || Math.Abs(t.Longitude - lon) >= maxLonDeg)
                continue;

            // Two dedup scenarios:
            // 1. If both tracks have no callsign and null GUFI, they're unidentified — merge
            if (string.IsNullOrEmpty(t.Callsign) && t.EramGufi is null)
            {
                if (best is null || t.LastSeen > best.LastSeen)
                    best = t;
            }
            // 2. If both tracks have the same squawk (duplicate transponder), merge
            else if (squawk is not null && t.Squawk == squawk)
            {
                if (best is null || t.LastSeen > best.LastSeen)
                    best = t;
            }
        }
        return best;
    }

    // ── Timer callbacks ──────────────────────────────────────────────────────

    /// <summary>Called every 1s. Enriches all dirty airports and sends batch updates to connected clients.</summary>
    public void FlushDirty()
    {
        if (_dirty.IsEmpty) return;

        foreach (var airport in _dirty.Keys.ToArray())
        {
            _dirty.TryRemove(airport, out _);
            if (!_state.TryGetValue(airport, out var tracks)) continue;

            // Enrich all dirty airports regardless of viewers
            if (OnEnrich is not null)
                foreach (var t in tracks.Values) OnEnrich(t);

            // Serialize tracks (needed for both replay recording and client broadcast)
            var arr = DeduplicateByCallsign(tracks.Values).Select(t => t.ToJson()).ToArray();

            // Record for replay (always, regardless of connected clients)
            GetRecorder(airport)?.RecordBatch(arr, DateTime.UtcNow);

            // Only broadcast if there are connected clients
            if (!_clients.TryGetValue(airport, out var airportClients) || airportClients.IsEmpty) continue;
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
                GetRecorder(airport)?.RecordRemove(new { airport, trackId }, DateTime.UtcNow);
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

    /// <summary>Write snapshots for all active airports (call from a timer, e.g. every 2 min).</summary>
    public void WriteReplaySnapshots()
    {
        foreach (var (airport, tracks) in _state)
        {
            if (tracks.IsEmpty) continue;
            var arr = DeduplicateByCallsign(tracks.Values).Select(t => t.ToJson()).ToArray();
            GetRecorder(airport)?.RecordSnapshot(arr, DateTime.UtcNow);
        }
    }

    /// <summary>Dispose all per-airport replay recorders.</summary>
    public void DisposeRecorders()
    {
        foreach (var (_, r) in _recorders) r.Dispose();
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
            ? DeduplicateByCallsign(t.Values).Select(x => x.ToJson()).ToArray()
            : Array.Empty<object>();
        var json = JsonSerializer.SerializeToUtf8Bytes(
            new WsMsg("snapshot", new { airport, tracks }), _jsonOpts);
        client.Enqueue(json);

        // Send current hold bar state if available
        if (_holdBars.TryGetValue(airport, out var hb))
        {
            var hbJson = JsonSerializer.SerializeToUtf8Bytes(
                new WsMsg("holdbar", hb.ToJson()), _jsonOpts);
            client.Enqueue(hbJson);
        }

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
        if (!_state.TryGetValue(airport, out var t))
            return new { airport, tracks = Array.Empty<object>() };

        // Run enrichment so REST API returns the same data as WebSocket
        if (OnEnrich is not null)
            foreach (var track in t.Values) OnEnrich(track);

        var tracks = DeduplicateByCallsign(t.Values).Select(x => x.ToJson()).ToArray();
        return new { airport, tracks };
    }

    /// <summary>All ASDE-X surface tracks matching a callsign across every airport (for the track page).</summary>
    public List<object> FindByCallsign(string callsign)
    {
        var result = new List<object>();
        foreach (var (airport, tracks) in _state)
            foreach (var t in tracks.Values)
                if (string.Equals(t.Callsign, callsign, StringComparison.OrdinalIgnoreCase))
                {
                    if (OnEnrich is not null) OnEnrich(t);
                    result.Add(new { airport, track = t.ToJson() });
                }
        return result;
    }

    /// <summary>Typed ASDE-X tracks for a callsign — used by the server-rendered text page.</summary>
    public List<AsdexTrack> TracksByCallsign(string callsign)
    {
        var result = new List<AsdexTrack>();
        foreach (var tracks in _state.Values)
            foreach (var t in tracks.Values)
                if (string.Equals(t.Callsign, callsign, StringComparison.OrdinalIgnoreCase))
                {
                    if (OnEnrich is not null) OnEnrich(t);
                    result.Add(t);
                }
        return result;
    }

    /// <summary>
    /// Deduplicate tracks by callsign — when multiple tracks share the same callsign,
    /// keep only the one with the most recent LastSeen. Tracks without callsigns are always kept.
    /// </summary>
    private static IEnumerable<AsdexTrack> DeduplicateByCallsign(ICollection<AsdexTrack> tracks)
    {
        var seen = new Dictionary<string, AsdexTrack>(StringComparer.OrdinalIgnoreCase);
        var noCallsign = new List<AsdexTrack>();
        foreach (var t in tracks)
        {
            if (string.IsNullOrEmpty(t.Callsign))
            {
                noCallsign.Add(t);
                continue;
            }
            if (!seen.TryGetValue(t.Callsign, out var existing) || t.LastSeen > existing.LastSeen)
                seen[t.Callsign] = t;
        }
        return seen.Values.Concat(noCallsign);
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
    public string? WakeCategory { get; set; }   // RECAT: A-F (from SMES flightInfo/wake)
    public double  Latitude  { get; set; }
    public double  Longitude { get; set; }
    public double? AltitudeFeet   { get; set; }
    public int?    SpeedKts       { get; set; }
    public double? HeadingDegrees { get; set; }   // From SMES, OR derived from position delta
    public string? EramGufi { get; set; }
    public DateTime LastSeen { get; set; } = DateTime.UtcNow;

    // Previous position used to derive heading when SMES doesn't provide it (unknowns/primaries)
    private double? _prevLat, _prevLon;
    private const double MinMovementMeters = 2.0;  // below this, position noise dominates

    // From AD enhanced data (ADS-B reports)
    public string? SfdpsGufi      { get; set; }  // for SFDPS flight lookup
    public string? AdDeparture    { get; set; }  // departureAirport from AD
    public string? AdDestination  { get; set; }  // destinationAirport from AD

    // Enrichment from SFDPS (set by OnEnrich delegate)
    public string? FpOrigin       { get; set; }
    public string? FpDestination  { get; set; }
    public string? FpStar         { get; set; }
    public string? FpRoute        { get; set; }

    // Enrichment from TDLS (set by OnEnrich delegate)
    public string? TdlsGate       { get; set; }
    public string? TdlsRunway     { get; set; }

    // Departure gate code — from fix→code mapping or destination fallback (set by OnEnrich)
    public string? GateCode        { get; set; }

    /// <summary>
    /// Merges incoming data. Position (lat/lon) is always updated.
    /// All other fields only overwrite when the incoming value is non-null.
    /// </summary>
    public void MergeFrom(double lat, double lon,
        string? callsign, string? squawk, string? acType, string? tgtType,
        double? alt, int? speed, double? heading, string? eramGufi, string? wake = null,
        string? sfdpsGufi = null, string? adDep = null, string? adDest = null)
    {
        // Derive heading from position delta when SMES doesn't provide one
        // (typical for unknown/primary targets). Requires a previous position and
        // enough movement to avoid noise.
        if (!heading.HasValue && _prevLat.HasValue && _prevLon.HasValue)
        {
            var movement = DistanceMeters(_prevLat.Value, _prevLon.Value, lat, lon);
            if (movement >= MinMovementMeters)
                HeadingDegrees = BearingDegrees(_prevLat.Value, _prevLon.Value, lat, lon);
        }
        // Update previous position reference only when we actually moved (avoid tiny noise accumulating)
        if (!_prevLat.HasValue || DistanceMeters(_prevLat.Value, _prevLon!.Value, lat, lon) >= MinMovementMeters)
        {
            _prevLat = lat;
            _prevLon = lon;
        }

        Latitude  = lat;
        Longitude = lon;
        if (callsign is not null) Callsign    = callsign;
        if (squawk   is not null) Squawk      = squawk;
        if (acType   is not null) AircraftType = acType;
        // Target type: never downgrade from aircraft/vehicle back to unknown.
        // SMES occasionally reclassifies a fully identified track as unknown for a few
        // cycles; we keep the previously-known type to avoid flickering.
        if (tgtType is not null)
        {
            if (TargetType is null
                || TargetType.Equals("unknown", StringComparison.OrdinalIgnoreCase)
                || !tgtType.Equals("unknown", StringComparison.OrdinalIgnoreCase))
            {
                TargetType = tgtType;
            }
        }
        if (alt.HasValue)     AltitudeFeet   = alt;
        if (speed.HasValue)   SpeedKts        = speed;
        if (heading.HasValue) HeadingDegrees  = heading;
        if (eramGufi   is not null) EramGufi      = eramGufi;
        if (wake       is not null) WakeCategory  = wake;
        if (sfdpsGufi  is not null) SfdpsGufi     = sfdpsGufi;
        if (adDep      is not null) AdDeparture   = adDep;
        if (adDest     is not null) AdDestination = adDest;
        LastSeen = DateTime.UtcNow;
    }

    private static double DistanceMeters(double lat1, double lon1, double lat2, double lon2)
    {
        // Flat-earth approximation, fine at airport scale
        const double metersPerDegLat = 111_111.0;
        var avgLatRad = (lat1 + lat2) * 0.5 * Math.PI / 180.0;
        var dy = (lat2 - lat1) * metersPerDegLat;
        var dx = (lon2 - lon1) * metersPerDegLat * Math.Cos(avgLatRad);
        return Math.Sqrt(dx * dx + dy * dy);
    }

    private static double BearingDegrees(double lat1, double lon1, double lat2, double lon2)
    {
        var lat1R = lat1 * Math.PI / 180.0;
        var lat2R = lat2 * Math.PI / 180.0;
        var dLonR = (lon2 - lon1) * Math.PI / 180.0;
        var y = Math.Sin(dLonR) * Math.Cos(lat2R);
        var x = Math.Cos(lat1R) * Math.Sin(lat2R) - Math.Sin(lat1R) * Math.Cos(lat2R) * Math.Cos(dLonR);
        var brg = Math.Atan2(y, x) * 180.0 / Math.PI;
        return (brg + 360.0) % 360.0;
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
        wake     = WakeCategory,
        ageSec   = (int)(DateTime.UtcNow - LastSeen).TotalSeconds,
        // Enrichment: best available destination/origin (SFDPS > AD > TDLS)
        dest     = FpDestination ?? AdDestination,
        origin   = FpOrigin ?? AdDeparture,
        star     = FpStar,
        route    = FpRoute,
        gate     = TdlsGate,
        runway   = TdlsRunway,
        gateCode = GateCode,
    };
}

// ── Hold bar state ───────────────────────────────────────────────────────────

class HoldBarState
{
    public string Airport { get; set; } = "";
    public int Control { get; set; }
    public string Status { get; set; } = "";  // hex bitmap
    public DateTime Timestamp { get; set; }

    public object ToJson() => new
    {
        airport = Airport,
        control = Control,
        status = Status,
        ageSec = (int)(DateTime.UtcNow - Timestamp).TotalSeconds,
    };
}

// ── Holdbar bit mapper (empirical correlation) ────────────────────────────────

/// <summary>
/// Learns the mapping between SMES holdbar bitmap bit positions and physical
/// hold bar lines (from vNAS GeoJSON). When a bit transitions 0→1, finds
/// the nearest aircraft to each GeoJSON line and records the association.
/// Mappings are persisted to disk and accumulate over time.
/// </summary>
class HoldbarMapper
{
    private readonly string _airport;
    private readonly string _savePath;

    // GeoJSON line geometries: each is a pair of (lat, lon) endpoints
    private readonly List<(double lat1, double lon1, double lat2, double lon2)> _lines = new();
    // Parallel to _lines: which runway each line protects (from GeoJSON runwayId property, may be null)
    private readonly List<string?> _lineRunways = new();
    // Runway polygons: name → list of (lat, lon) vertices
    private readonly List<(string name, List<(double lat, double lon)> poly)> _runwayPolys = new();

    // bit → lineIndex → observation count
    private readonly ConcurrentDictionary<int, ConcurrentDictionary<int, int>> _observations = new();

    // Correlation threshold: aircraft must be within this distance of a hold bar line.
    // Wide enough to catch an aircraft anywhere along the protected runway (hold bars
    // sit at runway thresholds/crossings, but the runway-occupancy aircraft is
    // typically somewhere along the runway, up to ~1.5 km away).
    private const double MaxCorrelationDistanceMeters = 400;
    // Speed filter: hold bars react to runway occupancy — aircraft taking off, landing,
    // on short final. All fast. Slow aircraft (<30 kts) are taxiing or parked and
    // never activate hold bars by themselves.
    private const int MinCorrelationSpeedKts = 30;

    // Save at most once per 30 seconds
    private DateTime _lastSave = DateTime.MinValue;

    public bool HasGeo => _lines.Count > 0;
    public bool HasMapping => !_observations.IsEmpty;

    private HoldbarMapper(string airport, string savePath)
    {
        _airport = airport;
        _savePath = savePath;
    }

    public static HoldbarMapper Load(string airport, string webRootPath)
    {
        var icao = airport.ToUpperInvariant();
        if (!icao.StartsWith("K") && !icao.StartsWith("P")) icao = "K" + icao;

        var saveDir = Path.Combine(Path.GetDirectoryName(webRootPath)!, "holdbar-map");
        var savePath = Path.Combine(saveDir, airport.ToUpperInvariant() + ".json");
        var mapper = new HoldbarMapper(airport, savePath);

        // Load GeoJSON geometry:
        //   LineString with runwayId property = hold bar line (on that runway)
        //   Polygon with id property like "9L - 27R" = runway surface polygon
        var geoPath = Path.Combine(webRootPath, "asdex", "holdbar-geo", icao + ".geojson");
        if (File.Exists(geoPath))
        {
            try
            {
                using var doc = JsonDocument.Parse(File.ReadAllText(geoPath));
                foreach (var feat in doc.RootElement.GetProperty("features").EnumerateArray())
                {
                    var props = feat.TryGetProperty("properties", out var p) ? p : default;
                    var geom = feat.GetProperty("geometry");
                    var type = geom.GetProperty("type").GetString();

                    if (type == "LineString")
                    {
                        var coords = geom.GetProperty("coordinates");
                        if (coords.GetArrayLength() < 2) continue;
                        var c0 = coords[0]; var c1 = coords[coords.GetArrayLength() - 1];
                        mapper._lines.Add((
                            c0[1].GetDouble(), c0[0].GetDouble(),
                            c1[1].GetDouble(), c1[0].GetDouble()));
                        string? rwy = null;
                        if (props.ValueKind == JsonValueKind.Object
                            && props.TryGetProperty("runwayId", out var rwyProp)
                            && rwyProp.ValueKind == JsonValueKind.String)
                            rwy = rwyProp.GetString();
                        mapper._lineRunways.Add(rwy);
                    }
                    else if (type == "Polygon")
                    {
                        // Runway polygon — identified by the "id" property (e.g. "9L - 27R")
                        string? name = null;
                        if (props.ValueKind == JsonValueKind.Object
                            && props.TryGetProperty("id", out var idProp)
                            && idProp.ValueKind == JsonValueKind.String)
                            name = idProp.GetString();
                        if (name is null) continue;

                        var rings = geom.GetProperty("coordinates");
                        if (rings.GetArrayLength() == 0) continue;
                        var outer = rings[0];
                        var poly = new List<(double lat, double lon)>(outer.GetArrayLength());
                        foreach (var pt in outer.EnumerateArray())
                            poly.Add((pt[1].GetDouble(), pt[0].GetDouble()));
                        if (poly.Count >= 3) mapper._runwayPolys.Add((name, poly));
                    }
                }
                Console.WriteLine($"[HOLDBAR-MAP] {airport}: loaded {mapper._lines.Count} lines, {mapper._runwayPolys.Count} runway polygons");
            }
            catch (Exception ex) { Console.Error.WriteLine($"[HOLDBAR-MAP] GeoJSON parse error: {ex.Message}"); }
        }

        // Load existing observations from disk
        if (File.Exists(savePath))
        {
            try
            {
                using var doc = JsonDocument.Parse(File.ReadAllText(savePath));
                foreach (var prop in doc.RootElement.EnumerateObject())
                {
                    if (!int.TryParse(prop.Name, out var bit)) continue;
                    var bitObs = mapper._observations.GetOrAdd(bit, _ => new ConcurrentDictionary<int, int>());
                    foreach (var inner in prop.Value.EnumerateObject())
                    {
                        if (int.TryParse(inner.Name, out var lineIdx))
                            bitObs[lineIdx] = inner.Value.GetInt32();
                    }
                }
                Console.WriteLine($"[HOLDBAR-MAP] {airport}: loaded {mapper._observations.Count} bit mappings from disk");
            }
            catch { /* ignore corrupt file */ }
        }

        return mapper;
    }

    /// <summary>
    /// For each active bit, identify which RUNWAY has an aircraft on it (via polygon
    /// containment), then credit the bit to hold bar lines tagged with that runway's ID.
    /// Hold bars activate because of runway occupancy — fast aircraft on the runway surface
    /// or airborne aircraft on short final.
    /// </summary>
    public void Correlate(List<int> newlyActiveBits, AsdexTrack[] tracks)
    {
        bool changed = false;

        // Runway-occupancy aircraft: fast on the ground, or airborne on approach.
        var runwayTracks = tracks.Where(t =>
            (t.SpeedKts.HasValue && t.SpeedKts.Value >= MinCorrelationSpeedKts)
            || (t.AltitudeFeet.HasValue && t.AltitudeFeet.Value > 50)).ToArray();
        if (runwayTracks.Length == 0) return;

        // Identify which runway(s) currently have an occupying aircraft.
        // For each runway polygon, check if any runway-track is inside it.
        var occupiedRunways = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var (name, poly) in _runwayPolys)
        {
            foreach (var t in runwayTracks)
            {
                if (PointInPolygon(t.Latitude, t.Longitude, poly))
                {
                    occupiedRunways.Add(name);
                    break;
                }
            }
        }

        // If we have runway polygons but nobody's inside any of them, there's nothing
        // to credit. (We could fall back to distance-based, but that's what caused the
        // previous overfitting.)
        if (_runwayPolys.Count > 0 && occupiedRunways.Count == 0) return;

        // Without runway polygons, fall back to distance-based correlation (legacy behavior)
        if (_runwayPolys.Count == 0)
        {
            CorrelateByDistance(newlyActiveBits, runwayTracks, ref changed);
        }
        else
        {
            foreach (var bit in newlyActiveBits)
            {
                // Find candidate lines whose runwayId matches an occupied runway
                var candidates = new List<int>();
                for (int li = 0; li < _lines.Count; li++)
                {
                    var rwy = _lineRunways[li];
                    if (rwy is not null && occupiedRunways.Contains(rwy))
                        candidates.Add(li);
                }

                // Only credit if we have a manageable number of candidates
                if (candidates.Count == 0 || candidates.Count > 40) continue;

                // Credit all candidate lines equally — over many observations, the bits
                // that belong to this runway will get boosted while others stay flat.
                // The statistical signal comes from "this bit is ON whenever this runway
                // has traffic" rather than "this bit is close to this line".
                var bitObs = _observations.GetOrAdd(bit, _ => new ConcurrentDictionary<int, int>());
                foreach (var li in candidates)
                    bitObs.AddOrUpdate(li, 1, (_, v) => v + 1);
                changed = true;
            }
        }

        if (changed && (DateTime.UtcNow - _lastSave).TotalSeconds > 30)
            Save();
    }

    /// <summary>Returns the best mapping: bit → lineIndex (highest observation count wins).</summary>
    public Dictionary<int, int> GetMapping()
    {
        var result = new Dictionary<int, int>();
        foreach (var (bit, obs) in _observations)
        {
            int bestLine = -1, bestCount = 0;
            foreach (var (lineIdx, count) in obs)
            {
                if (count > bestCount) { bestCount = count; bestLine = lineIdx; }
            }
            if (bestLine >= 0) result[bit] = bestLine;
        }
        return result;
    }

    /// <summary>Returns full observation data for debugging/API.</summary>
    public object GetDebugInfo()
    {
        var mapping = GetMapping();
        return new
        {
            airport = _airport,
            lineCount = _lines.Count,
            mappedBits = mapping.Count,
            mappings = mapping.OrderBy(kv => kv.Key)
                .Select(kv => new { bit = kv.Key, lineIdx = kv.Value,
                    observations = _observations.TryGetValue(kv.Key, out var o)
                        ? o.OrderByDescending(x => x.Value).Select(x => new { lineIdx = x.Key, count = x.Value })
                        : Enumerable.Empty<object>() })
        };
    }

    private void Save()
    {
        try
        {
            var dir = Path.GetDirectoryName(_savePath);
            if (dir is not null) Directory.CreateDirectory(dir);

            var data = new Dictionary<string, Dictionary<string, int>>();
            foreach (var (bit, obs) in _observations)
            {
                var inner = new Dictionary<string, int>();
                foreach (var (lineIdx, count) in obs)
                    inner[lineIdx.ToString()] = count;
                data[bit.ToString()] = inner;
            }
            File.WriteAllText(_savePath, JsonSerializer.Serialize(data,
                new JsonSerializerOptions { WriteIndented = true }));
            _lastSave = DateTime.UtcNow;
            Console.WriteLine($"[HOLDBAR-MAP] {_airport}: saved {_observations.Count} bit mappings");
        }
        catch (Exception ex) { Console.Error.WriteLine($"[HOLDBAR-MAP] Save error: {ex.Message}"); }
    }

    // ── Legacy distance-based correlation (fallback when no runway polygons available) ──
    private void CorrelateByDistance(List<int> newlyActiveBits, AsdexTrack[] runwayTracks, ref bool changed)
    {
        var lineMinDist = new double[_lines.Count];
        for (int li = 0; li < _lines.Count; li++)
        {
            var (lat1, lon1, lat2, lon2) = _lines[li];
            double minDist = double.MaxValue;
            foreach (var t in runwayTracks)
            {
                var dist = PointToSegmentDistanceMeters(t.Latitude, t.Longitude, lat1, lon1, lat2, lon2);
                if (dist < minDist) minDist = dist;
            }
            lineMinDist[li] = minDist;
        }

        foreach (var bit in newlyActiveBits)
        {
            int nearLine = -1;
            double nearDist = double.MaxValue;
            int nearCount = 0;
            for (int li = 0; li < _lines.Count; li++)
            {
                if (lineMinDist[li] < MaxCorrelationDistanceMeters)
                {
                    nearCount++;
                    if (lineMinDist[li] < nearDist) { nearDist = lineMinDist[li]; nearLine = li; }
                }
            }
            if (nearLine >= 0 && nearCount <= 3)
            {
                int weight = nearDist < 100 ? 5 : nearDist < 200 ? 3 : 1;
                var bitObs = _observations.GetOrAdd(bit, _ => new ConcurrentDictionary<int, int>());
                bitObs.AddOrUpdate(nearLine, weight, (_, v) => v + weight);
                changed = true;
            }
        }
    }

    // ── Geo math ──

    private static bool PointInPolygon(double lat, double lon, List<(double lat, double lon)> poly)
    {
        // Standard ray-casting algorithm
        bool inside = false;
        int n = poly.Count;
        for (int i = 0, j = n - 1; i < n; j = i++)
        {
            var (yi, xi) = poly[i];
            var (yj, xj) = poly[j];
            if (((yi > lat) != (yj > lat)) &&
                (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi))
                inside = !inside;
        }
        return inside;
    }

    private static double PointToSegmentDistanceMeters(
        double pLat, double pLon, double aLat, double aLon, double bLat, double bLon)
    {
        // Convert to approximate meters (flat earth at this scale is fine)
        var cosLat = Math.Cos(pLat * Math.PI / 180);
        var px = pLon * cosLat * 111320;
        var py = pLat * 111320;
        var ax = aLon * cosLat * 111320;
        var ay = aLat * 111320;
        var bx = bLon * cosLat * 111320;
        var by = bLat * 111320;

        var dx = bx - ax;
        var dy = by - ay;
        var len2 = dx * dx + dy * dy;
        if (len2 < 1e-10) return Math.Sqrt((px - ax) * (px - ax) + (py - ay) * (py - ay));

        var t = Math.Max(0, Math.Min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        var cx = ax + t * dx;
        var cy = ay + t * dy;
        return Math.Sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy));
    }
}
