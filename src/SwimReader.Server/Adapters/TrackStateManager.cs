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
            var t = new TrackedTarget { TrackGuid = Guid.NewGuid() };
            _logger.LogDebug("New track {Key} -> {Guid}", key, t.TrackGuid);
            return t;
        });

        target.LastSeen = DateTime.UtcNow;
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
    /// Remove stale targets and return deletion updates for purged entries.
    /// </summary>
    public IReadOnlyList<Guid> PurgeStale()
    {
        var cutoff = DateTime.UtcNow - _staleTimeout;
        var deletions = new List<Guid>();

        foreach (var kvp in _targets)
        {
            if (kvp.Value.LastSeen < cutoff)
            {
                if (_targets.TryRemove(kvp.Key, out var target))
                {
                    deletions.Add(target.TrackGuid);
                    if (target.FlightPlanGuid != Guid.Empty)
                        deletions.Add(target.FlightPlanGuid);

                    _logger.LogDebug("Purged stale target {Key}", kvp.Key);
                }
            }
        }

        return deletions;
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
        public DateTime LastSeen { get; set; } = DateTime.UtcNow;
    }
}
