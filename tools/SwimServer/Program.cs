using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Channels;
using System.Xml.Linq;
using SolaceSystems.Solclient.Messaging;
using SwimServer;

// ── Configuration ───────────────────────────────────────────────────────────

// Load .env file — search upward from working directory to find repo root .env
{
    var dir = new DirectoryInfo(Directory.GetCurrentDirectory());
    while (dir is not null)
    {
        var envPath = Path.Combine(dir.FullName, ".env");
        if (File.Exists(envPath))
        {
            foreach (var line in File.ReadAllLines(envPath))
            {
                var trimmed = line.Trim();
                if (string.IsNullOrEmpty(trimmed) || trimmed.StartsWith('#')) continue;
                var eq = trimmed.IndexOf('=');
                if (eq <= 0) continue;
                var key = trimmed[..eq].Trim();
                var val = trimmed[(eq + 1)..].Trim();
                if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable(key)))
                    Environment.SetEnvironmentVariable(key, val);
            }
            break;
        }
        dir = dir.Parent;
    }
}

var host = Environment.GetEnvironmentVariable("SFDPS_HOST") ?? "tcps://ems2.swim.faa.gov:55443";
var vpn = Environment.GetEnvironmentVariable("SFDPS_VPN") ?? "FDPS";
var user = Environment.GetEnvironmentVariable("SFDPS_USER") ?? "";
var pass = Environment.GetEnvironmentVariable("SFDPS_PASS") ?? "";
var queue = Environment.GetEnvironmentVariable("SFDPS_QUEUE") ?? "";

// STDDS credentials (ASDE-X / SMES)
var stddsUser  = Environment.GetEnvironmentVariable("SCDSCONNECTION__USERNAME") ?? "";
var stddsPass  = Environment.GetEnvironmentVariable("SCDSCONNECTION__PASSWORD") ?? "";
var stddsQueue = Environment.GetEnvironmentVariable("SCDSCONNECTION__QUEUENAME") ?? "";
var stddsHost  = Environment.GetEnvironmentVariable("SCDSCONNECTION__HOST") ?? "tcps://ems2.swim.faa.gov:55443";
var stddsVpn   = Environment.GetEnvironmentVariable("SCDSCONNECTION__MESSAGEVPN") ?? "STDDS";

// TFMS credentials (Traffic Flow Management)
var tfmsUser  = Environment.GetEnvironmentVariable("TFMS_USER") ?? "";
var tfmsPass  = Environment.GetEnvironmentVariable("TFMS_PASS") ?? "";
var tfmsQueue = Environment.GetEnvironmentVariable("TFMS_QUEUE") ?? "";
var tfmsHost  = Environment.GetEnvironmentVariable("TFMS_HOST") ?? "tcps://ems2.swim.faa.gov:55443";
var tfmsVpn   = Environment.GetEnvironmentVariable("TFMS_VPN") ?? "TFMS";

// ITWS credentials (Integrated Terminal Weather System)
var itwsUser  = Environment.GetEnvironmentVariable("ITWS_USER") ?? "";
var itwsPass  = Environment.GetEnvironmentVariable("ITWS_PASS") ?? "";
var itwsQueue = Environment.GetEnvironmentVariable("ITWS_QUEUE") ?? "";
var itwsHost  = Environment.GetEnvironmentVariable("ITWS_HOST") ?? "tcps://ems1.swim.faa.gov:55443";
var itwsVpn   = Environment.GetEnvironmentVariable("ITWS_VPN") ?? "ITWS";

// ── Shared state ────────────────────────────────────────────────────────────

var flights = new ConcurrentDictionary<string, FlightState>();
var clients = new ConcurrentDictionary<string, WsClient>();
var stats = new GlobalStats();
NasrData? nasrData = null;
var routeCache = new ConcurrentDictionary<string, List<double[]>>();
long _procCount = 0;
long _noGufiCount = 0;
long lastMessageTicks = DateTime.UtcNow.Ticks;
int sfdpsEverDelivered = 0;   // set once the SFDPS feed delivers its first message (gates the process-level watchdog)
int sfdpsWatchdogTripped = 0; // ensures the process-restart escalation fires at most once per process

// XML element discovery — tracks all unique element paths + attribute names seen in FIXM messages
var xmlElements = new ConcurrentDictionary<string, long>();
var xmlSampleStore = new ConcurrentDictionary<string, string>(); // source -> last raw XML sample
var nameValueKeys = new ConcurrentDictionary<string, long>(); // unique nameValue name= values

// Broadcast batching — all updates batched every 1 second, client owns the 12s scan cycle
var _dirty = new ConcurrentDictionary<string, byte>(); // GUFIs with any changes

// Debug: clearance raw XML log — captures raw XML for any message touching a clearance-bearing flight
var clearanceLog = new ConcurrentQueue<string>(); // timestamped log entries
const int MaxClearanceLogEntries = 2000;

// Debug: altitude raw XML log — captures assigned/interim altitude changes
var altitudeLog = new ConcurrentQueue<string>();
const int MaxAltitudeLogEntries = 5000;

// Investigation logger — captures ALL messages for flights with interim/clearance data.
// Run locally for 10-20 min to debug clearing issues. Output: investigation-YYYYMMDD-HHmmss.jsonl
// Uncomment these + the flush timer + shutdown flush + API endpoint + ProcessFlight logging block to enable.
// var investigationLogPath = Path.Combine(Directory.GetCurrentDirectory(), $"investigation-{DateTime.UtcNow:yyyyMMdd-HHmmss}.jsonl");
// var investigationQueue = new ConcurrentQueue<string>();
// var investigationWatched = new ConcurrentDictionary<string, byte>();
// long investigationEntryCount = 0;
// Console.WriteLine($"[INVESTIGATION] Logging interim/clearance data to: {investigationLogPath}");

// Point-out investigation logger (disabled — investigation complete, no acceptance signal in SFDPS)
// var poLogPath = Path.Combine(Directory.GetCurrentDirectory(), $"pointout-investigation-{DateTime.UtcNow:yyyyMMdd-HHmmss}.jsonl");
// var poLogQueue = new ConcurrentQueue<string>();
// long poLogCount = 0;
// var poWatched = new ConcurrentDictionary<string, byte>();
// Console.WriteLine($"[PO-INVESTIGATION] Logging to: {poLogPath}");
var jsonOpts = new JsonSerializerOptions
{
    PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    // Note: WhenWritingNull removed — null values must be transmitted so clients can
    // detect cleared fields (e.g., interimAltitude null after OH/FH clears it)
};

// Per-category disk budgets — each data type has its OWN cap, enforced independently.
// Rationale: the large binary replay recordings (eram/asdex) are pruned aggressively on a
// small cap, while the small high-value text data (flight-history, tdls-history) is retained
// much longer on generous caps. They never compete in one shared budget, so a flood of replay
// data can't evict old flight history (and vice versa). All caps overridable via env vars.
// Keeping the SwimReader footprint well under the disk size also leaves headroom for the other
// services sharing this host (e.g. vNCRCC), whose data lives outside every watched dir here and
// is therefore never touched by the budget enforcer.
long GbCap(string envVar, long defaultGb)
{
    var gb = long.TryParse(Environment.GetEnvironmentVariable(envVar), out var v) && v > 0 ? v : defaultGb;
    return gb * 1024L * 1024 * 1024;
}
var replayCapGb = GbCap("REPLAY_CAP_GB", 30);          // binary replay (eram + asdex) — pruned aggressively
var historyCapGb = GbCap("HISTORY_CAP_GB", 25);        // flight-history text — keep long (~1.4 yr at 49 MB/day)
var tdlsCapGb = GbCap("TDLS_CAP_GB", 5);               // tdls-history text — tiny, effectively unbounded
PersistenceBudget.DefineBucket("replay", replayCapGb);
PersistenceBudget.DefineBucket("flight-history", historyCapGb);
PersistenceBudget.DefineBucket("tdls-history", tdlsCapGb);
Console.WriteLine($"[BUDGET] Per-category caps (GB): replay={replayCapGb >> 30}, flight-history={historyCapGb >> 30}, tdls-history={tdlsCapGb >> 30}");

var replayDir = Path.Combine(Directory.GetCurrentDirectory(), "replay");
PersistenceBudget.Watch("replay", replayDir, "*.jsonl.gz");
// Recorders pass long.MaxValue so their internal cleanup never triggers — central enforcer owns it.
var eramRecorder = new SwimServer.ReplayRecorder(Path.Combine(replayDir, "eram"), long.MaxValue, replayDir);
var replayServer = new SwimServer.ReplayServer(replayDir, jsonOpts);

// Flight history directory (declared early so route lambdas can capture it)
var historyDir = Path.Combine(Directory.GetCurrentDirectory(), "flight-history");
PersistenceBudget.Watch("flight-history", historyDir, "*.jsonl");

// TDLS history directory
var tdlsHistoryDir = Path.Combine(Directory.GetCurrentDirectory(), "tdls-history");
PersistenceBudget.Watch("tdls-history", tdlsHistoryDir, "*.jsonl");

// ASDE-X departure gate codes: airport → pattern → abbreviation (declared early for route lambdas)
var gateCodesPath = Path.Combine(Directory.GetCurrentDirectory(), "asdex-gatecodes.json");
var gateCodes = new ConcurrentDictionary<string, ConcurrentDictionary<string, string>>();
// vNAS fix rules: ICAO airport → ordered list of (pattern, code) (auto-fetched from data-api.vnas.vatsim.net)
// Order matters — first match wins, so we preserve the API's rule ordering.
var vnasFixRules = new ConcurrentDictionary<string, List<KeyValuePair<string, string>>>();

// Initialize Solace SDK (once, before any thread or connection is created)
{
    var cfp = new ContextFactoryProperties { SolClientLogLevel = SolLogLevel.Warning };
    cfp.LogToConsoleError();
    ContextFactory.Instance.Init(cfp);
}

// ASDEX bridge — created here so routes below can reference it
var asdex = new AsdexBridge(stddsUser, stddsPass, stddsQueue, stddsHost, stddsVpn, jsonOpts);

// TDLS bridge — receives forwarded TDES messages from ASDEX bridge (shared Solace session)
var tdls = new TdlsBridge(jsonOpts) { HistoryDir = tdlsHistoryDir };
// TAIS bridge — receives forwarded TAIS messages from ASDEX bridge (shared Solace session)
var tais = new TaisBridge(jsonOpts);
// TFMS bridge — own Solace session for Traffic Flow Management data
var tfms = new TfmsBridge(tfmsUser, tfmsPass, tfmsQueue, tfmsHost, tfmsVpn, jsonOpts);
// ITWS bridge — own Solace session for terminal weather products
var itws = new ItwsBridge(itwsUser, itwsPass, itwsQueue, itwsHost, itwsVpn, jsonOpts);
itws.SetHistoryDir(Path.Combine(Directory.GetCurrentDirectory(), "itws-history"));

// STARS bridge — vNAS profile cache (no Solace; HTTP fetch from data-api.vnas.vatsim.net)
var starsHttp = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
starsHttp.DefaultRequestHeaders.UserAgent.ParseAdd("SwimReader-STARS/1.0");
var stars = new StarsBridge(starsHttp, jsonOpts);

// STDDS message telemetry — in-memory counters only, no disk I/O
// Key: "TOPIC_PREFIX/ROOT_ELEMENT" → count (e.g. "TAIS/TATrackAndFlightPlan" → 12345)
var stddsMessageCounts = new ConcurrentDictionary<string, long>();
// Keep one small XML sample per key (first seen only, capped at 2KB)
var stddsSamples = new ConcurrentDictionary<string, string>();

