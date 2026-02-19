using System.Collections.Concurrent;
using System.IO.Compression;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using System.Threading.Channels;
using System.Xml.Linq;
using SolaceSystems.Solclient.Messaging;

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

// ── Shared state ────────────────────────────────────────────────────────────

var flights = new ConcurrentDictionary<string, FlightState>();
var clients = new ConcurrentDictionary<string, WsClient>();
var stats = new GlobalStats();
NasrData? nasrData = null;
var routeCache = new ConcurrentDictionary<string, List<double[]>>();
var AirwayPattern = new Regex(@"^[JVQTLMNP]\d+$", RegexOptions.Compiled);
long _procCount = 0;
long _noGufiCount = 0;
long lastMessageTicks = DateTime.UtcNow.Ticks;

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
var jsonOpts = new JsonSerializerOptions
{
    PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    // Note: WhenWritingNull removed — null values must be transmitted so clients can
    // detect cleared fields (e.g., interimAltitude null after OH/FH clears it)
};

// ── ASP.NET Core setup ──────────────────────────────────────────────────────

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.UseUrls("http://0.0.0.0:5001");
var app = builder.Build();

app.UseDefaultFiles();
app.UseStaticFiles();
app.UseWebSockets();

// Clean URLs: /eram → eram.html, /table → index.html (serve directly, no redirect)
app.MapGet("/eram", async (HttpContext ctx) =>
{
    ctx.Response.ContentType = "text/html";
    await ctx.Response.SendFileAsync(Path.Combine(builder.Environment.WebRootPath, "eram.html"));
});
app.MapGet("/table", async (HttpContext ctx) =>
{
    ctx.Response.ContentType = "text/html";
    await ctx.Response.SendFileAsync(Path.Combine(builder.Environment.WebRootPath, "index.html"));
});

// WebSocket — streams flight updates to browser
app.Map("/ws", async (HttpContext ctx) =>
{
    if (!ctx.WebSockets.IsWebSocketRequest) { ctx.Response.StatusCode = 400; return; }

    using var ws = await ctx.WebSockets.AcceptWebSocketAsync();
    var clientId = Guid.NewGuid().ToString("N");
    var client = new WsClient(ws);
    clients[clientId] = client;

    // Start background send pump — serializes all writes through a single task
    var sendTask = Task.Run(async () =>
    {
        try
        {
            await foreach (var data in client.Queue.Reader.ReadAllAsync())
            {
                if (ws.State != WebSocketState.Open) break;
                await ws.SendAsync(data, WebSocketMessageType.Text, true, CancellationToken.None);
            }
        }
        catch (WebSocketException) { }
        catch (OperationCanceledException) { }
    });

    try
    {
        // Send initial snapshot of all flights
        SendSnapshot(client);

        var buf = new byte[4096];
        while (ws.State == WebSocketState.Open)
        {
            var result = await ws.ReceiveAsync(buf, CancellationToken.None);
            if (result.MessageType == WebSocketMessageType.Close) break;
        }
    }
    catch (WebSocketException) { }
    finally
    {
        clients.TryRemove(clientId, out _);
        client.Queue.Writer.TryComplete();
        await sendTask;
    }
});

// REST API for flight detail (full state + event log)
app.MapGet("/api/flights/{*gufi}", (string gufi) =>
{
    if (!flights.TryGetValue(gufi, out var f)) return Results.NotFound();
    return Results.Json(f.ToDetail(), jsonOpts);
});

// REST API for stats
app.MapGet("/api/stats", () => Results.Json(stats.Snapshot(flights.Count), jsonOpts));

// REST API for resolved route waypoints
app.MapGet("/api/route/{*gufi}", (string gufi) =>
{
    if (nasrData is null)
        return Results.Json(new { waypoints = Array.Empty<double[]>(), debug = "NASR not loaded" }, jsonOpts);
    if (!flights.TryGetValue(gufi, out var f))
        return Results.Json(new { waypoints = Array.Empty<double[]>(), debug = "Flight not found" }, jsonOpts);
    if (string.IsNullOrEmpty(f.Route))
        return Results.Json(new { waypoints = Array.Empty<double[]>(), debug = "No route string" }, jsonOpts);

    var key = $"{f.Origin}:{f.Destination}:{f.Route}";
    var wps = routeCache.GetOrAdd(key, _ => ResolveRoute(f.Route, f.Origin, f.Destination, nasrData));
    return Results.Json(new { waypoints = wps, route = f.Route, origin = f.Origin, destination = f.Destination }, jsonOpts);
});

// REST API for NASR data status
app.MapGet("/api/nasr/status", () => Results.Json(new
{
    loaded = nasrData is not null,
    effectiveDate = nasrData?.EffectiveDate,
    navaids = nasrData?.Navaids.Count ?? 0,
    fixes = nasrData?.Fixes.Count ?? 0,
    airports = nasrData?.Airports.Count ?? 0,
    airways = nasrData?.Airways.Count ?? 0,
    procedures = nasrData?.Procedures.Count ?? 0,
    cachedRoutes = routeCache.Count
}, jsonOpts));

// NASR point lookup (fix/navaid/airport)
app.MapGet("/api/nasr/find/{ident}", (string ident) =>
{
    if (nasrData is null) return Results.Json(new { error = "NASR data not loaded" }, statusCode: 503);
    ident = ident.ToUpperInvariant();
    var pt = LookupPoint(ident, null, nasrData);
    if (pt is null)
    {
        // Also try with K prefix for airports
        pt = LookupAirport(ident, nasrData);
    }
    if (pt is null) return Results.Json(new { error = "NOT FOUND" }, statusCode: 404);
    return Results.Json(new { ident = pt.Ident, lat = pt.Lat, lon = pt.Lon }, jsonOpts);
});

// NASR airways — resolved to lat/lon polylines
app.MapGet("/api/nasr/airways", (string? type) =>
{
    if (nasrData is null) return Results.Json(new { error = "NASR data not loaded" }, statusCode: 503);
    var airways = nasrData.Airways.Values.AsEnumerable();
    if (!string.IsNullOrEmpty(type))
    {
        var t = type.ToUpperInvariant();
        if (t == "HI" || t == "HIGH")
            airways = airways.Where(a => a.Id.StartsWith("J", StringComparison.OrdinalIgnoreCase) ||
                                         a.Id.StartsWith("Q", StringComparison.OrdinalIgnoreCase) ||
                                         a.Id.StartsWith("T", StringComparison.OrdinalIgnoreCase));
        else if (t == "LO" || t == "LOW")
            airways = airways.Where(a => a.Id.StartsWith("V", StringComparison.OrdinalIgnoreCase));
        else
            airways = airways.Where(a => a.Id.StartsWith(t, StringComparison.OrdinalIgnoreCase));
    }
    var result = airways.Select(a =>
    {
        var pts = a.Fixes.Select(f => LookupPoint(f, null, nasrData))
            .Where(p => p is not null)
            .Select(p => new[] { p!.Lat, p!.Lon })
            .ToList();
        return new { id = a.Id, points = pts };
    }).Where(a => a.points.Count >= 2).ToList();
    return Results.Json(result, jsonOpts);
});

// NASR SID/STAR procedures for an airport
app.MapGet("/api/nasr/procedures", (string airport, string? type) =>
{
    if (nasrData is null) return Results.Json(new { error = "NASR data not loaded" }, statusCode: 503);
    airport = airport.ToUpperInvariant();
    // Strip K prefix for ICAO codes
    var faaId = airport.Length == 4 && airport.StartsWith("K") ? airport[1..] : airport;
    var procs = nasrData.Procedures.Values.SelectMany(list => list)
        .Where(p =>
        {
            var pApt = p.Airport.Length == 4 && p.Airport.StartsWith("K") ? p.Airport[1..] : p.Airport;
            return pApt.Equals(faaId, StringComparison.OrdinalIgnoreCase);
        });
    if (!string.IsNullOrEmpty(type))
        procs = procs.Where(p => p.Type.Equals(type, StringComparison.OrdinalIgnoreCase));
    var result = procs.Select(p =>
    {
        var pts = p.Fixes.Select(f => LookupPoint(f, null, nasrData))
            .Where(pt => pt is not null)
            .Select(pt => new[] { pt!.Lat, pt!.Lon })
            .ToList();
        return new { id = p.Id, airport = p.Airport, type = p.Type, points = pts };
    }).Where(p => p.points.Count >= 2).ToList();
    return Results.Json(result, jsonOpts);
});

// Full procedure geometry for map overlay (all body legs + transitions)
// Searches by airport code OR procedure base name; type filter: STAR or DP
app.MapGet("/api/nasr/procgeo", (string q, string? type) =>
{
    if (nasrData is null) return Results.Json(new { error = "NASR data not loaded" }, statusCode: 503);
    q = q.Trim().ToUpperInvariant();
    var faaId = q.Length == 4 && q.StartsWith("K") ? q[1..] : q;

    var matches = new List<ProcedureFullDef>();

    // Try airport match first
    foreach (var list in nasrData.ProceduresFull.Values)
        foreach (var p in list)
        {
            var pApt = p.Airport.Length == 4 && p.Airport.StartsWith("K") ? p.Airport[1..] : p.Airport;
            if (pApt.Equals(faaId, StringComparison.OrdinalIgnoreCase))
                matches.Add(p);
        }

    // If no airport match, search by procedure name
    if (matches.Count == 0)
    {
        foreach (var kv in nasrData.ProceduresFull)
        {
            if (kv.Key.Equals(q, StringComparison.OrdinalIgnoreCase))
            {
                matches.AddRange(kv.Value);
                continue;
            }
            // Base name match: strip trailing digits, compare
            var baseName = System.Text.RegularExpressions.Regex.Replace(kv.Key, @"\d+$", "");
            if (baseName.Length > 0 && baseName.Equals(q, StringComparison.OrdinalIgnoreCase))
                matches.AddRange(kv.Value);
        }
    }

    if (!string.IsNullOrEmpty(type))
        matches = matches.Where(p => p.Type.Equals(type, StringComparison.OrdinalIgnoreCase)).ToList();

    // Deduplicate by (Id, Airport) — same procedure registered under multiple keys
    matches = matches.GroupBy(p => (p.Id, p.Airport)).Select(g => g.First()).ToList();

    var result = matches.Select(p =>
    {
        var resolvedLegs = p.Legs.Select(leg =>
        {
            NavPoint? lastPt = null;
            var pts = new List<double[]>();
            foreach (var fix in leg)
            {
                var pt = LookupPoint(fix, lastPt, nasrData);
                if (pt is not null) { pts.Add(new[] { pt.Lat, pt.Lon }); lastPt = pt; }
            }
            return pts;
        }).Where(pts => pts.Count >= 2).ToList();
        return new { id = p.Id, airport = p.Airport, type = p.Type, legs = resolvedLegs };
    }).Where(p => p.legs.Count > 0).ToList();

    return Results.Json(result, jsonOpts);
});

// NASR VOR/VORTAC navaids (for plotting circles) — excludes NDBs and fan markers
app.MapGet("/api/nasr/navaids", () =>
{
    if (nasrData is null) return Results.Json(new { error = "NASR data not loaded" }, statusCode: 503);
    // Return first non-NDB point for each navaid identifier (dedup same-name navaids)
    var result = nasrData.Navaids
        .Where(kv => kv.Value.Any(n => !n.Type.Contains("NDB", StringComparison.OrdinalIgnoreCase)
                                    && !n.Type.Equals("FAN MARKER", StringComparison.OrdinalIgnoreCase)))
        .Select(kv =>
        {
            var nav = kv.Value.First(n => !n.Type.Contains("NDB", StringComparison.OrdinalIgnoreCase)
                                       && !n.Type.Equals("FAN MARKER", StringComparison.OrdinalIgnoreCase));
            return new { id = kv.Key, lat = nav.Lat, lon = nav.Lon };
        }).ToList();
    return Results.Json(result, jsonOpts);
});

app.MapGet("/api/nasr/airports", () =>
{
    if (nasrData is null) return Results.Json(new { error = "NASR data not loaded" }, statusCode: 503);
    return Results.Json(nasrData.AirportOverlay, jsonOpts);
});

app.MapGet("/api/nasr/centerlines", () =>
{
    if (nasrData is null) return Results.Json(new { error = "NASR data not loaded" }, statusCode: 503);
    return Results.Json(nasrData.Centerlines, jsonOpts);
});

// Debug: find duplicate CIDs for a facility
app.MapGet("/api/debug/dupe-cids/{facility}", (string facility) =>
{
    facility = facility.ToUpperInvariant();
    var cidMap = new Dictionary<string, List<object>>();
    foreach (var (gufi, f) in flights)
    {
        if (f.ComputerIds.TryGetValue(facility, out var cid) && !string.IsNullOrEmpty(cid))
        {
            if (!cidMap.ContainsKey(cid)) cidMap[cid] = new List<object>();
            cidMap[cid].Add(new { gufi, f.Callsign, f.Origin, f.Destination, f.FlightStatus, cid });
        }
    }
    var dupes = cidMap.Where(kv => kv.Value.Count > 1)
        .ToDictionary(kv => kv.Key, kv => kv.Value);
    return Results.Json(new { facility, totalFlights = flights.Count, cidsChecked = cidMap.Count, duplicates = dupes }, jsonOpts);
});

