using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace SwimReader.Server.Adapters;

/// <summary>
/// On restart the STDDS feed re-sends positions within seconds, but flight-plan
/// data (callsign, owner, scratchpads, handoff) only arrives on change — so
/// without persistence tracks sit "bald" for a long time. This serializes the
/// dStars track + flight-plan state to disk (periodically and on shutdown) and
/// restores it on startup BEFORE Solace data flows, so a restarted server serves
/// full prior state on the connect snapshot. The TrackStateManager GUID mappings
/// are persisted too, so fresh positions re-associate with the saved flight plans.
/// </summary>
public sealed class PersistedState
{
    public DateTime SavedAt { get; set; }
    public List<PersistedTarget> Targets { get; set; } = new();
    public Dictionary<string, string> LastTrackJson { get; set; } = new();          // guid -> track JSON
    public Dictionary<string, string> LastFpJson { get; set; } = new();             // guid -> flight-plan JSON
    public Dictionary<string, List<string>> FacilityTracks { get; set; } = new();   // facility -> track guids
    public Dictionary<string, List<string>> FacilityFlightPlans { get; set; } = new();
    public Dictionary<string, string> EnrichedCallsigns { get; set; } = new();
    public List<string> TaisHasCallsign { get; set; } = new();
    public Dictionary<string, List<DstarsGeoPoint>> TrackHistory { get; set; } = new();
}

public sealed class PersistedTarget
{
    public string Key { get; set; } = "";
    public Guid TrackGuid { get; set; }
    public Guid FlightPlanGuid { get; set; }
    public string? Callsign { get; set; }
    public string? Facility { get; set; }
    public DateTime LastSeen { get; set; }
    public DateTime LastPositionTime { get; set; }
}

public static class DgScopePersistence
{
    private static readonly JsonSerializerOptions Json = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    // Discard the whole cache if it predates this (a long outage → everything
    // stale). Within the window, per-target staleness is filtered on import.
    private static readonly TimeSpan MaxAge = TimeSpan.FromMinutes(60);
    private static readonly TimeSpan TargetTimeout = TimeSpan.FromSeconds(45);   // = TrackStateManager._staleTimeout

    public static string ResolvePath() =>
        Environment.GetEnvironmentVariable("DSTARS_CACHE_PATH")
        ?? Path.Combine(Directory.GetCurrentDirectory(), "dstars-cache", "state.json");

    public static void Save(TrackStateManager tsm, DgScopeAdapter adapter, string path, ILogger logger)
    {
        try
        {
            var state = new PersistedState { SavedAt = DateTime.UtcNow, Targets = tsm.ExportTargets() };
            adapter.ExportCaches(state);

            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            var tmp = path + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(state, Json));
            File.Move(tmp, path, overwrite: true);   // atomic-ish swap
            logger.LogInformation("Persisted dStars state: {Targets} targets, {Fp} flight plans, {Tr} tracks",
                state.Targets.Count, state.LastFpJson.Count, state.LastTrackJson.Count);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to persist dStars state to {Path}", path);
        }
    }

    public static void Load(TrackStateManager tsm, DgScopeAdapter adapter, string path, ILogger logger)
    {
        try
        {
            if (!File.Exists(path)) { logger.LogInformation("No dStars state cache at {Path}", path); return; }

            var state = JsonSerializer.Deserialize<PersistedState>(File.ReadAllText(path), Json);
            if (state is null) return;

            var age = DateTime.UtcNow - state.SavedAt;
            if (age > MaxAge)
            {
                logger.LogInformation("dStars state cache too old ({Age:n0} min) — ignoring", age.TotalMinutes);
                return;
            }

            var cutoff = DateTime.UtcNow - TargetTimeout;
            var live = tsm.ImportTargets(state.Targets, cutoff);
            adapter.ImportCaches(state, live);
            logger.LogInformation("Restored dStars state: {Live} live targets from {Total} saved ({Age:n0}s old)",
                live.Count, state.Targets.Count, age.TotalSeconds);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to load dStars state from {Path}", path);
        }
    }
}

/// <summary>Periodic + shutdown saver. Loading happens explicitly at startup
/// (before the host runs) so it precedes any Solace data.</summary>
public sealed class DgScopePersistenceService : BackgroundService
{
    private readonly TrackStateManager _tsm;
    private readonly DgScopeAdapter _adapter;
    private readonly ILogger<DgScopePersistenceService> _logger;
    private readonly string _path;
    private static readonly TimeSpan SaveInterval = TimeSpan.FromMinutes(1);

    public DgScopePersistenceService(TrackStateManager tsm, DgScopeAdapter adapter, ILogger<DgScopePersistenceService> logger)
    {
        _tsm = tsm;
        _adapter = adapter;
        _logger = logger;
        _path = DgScopePersistence.ResolvePath();
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(SaveInterval);
        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken))
                DgScopePersistence.Save(_tsm, _adapter, _path, _logger);
        }
        catch (OperationCanceledException) { /* shutting down */ }
    }

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        DgScopePersistence.Save(_tsm, _adapter, _path, _logger);   // final save on SIGTERM
        await base.StopAsync(cancellationToken);
    }
}
