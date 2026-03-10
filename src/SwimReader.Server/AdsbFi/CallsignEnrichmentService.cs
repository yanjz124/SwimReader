using System.Collections.Concurrent;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using SwimReader.Core.Bus;
using SwimReader.Core.Events;
using SwimReader.Core.Models;
using SwimReader.Server.Adapters;

namespace SwimReader.Server.AdsbFi;

public sealed class CallsignEnrichmentService : BackgroundService
{
    private readonly IEventBus _eventBus;
    private readonly MultiAdsbClient _multiClient;
    private readonly AdsbFiCache _cache;
    private readonly TrackStateManager _trackState;
    private readonly AdsbFiOptions _options;
    private readonly ILogger<CallsignEnrichmentService> _logger;

    // Track which targets we've already enriched to avoid re-publishing
    private readonly ConcurrentDictionary<string, DateTime> _enrichedTargets = new();
    // Track callsigns we've already published per facility to prevent duplicates
    private readonly ConcurrentDictionary<string, DateTime> _publishedCallsigns = new();

    // Pending enrichment work: enrichKey -> latest track data
    // Written by the fast event consumer, read by the enrichment worker
    private readonly ConcurrentDictionary<string, TrackPositionEvent> _pendingWork = new();

    // Combined regional aircraft data, indexed for fast lookup
    private volatile AircraftIndex? _regionIndex;

    public CallsignEnrichmentService(
        IEventBus eventBus,
        MultiAdsbClient multiClient,
        AdsbFiCache cache,
        TrackStateManager trackState,
        IOptions<AdsbFiOptions> options,
        ILogger<CallsignEnrichmentService> logger)
    {
        _eventBus = eventBus;
        _multiClient = multiClient;
        _cache = cache;
        _trackState = trackState;
        _options = options.Value;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        _logger.LogInformation("Callsign enrichment service started (3-source hybrid)");

        _ = CleanupLoopAsync(ct);
        _ = EnrichmentWorkerAsync(ct);

        // Fast event consumer: reads events quickly and queues enrichment work
        await foreach (var evt in _eventBus.SubscribeAsync("CallsignEnrichment", ct))
        {
            if (evt is not TrackPositionEvent track)
                continue;

            // Skip tracks that already have a callsign or are frozen/pseudo
            if (!string.IsNullOrEmpty(track.Callsign))
                continue;
            if (track.IsFrozen || track.IsPseudo)
                continue;

            var enrichKey = track.ModeSCode.HasValue
                ? $"MS:{track.ModeSCode.Value:X6}"
                : $"SQ:{track.Facility}:{track.Squawk}";

            // Skip already-enriched targets
            if (_enrichedTargets.ContainsKey(enrichKey))
                continue;

            // Queue for enrichment (update with latest position data)
            _pendingWork[enrichKey] = track;
        }
    }

    /// <summary>
    /// Enrichment worker: regional geo query approach.
    /// 1. Fetch regional geo circles covering CONUS (rotates across 3 APIs)
    /// 2. Build combined indexed lookup (by hex + by squawk + by callsign)
    /// 3. Match ALL pending tracks: hex first, then callsign, then squawk
    /// 4. For remaining Mode S keys not in regions, individual hex lookups
    /// </summary>
    private async Task EnrichmentWorkerAsync(CancellationToken ct)
    {
        await Task.Delay(TimeSpan.FromSeconds(5), ct);

        var refreshInterval = _options.EnrichmentRegionRefresh;
        using var timer = new PeriodicTimer(refreshInterval);

        while (true)
        {
            try
            {
                await RefreshRegionsAsync(ct);
                await ProcessAllPendingAsync(ct);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Error in enrichment worker cycle");
            }

            await timer.WaitForNextTickAsync(ct);
        }
    }