asdex.OnOtherMessage = (topic, body) =>
{
    tdls.ProcessMessage(topic, body);
    tais.ProcessMessage(topic, body);

    // Lightweight telemetry: extract topic prefix + root element name
    var slash = topic.IndexOf('/');
    var prefix = slash > 0 ? topic[..slash] : topic;
    string rootName = "?";
    try
    {
        // Fast root element extraction — find first '<' after XML declaration
        var lt = body.IndexOf('<');
        while (lt >= 0 && lt < body.Length - 1 && body[lt + 1] == '?')
            lt = body.IndexOf('<', lt + 1);
        if (lt >= 0)
        {
            var end = lt + 1;
            while (end < body.Length && body[end] != ' ' && body[end] != '>' && body[end] != '/' && body[end] != '\n')
                end++;
            rootName = body[(lt + 1)..end];
            // Strip namespace prefix if present (e.g. "ns2:TATrackAndFlightPlan" → "TATrackAndFlightPlan")
            var colon = rootName.IndexOf(':');
            if (colon >= 0) rootName = rootName[(colon + 1)..];
        }
    }
    catch { /* best-effort */ }

    var key = $"{prefix}/{rootName}";
    stddsMessageCounts.AddOrUpdate(key, 1, (_, v) => v + 1);

    // Store first sample (truncated to 2KB)
    if (!stddsSamples.ContainsKey(key))
        stddsSamples.TryAdd(key, body.Length > 2048 ? body[..2048] + "\n... (truncated)" : body);
};

// ── ASP.NET Core setup ──────────────────────────────────────────────────────

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.UseUrls("http://0.0.0.0:5001");
asdex.SetWebRoot(builder.Environment.WebRootPath);
asdex.SetReplayDir(Path.Combine(replayDir, "asdex"), long.MaxValue, replayDir);
var app = builder.Build();

app.UseDefaultFiles();
var contentTypes = new Microsoft.AspNetCore.StaticFiles.FileExtensionContentTypeProvider();
contentTypes.Mappings[".geojson"] = "application/geo+json";
app.UseStaticFiles(new StaticFileOptions
{
    ContentTypeProvider = contentTypes,
    OnPrepareResponse = ctx =>
    {
        // Prevent Cloudflare from caching stale static files
        ctx.Context.Response.Headers["Cache-Control"] = "no-cache";
    }
});
app.UseWebSockets();

// Locate repo root for KML overlay files (declared early so route classes can capture)
var repoRoot = FindRepoRoot(app.Environment.ContentRootPath);

// NEXRAD tile proxy HTTP client (declared early so route classes can capture)
var nexradHttp = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
nexradHttp.DefaultRequestHeaders.UserAgent.ParseAdd("SwimReader/1.0");

// SFDPS callsign / squawk indices — declared early so ServerContext can capture
// (rebuilt every 5s by csIndexTimer below). Closures over the variables read the
// current dictionary reference each call.
var csIndex = new Dictionary<string, List<FlightState>>();
var sqIndex = new Dictionary<string, List<FlightState>>();

// Build the shared ServerContext that gets passed to each route registrar.
// Helper local functions (SendSnapshot, SaveGateCodes, LookupPoint, LookupAirport,
// ResolveRoute) are forward-referenceable here because top-level local functions
// are hoisted across the entire compilation unit.
var serverCtx = new ServerContext
{
    Flights = flights,
    Clients = clients,
    Stats = stats,
    JsonOpts = jsonOpts,
    Dirty = _dirty,
    XmlElements = xmlElements,
    XmlSampleStore = xmlSampleStore,
    NameValueKeys = nameValueKeys,
    ClearanceLog = clearanceLog,
    AltitudeLog = altitudeLog,
    StddsMessageCounts = stddsMessageCounts,
    StddsSamples = stddsSamples,
    Asdex = asdex,
    Tdls = tdls,
    Tais = tais,
    Tfms = tfms,
    Itws = itws,
    Stars = stars,
    EramRecorder = eramRecorder,
    ReplayServer = replayServer,
    WebRootPath = builder.Environment.WebRootPath,
    HistoryDir = historyDir,
    TdlsHistoryDir = tdlsHistoryDir,
    RepoRoot = repoRoot,
    GateCodes = gateCodes,
    VnasFixRules = vnasFixRules,
    GetNasr = () => nasrData,
    RouteCache = routeCache,
    SendSnapshot = c => SendSnapshot(c),
    SaveGateCodes = () => SaveGateCodes(),
    LookupPoint = (ident, near, nasr) => NasrService.LookupPoint(ident, near, nasr),
    LookupAirport = (code, nasr) => NasrService.LookupAirport(code, nasr),
    ResolveRoute = (text, origin, dest, nasr) => NasrService.ResolveRoute(text, origin, dest, nasr),
    NexradHttp = nexradHttp,
};

// Reverse proxy: /dstars/* → SwimReader.Server on port 5000
DgScopeRoutes.Register(app, serverCtx);

// Static page handlers + legacy ".html → clean URL" redirects
StaticRoutes.Register(app, serverCtx);
// ASDE-X: directory + scope page + /asdex/ws/{airport} WebSocket + /api/asdex/* REST
AsdexRoutes.Register(app, serverCtx);

// TDLS: directory + airport detail + /tdls/ws/{airport} WebSocket + /api/tdls/* REST
TdlsRoutes.Register(app, serverCtx);

// TAIS: directory + facility detail + /tais/ws/{facility} WebSocket + /api/tais/* REST
TaisRoutes.Register(app, serverCtx);

// TFMS: WebSocket flight + TMI streams + /api/tfms/* REST
TfmsRoutes.Register(app, serverCtx);

// ITWS: terminal weather products page + /itws/ws WebSocket + /api/itws/* REST
ItwsRoutes.Register(app, serverCtx);

// STARS: facility picker + scope page + /api/stars/* vNAS profile REST
StarsRoutes.Register(app, serverCtx);

// ERAM: /ws snapshot/batch WebSocket + /api/event-xml + /api/flights + /api/stats
EramRoutes.Register(app, serverCtx);

// NASR data endpoints under /api/nasr/* and /api/route/{gufi}
NasrRoutes.Register(app, serverCtx);

// Debug / introspection endpoints under /api/debug/*
DebugRoutes.Register(app, serverCtx);

// NEXRAD tile proxy + METAR fetch + KML files
MiscRoutes.Register(app, serverCtx);

// (ASDE-X / TDLS / TAIS / TFMS REST endpoints are registered above by their feature routes.)

// Flight history search and retrieval
HistoryRoutes.Register(app, serverCtx);

// History symbol: matches client getSymbolChar() logic
static char GetHistSym(FlightState f)
{
    if (!string.IsNullOrEmpty(f.Callsign) && f.ReportedAltitude is <= 23000) return '\u2022'; // •
    if (!string.IsNullOrEmpty(f.Callsign)) return '\\';  // Correlated Beacon
    if (!string.IsNullOrEmpty(f.Squawk)) return '/';      // Uncorrelated Beacon
    return '+';                                             // Primary only
}

static string FindRepoRoot(string start)
{
    var dir = new DirectoryInfo(start);
    while (dir != null && !Directory.Exists(Path.Combine(dir.FullName, ".git")))
        dir = dir.Parent;
    return dir?.FullName ?? start;
}

// ── Solace connection (background) ──────────────────────────────────────────

var solaceReady = new TaskCompletionSource();

var solaceThread = new Thread(() =>
{
    try
    {
        while (true)
        {
            try
            {
                using var context = ContextFactory.Instance.CreateContext(new ContextProperties(), null);
                var sessionProps = new SessionProperties
                {
                    Host = host, VPNName = vpn, UserName = user, Password = pass,
                    ReconnectRetries = 100,
                    ReconnectRetriesWaitInMsecs = 5000,
                    SSLValidateCertificate = false
                };

                using var session = context.CreateSession(sessionProps, null,
                    (_, e) => Console.WriteLine($"[Solace] {e.Event} - {e.Info}"));

                var rc = session.Connect();
                if (rc != ReturnCode.SOLCLIENT_OK)
                {
                    Console.Error.WriteLine($"[Solace] Connect returned {rc}, retrying...");
                    solaceReady.TrySetResult();
                    Thread.Sleep(10000);
                    continue;
                }

                Console.WriteLine("[Solace] Connected to SFDPS");
                stats.Connected = true;
                Interlocked.Exchange(ref lastMessageTicks, DateTime.UtcNow.Ticks);

                var solQueue = ContextFactory.Instance.CreateQueue(queue);
                using var flow = session.CreateFlow(
                    new FlowProperties { AckMode = MessageAckMode.AutoAck }, solQueue, null,
                    (_, msgArgs) => { using var m = msgArgs.Message; ProcessMessage(m); },
                    (_, flowArgs) => Console.WriteLine($"[Flow] {flowArgs.Event} - {flowArgs.Info}"));

                flow.Start();
                Console.WriteLine("[Solace] Listening on queue");
                solaceReady.TrySetResult();

                // Self-monitor: poll for stale connection every 10s, reconnect after 90s silence
                while (true)
                {
                    Thread.Sleep(10000);
                    var silence = (DateTime.UtcNow - new DateTime(Interlocked.Read(ref lastMessageTicks), DateTimeKind.Utc)).TotalSeconds;
                    if (silence > 90)
                    {
                        Console.WriteLine($"[Solace] No messages for {silence:F0}s — connection stale, reconnecting");
                        break;
                    }
                }

                stats.Connected = false;
                // Explicit disconnect before using-block disposal
                try { session.Disconnect(); } catch (Exception ex) { Console.WriteLine($"[Solace] Disconnect: {ex.Message}"); }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[Solace] Error: {ex.Message}");
                solaceReady.TrySetResult();
            }

            Console.WriteLine("[Solace] Reconnecting in 10 seconds...");
            Thread.Sleep(10000);
        }
    }
    finally { ContextFactory.Instance.Cleanup(); }
}) { IsBackground = true, Name = "SolaceReceiver" };

// ── Flight state cache (persist across restarts) ─────────────────────────────

var cacheDir = Path.Combine(Directory.GetCurrentDirectory(), "flight-cache");
var cacheJsonOpts = new JsonSerializerOptions
{
    PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
};

FlightCacheService.Load(flights, cacheDir, cacheJsonOpts);

// ── Flight history persistence (save purged flights to daily JSONL files) ─────
// History budget: keep total disk usage under 85%. Calculated dynamically each cleanup cycle.
var historyJsonOpts = new JsonSerializerOptions
{
    PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
};

// Initialize flight pinning (server-side persistence of user-protected flights)
FlightPinService.Initialize(historyDir, historyJsonOpts);

// (Per-service cleanup removed — PersistenceBudget enforces a single shared cap.)

// Save flight cache on graceful shutdown (SIGTERM from systemd)
var lifetime = app.Services.GetRequiredService<IHostApplicationLifetime>();
lifetime.ApplicationStopping.Register(() =>
{
    Console.WriteLine("[Cache] Shutdown — saving flight state...");
    FlightCacheService.Save(flights, cacheDir, cacheJsonOpts);

    // Investigation: flush remaining log entries (uncomment with investigation logger)
    // var remaining = new List<string>();
    // while (investigationQueue.TryDequeue(out var entry)) remaining.Add(entry);
    // if (remaining.Count > 0) { try { File.AppendAllLines(investigationLogPath, remaining); } catch { } }
    // Console.WriteLine($"[INVESTIGATION] Shutdown — {Interlocked.Read(ref investigationEntryCount) + remaining.Count} total entries → {investigationLogPath}");

    // var poRemaining = new List<string>();
    // while (poLogQueue.TryDequeue(out var poEntry)) poRemaining.Add(poEntry);
    // if (poRemaining.Count > 0) { try { File.AppendAllLines(poLogPath, poRemaining); } catch { } }
    // Console.WriteLine($"[PO] Shutdown — {Interlocked.Read(ref poLogCount) + poRemaining.Count} entries → {poLogPath}");
});

// Background so a Solace receiver hung inside the SDK can't keep the process
// alive and block the watchdog's graceful restart (observed: feed dead for hours).
solaceThread.IsBackground = true;
solaceThread.Start();
asdex.Start();
tfms.Start();
itws.Start();
stars.Start();

// ── ASDE-X enrichment: merge SFDPS + TDLS flight data into surface tracks ───
// (csIndex/sqIndex declared above so ServerContext can capture; rebuilt below)
var csIndexTimer = new Timer(_ =>
{
    try
    {
        var csIdx = new Dictionary<string, List<FlightState>>();
        var sqIdx = new Dictionary<string, List<FlightState>>();
        foreach (var f in flights.Values)
        {
            if (f.FlightStatus == "CANCELLED") continue;
            if (f.Callsign is not null)
            {
                if (!csIdx.TryGetValue(f.Callsign, out var csList))
                    csIdx[f.Callsign] = csList = new List<FlightState>();
                csList.Add(f);
            }
            // Squawk index: assigned squawk is more stable (controller-assigned),
            // fallback to received squawk. Skip 1200 (VFR) and 0000.
            var sq = f.AssignedSquawk ?? f.Squawk;
            if (sq is not null && sq != "1200" && sq != "0000")
            {
                if (!sqIdx.TryGetValue(sq, out var sqList))
                    sqIdx[sq] = sqList = new List<FlightState>();
                sqList.Add(f);
            }
        }
        csIndex = csIdx;
        sqIndex = sqIdx;
    }
    catch { /* best-effort */ }
}, null, TimeSpan.Zero, TimeSpan.FromSeconds(5));

