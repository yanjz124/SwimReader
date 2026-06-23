using System.Collections.Concurrent;
using System.Globalization;
using System.Net.WebSockets;
using System.Text.Json;
using System.Xml.Linq;
using SwimServer;

/// <summary>
/// Manages TAIS (Terminal Automation Information Service) data: STARS terminal
/// radar tracks with flight plan data from TRACONs.
///
/// Receives forwarded TAIS messages from AsdexBridge (shared STDDS Solace session),
/// maintains per-facility, per-track state, and broadcasts updates to /tais/ws/{facility}
/// WebSocket clients.
///
/// XML root element: TATrackAndFlightPlan
/// Each message contains a &lt;src&gt; facility code and multiple &lt;record&gt; elements,
/// each with &lt;track&gt; (position) + optional &lt;flightPlan&gt; + &lt;enhancedData&gt;.
/// </summary>
class TaisBridge
{
    private readonly JsonSerializerOptions _jsonOpts;

    // facility → trackNum → track state
    private readonly ConcurrentDictionary<string, ConcurrentDictionary<string, TaisTrack>> _state = new();
    // facility → clientId → WebSocket client
    private readonly ConcurrentDictionary<string, ConcurrentDictionary<string, WsClient>> _clients = new();
    // facilities modified since last FlushDirty()
    private readonly ConcurrentDictionary<string, byte> _dirty = new();

    public TaisBridge(JsonSerializerOptions jsonOpts) => _jsonOpts = jsonOpts;

    // ── Message processing ─────────────────────────────────────────────────────

    /// <summary>Called by AsdexBridge for non-SMES messages.</summary>
    // Debug: when set, log full XML of any record whose flightPlan.acid matches
    // one of these callsigns. File: /tmp/tais-watch.log (or platform tmp).
    // Toggle via PUT /api/debug/tais-watch with body {"callsigns":["SWA4308",...]}.
    public static readonly System.Collections.Concurrent.ConcurrentDictionary<string, byte> WatchCallsigns =
        new(StringComparer.OrdinalIgnoreCase);
    static readonly object _watchLock = new();
    static readonly string _watchLogPath = Path.Combine(Path.GetTempPath(), "tais-watch.log");

