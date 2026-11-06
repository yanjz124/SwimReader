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
    private readonly SwimCorrelationSource _swim;
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
    /// <summary>Last ADS-B region sweep, kept so the index can be rebuilt on the fast cadence
    /// when only the SWIM half has changed.</summary>
    private volatile IReadOnlyList<AdsbFiAircraft> _adsbSet = Array.Empty<AdsbFiAircraft>();

    // ── Per-tier counters ───────────────────────────────────────────────────
    //
    // "Is the beacon reader working?" was not answerable without turning on Debug logging on a
    // box whose journal is capped (see CLAUDE.md on logging volume), and silence from this
    // service is indistinguishable from "nothing matched". The DGScope receiver this is ported
    // from writes a log file for exactly that reason. Counting per tier also says WHY: a
    // position-only tier that sees candidates but rejects them all is a very different problem
    // from one that never gets a candidate.
    private long _srcAdsb, _srcSfdps, _srcTais;
    private long _seen, _queued, _matchHex, _matchSquawk, _matchPosition,
                 _posNoCoverage, _posNoCandidate, _posAmbiguous,
                 _skippedNonDiscrete, _published, _skippedDuplicate;
    private DateTime _lastMatch;

    /// <summary>Enrichment counters for GET /diag — see the fields above for why they exist.</summary>
    public object Stats() => new
    {
        regionAircraft = _regionIndex?.ByHex.Count ?? 0,
        regionCells = _regionIndex?.ByCell.Count ?? 0,
        pending = _pendingWork.Count,
        tracksSeen = Interlocked.Read(ref _seen),
        tracksQueued = Interlocked.Read(ref _queued),
        // Which tier produced the match. positionOnly is the one that serves uncorrelated
        // targets, since TAIS publishes no Mode S code for them.
        matchedByHex = Interlocked.Read(ref _matchHex),
        matchedBySquawk = Interlocked.Read(ref _matchSquawk),
        matchedByPosition = Interlocked.Read(ref _matchPosition),
        // Why the position tier declined: nothing in the 1.5 NM / 500 ft gate, versus two or
        // more in it (rejected on purpose — with no tiebreaker, picking the closer one is a
        // coin flip that produces a confidently wrong callsign).
        // No ADS-B target within ~90 NM at all: the region set doesn't cover this facility.
        // Loosening the gate cannot help these; only more coverage can.
        positionNoCoverage = Interlocked.Read(ref _posNoCoverage),
        positionNoCandidate = Interlocked.Read(ref _posNoCandidate),
        positionAmbiguous = Interlocked.Read(ref _posAmbiguous),
        // Tracks whose only identifier was a non-discrete code (1200, 7700, any xx00), so the
        // squawk tier correctly refused them and they fell through to position-only.
        nonDiscreteSquawk = Interlocked.Read(ref _skippedNonDiscrete),
        published = Interlocked.Read(ref _published),
        skippedDuplicate = Interlocked.Read(ref _skippedDuplicate),
        lastMatch = _lastMatch == default ? null : _lastMatch.ToString("o"),
        // WHICH source produced the name, independent of which tier did. Without this split a
        // rising match count cannot distinguish "ADS-B coverage improved" from "we started
        // reading our own feed", and the two have completely different follow-ups.
        matchedFromAdsb = Interlocked.Read(ref _srcAdsb),
        matchedFromSfdps = Interlocked.Read(ref _srcSfdps),
        matchedFromTais = Interlocked.Read(ref _srcTais),
        swim = _swim.Stats(),
    };

    public CallsignEnrichmentService(
        IEventBus eventBus,
        MultiAdsbClient multiClient,
        AdsbFiCache cache,
        SwimCorrelationSource swim,
        TrackStateManager trackState,
        IOptions<AdsbFiOptions> options,
        ILogger<CallsignEnrichmentService> logger)
    {
        _eventBus = eventBus;
        _multiClient = multiClient;
        _cache = cache;
        _swim = swim;
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

            Interlocked.Increment(ref _seen);

            // A track that already has a callsign needs no enrichment — but it is EVIDENCE.
            // The same aircraft is often untagged at the neighbouring facility, and this loop
            // already sees every one of them, so remembering it costs an index entry and names
            // 24.6% of untagged targets that ADS-B could not.
            if (!string.IsNullOrEmpty(track.Callsign))
            {
                _swim.NoteTagged(track);
                continue;
            }
            if (track.IsFrozen || track.IsPseudo)
                continue;
            if (!BeaconCodes.IsDiscrete(track.Squawk) && !track.ModeSCode.HasValue)
                Interlocked.Increment(ref _skippedNonDiscrete);

            // Key by the strongest identifier the track has. A non-discrete code (1200, 7700,
            // any xx00 — see BeaconCodes) is NOT an identifier: it is shared, so keying on it
            // would also make every 1200 in the facility collide on one enrichment slot. Those
            // fall through to a track-number key and are matched on position alone, on a much
            // tighter gate.
            var enrichKey = track.ModeSCode.HasValue
                ? $"MS:{track.ModeSCode.Value:X6}"
                : BeaconCodes.IsDiscrete(track.Squawk)
                    ? $"SQ:{track.Facility}:{track.Squawk}"
                    : $"PX:{track.Facility}:{track.TrackNumber}";

            // Skip already-enriched targets
            if (_enrichedTargets.ContainsKey(enrichKey))
                continue;

            // Queue for enrichment (update with latest position data)
            if (!_pendingWork.ContainsKey(enrichKey)) Interlocked.Increment(ref _queued);
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

        // Two cadences, because the two halves cost wildly different things.
        //
        // RefreshRegionsAsync is 20 rate-limited HTTP calls and belongs on the slow timer.
        // ProcessAllPendingAsync is pure in-memory matching against the index we already hold —
        // it costs nothing, so running it only once per refresh made every new track wait up to
        // a full minute for a callsign for no reason. An uncorrelated VFR target can be on and
        // off a TRACON's scope inside that window. The DGScope receiver this is ported from
        // polls every 5 s.
        //
        // Matching between refreshes uses an index up to 60 s old, which is fine: the gate is
        // 1.5 NM and ADS-B positions are interpolated against the TRACON track's CURRENT
        // position (the pending entry is overwritten by every TAIS update), so the error that
        // matters is the index's age, not the track's.
        var refreshInterval = _options.EnrichmentRegionRefresh;
        var matchInterval = TimeSpan.FromSeconds(Math.Max(5, refreshInterval.TotalSeconds / 6));
        using var timer = new PeriodicTimer(matchInterval);
        var lastRefresh = DateTime.MinValue;

        while (true)
        {
            try
            {
                var refreshed = DateTime.UtcNow - lastRefresh >= refreshInterval;
                if (refreshed)
                {
                    await RefreshRegionsAsync(ct);
                    lastRefresh = DateTime.UtcNow;
                }
                // SWIM candidates refresh on the FAST cadence, not with the regions. The
                // SFDPS pull is one local HTTP call rather than 20 rate-limited public ones, and
                // position freshness is the whole currency of a distance gate: at 450 kt a
                // 60-second-old fix is already 7 NM out against a 5 NM gate.
                await _swim.RefreshSfdpsAsync(ct);
                RebuildIndex();
                await ProcessAllPendingAsync(allowHexLookups: refreshed, ct);
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

        // Three at a time: the rate limiters are per-source and GetByLocationAsync now rotates
        // which source each region prefers, so three requests can genuinely be in flight. More
        // concurrency than sources would just queue on the same semaphores.
        using (var gate = new SemaphoreSlim(3))
        {
            var fetches = regions.Select(async region =>
            {
                await gate.WaitAsync(ct);
                try
                {
                    return await _multiClient.GetByLocationAsync(
                        region.Latitude, region.Longitude, region.RadiusNm, ct);
                }
                finally { gate.Release(); }
            }).ToList();

            foreach (var aircraft in await Task.WhenAll(fetches))
                foreach (var ac in aircraft)
                    if (!string.IsNullOrEmpty(ac.Hex))
                        allAircraft[ac.Hex] = ac; // Dedup by hex across overlapping regions
        }

        _adsbSet = allAircraft.Values.ToList();
        RebuildIndex();

        // Cross-populate hex cache for individual lookups
        foreach (var (hex, ac) in allAircraft)
            _cache.SetHex(hex, ac);

        _logger.LogInformation(
            "Enrichment regions refreshed: {RegionCount} regions, {AcCount} ADS-B aircraft",
            regions.Count, allAircraft.Count);
    }

    /// <summary>
    /// Build the lookup index from every source: the ADS-B region sweep, plus SFDPS and other
    /// facilities' already-correlated tracks.
    ///
    /// <para>They are merged into ONE index rather than consulted as a second matching path, so
    /// that every tier, every gate, the decline-on-ambiguity rule and the non-discrete beacon
    /// rule apply to the new candidates unchanged. A parallel matcher would be a second set of
    /// thresholds to keep in step with the first, and the ambiguity rule in particular only works
    /// if all candidates are in the same bucket — two sources each finding one "unique" match is
    /// exactly the coin flip that rule exists to refuse.</para>
    /// </summary>
    private void RebuildIndex()
    {
        var adsb = _adsbSet;
        var swim = _swim.Candidates();

        var byHex = new Dictionary<string, AdsbFiAircraft>(StringComparer.OrdinalIgnoreCase);
        var bySquawk = new Dictionary<string, List<AdsbFiAircraft>>(StringComparer.Ordinal);
        var byCallsign = new Dictionary<string, AdsbFiAircraft>(StringComparer.OrdinalIgnoreCase);
        var byCell = new Dictionary<(int, int), List<AdsbFiAircraft>>();

        // SWIM goes in AFTER ADS-B so that it wins a Mode S collision. Both are the same
        // aircraft; the difference is the name. ADS-B carries the pilot-entered flight id, which
        // is blank or malformed often enough to matter, while SFDPS carries the callsign ATC is
        // actually working — and this readout exists to answer "who is that" on a radar scope.
        foreach (var ac in adsb.Concat(swim))
        {
            if (!string.IsNullOrEmpty(ac.Hex)) byHex[ac.Hex] = ac;

            if (ac.Lat.HasValue && ac.Lon.HasValue)
            {
                var cell = Cell(ac.Lat.Value, ac.Lon.Value);
                if (!byCell.TryGetValue(cell, out var bucket)) byCell[cell] = bucket = [];
                bucket.Add(ac);
            }

            if (!string.IsNullOrEmpty(ac.Squawk))
            {
                if (!bySquawk.TryGetValue(ac.Squawk, out var list)) bySquawk[ac.Squawk] = list = [];
                list.Add(ac);
            }

            var cs = ac.TrimmedCallsign;
            if (!string.IsNullOrEmpty(cs)) byCallsign[cs] = ac;
        }

        _regionIndex = new AircraftIndex(byHex, bySquawk, byCallsign, byCell);
    }

    /// <summary>
    /// Match all pending tracks against the combined regional index.
    /// Priority: hex (Mode S 24-bit) → callsign → squawk.
    /// </summary>
    /// <param name="allowHexLookups">
    /// Whether this pass may spend rate-limited HTTP on per-hex lookups. True only on the slow
    /// (region-refresh) cadence; the fast matching pass is index-only and must stay free.
    /// </param>
    private async Task ProcessAllPendingAsync(bool allowHexLookups, CancellationToken ct)
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
                    Interlocked.Increment(ref _matchHex);
                    CountSource(aircraft);
                    await PublishEnrichmentAsync(key, track, aircraft, ct);
                }
                else
                {
                    // Not in any region - queue for individual API lookup
                    msRemaining.Add((key, track));
                }
            }
            else if (BeaconCodes.IsDiscrete(track.Squawk))
            {
                // Priority 2: a DISCRETE beacon code, plus a relaxed position/altitude gate.
                // The code already identifies one aircraft, so the gate only has to rule out a
                // coincidence — hence the wider thresholds.
                if (index.BySquawk.TryGetValue(track.Squawk!, out var candidates))
                    aircraft = ClosestWithin(candidates, track,
                        _options.PositionProximityNm, _options.AltitudeProximityFeet);

                if (aircraft is not null)
                {
                    matchCount++;
                    Interlocked.Increment(ref _matchSquawk);
                    CountSource(aircraft);
                    await PublishEnrichmentAsync(key, track, aircraft, ct);
                }
            }
            else
            {
                // Priority 3: position and altitude ALONE, on a tight gate.
                //
                // This is the tier SWIM actually needs. TAIS publishes no Mode S code for most
                // tracks, and a non-discrete code is worthless for correlation, so without this
                // those tracks were never enriched at all. The thresholds are deliberately much
                // tighter than the squawk tier's (1.5 NM / 500 ft vs 5 NM / 1000 ft): nothing
                // corroborates the match except the geometry, so the geometry has to be
                // unambiguous. A match is also rejected outright if a SECOND candidate is inside
                // the same gate — with no tiebreaker available, "closest wins" is a guess, and a
                // wrong callsign is worse than none.
                // Split "nothing nearby at all" from "nearby but outside the gate", because the
                // two have opposite fixes and a single no-candidate count cannot tell them apart.
                // The 3x3 cell neighbourhood is ~90 NM, so an empty one means the ADS-B region
                // set simply does not cover this facility — widening coverage is the answer, and
                // loosening the gate would do nothing. A non-empty one that still fails the
                // 1.5 NM / 500 ft gate is a real near-miss and is about the gate.
                var neighbourhood = Nearby(index.ByCell,
                    track.Position.Latitude, track.Position.Longitude).ToList();
                var near = WithinGate(neighbourhood, track,
                    PositionOnlyMatchNm, PositionOnlyAltitudeFeet);
                aircraft = near.Count == 1 ? near[0] : null;

                if (aircraft is not null)
                {
                    matchCount++;
                    Interlocked.Increment(ref _matchPosition);
                    CountSource(aircraft);
                    await PublishEnrichmentAsync(key, track, aircraft, ct);
                }
                else if (neighbourhood.Count == 0) Interlocked.Increment(ref _posNoCoverage);
                else if (near.Count == 0) Interlocked.Increment(ref _posNoCandidate);
                else Interlocked.Increment(ref _posAmbiguous);
            }
        }

        // Individual hex lookups for Mode S keys the regional index didn't hold. These are
        // rate-limited HTTP (up to 50 x 1.1 s), so they run ONLY on the slow cadence — the fast
        // matching pass must not multiply them by six. Anything left over goes back on the queue
        // rather than being dropped: ProcessAllPendingAsync removed these keys from _pendingWork
        // on the way in, so skipping them silently would lose the track entirely.
        if (!allowHexLookups)
        {
            foreach (var (key, track) in msRemaining)
                _pendingWork.TryAdd(key, track);
            return;
        }

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

    // Position-only gate. Tighter than the squawk tier on purpose — see the Priority 3 comment.
    /// <summary>Attribute a match to the source that supplied the candidate, not the tier that
    /// matched it — the two answer different questions (see Stats).</summary>
    private void CountSource(AdsbFiAircraft ac)
    {
        switch (ac.SyntheticSource)
        {
            case "sfdps": Interlocked.Increment(ref _srcSfdps); break;
            case "tais": Interlocked.Increment(ref _srcTais); break;
            default: Interlocked.Increment(ref _srcAdsb); break;
        }
    }

    private const double PositionOnlyMatchNm = 1.5;
    private const int PositionOnlyAltitudeFeet = 500;

    /// <summary>
    /// Everything inside the position/altitude gate, nearest first.
    ///
    /// TAIS reports altitude 0 to mean "no Mode-C data" (a primary-only return), NOT ground
    /// level, so the altitude test is skipped for those rather than comparing against 0 and
    /// rejecting every airborne candidate.
    /// </summary>
    private static List<AdsbFiAircraft> WithinGate(
        IEnumerable<AdsbFiAircraft> candidates, TrackPositionEvent track, double nm, int feet)
    {
        var hasAltitude = track.AltitudeFeet.HasValue && track.AltitudeFeet.Value > 0;
        return candidates
            .Where(ac =>
                // A tagged track from the SAME facility is not independent evidence — it is this
                // facility's own radar picture, so a hit means two of its tracks are within the
                // gate of each other, which is a duplicate or a genuinely different aeroplane,
                // never a correlation. The value of the TAIS source is specifically the
                // NEIGHBOURING facility that has already identified the same target.
                !(ac.SyntheticFacility is { } sf && sf == track.Facility) &&
                ac.Lat.HasValue && ac.Lon.HasValue &&
                GeoDistanceNm(track.Position.Latitude, track.Position.Longitude,
                    ac.Lat.Value, ac.Lon.Value) <= nm &&
                (!hasAltitude || (ac.ParsedAltBaro.HasValue &&
                    Math.Abs(ac.ParsedAltBaro.Value - track.AltitudeFeet!.Value) <= feet)))
            .OrderBy(ac => GeoDistanceNm(
                track.Position.Latitude, track.Position.Longitude,
                ac.Lat!.Value, ac.Lon!.Value))
            .ToList();
    }

    /// <summary>Nearest candidate inside the gate, or null. For tiers where an identifier
    /// (hex or discrete beacon code) has already narrowed the field.</summary>
    private AdsbFiAircraft? ClosestWithin(
        IEnumerable<AdsbFiAircraft> candidates, TrackPositionEvent track, double nm, int feet)
        => WithinGate(candidates, track, nm, feet).FirstOrDefault();

    /// <summary>
    /// The single candidate inside the gate — null if there are none OR more than one.
    ///
    /// Used only by the position-only tier, where nothing but the geometry supports the match.
    /// With two aircraft in the box there is no tiebreaker, so taking the closer one is a coin
    /// flip that produces a confidently-wrong callsign; returning null leaves the track
    /// untagged, which is the honest answer and what a controller can see is happening.
    /// </summary>
    private static AdsbFiAircraft? SoleCandidateWithin(
        IEnumerable<AdsbFiAircraft> candidates, TrackPositionEvent track, double nm, int feet)
    {
        var hits = WithinGate(candidates, track, nm, feet);
        return hits.Count == 1 ? hits[0] : null;
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
            Interlocked.Increment(ref _skippedDuplicate);
            _logger.LogDebug("Skipping enrichment for {Key}: callsign {Callsign} already in use",
                enrichKey, aircraft.TrimmedCallsign);
            return;
        }

        // Two different cases, and they must not be conflated:
        //
        //   LADD (a Mode S target TAIS gives no callsign for) — it HAS a flight
        //   plan, so the callsign is flight-plan data and goes on line 1 as usual.
        //
        //   Uncorrelated target (no Mode S) — it has NO flight plan. The callsign is
        //   a property of the radar target, revealed by holding F1, so it travels as
        //   AdsbCallsign for the adapter to put on the track update. It is also
        //   mirrored into Scratchpad1, which is what you see if you click the target
        //   up to an FDB.
        //
        // Callsign and AssignedSquawk stay NULL in that second case. Both used to be
        // set, and each had its own visible consequence:
        //
        //   Callsign = track.Squawk made the beacon code the scope's dedup key.
        //   dedupByCallsign only applies its "many aircraft share 1200" co-location
        //   escape to keys it built itself (prefix "SQ:"), so a literal "1200"
        //   arriving as a callsign read as a unique aircraft id and every VFR 1200
        //   target in the facility collapsed onto one. Leaving it null lets the
        //   client derive "SQ:1200" and correctly refuse to merge them. Nothing is
        //   lost on the display: line 1 falls through to the track's own squawk.
        //
        //   AssignedSquawk = the callsign put a callsign in a beacon-code field, so
        //   FDB line 3's assigned-vs-received mismatch test rendered "1200 N98RR".
        //   An uncorrelated target has no assigned code; null is the truth.
        var fpEvent = new FlightPlanDataEvent
        {
            Timestamp = DateTime.UtcNow,
            Source = "ADSB_ENRICH",
            Callsign = isModeSTarget ? aircraft.TrimmedCallsign : null,
            AdsbCallsign = isModeSTarget ? null : aircraft.TrimmedCallsign,
            ModeSCode = effectiveModeSCode,
            TrackNumber = isModeSTarget ? null : track.TrackNumber,
            AircraftType = aircraft.AircraftType,
            WakeCategory = RecatLookup.GetCategory(aircraft.AircraftType),
            AssignedSquawk = isModeSTarget ? track.Squawk : null,
            Scratchpad1 = isModeSTarget ? null : aircraft.TrimmedCallsign,
            Facility = track.Facility
        };

        await _eventBus.PublishAsync(fpEvent, ct);
        Interlocked.Increment(ref _published);
        _lastMatch = DateTime.UtcNow;

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
        Dictionary<string, AdsbFiAircraft> ByCallsign,
        Dictionary<(int, int), List<AdsbFiAircraft>> ByCell);

    // ── Spatial bucketing for the position-only tier ────────────────────────────────────
    //
    // That tier has no identifier to narrow the field, so without an index it would test every
    // ADS-B target in the regional set against every unmatched track — several thousand times a
    // few hundred, every cycle, on a box where CPU is the scarce resource (see CLAUDE.md on the
    // Pi's co-tenants). Bucketing by half a degree reduces it to the 3x3 neighbourhood.
    //
    // CELL_DEG must stay comfortably larger than the gate: 0.5 deg is ~30 NM of latitude against
    // a 1.5 NM gate, so a target within range of a track is always in that track's cell or one
    // adjacent to it, and the 3x3 search cannot miss a candidate near a cell boundary.
    private const double CellDeg = 0.5;

    private static (int, int) Cell(double lat, double lon) =>
        ((int)Math.Floor(lat / CellDeg), (int)Math.Floor(lon / CellDeg));

    /// <summary>Every target in the 3x3 cell neighbourhood of a position.</summary>
    private static IEnumerable<AdsbFiAircraft> Nearby(
        Dictionary<(int, int), List<AdsbFiAircraft>> byCell, double lat, double lon)
    {
        var (cy, cx) = Cell(lat, lon);
        for (var dy = -1; dy <= 1; dy++)
            for (var dx = -1; dx <= 1; dx++)
                if (byCell.TryGetValue((cy + dy, cx + dx), out var bucket))
                    foreach (var ac in bucket)
                        yield return ac;
    }
}
