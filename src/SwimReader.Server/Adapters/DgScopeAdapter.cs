using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using SwimReader.Core.Bus;
using SwimReader.Core.Events;
using SwimReader.Server.Streaming;

namespace SwimReader.Server.Adapters;

/// <summary>
/// Background service that subscribes to the event bus, converts domain events
/// into Dstars-compatible JSON updates, and pushes them to connected DGScope clients.
/// Also periodically purges stale tracks and sends deletion updates.
/// </summary>
public sealed class DgScopeAdapter : BackgroundService
{
    private readonly IEventBus _eventBus;
    private readonly TrackStateManager _trackState;
    private readonly ClientConnectionManager _clients;
    private readonly ILogger<DgScopeAdapter> _logger;

    /// <summary>
    /// Caches last-broadcast FP JSON per GUID to avoid re-sending unchanged flight plans.
    /// TAIS batches arrive every ~5s with ALL tracks, so without dedup we'd flood 7x more FPs.
    /// </summary>
    private readonly ConcurrentDictionary<Guid, string> _lastFpJson = new();

    /// <summary>
    /// Caches the most-recently broadcast Track update JSON per Guid.
    /// Used to emit a snapshot when a new client connects so they see all
    /// known tracks immediately instead of waiting for the next sweep.
    /// </summary>
    private readonly ConcurrentDictionary<Guid, string> _lastTrackJson = new();

    /// <summary>
    /// Caches the most-recently broadcast FlightPlan JSON per Guid.
    /// Separate from _lastFpJson (which stores a dedup CONTENT KEY, not the
    /// actual JSON).
    /// </summary>
    private readonly ConcurrentDictionary<Guid, string> _lastFpJsonOut = new();

    /// <summary>
    /// Per-facility ordered Guid set so snapshots can scope to one facility.
    /// </summary>
    private readonly ConcurrentDictionary<string, ConcurrentDictionary<Guid, byte>> _facilityTracks = new(StringComparer.OrdinalIgnoreCase);
    private readonly ConcurrentDictionary<string, ConcurrentDictionary<Guid, byte>> _facilityFlightPlans = new(StringComparer.OrdinalIgnoreCase);

    // ── Conflict Alert (STCA) — DGScope's engine, run server-side ─────────────────
    // Per-facility live track snapshot fed to the ported DGScope ConflictAlertSystem. The
    // result (the set of conflicting track guids per facility) is broadcast as a UT=4 line
    // that the JS STARS scope consumes; real DGScope clients ignore the unknown update type.
    private readonly ConcurrentDictionary<string, ConcurrentDictionary<Guid, Ca.Aircraft>> _caTracks
        = new(StringComparer.OrdinalIgnoreCase);
    private readonly Ca.ConflictAlertSystem _ca = new();
    private readonly Ca.Radar _caRadar = new();

    // Runway DB → CA final-approach suppression corridors, so CA stops false-triggering on
    // sequenced/parallel approaches. DGScope loads these from the facility profile; we auto-build
    // them per facility from the runways near its live tracks (cached; rebuilt when the box drifts).
    private readonly Ca.RunwayDb _runways = Ca.RunwayDb.Load(
        Path.Combine(AppContext.BaseDirectory, "Ca", "data", "runways.csv"));
    private readonly ConcurrentDictionary<string, (string BoxKey, DateTime Built, List<Ca.CASuppressionVolume> Vols)>
        _caSuppression = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// Recent positions per track (newest-first, capped), injected into the
    /// snapshot so a freshly-connected scope renders a history trail instantly
    /// instead of taking ~HistoryRate*N seconds to build it up. Each entry is an
    /// immutable array swapped atomically, so GetSnapshot reads it lock-free.
    /// Live updates do NOT carry history (only the snapshot does), so per-update
    /// bandwidth is unchanged.
    /// </summary>
    private readonly ConcurrentDictionary<Guid, DstarsGeoPoint[]> _trackHistory = new();
    private readonly ConcurrentDictionary<Guid, DateTime> _trackHistoryTime = new();
    private const int HistoryMax = 10;                                    // matches client HistoryNum ceiling
    private static readonly TimeSpan HistorySpacing = TimeSpan.FromSeconds(4.5);  // PrefSet.HistoryRate default

