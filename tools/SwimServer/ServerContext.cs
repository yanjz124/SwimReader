using System.Collections.Concurrent;
using System.Text.Json;

namespace SwimServer;

/// <summary>
/// Shared references passed to route registration classes so endpoint lambdas can
/// close over Program.cs's top-level state without requiring partial classes or
/// global variables. All fields are reference-typed and the same instances live in
/// Program.cs — mutations made there are visible to extracted route handlers.
///
/// Mutable scalars (like nasrData, which is reassigned after async load) are exposed
/// through accessor delegates so the routes always read the current value.
/// </summary>
class ServerContext
{
    // ── Core in-memory state (shared references) ────────────────────────────
    public required ConcurrentDictionary<string, FlightState> Flights { get; init; }
    public required ConcurrentDictionary<string, WsClient> Clients { get; init; }
    public required GlobalStats Stats { get; init; }
    public required JsonSerializerOptions JsonOpts { get; init; }

    // SFDPS dirty-batch set
    public required ConcurrentDictionary<string, byte> Dirty { get; init; }

    // XML element discovery / debug stores
    public required ConcurrentDictionary<string, long> XmlElements { get; init; }
    public required ConcurrentDictionary<string, string> XmlSampleStore { get; init; }
    public required ConcurrentDictionary<string, long> NameValueKeys { get; init; }
    public required ConcurrentQueue<string> ClearanceLog { get; init; }
    public required ConcurrentQueue<string> AltitudeLog { get; init; }
    public required ConcurrentDictionary<string, long> StddsMessageCounts { get; init; }
    public required ConcurrentDictionary<string, string> StddsSamples { get; init; }

    // ── Bridges & long-lived services ───────────────────────────────────────
    public required AsdexBridge Asdex { get; init; }
    public required TdlsBridge Tdls { get; init; }
    public required TaisBridge Tais { get; init; }
    public required TfmsBridge Tfms { get; init; }
    public required ItwsBridge Itws { get; init; }
    public required StarsBridge Stars { get; init; }
    public required ReplayRecorder EramRecorder { get; init; }
    public required ReplayServer ReplayServer { get; init; }
    public required SectorTracker SectorTracker { get; init; }
    public required AirspaceBridge Airspace { get; init; }
    public required NexradStations NexradStations { get; init; }

    // ── Filesystem paths ────────────────────────────────────────────────────
    public required string WebRootPath { get; init; }
    public required string HistoryDir { get; init; }
    public required string TdlsHistoryDir { get; init; }
    public required string RepoRoot { get; init; }

    // ── ASDE-X scratchpad / vNAS rules ──────────────────────────────────────
    public required ConcurrentDictionary<string, ConcurrentDictionary<string, string>> GateCodes { get; init; }
    public required ConcurrentDictionary<string, List<KeyValuePair<string, string>>> VnasFixRules { get; init; }
    // ARTCC ERAM sector → controller frequency (MHz string, e.g. "133.725"), keyed "FAC/SECTOR" (from vNAS).
    public required ConcurrentDictionary<string, string> SectorFreqs { get; init; }
    // SFDPS controlling-facility NAS code → real TRACON id, keyed "ARTCC/starsId" (e.g. "ZAU/ORT" → "C90").
    public required ConcurrentDictionary<string, string> TraconIds { get; init; }

    // ── NASR (mutable: assigned after async load) ───────────────────────────
    public required Func<NasrData?> GetNasr { get; init; }
    public required ConcurrentDictionary<string, List<double[]>> RouteCache { get; init; }

    // ── Helpers / callbacks ─────────────────────────────────────────────────
    public required Action<WsClient> SendSnapshot { get; init; }
    public required Action SaveGateCodes { get; init; }
    public required Func<string, NavPoint?, NasrData, NavPoint?> LookupPoint { get; init; }
    public required Func<string, NasrData, NavPoint?> LookupAirport { get; init; }
    public required Func<string, string?, string?, NasrData, List<double[]>> ResolveRoute { get; init; }

    // Shared NEXRAD HTTP client (created once in Program.cs)
    public required HttpClient NexradHttp { get; init; }
}