// Gate codes: load pattern→code mappings from disk on startup
try
{
    if (File.Exists(gateCodesPath))
    {
        var raw = JsonSerializer.Deserialize<Dictionary<string, Dictionary<string, string>>>(
            File.ReadAllText(gateCodesPath));
        if (raw is not null)
            foreach (var (apt, entries) in raw)
                gateCodes[apt] = new ConcurrentDictionary<string, string>(entries);
        Console.WriteLine($"[GateCodes] Loaded {gateCodes.Sum(kv => kv.Value.Count)} entries");
    }
}
catch (Exception ex) { Console.WriteLine($"[GateCodes] Load error: {ex.Message}"); }

void SaveGateCodes()
{
    try
    {
        var data = gateCodes.ToDictionary(kv => kv.Key,
            kv => kv.Value.ToDictionary(e => e.Key, e => e.Value));
        var tmp = gateCodesPath + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(data, jsonOpts));
        File.Move(tmp, gateCodesPath, overwrite: true);
    }
    catch (Exception ex) { Console.Error.WriteLine($"[GateCodes] Save error: {ex.Message}"); }
}

// Map FAA LID → ICAO code for SMES matching
string FaaToIcao(string faaLid)
{
    // Alaska = PA prefix, Hawaii = PH prefix, everything else = K prefix
    if (faaLid.Length == 3)
    {
        if (faaLid.StartsWith("A", StringComparison.OrdinalIgnoreCase) && faaLid != "ATL")
        {
            // Check known Alaska airports (ANC, ADQ, AKN, etc.)
        }
        // Hawaii: HNL → PHNL
        if (faaLid is "HNL" or "OGG" or "LIH" or "KOA" or "ITO" or "MKK" or "LNY" or "JHM" or "HNM")
            return "PH" + faaLid;
        // Alaska: ANC → PANC
        if (faaLid is "ANC" or "FAI" or "JNU" or "BET" or "SCC" or "ADQ" or "AKN" or "DLG" or "OME"
            or "OTZ" or "BRW" or "SIT" or "KTN" or "CDV" or "YAK" or "VDZ" or "MRI" or "ENA")
            return "PA" + faaLid;
        return "K" + faaLid;
    }
    // Already 4 chars — probably already ICAO
    return faaLid;
}

async Task FetchVnasFixRules()
{
    try
    {
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
        // Get list of all ARTCCs
        var artccListJson = await http.GetStringAsync("https://data-api.vnas.vatsim.net/api/artccs/");
        var artccList = JsonSerializer.Deserialize<JsonElement>(artccListJson);
        var artccIds = new List<string>();
        foreach (var artcc in artccList.EnumerateArray())
        {
            var id = artcc.GetProperty("id").GetString();
            if (id is not null) artccIds.Add(id);
        }

        Console.WriteLine($"[vNAS] Fetching fix rules from {artccIds.Count} ARTCCs...");
        int totalRules = 0, totalAirports = 0;

        // Fetch each ARTCC (parallel, throttled)
        var semaphore = new SemaphoreSlim(4);
        var tasks = artccIds.Select(async artccId =>
        {
            await semaphore.WaitAsync();
            try
            {
                var json = await http.GetStringAsync($"https://data-api.vnas.vatsim.net/api/artccs/{artccId}/");
                var doc = JsonSerializer.Deserialize<JsonElement>(json);
                var facility = doc.GetProperty("facility");
                ScanFacilityFixRules(facility, ref totalRules, ref totalAirports);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[vNAS] Error fetching {artccId}: {ex.Message}");
            }
            finally { semaphore.Release(); }
        });
        await Task.WhenAll(tasks);

        Console.WriteLine($"[vNAS] Loaded {totalRules} fix rules for {totalAirports} airports");
    }
    catch (Exception ex)
    {
        Console.Error.WriteLine($"[vNAS] Fix rules fetch failed: {ex.Message}");
    }
}

void ScanFacilityFixRules(JsonElement facility, ref int totalRules, ref int totalAirports)
{
    // Check this facility for asdexConfiguration.fixRules
    if (facility.TryGetProperty("asdexConfiguration", out var asdexConfig)
        && asdexConfig.TryGetProperty("fixRules", out var fixRulesArr)
        && fixRulesArr.GetArrayLength() > 0)
    {
        var facId = facility.GetProperty("id").GetString() ?? "";
        var icao = FaaToIcao(facId);
        var list = new List<KeyValuePair<string, string>>();
        foreach (var rule in fixRulesArr.EnumerateArray())
        {
            var pattern = rule.GetProperty("searchPattern").GetString()?.Trim().ToUpperInvariant();
            var code = rule.GetProperty("fixId").GetString()?.Trim().ToUpperInvariant();
            if (pattern is not null && code is not null && pattern.Length > 0 && code.Length > 0)
                list.Add(new(pattern, code));
        }
        if (list.Count > 0)
        {
            vnasFixRules[icao] = list;
            Interlocked.Add(ref totalRules, list.Count);
            Interlocked.Increment(ref totalAirports);
        }
    }

    // Recurse into child facilities
    if (facility.TryGetProperty("childFacilities", out var children))
    {
        foreach (var child in children.EnumerateArray())
            ScanFacilityFixRules(child, ref totalRules, ref totalAirports);
    }
}

// Fetch vNAS fix rules on startup (background) and refresh daily
_ = Task.Run(async () =>
{
    while (true)
    {
        try { await FetchVnasFixRules(); }
        catch (Exception ex) { Console.WriteLine($"[vNAS] Rule fetch error: {ex.Message}"); }
        await Task.Delay(TimeSpan.FromHours(24));
    }
});

// Match route against a pattern→code map; returns first matching code or null
string? MatchFixRules(IEnumerable<KeyValuePair<string, string>> fixRules, string[] routeTokens, HashSet<string> routeSet)
{
    foreach (var (pattern, code) in fixRules)
    {
        var patTokens = pattern.Split(new[] { ' ', '.' }, StringSplitOptions.RemoveEmptyEntries);
        var allMatch = true;
        foreach (var pt in patTokens)
        {
            var ptClean = pt.TrimEnd('#');
            if (ptClean != pt)
            {
                if (!routeSet.Contains(ptClean) && !routeTokens.Any(rt => rt.StartsWith(ptClean))) { allMatch = false; break; }
            }
            else
            {
                if (!routeSet.Contains(pt)) { allMatch = false; break; }
            }
        }
        if (allMatch) return code;
    }
    return null;
}

// Resolve departure gate code: manual gateCodes → vNAS fixRules → destination fallback
string? ResolveGateCode(string airport, string? route, string? destination)
{
    if (route is null) return null;

    var routeUpper = route.ToUpperInvariant();
    var routeTokens = routeUpper.Split(new[] { ' ', '.' }, StringSplitOptions.RemoveEmptyEntries);
    var routeSet = new HashSet<string>(routeTokens);
    foreach (var rt in routeTokens)
    {
        var stripped = rt.TrimEnd('0', '1', '2', '3', '4', '5', '6', '7', '8', '9');
        if (stripped.Length > 0 && stripped.Length != rt.Length) routeSet.Add(stripped);
    }

    // Priority 1: manual gate codes (user-configured per airport)
    if (gateCodes.TryGetValue(airport, out var manualMap) && !manualMap.IsEmpty)
    {
        var result = MatchFixRules(manualMap, routeTokens, routeSet);
        if (result is not null) return result;
    }

    // Priority 2: vNAS fix rules (auto-fetched from data-api.vnas.vatsim.net)
    if (vnasFixRules.TryGetValue(airport, out var vnasRules) && vnasRules.Count > 0)
    {
        var result = MatchFixRules(vnasRules, routeTokens, routeSet);
        if (result is not null) return result;
    }

    // Fallback: destination FAA LID (strip leading K/P for US airports)
    if (destination is null) return null;
    var dest = destination;
    if (dest.Length == 4 && (dest[0] == 'K' || dest[0] == 'P')) dest = dest[1..];
    return dest;
}