    public void ProcessMessage(string topic, string body)
    {
        if (!topic.StartsWith("TAIS/", StringComparison.OrdinalIgnoreCase)) return;

        try
        {
            var doc = XDocument.Parse(body);
            var root = doc.Root;
            if (root is null) return;

            if (root.Name.LocalName != "TATrackAndFlightPlan") return;

            var facility = ElVal(root, "src");
            if (facility is null) return;

            // Debug-watch: log full record XML for matched callsigns.
            if (!WatchCallsigns.IsEmpty)
            {
                foreach (var record in Els(root, "record"))
                {
                    var fp = El(record, "flightPlan");
                    var acid = fp is null ? null : ElVal(fp, "acid");
                    if (acid is not null && WatchCallsigns.ContainsKey(acid))
                    {
                        lock (_watchLock)
                        {
                            try
                            {
                                File.AppendAllText(_watchLogPath,
                                    $"\n=== {DateTime.UtcNow:HH:mm:ss.fff} {facility} {acid} ===\n" + record.ToString() + "\n");
                            }
                            catch { /* best effort */ }
                        }
                    }
                }
            }

            var facilityTracks = _state.GetOrAdd(facility,
                _ => new ConcurrentDictionary<string, TaisTrack>());

            foreach (var record in Els(root, "record"))
            {
                var trackEl = El(record, "track");
                if (trackEl is null) continue;

                var trackNum = ElVal(trackEl, "trackNum");
                if (trackNum is null) continue;

                // Parse position
                if (!double.TryParse(ElVal(trackEl, "lat"),
                    NumberStyles.Float, CultureInfo.InvariantCulture, out var lat)) continue;
                if (!double.TryParse(ElVal(trackEl, "lon"),
                    NumberStyles.Float, CultureInfo.InvariantCulture, out var lon)) continue;

                var track = facilityTracks.GetOrAdd(trackNum,
                    id => new TaisTrack { Facility = facility, TrackNum = id });

                // Always update position
                track.Latitude = lat;
                track.Longitude = lon;
                track.LastSeen = DateTime.UtcNow;

                // Track fields
                track.ReportedSquawk = ElVal(trackEl, "reportedBeaconCode") ?? track.ReportedSquawk;
                track.AltitudeFeet = ParseInt(ElVal(trackEl, "reportedAltitude")) ?? track.AltitudeFeet;
                track.VerticalRateFpm = ParseInt(ElVal(trackEl, "vVert")) ?? track.VerticalRateFpm;
                track.IsFrozen = ElVal(trackEl, "frozen") == "1";
                track.IsPseudo = ElVal(trackEl, "pseudo") == "1";

                // Mode S hex code
                var acAddr = ElVal(trackEl, "acAddress");
                if (acAddr is not null && acAddr != "000000") track.ModeSCode = acAddr;

                // Compute ground speed/track from vx/vy
                if (int.TryParse(ElVal(trackEl, "vx"), out var vx) &&
                    int.TryParse(ElVal(trackEl, "vy"), out var vy))
                {
                    var speedRaw = Math.Sqrt(vx * vx + vy * vy);
                    track.GroundSpeedKnots = (int)Math.Round(speedRaw);
                    if (speedRaw > 0)
                    {
                        var heading = Math.Atan2(vx, vy) * 180.0 / Math.PI;
                        if (heading < 0) heading += 360;
                        track.GroundTrackDegrees = (int)Math.Round(heading);
                    }
                }

                // Flight plan fields (only present in some records)
                var fp = El(record, "flightPlan");
                if (fp is not null)
                {
                    track.Callsign = ElVal(fp, "acid") ?? track.Callsign;
                    track.AircraftType = ElVal(fp, "acType") ?? track.AircraftType;
                    track.FlightRules = ElVal(fp, "flightRules") ?? track.FlightRules;
                    track.EntryFix = ElVal(fp, "entryFix") ?? track.EntryFix;
                    track.ExitFix = ElVal(fp, "exitFix") ?? track.ExitFix;
                    track.AssignedSquawk = ElVal(fp, "assignedBeaconCode") ?? track.AssignedSquawk;
                    track.RequestedAltitude = ParseInt(ElVal(fp, "requestedAltitude")) ?? track.RequestedAltitude;
                    track.Runway = NullIfEmpty(ElVal(fp, "runway")) ?? track.Runway;
                    track.Scratchpad1 = NullIfEmpty(ElVal(fp, "scratchPad1")) ?? track.Scratchpad1;
                    track.Scratchpad2 = NullIfEmpty(ElVal(fp, "scratchPad2")) ?? track.Scratchpad2;
                    track.Owner = NullIfUnassigned(ElVal(fp, "cps")) ?? track.Owner;
                    track.WakeCategory = NullIfEmpty(ElVal(fp, "category")) ?? track.WakeCategory;
                    track.EquipmentSuffix = NullIfUnavailable(ElVal(fp, "eqptSuffix")) ?? track.EquipmentSuffix;
                    // TAIS publishes the handoff state in <ocr>. The receiver TCP
                    // appears to be ENCODED as raw single bytes (0x80-0xFF) in
                    // <scratchPad2> and <runway> on inter-facility handoffs —
                    // observed in real A90 capture (UAL1392/JBU312): 1-2 high-
                    // byte chars appear in those fields exactly when ocr =
                    // "normal handoff", with 1 byte for 1-char sectors and 2
                    // bytes for 2-char sectors. We capture them as hex so the
                    // client can decode.
                    track.HandoffOcr = NullIfEmpty(ElVal(fp, "ocr"));
                    track.PendingHandoff = NullIfEmpty(ElVal(fp, "pendingHandoff")) ?? track.PendingHandoff;
                    var sp2 = ElVal(fp, "scratchPad2");
                    var rwy = ElVal(fp, "runway");
                    track.ScratchPad2Hex = HexIfNonAscii(sp2);
                    track.RunwayHex      = HexIfNonAscii(rwy);
                }

                // Enhanced data (origin/destination airports)
                var enhanced = El(record, "enhancedData");
                if (enhanced is not null)
                {
                    track.Origin = ElVal(enhanced, "departureAirport") ?? track.Origin;
                    track.Destination = ElVal(enhanced, "destinationAirport") ?? track.Destination;
                }
            }

            _dirty.TryAdd(facility, 0);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[TAIS] {ex.GetType().Name}: {ex.Message}");
        }
    }

    // ── Helpers ─────────────────────────────────────────────────────────────────

