using System.Collections.Concurrent;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using SwimReader.Core.Bus;
using SwimReader.Core.Events;
using SwimReader.Core.Models;
using SwimReader.Server.Adapters;

namespace SwimReader.Server.AdsbFi;

public sealed class MilitaryInjectionService : BackgroundService
{
    private readonly IEventBus _eventBus;
    private readonly AdsbFiClient _adsbClient;
    private readonly AdsbFiCache _cache;
    private readonly TrackStateManager _trackState;
    private readonly AdsbFiOptions _options;
    private readonly ILogger<MilitaryInjectionService> _logger;

    private readonly ConcurrentDictionary<string, DateTime> _injectedMilitary = new();

    public MilitaryInjectionService(
        IEventBus eventBus,
        AdsbFiClient adsbClient,
        AdsbFiCache cache,
        TrackStateManager trackState,
        IOptions<AdsbFiOptions> options,
        ILogger<MilitaryInjectionService> logger)
    {
        _eventBus = eventBus;
        _adsbClient = adsbClient;
        _cache = cache;
        _trackState = trackState;
        _options = options.Value;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        _logger.LogInformation("Military injection service started with {Count} facility areas",
            _options.Facilities.Count);

        if (_options.Facilities.Count == 0)
        {
            _logger.LogWarning("No facility coverage areas configured; military injection idle");
            return;
        }

        using var timer = new PeriodicTimer(_options.MilitaryPollInterval);
        var facilityIndex = 0;

        while (await timer.WaitForNextTickAsync(ct))
        {
            try
            {
                var facility = _options.Facilities[facilityIndex];
                facilityIndex = (facilityIndex + 1) % _options.Facilities.Count;

                await PollFacilityAsync(facility, ct);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error during military injection poll");
            }
        }
    }

    private async Task PollFacilityAsync(FacilityCoverage facility, CancellationToken ct)
    {
        IReadOnlyList<AdsbFiAircraft>? aircraft;

        if (_cache.TryGetGeo(facility.FacilityId, out var cached))
        {
            aircraft = cached;
        }
        else
        {
            aircraft = await _adsbClient.GetByLocationAsync(
                facility.CenterLatitude, facility.CenterLongitude,
                facility.RadiusNm, ct);
            _cache.SetGeo(facility.FacilityId, aircraft);
        }

        if (aircraft is null) return;

        var militaryAircraft = aircraft
            .Where(ac => IsMilitaryAircraft(ac) && ac.Hex is not null && ac.Lat.HasValue && ac.Lon.HasValue)
            .ToList();

        var seenHexCodes = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var mil in militaryAircraft)
        {
            seenHexCodes.Add(mil.Hex!);
            var modeSCode = ModeSCodeHelper.ParseHex(mil.Hex);

            // Skip if already tracked by TAIS — by Mode S code OR by callsign.
            // The callsign check catches the dupe case where TAIS keys the target
            // by track number (no Mode S) while our injection would key it by
            // Mode S, yielding two GUIDs for one aircraft. Don't skip our own
            // injected track (we must keep re-publishing it to stay alive).
            var taisHasIt = (modeSCode.HasValue && _trackState.HasTrack(modeSCode.Value))
                || (mil.TrimmedCallsign is not null && _trackState.HasCallsign(mil.TrimmedCallsign, null));
            if (taisHasIt && !_injectedMilitary.ContainsKey(mil.Hex!))
                continue;

            await InjectAircraftAsync(mil, facility.FacilityId, ct);
            _injectedMilitary[mil.Hex!] = DateTime.UtcNow;
        }

        // Clean up departed aircraft from our tracking set
        foreach (var kvp in _injectedMilitary)
        {
            if (!seenHexCodes.Contains(kvp.Key) &&
                kvp.Value < DateTime.UtcNow.AddMinutes(-2))
            {
                _injectedMilitary.TryRemove(kvp.Key, out _);
            }
        }

        if (militaryAircraft.Count > 0)
        {
            _logger.LogDebug("Military poll for {Facility}: {Total} aircraft, {Mil} military",
                facility.FacilityId, aircraft.Count, militaryAircraft.Count);
        }
    }

    private async Task InjectAircraftAsync(AdsbFiAircraft ac, string facility, CancellationToken ct)
    {
        var modeSCode = ModeSCodeHelper.ParseHex(ac.Hex);

        var trackEvent = new TrackPositionEvent
        {
            Timestamp = DateTime.UtcNow,
            Source = "ADSB_MIL",
            Position = new GeoPosition(ac.Lat!.Value, ac.Lon!.Value),
            ModeSCode = modeSCode,
            Squawk = ac.Squawk,
            Callsign = ac.TrimmedCallsign,
            AltitudeFeet = ac.ParsedAltBaro,
            AltitudeType = ac.ParsedAltBaro.HasValue ? AltitudeType.Pressure : AltitudeType.Unknown,
            GroundSpeedKnots = ac.GroundSpeed.HasValue ? (int)Math.Round(ac.GroundSpeed.Value) : null,
            GroundTrackDegrees = ac.Track.HasValue ? (int)Math.Round(ac.Track.Value) : null,
            VerticalRateFpm = ac.BaroRate,
            IsOnGround = ac.IsOnGround,
            Facility = facility
        };

        await _eventBus.PublishAsync(trackEvent, ct);

        if (ac.TrimmedCallsign is not null || ac.AircraftType is not null)
        {
            var fpEvent = new FlightPlanDataEvent
            {
                Timestamp = DateTime.UtcNow,
                Source = "ADSB_MIL",
                Callsign = ac.TrimmedCallsign,
                ModeSCode = modeSCode,
                AircraftType = ac.AircraftType,
                WakeCategory = RecatLookup.GetCategory(ac.AircraftType),
                AssignedSquawk = ac.Squawk,
                Facility = facility
            };

            await _eventBus.PublishAsync(fpEvent, ct);
        }
    }

    private static bool IsMilitaryAircraft(AdsbFiAircraft ac)
    {
        return ac.IsMilitary || ModeSCodeHelper.IsUsMilitaryHex(ac.Hex);
    }
}