// Debug: search flights by callsign
app.MapGet("/api/debug/search/{callsign}", (string callsign) =>
{
    var needle = callsign.ToUpperInvariant();
    var matches = flights.Where(kv =>
        (kv.Value.Callsign?.ToUpperInvariant().Contains(needle) ?? false) ||
        (kv.Value.ComputerId?.Contains(needle) ?? false))
        .Select(kv => new {
            kv.Value.Gufi, kv.Value.Callsign, kv.Value.ComputerId,
            ComputerIds = new Dictionary<string, string>(kv.Value.ComputerIds),
            kv.Value.Origin, kv.Value.Destination, kv.Value.Squawk
        }).Take(20).ToList();
    return Results.Json(matches, jsonOpts);
});

// Debug: XML element discovery — shows all unique element paths seen in FIXM messages
app.MapGet("/api/debug/elements", (string? filter) =>
{
    var elements = xmlElements.ToArray()
        .Where(kv => string.IsNullOrEmpty(filter) ||
            kv.Key.Contains(filter, StringComparison.OrdinalIgnoreCase))
        .OrderBy(kv => kv.Key)
        .Select(kv => new { path = kv.Key, count = kv.Value })
        .ToList();
    return Results.Json(new { totalPaths = xmlElements.Count, showing = elements.Count, elements }, jsonOpts);
});

// Debug: raw XML sample for a given message source type
app.MapGet("/api/debug/raw/{source}", (string source) =>
{
    source = source.ToUpperInvariant();
    if (xmlSampleStore.TryGetValue(source, out var xml))
        return Results.Content(xml, "application/xml");
    return Results.NotFound($"No sample for source '{source}'");
});

// Debug: search raw XML samples for a keyword (e.g., "cpdlc", "dataLink", "authority")
app.MapGet("/api/debug/xml-search", (string q) =>
{
    var results = xmlSampleStore
        .Where(kv => kv.Value.Contains(q, StringComparison.OrdinalIgnoreCase))
        .Select(kv => {
            // Find context around the match
            var idx = kv.Value.IndexOf(q, StringComparison.OrdinalIgnoreCase);
            var start = Math.Max(0, idx - 200);
            var end = Math.Min(kv.Value.Length, idx + q.Length + 200);
            return new { source = kv.Key, context = kv.Value[start..end] };
        }).ToList();
    return Results.Json(new { query = q, sourcesSearched = xmlSampleStore.Count, matches = results }, jsonOpts);
});

// Debug: all unique nameValue keys seen in supplementalData
app.MapGet("/api/debug/namevalue-keys", () =>
{
    var keys = nameValueKeys.ToArray()
        .OrderByDescending(kv => kv.Value)
        .Select(kv => new { key = kv.Key, count = kv.Value })
        .ToList();
    return Results.Json(new { totalKeys = keys.Count, keys }, jsonOpts);
});

// Debug: CPDLC capability summary across all tracked flights
app.MapGet("/api/debug/posage", () =>
{
    var withPos = flights.Values.Where(f => f.Latitude.HasValue).ToList();
    var nullPosTime = withPos.Count(f => f.LastPositionTime == default);
    var buckets = withPos.Where(f => f.LastPositionTime != default)
        .GroupBy(f => {
            var age = (int)(DateTime.UtcNow - f.LastPositionTime).TotalSeconds;
            return age switch { < 15 => "0-14s", < 30 => "15-29s", < 60 => "30-59s", < 300 => "1-5m", _ => ">5m" };
        })
        .ToDictionary(g => g.Key, g => g.Count());
    return Results.Json(new { total = withPos.Count, nullLastPositionTime = nullPosTime, buckets });
});

app.MapGet("/api/debug/cpdlc", () =>
{
    var cpdlcFlights = flights.Values
        .Where(f => !string.IsNullOrEmpty(f.DataLinkCode) && f.DataLinkCode.Contains("J"))
        .Select(f => new {
            f.Gufi, f.Callsign, f.AircraftType,
            f.DataLinkCode, f.OtherDataLink, f.CommunicationCode,
            f.Origin, f.Destination,
            f.ControllingFacility, f.ControllingSector,
            f.FlightStatus
        })
        .Take(100).ToList();
    var total = flights.Count;
    var jCount = flights.Values.Count(f => !string.IsNullOrEmpty(f.DataLinkCode) && f.DataLinkCode.Contains("J"));
    var cpdlcXCount = flights.Values.Count(f =>
        !string.IsNullOrEmpty(f.OtherDataLink) &&
        f.OtherDataLink.Contains("CPDLC", StringComparison.OrdinalIgnoreCase));
    return Results.Json(new {
        totalFlights = total,
        dataLinkJ = jCount,
        otherDataLinkCPDLC = cpdlcXCount,
        sampleFlights = cpdlcFlights
    }, jsonOpts);
});

// Debug: flights with clearance data (heading/speed/text)
app.MapGet("/api/debug/clearance", () =>
{
    var clrFlights = flights.Values
        .Where(f => !string.IsNullOrEmpty(f.ClearanceHeading) || !string.IsNullOrEmpty(f.ClearanceSpeed) || !string.IsNullOrEmpty(f.ClearanceText))
        .Select(f => new { f.Gufi, f.Callsign, f.ControllingFacility, f.ControllingSector, f.ClearanceHeading, f.ClearanceSpeed, f.ClearanceText, f.Origin, f.Destination })
        .OrderBy(f => f.ControllingFacility)
        .ToList();
    return Results.Json(new { total = flights.Count, withClearance = clrFlights.Count, flights = clrFlights }, jsonOpts);
});

// Debug: clearance raw XML log — shows raw SFDPS XML for clearance-related events
app.MapGet("/api/debug/clearance-log", (int? last) =>
{
    var entries = clearanceLog.ToArray();
    var n = last ?? 100;
    var recent = entries.Length > n ? entries[^n..] : entries;
    return Results.Text(string.Join("\n", recent), "text/plain");
});

app.MapGet("/api/debug/altitude-log", (int? last) =>
{
    var entries = altitudeLog.ToArray();
    var n = last ?? 200;
    var recent = entries.Length > n ? entries[^n..] : entries;
    return Results.Text(string.Join("\n", recent), "text/plain");
});

// Serve KML files from repo root
var repoRoot = FindRepoRoot(app.Environment.ContentRootPath);

// NEXRAD tile proxy — serves IEM tiles from same origin so canvas pixel manipulation works (no CORS)
var nexradHttp = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
nexradHttp.DefaultRequestHeaders.UserAgent.ParseAdd("SwimReader/1.0");
app.MapGet("/api/nexrad/tile", async (int z, int x, int y) =>
{
    try
    {
        var url = $"https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/ridge::USCOMP-N0Q-0/{z}/{x}/{y}.png";
        var bytes = await nexradHttp.GetByteArrayAsync(url);
        return Results.Bytes(bytes, "image/png");
    }
    catch
    {
        return Results.StatusCode(502);
    }
});

app.MapGet("/api/metar/{station}", async (string station) =>
{
    station = station.ToUpperInvariant();
    if (station.Length == 3) station = "K" + station;
    using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
    try
    {
        var resp = await http.GetAsync($"https://aviationweather.gov/api/data/metar?ids={Uri.EscapeDataString(station)}");
        if (!resp.IsSuccessStatusCode) return Results.StatusCode((int)resp.StatusCode);
        var text = (await resp.Content.ReadAsStringAsync()).Trim();
        if (string.IsNullOrEmpty(text)) return Results.NotFound();
        return Results.Text(text);
    }
    catch { return Results.StatusCode(502); }
});

app.MapGet("/api/kml", () =>
{
    var files = Directory.GetFiles(repoRoot, "*.kml").Select(Path.GetFileName).ToArray();
    return Results.Json(files, jsonOpts);
});

app.MapGet("/api/kml/{name}", (string name) =>
{
    if (!name.EndsWith(".kml")) name += ".kml";
    name = Path.GetFileName(name); // prevent path traversal
    var path = Path.Combine(repoRoot, name);
    if (!File.Exists(path)) return Results.NotFound();
    return Results.File(path, "application/vnd.google-earth.kml+xml");
});

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
    var cfp = new ContextFactoryProperties { SolClientLogLevel = SolLogLevel.Warning };
    cfp.LogToConsoleError();
    ContextFactory.Instance.Init(cfp);

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

void SaveFlightCache()
{
    try
    {
        Directory.CreateDirectory(cacheDir);
        var cache = new FlightCache
        {
            SavedAt = DateTime.UtcNow,
            Flights = flights.Values
                .Where(f => f.FlightStatus != "CANCELLED")
                .Select(f => f.ToSnapshot())
                .ToList()
        };
        var tmpPath = Path.Combine(cacheDir, "flights.json.tmp");
        var finalPath = Path.Combine(cacheDir, "flights.json");
        using (var fs = File.Create(tmpPath))
            JsonSerializer.Serialize(fs, cache, cacheJsonOpts);
        File.Move(tmpPath, finalPath, overwrite: true);
        Console.WriteLine($"[Cache] Saved {cache.Flights.Count} flights ({new FileInfo(finalPath).Length / 1024}KB)");
    }
    catch (Exception ex)
    {
        Console.Error.WriteLine($"[Cache] Save error: {ex.Message}");
    }
}

void LoadFlightCache()
{
    try
    {
        var cachePath = Path.Combine(cacheDir, "flights.json");
        if (!File.Exists(cachePath))
        {
            Console.WriteLine("[Cache] No cached flight data found");
            return;
        }
        var ageMinutes = (DateTime.UtcNow - File.GetLastWriteTimeUtc(cachePath)).TotalMinutes;
        if (ageMinutes > 60)
        {
            Console.WriteLine($"[Cache] Cache is {ageMinutes:F0} min old, skipping (stale)");
            return;
        }
        using var fs = File.OpenRead(cachePath);
        var cache = JsonSerializer.Deserialize<FlightCache>(fs, cacheJsonOpts);
        if (cache?.Flights is null || cache.Flights.Count == 0)
        {
            Console.WriteLine("[Cache] Cache file empty");
            return;
        }
        int loaded = 0;
        foreach (var snapshot in cache.Flights)
        {
            if (string.IsNullOrEmpty(snapshot.Gufi)) continue;
            flights[snapshot.Gufi] = FlightState.FromSnapshot(snapshot);
            loaded++;
        }
        Console.WriteLine($"[Cache] Restored {loaded} flights (saved {ageMinutes:F0} min ago)");
    }
    catch (Exception ex)
    {
        Console.Error.WriteLine($"[Cache] Load error: {ex.Message}");
    }
}

LoadFlightCache();

// Save flight cache on graceful shutdown (SIGTERM from systemd)
var lifetime = app.Services.GetRequiredService<IHostApplicationLifetime>();
lifetime.ApplicationStopping.Register(() =>
{
    Console.WriteLine("[Cache] Shutdown — saving flight state...");
    SaveFlightCache();
});

solaceThread.Start();

// Save flight cache periodically (every 5 minutes)
var cacheTimer = new Timer(_ => SaveFlightCache(), null, TimeSpan.FromMinutes(5), TimeSpan.FromMinutes(5));

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
            Broadcast(new WsMsg("remove", new { gufi }));
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
}, null, TimeSpan.FromSeconds(60), TimeSpan.FromSeconds(60));

// Broadcast stats every 5 seconds
var statsTimer = new Timer(_ =>
{
    var fc = flights.Count;
    Console.WriteLine($"[Stats] flights={fc} proc={_procCount} nogufi={_noGufiCount}");
    Broadcast(new WsMsg("stats", stats.Snapshot(fc)));
}, null, TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(5));

// Health check — log stale connection warnings
var healthTimer = new Timer(_ =>
{
    var silence = (DateTime.UtcNow - new DateTime(Interlocked.Read(ref lastMessageTicks), DateTimeKind.Utc)).TotalSeconds;
    if (silence > 60)
        Console.WriteLine($"[HEALTH] Warning: no messages for {silence:F0}s");
}, null, TimeSpan.FromSeconds(60), TimeSpan.FromSeconds(60));

// ── NASR data (background download + parse) ─────────────────────────────────
Task.Run(async () =>
{
    try { await LoadNasrData(); }
    catch (Exception ex) { Console.WriteLine($"[NASR] Error: {ex.Message}"); }
});

// Check for new NASR cycle every 24 hours
var nasrTimer = new Timer(async _ =>
{
    try { await LoadNasrData(); }
    catch (Exception ex) { Console.WriteLine($"[NASR] Update check error: {ex.Message}"); }
}, null, TimeSpan.FromHours(24), TimeSpan.FromHours(24));