    /// <summary>
    /// Fetch aircraft from each configured region and build a combined index.
    /// Round-robins across all 3 ADS-B APIs via MultiAdsbClient.
    /// </summary>
    private async Task RefreshRegionsAsync(CancellationToken ct)
    {
        var regions = _options.EnrichmentRegions;
        if (regions.Count == 0) return;

        var allAircraft = new Dictionary<string, AdsbFiAircraft>(StringComparer.OrdinalIgnoreCase);

        foreach (var region in regions)
        {
            var aircraft = await _multiClient.GetByLocationAsync(
                region.Latitude, region.Longitude, region.RadiusNm, ct);

            foreach (var ac in aircraft)
            {
                if (!string.IsNullOrEmpty(ac.Hex))
                    allAircraft[ac.Hex] = ac; // Dedup by hex across overlapping regions
            }
        }

        // Build squawk index
        var bySquawk = new Dictionary<string, List<AdsbFiAircraft>>(StringComparer.Ordinal);
        // Build callsign index
        var byCallsign = new Dictionary<string, AdsbFiAircraft>(StringComparer.OrdinalIgnoreCase);

        foreach (var ac in allAircraft.Values)
        {
            if (!string.IsNullOrEmpty(ac.Squawk))
            {
                if (!bySquawk.TryGetValue(ac.Squawk, out var list))
                {
                    list = [];
                    bySquawk[ac.Squawk] = list;
                }
                list.Add(ac);
            }

            var cs = ac.TrimmedCallsign;
            if (!string.IsNullOrEmpty(cs))
                byCallsign[cs] = ac;
        }

        _regionIndex = new AircraftIndex(allAircraft, bySquawk, byCallsign);

        // Cross-populate hex cache for individual lookups
        foreach (var (hex, ac) in allAircraft)
            _cache.SetHex(hex, ac);

        _logger.LogInformation(
            "Enrichment regions refreshed: {RegionCount} regions, {AcCount} aircraft, {SqGroups} squawk groups",
            regions.Count, allAircraft.Count, bySquawk.Count);
    }

    /// <summary>
    /// Match all pending tracks against the combined regional index.
    /// Priority: hex (Mode S 24-bit) → callsign → squawk.
    /// </summary>
    private async Task ProcessAllPendingAsync(CancellationToken ct)
    {
        var index = _regionIndex;
        if (index is null) return;

        var keys = _pendingWork.Keys.ToList();
        if (keys.Count == 0) return;

        var matchCount = 0;
        var totalCount = 0;
        var msRemaining = new List<(string Key, TrackPositionEvent Track)>();

        foreach (var key in keys)
        {
            if (!_pendingWork.TryRemove(key, out var track))
                continue;
            if (_enrichedTargets.ContainsKey(key))
                continue;

            totalCount++;
            AdsbFiAircraft? aircraft = null;

            if (key.StartsWith("MS:", StringComparison.Ordinal))
            {
                // Priority 1: Hex (Mode S 24-bit ICAO address) — most reliable
                var hex = ModeSCodeHelper.ToHexString(track.ModeSCode!.Value);
                if (index.ByHex.TryGetValue(hex, out aircraft))
                {
                    matchCount++;
                    await PublishEnrichmentAsync(key, track, aircraft, ct);
                }
                else
                {
                    // Not in any region - queue for individual API lookup
                    msRemaining.Add((key, track));
                }
            }
            else if (!string.IsNullOrEmpty(track.Squawk))
            {
                // Priority 3: Squawk + position proximity (least reliable, last resort)
                if (index.BySquawk.TryGetValue(track.Squawk, out var candidates))
                {
                    aircraft = MatchBySquawk(candidates, track);
                }

                if (aircraft is not null)
                {
                    matchCount++;
                    await PublishEnrichmentAsync(key, track, aircraft, ct);
                }
            }
        }

        // Process remaining Mode S keys with individual hex lookups (cache first)
        foreach (var (key, track) in msRemaining.Take(50))
        {
            if (_enrichedTargets.ContainsKey(key))
                continue;

            var hex = ModeSCodeHelper.ToHexString(track.ModeSCode!.Value);
            AdsbFiAircraft? aircraft = null;

            if (_cache.TryGetHex(hex, out var cached))
            {
                aircraft = cached;
            }
            else if (!_cache.WasRecentlyQueried(hex))
            {
                // Individual hex lookup — rotates across all 3 APIs
                aircraft = await _multiClient.GetByHexAsync(hex, ct);
                _cache.SetHex(hex, aircraft);
            }

            if (aircraft is not null)
            {
                matchCount++;
                await PublishEnrichmentAsync(key, track, aircraft, ct);
            }
        }

        if (totalCount > 0)
        {
            _logger.LogDebug("Enrichment cycle: {Matches}/{Total} matched, {MsRemaining} MS fallback lookups",
                matchCount, totalCount, msRemaining.Count);
        }
    }

