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
            IsOnGround = positionOnly ? null : track.IsOnGround
        };

        return JsonSerializer.Serialize(update, JsonOptions);
    }

    private string ConvertFlightPlan(FlightPlanDataEvent fp)
    {
        var guid = _trackState.GetFlightPlanGuid(fp.ModeSCode, fp.TrackNumber, fp.Callsign, fp.Facility);
        var trackGuid = _trackState.GetAssociatedTrackGuid(fp.ModeSCode, fp.TrackNumber, fp.Facility);

        var update = new DstarsFlightPlanUpdate
        {
            Guid = guid,
            TimeStamp = fp.Timestamp,
            Callsign = fp.Callsign,
            AircraftType = fp.AircraftType,
            WakeCategory = fp.WakeCategory,
            FlightRules = fp.FlightRules,
            Origin = fp.Origin,
            Destination = fp.Destination,
            EntryFix = fp.EntryFix,
            ExitFix = fp.ExitFix,
            Route = fp.Route,
            RequestedAltitude = fp.RequestedAltitude,
            Scratchpad1 = fp.Scratchpad1,
            Scratchpad2 = fp.Scratchpad2,
            Runway = fp.Runway,
            Owner = fp.Owner,
            PendingHandoff = fp.PendingHandoff,
            AssignedSquawk = fp.AssignedSquawk,
            EquipmentSuffix = fp.EquipmentSuffix,
            LDRDirection = fp.LdrDirection,
            AssociatedTrackGuid = trackGuid
        };

        return JsonSerializer.Serialize(update, JsonOptions);
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