    /// <summary>
    /// Tracks which FP GUIDs have TAIS data with a callsign (non-LADD).
    /// Enrichment is fully suppressed for these tracks.
    /// </summary>
    private readonly ConcurrentDictionary<Guid, byte> _taisHasCallsign = new();

    /// <summary>
    /// Stores the enriched callsign per FP GUID for LADD tracks.
    /// When TAIS batches repeat every ~5s with no callsign, we re-apply
    /// the enriched callsign instead of letting it oscillate.
    /// </summary>
    private readonly ConcurrentDictionary<Guid, string> _enrichedCallsigns = new();

    /// <summary>
    /// Per-aircraft handoff state machine — REVISED 2026-06-23 after
    /// inspecting an NCT TAIS sample.
    ///
    /// Key insight: TAIS DOES publish the receiver — it lives in &lt;cps&gt;
    /// while &lt;ocr&gt; is a handoff state. The "current owner" mental model
    /// is wrong: cps during a handoff is the PRE-STAGED RECEIVER, not the
    /// owner. SFO departures show cps="C" with ocr="normal handoff" — "C"
    /// isn't a TRACON sector, it's STARS's code for Center (the receiver).
    /// The actual current owner is whatever cps WAS the last time ocr was
    /// "no change".
    ///
    /// We track both values per aircraft:
    ///   ConfirmedOwner = last cps seen while ocr was idle ("no change")
    ///                    OR null if we've only ever seen the aircraft in
    ///                    a handoff state.
    ///   HandoffTo      = current cps while ocr is a handoff state — the
    ///                    receiver. Null when ocr is idle.
    ///
    /// Emitted on the wire:
    ///   Owner          = ConfirmedOwner (so the position symbol stays at
    ///                    the actual controller, not the proposed receiver)
    ///   PendingHandoff = HandoffTo       (so line-2 shows where it's going)
    /// </summary>
    private sealed class HandoffState
    {
        public string? ConfirmedOwner;  // last cps observed with ocr=no_change
        public string? HandoffTo;       // current cps while ocr is in handoff
    }
    private readonly ConcurrentDictionary<Guid, HandoffState> _handoffState = new();

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        PropertyNamingPolicy = null // PascalCase to match DGScope
    };

    public DgScopeAdapter(
        IEventBus eventBus,
        TrackStateManager trackState,
        ClientConnectionManager clients,
        ILogger<DgScopeAdapter> logger)
    {
        _eventBus = eventBus;
        _trackState = trackState;
        _clients = clients;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("DgScope adapter started");

        // Start stale purge timer
        _ = PurgeLoopAsync(stoppingToken);

        // Start the server-side Conflict Alert loop (DGScope's engine over the live feed).
        _ = CaLoopAsync(stoppingToken);

        await foreach (var evt in _eventBus.SubscribeAsync("DgScopeAdapter", stoppingToken))
        {
            try
            {
                var (json, facility, kind, guid) = ConvertToJsonWithFacility(evt);
                if (json is not null)
                {
                    // Cache the last broadcast value per Guid so a freshly-
                    // connected client can be seeded with the current state.
                    if (guid is Guid g && facility is not null)
                    {
                        if (kind == "T")
                        {
                            _lastTrackJson[g] = json;
                            _facilityTracks.GetOrAdd(facility, _ => new())[g] = 0;
                        }
                        else if (kind == "F")
                        {
                            // _lastFpJson already managed inside ConvertFlightPlan
                            _facilityFlightPlans.GetOrAdd(facility, _ => new())[g] = 0;
                        }
                    }
                    // Tracked broadcast: each client records the guid so the
                    // matching UT=2 deletion later is delivered. Untracked
                    // updates (no guid) still go through the plain channel.
                    if (guid is Guid g2 && facility is not null)
                        _clients.BroadcastTracked(json, facility, g2);
                    else
                        _clients.Broadcast(json, facility);
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error converting event to Dstars JSON");
            }
        }
    }

    /// <summary>Export the broadcast caches for persistence. Pairs with
    /// TrackStateManager.ExportTargets — together they let a restarted server
    /// serve the full prior state (callsign, owner, scratchpads, history) on the
    /// connect snapshot instead of bald position-only tracks.</summary>
    public void ExportCaches(PersistedState s)
    {
        foreach (var kv in _lastTrackJson) s.LastTrackJson[kv.Key.ToString()] = kv.Value;
        foreach (var kv in _lastFpJsonOut) s.LastFpJson[kv.Key.ToString()] = kv.Value;
        foreach (var kv in _facilityTracks) s.FacilityTracks[kv.Key] = kv.Value.Keys.Select(g => g.ToString()).ToList();
        foreach (var kv in _facilityFlightPlans) s.FacilityFlightPlans[kv.Key] = kv.Value.Keys.Select(g => g.ToString()).ToList();
        foreach (var kv in _enrichedCallsigns) s.EnrichedCallsigns[kv.Key.ToString()] = kv.Value;
        foreach (var g in _taisHasCallsign.Keys) s.TaisHasCallsign.Add(g.ToString());
        foreach (var kv in _trackHistory) s.TrackHistory[kv.Key.ToString()] = kv.Value.ToList();
        // Handoff state — see PersistedHandoffState comments.
        foreach (var kv in _handoffState)
        {
            s.HandoffStates[kv.Key.ToString()] = new PersistedHandoffState
            {
                ConfirmedOwner = kv.Value.ConfirmedOwner,
                HandoffTo      = kv.Value.HandoffTo,
            };
        }
    }

    /// <summary>Restore caches, keeping only entries whose GUID is a live target
    /// (post-cutoff) so we never resurrect tracks the manager dropped.</summary>
    public void ImportCaches(PersistedState s, HashSet<Guid> live)
    {
        foreach (var kv in s.LastTrackJson) if (Guid.TryParse(kv.Key, out var g) && live.Contains(g)) _lastTrackJson[g] = kv.Value;
        foreach (var kv in s.LastFpJson) if (Guid.TryParse(kv.Key, out var g) && live.Contains(g)) _lastFpJsonOut[g] = kv.Value;
        foreach (var kv in s.EnrichedCallsigns) if (Guid.TryParse(kv.Key, out var g) && live.Contains(g)) _enrichedCallsigns[g] = kv.Value;
        foreach (var k in s.TaisHasCallsign) if (Guid.TryParse(k, out var g) && live.Contains(g)) _taisHasCallsign[g] = 0;
        foreach (var kv in s.TrackHistory)
            if (Guid.TryParse(kv.Key, out var g) && live.Contains(g) && kv.Value.Count > 0)
                _trackHistory[g] = kv.Value.ToArray();
        foreach (var kv in s.FacilityTracks)
        {
            var set = _facilityTracks.GetOrAdd(kv.Key, _ => new());
            foreach (var idStr in kv.Value) if (Guid.TryParse(idStr, out var g) && live.Contains(g)) set[g] = 0;
        }
        foreach (var kv in s.FacilityFlightPlans)
        {
            var set = _facilityFlightPlans.GetOrAdd(kv.Key, _ => new());
            foreach (var idStr in kv.Value) if (Guid.TryParse(idStr, out var g) && live.Contains(g)) set[g] = 0;
        }
        // Handoff state — restore only for live targets so we don't keep
        // state for tracks the manager has already aged out.
        foreach (var kv in s.HandoffStates)
        {
            if (Guid.TryParse(kv.Key, out var g) && live.Contains(g))
            {
                _handoffState[g] = new HandoffState
                {
                    ConfirmedOwner = kv.Value.ConfirmedOwner,
                    HandoffTo      = kv.Value.HandoffTo,
                };
            }
        }
    }

    /// <summary>
    /// Snapshot of all currently-known tracks + flight plans for a facility.
    /// Called by DstarsController on new client connect so they see the
    /// current state immediately. Order: flight plans first (so AssociatedTrackGuid
    /// resolves on the client side before tracks render).
    /// </summary>
    public IEnumerable<(Guid Guid, string Json)> GetSnapshot(string facility)
    {
        if (_facilityFlightPlans.TryGetValue(facility, out var fpGuids))
        {
            foreach (var g in fpGuids.Keys)
                if (_lastFpJsonOut.TryGetValue(g, out var json)) yield return (g, json);
        }
        if (_facilityTracks.TryGetValue(facility, out var tGuids))
        {
            foreach (var g in tGuids.Keys)
            {
                if (!_lastTrackJson.TryGetValue(g, out var json)) continue;
                // Inject the cached history trail (snapshot only) by splicing it
                // into the flat JSON object before the closing brace. Reading the
                // array reference is atomic (it's swapped, never mutated).
                var hist = _trackHistory.GetValueOrDefault(g);
                if (hist is { Length: > 1 })
                    json = json[..^1] + ",\"History\":" + JsonSerializer.Serialize(hist, JsonOptions) + "}";
                yield return (g, json);
            }
        }
    }

    private (string? json, string? facility, string kind, Guid? guid) ConvertToJsonWithFacility(ISwimEvent evt)
    {
        switch (evt)
        {
            case TrackPositionEvent track:
            {
                var guid = _trackState.GetTrackGuid(track.ModeSCode, track.TrackNumber, track.Facility);
                return (ConvertTrack(track), track.Facility, "T", guid);
            }
            case FlightPlanDataEvent fp:
            {
                var guid = _trackState.GetFlightPlanGuid(fp.ModeSCode, fp.TrackNumber, fp.Callsign, fp.Facility);
                return (ConvertFlightPlan(fp), fp.Facility, "F", guid);
            }
            default:
                return (null, null, "", null);
        }
    }

    private string ConvertTrack(TrackPositionEvent track)
    {
        var guid = _trackState.GetTrackGuid(track.ModeSCode, track.TrackNumber, track.Facility);
        var positionOnly = track.IsPseudo;

        var update = new DstarsTrackUpdate
        {
            Guid = guid,
            TimeStamp = track.Timestamp,
            Location = new DstarsGeoPoint
            {
                Latitude = track.Position.Latitude,
                Longitude = track.Position.Longitude
            },
            // Omit altitude, squawk, Mode S for pseudo tracks so DGScope
            // treats them as PrimaryOnly (position symbol only, no datablock).
            // Frozen tracks keep all data — they're real correlated aircraft
            // that temporarily lost radar coverage (coast), not uncorrelated targets.
            Altitude = !positionOnly && track.AltitudeFeet.HasValue ? new DstarsAltitude
            {
                Value = track.AltitudeFeet.Value,
                AltitudeType = (int)track.AltitudeType
            } : null,
            GroundSpeed = positionOnly ? null : track.GroundSpeedKnots,
            GroundTrack = track.GroundTrackDegrees,
            VerticalRate = positionOnly ? null : track.VerticalRateFpm,
            Squawk = positionOnly ? null : track.Squawk,
            Callsign = positionOnly ? null : track.Callsign,
            ModeSCode = positionOnly ? null : track.ModeSCode,
            Ident = track.Ident,
            IsOnGround = positionOnly ? null : track.IsOnGround,
            Source = positionOnly ? null : 0
        };

        if (update.Location is not null)
            RecordHistory(guid, update.Location, track.Timestamp);

        if (track.Facility is not null)
            UpdateCaTrack(track.Facility, guid, update, track.IsPseudo);

        return JsonSerializer.Serialize(update, JsonOptions);
    }

    // Keep the CA snapshot for this facility current from the track update we just built.
    private void UpdateCaTrack(string facility, Guid guid, DstarsTrackUpdate u, bool pseudo)
    {
        var facTracks = _caTracks.GetOrAdd(facility, _ => new());
        var a = facTracks.GetOrAdd(guid, g => new Ca.Aircraft { Guid = g });
        if (u.Location is not null)
            a.Location = new Ca.GeoPoint(u.Location.Latitude, u.Location.Longitude);
        a.PrimaryOnly = pseudo;
        if (u.Altitude is not null)
        {
            a.Altitude.TrueAltitude = u.Altitude.Value;
            // DstarsAltitude.AltitudeType (0=Pressure,1=True,2=Unknown) maps 1:1 onto Ca.AltitudeType.
            a.Altitude.AltitudeType = (Ca.AltitudeType)u.Altitude.AltitudeType;
        }
        a.GroundSpeed = u.GroundSpeed ?? a.GroundSpeed;
        a.GroundTrack = u.GroundTrack ?? a.GroundTrack;
        // The DGScope feed carries no sector ownership, so every correlated (non-pseudo,
        // Mode-C) track is a CA candidate; the engine's valid/altitude filter gates the rest.
        a.Owned = true;
        a.Associated = true;
        a.Deleted = false;
        a.LastSeen = DateTime.UtcNow;
    }

    // Run DGScope's Conflict Alert engine once per second per viewed facility and broadcast the
    // conflicting-guid set (UT=4). Purges tracks unseen for 30 s (mirrors the position purge).
    private async Task CaLoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try { await Task.Delay(1000, ct); }
            catch (OperationCanceledException) { break; }
            try
            {
                var cutoff = DateTime.UtcNow.AddSeconds(-30);
                foreach (var (facility, facTracks) in _caTracks)
                {
                    foreach (var (g, a) in facTracks)
                        if (a.LastSeen < cutoff) facTracks.TryRemove(g, out _);
                    if (facTracks.IsEmpty) { _caTracks.TryRemove(facility, out _); continue; }
                    if (!_clients.HasClients(facility)) continue;   // no viewer — skip the O(n²) pass

                    var list = facTracks.Values.ToList();
                    _ca.SuppressionVolumes = SuppressionVolumesFor(facility, list);
                    _ca.Calculate(list, _caRadar);
                    var guids = list.Where(a => a.ConflictAlert).Select(a => a.Guid.ToString()).ToArray();
                    var json = JsonSerializer.Serialize(new { UpdateType = 4, Guids = guids }, JsonOptions);
                    _clients.Broadcast(json, facility);   // JS STARS scope reads it; DGScope ignores UT=4
                }
            }
            catch (Exception ex) { _logger.LogError(ex, "CA loop error"); }
        }
    }

    private static readonly List<Ca.CASuppressionVolume> _emptyVols = new();

    // Build (or reuse) the CA final-approach suppression corridors for a facility. Corridors come from
    // runway ends near the facility's live approach traffic; cached and only rebuilt when the coarse
    // bounding box drifts or after 5 min. Faithful to DGScope's CASuppressionVolume geometry/defaults.
    private List<Ca.CASuppressionVolume> SuppressionVolumesFor(string facility, List<Ca.Aircraft> list)
    {
        // Bounding box of approach-relevant tracks (positioned, below 18,000 ft).
        double minLat = double.MaxValue, minLon = double.MaxValue, maxLat = double.MinValue, maxLon = double.MinValue;
        int n = 0;
        foreach (var a in list)
        {
            if (a.Location is null) continue;
            if (a.Altitude.AltitudeType != Ca.AltitudeType.Unknown && a.TrueAltitude > 18000) continue;
            minLat = Math.Min(minLat, a.Location.Latitude); maxLat = Math.Max(maxLat, a.Location.Latitude);
            minLon = Math.Min(minLon, a.Location.Longitude); maxLon = Math.Max(maxLon, a.Location.Longitude);
            n++;
        }
        if (n == 0) return _emptyVols;
        // Expand by ~0.75° (~45 NM) so a 30 NM corridor whose threshold sits just outside the
        // track cluster is still included, and round to 0.5° so the cache key is stable.
        minLat = Math.Floor((minLat - 0.75) * 2) / 2; minLon = Math.Floor((minLon - 0.75) * 2) / 2;
        maxLat = Math.Ceiling((maxLat + 0.75) * 2) / 2; maxLon = Math.Ceiling((maxLon + 0.75) * 2) / 2;
        string boxKey = $"{minLat:F1},{minLon:F1},{maxLat:F1},{maxLon:F1}";
        if (_caSuppression.TryGetValue(facility, out var cached)
            && cached.BoxKey == boxKey && (DateTime.UtcNow - cached.Built) < TimeSpan.FromMinutes(5))
            return cached.Vols;
        var vols = _runways.VolumesInBox(minLat, minLon, maxLat, maxLon);
        _caSuppression[facility] = (boxKey, DateTime.UtcNow, vols);
        _logger.LogInformation("CA suppression: {N} corridors for {Facility} (box {Box})", vols.Count, facility, boxKey);
        return vols;
    }

    /// <summary>
    /// Append a position to the track's history ring buffer — time-gated to
    /// HistorySpacing and only when the position actually changed (so a frozen
    /// track doesn't stack points), capped at HistoryMax, newest-first. Mirrors
    /// the client's radarSweep history logic so the seeded trail is consistent.
    /// </summary>
    private void RecordHistory(Guid guid, DstarsGeoPoint pos, DateTime ts)
    {
        if (_trackHistoryTime.TryGetValue(guid, out var last) && (ts - last) < HistorySpacing)
            return;
        var prev = _trackHistory.GetValueOrDefault(guid) ?? Array.Empty<DstarsGeoPoint>();
        if (prev.Length > 0 && prev[0].Latitude == pos.Latitude && prev[0].Longitude == pos.Longitude)
            return;   // no movement — don't stack
        _trackHistoryTime[guid] = ts;
        var next = new DstarsGeoPoint[Math.Min(prev.Length + 1, HistoryMax)];
        next[0] = pos;
        Array.Copy(prev, 0, next, 1, next.Length - 1);
        _trackHistory[guid] = next;
    }

    private string? ConvertFlightPlan(FlightPlanDataEvent fp)
    {
        var guid = _trackState.GetFlightPlanGuid(fp.ModeSCode, fp.TrackNumber, fp.Callsign, fp.Facility);
        var trackGuid = _trackState.GetAssociatedTrackGuid(fp.ModeSCode, fp.TrackNumber, fp.Facility);

        var isEnrichment = fp.Source == "ADSB_ENRICH";

        if (isEnrichment)
        {
            // Track already has a TAIS FP with callsign — suppress enrichment entirely
            if (_taisHasCallsign.ContainsKey(guid))
                return null;

            // Store the enriched callsign so it persists across TAIS batch repeats
            if (!string.IsNullOrEmpty(fp.Callsign))
                _enrichedCallsigns[guid] = fp.Callsign;
        }
        else
        {
            // TAIS FP — track whether it has a callsign
            if (!string.IsNullOrEmpty(fp.Callsign))
                _taisHasCallsign[guid] = 0;
        }

        // For TAIS FPs with no callsign (LADD), re-apply the enriched callsign
        var effectiveCallsign = fp.Callsign;
        if (!isEnrichment && string.IsNullOrEmpty(effectiveCallsign))
        {
            _enrichedCallsigns.TryGetValue(guid, out effectiveCallsign);
        }

        // Resolve owner vs receiver from the per-aircraft handoff state
        // machine BEFORE building the update — see ResolveHandoff comments.
        var (resolvedOwner, resolvedReceiver) = ResolveHandoff(guid, fp);

        var update = new DstarsFlightPlanUpdate
        {
            Guid = guid,
            TimeStamp = fp.Timestamp,
            Callsign = effectiveCallsign,
            AircraftType = fp.AircraftType,
            WakeCategory = fp.WakeCategory,
            FlightRules = fp.FlightRules,
            Origin = fp.EntryFix,
            Destination = fp.ExitFix,
            EntryFix = fp.EntryFix,
            ExitFix = fp.ExitFix,
            Route = fp.Route,
            RequestedAltitude = fp.RequestedAltitude,
            Scratchpad1 = fp.Scratchpad1 ?? "",
            Scratchpad2 = fp.Scratchpad2 ?? "",
            Runway = fp.Runway,
            Owner = resolvedOwner,
            PendingHandoff = resolvedReceiver ?? "",
            HandoffOcr = fp.HandoffOcr,
            IsHandoffInProgress = fp.IsHandoffInProgress,
            AssignedSquawk = StripLeadingZeros(fp.AssignedSquawk),
            EquipmentSuffix = fp.EquipmentSuffix,
            LDRDirection = fp.LdrDirection,
            AssociatedTrackGuid = trackGuid
        };

        var json = JsonSerializer.Serialize(update, JsonOptions);

        // Dedup: TAIS sends full batches every ~5s with all tracks, so the same FP
        // re-emits unchanged every cycle. Only broadcast when content actually changes.
        var contentKey = BuildFpContentKey(update);
        if (_lastFpJson.TryGetValue(guid, out var prev) && prev == contentKey)
            return null; // unchanged — suppress
        _lastFpJson[guid] = contentKey;
        _lastFpJsonOut[guid] = json;     // store full JSON for snapshot replay

        return json;
    }

    /// <summary>
    /// Build a content key for FP dedup — all fields except TimeStamp concatenated.
    /// </summary>
    private static string BuildFpContentKey(DstarsFlightPlanUpdate u) =>
        $"{u.Guid}|{u.Callsign}|{u.AircraftType}|{u.WakeCategory}|{u.FlightRules}|" +
        $"{u.Origin}|{u.Destination}|{u.EntryFix}|{u.ExitFix}|{u.Route}|" +
        $"{u.RequestedAltitude}|{u.Scratchpad1}|{u.Scratchpad2}|{u.Runway}|" +
        $"{u.Owner}|{u.PendingHandoff}|{u.AssignedSquawk}|{u.EquipmentSuffix}|" +
        $"{u.LDRDirection}|{u.AssociatedTrackGuid}|" +
        $"{u.HandoffOcr}|{u.IsHandoffInProgress}";

    /// <summary>
    /// Resolve per-aircraft (owner, receiver) given the latest TAIS update.
    ///
    /// When ocr is "no change": cps IS the current owner. Record it as
    /// ConfirmedOwner and clear HandoffTo. Returned (owner=cps, receiver=null).
    ///
    /// When ocr is in a handoff state: cps is the PRE-STAGED RECEIVER, not
    /// the owner. Stash it as HandoffTo and return (owner=ConfirmedOwner,
    /// receiver=cps). If we've never seen ocr="no change" for this aircraft,
    /// ConfirmedOwner is null — fall back to cps as the owner too (best we
    /// can do without prior history) so the position symbol isn't blank.
    /// </summary>
    private (string? owner, string? receiver) ResolveHandoff(Guid guid, FlightPlanDataEvent fp)
    {
        var s = _handoffState.GetOrAdd(guid, _ => new HandoffState());
        var cps = fp.Owner;       // FlightPlanDataEvent.Owner = the <cps> field

        if (!fp.IsHandoffInProgress)
        {
            // Idle: cps is the actual owner. Lock it in, clear any prior
            // pending receiver.
            if (cps is not null) s.ConfirmedOwner = cps;
            s.HandoffTo = null;
            return (s.ConfirmedOwner, null);
        }

        // Handoff in progress: cps is the receiver.
        //
        // Chained handoff: TAIS sometimes skips the ocr="no change" window
        // entirely when one sector accepts and immediately re-hands-off.
        // Example sequence observed for SWA480 — 1Y owned, ocr flipped to
        // handoff with cps=1L (1L is receiver), then NEXT update was still
        // in-handoff but cps=C (Center) — meaning 1L accepted (implicit)
        // and is now sending it to Center. Without this branch the owner
        // would still show 1Y on the position symbol.
        //
        // Detection: if we already have a HandoffTo, and the new cps is
        // different, the previous HandoffTo IS the new ConfirmedOwner.
        if (s.HandoffTo is not null && cps is not null && cps != s.HandoffTo)
        {
            s.ConfirmedOwner = s.HandoffTo;
        }
        s.HandoffTo = cps;
        // First time we see this aircraft AND it's already in a handoff —
        // we have no prior owner observation. Don't invent one. Return
        // owner=null with receiver=cps so the track renders unowned
        // (default position symbol) and flashes to the receiver TCP. Once
        // an ocr=no change update arrives, ConfirmedOwner will lock in.
        if (s.ConfirmedOwner is null)
        {
            return (null, cps);
        }
        var owner = s.ConfirmedOwner;
        // If somehow ConfirmedOwner == HandoffTo (chained logic edge case),
        // also suppress to avoid the self-handoff display.
        var receiver = (owner == s.HandoffTo) ? null : s.HandoffTo;
        return (owner, receiver);
    }

    /// <summary>
    /// Convert ICAO airport code to FAA LID (e.g. KDCA → DCA, KORD → ORD).
    /// US airports with "K" prefix are converted; others pass through unchanged.
    /// </summary>
    private static string? IcaoToFaaLid(string? icao)
    {
        if (icao is not null && icao.Length == 4 && icao[0] == 'K')
            return icao[1..];
        return icao;
    }

    /// <summary>
    /// Strip leading zeros from squawk codes (e.g. "0535" → "535") to match OG dSTARS format.
    /// Track squawk (reportedBeaconCode) keeps leading zeros; assigned squawk strips them.
    /// </summary>
    private static string? StripLeadingZeros(string? value)
    {
        if (value is null) return null;
        var trimmed = value.TrimStart('0');
        return trimmed.Length > 0 ? trimmed : "0";
    }

    private async Task PurgeLoopAsync(CancellationToken ct)
    {
        // Every 10s (matching SwimServer's TaisBridge) so churned-track-number
        // duplicates are shed promptly rather than lingering up to 30s extra.
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(10));

        while (await timer.WaitForNextTickAsync(ct))
        {
            try
            {
                var deletedTargets = _trackState.PurgeStale();
                int broadcastCount = 0;
                foreach (var (guid, facility) in deletedTargets)
                {
                    // Phantom-delete guard: TrackStateManager keys by per-facility
                    // TAIS track-number, and TAIS reassigns track numbers, so each
                    // reassignment mints a fresh GUID. Most of those churned GUIDs
                    // never produced a UT=0 / UT=1 broadcast (the track was already
                    // re-keyed before its first emit). Emitting UT=2 for a GUID the
                    // client has never seen sent 4,785 phantom deletes in a 5-min
                    // window vs OG ScopeServer's 252 (verified on PCT, 2026-06-26).
                    // Only broadcast when we've actually told clients about the GUID.
                    bool everSentTrack = _lastTrackJson.ContainsKey(guid);
                    bool everSentFp    = _lastFpJsonOut.ContainsKey(guid);

                    _lastFpJson.TryRemove(guid, out _);
                    _lastFpJsonOut.TryRemove(guid, out _);
                    _lastTrackJson.TryRemove(guid, out _);
                    _trackHistory.TryRemove(guid, out _);
                    _trackHistoryTime.TryRemove(guid, out _);
                    _taisHasCallsign.TryRemove(guid, out _);
                    _enrichedCallsigns.TryRemove(guid, out _);
                    if (facility is not null)
                    {
                        if (_facilityTracks.TryGetValue(facility, out var ft)) ft.TryRemove(guid, out _);
                        if (_facilityFlightPlans.TryGetValue(facility, out var ff)) ff.TryRemove(guid, out _);
                    }

                    if (!everSentTrack && !everSentFp) continue;

                    var deletion = new DstarsDeletionUpdate
                    {
                        Guid = guid,
                        TimeStamp = DateTime.UtcNow
                    };

                    var json = JsonSerializer.Serialize(deletion, JsonOptions);
                    // Per-client filter: clients that never saw a UT=0/UT=1
                    // for this guid get nothing — fixes the AddClient ↔
                    // GetSnapshot race where a purge runs between the two
                    // and the snapshot misses the guid.
                    //
                    // Never fan out a UT=2 with facility=null — that
                    // bypasses both the facility filter AND the per-client
                    // guid filter and floods every scope with deletes for
                    // guids they've never seen.
                    if (facility is null)
                    {
                        _logger.LogWarning(
                            "Skipping UT=2 broadcast for {Guid} — null facility (orphan target)", guid);
                        continue;
                    }
                    _clients.BroadcastDeletion(json, facility, guid);
                    broadcastCount++;
                }

                if (deletedTargets.Count > 0)
                {
                    var (accepted, rejected) = _clients.DrainDeletionStats();
                    _logger.LogInformation(
                        "Purged {Count} stale targets ({Sent} broadcast attempts; per-client filter accepted {Accepted}, rejected {Rejected})",
                        deletedTargets.Count, broadcastCount, accepted, rejected);
                }
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error during stale target purge");
            }
        }
    }
}
