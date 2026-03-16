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
                var (json, facility) = ConvertToJsonWithFacility(evt);
                if (json is not null)
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

    private (string? json, string? facility) ConvertToJsonWithFacility(ISwimEvent evt)
    {
        switch (evt)
        {
            case TrackPositionEvent track:
                return (ConvertTrack(track), track.Facility);

            case FlightPlanDataEvent fp:
                return (ConvertFlightPlan(fp), fp.Facility);

            default:
                return (null, null);
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

        return JsonSerializer.Serialize(update, JsonOptions);
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
            Owner = fp.Owner,
            PendingHandoff = fp.PendingHandoff ?? "",
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
                    _taisHasCallsign.TryRemove(guid, out _);
                    _enrichedCallsigns.TryRemove(guid, out _);

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