asdex.OnEnrich = (track) =>
{
    // Clear enrichment fields (re-derived each cycle)
    track.FpOrigin = null; track.FpDestination = null; track.FpStar = null; track.FpRoute = null;
    track.TdlsGate = null; track.TdlsRunway = null; track.GateCode = null;

    // Path 1: SFDPS via sfdpsGufi (direct O(1) lookup)
    FlightState? fp = null;
    if (track.SfdpsGufi is not null)
        flights.TryGetValue(track.SfdpsGufi, out fp);

    // Path 2: SFDPS via callsign (index lookup)
    // Airlines reuse callsigns for turnover legs (e.g., DAL123 ORD→IAD then IAD→DFW).
    // Disambiguate with multiple signals; prefer the leg that actually matches this airport.
    if (fp is null && track.Callsign is not null && csIndex.TryGetValue(track.Callsign, out var candidates))
    {
        bool sqMatch(FlightState f) => track.Squawk is not null
            && !string.IsNullOrEmpty(f.Squawk) && f.Squawk == track.Squawk;
        bool originMatch(FlightState f) =>
            string.Equals(f.Origin, track.Airport, StringComparison.OrdinalIgnoreCase);
        bool destMatch(FlightState f) =>
            string.Equals(f.Destination, track.Airport, StringComparison.OrdinalIgnoreCase);
        bool airportMatch(FlightState f) => originMatch(f) || destMatch(f);
        bool adDestMatch(FlightState f) => track.AdDestination is not null
            && string.Equals(f.Destination, track.AdDestination, StringComparison.OrdinalIgnoreCase);
        bool adDepMatch(FlightState f) => track.AdDeparture is not null
            && string.Equals(f.Origin, track.AdDeparture, StringComparison.OrdinalIgnoreCase);
        bool hasPosition(FlightState f) => f.Latitude != 0 && f.Longitude != 0;

        // Priority 1: squawk + airport match (origin or destination) — strongest signal
        fp = candidates.Where(f => sqMatch(f) && airportMatch(f))
                       .OrderByDescending(f => f.LastSeen).FirstOrDefault();
        // Priority 2: origin matches AND ADS-B destination matches FP destination (departure leg)
        fp ??= candidates.FirstOrDefault(f => originMatch(f) && adDestMatch(f));
        // Priority 3: destination matches AND ADS-B origin matches FP origin (arrival leg)
        fp ??= candidates.FirstOrDefault(f => destMatch(f) && adDepMatch(f));
        // Priority 4: airport matches AND flight has a live radar position (active leg)
        fp ??= candidates.Where(f => airportMatch(f) && hasPosition(f))
                         .OrderByDescending(f => f.LastSeen).FirstOrDefault();
        // Priority 5: airport matches at all (origin first, then destination)
        fp ??= candidates.Where(originMatch).OrderByDescending(f => f.LastSeen).FirstOrDefault();
        fp ??= candidates.Where(destMatch).OrderByDescending(f => f.LastSeen).FirstOrDefault();
        // Priority 6: squawk match + has live position (callsign+squawk reuse but currently flying)
        fp ??= candidates.Where(f => sqMatch(f) && hasPosition(f))
                         .OrderByDescending(f => f.LastSeen).FirstOrDefault();
        // No further fallback. A callsign-only match without airport/squawk/position context
        // is more likely wrong than right (callsign reuse for back-to-back legs). Leave fp null
        // and let TFMS/AD data fill destination — better to show no destination than the wrong one.
    }

    // Path 2a: SFDPS via squawk (beacon code index)
    // Catches tracks where callsign lookup failed or matched the wrong turnaround leg,
    // and unknown targets that only have a transponder code (no callsign from SMES).
    // Pre-departure aircraft on the ground squawk their assigned code before getting a callsign tag.
    // Squawk codes are NOT globally unique — multiple ARTCCs can assign the same code.
    // Filter by origin/destination match or geographic proximity (<200nm) to avoid cross-country false matches.
    if (fp is null && track.Squawk is not null && track.Squawk != "1200"
        && sqIndex.TryGetValue(track.Squawk, out var sqCandidates))
    {
        bool isNearby(FlightState f) =>
            f.Latitude is double flat && f.Longitude is double flon && flat != 0 &&
            NasrService.HaversineNm(track.Latitude, track.Longitude, flat, flon) < 200;
        bool matchesAirport(FlightState f) =>
            string.Equals(f.Origin, track.Airport, StringComparison.OrdinalIgnoreCase) ||
            string.Equals(f.Destination, track.Airport, StringComparison.OrdinalIgnoreCase);
        bool matchesAdDest(FlightState f) => track.AdDestination is not null
            && string.Equals(f.Destination, track.AdDestination, StringComparison.OrdinalIgnoreCase);
        bool matchesAdDep(FlightState f) => track.AdDeparture is not null
            && string.Equals(f.Origin, track.AdDeparture, StringComparison.OrdinalIgnoreCase);

        // Best: this airport AND ADS-B endpoints match (very strong signal)
        fp = sqCandidates.FirstOrDefault(f => matchesAirport(f) && (matchesAdDest(f) || matchesAdDep(f)));
        // Next: this airport matches origin or destination — pick most recent
        fp ??= sqCandidates.Where(matchesAirport).OrderByDescending(f => f.LastSeen).FirstOrDefault();
        // Fallback: nearby flight (within 200nm — same region, not across the US)
        fp ??= sqCandidates.Where(isNearby).OrderByDescending(f => f.LastSeen).FirstOrDefault();
    }

    // Apply SFDPS flight plan data
    if (fp is not null)
    {
        track.FpDestination = fp.Destination;
        track.FpOrigin = fp.Origin;
        track.FpStar = fp.STAR;
        track.FpRoute = fp.Route;
        // SFDPS aircraft type fills gaps where SMES didn't provide one
        if (track.AircraftType is null && fp.AircraftType is not null)
            track.AircraftType = fp.AircraftType;
        // If SFDPS matched via squawk, propagate callsign to ASDE-X track
        if (track.Callsign is null && fp.Callsign is not null)
            track.Callsign = fp.Callsign;
    }

    // Path 2b: TFMS via callsign (fills gaps SFDPS doesn't have — route, STAR, ETA)
    // Prefer the leg whose origin or destination matches this airport, to avoid
    // matching the wrong reused-callsign leg (e.g., RPA3477 EWR→PIT vs SFO leg).
    if (track.Callsign is not null)
    {
        var tfmsFlight = tfms.FindByCallsign(track.Callsign, track.Airport);
        if (tfmsFlight is not null)
        {
            if (track.FpDestination is null && tfmsFlight.ArrArpt is not null)
                track.FpDestination = tfmsFlight.ArrArpt;
            if (track.FpOrigin is null && tfmsFlight.DepArpt is not null)
                track.FpOrigin = tfmsFlight.DepArpt;
            if (track.FpStar is null && tfmsFlight.Star is not null)
                track.FpStar = tfmsFlight.Star;
            if (track.FpRoute is null && tfmsFlight.RouteOfFlight is not null)
                track.FpRoute = tfmsFlight.RouteOfFlight;
            // TFMS aircraft type fills gaps where SMES didn't provide one
            if (track.AircraftType is null && tfmsFlight.AircraftType is not null)
                track.AircraftType = tfmsFlight.AircraftType;
        }
    }

    // Path 3: TDLS via airport + callsign
    if (track.Callsign is not null)
    {
        var tdlsData = tdls.FindAircraft(track.Airport, track.Callsign);
        if (tdlsData.HasValue)
        {
            track.TdlsGate = tdlsData.Value.gate;
            track.TdlsRunway = tdlsData.Value.runway;
            if (track.FpDestination is null)
                track.FpDestination = tdlsData.Value.destination;
        }
    }

    // Resolve gate code: fix map match → best available destination as FAA LID
    // Uses track.FpRoute (populated from SFDPS or TFMS) so rules match regardless of data source
    track.GateCode = ResolveGateCode(track.Airport, track.FpRoute, track.FpDestination ?? track.AdDestination);
};

// Save flight cache periodically (every 5 minutes)
var cacheTimer = new Timer(_ => FlightCacheService.Save(flights, cacheDir, cacheJsonOpts), null, TimeSpan.FromMinutes(5), TimeSpan.FromMinutes(5));

// Purge stale flights every 60 seconds
var purgeTimer = new Timer(_ =>
{
    var cutoff = DateTime.UtcNow.AddMinutes(-60);
    var poCutoff = DateTime.UtcNow.AddMinutes(-3);
    foreach (var (gufi, f) in flights)
    {
        if (f.LastSeen < cutoff)
        {
            flights.TryRemove(gufi, out FlightState? _);
            eramRecorder.RecordRemove(new { gufi }, DateTime.UtcNow);
            Broadcast(new WsMsg("remove", new { gufi }));
            // Persist to daily history file before discarding
            Task.Run(() => FlightHistoryService.Save(f, historyDir, historyJsonOpts));
        }
        // Expire point-out data after 3 minutes (SFDPS doesn't send clear signals)
        // Also clear legacy data with no timestamp (e.g. from cache before this fix)
        else if ((f.PointoutOriginatingUnit is not null || f.PointoutReceivingUnit is not null)
                 && (!f.PointoutTimestamp.HasValue || f.PointoutTimestamp.Value < poCutoff))
        {
            f.PointoutOriginatingUnit = null;
            f.PointoutReceivingUnit = null;
            f.PointoutTimestamp = null;
        }
    }

    // Early-retire stale duplicate GUFIs left behind by inter-ARTCC handoffs.
    // When an aircraft crosses an ARTCC boundary it briefly exists as two GUFIs (one per
    // centre). After the handoff the old centre stops sending its GUFI, which then sits frozen
    // for the full 60 min above. If a same-callsign sibling with the SAME origin AND destination
    // is still actively updating, drop the stale one now instead of waiting.
    //
    // Safety (must satisfy ALL): (a) a fresh canonical sibling exists with a position fix < 60s
    // old; (b) the stale GUFI has had NO position fix for > 3 min; (c) identical origin AND
    // destination; (d) no active handoff on the stale GUFI. Pseudo-tracks (TFC/BLOCK/JUMP/etc.)
    // carry no origin/destination so they are never matched. Only the older duplicate is removed
    // and the live one is always kept — this can neither create a duplicate nor drop a track that
    // is still updating. Genuinely distinct flights that share a callsign are safe too: removal
    // requires one to be 3-min stale while the other is live, which never holds for two aircraft
    // that are both actually airborne and reporting.
    var nowUtc = DateTime.UtcNow;
    // 300s stale matches the client's hide window and keeps early-retire well clear of normal
    // radar gaps. (Even if a gapped real track were retired, its same-callsign sibling keeps the
    // target on screen, so no aircraft vanishes — but 300s makes that case vanishingly rare.)
    const double freshSec = 60, staleSec = 300;
    var byCallsign = new Dictionary<string, List<KeyValuePair<string, FlightState>>>(StringComparer.OrdinalIgnoreCase);
    foreach (var kv in flights)
    {
        var f = kv.Value;
        if (f.FlightStatus != "ACTIVE") continue;
        if (string.IsNullOrEmpty(f.Callsign)) continue;
        if (!f.Latitude.HasValue) continue;
        if (string.IsNullOrEmpty(f.Origin) || string.IsNullOrEmpty(f.Destination)) continue;
        if (f.LastPositionTime == default) continue;
        if (!byCallsign.TryGetValue(f.Callsign, out var lst)) byCallsign[f.Callsign] = lst = new();
        lst.Add(kv);
    }
    int retired = 0;
    foreach (var (_, group) in byCallsign)
    {
        if (group.Count < 2) continue;
        // Canonical = the GUFI with the freshest position fix.
        var fresh = group[0];
        foreach (var g in group)
            if (g.Value.LastPositionTime > fresh.Value.LastPositionTime) fresh = g;
        if ((nowUtc - fresh.Value.LastPositionTime).TotalSeconds > freshSec) continue; // no live canonical → leave to 60-min purge
        foreach (var (gufi, f) in group)
        {
            if (gufi == fresh.Key) continue;
            if ((nowUtc - f.LastPositionTime).TotalSeconds <= staleSec) continue;       // still recent → keep
            if (!string.IsNullOrEmpty(f.HandoffEvent)) continue;                        // mid-handoff → keep
            if (!string.Equals(f.Origin, fresh.Value.Origin, StringComparison.OrdinalIgnoreCase)) continue;
            if (!string.Equals(f.Destination, fresh.Value.Destination, StringComparison.OrdinalIgnoreCase)) continue;
            // Preserve per-facility CIDs: fold the stale GUFI's computer IDs into the survivor
            // (without overwriting), so viewing from the transferring ARTCC still shows its CID
            // after the duplicate is gone.
            foreach (var cidKv in f.ComputerIds)
                fresh.Value.ComputerIds.TryAdd(cidKv.Key, cidKv.Value);
            if (flights.TryRemove(gufi, out var removed))
            {
                eramRecorder.RecordRemove(new { gufi }, nowUtc);
                Broadcast(new WsMsg("remove", new { gufi }));
                Task.Run(() => FlightHistoryService.Save(removed, historyDir, historyJsonOpts));
                retired++;
            }
        }
    }
    if (retired > 0)
        Console.WriteLine($"[Purge] Early-retired {retired} stale duplicate GUFIs (inter-ARTCC handoff leftovers)");
}, null, TimeSpan.FromSeconds(60), TimeSpan.FromSeconds(60));

// Broadcast stats every 5 seconds
var statsTimer = new Timer(_ =>
{
    var fc = flights.Count;
    Console.WriteLine($"[Stats] flights={fc} proc={_procCount} nogufi={_noGufiCount}");
    Broadcast(new WsMsg("stats", stats.Snapshot(fc)));
}, null, TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(5));

// Health check — log stale connection warnings, and escalate to a process restart if the
// in-thread Solace watchdog (90s graceful reconnect) fails to recover the SFDPS feed.
// Observed failure (2026-06): the receiver thread hung inside the Solace SDK during reconnect,
// so the in-thread watchdog could not heal itself and the feed sat dead for ~37h. A clean host
// stop lets systemd (Restart=always) relaunch the process for a fresh connection.
const double SfdpsRestartSilenceSec = 240;  // ~20 missed 12s update cycles; well past the 90s in-thread reconnect
var healthTimer = new Timer(_ =>
{
    var silence = (DateTime.UtcNow - new DateTime(Interlocked.Read(ref lastMessageTicks), DateTimeKind.Utc)).TotalSeconds;
    if (silence > 60)
        Console.WriteLine($"[HEALTH] Warning: no messages for {silence:F0}s");

    // Only escalate once the feed has actually delivered at least once (avoids restart loops when
    // SFDPS never connects, e.g. bad credentials) and at most once per process.
    if (silence > SfdpsRestartSilenceSec
        && Interlocked.CompareExchange(ref sfdpsEverDelivered, 1, 1) == 1
        && Interlocked.Exchange(ref sfdpsWatchdogTripped, 1) == 0)
    {
        Console.Error.WriteLine($"[HEALTH] SFDPS feed dead for {silence:F0}s — in-thread reconnect failed; restarting process for systemd restart.");
        try { lifetime.StopApplication(); } catch { }
        // Backstop: graceful stop can hang if the Solace receiver is stuck inside
        // the SDK. Force-exit shortly after so systemd (Restart=always) always
        // relaunches with a fresh connection — this is what failed before, leaving
        // the feed dead for ~1h49m even though the watchdog had tripped.
        new Thread(() =>
        {
            Thread.Sleep(20000);
            Console.Error.WriteLine("[HEALTH] Graceful stop did not complete in 20s — hard exit.");
            Environment.Exit(1);
        }) { IsBackground = true }.Start();
    }
}, null, TimeSpan.FromSeconds(60), TimeSpan.FromSeconds(60));

// ── NASR data (background download + parse) ─────────────────────────────────
async Task LoadNasr()
{
    var newData = await NasrService.LoadAsync(nasrData);
    if (newData is not null)
    {
        nasrData = newData;
        routeCache.Clear();
    }
}

