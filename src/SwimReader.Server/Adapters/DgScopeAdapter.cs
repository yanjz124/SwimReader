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
    /// Caches last TAIS flight plan data per GUID. Used to:
    /// 1) Suppress enrichment for tracks that already have a callsign (non-LADD)
    /// 2) Merge ADS-B callsign into TAIS data for LADD tracks (have FP but no callsign)
    /// </summary>
    private readonly ConcurrentDictionary<Guid, DstarsFlightPlanUpdate> _lastTaisFp = new();

    /// <summary>
    /// Tracks which track GUIDs have had a flight plan sent. Used to generate
    /// synthetic FPs for uncorrelated targets (squawk only, no TAIS FP) so
    /// DGScope beacon reader can display their squawk codes.
    /// </summary>
    private readonly ConcurrentDictionary<Guid, byte> _trackHasFp = new();

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

        await foreach (var evt in _eventBus.SubscribeAsync("DgScopeAdapter", stoppingToken))
        {
            try
            {
                foreach (var (json, facility) in ConvertToMessages(evt))
                {
                    _clients.Broadcast(json, facility);
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error converting event to Dstars JSON");
            }
        }
    }

    private IEnumerable<(string json, string? facility)> ConvertToMessages(ISwimEvent evt)
    {
        switch (evt)
        {
            case TrackPositionEvent track:
            {
                var (trackJson, syntheticFpJson) = ConvertTrack(track);
                yield return (trackJson, track.Facility);
                if (syntheticFpJson is not null)
                    yield return (syntheticFpJson, track.Facility);
                break;
            }

            case FlightPlanDataEvent fp:
            {
                var json = ConvertFlightPlan(fp);
                if (json is not null)
                    yield return (json, fp.Facility);
                break;
            }
        }
    }

    private (string trackJson, string? syntheticFpJson) ConvertTrack(TrackPositionEvent track)
    {
        var guid = _trackState.GetTrackGuid(track.ModeSCode, track.TrackNumber, track.Facility);
        var positionOnly = track.IsFrozen || track.IsPseudo;

        var update = new DstarsTrackUpdate
        {
            Guid = guid,
            TimeStamp = track.Timestamp,
            Location = new DstarsGeoPoint
            {
                Latitude = track.Position.Latitude,
                Longitude = track.Position.Longitude
            },
            // Omit altitude, squawk, Mode S for frozen/pseudo tracks so DGScope
            // treats them as PrimaryOnly (position symbol only, no datablock)
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

        var trackJson = JsonSerializer.Serialize(update, JsonOptions);

        // For uncorrelated targets with a squawk but no flight plan,
        // generate a synthetic FP so DGScope beacon reader can display them.
        string? syntheticFpJson = null;
        if (!positionOnly && !string.IsNullOrEmpty(track.Squawk) && !_trackHasFp.ContainsKey(guid))
        {
            var fpGuid = _trackState.GetFlightPlanGuid(track.ModeSCode, track.TrackNumber, null, track.Facility);
            var fpUpdate = new DstarsFlightPlanUpdate
            {
                Guid = fpGuid,
                TimeStamp = track.Timestamp,
                Callsign = track.Squawk,
                AssignedSquawk = StripLeadingZeros(track.Squawk),
                AssociatedTrackGuid = guid
            };

            var fpKey = BuildFpContentKey(fpUpdate);
            if (!_lastFpJson.TryGetValue(fpGuid, out var prevFp) || prevFp != fpKey)
            {
                _lastFpJson[fpGuid] = fpKey;
                _trackHasFp[guid] = 0;
                syntheticFpJson = JsonSerializer.Serialize(fpUpdate, JsonOptions);
            }
        }

        return (trackJson, syntheticFpJson);
    }

    private string? ConvertFlightPlan(FlightPlanDataEvent fp)
    {
        var guid = _trackState.GetFlightPlanGuid(fp.ModeSCode, fp.TrackNumber, fp.Callsign, fp.Facility);
        var trackGuid = _trackState.GetAssociatedTrackGuid(fp.ModeSCode, fp.TrackNumber, fp.Facility);

        var isEnrichment = fp.Source == "ADSB_ENRICH";

        if (isEnrichment)
        {
            if (_lastTaisFp.TryGetValue(guid, out var taisFp))
            {
                if (!string.IsNullOrEmpty(taisFp.Callsign))
                    return null; // TAIS already has callsign — suppress enrichment

                // LADD track: TAIS FP exists but no callsign.
                // Merge ADS-B callsign into the cached TAIS data so we
                // keep Owner, Origin, Destination, etc. from TAIS.
                var merged = new DstarsFlightPlanUpdate
                {
                    Guid = taisFp.Guid,
                    TimeStamp = fp.Timestamp,
                    Callsign = fp.Callsign,
                    AircraftType = fp.AircraftType ?? taisFp.AircraftType,
                    WakeCategory = fp.WakeCategory ?? taisFp.WakeCategory,
                    FlightRules = taisFp.FlightRules,
                    Origin = taisFp.Origin,
                    Destination = taisFp.Destination,
                    EntryFix = taisFp.EntryFix,
                    ExitFix = taisFp.ExitFix,
                    Route = taisFp.Route,
                    RequestedAltitude = taisFp.RequestedAltitude,
                    Scratchpad1 = taisFp.Scratchpad1,
                    Scratchpad2 = taisFp.Scratchpad2,
                    Runway = taisFp.Runway,
                    Owner = taisFp.Owner,
                    PendingHandoff = taisFp.PendingHandoff,
                    AssignedSquawk = taisFp.AssignedSquawk,
                    EquipmentSuffix = taisFp.EquipmentSuffix,
                    LDRDirection = taisFp.LDRDirection,
                    AssociatedTrackGuid = taisFp.AssociatedTrackGuid
                };
                var mergedJson = JsonSerializer.Serialize(merged, JsonOptions);
                var mergedKey = BuildFpContentKey(merged);
                if (_lastFpJson.TryGetValue(guid, out var prevKey) && prevKey == mergedKey)
                    return null;
                _lastFpJson[guid] = mergedKey;
                return mergedJson;
            }
        }
        else
        {
            // Cache the TAIS FP data for LADD detection and enrichment merging
        }

        var update = new DstarsFlightPlanUpdate
        {
            Guid = guid,
            TimeStamp = fp.Timestamp,
            Callsign = fp.Callsign,
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
            Owner = fp.Owner,
            PendingHandoff = fp.PendingHandoff ?? "",
            AssignedSquawk = StripLeadingZeros(fp.AssignedSquawk),
            EquipmentSuffix = fp.EquipmentSuffix,
            LDRDirection = fp.LdrDirection,
            AssociatedTrackGuid = trackGuid
        };

        if (!isEnrichment)
        {
            _lastTaisFp[guid] = update;
        }

        // Mark the associated track as having a flight plan
        if (trackGuid.HasValue)
        {
            _trackHasFp[trackGuid.Value] = 0;
        }

        var json = JsonSerializer.Serialize(update, JsonOptions);

        // Dedup: TAIS sends full batches every ~5s with all tracks, so the same FP
        // re-emits unchanged every cycle. Only broadcast when content actually changes.
        // Compare full JSON (includes all fields); TimeStamp varies but is fine for
        // dedup since a changed timestamp with identical data still means "no change."
        // We strip TimeStamp for comparison by using a content key.
        var contentKey = BuildFpContentKey(update);
        if (_lastFpJson.TryGetValue(guid, out var prev) && prev == contentKey)
            return null; // unchanged — suppress
        _lastFpJson[guid] = contentKey;

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
        $"{u.LDRDirection}|{u.AssociatedTrackGuid}";

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
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(30));

        while (await timer.WaitForNextTickAsync(ct))
        {
            try
            {
                var deletedTargets = _trackState.PurgeStale();
                foreach (var (guid, facility) in deletedTargets)
                {
                    _lastFpJson.TryRemove(guid, out _);
                    _lastTaisFp.TryRemove(guid, out _);
                    _trackHasFp.TryRemove(guid, out _);

                    var deletion = new DstarsDeletionUpdate
                    {
                        Guid = guid,
                        TimeStamp = DateTime.UtcNow
                    };

                    var json = JsonSerializer.Serialize(deletion, JsonOptions);
                    _clients.Broadcast(json, facility);
                }

                if (deletedTargets.Count > 0)
                {
                    _logger.LogInformation("Purged {Count} stale targets", deletedTargets.Count);
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