    private AdsbFiAircraft? MatchBySquawk(List<AdsbFiAircraft> candidates, TrackPositionEvent track)
    {
        // TAIS altitude=0 means "no Mode-C data" (primary-only), not ground level.
        // Skip altitude check in that case; rely on squawk + position proximity only.
        var hasAltitude = track.AltitudeFeet.HasValue && track.AltitudeFeet.Value > 0;

        return candidates
            .Where(ac =>
                ac.Lat.HasValue && ac.Lon.HasValue &&
                GeoDistanceNm(track.Position.Latitude, track.Position.Longitude,
                    ac.Lat.Value, ac.Lon.Value) <= _options.PositionProximityNm &&
                (!hasAltitude || (ac.ParsedAltBaro.HasValue &&
                    Math.Abs(ac.ParsedAltBaro.Value - track.AltitudeFeet!.Value) <= _options.AltitudeProximityFeet)))
            .OrderBy(ac => GeoDistanceNm(
                track.Position.Latitude, track.Position.Longitude,
                ac.Lat!.Value, ac.Lon!.Value))
            .FirstOrDefault();
    }

    private async Task PublishEnrichmentAsync(
        string enrichKey, TrackPositionEvent track, AdsbFiAircraft aircraft, CancellationToken ct)
    {
        if (aircraft.TrimmedCallsign is null or "")
            return;

        // If squawk-matched aircraft has a Mode S code already tracked by TAIS,
        // redirect the enrichment to the Mode S track instead of creating a
        // duplicate flight plan on the uncorrelated track (TAIS desync fix)
        int? effectiveModeSCode = track.ModeSCode;
        var isModeSTarget = track.ModeSCode.HasValue && track.ModeSCode.Value > 0;

        if (!isModeSTarget && aircraft.Hex is not null)
        {
            var matchedModeSCode = ModeSCodeHelper.ParseHex(aircraft.Hex);
            if (matchedModeSCode.HasValue && _trackState.HasTrack(matchedModeSCode.Value))
            {
                effectiveModeSCode = matchedModeSCode;
                isModeSTarget = true;
                _logger.LogDebug("Redirecting enrichment for {Key} to Mode S track {Hex}",
                    enrichKey, aircraft.Hex);
            }
        }

        // Skip if this callsign is already in use (avoids duplicates from
        // TAIS lag/desync creating multiple tracks for the same aircraft)
        var csKey = $"{track.Facility}:{aircraft.TrimmedCallsign}";
        if (_trackState.HasCallsign(aircraft.TrimmedCallsign, track.Facility) ||
            _publishedCallsigns.ContainsKey(csKey))
        {
            _enrichedTargets[enrichKey] = DateTime.UtcNow;
            _logger.LogDebug("Skipping enrichment for {Key}: callsign {Callsign} already in use",
                enrichKey, aircraft.TrimmedCallsign);
            return;
        }

        // LADD flights (Mode S target with no callsign): put callsign on line 1
        // Uncorrelated targets (no Mode S): squawk on line 1, callsign in scratchpad
        var fpEvent = new FlightPlanDataEvent
        {
            Timestamp = DateTime.UtcNow,
            Source = "ADSB_ENRICH",
            Callsign = isModeSTarget ? aircraft.TrimmedCallsign : track.Squawk,
            ModeSCode = effectiveModeSCode,
            TrackNumber = isModeSTarget ? null : track.TrackNumber,
            AircraftType = aircraft.AircraftType,
            WakeCategory = RecatLookup.GetCategory(aircraft.AircraftType),
            AssignedSquawk = isModeSTarget ? track.Squawk : aircraft.TrimmedCallsign,
            Scratchpad1 = isModeSTarget ? null : aircraft.TrimmedCallsign,
            Facility = track.Facility
        };

        await _eventBus.PublishAsync(fpEvent, ct);

        // If TAIS has no altitude but ADS-B does, supplement the track
        if ((!track.AltitudeFeet.HasValue || track.AltitudeFeet.Value == 0) &&
            aircraft.ParsedAltBaro.HasValue && aircraft.ParsedAltBaro.Value > 0)
        {
            var trackUpdate = new TrackPositionEvent
            {
                Timestamp = DateTime.UtcNow,
                Source = "ADSB_ENRICH",
                Position = new GeoPosition(
                    aircraft.Lat ?? track.Position.Latitude,
                    aircraft.Lon ?? track.Position.Longitude),
                ModeSCode = track.ModeSCode,
                TrackNumber = track.TrackNumber,
                AltitudeFeet = aircraft.ParsedAltBaro,
                AltitudeType = AltitudeType.Pressure,
                GroundSpeedKnots = aircraft.GroundSpeed.HasValue
                    ? (int)Math.Round(aircraft.GroundSpeed.Value) : track.GroundSpeedKnots,
                GroundTrackDegrees = aircraft.Track.HasValue
                    ? (int)Math.Round(aircraft.Track.Value) : track.GroundTrackDegrees,
                VerticalRateFpm = aircraft.BaroRate ?? track.VerticalRateFpm,
                Squawk = track.Squawk,
                Facility = track.Facility
            };

            await _eventBus.PublishAsync(trackUpdate, ct);
        }

        _enrichedTargets[enrichKey] = DateTime.UtcNow;
        _publishedCallsigns[csKey] = DateTime.UtcNow;

        _logger.LogDebug("Enriched {Key} with callsign {Callsign} (LADD={IsLadd})",
            enrichKey, aircraft.TrimmedCallsign, isModeSTarget);
    }