Task.Run(async () =>
{
    try { await LoadNasr(); }
    catch (Exception ex) { Console.WriteLine($"[NASR] Error: {ex.Message}"); }
});

// Check for new NASR cycle every 24 hours
var nasrTimer = new Timer(async _ =>
{
    try { await LoadNasr(); }
    catch (Exception ex) { Console.WriteLine($"[NASR] Update check error: {ex.Message}"); }
}, null, TimeSpan.FromHours(24), TimeSpan.FromHours(24));

// Batch broadcast timers — flush dirty flights to all connected clients
var batchTimer = new Timer(_ => FlushDirtyBatch(_dirty), null, TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(1));

// ASDEX: flush dirty airports every 1s, purge stale tracks every 10s
var asdexBatchTimer = new Timer(_ => asdex.FlushDirty(), null, TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(1));
var asdexPurgeTimer = new Timer(_ => asdex.PurgeStaleTracks(), null, TimeSpan.FromSeconds(10), TimeSpan.FromSeconds(10));

// TDLS: flush new messages every 1s, purge stale aircraft every 60s
var tdlsFlushTimer = new Timer(_ => tdls.FlushDirty(), null, TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(1));
var tdlsPurgeTimer = new Timer(_ => tdls.PurgeStale(), null, TimeSpan.FromSeconds(60), TimeSpan.FromSeconds(60));
var taisFlushTimer = new Timer(_ => tais.FlushDirty(), null, TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(1));
var taisPurgeTimer = new Timer(_ => tais.PurgeStaleTracks(), null, TimeSpan.FromSeconds(10), TimeSpan.FromSeconds(10));
var tfmsFlushTimer = new Timer(_ => tfms.FlushDirty(), null, TimeSpan.FromSeconds(2), TimeSpan.FromSeconds(2));
var tfmsPurgeTimer = new Timer(_ => tfms.PurgeStale(), null, TimeSpan.FromSeconds(60), TimeSpan.FromSeconds(60));
// ITWS: persist 24h time-series history to disk every 5 min (and on shutdown)
var itwsHistoryTimer = new Timer(_ => itws.SaveHistory(), null, TimeSpan.FromMinutes(5), TimeSpan.FromMinutes(5));
// Centralized disk-budget enforcement across all persisted data (replay + flight-history + tdls-history).
var budgetTimer = new Timer(_ => PersistenceBudget.Enforce(), null, TimeSpan.FromMinutes(2), TimeSpan.FromHours(1));
// Hourly pin grace-period cleanup (24h floor, 4-day soft retention).
var pinCleanupTimer = new Timer(_ => FlightPinService.CleanupExpired(), null, TimeSpan.FromMinutes(5), TimeSpan.FromHours(1));

// Replay: periodic ERAM snapshots for seek support (every 5 minutes)
var eramSnapshotTimer = new Timer(_ =>
{
    try
    {
        var now = DateTime.UtcNow;
        var summaries = flights.Values
            .Where(f => f.Latitude.HasValue && f.FlightStatus != "CANCELLED")
            .Select(f => f.ToSummary())
            .ToArray();
        if (summaries.Length > 0)
            eramRecorder.RecordSnapshot(summaries, now);
    }
    catch (Exception ex) { Console.WriteLine($"[REPLAY] ERAM snapshot error: {ex.Message}"); }
}, null, TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(5));

// Replay: periodic ASDE-X snapshots for seek support (every 2 minutes)
var asdexSnapshotTimer = new Timer(_ =>
{
    try { asdex.WriteReplaySnapshots(); }
    catch (Exception ex) { Console.WriteLine($"[REPLAY] ASDE-X snapshot error: {ex.Message}"); }
}, null, TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(2));

// Investigation: flush queued log entries to disk (uncomment with investigation logger vars)
// var investigationFlushTimer = new Timer(_ =>
// {
//     if (investigationQueue.IsEmpty) return;
//     var batch = new List<string>();
//     while (investigationQueue.TryDequeue(out var entry)) batch.Add(entry);
//     if (batch.Count > 0)
//     {
//         try
//         {
//             File.AppendAllLines(investigationLogPath, batch);
//             var total = Interlocked.Add(ref investigationEntryCount, batch.Count);
//             if (total % 1000 < batch.Count)
//                 Console.WriteLine($"[INVESTIGATION] {total} entries logged, {investigationWatched.Count} watched flights");
//         }
//         catch (Exception ex) { Console.WriteLine($"[INVESTIGATION] Write error: {ex.Message}"); }
//     }
// }, null, TimeSpan.FromSeconds(2), TimeSpan.FromSeconds(2));

// var poFlushTimer = new Timer(_ =>
// {
//     var batch = new List<string>();
//     while (poLogQueue.TryDequeue(out var entry)) batch.Add(entry);
//     if (batch.Count > 0) { try { File.AppendAllLines(poLogPath, batch); } catch { } }
// }, null, TimeSpan.FromSeconds(2), TimeSpan.FromSeconds(2));

// Prevent GC from collecting timers in Release mode — JIT considers local vars dead after last use,
// so timers silently stop firing. Registering a shutdown callback keeps them reachable.
var allTimers = new[] { cacheTimer, purgeTimer, statsTimer, healthTimer, nasrTimer, batchTimer, asdexBatchTimer, asdexPurgeTimer, tdlsFlushTimer, tdlsPurgeTimer, taisFlushTimer, taisPurgeTimer, tfmsFlushTimer, tfmsPurgeTimer, itwsHistoryTimer, budgetTimer, csIndexTimer, eramSnapshotTimer, asdexSnapshotTimer /*, poFlushTimer, investigationFlushTimer */ };
app.Lifetime.ApplicationStopping.Register(() => { foreach (var t in allTimers) t.Dispose(); eramRecorder.Dispose(); asdex.DisposeRecorders(); itws.SaveHistory(); });

// Replay endpoints (WebSocket + REST)
replayServer.MapEndpoints(app);

await solaceReady.Task;
Console.WriteLine("[Web] Starting on http://localhost:5001");
app.Run();

// ── Message processing ──────────────────────────────────────────────────────

void ProcessMessage(IMessage message)
{
    string? body = null;
    if (message.BinaryAttachment is { Length: > 0 })
        body = Encoding.UTF8.GetString(message.BinaryAttachment);
    else if (message.XmlContent is { Length: > 0 })
        body = Encoding.UTF8.GetString(message.XmlContent);

    if (body is null) return;
    stats.IncrementTotal();
    Interlocked.Exchange(ref lastMessageTicks, DateTime.UtcNow.Ticks);
    Interlocked.Exchange(ref sfdpsEverDelivered, 1);

    try
    {
        var doc = XDocument.Parse(body);
        if (doc.Root is null) return;

        foreach (var msgEl in doc.Root.Elements())
        {
            var flightEl = msgEl.Elements().FirstOrDefault(e => e.Name.LocalName == "flight");
            if (flightEl is null) continue;
            ProcessFlight(flightEl, body);
        }
    }
    catch (Exception ex) { Console.Error.WriteLine($"[Parse] {ex.GetType().Name}: {ex.Message}"); }
}