// Batch broadcast timers — flush dirty flights to all connected clients
var batchTimer = new Timer(_ => FlushDirtyBatch(_dirty), null, TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(1));

// Prevent GC from collecting timers in Release mode — JIT considers local vars dead after last use,
// so timers silently stop firing. Registering a shutdown callback keeps them reachable.
var allTimers = new[] { cacheTimer, purgeTimer, statsTimer, healthTimer, nasrTimer, batchTimer };
app.Lifetime.ApplicationStopping.Register(() => { foreach (var t in allTimers) t.Dispose(); });

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

    // XML element discovery: walk the flight element tree (first 10K messages only to minimize overhead)
    if (Interlocked.Read(ref _procCount) < 10_000)
    {
        WalkElements(flight, "flight", source);
        xmlSampleStore[source] = rawXml;
    }

    var state = flights.GetOrAdd(gufi, _ => new FlightState { Gufi = gufi });
    state.LastSeen = DateTime.UtcNow;
    state.LastMsgSource = source;

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

    // operator
    var op = flight.Descendants().FirstOrDefault(e => e.Name.LocalName == "organization" && e.Attribute("name") is not null);
    if (op is not null) state.Operator = op.Attribute("name")!.Value;

    // departure / arrival
    var dep = flight.Elements().FirstOrDefault(e => e.Name.LocalName == "departure");
    if (dep is not null)
    {
        var pt = dep.Attribute("departurePoint")?.Value;
        if (!string.IsNullOrEmpty(pt)) state.Origin = pt;
        var actTime = dep.Descendants().FirstOrDefault(e => e.Name.LocalName == "actual")?.Attribute("time")?.Value;
        if (!string.IsNullOrEmpty(actTime)) state.ActualDepartureTime = actTime;
    }
    var arr = flight.Elements().FirstOrDefault(e => e.Name.LocalName == "arrival");
    if (arr is not null)
    {
        var pt = arr.Attribute("arrivalPoint")?.Value;
        if (!string.IsNullOrEmpty(pt)) state.Destination = pt;
        var eta = arr.Descendants().FirstOrDefault(e => e.Name.LocalName == "estimated")?.Attribute("time")?.Value;
        if (!string.IsNullOrEmpty(eta)) state.ETA = eta;
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

    // interimAltitude — nil="true" means clear
    var ia = flight.Elements().FirstOrDefault(e => e.Name.LocalName == "interimAltitude");
    var prevIA = state.InterimAltitude;
    if (ia is not null)
    {
        var isNil = string.Equals(ia.Attribute("nil")?.Value, "true", StringComparison.OrdinalIgnoreCase);
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
        }
    }
    // Clear interim only when absent in LH (the dedicated interim altitude message type).
    // OH/FH omit the element because interim isn't their concern — absence means "no change".
    // Previously OH/FH also cleared here, but that was masked by WhenWritingNull dropping the
    // null from JSON. Now that nulls transmit, only LH should clear.
    else if (source is "LH")
    {
        state.InterimAltitude = null;
        if (prevIA.HasValue)
        {
            var logEntry = $"[{DateTime.UtcNow:HH:mm:ss}] {source} {state.Callsign ?? "?"}/{state.Gufi?[..8] ?? "?"} ctrl={state.ControllingFacility}/{state.ControllingSector} INTERIM: {prevIA} → CLEARED(absent in {source})";
            altitudeLog.Enqueue(logEntry);
            while (altitudeLog.Count > MaxAltitudeLogEntries) altitudeLog.TryDequeue(out _);
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

        // Point-out (PT, HT)
        var po = enRoute.Elements().FirstOrDefault(e => e.Name.LocalName == "pointout");
        if (po is not null)
        {
            var origUnit = po.Elements().FirstOrDefault(e => e.Name.LocalName == "originatingUnit");
            var recvUnit = po.Elements().FirstOrDefault(e => e.Name.LocalName == "receivingUnit");
            if (origUnit is not null) state.PointoutOriginatingUnit = FormatUnit(origUnit);
            if (recvUnit is not null) state.PointoutReceivingUnit = FormatUnit(recvUnit);
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
            state.ClearanceHeading = string.IsNullOrEmpty(clrHdg) ? null : clrHdg;
            state.ClearanceSpeed = string.IsNullOrEmpty(clrSpd) ? null : clrSpd;
            state.ClearanceText = string.IsNullOrEmpty(clrTxt) ? null : clrTxt;
        }
        else if (hadClearance)
        {
            // Flight HAS clearance data but this message has NO <cleared> element — log to see what source types arrive
            var logEntry = $"[{DateTime.UtcNow:HH:mm:ss}] {source} {state.Callsign ?? "?"}/{state.Gufi?[..8] ?? "?"} " +
                $"HAS_CLR(H={state.ClearanceHeading ?? "-"} S={state.ClearanceSpeed ?? "-"} T={state.ClearanceText ?? "-"}) " +
                $"NO_CLEARED_ELEM enRoute_children=[{string.Join(",", enRoute.Elements().Select(e => e.Name.LocalName))}]";
            clearanceLog.Enqueue(logEntry);
            while (clearanceLog.Count > MaxClearanceLogEntries) clearanceLog.TryDequeue(out _);
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
            if (recv is not null) state.HandoffReceiving = FormatUnit(recv);
            if (xfer is not null) state.HandoffTransferring = FormatUnit(xfer);
            if (acpt is not null) state.HandoffAccepting = FormatUnit(acpt);
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
        }

        // Surveillance
        var surv = acft.Descendants().FirstOrDefault(e => e.Name.LocalName == "surveillance");
        if (surv is not null)
        {
            var survCode = surv.Elements().FirstOrDefault(e => e.Name.LocalName == "surveillanceCode")?.Value;
            if (!string.IsNullOrEmpty(survCode)) state.SurveillanceCode = survCode;
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
            if (!string.IsNullOrEmpty(routeText)) state.Route = routeText;
            var rules = route.Attribute("initialFlightRules")?.Value;
            if (!string.IsNullOrEmpty(rules)) state.FlightRules = rules;

            var star = route.Descendants().FirstOrDefault(e => e.Name.LocalName == "nasadaptedArrivalRoute");
            if (star is not null) state.STAR = star.Attribute("nasRouteIdentifier")?.Value;
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

    // Add event to log
    state.AddEvent(new FlightEvent
    {
        Time = timestamp ?? DateTime.UtcNow.ToString("o"),
        Source = source,
        Centre = centre,
        Summary = BuildEventSummary(source, flight)
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

    // Mark flight dirty for batched broadcast (all updates batched every 1s)
    _dirty.TryAdd(gufi, 0);
}

string FormatUnit(XElement unit)
{
    var id = unit.Attribute("unitIdentifier")?.Value ?? "";
    var sec = unit.Attribute("sectorIdentifier")?.Value ?? "";
    return string.IsNullOrEmpty(sec) ? id : $"{id}/{sec}";
}

void WalkElements(XElement el, string path, string source)
{
    var key = $"{path}";
    xmlElements.AddOrUpdate(key, 1, (_, v) => v + 1);

    // Also record attributes at this path
    foreach (var attr in el.Attributes())
    {
        var attrKey = $"{path}/@{attr.Name.LocalName}";
        xmlElements.AddOrUpdate(attrKey, 1, (_, v) => v + 1);
    }

    foreach (var child in el.Elements())
    {
        var childName = child.Name.LocalName;
        WalkElements(child, $"{path}/{childName}", source);
    }
}

string BuildEventSummary(string source, XElement flight)
{
    return source switch
    {
        "TH" => "Track history update",
        "HZ" => BuildHzSummary(flight),
        "OH" => BuildOhSummary(flight),
        "FH" => "Flight plan update",
        "HP" => "Handoff proposal",
        "HU" => "Handoff update",
        "AH" => "Assumed/amended handoff",
        "HX" => "Handoff execution (route transfer)",
        "CL" => "Flight plan cancellation/clearance",
        "LH" => BuildLhSummary(flight),
        "NP" => "New flight plan",
        "PT" => BuildPtSummary(flight),
        "HT" => BuildPtSummary(flight),
        "DH" => "Departure handoff",
        "BA" => "Beacon code assignment",
        "RE" => "Beacon code reassignment",
        "RH" => "Radar handoff (drop)",
        "HV" => "Handoff void/complete",
        "HF" => "Handoff failure",
        _ => $"Message type: {source}"
    };
}

string BuildHzSummary(XElement flight)
{
    var pos = flight.Descendants().FirstOrDefault(e => e.Name.LocalName == "pos");
    var alt = flight.Elements().FirstOrDefault(e => e.Name.LocalName == "assignedAltitude");
    var altVal = alt?.Descendants().FirstOrDefault(e => e.Name.LocalName == "simple")?.Value;
    if (altVal is not null && double.TryParse(altVal, out var a))
        return $"Position update — assigned FL{a / 100:F0}";
    return "Position update";
}

string BuildOhSummary(XElement flight)
{
    var ho = flight.Descendants().FirstOrDefault(e => e.Name.LocalName == "handoff");
    if (ho is null) return "Handoff";
    var evt = ho.Attribute("event")?.Value ?? "";
    var recv = ho.Elements().FirstOrDefault(e => e.Name.LocalName == "receivingUnit");
    var xfer = ho.Elements().FirstOrDefault(e => e.Name.LocalName == "transferringUnit");
    return $"Handoff {evt}: {FormatUnit(xfer!)} → {FormatUnit(recv!)}";
}

string BuildLhSummary(XElement flight)
{
    var ia = flight.Elements().FirstOrDefault(e => e.Name.LocalName == "interimAltitude");
    if (ia is not null)
    {
        var isNil = string.Equals(ia.Attribute("nil")?.Value, "true", StringComparison.OrdinalIgnoreCase);
        if (isNil) return "Interim altitude cleared (nil)";
        if (double.TryParse(ia.Value, out var alt))
            return $"Interim altitude set: {alt:F0} ft";
    }
    return "Local handoff / interim altitude cleared";
}

string BuildPtSummary(XElement flight)
{
    var po = flight.Descendants().FirstOrDefault(e => e.Name.LocalName == "pointout");
    if (po is null) return "Point-out";
    var orig = po.Elements().FirstOrDefault(e => e.Name.LocalName == "originatingUnit");
    var recv = po.Elements().FirstOrDefault(e => e.Name.LocalName == "receivingUnit");
    if (orig is not null && recv is not null)
        return $"Point-out: {FormatUnit(orig)} → {FormatUnit(recv)}";
    return "Point-out";
}

void SendSnapshot(WsClient client)
{
    // Only send flights that would be visible on the scope — skip stale/position-less flights.
    // This reduces the snapshot from ~88MB (all 44K flights) to a few MB (active flights only).
    var now = DateTime.UtcNow;
    var summaries = flights.Values
        .Where(f =>
        {
            if (!f.Latitude.HasValue || !f.Longitude.HasValue) return false;
            if (f.FlightStatus == "CANCELLED") return false;
            var posAge = f.LastPositionTime == default ? int.MaxValue : (int)(now - f.LastPositionTime).TotalSeconds;
            if (f.FlightStatus == "DROPPED" && posAge > 60) return false;
            if (f.FlightStatus == "ACTIVE" && posAge > 600) return false;
            if (f.FlightStatus is not null and not "ACTIVE" and not "DROPPED") return false;
            return true;
        })
        .Select(f => f.ToSummary(includeHistory: true))
        .ToArray();
    Console.WriteLine($"[WS] Snapshot: {summaries.Length} visible flights (of {flights.Count} total)");
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
    if (dirtySet.IsEmpty || clients.IsEmpty) return;
    // Drain the dirty set atomically
    var gufis = dirtySet.Keys.ToArray();
    foreach (var g in gufis) dirtySet.TryRemove(g, out _);

    var summaries = new List<object>(gufis.Length);
    foreach (var gufi in gufis)
    {
        // Skip flights without position — client can't display them
        if (flights.TryGetValue(gufi, out var f) && f.Latitude.HasValue)
            summaries.Add(f.ToSummary());
    }
    if (summaries.Count == 0) return;
    Broadcast(new WsMsg("batch", summaries));
}

// ── NASR data loading & route resolution ─────────────────────────────────────

async Task LoadNasrData()
{
    var nasrDir = Path.Combine(Directory.GetCurrentDirectory(), "nasr-data");
    Directory.CreateDirectory(nasrDir);

    // Calculate current AIRAC cycle effective date
    // Reference: 2026-01-22 is a known AIRAC date; cycles are every 28 days
    var reference = new DateTime(2026, 1, 22, 0, 0, 0, DateTimeKind.Utc);
    var today = DateTime.UtcNow.Date;
    var daysSinceRef = (int)(today - reference).TotalDays;
    var cycleOffset = daysSinceRef >= 0 ? (daysSinceRef / 28) * 28 : ((daysSinceRef / 28) - 1) * 28;
    var effectiveDate = reference.AddDays(cycleOffset);
    var dateStr = effectiveDate.ToString("yyyy-MM-dd");

    var cycleDir = Path.Combine(nasrDir, dateStr);

    // Check if already loaded for this cycle
    if (nasrData?.EffectiveDate == dateStr)
    {
        Console.WriteLine($"[NASR] Already loaded cycle {dateStr}");
        return;
    }

    // Check for cached CSVs (re-download if new files like ILS_BASE.csv are missing)
    var navFile = Path.Combine(cycleDir, "NAV_BASE.csv");
    var ilsFile = Path.Combine(cycleDir, "ILS_BASE.csv");
    if (!File.Exists(navFile) || !File.Exists(ilsFile))
    {
        Console.WriteLine($"[NASR] Downloading cycle {dateStr}...");
        await DownloadNasr(effectiveDate, cycleDir);
    }

    if (!File.Exists(navFile))
    {
        Console.WriteLine("[NASR] CSV files not found after download attempt");
        return;
    }

    Console.WriteLine($"[NASR] Parsing cycle {dateStr}...");
    var data = new NasrData { EffectiveDate = dateStr };

    data.Navaids = ParseNavBase(Path.Combine(cycleDir, "NAV_BASE.csv"));
    Console.WriteLine($"[NASR]   Navaids: {data.Navaids.Count} identifiers");

    data.Fixes = ParseFixBase(Path.Combine(cycleDir, "FIX_BASE.csv"));
    Console.WriteLine($"[NASR]   Fixes: {data.Fixes.Count} identifiers");

    (data.Airports, data.AirportsIcao, data.AirportOverlay) = ParseAptBase(Path.Combine(cycleDir, "APT_BASE.csv"));
    Console.WriteLine($"[NASR]   Airports: {data.Airports.Count} FAA LIDs, {data.AirportsIcao.Count} ICAO, {data.AirportOverlay.Count} overlay (B/C/D/E)");

    data.Airways = ParseAwyBase(Path.Combine(cycleDir, "AWY_BASE.csv"));
    Console.WriteLine($"[NASR]   Airways: {data.Airways.Count} routes");

    // Parse SID/STAR procedures (optional — files may not exist)
    data.Procedures = new Dictionary<string, List<ProcedureDef>>(StringComparer.OrdinalIgnoreCase);
    data.ProceduresFull = new Dictionary<string, List<ProcedureFullDef>>(StringComparer.OrdinalIgnoreCase);
    try
    {
        var stars = ParseProcedureCsvs(cycleDir, "STAR", out var starsFull);
        foreach (var kv in stars) data.Procedures[kv.Key] = kv.Value;
        foreach (var kv in starsFull) data.ProceduresFull[kv.Key] = kv.Value;
        Console.WriteLine($"[NASR]   STARs: {stars.Count} procedures ({starsFull.Count} full)");
    }
    catch (Exception ex) { Console.WriteLine($"[NASR]   STAR parse skipped: {ex.Message}"); }
    try
    {
        var dps = ParseProcedureCsvs(cycleDir, "DP", out var dpsFull);
        foreach (var kv in dps)
        {
            if (data.Procedures.ContainsKey(kv.Key))
                data.Procedures[kv.Key].AddRange(kv.Value);
            else
                data.Procedures[kv.Key] = kv.Value;
        }
        foreach (var kv in dpsFull)
        {
            if (data.ProceduresFull.ContainsKey(kv.Key))
                data.ProceduresFull[kv.Key].AddRange(kv.Value);
            else
                data.ProceduresFull[kv.Key] = kv.Value;
        }
        Console.WriteLine($"[NASR]   DPs (SIDs): {dps.Count} procedures ({dpsFull.Count} full)");
    }
    catch (Exception ex) { Console.WriteLine($"[NASR]   DP parse skipped: {ex.Message}"); }

    // Parse ILS/LOC/LDA centerlines (optional)
    try
    {
        data.Centerlines = ParseIlsCenterlines(Path.Combine(cycleDir, "ILS_BASE.csv"));
        Console.WriteLine($"[NASR]   Centerlines: {data.Centerlines.Count} ILS/LOC/LDA approaches");
    }
    catch (Exception ex) { Console.WriteLine($"[NASR]   ILS parse skipped: {ex.Message}"); }

    nasrData = data;
    routeCache.Clear();
    Console.WriteLine($"[NASR] Loaded successfully — cycle {dateStr}");
}

async Task DownloadNasr(DateTime effectiveDate, string outputDir)
{
    Directory.CreateDirectory(outputDir);
    var dateUrl = effectiveDate.ToString("yyyy-MM-dd");
    var url = $"https://nfdc.faa.gov/webContent/28DaySub/28DaySubscription_Effective_{dateUrl}.zip";

    using var http = new HttpClient { Timeout = TimeSpan.FromMinutes(10) };
    Console.WriteLine($"[NASR] GET {url}");

    using var response = await http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead);
    if (!response.IsSuccessStatusCode)
    {
        Console.WriteLine($"[NASR] Download failed: {response.StatusCode}");
        return;
    }

    // Stream outer zip to temp file
    var tempZip = Path.Combine(outputDir, "outer.zip");
    await using (var fs = File.Create(tempZip))
        await response.Content.CopyToAsync(fs);

    var size = new FileInfo(tempZip).Length;
    Console.WriteLine($"[NASR] Downloaded {size / 1024 / 1024}MB, extracting CSV data...");

    // Find and extract the inner CSV zip
    var innerZipPath = Path.Combine(outputDir, "csv.zip");
    using (var outerZip = ZipFile.OpenRead(tempZip))
    {
        var csvZipEntry = outerZip.Entries.FirstOrDefault(e =>
            e.FullName.Contains("CSV_Data/", StringComparison.OrdinalIgnoreCase) &&
            e.Name.EndsWith("_CSV.zip", StringComparison.OrdinalIgnoreCase));

        if (csvZipEntry is null)
        {
            Console.WriteLine("[NASR] Could not find CSV zip inside subscription");
            outerZip.Dispose();
            File.Delete(tempZip);
            return;
        }

        csvZipEntry.ExtractToFile(innerZipPath, overwrite: true);
    } // outerZip closed here — safe to delete

    // Extract the CSV files we need from the inner zip
    var needed = new[] { "NAV_BASE.csv", "FIX_BASE.csv", "AWY_BASE.csv", "APT_BASE.csv", "ILS_BASE.csv" };
    // Also extract STAR, DP, and ILS procedure files
    using (var innerZip = ZipFile.OpenRead(innerZipPath))
    {
        foreach (var entry in innerZip.Entries)
        {
            var name = entry.Name;
            bool isNeeded = needed.Any(n => name.Equals(n, StringComparison.OrdinalIgnoreCase))
                || name.StartsWith("STAR_", StringComparison.OrdinalIgnoreCase) && name.EndsWith(".csv", StringComparison.OrdinalIgnoreCase)
                || name.StartsWith("DP_", StringComparison.OrdinalIgnoreCase) && name.EndsWith(".csv", StringComparison.OrdinalIgnoreCase)
                || name.StartsWith("ILS_", StringComparison.OrdinalIgnoreCase) && name.EndsWith(".csv", StringComparison.OrdinalIgnoreCase);
            if (isNeeded)
            {
                var dest = Path.Combine(outputDir, name);
                entry.ExtractToFile(dest, overwrite: true);
                Console.WriteLine($"[NASR]   Extracted {name} ({entry.Length / 1024}KB)");
            }
        }
    } // innerZip closed here — safe to delete

    // Cleanup temp zips
    File.Delete(tempZip);
    File.Delete(innerZipPath);
}

// ── CSV parsers ──

List<string> ParseCsvLine(string line)
{
    var fields = new List<string>();
    var i = 0;
    while (i < line.Length)
    {
        if (line[i] == '"')
        {
            var end = line.IndexOf('"', i + 1);
            if (end < 0) end = line.Length;
            fields.Add(line[(i + 1)..end]);
            i = end + 2; // skip closing quote + comma
        }
        else
        {
            var end = line.IndexOf(',', i);
            if (end < 0) end = line.Length;
            fields.Add(line[i..end]);
            i = end + 1;
        }
    }
    return fields;
}

int ColIdx(List<string> headers, string name) =>
    headers.FindIndex(h => h.Equals(name, StringComparison.OrdinalIgnoreCase));

Dictionary<string, List<NavPoint>> ParseNavBase(string path)
{
    var result = new Dictionary<string, List<NavPoint>>(StringComparer.OrdinalIgnoreCase);
    using var reader = new StreamReader(path);
    var headers = ParseCsvLine(reader.ReadLine()!);
    int iId = ColIdx(headers, "NAV_ID"), iLat = ColIdx(headers, "LAT_DECIMAL"), iLon = ColIdx(headers, "LONG_DECIMAL");
    int iType = ColIdx(headers, "NAV_TYPE");
    if (iId < 0 || iLat < 0 || iLon < 0) return result;

    while (reader.ReadLine() is { } line)
    {
        var f = ParseCsvLine(line);
        if (f.Count <= Math.Max(iId, Math.Max(iLat, iLon))) continue;
        if (!double.TryParse(f[iLat], out var lat) || !double.TryParse(f[iLon], out var lon)) continue;
        var id = f[iId].Trim();
        if (string.IsNullOrEmpty(id)) continue;
        var type = (iType >= 0 && iType < f.Count) ? f[iType].Trim() : "";
        if (!result.ContainsKey(id)) result[id] = new List<NavPoint>();
        result[id].Add(new NavPoint(id, lat, lon, type));
    }
    return result;
}

Dictionary<string, List<NavPoint>> ParseFixBase(string path)
{
    var result = new Dictionary<string, List<NavPoint>>(StringComparer.OrdinalIgnoreCase);
    using var reader = new StreamReader(path);
    var headers = ParseCsvLine(reader.ReadLine()!);
    int iId = ColIdx(headers, "FIX_ID"), iLat = ColIdx(headers, "LAT_DECIMAL"), iLon = ColIdx(headers, "LONG_DECIMAL");
    if (iId < 0 || iLat < 0 || iLon < 0) return result;

    while (reader.ReadLine() is { } line)
    {
        var f = ParseCsvLine(line);
        if (f.Count <= Math.Max(iId, Math.Max(iLat, iLon))) continue;
        if (!double.TryParse(f[iLat], out var lat) || !double.TryParse(f[iLon], out var lon)) continue;
        var id = f[iId].Trim();
        if (string.IsNullOrEmpty(id)) continue;
        if (!result.ContainsKey(id)) result[id] = new List<NavPoint>();
        result[id].Add(new NavPoint(id, lat, lon));
    }
    return result;
}

(Dictionary<string, NavPoint> byLid, Dictionary<string, NavPoint> byIcao, List<AirportOverlayPoint> overlay) ParseAptBase(string path)
{
    var byLid = new Dictionary<string, NavPoint>(StringComparer.OrdinalIgnoreCase);
    var byIcao = new Dictionary<string, NavPoint>(StringComparer.OrdinalIgnoreCase);
    var overlay = new List<AirportOverlayPoint>();
    using var reader = new StreamReader(path);
    var headers = ParseCsvLine(reader.ReadLine()!);
    int iId = ColIdx(headers, "ARPT_ID"), iIcao = ColIdx(headers, "ICAO_ID");
    int iLat = ColIdx(headers, "LAT_DECIMAL"), iLon = ColIdx(headers, "LONG_DECIMAL");
    int iSiteType = ColIdx(headers, "SITE_TYPE_CODE"), iUse = ColIdx(headers, "FACILITY_USE_CODE");
    int iStatus = ColIdx(headers, "ARPT_STATUS"), iTwr = ColIdx(headers, "TWR_TYPE_CODE");
    int iFar139 = ColIdx(headers, "FAR_139_TYPE_CODE");
    if (iId < 0 || iLat < 0 || iLon < 0) return (byLid, byIcao, overlay);

    while (reader.ReadLine() is { } line)
    {
        var f = ParseCsvLine(line);
        if (f.Count <= Math.Max(iId, Math.Max(iLat, iLon))) continue;
        if (!double.TryParse(f[iLat], out var lat) || !double.TryParse(f[iLon], out var lon)) continue;
        var lid = f[iId].Trim();
        if (string.IsNullOrEmpty(lid)) continue;
        var pt = new NavPoint(lid, lat, lon);
        byLid.TryAdd(lid, pt);
        var icao = "";
        if (iIcao >= 0 && iIcao < f.Count)
        {
            icao = f[iIcao].Trim();
            if (!string.IsNullOrEmpty(icao)) byIcao.TryAdd(icao, pt);
        }

        // Build airport overlay: public-use operational airports only
        var siteType = iSiteType >= 0 && iSiteType < f.Count ? f[iSiteType].Trim() : "";
        var use = iUse >= 0 && iUse < f.Count ? f[iUse].Trim() : "";
        var status = iStatus >= 0 && iStatus < f.Count ? f[iStatus].Trim() : "";
        if (siteType.Equals("A", StringComparison.OrdinalIgnoreCase) &&
            use.Equals("PU", StringComparison.OrdinalIgnoreCase) &&
            status.Equals("O", StringComparison.OrdinalIgnoreCase))
        {
            var twr = iTwr >= 0 && iTwr < f.Count ? f[iTwr].Trim() : "";
            var far139 = iFar139 >= 0 && iFar139 < f.Count ? f[iFar139].Trim() : "";

            // Derive airspace class from tower type + FAR 139 certification
            string cls;
            if (far139.StartsWith("I E", StringComparison.OrdinalIgnoreCase))
                cls = "B";
            else if (twr.Contains("TRACON", StringComparison.OrdinalIgnoreCase) ||
                     twr.Contains("RAPCON", StringComparison.OrdinalIgnoreCase) ||
                     twr.Contains("RATCF", StringComparison.OrdinalIgnoreCase) ||
                     twr.Contains("A/C", StringComparison.OrdinalIgnoreCase))
                cls = "C";
            else if (twr.StartsWith("ATCT", StringComparison.OrdinalIgnoreCase))
                cls = "D";
            else
                cls = "E";

            overlay.Add(new AirportOverlayPoint(lid, icao, lat, lon, cls));
        }
    }
    return (byLid, byIcao, overlay);
}

// Great-circle destination point from a given lat/lon, bearing (degrees), and distance (NM)
static (double lat, double lon) DestPoint(double lat, double lon, double brngDeg, double distNm)
{
    const double R = 3440.065; // earth radius in NM
    double d = distNm / R;
    double lat1 = lat * Math.PI / 180, lon1 = lon * Math.PI / 180, brng = brngDeg * Math.PI / 180;
    double lat2 = Math.Asin(Math.Sin(lat1) * Math.Cos(d) + Math.Cos(lat1) * Math.Sin(d) * Math.Cos(brng));
    double lon2 = lon1 + Math.Atan2(Math.Sin(brng) * Math.Sin(d) * Math.Cos(lat1),
                                     Math.Cos(d) - Math.Sin(lat1) * Math.Sin(lat2));
    return (lat2 * 180 / Math.PI, lon2 * 180 / Math.PI);
}

List<CenterlinePoint> ParseIlsCenterlines(string path)
{
    var result = new List<CenterlinePoint>();
    if (!File.Exists(path)) return result;

    using var reader = new StreamReader(path);
    var headers = ParseCsvLine(reader.ReadLine()!);

    int iApt = ColIdx(headers, "ARPT_ID");
    if (iApt < 0) iApt = ColIdx(headers, "FACILITY_SITE_NO"); // fallback
    int iRwy = ColIdx(headers, "RWY_END_ID");
    if (iRwy < 0) iRwy = ColIdx(headers, "RWY_ID");

    // System type — try multiple column names
    int iType = ColIdx(headers, "SYSTEM_TYPE");
    if (iType < 0) iType = ColIdx(headers, "ILS_COMP_TYPE_CODE");
    if (iType < 0) iType = ColIdx(headers, "ILS_TYPE");
    if (iType < 0) iType = ColIdx(headers, "SYSTEM_TYPE_CODE");

    int iLat = ColIdx(headers, "LAT_DECIMAL");
    int iLon = ColIdx(headers, "LONG_DECIMAL");

    // Approach bearing — try multiple column names
    int iBrg = ColIdx(headers, "LOC_BEARING");
    if (iBrg < 0) iBrg = ColIdx(headers, "APCH_BEAR");
    if (iBrg < 0) iBrg = ColIdx(headers, "MAG_BRG");
    if (iBrg < 0) iBrg = ColIdx(headers, "ILS_MAG_BRG");

    int iVar = ColIdx(headers, "MAG_VARN");
    if (iVar < 0) iVar = ColIdx(headers, "MAG_VAR");
    int iVarH = ColIdx(headers, "MAG_VAR_HEMIS");
    if (iVarH < 0) iVarH = ColIdx(headers, "MAG_VARN_HEMIS");
    if (iVarH < 0) iVarH = ColIdx(headers, "MAG_HEMIS");

    int iLen = ColIdx(headers, "RWY_LEN");
    if (iLen < 0) iLen = ColIdx(headers, "RWY_LENGTH");

    // Log discovered columns for debugging
    Console.WriteLine($"[NASR]   ILS columns: apt={iApt} rwy={iRwy} type={iType} lat={iLat} lon={iLon} brg={iBrg} var={iVar} varH={iVarH} len={iLen}");

    if (iApt < 0 || iLat < 0 || iLon < 0 || iBrg < 0) {
        Console.WriteLine("[NASR]   ILS_BASE.csv: missing required columns, skipping centerlines");
        Console.WriteLine($"[NASR]   Headers: {string.Join(", ", headers.Take(30))}");
        return result;
    }

    while (reader.ReadLine() is { } line)
    {
        var f = ParseCsvLine(line);
        var maxIdx = Math.Max(iApt, Math.Max(iLat, Math.Max(iLon, iBrg)));
        if (f.Count <= maxIdx) continue;

        // All records in ILS_BASE.csv are ILS/LOC/LDA/SDF approaches
        // System type codes: LS=ILS, LD=ILS/DME, LC=LOC, LE=LDA/DME, LG=LDA/GS, LA=LDA, SF=SDF, SD=SDF/DME, DD=DME
        // Skip DD (DME-only, no localizer component)
        if (iType >= 0 && iType < f.Count)
        {
            var sysType = f[iType].Trim().ToUpperInvariant();
            if (sysType == "DD") continue;
        }

        if (!double.TryParse(f[iLat], out var locLat) || !double.TryParse(f[iLon], out var locLon)) continue;
        if (!double.TryParse(f[iBrg], out var magBrg)) continue;

        // Magnetic variation → true bearing
        double magVar = 0;
        if (iVar >= 0 && iVar < f.Count && double.TryParse(f[iVar], out var mv))
        {
            var hemis = iVarH >= 0 && iVarH < f.Count ? f[iVarH].Trim().ToUpperInvariant() : "W";
            magVar = hemis == "E" ? mv : -mv;
        }
        double trueBrg = magBrg + magVar;

        // Runway length (feet) → NM; default to ~7000ft if missing
        double rwyLenFt = 7000;
        if (iLen >= 0 && iLen < f.Count && double.TryParse(f[iLen], out var lenFt) && lenFt > 0)
            rwyLenFt = lenFt;
        double rwyLenNm = rwyLenFt / 6076.12;

        // Reverse bearing = direction from localizer toward threshold (and beyond)
        double reverseBrg = trueBrg + 180;

        // Compute threshold (approx: localizer position + rwy length along reverse bearing)
        var threshold = DestPoint(locLat, locLon, reverseBrg, rwyLenNm);
        // Compute 15 NM endpoint from threshold
        var farPoint = DestPoint(threshold.lat, threshold.lon, reverseBrg, 15.0);

        var aptId = f[iApt].Trim();
        var rwyId = iRwy >= 0 && iRwy < f.Count ? f[iRwy].Trim() : "";

        result.Add(new CenterlinePoint(threshold.lat, threshold.lon, farPoint.lat, farPoint.lon, aptId, rwyId));
    }
    return result;
}

Dictionary<string, AirwayDef> ParseAwyBase(string path)
{
    var result = new Dictionary<string, AirwayDef>(StringComparer.OrdinalIgnoreCase);
    using var reader = new StreamReader(path);
    var headers = ParseCsvLine(reader.ReadLine()!);
    int iId = ColIdx(headers, "AWY_ID"), iDesig = ColIdx(headers, "AWY_DESIGNATION"), iStr = ColIdx(headers, "AIRWAY_STRING");
    if (iId < 0 || iStr < 0) return result;

    while (reader.ReadLine() is { } line)
    {
        var f = ParseCsvLine(line);
        if (f.Count <= Math.Max(iId, iStr)) continue;
        var id = f[iId].Trim();
        var desig = iDesig >= 0 && iDesig < f.Count ? f[iDesig].Trim() : "";
        var awyStr = f[iStr].Trim();
        if (string.IsNullOrEmpty(id) || string.IsNullOrEmpty(awyStr)) continue;
        var fixes = awyStr.Split(' ', StringSplitOptions.RemoveEmptyEntries).ToList();
        result.TryAdd(id, new AirwayDef(id, desig, fixes));
    }
    return result;
}

// Parse SID/STAR procedure CSV files — adaptive header detection
// These files have a route/leg structure with fix sequences per procedure
Dictionary<string, List<ProcedureDef>> ParseProcedureCsvs(string cycleDir, string type, out Dictionary<string, List<ProcedureFullDef>> fullResult)
{
    // type = "STAR" or "DP"
    // Files: {type}_BASE.csv has procedure name + airport, {type}_RTE.csv has fix sequences
    // Computer codes like "ALWYZ.FRDMM6" → route strings use the part after the dot ("FRDMM6")
    var result = new Dictionary<string, List<ProcedureDef>>(StringComparer.OrdinalIgnoreCase);
    fullResult = new Dictionary<string, List<ProcedureFullDef>>(StringComparer.OrdinalIgnoreCase);
    if (!Directory.Exists(cycleDir)) return result;

    var codeCol = type == "STAR" ? "STAR_COMPUTER_CODE" : "DP_COMPUTER_CODE";

    // Step 1: Parse BASE file to get computer_code → airport mapping
    var baseFile = Path.Combine(cycleDir, $"{type}_BASE.csv");
    var codeToAirports = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    if (File.Exists(baseFile))
    {
        using var br = new StreamReader(baseFile);
        var bh = ParseCsvLine(br.ReadLine()!);
        int iCode = bh.FindIndex(h => h.Trim().Equals(codeCol, StringComparison.OrdinalIgnoreCase));
        int iApt = bh.FindIndex(h => h.Trim().Equals("SERVED_ARPT", StringComparison.OrdinalIgnoreCase));
        if (iCode >= 0 && iApt >= 0)
        {
            while (br.ReadLine() is { } line)
            {
                var f = ParseCsvLine(line);
                if (f.Count > Math.Max(iCode, iApt))
                    codeToAirports[f[iCode].Trim()] = f[iApt].Trim().ToUpperInvariant();
            }
        }
        Console.WriteLine($"[NASR]   {type}_BASE: {codeToAirports.Count} procedures");
    }

    // Step 2: Parse RTE file to get fix sequences per computer code
    var rteFile = Path.Combine(cycleDir, $"{type}_RTE.csv");
    if (!File.Exists(rteFile))
    {
        Console.WriteLine($"[NASR]   {type}_RTE.csv not found");
        return result;
    }

    using var reader = new StreamReader(rteFile);
    var headers = ParseCsvLine(reader.ReadLine()!);

    int iRteCode = headers.FindIndex(h => h.Trim().Equals(codeCol, StringComparison.OrdinalIgnoreCase));
    int iFix = headers.FindIndex(h => h.Trim().Equals("POINT", StringComparison.OrdinalIgnoreCase));
    int iSeq = headers.FindIndex(h => h.Trim().Equals("POINT_SEQ", StringComparison.OrdinalIgnoreCase));
    int iRouteType = headers.FindIndex(h => h.Trim().Equals("ROUTE_PORTION_TYPE", StringComparison.OrdinalIgnoreCase));
    int iTransCode = headers.FindIndex(h => h.Trim().Equals("TRANSITION_COMPUTER_CODE", StringComparison.OrdinalIgnoreCase));
    int iRouteName = headers.FindIndex(h => h.Trim().Equals("ROUTE_NAME", StringComparison.OrdinalIgnoreCase));

    if (iRteCode < 0 || iFix < 0)
    {
        Console.WriteLine($"[NASR]   Missing columns: {codeCol}={iRteCode}, POINT={iFix}");
        return result;
    }

    // Read all rows grouped by computer code
    var rows = new List<(string code, string routeType, string routeName, string tranCode, int seq, string fix)>();
    while (reader.ReadLine() is { } line)
    {
        var f = ParseCsvLine(line);
        if (f.Count <= Math.Max(iRteCode, iFix)) continue;
        var code = f[iRteCode].Trim();
        var fix = f[iFix].Trim().ToUpperInvariant();
        if (string.IsNullOrEmpty(code) || string.IsNullOrEmpty(fix)) continue;

        var routeType = iRouteType >= 0 && iRouteType < f.Count ? f[iRouteType].Trim().ToUpperInvariant() : "";
        var routeName = iRouteName >= 0 && iRouteName < f.Count ? f[iRouteName].Trim() : "";
        var tranCode = iTransCode >= 0 && iTransCode < f.Count ? f[iTransCode].Trim() : "";
        var seq = 0;
        if (iSeq >= 0 && iSeq < f.Count) int.TryParse(f[iSeq].Trim(), out seq);
        rows.Add((code, routeType, routeName, tranCode, seq, fix));
    }

    // Group by computer code and build fix sequences
    // For BODY portions, extract only the common (non-runway-dependent) fixes:
    // each ROUTE_NAME is a separate leg (different runway); we keep only fixes shared by ALL legs,
    // then reverse them to flight direction (stored order is opposite to flight direction)
    var grouped = rows.GroupBy(r => r.code);
    foreach (var g in grouped)
    {
        var computerCode = g.Key;
        var bodyRows = g.Where(r => r.routeType == "BODY" || string.IsNullOrEmpty(r.routeType)).ToList();

        // Group body rows by ROUTE_NAME to get individual legs
        var legs = bodyRows
            .GroupBy(r => r.routeName)
            .Select(lg => lg.OrderBy(r => r.seq).Select(r => r.fix).Where(f => !string.IsNullOrEmpty(f)).ToList())
            .Where(leg => leg.Count > 0)
            .ToList();

        // Extract procedure identifier and airport (needed for both common and full defs)
        var dotIdx = computerCode.IndexOf('.');
        var afterDot = dotIdx >= 0 ? computerCode[(dotIdx + 1)..].Trim().ToUpperInvariant() : computerCode.Trim().ToUpperInvariant();
        var beforeDot = dotIdx >= 0 ? computerCode[..dotIdx].Trim().ToUpperInvariant() : computerCode.Trim().ToUpperInvariant();
        codeToAirports.TryGetValue(computerCode, out var airports);
        var airport = airports?.Split(' ', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault() ?? "";
        var identifiers = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (!string.IsNullOrEmpty(afterDot)) identifiers.Add(afterDot);
        if (!string.IsNullOrEmpty(beforeDot) && beforeDot != afterDot) identifiers.Add(beforeDot);

        // Build full leg data for procedure map overlay (all body legs + transitions)
        var allLegs = new List<List<string>>();
        foreach (var leg in legs)
        {
            var copy = new List<string>(leg);
            copy.Reverse(); // Reverse to flight direction
            if (copy.Count >= 2) allLegs.Add(copy);
        }
        var transGroups = g.Where(r => r.routeType == "TRANSITION").GroupBy(r => r.tranCode);
        foreach (var tg in transGroups)
        {
            var tranFixes = tg.OrderBy(r => r.seq).Select(r => r.fix)
                .Where(f => !string.IsNullOrEmpty(f)).ToList();
            tranFixes.Reverse();
            if (tranFixes.Count >= 2) allLegs.Add(tranFixes);
        }
        if (allLegs.Count > 0)
        {
            // Use the versioned name (with trailing digit) as canonical Id to avoid duplicates
            var procId = identifiers.FirstOrDefault(id => id.Length > 0 && char.IsDigit(id[^1])) ?? identifiers.First();
            var fDef = new ProcedureFullDef(procId, airport, type, allLegs);
            foreach (var ident in identifiers)
            {
                if (!fullResult.ContainsKey(ident)) fullResult[ident] = new List<ProcedureFullDef>();
                fullResult[ident].Add(fDef);
            }
        }

        // Build common (non-runway-dependent) body fixes for QU route resolution
        List<string> bodyFixes;
        if (legs.Count <= 1)
        {
            bodyFixes = (legs.Count == 1 ? legs[0] : bodyRows.OrderBy(r => r.seq).Select(r => r.fix)
                .Where(f => !string.IsNullOrEmpty(f)).Distinct().ToList());
            bodyFixes.Reverse();
        }
        else
        {
            var commonFixes = new HashSet<string>(legs[0], StringComparer.OrdinalIgnoreCase);
            foreach (var leg in legs.Skip(1))
                commonFixes.IntersectWith(leg);
            var shortestLeg = legs.OrderBy(l => l.Count).First();
            bodyFixes = shortestLeg.Where(f => commonFixes.Contains(f)).ToList();
            bodyFixes.Reverse();
        }

        if (bodyFixes.Count < 1) continue;

        // Build transitions for QU route resolution (enroute portions only, not runway legs)
        // SID transitions: stem → enroute (after body); STAR transitions: enroute → stem (before body)
        var transitions = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);
        foreach (var tg in transGroups)
        {
            var tranFixes = tg.OrderBy(r => r.seq).Select(r => r.fix)
                .Where(f => !string.IsNullOrEmpty(f)).ToList();
            tranFixes.Reverse(); // Reverse to flight direction
            if (tranFixes.Count < 2) continue;

            // Determine transition name from transition code: the part that ISN'T the procedure name
            var tc = tg.Key;
            var tdot = tc.IndexOf('.');
            string transName;
            if (tdot >= 0)
            {
                var tBefore = tc[..tdot].Trim().ToUpperInvariant();
                var tAfter = tc[(tdot + 1)..].Trim().ToUpperInvariant();
                transName = identifiers.Contains(tAfter) ? tBefore
                    : identifiers.Contains(tBefore) ? tAfter
                    : tAfter; // default to after-dot
            }
            else
            {
                transName = tc.Trim().ToUpperInvariant();
            }

            // Key by the enroute endpoint: SID = last fix, STAR = first fix
            var endpointKey = type == "DP" ? tranFixes[^1] : tranFixes[0];
            if (!string.IsNullOrEmpty(endpointKey))
                transitions[endpointKey] = tranFixes;
            // Also register by transition name
            if (!string.IsNullOrEmpty(transName) && !transitions.ContainsKey(transName))
                transitions[transName] = tranFixes;
        }

        foreach (var ident in identifiers)
        {
            var def = new ProcedureDef(ident, airport, type, bodyFixes, transitions);
            if (!result.ContainsKey(ident)) result[ident] = new List<ProcedureDef>();
            result[ident].Add(def);
        }
    }

    return result;
}

// ── Route resolver ──

List<double[]> ResolveRoute(string routeText, string? origin, string? destination, NasrData nasr)
{
    var waypoints = new List<double[]>();
    NavPoint? lastPt = null;

    // Add origin airport
    if (!string.IsNullOrEmpty(origin))
    {
        var apt = LookupAirport(origin, nasr);
        if (apt is not null) { waypoints.Add(new[] { apt.Lat, apt.Lon }); lastPt = apt; }
    }

    // Tokenize: split on spaces and dots, filter out DCT, "/", and empty tokens
    var tokens = routeText.Split(new[] { ' ', '.' }, StringSplitOptions.RemoveEmptyEntries)
        .Where(t => !t.Equals("DCT", StringComparison.OrdinalIgnoreCase) && t != "/")
        .ToArray();

    for (int i = 0; i < tokens.Length; i++)
    {
        var token = tokens[i].ToUpperInvariant();

        // Strip speed/altitude annotations (e.g., FIX/N0450F350)
        var slash = token.IndexOf('/');
        if (slash > 0) token = token[..slash];

        if (AirwayPattern.IsMatch(token))
        {
            // Airway: resolve intermediate fixes between entry and exit
            string? exitFix = null;
            if (i + 1 < tokens.Length)
            {
                exitFix = tokens[i + 1].ToUpperInvariant();
                var es = exitFix.IndexOf('/');
                if (es > 0) exitFix = exitFix[..es];
            }
            var awyPts = ResolveAirway(token, lastPt, exitFix, nasr);
            foreach (var pt in awyPts)
            {
                waypoints.Add(new[] { pt.Lat, pt.Lon });
                lastPt = pt;
            }
            if (exitFix is not null) i++; // skip exit fix (already included)
        }
        else
        {
            // Skip tokens that are just the origin/destination (already added)
            if (token == origin?.ToUpperInvariant() || token == destination?.ToUpperInvariant()) continue;

            // Fix/navaid/airport
            var pt = LookupPoint(token, lastPt, nasr);

            // If not found, try fix-radial-distance (FRD) format: {navaid}{radial:3}{distance:3}
            // e.g., SBY217078 = SBY VOR, radial 217°, 78nm
            if (pt is null && token.Length >= 8 && char.IsDigit(token[^1]))
            {
                var nameEnd = token.Length;
                while (nameEnd > 0 && char.IsDigit(token[nameEnd - 1])) nameEnd--;
                var digits = token[nameEnd..];
                var baseName = token[..nameEnd];
                if (digits.Length == 6 && nameEnd >= 2)
                {
                    // FRD: 3-digit radial + 3-digit distance
                    var basePt = LookupPoint(baseName, lastPt, nasr);
                    if (basePt is not null &&
                        int.TryParse(digits[..3], out var radial) &&
                        int.TryParse(digits[3..], out var distNm) &&
                        radial >= 0 && radial <= 360 && distNm > 0)
                    {
                        var (frdLat, frdLon) = ProjectPoint(basePt.Lat, basePt.Lon, radial, distNm);
                        pt = new NavPoint(token, frdLat, frdLon);
                    }
                }
                // Fallback: strip digits and use base navaid directly
                if (pt is null && nameEnd >= 2 && nameEnd < token.Length)
                    pt = LookupPoint(baseName, lastPt, nasr);
            }

            if (pt is not null)
            {
                waypoints.Add(new[] { pt.Lat, pt.Lon });
                lastPt = pt;
            }
            else if (nasr.Procedures.TryGetValue(token, out var procs))
            {
                // SID/STAR procedure — expand fix sequence (common non-runway-dependent portion + transitions)
                // Pick the procedure for the matching airport (origin for SID, destination for STAR)
                var proc = procs.Count == 1 ? procs[0]
                    : procs.FirstOrDefault(p =>
                        (!string.IsNullOrEmpty(origin) && p.Airport.Equals(origin.TrimStart('K'), StringComparison.OrdinalIgnoreCase)) ||
                        (!string.IsNullOrEmpty(destination) && p.Airport.Equals(destination.TrimStart('K'), StringComparison.OrdinalIgnoreCase)))
                    ?? procs[0];

                // STAR transitions: if lastPt matches a transition entry, prepend transition fixes before body
                if (proc.Type == "STAR" && proc.Transitions.Count > 0 && lastPt is not null)
                {
                    if (proc.Transitions.TryGetValue(lastPt.Ident, out var tranFixes))
                    {
                        // Transition goes enroute → stem; skip the first fix (already plotted as lastPt)
                        for (int ti = 1; ti < tranFixes.Count; ti++)
                        {
                            var tp = LookupPoint(tranFixes[ti], lastPt, nasr);
                            if (tp is not null) { waypoints.Add(new[] { tp.Lat, tp.Lon }); lastPt = tp; }
                        }
                    }
                }

                // SID: check if lastPt is already on a transition (aircraft past the stem, e.g., direct-to a transition fix)
                // Route like "REWET.BOBZY5.BNA" — REWET is on the BNA transition, skip body entirely
                bool sidTransitionHandled = false;
                if (proc.Type == "DP" && proc.Transitions.Count > 0 && lastPt is not null && i + 1 < tokens.Length)
                {
                    var nextToken = tokens[i + 1].ToUpperInvariant();
                    var nextSlash = nextToken.IndexOf('/');
                    if (nextSlash > 0) nextToken = nextToken[..nextSlash];
                    if (proc.Transitions.TryGetValue(nextToken, out var sidTranFixes))
                    {
                        // Check if lastPt is on this transition
                        int tranSkipIdx = -1;
                        for (int ti = 0; ti < sidTranFixes.Count; ti++)
                        {
                            if (sidTranFixes[ti].Equals(lastPt.Ident, StringComparison.OrdinalIgnoreCase))
                            { tranSkipIdx = ti + 1; break; }
                        }
                        if (tranSkipIdx >= 0)
                        {
                            // lastPt is on the transition → skip body, plot remaining transition fixes
                            for (int ti = tranSkipIdx; ti < sidTranFixes.Count; ti++)
                            {
                                var tp = LookupPoint(sidTranFixes[ti], lastPt, nasr);
                                if (tp is not null) { waypoints.Add(new[] { tp.Lat, tp.Lon }); lastPt = tp; }
                            }
                            i++; // skip next token (transition endpoint)
                            sidTransitionHandled = true;
                        }
                    }
                }

                if (!sidTransitionHandled)
                {
                    // Body expansion: skip ahead if lastPt is already on the procedure
                    int startIdx = 0;
                    if (lastPt is not null)
                    {
                        for (int fi = 0; fi < proc.Fixes.Count; fi++)
                        {
                            if (proc.Fixes[fi].Equals(lastPt.Ident, StringComparison.OrdinalIgnoreCase))
                            {
                                startIdx = fi + 1;
                                break;
                            }
                        }
                        // If not found by name, check by proximity (within 1nm)
                        if (startIdx == 0)
                        {
                            double bestDist = double.MaxValue;
                            int bestIdx = -1;
                            for (int fi = 0; fi < proc.Fixes.Count; fi++)
                            {
                                var fixPt2 = LookupPoint(proc.Fixes[fi], lastPt, nasr);
                                if (fixPt2 is not null)
                                {
                                    var d = HaversineNm(lastPt.Lat, lastPt.Lon, fixPt2.Lat, fixPt2.Lon);
                                    if (d < bestDist) { bestDist = d; bestIdx = fi; }
                                }
                            }
                            if (bestDist < 1.0 && bestIdx >= 0)
                                startIdx = bestIdx + 1;
                        }
                    }

                    for (int fi = startIdx; fi < proc.Fixes.Count; fi++)
                    {
                        var fixPt = LookupPoint(proc.Fixes[fi], lastPt, nasr);
                        if (fixPt is not null)
                        {
                            waypoints.Add(new[] { fixPt.Lat, fixPt.Lon });
                            lastPt = fixPt;
                        }
                    }

                    // SID transitions: after body, append transition fixes to reach enroute
                    if (proc.Type == "DP" && proc.Transitions.Count > 0 && i + 1 < tokens.Length)
                    {
                        var nextToken = tokens[i + 1].ToUpperInvariant();
                        var nextSlash = nextToken.IndexOf('/');
                        if (nextSlash > 0) nextToken = nextToken[..nextSlash];
                        if (proc.Transitions.TryGetValue(nextToken, out var sidTranFixes))
                        {
                            // Transition goes stem → enroute; skip fixes already plotted
                            for (int ti = 0; ti < sidTranFixes.Count; ti++)
                            {
                                if (lastPt is not null && sidTranFixes[ti].Equals(lastPt.Ident, StringComparison.OrdinalIgnoreCase))
                                    continue;
                                var tp = LookupPoint(sidTranFixes[ti], lastPt, nasr);
                                if (tp is not null) { waypoints.Add(new[] { tp.Lat, tp.Lon }); lastPt = tp; }
                            }
                            i++; // skip the next token (transition endpoint)
                        }
                    }
                }
            }
        }
    }

    // Add destination airport
    if (!string.IsNullOrEmpty(destination))
    {
        var apt = LookupAirport(destination, nasr);
        if (apt is not null) waypoints.Add(new[] { apt.Lat, apt.Lon });
    }

    return waypoints;
}

NavPoint? LookupAirport(string code, NasrData nasr)
{
    // Try ICAO first (KDCA), then FAA LID (DCA), then strip K prefix
    if (nasr.AirportsIcao.TryGetValue(code, out var apt)) return apt;
    if (nasr.Airports.TryGetValue(code, out apt)) return apt;
    if (code.Length == 4 && code.StartsWith("K") && nasr.Airports.TryGetValue(code[1..], out apt)) return apt;
    return null;
}

double HaversineNm(double lat1, double lon1, double lat2, double lon2)
{
    const double R = 3440.065;
    var dLat = (lat2 - lat1) * Math.PI / 180;
    var dLon = (lon2 - lon1) * Math.PI / 180;
    var a = Math.Sin(dLat / 2) * Math.Sin(dLat / 2) +
            Math.Cos(lat1 * Math.PI / 180) * Math.Cos(lat2 * Math.PI / 180) *
            Math.Sin(dLon / 2) * Math.Sin(dLon / 2);
    return R * 2 * Math.Atan2(Math.Sqrt(a), Math.Sqrt(1 - a));
}

// Project a point from lat/lon along a bearing for a given distance (great circle)
(double Lat, double Lon) ProjectPoint(double lat, double lon, double bearingDeg, double distNm)
{
    const double R = 3440.065; // Earth radius in nm
    var d = distNm / R;
    var brng = bearingDeg * Math.PI / 180;
    var lat1 = lat * Math.PI / 180;
    var lon1 = lon * Math.PI / 180;
    var lat2 = Math.Asin(Math.Sin(lat1) * Math.Cos(d) + Math.Cos(lat1) * Math.Sin(d) * Math.Cos(brng));
    var lon2 = lon1 + Math.Atan2(Math.Sin(brng) * Math.Sin(d) * Math.Cos(lat1),
                                  Math.Cos(d) - Math.Sin(lat1) * Math.Sin(lat2));
    return (lat2 * 180 / Math.PI, lon2 * 180 / Math.PI);
}

NavPoint? LookupPoint(string ident, NavPoint? near, NasrData nasr)
{
    // Collect candidates from navaids, fixes, airports
    var candidates = new List<NavPoint>();
    if (nasr.Navaids.TryGetValue(ident, out var navs)) candidates.AddRange(navs);
    if (nasr.Fixes.TryGetValue(ident, out var fixes)) candidates.AddRange(fixes);
    if (nasr.Airports.TryGetValue(ident, out var apt)) candidates.Add(apt);
    if (nasr.AirportsIcao.TryGetValue(ident, out apt)) candidates.Add(apt);
    // Try stripping K prefix for airports
    if (ident.Length == 4 && ident.StartsWith("K") && nasr.Airports.TryGetValue(ident[1..], out apt))
        candidates.Add(apt);

    if (candidates.Count == 0) return null;
    if (candidates.Count == 1 || near is null) return candidates[0];

    // Disambiguate by proximity to last point
    return candidates.MinBy(c => DistSq(c.Lat, c.Lon, near.Lat, near.Lon));
}

List<NavPoint> ResolveAirway(string airwayId, NavPoint? entryPt, string? exitFix, NasrData nasr)
{
    if (!nasr.Airways.TryGetValue(airwayId, out var awy)) return new List<NavPoint>();

    var fixList = awy.Fixes;
    if (fixList.Count == 0) return new List<NavPoint>();

    // Find entry index (closest to entryPt)
    int entryIdx = 0;
    if (entryPt is not null)
    {
        double bestDist = double.MaxValue;
        for (int i = 0; i < fixList.Count; i++)
        {
            var pt = LookupPoint(fixList[i], null, nasr);
            if (pt is null) continue;
            var d = DistSq(pt.Lat, pt.Lon, entryPt.Lat, entryPt.Lon);
            if (d < bestDist) { bestDist = d; entryIdx = i; }
        }
    }

    // Find exit index (by name match)
    int exitIdx = fixList.Count - 1;
    if (exitFix is not null)
    {
        for (int i = 0; i < fixList.Count; i++)
        {
            if (fixList[i].Equals(exitFix, StringComparison.OrdinalIgnoreCase))
            {
                exitIdx = i;
                break;
            }
        }
    }

    // Build waypoint list between entry and exit (inclusive)
    var result = new List<NavPoint>();
    int step = entryIdx <= exitIdx ? 1 : -1;
    for (int i = entryIdx; i != exitIdx + step; i += step)
    {
        if (i < 0 || i >= fixList.Count) break;
        var pt = LookupPoint(fixList[i], result.Count > 0 ? result[^1] : entryPt, nasr);
        if (pt is not null) result.Add(pt);
    }
    return result;
}

double DistSq(double lat1, double lon1, double lat2, double lon2)
{
    var dlat = lat1 - lat2;
    var dlon = (lon1 - lon2) * Math.Cos(lat1 * Math.PI / 180);
    return dlat * dlat + dlon * dlon;
}

// ── Types ───────────────────────────────────────────────────────────────────

record WsMsg(string Type, object Data);

class WsClient(WebSocket ws)
{
    public WebSocket Ws { get; } = ws;
    public Channel<byte[]> Queue { get; } = Channel.CreateBounded<byte[]>(
        new BoundedChannelOptions(512)
        {
            FullMode = BoundedChannelFullMode.DropOldest,
            SingleReader = true
        });

    public void Enqueue(byte[] data)
    {
        Queue.Writer.TryWrite(data);
    }
}

record NavPoint(string Ident, double Lat, double Lon, string Type = "");
record AirportOverlayPoint(string Lid, string Icao, double Lat, double Lon, string Cls);
record CenterlinePoint(double Lat1, double Lon1, double Lat2, double Lon2, string Apt, string Rwy);
record AirwayDef(string Id, string Designation, List<string> Fixes);

record ProcedureDef(string Id, string Airport, string Type, List<string> Fixes, Dictionary<string, List<string>> Transitions); // Type = "STAR" or "DP"; Transitions keyed by enroute fix name
record ProcedureFullDef(string Id, string Airport, string Type, List<List<string>> Legs); // All body legs + transitions for map overlay
record PositionRecord(double Lat, double Lon, long Ticks, char Sym);

class NasrData
{
    public Dictionary<string, List<NavPoint>> Navaids { get; set; } = new();
    public Dictionary<string, List<NavPoint>> Fixes { get; set; } = new();
    public Dictionary<string, NavPoint> Airports { get; set; } = new();
    public Dictionary<string, NavPoint> AirportsIcao { get; set; } = new();
    public Dictionary<string, AirwayDef> Airways { get; set; } = new();
    public Dictionary<string, List<ProcedureDef>> Procedures { get; set; } = new(); // name → list (may have same name at different airports)
    public Dictionary<string, List<ProcedureFullDef>> ProceduresFull { get; set; } = new(); // full legs for map overlay
    public List<AirportOverlayPoint> AirportOverlay { get; set; } = new(); // public airports with derived airspace class
    public List<CenterlinePoint> Centerlines { get; set; } = new(); // ILS/LOC/LDA approach centerlines
    public string EffectiveDate { get; set; } = "";
}

class FlightState
{
    public string Gufi { get; set; } = "";
    public string? FdpsGufi { get; set; }
    public string? Callsign { get; set; }
    public string? ComputerId { get; set; }
    public ConcurrentDictionary<string, string> ComputerIds { get; } = new();
    public string? Operator { get; set; }
    public string? FlightStatus { get; set; }
    public string? Origin { get; set; }
    public string? Destination { get; set; }
    public string? AircraftType { get; set; }
    public string? Registration { get; set; }
    public string? WakeCategory { get; set; }
    public string? ModeSCode { get; set; }
    public string? EquipmentQualifier { get; set; }
    public string? Squawk { get; set; }            // Current/received beacon code
    public string? AssignedSquawk { get; set; }     // Controller-assigned beacon code (from BA/RE messages)
    public string? FlightRules { get; set; }
    public string? Route { get; set; }
    public string? STAR { get; set; }
    public string? Remarks { get; set; }

    // Altitude
    public double? AssignedAltitude { get; set; }
    public bool AssignedVfr { get; set; }          // true for <vfr/> or <vfrPlus>
    public double? BlockFloor { get; set; }        // block altitude lower bound (feet)
    public double? BlockCeiling { get; set; }      // block altitude upper bound (feet)
    public double? InterimAltitude { get; set; }
    public double? ReportedAltitude { get; set; }

    // Position
    public double? Latitude { get; set; }
    public double? Longitude { get; set; }
    public double? GroundSpeed { get; set; }
    public double? RequestedSpeed { get; set; }
    public double? TrackVelocityX { get; set; }
    public double? TrackVelocityY { get; set; }

    // Times
    public string? ActualDepartureTime { get; set; }
    public string? ETA { get; set; }
    public string? CoordinationTime { get; set; }
    public string? CoordinationFix { get; set; }

    // Ownership / handoff
    public string? ReportingFacility { get; set; }
    public string? ControllingFacility { get; set; }
    public string? ControllingSector { get; set; }
    public string? HandoffEvent { get; set; }
    public string? HandoffReceiving { get; set; }
    public string? HandoffTransferring { get; set; }
    public string? HandoffAccepting { get; set; }
    public bool HandoffForced { get; set; } // true when handoff accepted via /OK (AH message)

    // Point-out
    public string? PointoutOriginatingUnit { get; set; }
    public string? PointoutReceivingUnit { get; set; }
    public DateTime? PointoutTimestamp { get; set; }

    // Clearance data (from NasClearedFlightInformationType — heading, speed, text)
    public string? ClearanceHeading { get; set; }
    public string? ClearanceSpeed { get; set; }
    public string? ClearanceText { get; set; }
    public string? FourthAdaptedField { get; set; }

    // Traffic Management Initiatives
    public string? TmiIds { get; set; }

    // Datalink / CPDLC
    public string? CommunicationCode { get; set; }
    public string? DataLinkCode { get; set; }
    public string? OtherDataLink { get; set; }
    public string? SELCAL { get; set; }
    public string? NavigationCode { get; set; }
    public string? PBNCode { get; set; }
    public string? SurveillanceCode { get; set; }

    // Meta
    public DateTime LastSeen { get; set; }
    public DateTime LastPositionTime { get; set; }
    public string? LastMsgSource { get; set; }

    // Position history (server-side, survives client refresh)
    private readonly List<PositionRecord> _posHistory = new();
    private const int MaxPosHistory = 20;

    public void AddPosition(double lat, double lon, char sym)
    {
        lock (_posHistory)
        {
            _posHistory.Add(new PositionRecord(lat, lon, DateTime.UtcNow.Ticks, sym));
            if (_posHistory.Count > MaxPosHistory) _posHistory.RemoveAt(0);
        }
    }

    public List<PositionRecord> GetPositionHistory()
    {
        lock (_posHistory) { return new(_posHistory); }
    }

    private readonly List<FlightEvent> _events = new();
    private const int MaxEvents = 50;

    public void AddEvent(FlightEvent e)
    {
        lock (_events)
        {
            _events.Add(e);
            if (_events.Count > MaxEvents) _events.RemoveAt(0);
        }
    }

    public List<FlightEvent> GetEvents()
    {
        lock (_events) { return new(_events); }
    }

    public void RestorePosition(PositionRecord rec)
    {
        lock (_posHistory) { _posHistory.Add(rec); }
    }

    public FlightSnapshot ToSnapshot() => new()
    {
        Gufi = Gufi, FdpsGufi = FdpsGufi, Callsign = Callsign,
        ComputerId = ComputerId,
        ComputerIds = ComputerIds.IsEmpty ? null : new Dictionary<string, string>(ComputerIds),
        Operator = Operator, FlightStatus = FlightStatus,
        Origin = Origin, Destination = Destination, AircraftType = AircraftType,
        Registration = Registration, WakeCategory = WakeCategory,
        ModeSCode = ModeSCode, EquipmentQualifier = EquipmentQualifier,
        Squawk = Squawk, AssignedSquawk = AssignedSquawk, FlightRules = FlightRules,
        Route = Route, STAR = STAR, Remarks = Remarks,
        AssignedAltitude = AssignedAltitude, AssignedVfr = AssignedVfr,
        BlockFloor = BlockFloor, BlockCeiling = BlockCeiling,
        InterimAltitude = InterimAltitude, ReportedAltitude = ReportedAltitude,
        Latitude = Latitude, Longitude = Longitude,
        GroundSpeed = GroundSpeed, RequestedSpeed = RequestedSpeed,
        TrackVelocityX = TrackVelocityX, TrackVelocityY = TrackVelocityY,
        ActualDepartureTime = ActualDepartureTime, ETA = ETA,
        CoordinationTime = CoordinationTime, CoordinationFix = CoordinationFix,
        ReportingFacility = ReportingFacility,
        ControllingFacility = ControllingFacility, ControllingSector = ControllingSector,
        HandoffEvent = HandoffEvent, HandoffReceiving = HandoffReceiving,
        HandoffTransferring = HandoffTransferring, HandoffAccepting = HandoffAccepting,
        HandoffForced = HandoffForced,
        PointoutOriginatingUnit = PointoutOriginatingUnit, PointoutReceivingUnit = PointoutReceivingUnit,
        ClearanceHeading = ClearanceHeading, ClearanceSpeed = ClearanceSpeed,
        ClearanceText = ClearanceText, FourthAdaptedField = FourthAdaptedField,
        TmiIds = TmiIds,
        CommunicationCode = CommunicationCode, DataLinkCode = DataLinkCode,
        OtherDataLink = OtherDataLink, SELCAL = SELCAL,
        NavigationCode = NavigationCode, PBNCode = PBNCode, SurveillanceCode = SurveillanceCode,
        LastSeen = LastSeen, LastMsgSource = LastMsgSource,
        PosHistory = GetPositionHistory(),
        Events = GetEvents()
    };

    public static FlightState FromSnapshot(FlightSnapshot s)
    {
        var f = new FlightState
        {
            Gufi = s.Gufi, FdpsGufi = s.FdpsGufi, Callsign = s.Callsign,
            ComputerId = s.ComputerId,
            Operator = s.Operator, FlightStatus = s.FlightStatus,
            Origin = s.Origin, Destination = s.Destination, AircraftType = s.AircraftType,
            Registration = s.Registration, WakeCategory = s.WakeCategory,
            ModeSCode = s.ModeSCode, EquipmentQualifier = s.EquipmentQualifier,
            Squawk = s.Squawk, AssignedSquawk = s.AssignedSquawk, FlightRules = s.FlightRules,
            Route = s.Route, STAR = s.STAR, Remarks = s.Remarks,
            AssignedAltitude = s.AssignedAltitude, AssignedVfr = s.AssignedVfr,
            BlockFloor = s.BlockFloor, BlockCeiling = s.BlockCeiling,
            InterimAltitude = s.InterimAltitude, ReportedAltitude = s.ReportedAltitude,
            Latitude = s.Latitude, Longitude = s.Longitude,
            GroundSpeed = s.GroundSpeed, RequestedSpeed = s.RequestedSpeed,
            TrackVelocityX = s.TrackVelocityX, TrackVelocityY = s.TrackVelocityY,
            ActualDepartureTime = s.ActualDepartureTime, ETA = s.ETA,
            CoordinationTime = s.CoordinationTime, CoordinationFix = s.CoordinationFix,
            ReportingFacility = s.ReportingFacility,
            ControllingFacility = s.ControllingFacility, ControllingSector = s.ControllingSector,
            HandoffEvent = s.HandoffEvent, HandoffReceiving = s.HandoffReceiving,
            HandoffTransferring = s.HandoffTransferring, HandoffAccepting = s.HandoffAccepting,
            HandoffForced = s.HandoffForced,
            PointoutOriginatingUnit = s.PointoutOriginatingUnit, PointoutReceivingUnit = s.PointoutReceivingUnit,
            ClearanceHeading = s.ClearanceHeading, ClearanceSpeed = s.ClearanceSpeed,
            ClearanceText = s.ClearanceText, FourthAdaptedField = s.FourthAdaptedField,
            TmiIds = s.TmiIds,
            CommunicationCode = s.CommunicationCode, DataLinkCode = s.DataLinkCode,
            OtherDataLink = s.OtherDataLink, SELCAL = s.SELCAL,
            NavigationCode = s.NavigationCode, PBNCode = s.PBNCode, SurveillanceCode = s.SurveillanceCode,
            LastSeen = s.LastSeen, LastMsgSource = s.LastMsgSource,
            LastPositionTime = s.Latitude.HasValue ? s.LastSeen : default
        };
        if (s.ComputerIds is not null)
            foreach (var kv in s.ComputerIds) f.ComputerIds[kv.Key] = kv.Value;
        if (s.PosHistory is not null)
            foreach (var p in s.PosHistory) f.RestorePosition(p);
        if (s.Events is not null)
            foreach (var e in s.Events) f.AddEvent(e);
        return f;
    }

    public object ToSummary(bool includeHistory = false) => new
    {
        Gufi, Callsign, ComputerId,
        ComputerIds = ComputerIds.IsEmpty ? null : new Dictionary<string, string>(ComputerIds),
        Operator, FlightStatus,
        Origin, Destination, AircraftType, WakeCategory,
        AssignedAltitude, AssignedVfr, BlockFloor, BlockCeiling,
        InterimAltitude, ReportedAltitude,
        Latitude, Longitude, GroundSpeed, Squawk, AssignedSquawk,
        TrackVelocityX, TrackVelocityY,
        ControllingFacility, ControllingSector,
        ReportingFacility,
        HandoffEvent, HandoffReceiving, HandoffTransferring, HandoffAccepting, HandoffForced,
        PointoutOriginatingUnit, PointoutReceivingUnit,
        ClearanceHeading, ClearanceSpeed, ClearanceText,
        DataLinkCode, OtherDataLink,
        Route, FlightRules, STAR, Remarks,
        Registration, EquipmentQualifier, RequestedSpeed,
        CoordinationFix, CoordinationTime,
        ETA, ActualDepartureTime,
        LastMsgSource,
        LastSeen = LastSeen.ToString("HH:mm:ss"),
        PosAge = LastPositionTime == default ? (int?)null : (int)(DateTime.UtcNow - LastPositionTime).TotalSeconds,
        History = includeHistory ? HistoryWithAge() : null
    };

    private object[] HistoryWithAge()
    {
        var nowTicks = DateTime.UtcNow.Ticks;
        return GetPositionHistory().Select(h => new {
            h.Lat, h.Lon, Sym = h.Sym.ToString(),
            Age = (int)((nowTicks - h.Ticks) / TimeSpan.TicksPerSecond)
        }).ToArray();
    }

    public object ToDetail()
    {
        List<object> events;
        lock (_events) { events = _events.Select(e => (object)e).ToList(); }
        return new
        {
            Gufi, FdpsGufi, Callsign, ComputerId,
            ComputerIds = ComputerIds.IsEmpty ? null : new Dictionary<string, string>(ComputerIds),
            Operator, FlightStatus,
            Origin, Destination, AircraftType, Registration, WakeCategory,
            ModeSCode, EquipmentQualifier, Squawk, AssignedSquawk, FlightRules,
            Route, STAR, Remarks,
            AssignedAltitude, AssignedVfr, BlockFloor, BlockCeiling,
            InterimAltitude, ReportedAltitude,
            Latitude, Longitude, GroundSpeed, RequestedSpeed,
            ActualDepartureTime, ETA, CoordinationTime, CoordinationFix,
            ReportingFacility, ControllingFacility, ControllingSector,
            HandoffEvent, HandoffReceiving, HandoffTransferring, HandoffAccepting, HandoffForced,
            PointoutOriginatingUnit, PointoutReceivingUnit,
            ClearanceHeading, ClearanceSpeed, ClearanceText, FourthAdaptedField, TmiIds,
            CommunicationCode, DataLinkCode, OtherDataLink, SELCAL,
            NavigationCode, PBNCode, SurveillanceCode,
            LastMsgSource, LastSeen = LastSeen.ToString("o"),
            Events = events,
            History = HistoryWithAge()
        };
    }
}

class FlightEvent
{
    public string Time { get; set; } = "";
    public string Source { get; set; } = "";
    public string Centre { get; set; } = "";
    public string Summary { get; set; } = "";
}

class FlightSnapshot
{
    public string Gufi { get; set; } = "";
    public string? FdpsGufi { get; set; }
    public string? Callsign { get; set; }
    public string? ComputerId { get; set; }
    public Dictionary<string, string>? ComputerIds { get; set; }
    public string? Operator { get; set; }
    public string? FlightStatus { get; set; }
    public string? Origin { get; set; }
    public string? Destination { get; set; }
    public string? AircraftType { get; set; }
    public string? Registration { get; set; }
    public string? WakeCategory { get; set; }
    public string? ModeSCode { get; set; }
    public string? EquipmentQualifier { get; set; }
    public string? Squawk { get; set; }
    public string? AssignedSquawk { get; set; }
    public string? FlightRules { get; set; }
    public string? Route { get; set; }
    public string? STAR { get; set; }
    public string? Remarks { get; set; }
    public double? AssignedAltitude { get; set; }
    public bool AssignedVfr { get; set; }
    public double? BlockFloor { get; set; }
    public double? BlockCeiling { get; set; }
    public double? InterimAltitude { get; set; }
    public double? ReportedAltitude { get; set; }
    public double? Latitude { get; set; }
    public double? Longitude { get; set; }
    public double? GroundSpeed { get; set; }
    public double? RequestedSpeed { get; set; }
    public double? TrackVelocityX { get; set; }
    public double? TrackVelocityY { get; set; }
    public string? ActualDepartureTime { get; set; }
    public string? ETA { get; set; }
    public string? CoordinationTime { get; set; }
    public string? CoordinationFix { get; set; }
    public string? ReportingFacility { get; set; }
    public string? ControllingFacility { get; set; }
    public string? ControllingSector { get; set; }
    public string? HandoffEvent { get; set; }
    public string? HandoffReceiving { get; set; }
    public string? HandoffTransferring { get; set; }
    public string? HandoffAccepting { get; set; }
    public bool HandoffForced { get; set; }
    public string? PointoutOriginatingUnit { get; set; }
    public string? PointoutReceivingUnit { get; set; }
    public string? ClearanceHeading { get; set; }
    public string? ClearanceSpeed { get; set; }
    public string? ClearanceText { get; set; }
    public string? FourthAdaptedField { get; set; }
    public string? TmiIds { get; set; }
    public string? CommunicationCode { get; set; }
    public string? DataLinkCode { get; set; }
    public string? OtherDataLink { get; set; }
    public string? SELCAL { get; set; }
    public string? NavigationCode { get; set; }
    public string? PBNCode { get; set; }
    public string? SurveillanceCode { get; set; }
    public DateTime LastSeen { get; set; }
    public string? LastMsgSource { get; set; }
    public List<PositionRecord>? PosHistory { get; set; }
    public List<FlightEvent>? Events { get; set; }
}

class FlightCache
{
    public DateTime SavedAt { get; set; }
    public List<FlightSnapshot> Flights { get; set; } = new();
}

class GlobalStats
{
    public bool Connected { get; set; }
    private long _total;
    private readonly DateTime _startTime = DateTime.UtcNow;

    public long IncrementTotal() => Interlocked.Increment(ref _total);

    public object Snapshot(int flightCount = 0)
    {
        var elapsed = (DateTime.UtcNow - _startTime).TotalSeconds;
        return new
        {
            Connected,
            Total = _total,
            Rate = elapsed > 0 ? Math.Round(_total / elapsed, 1) : 0,
            Elapsed = (DateTime.UtcNow - _startTime).ToString(@"hh\:mm\:ss"),
            Flights = flightCount
        };
    }
}