    internal static double GeoDistanceNm(double lat1, double lon1, double lat2, double lon2)
    {
        const double R = 3440.065; // Earth radius in NM
        var dLat = (lat2 - lat1) * Math.PI / 180;
        var dLon = (lon2 - lon1) * Math.PI / 180;
        var a = Math.Sin(dLat / 2) * Math.Sin(dLat / 2) +
                Math.Cos(lat1 * Math.PI / 180) * Math.Cos(lat2 * Math.PI / 180) *
                Math.Sin(dLon / 2) * Math.Sin(dLon / 2);
        return R * 2 * Math.Atan2(Math.Sqrt(a), Math.Sqrt(1 - a));
    }

    private async Task CleanupLoopAsync(CancellationToken ct)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMinutes(2));
        while (await timer.WaitForNextTickAsync(ct))
        {
            var cutoff = DateTime.UtcNow.AddMinutes(-5);
            foreach (var kvp in _enrichedTargets)
            {
                if (kvp.Value < cutoff)
                    _enrichedTargets.TryRemove(kvp.Key, out _);
            }
            foreach (var kvp in _publishedCallsigns)
            {
                if (kvp.Value < cutoff)
                    _publishedCallsigns.TryRemove(kvp.Key, out _);
            }
            _cache.PurgeExpired();
        }
    }

    /// <summary>
    /// Combined index of aircraft from all regional queries.
    /// </summary>
    private sealed record AircraftIndex(
        Dictionary<string, AdsbFiAircraft> ByHex,
        Dictionary<string, List<AdsbFiAircraft>> BySquawk,
        Dictionary<string, AdsbFiAircraft> ByCallsign);
}
