using System.Collections.Concurrent;
using Microsoft.Extensions.Logging;

namespace SwimReader.Server.Adapters;

/// <summary>
/// Manages GUID assignment and track/flight-plan association.
/// SWIM data identifies targets by Mode S code, track number, and callsign.
/// DGScope identifies them by GUID. This class maintains the mapping.
/// </summary>
public sealed class TrackStateManager
{
    private readonly ConcurrentDictionary<string, TrackedTarget> _targets = new();
    private readonly ILogger<TrackStateManager> _logger;
    // 45 s matches SwimServer's TaisBridge purge. TAIS reassigns ("churns") track
    // numbers for the same aircraft over time; a long timeout lets each aircraft's
    // recent track numbers pile up as duplicates. Also > the client/DGScope 30 s
    // LostTargetSeconds, so a track is hidden client-side before the server drops it.
    private readonly TimeSpan _staleTimeout = TimeSpan.FromSeconds(45);

    public TrackStateManager(ILogger<TrackStateManager> logger)
    {
        _logger = logger;
    }

    /// <summary>
    /// Get or create a stable track GUID for a target identified by Mode S code and/or track number.
    /// </summary>
    public Guid GetTrackGuid(int? modeSCode, string? trackNumber, string? facility)
    {
        var key = BuildTrackKey(modeSCode, trackNumber, facility);
        var target = _targets.GetOrAdd(key, _ =>
        {
            var t = new TrackedTarget { TrackGuid = Guid.NewGuid(), Facility = facility };
            _logger.LogDebug("New track {Key} -> {Guid}", key, t.TrackGuid);
            return t;
        });

        // GetTrackGuid is the POSITION path (called from ConvertTrack). Stamp the
        // position time so purge can drop tracks whose position has gone stale even
        // if flight-plan/enrichment messages keep refreshing LastSeen — otherwise a
        // departed aircraft lingers as a position-frozen, callsign-shedding ghost.
        var now = DateTime.UtcNow;
        target.LastSeen = now;
        target.LastPositionTime = now;
        target.Facility ??= facility;
        if (modeSCode.HasValue && modeSCode.Value > 0) target.ModeSCode = modeSCode;
        return target.TrackGuid;
    }

    /// <summary>
    /// Get or create a stable flight plan GUID and associate it with the track.
    /// </summary>
    public Guid GetFlightPlanGuid(int? modeSCode, string? trackNumber, string? callsign, string? facility)
    {
        var key = BuildTrackKey(modeSCode, trackNumber, facility);
        var target = _targets.GetOrAdd(key, _ => new TrackedTarget { TrackGuid = Guid.NewGuid(), Facility = facility });

        if (target.FlightPlanGuid == Guid.Empty)
        {
            target.FlightPlanGuid = Guid.NewGuid();
            _logger.LogDebug("New flight plan for {Key} -> {Guid}", key, target.FlightPlanGuid);
        }

        target.LastSeen = DateTime.UtcNow;
        // Make sure Facility is set even if the target was first created via
        // GetFlightPlanGuid before GetTrackGuid ever fired (FP-only targets).
        // Without this, target.Facility stayed null and PurgeStale emitted
        // UT=2 with facility=null, which fell through to the untracked
        // Broadcast(json, null) fan-out — bypassing the per-client filter
        // and sending phantom deletes to every connected scope.
        target.Facility ??= facility;
        target.Callsign = callsign ?? target.Callsign;
        return target.FlightPlanGuid;
    }

    /// <summary>
    /// Get the associated track GUID for a flight plan target.
    /// </summary>
    public Guid? GetAssociatedTrackGuid(int? modeSCode, string? trackNumber, string? facility)
    {
        var key = BuildTrackKey(modeSCode, trackNumber, facility);
        return _targets.TryGetValue(key, out var target) ? target.TrackGuid : null;
    }

    /// <summary>
    /// Remove stale targets and return deletion updates (guid + facility) for purged entries.
    /// </summary>
    public IReadOnlyList<(Guid Guid, string? Facility)> PurgeStale()
    {
        var cutoff = DateTime.UtcNow - _staleTimeout;
        var deletions = new List<(Guid, string?)>();

        foreach (var kvp in _targets)
        {
            // A target that has EVER had a position is purged on position staleness
            // (so FP/enrichment can't keep a frozen ghost alive); a flight-plan-only
            // target (never positioned) falls back to message staleness.
            var t = kvp.Value;
            var stale = t.LastPositionTime != default
                ? t.LastPositionTime < cutoff
                : t.LastSeen < cutoff;
            if (stale)
            {
                if (_targets.TryRemove(kvp.Key, out var target))
                {
                    deletions.Add((target.TrackGuid, target.Facility));
                    if (target.FlightPlanGuid != Guid.Empty)
                        deletions.Add((target.FlightPlanGuid, target.Facility));

                    _logger.LogDebug("Purged stale target {Key}", kvp.Key);
                }
            }
        }

        return deletions;
    }