    private static int? ParseInt(string? v) => int.TryParse(v, out var i) ? i : null;
    private static string? NullIfEmpty(string? v) => string.IsNullOrWhiteSpace(v) ? null : v;
    private static string? NullIfUnavailable(string? v) => v is null or "unavailable" ? null : v;
    private static string? NullIfUnassigned(string? v) => v is null or "unassigned" ? null : v;
    /// <summary>
    /// Returns a hex string of the bytes in <paramref name="v"/> ONLY if it
    /// contains non-ASCII chars (i.e. raw 0x80-0xFF bytes from ISO-8859-1
    /// decode of FAA TAIS XML). Returns null for empty / pure-ASCII so the
    /// JSON stays clean for the 99% of records that don't carry binary data.
    /// </summary>
    private static string? HexIfNonAscii(string? v)
    {
        if (string.IsNullOrEmpty(v)) return null;
        bool hasHigh = false;
        foreach (var ch in v) { if (ch > 0x7F) { hasHigh = true; break; } }
        if (!hasHigh) return null;
        var sb = new System.Text.StringBuilder(v.Length * 2);
        foreach (var ch in v) sb.AppendFormat("{0:X2}", (int)ch & 0xFF);
        return sb.ToString();
    }

    /// <summary>Namespace-agnostic element lookup by local name.</summary>
    private static XElement? El(XElement parent, string localName) =>
        parent.Elements().FirstOrDefault(e => e.Name.LocalName == localName);

    /// <summary>Namespace-agnostic element value lookup.</summary>
    private static string? ElVal(XElement parent, string localName) =>
        El(parent, localName)?.Value;

    /// <summary>Namespace-agnostic enumeration of child elements by local name.</summary>
    private static IEnumerable<XElement> Els(XElement parent, string localName) =>
        parent.Elements().Where(e => e.Name.LocalName == localName);

    // ── Timer callbacks ────────────────────────────────────────────────────────

    /// <summary>Called every 1s. Sends all tracks for dirty facilities (batch pattern).</summary>
    public void FlushDirty()
    {
        if (_dirty.IsEmpty || _clients.IsEmpty) return;

        foreach (var facility in _dirty.Keys.ToArray())
        {
            _dirty.TryRemove(facility, out _);
            if (!_clients.TryGetValue(facility, out var facClients) || facClients.IsEmpty) continue;
            if (!_state.TryGetValue(facility, out var tracks)) continue;

            var arr = tracks.Values.Select(t => t.ToJson()).ToArray();
            var json = JsonSerializer.SerializeToUtf8Bytes(new WsMsg("batch", arr), _jsonOpts);
            foreach (var (_, client) in facClients)
            {
                if (client.Ws.State != WebSocketState.Open) continue;
                client.Enqueue(json);
            }
        }
    }

    /// <summary>Called every 10s. Removes tracks not seen in 60s.</summary>
    public void PurgeStaleTracks()
    {
        var cutoff = DateTime.UtcNow.AddSeconds(-60);
        foreach (var (facility, tracks) in _state)
        {
            var stale = tracks.Where(kv => kv.Value.LastSeen < cutoff)
                              .Select(kv => kv.Key).ToList();
            foreach (var trackNum in stale)
            {
                tracks.TryRemove(trackNum, out _);
                if (_clients.TryGetValue(facility, out var fc))
                {
                    var json = JsonSerializer.SerializeToUtf8Bytes(
                        new WsMsg("remove", new { facility, trackNum }), _jsonOpts);
                    foreach (var (_, cl) in fc) cl.Enqueue(json);
                }
            }
            if (tracks.IsEmpty) _state.TryRemove(facility, out _);
        }
    }

    // ── WebSocket client management ────────────────────────────────────────────

    public string AddClient(string facility, WsClient client)
    {
        var clientId = Guid.NewGuid().ToString("N");
        _clients.GetOrAdd(facility, _ => new ConcurrentDictionary<string, WsClient>())[clientId] = client;

        var snapshot = GetSnapshot(facility);
        var json = JsonSerializer.SerializeToUtf8Bytes(new WsMsg("snapshot", snapshot), _jsonOpts);
        client.Enqueue(json);

        return clientId;
    }

    public void RemoveClient(string facility, string clientId)
    {
        if (!_clients.TryGetValue(facility, out var fc)) return;
        fc.TryRemove(clientId, out _);
        if (fc.IsEmpty) _clients.TryRemove(facility, out _);
    }

    // ── REST helpers ───────────────────────────────────────────────────────────

    /// <summary>Facility directory: [{facility, trackCount}]</summary>
    public object GetDirectory() =>
        _state
            .Where(kv => !kv.Value.IsEmpty)
            .Select(kv => new { facility = kv.Key, trackCount = kv.Value.Count })
            .OrderBy(x => x.facility)
            .ToArray();