void ProcessFlight(XElement flight, string rawXml)
{
    var gufi = flight.Elements().FirstOrDefault(e => e.Name.LocalName == "gufi")?.Value;
    if (string.IsNullOrEmpty(gufi))
    {
        Interlocked.Increment(ref _noGufiCount);
        return;
    }

    Interlocked.Increment(ref _procCount);

    var source = flight.Attribute("source")?.Value ?? "";
    var centre = flight.Attribute("centre")?.Value ?? "";
    var timestamp = flight.Attribute("timestamp")?.Value;
    var flightType = flight.Attribute("flightType")?.Value;

    // XML element discovery: walk the flight element tree (first 10K messages only to minimize overhead)
    if (Interlocked.Read(ref _procCount) < 10_000)
    {
        EventSummaryBuilder.WalkElements(flight, "flight", source, xmlElements);
        xmlSampleStore[source] = rawXml;
    }

    var state = flights.GetOrAdd(gufi, _ => new FlightState { Gufi = gufi });
    state.LastSeen = DateTime.UtcNow;
    state.LastMsgSource = source;
    if (!string.IsNullOrEmpty(flightType)) state.FlightType = flightType;

    // Investigation: capture before-state (uncomment with investigation logger)
    // var prevClrH = state.ClearanceHeading;
    // var prevClrS = state.ClearanceSpeed;
    // var prevClrT = state.ClearanceText;
    // var prevRA = state.ReportedAltitude;

    // flightIdentification
    var fid = flight.Elements().FirstOrDefault(e => e.Name.LocalName == "flightIdentification");
    if (fid is not null)
    {
        var cs = fid.Attribute("aircraftIdentification")?.Value;
        if (!string.IsNullOrEmpty(cs)) state.Callsign = cs;
        var cid = fid.Attribute("computerId")?.Value;
        if (!string.IsNullOrEmpty(cid))
        {
            state.ComputerId = cid;
            // Store CID per reporting facility — each ARTCC assigns its own CID
            if (!string.IsNullOrEmpty(centre)) state.ComputerIds[centre] = cid;
        }
    }

    // flightStatus
    var fstat = flight.Elements().FirstOrDefault(e => e.Name.LocalName == "flightStatus");
    if (fstat is not null)
    {
        var s = fstat.Attribute("fdpsFlightStatus")?.Value;
        if (!string.IsNullOrEmpty(s)) state.FlightStatus = s;
    }

    // operator — <operator><operatingOrganization><organization name="FLEXJET"/>
    // SFDPS sends full company names from some ARTCCs (e.g. "JAZZ AVIATION LP", "ALASKA AIRLINES")
    // and ICAO codes from others (e.g. "JZA", "ASA"). Later FH messages can overwrite full names
    // with short codes, so keep the longer (more descriptive) value once we have it.
    var opEl = flight.Elements().FirstOrDefault(e => e.Name.LocalName == "operator");
    if (opEl is not null)
    {
        var org = opEl.Descendants().FirstOrDefault(e => e.Name.LocalName == "organization" && e.Attribute("name") is not null);
        if (org is not null)
        {
            var newOp = org.Attribute("name")!.Value;
            if (string.IsNullOrEmpty(state.Operator) || newOp.Length > state.Operator.Length)
                state.Operator = newOp;
        }
    }

    // originator (AFTN address, e.g. EKODFFLX)
    var originator = flight.Elements().FirstOrDefault(e => e.Name.LocalName == "originator");
    if (originator is not null)
    {
        var aftn = originator.Elements().FirstOrDefault(e => e.Name.LocalName == "aftnAddress")?.Value;
        if (!string.IsNullOrEmpty(aftn)) state.Originator = aftn;
    }

    // departure / arrival
    var dep = flight.Elements().FirstOrDefault(e => e.Name.LocalName == "departure");
    if (dep is not null)
    {
        var pt = dep.Attribute("departurePoint")?.Value;
        if (!string.IsNullOrEmpty(pt)) state.Origin = pt;
        var rwyPos = dep.Elements().FirstOrDefault(e => e.Name.LocalName == "runwayPositionAndTime");
        var rwyTime = rwyPos?.Elements().FirstOrDefault(e => e.Name.LocalName == "runwayTime");
        if (rwyTime is not null)
        {
            var actTime = rwyTime.Elements().FirstOrDefault(e => e.Name.LocalName == "actual")?.Attribute("time")?.Value;
            if (!string.IsNullOrEmpty(actTime)) state.ActualDepartureTime = actTime;
            // EDCT (Expected Departure Clearance Time) — assigned by GDP/CTOP/Ground Stop
            var ctlTime = rwyTime.Elements().FirstOrDefault(e => e.Name.LocalName == "controlled")?.Attribute("time")?.Value;
            state.EdctTime = string.IsNullOrEmpty(ctlTime) ? null : ctlTime;
        }
        else
        {
            // FH/AH messages without runwayPositionAndTime → keep prior values (don't clear)
        }
    }
    var arr = flight.Elements().FirstOrDefault(e => e.Name.LocalName == "arrival");
    if (arr is not null)
    {
        var pt = arr.Attribute("arrivalPoint")?.Value;
        if (!string.IsNullOrEmpty(pt)) state.Destination = pt;
        var eta = arr.Descendants().FirstOrDefault(e => e.Name.LocalName == "estimated")?.Attribute("time")?.Value;
        if (!string.IsNullOrEmpty(eta)) state.ETA = eta;
        // Alternate airport(s)
        var altns = arr.Elements().Where(e => e.Name.LocalName == "arrivalAerodromeAlternate");
        var altnCodes = new List<string>();
        foreach (var altn in altns)
        {
            var code = altn.Attribute("code")?.Value;
            if (!string.IsNullOrEmpty(code)) altnCodes.Add(code);
        }
        if (altnCodes.Count > 0) state.AlternateAerodrome = string.Join(" ", altnCodes);
    }

    // assignedAltitude — has mutually exclusive sub-types: simple, vfr, vfrPlus, block
    // HZ (heartbeat) carries reported/Mode-C altitude in this field, NOT the controller-assigned altitude.
    // Skip HZ to prevent oscillation between Mode-C and actual assigned values.
    var aa = source != "HZ" ? flight.Elements().FirstOrDefault(e => e.Name.LocalName == "assignedAltitude") : null;
    var prevAA = state.AssignedAltitude;
    var prevVfr = state.AssignedVfr;
    var prevBlkF = state.BlockFloor;
    var prevBlkC = state.BlockCeiling;
    if (aa is not null)
    {
        var simple = aa.Descendants().FirstOrDefault(e => e.Name.LocalName == "simple")?.Value;
        if (double.TryParse(simple, out var alt))
        {
            state.AssignedAltitude = alt;
            state.AssignedVfr = false;
            state.BlockFloor = null;
            state.BlockCeiling = null;
        }
        else if (aa.Elements().Any(e => e.Name.LocalName == "vfr"))
        {
            state.AssignedAltitude = null;
            state.AssignedVfr = true;
            state.BlockFloor = null;
            state.BlockCeiling = null;
        }
        else
        {
            var vfrPlus = aa.Descendants().FirstOrDefault(e => e.Name.LocalName == "vfrPlus")?.Value;
            if (double.TryParse(vfrPlus, out var vfpAlt))
            {
                state.AssignedAltitude = vfpAlt;
                state.AssignedVfr = true;
                state.BlockFloor = null;
                state.BlockCeiling = null;
            }
            else
            {
                var block = aa.Elements().FirstOrDefault(e => e.Name.LocalName == "block");
                if (block is not null)
                {
                    var above = block.Descendants().FirstOrDefault(e => e.Name.LocalName == "above")?.Value;
                    var below = block.Descendants().FirstOrDefault(e => e.Name.LocalName == "below")?.Value;
                    // FIXM: above = "maintain above" (floor), below = "maintain below" (ceiling)
                    if (double.TryParse(above, out var floor) && double.TryParse(below, out var ceil))
                    {
                        state.AssignedAltitude = floor;
                        state.AssignedVfr = false;
                        state.BlockFloor = floor;
                        state.BlockCeiling = ceil;
                    }
                }
            }
        }

        // First-ever assignment: snapshot as OriginalAssignedAltitude so the
        // initial flight-plan altitude is retained even after ATC amends it
        // later. Mirrors OriginalRoute. Once set (either numeric or VFR), it
        // is never overwritten.
        if (state.OriginalAssignedAltitude is null && !state.OriginalAssignedVfr &&
            (state.AssignedAltitude.HasValue || state.AssignedVfr))
        {
            state.OriginalAssignedAltitude = state.AssignedAltitude;
            state.OriginalAssignedVfr = state.AssignedVfr;
        }

        // Log altitude changes
        if (state.AssignedAltitude != prevAA || state.AssignedVfr != prevVfr || state.BlockFloor != prevBlkF || state.BlockCeiling != prevBlkC)
        {
            var beforeStr = prevVfr ? (prevAA.HasValue ? $"VFR/{prevAA}" : "VFR") : prevBlkF.HasValue ? $"{prevBlkF}B{prevBlkC}" : $"{prevAA?.ToString() ?? "null"}";
            var afterStr = state.AssignedVfr ? (state.AssignedAltitude.HasValue ? $"VFR/{state.AssignedAltitude}" : "VFR") : state.BlockFloor.HasValue ? $"{state.BlockFloor}B{state.BlockCeiling}" : $"{state.AssignedAltitude?.ToString() ?? "null"}";
            var logEntry = $"[{DateTime.UtcNow:HH:mm:ss}] {source} {state.Callsign ?? "?"}/{state.Gufi?[..8] ?? "?"} ctrl={state.ControllingFacility}/{state.ControllingSector} ASSIGNED: {beforeStr} → {afterStr} RAW_XML: {aa.ToString().Replace("\n", " ")}";
            altitudeLog.Enqueue(logEntry);
            while (altitudeLog.Count > MaxAltitudeLogEntries) altitudeLog.TryDequeue(out _);
        }
    }

    // interimAltitude — xsi:nil="true" means clear
    var ia = flight.Elements().FirstOrDefault(e => e.Name.LocalName == "interimAltitude");
    var prevIA = state.InterimAltitude;
    XNamespace xsiNs = "http://www.w3.org/2001/XMLSchema-instance";
    if (ia is not null)
    {
        var isNil = string.Equals(ia.Attribute(xsiNs + "nil")?.Value, "true", StringComparison.OrdinalIgnoreCase)
                 || string.Equals(ia.Attribute("nil")?.Value, "true", StringComparison.OrdinalIgnoreCase);
        if (isNil)
            state.InterimAltitude = null;
        else if (double.TryParse(ia.Value, out var ival))
            state.InterimAltitude = ival;

        // Log interim changes
        if (state.InterimAltitude != prevIA)
        {
            var logEntry = $"[{DateTime.UtcNow:HH:mm:ss}] {source} {state.Callsign ?? "?"}/{state.Gufi?[..8] ?? "?"} ctrl={state.ControllingFacility}/{state.ControllingSector} INTERIM: {prevIA?.ToString() ?? "null"} → {state.InterimAltitude?.ToString() ?? "CLEARED(nil)"} RAW_XML: {ia.ToString().Replace("\n", " ")}";
            altitudeLog.Enqueue(logEntry);
            while (altitudeLog.Count > MaxAltitudeLogEntries) altitudeLog.TryDequeue(out _);
            Console.WriteLine($"[INTERIM] {source} {state.Callsign}/{state.Gufi?[..8]} {prevIA?.ToString() ?? "null"} → {state.InterimAltitude?.ToString() ?? "CLEARED"}");
        }
    }
    // Clear interim when absent in full-state-snapshot sources:
    // - LH: dedicated interim message — absence means explicitly cleared
    // - FH: canonical flight plan snapshot — absence means interim not active
    // - AH: assumed/forced handoff — full state transfer (carries assignedAltitude, route, aircraft
    //   description at 100%, enRoute at 95%), NEVER carries interimAltitude (0/197 observed)
    // - HU: handoff update — structurally identical to FH/AH, also never carries interimAltitude
    // Other sources (TH/OH/HX/HP) are event-specific and don't carry interim, so absence is incidental.
    else if (source is "LH" or "FH" or "AH" or "HU")
    {
        state.InterimAltitude = null;
        if (prevIA.HasValue)
        {
            var logEntry = $"[{DateTime.UtcNow:HH:mm:ss}] {source} {state.Callsign ?? "?"}/{state.Gufi?[..8] ?? "?"} ctrl={state.ControllingFacility}/{state.ControllingSector} INTERIM: {prevIA} → CLEARED(absent in {source})";
            altitudeLog.Enqueue(logEntry);
            while (altitudeLog.Count > MaxAltitudeLogEntries) altitudeLog.TryDequeue(out _);
            Console.WriteLine($"[INTERIM] {source} {state.Callsign}/{state.Gufi?[..8]} {prevIA} → CLEARED(absent)");
        }
    }

    // controllingUnit
    var cu = flight.Elements().FirstOrDefault(e => e.Name.LocalName == "controllingUnit");
    if (cu is not null)
    {
        state.ControllingFacility = cu.Attribute("unitIdentifier")?.Value ?? "";
        state.ControllingSector = cu.Attribute("sectorIdentifier")?.Value ?? "";
    }

    // flightPlan
    var fp = flight.Elements().FirstOrDefault(e => e.Name.LocalName == "flightPlan");
    if (fp is not null)
    {
        var remarks = fp.Attribute("flightPlanRemarks")?.Value;
        if (!string.IsNullOrEmpty(remarks)) state.Remarks = remarks;
    }

    // coordination
    var coord = flight.Elements().FirstOrDefault(e => e.Name.LocalName == "coordination");
    if (coord is not null)
    {
        state.CoordinationTime = coord.Attribute("coordinationTime")?.Value;
        var fix = coord.Elements().FirstOrDefault(e => e.Name.LocalName == "coordinationFix");
        if (fix is not null) state.CoordinationFix = fix.Attribute("fix")?.Value;
    }

    // requestedAirspeed
    var ras = flight.Descendants().FirstOrDefault(e => e.Name.LocalName == "nasAirspeed");
    if (ras is not null && double.TryParse(ras.Value, out var spd)) state.RequestedSpeed = spd;

    // enRoute
    var enRoute = flight.Elements().FirstOrDefault(e => e.Name.LocalName == "enRoute");
    if (enRoute is not null)
    {
        // Position (TH, HZ)
        var pos = enRoute.Elements().FirstOrDefault(e => e.Name.LocalName == "position");
        if (pos is not null)
        {
            var locPos = pos.Descendants().FirstOrDefault(e => e.Name.LocalName == "pos");
            if (locPos is not null)
            {
                var parts = locPos.Value.Trim().Split(' ', StringSplitOptions.RemoveEmptyEntries);
                if (parts.Length == 2 && double.TryParse(parts[0], out var lat) && double.TryParse(parts[1], out var lon))
                {
                    // Record old position in history before updating (if moved)
                    if (state.Latitude.HasValue && state.Longitude.HasValue)
                    {
                        var dlat = Math.Abs(state.Latitude.Value - lat);
                        var dlon = Math.Abs(state.Longitude.Value - lon);
                        if (dlat > 0.0001 || dlon > 0.0001)
                            state.AddPosition(state.Latitude.Value, state.Longitude.Value, GetHistSym(state));
                    }
                    state.Latitude = lat;
                    state.Longitude = lon;
                    state.LastPositionTime = DateTime.UtcNow;
                }
            }
            var altEl = pos.Elements().FirstOrDefault(e => e.Name.LocalName == "altitude");
            if (altEl is not null && double.TryParse(altEl.Value, out var rptAlt))
                state.ReportedAltitude = rptAlt;

            var spdEl = pos.Descendants().FirstOrDefault(e => e.Name.LocalName == "surveillance");
            if (spdEl is not null && double.TryParse(spdEl.Value, out var gs))
                state.GroundSpeed = gs;

            // Track velocity (x=east, y=north in knots)
            var tv = pos.Elements().FirstOrDefault(e => e.Name.LocalName == "trackVelocity");
            if (tv is not null)
            {
                var xEl = tv.Elements().FirstOrDefault(e => e.Name.LocalName == "x");
                var yEl = tv.Elements().FirstOrDefault(e => e.Name.LocalName == "y");
                if (xEl is not null && double.TryParse(xEl.Value, out var vx)) state.TrackVelocityX = vx;
                if (yEl is not null && double.TryParse(yEl.Value, out var vy)) state.TrackVelocityY = vy;
            }

            // Coast indicator — authoritative from ERAM (attribute only present when coasting)
            state.CoastIndicator = string.Equals(pos.Attribute("coastIndicator")?.Value, "true", StringComparison.OrdinalIgnoreCase);

            // Target position — ERAM-predicted next position for track smoothing
            var tgtPos = pos.Elements().FirstOrDefault(e => e.Name.LocalName == "targetPosition");
            if (tgtPos is not null)
            {
                var tgtPosEl = tgtPos.Elements().FirstOrDefault(e => e.Name.LocalName == "pos")
                            ?? tgtPos.Descendants().FirstOrDefault(e => e.Name.LocalName == "pos");
                if (tgtPosEl is not null)
                {
                    var tp = tgtPosEl.Value.Trim().Split(' ', StringSplitOptions.RemoveEmptyEntries);
                    if (tp.Length == 2 && double.TryParse(tp[0], out var tlat) && double.TryParse(tp[1], out var tlon))
                    {
                        state.TargetLatitude = tlat;
                        state.TargetLongitude = tlon;
                    }
                }
            }

            // Target altitude — ERAM-predicted altitude (skip if @invalid="true")
            var tgtAlt = pos.Elements().FirstOrDefault(e => e.Name.LocalName == "targetAltitude");
            if (tgtAlt is not null && !string.Equals(tgtAlt.Attribute("invalid")?.Value, "true", StringComparison.OrdinalIgnoreCase))
            {
                if (double.TryParse(tgtAlt.Value, out var ta)) state.TargetAltitude = ta;
            }
        }

        // Beacon code — BA/RE messages carry <beaconCodeAssignment> (assigned code);
        // other messages carry <currentBeaconCode> directly (received/current code)
        var bca = enRoute.Elements().FirstOrDefault(e => e.Name.LocalName == "beaconCodeAssignment");
        if (bca is not null)
        {
            var bcAssigned = bca.Elements().FirstOrDefault(e => e.Name.LocalName == "currentBeaconCode");
            if (bcAssigned is not null)
            {
                state.AssignedSquawk = bcAssigned.Value;
                state.Squawk = bcAssigned.Value; // Assignment also sets current
            }
        }
        else
        {
            var bc = enRoute.Descendants().FirstOrDefault(e => e.Name.LocalName == "currentBeaconCode");
            if (bc is not null) state.Squawk = bc.Value;
        }

        // Point-out (PT, HT) — may have multiple receiving units
        var po = enRoute.Elements().FirstOrDefault(e => e.Name.LocalName == "pointout");
        if (po is not null)
        {
            var origUnit = po.Elements().FirstOrDefault(e => e.Name.LocalName == "originatingUnit");
            var recvUnits = po.Elements().Where(e => e.Name.LocalName == "receivingUnit").Select(EventSummaryBuilder.FormatUnit).ToArray();
            if (origUnit is not null) state.PointoutOriginatingUnit = EventSummaryBuilder.FormatUnit(origUnit);
            if (recvUnits.Length > 0) state.PointoutReceivingUnit = string.Join(",", recvUnits);
            state.PointoutTimestamp = DateTime.UtcNow;
        }

        // Cleared flight information (HF — heading, speed, text assigned by controller)
        var clr = enRoute.Elements().FirstOrDefault(e => e.Name.LocalName == "cleared");
        var hadClearance = !string.IsNullOrEmpty(state.ClearanceHeading) || !string.IsNullOrEmpty(state.ClearanceSpeed) || !string.IsNullOrEmpty(state.ClearanceText);
        if (clr is not null)
        {
            // <cleared> element is authoritative — present attributes are set, absent attributes are cleared.
            // e.g. <cleared clearanceSpeed="270"/> means heading & text have been removed by controller.
            var clrHdg = clr.Attribute("clearanceHeading")?.Value;
            var clrSpd = clr.Attribute("clearanceSpeed")?.Value;
            var clrTxt = clr.Attribute("clearanceText")?.Value;

            // Log raw XML for debugging (before applying changes)
            var logEntry = $"[{DateTime.UtcNow:HH:mm:ss}] {source} {state.Callsign ?? "?"}/{state.Gufi?[..8] ?? "?"} ctrl={state.ControllingFacility}/{state.ControllingSector} " +
                $"BEFORE: H={state.ClearanceHeading ?? "-"} S={state.ClearanceSpeed ?? "-"} T={state.ClearanceText ?? "-"} " +
                $"RAW_ATTRS: H=\"{clrHdg ?? "(null)"}\" S=\"{clrSpd ?? "(null)"}\" T=\"{clrTxt ?? "(null)"}\" " +
                $"RAW_XML: {clr.ToString()}";
            clearanceLog.Enqueue(logEntry);
            while (clearanceLog.Count > MaxClearanceLogEntries) clearanceLog.TryDequeue(out _);

            // Apply: set present values, clear absent ones.
            var prevH = state.ClearanceHeading; var prevS = state.ClearanceSpeed; var prevT = state.ClearanceText;
            state.ClearanceHeading = string.IsNullOrEmpty(clrHdg) ? null : clrHdg;
            state.ClearanceSpeed = string.IsNullOrEmpty(clrSpd) ? null : clrSpd;
            state.ClearanceText = string.IsNullOrEmpty(clrTxt) ? null : clrTxt;
            if (state.ClearanceHeading != prevH || state.ClearanceSpeed != prevS || state.ClearanceText != prevT)
                Console.WriteLine($"[CLR] {source} {state.Callsign}/{state.Gufi?[..8]} H:{prevH ?? "-"}→{state.ClearanceHeading ?? "-"} S:{prevS ?? "-"}→{state.ClearanceSpeed ?? "-"} T:{prevT ?? "-"}→{state.ClearanceText ?? "-"}");
        }
        else if (hadClearance)
        {
            // FH is the canonical state snapshot — if it omits <cleared>, clearance has been wiped (QS *).
            // Other sources (TH/OH/AH/HF) simply don't carry clearance data, so absence is not meaningful.
            if (source is "FH")
            {
                var prevH = state.ClearanceHeading; var prevS = state.ClearanceSpeed; var prevT = state.ClearanceText;
                state.ClearanceHeading = null;
                state.ClearanceSpeed = null;
                state.ClearanceText = null;
                var logEntry = $"[{DateTime.UtcNow:HH:mm:ss}] {source} {state.Callsign ?? "?"}/{state.Gufi?[..8] ?? "?"} " +
                    $"CLEARED_WIPED(H={prevH ?? "-"} S={prevS ?? "-"} T={prevT ?? "-"}) " +
                    $"FH had enRoute but no <cleared> element";
                clearanceLog.Enqueue(logEntry);
                while (clearanceLog.Count > MaxClearanceLogEntries) clearanceLog.TryDequeue(out _);
                Console.WriteLine($"[CLR] {source} {state.Callsign}/{state.Gufi?[..8]} WIPED H:{prevH ?? "-"} S:{prevS ?? "-"} T:{prevT ?? "-"}");
            }
            else
            {
                var logEntry = $"[{DateTime.UtcNow:HH:mm:ss}] {source} {state.Callsign ?? "?"}/{state.Gufi?[..8] ?? "?"} " +
                    $"HAS_CLR(H={state.ClearanceHeading ?? "-"} S={state.ClearanceSpeed ?? "-"} T={state.ClearanceText ?? "-"}) " +
                    $"NO_CLEARED_ELEM enRoute_children=[{string.Join(",", enRoute.Elements().Select(e => e.Name.LocalName))}]";
                clearanceLog.Enqueue(logEntry);
                while (clearanceLog.Count > MaxClearanceLogEntries) clearanceLog.TryDequeue(out _);
            }
        }

        // Handoff (OH)
        var ho = enRoute.Descendants().FirstOrDefault(e => e.Name.LocalName == "handoff");
        if (ho is not null)
        {
            var evt = ho.Attribute("event")?.Value ?? "";
            var recv = ho.Elements().FirstOrDefault(e => e.Name.LocalName == "receivingUnit");
            var xfer = ho.Elements().FirstOrDefault(e => e.Name.LocalName == "transferringUnit");
            var acpt = ho.Elements().FirstOrDefault(e => e.Name.LocalName == "acceptingUnit");

            // Only update handoff event if we got an explicit event type
            // (SFDPS sometimes sends OH with no event attribute — don't clear state)
            if (!string.IsNullOrEmpty(evt))
            {
                state.HandoffEvent = evt;
                // AH (assumed/assigned handoff) with acceptance = /OK forced track
                var evtUpper = evt.ToUpperInvariant();
                state.HandoffForced = source == "AH" &&
                    (evtUpper.StartsWith("ACCEPT") || evtUpper == "EXECUTION");
            }
            if (recv is not null) state.HandoffReceiving = EventSummaryBuilder.FormatUnit(recv);
            if (xfer is not null) state.HandoffTransferring = EventSummaryBuilder.FormatUnit(xfer);
            if (acpt is not null) state.HandoffAccepting = EventSummaryBuilder.FormatUnit(acpt);
        }
    }
    else if (source == "HF" && (!string.IsNullOrEmpty(state.ClearanceHeading) || !string.IsNullOrEmpty(state.ClearanceSpeed) || !string.IsNullOrEmpty(state.ClearanceText)))
    {
        // HF without <enRoute> = clearance wipe signal.
        // Data-driven: HF-no-enRoute targets flights with active clearance at 89% rate (2x baseline),
        // and 92% of affected flights receive NO other clearing message. The absence of <enRoute>
        // in the authoritative clearance source (HF) means "no en route clearance data exists."
        var prevH = state.ClearanceHeading; var prevS = state.ClearanceSpeed; var prevT = state.ClearanceText;
        state.ClearanceHeading = null;
        state.ClearanceSpeed = null;
        state.ClearanceText = null;
        if (prevH is not null || prevS is not null || prevT is not null)
        {
            var logEntry = $"[{DateTime.UtcNow:HH:mm:ss}] {source} {state.Callsign ?? "?"}/{state.Gufi?[..8] ?? "?"} " +
                $"CLEARED_WIPED(H={prevH ?? "-"} S={prevS ?? "-"} T={prevT ?? "-"}) " +
                $"HF had no <enRoute> element (clearance removal signal)";
            clearanceLog.Enqueue(logEntry);
            while (clearanceLog.Count > MaxClearanceLogEntries) clearanceLog.TryDequeue(out _);
            Console.WriteLine($"[CLR] {source} {state.Callsign}/{state.Gufi?[..8]} WIPED(no-enRoute) H:{prevH ?? "-"} S:{prevS ?? "-"} T:{prevT ?? "-"}");
        }
    }

    // aircraftDescription (FH, AH, HU)
    var acft = flight.Elements().FirstOrDefault(e => e.Name.LocalName == "aircraftDescription");
    if (acft is not null)
    {
        var acType = acft.Descendants().FirstOrDefault(e => e.Name.LocalName == "icaoModelIdentifier")?.Value;
        if (!string.IsNullOrEmpty(acType)) state.AircraftType = acType;
        var reg = acft.Attribute("registration")?.Value;
        if (!string.IsNullOrEmpty(reg)) state.Registration = reg;
        var wake = acft.Attribute("wakeTurbulence")?.Value;
        if (!string.IsNullOrEmpty(wake)) state.WakeCategory = wake;
        var modeS = acft.Attribute("aircraftAddress")?.Value;
        if (!string.IsNullOrEmpty(modeS)) state.ModeSCode = modeS;
        var equip = acft.Attribute("equipmentQualifier")?.Value;
        if (!string.IsNullOrEmpty(equip)) state.EquipmentQualifier = equip;
        var perf = acft.Attribute("aircraftPerformance")?.Value;
        if (!string.IsNullOrEmpty(perf)) state.AircraftPerformance = perf;

        // Communication / datalink
        var comm = acft.Descendants().FirstOrDefault(e => e.Name.LocalName == "communication");
        if (comm is not null)
        {
            var commCode = comm.Elements().FirstOrDefault(e => e.Name.LocalName == "communicationCode")?.Value;
            if (!string.IsNullOrEmpty(commCode)) state.CommunicationCode = commCode;
            var dlCode = comm.Elements().FirstOrDefault(e => e.Name.LocalName == "dataLinkCode")?.Value;
            if (!string.IsNullOrEmpty(dlCode)) state.DataLinkCode = dlCode;
            var otherDl = comm.Attribute("otherDataLinkCapabilities")?.Value;
            if (!string.IsNullOrEmpty(otherDl)) state.OtherDataLink = otherDl;
            var otherComm = comm.Attribute("otherCommunicationCapabilities")?.Value;
            if (!string.IsNullOrEmpty(otherComm)) state.OtherCommunicationCapabilities = otherComm;
            var selcal = comm.Attribute("selectiveCallingCode")?.Value;
            if (!string.IsNullOrEmpty(selcal)) state.SELCAL = selcal;
        }

        // Navigation
        var nav = acft.Descendants().FirstOrDefault(e => e.Name.LocalName == "navigation");
        if (nav is not null)
        {
            var navCode = nav.Elements().FirstOrDefault(e => e.Name.LocalName == "navigationCode")?.Value;
            if (!string.IsNullOrEmpty(navCode)) state.NavigationCode = navCode;
            var pbn = nav.Elements().FirstOrDefault(e => e.Name.LocalName == "performanceBasedCode")?.Value;
            if (!string.IsNullOrEmpty(pbn)) state.PBNCode = pbn;
            var otherNav = nav.Attribute("otherNavigationCapabilities")?.Value;
            if (!string.IsNullOrEmpty(otherNav)) state.OtherNavigationCapabilities = otherNav;
        }

        // Surveillance
        var surv = acft.Descendants().FirstOrDefault(e => e.Name.LocalName == "surveillance");
        if (surv is not null)
        {
            var survCode = surv.Elements().FirstOrDefault(e => e.Name.LocalName == "surveillanceCode")?.Value;
            if (!string.IsNullOrEmpty(survCode)) state.SurveillanceCode = survCode;
            var otherSurv = surv.Attribute("otherSurveillanceCapabilities")?.Value;
            if (!string.IsNullOrEmpty(otherSurv)) state.OtherSurveillanceCapabilities = otherSurv;
        }
    }

    // Route (FH, AH, HU)
    var agreed = flight.Elements().FirstOrDefault(e => e.Name.LocalName == "agreed");
    if (agreed is not null)
    {
        var route = agreed.Elements().FirstOrDefault(e => e.Name.LocalName == "route");
        if (route is not null)
        {
            var routeText = route.Attribute("nasRouteText")?.Value;
            if (!string.IsNullOrEmpty(routeText))
            {
                if (string.IsNullOrEmpty(state.OriginalRoute)) state.OriginalRoute = routeText;
                state.Route = routeText;
            }
            var rules = route.Attribute("initialFlightRules")?.Value;
            if (!string.IsNullOrEmpty(rules)) state.FlightRules = rules;

            var star = route.Descendants().FirstOrDefault(e => e.Name.LocalName == "nasadaptedArrivalRoute");
            if (star is not null) state.STAR = star.Attribute("nasRouteIdentifier")?.Value;

            // estimatedElapsedTime — FIR boundary crossing times (for ICAO EET/)
            var eets = route.Elements().Where(e => e.Name.LocalName == "estimatedElapsedTime");
            var eetParts = new List<string>();
            foreach (var eet in eets)
            {
                var elapsed = eet.Attribute("elapsedTime")?.Value; // ISO 8601 duration e.g. P0Y0M0DT1H9M0S
                var region = eet.Descendants().FirstOrDefault(e => e.Name.LocalName == "region")?.Value;
                var fix = eet.Descendants().FirstOrDefault(e => e.Name.LocalName == "point")?.Attribute("fix")?.Value;
                if (!string.IsNullOrEmpty(elapsed))
                {
                    // Parse ISO 8601 duration to HHMM
                    try
                    {
                        var ts = System.Xml.XmlConvert.ToTimeSpan(elapsed);
                        var hhmm = $"{(int)ts.TotalHours:D2}{ts.Minutes:D2}";
                        // Format: REGION/FIX HHMM or REGION HHMM or FIX HHMM
                        var label = !string.IsNullOrEmpty(region) && !string.IsNullOrEmpty(fix)
                            ? $"{region}/{fix}" : (region ?? fix ?? "");
                        if (!string.IsNullOrEmpty(label))
                            eetParts.Add($"{label}{hhmm}");
                    }
                    catch { }
                }
            }
            if (eetParts.Count > 0) state.EstimatedElapsedTimes = string.Join(" ", eetParts);
        }
    }

    // supplementalData nameValues
    var suppData = flight.Descendants().Where(e => e.Name.LocalName == "nameValue");
    foreach (var nv in suppData)
    {
        var name = nv.Attribute("name")?.Value;
        var val = nv.Attribute("value")?.Value;
        if (!string.IsNullOrEmpty(name)) nameValueKeys.AddOrUpdate(name, 1, (_, v) => v + 1);
        if (name == "FDPS_GUFI" && !string.IsNullOrEmpty(val)) state.FdpsGufi = val;
        if (name == "4TH_ADAPTED_FIELD" && !string.IsNullOrEmpty(val)) state.FourthAdaptedField = val;
        if (name == "TMI_IDS" && !string.IsNullOrEmpty(val)) state.TmiIds = val;
    }

    // Add event to log (store raw XML for non-TH/HZ to save memory; TH=65% of traffic)
    state.AddEvent(new FlightEvent
    {
        Time = timestamp ?? DateTime.UtcNow.ToString("o"),
        Source = source,
        Centre = centre,
        Summary = EventSummaryBuilder.BuildEventSummary(source, flight),
        RawXml = source is not "TH" and not "HZ" ? rawXml : null
    });

    // Detect handoff completion: controlling unit now matches receiving unit.
    // Don't require a specific HandoffEvent — handles cases where we missed the
    // INITIATION/ACCEPTANCE (e.g. server restart mid-handoff). Any time CU matches
    // recv and handoff fields are populated, the handoff has completed.
    if (!string.IsNullOrEmpty(state.HandoffReceiving))
    {
        var recvParts = state.HandoffReceiving.Split('/');
        var recvFac = recvParts[0];
        var recvSec = recvParts.Length > 1 ? recvParts[1] : "";
        if (state.ControllingFacility == recvFac && state.ControllingSector == recvSec)
        {
            state.HandoffEvent = "";
            state.HandoffReceiving = "";
            state.HandoffTransferring = "";
            state.HandoffAccepting = "";
            state.HandoffForced = false;
        }
    }

    // Track which facility reports on this flight (for "tracked by")
    if (!string.IsNullOrEmpty(centre)) state.ReportingFacility = centre;

    // Investigation: log all messages for flights with interim or clearance data
    // Uncomment this block + investigation logger vars + before-state vars (prevClrH etc.) to enable.
    // {
    //     bool hasInteresting = state.InterimAltitude.HasValue
    //         || !string.IsNullOrEmpty(state.ClearanceHeading)
    //         || !string.IsNullOrEmpty(state.ClearanceSpeed)
    //         || !string.IsNullOrEmpty(state.ClearanceText);
    //     bool wasInteresting = prevIA.HasValue
    //         || !string.IsNullOrEmpty(prevClrH)
    //         || !string.IsNullOrEmpty(prevClrS)
    //         || !string.IsNullOrEmpty(prevClrT);
    //     if (hasInteresting || wasInteresting || investigationWatched.ContainsKey(gufi))
    //     {
    //         investigationWatched.TryAdd(gufi, 0);
    //         bool isTH = source is "TH" or "HZ";
    //         bool thHasIa = isTH && rawXml != null && rawXml.Contains("interimAltitude");
    //         bool thHasClr = isTH && rawXml != null && rawXml.Contains("\"cleared\"");
    //         string logLine;
    //         if (!isTH || thHasIa || thHasClr)
    //         {
    //             logLine = JsonSerializer.Serialize(new
    //             {
    //                 ts = DateTime.UtcNow.ToString("o"), src = source, gufi, cs = state.Callsign,
    //                 ctrl = $"{state.ControllingFacility}/{state.ControllingSector}",
    //                 ho = state.HandoffEvent, hoRecv = state.HandoffReceiving,
    //                 b = new { ia = prevIA, aa = prevAA, ra = prevRA, ch = prevClrH, csp = prevClrS, ct = prevClrT },
    //                 a = new { ia = state.InterimAltitude, aa = state.AssignedAltitude, ra = state.ReportedAltitude,
    //                           ch = state.ClearanceHeading, csp = state.ClearanceSpeed, ct = state.ClearanceText },
    //                 thHasIa, thHasClr, xml = rawXml
    //             }, jsonOpts);
    //         }
    //         else
    //         {
    //             logLine = JsonSerializer.Serialize(new
    //             {
    //                 ts = DateTime.UtcNow.ToString("o"), src = source, gufi, cs = state.Callsign,
    //                 ra = state.ReportedAltitude, aa = state.AssignedAltitude, ia = state.InterimAltitude,
    //                 ch = state.ClearanceHeading, csp = state.ClearanceSpeed, ct = state.ClearanceText
    //             }, jsonOpts);
    //         }
    //         investigationQueue.Enqueue(logLine);
    //     }
    // }

    // Point-out investigation (disabled — complete, no acceptance signal in SFDPS)
    // var isPtHt = source is "PT" or "HT";
    // if (isPtHt) poWatched.TryAdd(gufi, 0);
    // if (isPtHt || poWatched.ContainsKey(gufi))
    // {
    //     ... investigation logging ...
    // }

    // Mark flight dirty for batched broadcast (all updates batched every 1s)
    _dirty.TryAdd(gufi, 0);
}

