using System.Collections.Concurrent;
using System.Globalization;
using System.Net.WebSockets;
using System.Text.Json;
using System.Xml.Linq;

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
    public void ProcessMessage(string topic, string body)
    {
        if (!topic.StartsWith("TAIS/", StringComparison.OrdinalIgnoreCase)) return;

        try
        {
            var doc = XDocument.Parse(body);
            var root = doc.Root;
            if (root is null) return;

            if (root.Name.LocalName != "TATrackAndFlightPlan") return;

            var facility = root.Element("src")?.Value;
            if (facility is null) return;

            var facilityTracks = _state.GetOrAdd(facility,
                _ => new ConcurrentDictionary<string, TaisTrack>());

            foreach (var record in root.Elements("record"))
            {
                var trackEl = record.Element("track");
                if (trackEl is null) continue;

                var trackNum = trackEl.Element("trackNum")?.Value;
                if (trackNum is null) continue;

                // Parse position
                if (!double.TryParse(trackEl.Element("lat")?.Value,
                    NumberStyles.Float, CultureInfo.InvariantCulture, out var lat)) continue;
                if (!double.TryParse(trackEl.Element("lon")?.Value,
                    NumberStyles.Float, CultureInfo.InvariantCulture, out var lon)) continue;

                var track = facilityTracks.GetOrAdd(trackNum,
                    id => new TaisTrack { Facility = facility, TrackNum = id });

                // Always update position
                track.Latitude = lat;
                track.Longitude = lon;
                track.LastSeen = DateTime.UtcNow;

                // Track fields
                track.ReportedSquawk = trackEl.Element("reportedBeaconCode")?.Value ?? track.ReportedSquawk;
                track.AltitudeFeet = ParseInt(trackEl.Element("reportedAltitude")?.Value) ?? track.AltitudeFeet;
                track.VerticalRateFpm = ParseInt(trackEl.Element("vVert")?.Value) ?? track.VerticalRateFpm;
                track.IsFrozen = trackEl.Element("frozen")?.Value == "1";
                track.IsPseudo = trackEl.Element("pseudo")?.Value == "1";

                // Mode S hex code
                var acAddr = trackEl.Element("acAddress")?.Value;
                if (acAddr is not null && acAddr != "000000") track.ModeSCode = acAddr;

                // Compute ground speed/track from vx/vy
                if (int.TryParse(trackEl.Element("vx")?.Value, out var vx) &&
                    int.TryParse(trackEl.Element("vy")?.Value, out var vy))
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
                var fp = record.Element("flightPlan");
                if (fp is not null)
                {
                    track.Callsign = fp.Element("acid")?.Value ?? track.Callsign;
                    track.AircraftType = fp.Element("acType")?.Value ?? track.AircraftType;
                    track.FlightRules = fp.Element("flightRules")?.Value ?? track.FlightRules;
                    track.EntryFix = fp.Element("entryFix")?.Value ?? track.EntryFix;
                    track.ExitFix = fp.Element("exitFix")?.Value ?? track.ExitFix;
                    track.AssignedSquawk = fp.Element("assignedBeaconCode")?.Value ?? track.AssignedSquawk;
                    track.RequestedAltitude = ParseInt(fp.Element("requestedAltitude")?.Value) ?? track.RequestedAltitude;
                    track.Runway = NullIfEmpty(fp.Element("runway")?.Value) ?? track.Runway;
                    track.Scratchpad1 = NullIfEmpty(fp.Element("scratchPad1")?.Value) ?? track.Scratchpad1;
                    track.Scratchpad2 = NullIfEmpty(fp.Element("scratchPad2")?.Value) ?? track.Scratchpad2;
                    track.Owner = NullIfUnassigned(fp.Element("cps")?.Value) ?? track.Owner;
                    track.WakeCategory = NullIfEmpty(fp.Element("category")?.Value) ?? track.WakeCategory;
                    track.EquipmentSuffix = NullIfUnavailable(fp.Element("eqptSuffix")?.Value) ?? track.EquipmentSuffix;
                    track.PendingHandoff = NullIfEmpty(fp.Element("pendingHandoff")?.Value) ?? track.PendingHandoff;
                }

                // Enhanced data (origin/destination airports)
                var enhanced = record.Element("enhancedData");
                if (enhanced is not null)
                {
                    track.Origin = enhanced.Element("departureAirport")?.Value ?? track.Origin;
                    track.Destination = enhanced.Element("destinationAirport")?.Value ?? track.Destination;
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
            .OrderByDescending(x => x.trackCount)
            .ToArray();

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