    /// <summary>Active controller positions (TCPs) currently owning tracks, by
    /// facility: [{facility, tcpCount, trackCount, tcps:[{tcp, count}]}]. "Active"
    /// = a position (CPS controller ID) that owns ≥1 track right now. Sorted by
    /// busiest facility, then each facility's TCPs by busiest.</summary>
    public object GetActiveTcps()
    {
        var facs = new List<(int tcpCount, int trackCount, object payload)>();
        foreach (var kv in _state)
        {
            var tcps = kv.Value.Values
                .Where(t => !string.IsNullOrWhiteSpace(t.Owner))
                .GroupBy(t => t.Owner!.Trim())
                .Select(g => new { tcp = g.Key, count = g.Count() })
                .OrderByDescending(x => x.count).ThenBy(x => x.tcp)
                .ToList();
            if (tcps.Count == 0) continue;
            var trackCount = tcps.Sum(x => x.count);
            facs.Add((tcps.Count, trackCount,
                new { facility = kv.Key, tcpCount = tcps.Count, trackCount, tcps }));
        }
        return facs.OrderByDescending(f => f.tcpCount).ThenByDescending(f => f.trackCount)
                   .Select(f => f.payload).ToList();
    }

    /// <summary>Full snapshot for one facility.</summary>
    public object GetSnapshot(string facility)
    {
        if (!_state.TryGetValue(facility, out var tracks))
            return new { facility, tracks = Array.Empty<object>() };

        return new
        {
            facility,
            tracks = tracks.Values
                .OrderBy(t => t.Callsign ?? t.TrackNum)
                .Select(t => t.ToJson())
                .ToArray()
        };
    }
}

// ── Data model ──────────────────────────────────────────────────────────────

class TaisTrack
{
    public string Facility { get; set; } = "";
    public string TrackNum { get; set; } = "";

    // Identity (from flightPlan element)
    public string? Callsign { get; set; }
    public string? AircraftType { get; set; }
    public string? EquipmentSuffix { get; set; }
    public string? WakeCategory { get; set; }
    public string? FlightRules { get; set; }
    public string? Origin { get; set; }
    public string? Destination { get; set; }
    public string? EntryFix { get; set; }
    public string? ExitFix { get; set; }
    public string? AssignedSquawk { get; set; }
    public string? ReportedSquawk { get; set; }
    public int? RequestedAltitude { get; set; }
    public string? Runway { get; set; }
    public string? Scratchpad1 { get; set; }
    public string? Scratchpad2 { get; set; }
    public string? Owner { get; set; }           // CPS controller ID
    public string? PendingHandoff { get; set; }
    public string? HandoffOcr { get; set; }      // raw <ocr> value
    // Hex byte values for scratchPad2 / runway IF they contain non-ASCII bytes
    // (FAA TAIS appears to encode the receiving sector here as raw 0x80-0xFF
    // single bytes on inter-facility handoffs). Null when the field is empty
    // or pure ASCII.
    public string? ScratchPad2Hex { get; set; }
    public string? RunwayHex { get; set; }

    // Track (from track element)
    public double Latitude { get; set; }
    public double Longitude { get; set; }
    public int? AltitudeFeet { get; set; }
    public int? GroundSpeedKnots { get; set; }
    public int? GroundTrackDegrees { get; set; }
    public int? VerticalRateFpm { get; set; }
    public string? ModeSCode { get; set; }       // hex
    public bool IsFrozen { get; set; }
    public bool IsPseudo { get; set; }
    public DateTime LastSeen { get; set; } = DateTime.UtcNow;

    public object ToJson() => new
    {
        facility = Facility,
        trackNum = TrackNum,
        callsign = Callsign,
        acType = AircraftType,
        equip = EquipmentSuffix,
        wake = WakeCategory,
        rules = FlightRules,
        origin = Origin,
        dest = Destination,
        entryFix = EntryFix,
        exitFix = ExitFix,
        assignedSqk = AssignedSquawk,
        reportedSqk = ReportedSquawk,
        reqAlt = RequestedAltitude,
        runway = Runway,
        sp1 = Scratchpad1,
        sp2 = Scratchpad2,
        owner = Owner,
        handoff = PendingHandoff,
        handoffOcr = HandoffOcr,
        scratchPad2Hex = ScratchPad2Hex,
        runwayHex = RunwayHex,
        lat = Latitude,
        lon = Longitude,
        altFt = AltitudeFeet,
        gs = GroundSpeedKnots,
        trk = GroundTrackDegrees,
        vs = VerticalRateFpm,
        modeS = ModeSCode,
        frozen = IsFrozen,
        pseudo = IsPseudo,
        ageSec = (int)(DateTime.UtcNow - LastSeen).TotalSeconds
    };
}