void SendSnapshot(WsClient client)
{
    // Send every flight the flight table or scope might want to show. ERAM
    // null-checks f.latitude before rendering (see eram.js), so position-less
    // flights coming through are silently skipped on the scope side. The
    // flight TABLE needs them so newly-filed flight plans (FH-only, no TH yet)
    // appear immediately rather than only when the airplane gets airborne and
    // a track message lands. SFDPS data is ~14% flight-plan-only at any time;
    // dropping the Latitude filter raises snapshot size from ~few MB to
    // ~6 MB extra, which is well within budget.
    var now = DateTime.UtcNow;
    var summaries = flights.Values
        .Where(f =>
        {
            if (f.FlightStatus == "CANCELLED") return false;
            // Long-dropped flights are noise — drop them.
            if (f.FlightStatus == "DROPPED")
            {
                var posAge = f.LastPositionTime == default ? int.MaxValue : (int)(now - f.LastPositionTime).TotalSeconds;
                if (posAge > 60) return false;
            }
            // ACTIVE without position is fine (PROPOSED / filed-but-not-airborne).
            // ACTIVE with stale position past 5 min is dropped unless there's an
            // active handoff event keeping the strip relevant.
            if (f.FlightStatus == "ACTIVE" && f.Latitude.HasValue)
            {
                var posAge = f.LastPositionTime == default ? int.MaxValue : (int)(now - f.LastPositionTime).TotalSeconds;
                if (posAge > 300 && f.HandoffEvent == null) return false;
            }
            // Any non-position flight needs identifying flight-plan content
            // (callsign or destination) - prevents empty stub records from
            // being shipped. SFDPS uses status=ACTIVE for filed-but-not-yet-
            // departed flights, so this branch is the "active flight plan,
            // aircraft not yet airborne" case the user asked for.
            if (!f.Latitude.HasValue)
            {
                if (string.IsNullOrEmpty(f.Callsign) && string.IsNullOrEmpty(f.Destination)) return false;
            }
            if (f.FlightStatus is not null and not "ACTIVE" and not "DROPPED") return false;
            return true;
        })
        .Select(f => f.ToSummary(includeHistory: true))
        .ToArray();
    Console.WriteLine($"[WS] Snapshot: {summaries.Length} flights (of {flights.Count} total)");
    var json = JsonSerializer.SerializeToUtf8Bytes(new WsMsg("snapshot", summaries), jsonOpts);
    client.Enqueue(json);
}