    /// <summary>
    /// Check if a target with the given Mode S code is already being tracked.
    /// Used by military injection to avoid duplicating TAIS targets.
    /// </summary>
    public bool HasTrack(int modeSCode)
    {
        // Tracks are keyed by track number now, so match on the stored Mode S
        // field (set from each track's acAddress) rather than an "MS:" key.
        return _targets.Values.Any(t => t.ModeSCode == modeSCode);
    }

    /// <summary>
    /// Check if a tracked target in the same facility already has the given callsign.
    /// Used by enrichment to avoid creating duplicate entries when TAIS
    /// already has a correlated flight plan for the same callsign.
    /// Facility-scoped to avoid cross-facility false positives (e.g., same flight
    /// tracked by both PCT and ILM STARS systems).
    /// </summary>
    public bool HasCallsign(string callsign, string? facility)
    {
        return _targets.Values.Any(t =>
            string.Equals(t.Callsign, callsign, StringComparison.OrdinalIgnoreCase) &&
            (facility is null || string.Equals(t.Facility, facility, StringComparison.OrdinalIgnoreCase)));
    }

    public int ActiveTrackCount => _targets.Count;

    /// <summary>Export the GUID mappings for persistence (survives restarts so
    /// fresh positions re-associate with the saved flight plans).</summary>
    public List<PersistedTarget> ExportTargets()
    {
        var list = new List<PersistedTarget>(_targets.Count);
        foreach (var kv in _targets)
            list.Add(new PersistedTarget
            {
                Key = kv.Key,
                TrackGuid = kv.Value.TrackGuid,
                FlightPlanGuid = kv.Value.FlightPlanGuid,
                Callsign = kv.Value.Callsign,
                Facility = kv.Value.Facility,
                LastSeen = kv.Value.LastSeen,
                LastPositionTime = kv.Value.LastPositionTime,
            });
        return list;
    }

    /// <summary>Restore GUID mappings seen at-or-after <paramref name="cutoff"/>.
    /// Returns the set of restored GUIDs (track + flight plan) so the adapter can
    /// restore only matching cache entries.</summary>
    public HashSet<Guid> ImportTargets(IEnumerable<PersistedTarget> targets, DateTime cutoff)
    {
        var live = new HashSet<Guid>();
        foreach (var t in targets)
        {
            // Only restore targets with a FRESH position (or fresh message if never
            // positioned) — never re-seed position-frozen ghosts across restarts.
            var fresh = t.LastPositionTime != default
                ? t.LastPositionTime >= cutoff
                : t.LastSeen >= cutoff;
            if (!fresh) continue;
            _targets[t.Key] = new TrackedTarget
            {
                TrackGuid = t.TrackGuid,
                FlightPlanGuid = t.FlightPlanGuid,
                Callsign = t.Callsign,
                Facility = t.Facility,
                LastSeen = t.LastSeen,
                LastPositionTime = t.LastPositionTime,
            };
            live.Add(t.TrackGuid);
            if (t.FlightPlanGuid != Guid.Empty) live.Add(t.FlightPlanGuid);
        }
        return live;
    }

    private static string BuildTrackKey(int? modeSCode, string? trackNumber, string? facility)
    {
        // Key by the per-facility TAIS track number first — it's the stable
        // identifier the source uses (matches SwimServer's TaisBridge, which keys
        // purely by trackNum). Preferring Mode S split one aircraft into TWO GUIDs
        // whenever its messages inconsistently carried the Mode S address, and the
        // no-flight-plan twin rendered as a callsign-less duplicate track.
        if (!string.IsNullOrEmpty(trackNumber))
            return $"TN:{facility ?? "UNK"}:{trackNumber}";

        // Fall back to Mode S (e.g. ADS-B injected tracks carry no track number).
        if (modeSCode.HasValue && modeSCode.Value > 0)
            return $"MS:{modeSCode.Value:X6}";

        return $"TN:{facility ?? "UNK"}:0";
    }

    private sealed class TrackedTarget
    {
        public Guid TrackGuid { get; set; }
        public Guid FlightPlanGuid { get; set; }
        public string? Callsign { get; set; }
        public string? Facility { get; set; }
        public int? ModeSCode { get; set; }               // stored for injection dedup (key is trackNum)
        public DateTime LastPositionTime { get; set; }   // last actual position fix (not FP/enrichment)
        public DateTime LastSeen { get; set; } = DateTime.UtcNow;
    }
}
