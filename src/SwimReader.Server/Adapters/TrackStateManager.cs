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
    private readonly TimeSpan _staleTimeout = TimeSpan.FromMinutes(5);

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

        target.LastSeen = DateTime.UtcNow;
        target.Facility ??= facility;
        return target.TrackGuid;
    }

    /// <summary>
    /// Get or create a stable flight plan GUID and associate it with the track.
    /// </summary>
    public Guid GetFlightPlanGuid(int? modeSCode, string? trackNumber, string? callsign, string? facility)
    {
        var key = BuildTrackKey(modeSCode, trackNumber, facility);
        var target = _targets.GetOrAdd(key, _ => new TrackedTarget { TrackGuid = Guid.NewGuid() });

        if (target.FlightPlanGuid == Guid.Empty)
        {
            target.FlightPlanGuid = Guid.NewGuid();
            _logger.LogDebug("New flight plan for {Key} -> {Guid}", key, target.FlightPlanGuid);
        }

        target.LastSeen = DateTime.UtcNow;
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
            if (kvp.Value.LastSeen < cutoff)
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
        var key = $"MS:{modeSCode:X6}";
        return _targets.ContainsKey(key);
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

    private static string BuildTrackKey(int? modeSCode, string? trackNumber, string? facility)
    {
        // Prefer Mode S code as it's globally unique
        if (modeSCode.HasValue && modeSCode.Value > 0)
            return $"MS:{modeSCode.Value:X6}";

        // Fall back to facility + track number
        return $"TN:{facility ?? "UNK"}:{trackNumber ?? "0"}";
    }

    private sealed class TrackedTarget
    {
        public Guid TrackGuid { get; set; }
        public Guid FlightPlanGuid { get; set; }
        public string? Callsign { get; set; }
        public string? Facility { get; set; }
        public DateTime LastSeen { get; set; } = DateTime.UtcNow;
    }
}