void Broadcast(WsMsg msg)
{
    var json = JsonSerializer.SerializeToUtf8Bytes(msg, jsonOpts);
    foreach (var (_, client) in clients)
    {
        if (client.Ws.State != WebSocketState.Open) continue;
        client.Enqueue(json);
    }
}

void FlushDirtyBatch(ConcurrentDictionary<string, byte> dirtySet)
{
    if (dirtySet.IsEmpty) return;
    // Drain the dirty set atomically
    var gufis = dirtySet.Keys.ToArray();
    foreach (var g in gufis) dirtySet.TryRemove(g, out _);

    var summaries = new List<object>(gufis.Length);
    foreach (var gufi in gufis)
    {
        // Include position-less flights too: the flight table renders them
        // (their row is just blank for lat/lon/altitude/speed columns), and
        // ERAM null-checks f.latitude before rendering so it ignores them
        // safely. Dropping these here was the root cause of "some flight
        // plans never show up" in the flight table.
        if (flights.TryGetValue(gufi, out var f))
            summaries.Add(f.ToSummary());
    }
    if (summaries.Count == 0) return;

    // Record for replay (always, regardless of connected clients)
    eramRecorder.RecordBatch(summaries.ToArray(), DateTime.UtcNow);

    if (!clients.IsEmpty)
        Broadcast(new WsMsg("batch", summaries));
}

