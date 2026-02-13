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
var jsonOpts = new JsonSerializerOptions
{
    PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
};

// ── ASP.NET Core setup ──────────────────────────────────────────────────────

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.UseUrls("http://0.0.0.0:5001");
var app = builder.Build();

app.UseDefaultFiles();
app.UseStaticFiles();
app.UseWebSockets();

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

// Serve KML files from repo root
var repoRoot = FindRepoRoot(app.Environment.ContentRootPath);

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

solaceThread.Start();

// Purge stale flights every 60 seconds
var purgeTimer = new Timer(_ =>
{
    var cutoff = DateTime.UtcNow.AddMinutes(-60);
    foreach (var (gufi, f) in flights)
    {
        if (f.LastSeen < cutoff)
        {
            flights.TryRemove(gufi, out FlightState? _);
            Broadcast(new WsMsg("remove", new { gufi }));
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
        if (Interlocked.Increment(ref _noGufiCount) <= 3)
            Console.WriteLine($"[DBG] No gufi, children: {string.Join(", ", flight.Elements().Select(e => e.Name.LocalName))}");
        return;
    }

    if (Interlocked.Increment(ref _procCount) <= 3)
        Console.WriteLine($"[DBG] ProcessFlight OK gufi={gufi[..8]}.. flights.Count={flights.Count}");

    var source = flight.Attribute("source")?.Value ?? "";
    var centre = flight.Attribute("centre")?.Value ?? "";
    var timestamp = flight.Attribute("timestamp")?.Value;

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

    // assignedAltitude
    var aa = flight.Elements().FirstOrDefault(e => e.Name.LocalName == "assignedAltitude");
    if (aa is not null)
    {
        var val = aa.Descendants().FirstOrDefault(e => e.Name.LocalName == "simple")?.Value;
        if (double.TryParse(val, out var alt)) state.AssignedAltitude = alt;
    }

    // interimAltitude (fourth line!)
    var ia = flight.Elements().FirstOrDefault(e => e.Name.LocalName == "interimAltitude");
    if (ia is not null)
    {
        if (double.TryParse(ia.Value, out var ival)) state.InterimAltitude = ival;
    }
    // Clear interim if this is a message type that would have it but doesn't (LH cleared)
    else if (source == "LH") state.InterimAltitude = null;

    // controllingUnit
    var cu = flight.Elements().FirstOrDefault(e => e.Name.LocalName == "controllingUnit");
    if (cu is not null)
    {
        var newFac = cu.Attribute("unitIdentifier")?.Value ?? "";
        var newSec = cu.Attribute("sectorIdentifier")?.Value ?? "";
        if (state.ControllingFacility != newFac || state.ControllingSector != newSec)
        {
            Console.WriteLine($"[CU] {DateTime.UtcNow:HH:mm:ss.fff} {state.Callsign ?? "?"} gufi={gufi[..Math.Min(8, gufi.Length)]}.. ctrl={state.ControllingFacility}/{state.ControllingSector} -> {newFac}/{newSec} src={source} ho={state.HandoffEvent}");
        }
        state.ControllingFacility = newFac;
        state.ControllingSector = newSec;
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

        // Beacon code
        var bc = enRoute.Descendants().FirstOrDefault(e => e.Name.LocalName == "currentBeaconCode");
        if (bc is not null) state.Squawk = bc.Value;

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
            if (!string.IsNullOrEmpty(evt))
                Console.WriteLine($"[HO] {DateTime.UtcNow:HH:mm:ss.fff} {state.Callsign ?? "?"} gufi={gufi[..Math.Min(8, gufi.Length)]}.. event={evt} recv={state.HandoffReceiving} xfer={state.HandoffTransferring} ctrl={state.ControllingFacility}/{state.ControllingSector}");
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
        if (name == "FDPS_GUFI" && !string.IsNullOrEmpty(val)) state.FdpsGufi = val;
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
            Console.WriteLine($"[HO-DONE] {DateTime.UtcNow:HH:mm:ss.fff} {state.Callsign ?? "?"} gufi={gufi[..Math.Min(8, gufi.Length)]}.. ctrl={state.ControllingFacility}/{state.ControllingSector} matched recv={state.HandoffReceiving}, xfer={state.HandoffTransferring}");
            state.HandoffEvent = "";
            state.HandoffReceiving = "";
            state.HandoffTransferring = "";
            state.HandoffAccepting = "";
            state.HandoffForced = false;
        }
    }

    // Track which facility reports on this flight (for "tracked by")
    if (!string.IsNullOrEmpty(centre)) state.ReportingFacility = centre;

    // Broadcast update to clients
    Broadcast(new WsMsg("update", state.ToSummary()));
}

string FormatUnit(XElement unit)
{
    var id = unit.Attribute("unitIdentifier")?.Value ?? "";
    var sec = unit.Attribute("sectorIdentifier")?.Value ?? "";
    return string.IsNullOrEmpty(sec) ? id : $"{id}/{sec}";
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
    if (ia is not null && double.TryParse(ia.Value, out var alt))
        return $"Interim altitude set: {alt:F0} ft";
    return "Local handoff / interim altitude cleared";
}

void SendSnapshot(WsClient client)
{
    // Send all current flights as a batch, with position history for initial display
    var summaries = flights.Values.Select(f => f.ToSummary(includeHistory: true)).ToArray();
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

    // Check for cached CSVs
    var navFile = Path.Combine(cycleDir, "NAV_BASE.csv");
    if (!File.Exists(navFile))
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

    (data.Airports, data.AirportsIcao) = ParseAptBase(Path.Combine(cycleDir, "APT_BASE.csv"));
    Console.WriteLine($"[NASR]   Airports: {data.Airports.Count} FAA LIDs, {data.AirportsIcao.Count} ICAO");

    data.Airways = ParseAwyBase(Path.Combine(cycleDir, "AWY_BASE.csv"));
    Console.WriteLine($"[NASR]   Airways: {data.Airways.Count} routes");

    // Parse SID/STAR procedures (optional — files may not exist)
    data.Procedures = new Dictionary<string, List<ProcedureDef>>(StringComparer.OrdinalIgnoreCase);
    try
    {
        var stars = ParseProcedureCsvs(cycleDir, "STAR");
        foreach (var kv in stars) data.Procedures[kv.Key] = kv.Value;
        Console.WriteLine($"[NASR]   STARs: {stars.Count} procedures");
    }
    catch (Exception ex) { Console.WriteLine($"[NASR]   STAR parse skipped: {ex.Message}"); }
    try
    {
        var dps = ParseProcedureCsvs(cycleDir, "DP");
        foreach (var kv in dps)
        {
            if (data.Procedures.ContainsKey(kv.Key))
                data.Procedures[kv.Key].AddRange(kv.Value);
            else
                data.Procedures[kv.Key] = kv.Value;
        }
        Console.WriteLine($"[NASR]   DPs (SIDs): {dps.Count} procedures");
    }
    catch (Exception ex) { Console.WriteLine($"[NASR]   DP parse skipped: {ex.Message}"); }

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
    using var outerZip = ZipFile.OpenRead(tempZip);
    var csvZipEntry = outerZip.Entries.FirstOrDefault(e =>
        e.FullName.Contains("CSV_Data/", StringComparison.OrdinalIgnoreCase) &&
        e.Name.EndsWith("_CSV.zip", StringComparison.OrdinalIgnoreCase));

    if (csvZipEntry is null)
    {
        Console.WriteLine("[NASR] Could not find CSV zip inside subscription");
        File.Delete(tempZip);
        return;
    }

    var innerZipPath = Path.Combine(outputDir, "csv.zip");
    csvZipEntry.ExtractToFile(innerZipPath, overwrite: true);

    // Extract the CSV files we need from the inner zip
    var needed = new[] { "NAV_BASE.csv", "FIX_BASE.csv", "AWY_BASE.csv", "APT_BASE.csv" };
    // Also extract STAR and DP procedure files (name patterns: STAR_*.csv, DP_*.csv)
    using var innerZip = ZipFile.OpenRead(innerZipPath);
    foreach (var entry in innerZip.Entries)
    {
        var name = entry.Name;
        bool isNeeded = needed.Any(n => name.Equals(n, StringComparison.OrdinalIgnoreCase))
            || name.StartsWith("STAR_", StringComparison.OrdinalIgnoreCase) && name.EndsWith(".csv", StringComparison.OrdinalIgnoreCase)
            || name.StartsWith("DP_", StringComparison.OrdinalIgnoreCase) && name.EndsWith(".csv", StringComparison.OrdinalIgnoreCase);
        if (isNeeded)
        {
            var dest = Path.Combine(outputDir, name);
            entry.ExtractToFile(dest, overwrite: true);
            Console.WriteLine($"[NASR]   Extracted {name} ({entry.Length / 1024}KB)");
        }
    }

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

(Dictionary<string, NavPoint> byLid, Dictionary<string, NavPoint> byIcao) ParseAptBase(string path)
{
    var byLid = new Dictionary<string, NavPoint>(StringComparer.OrdinalIgnoreCase);
    var byIcao = new Dictionary<string, NavPoint>(StringComparer.OrdinalIgnoreCase);
    using var reader = new StreamReader(path);
    var headers = ParseCsvLine(reader.ReadLine()!);
    int iId = ColIdx(headers, "ARPT_ID"), iIcao = ColIdx(headers, "ICAO_ID");
    int iLat = ColIdx(headers, "LAT_DECIMAL"), iLon = ColIdx(headers, "LONG_DECIMAL");
    if (iId < 0 || iLat < 0 || iLon < 0) return (byLid, byIcao);

    while (reader.ReadLine() is { } line)
    {
        var f = ParseCsvLine(line);
        if (f.Count <= Math.Max(iId, Math.Max(iLat, iLon))) continue;
        if (!double.TryParse(f[iLat], out var lat) || !double.TryParse(f[iLon], out var lon)) continue;
        var lid = f[iId].Trim();
        if (string.IsNullOrEmpty(lid)) continue;
        var pt = new NavPoint(lid, lat, lon);
        byLid.TryAdd(lid, pt);
        if (iIcao >= 0 && iIcao < f.Count)
        {
            var icao = f[iIcao].Trim();
            if (!string.IsNullOrEmpty(icao)) byIcao.TryAdd(icao, pt);
        }
    }
    return (byLid, byIcao);
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
Dictionary<string, List<ProcedureDef>> ParseProcedureCsvs(string cycleDir, string type)
{
    // type = "STAR" or "DP"
    // Files: {type}_BASE.csv has procedure name + airport, {type}_RTE.csv has fix sequences
    // Computer codes like "ALWYZ.FRDMM6" → route strings use the part after the dot ("FRDMM6")
    var result = new Dictionary<string, List<ProcedureDef>>(StringComparer.OrdinalIgnoreCase);
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

    if (iRteCode < 0 || iFix < 0)
    {
        Console.WriteLine($"[NASR]   Missing columns: {codeCol}={iRteCode}, POINT={iFix}");
        return result;
    }

    // Read all rows grouped by computer code
    var rows = new List<(string code, string routeType, string tranCode, int seq, string fix)>();
    while (reader.ReadLine() is { } line)
    {
        var f = ParseCsvLine(line);
        if (f.Count <= Math.Max(iRteCode, iFix)) continue;
        var code = f[iRteCode].Trim();
        var fix = f[iFix].Trim().ToUpperInvariant();
        if (string.IsNullOrEmpty(code) || string.IsNullOrEmpty(fix)) continue;

        var routeType = iRouteType >= 0 && iRouteType < f.Count ? f[iRouteType].Trim().ToUpperInvariant() : "";
        var tranCode = iTransCode >= 0 && iTransCode < f.Count ? f[iTransCode].Trim() : "";
        var seq = 0;
        if (iSeq >= 0 && iSeq < f.Count) int.TryParse(f[iSeq].Trim(), out seq);
        rows.Add((code, routeType, tranCode, seq, fix));
    }

    // Group by computer code and build fix sequences (BODY portion only for main route)
    var grouped = rows.GroupBy(r => r.code);
    foreach (var g in grouped)
    {
        var computerCode = g.Key;
        // Use the BODY route portion as the main fix sequence
        var bodyFixes = g.Where(r => r.routeType == "BODY" || string.IsNullOrEmpty(r.routeType))
            .OrderBy(r => r.seq)
            .Select(r => r.fix)
            .Where(f => !string.IsNullOrEmpty(f))
            .Distinct()
            .ToList();

        if (bodyFixes.Count < 2) continue;

        // Extract the procedure identifier from computer code (part after the dot)
        // e.g., "ALWYZ.FRDMM6" → "FRDMM6", "ACCRA5.ACCRA" → "ACCRA5" (before dot) or "ACCRA" (after dot)
        var dotIdx = computerCode.IndexOf('.');
        var afterDot = dotIdx >= 0 ? computerCode[(dotIdx + 1)..].Trim().ToUpperInvariant() : computerCode.Trim().ToUpperInvariant();
        var beforeDot = dotIdx >= 0 ? computerCode[..dotIdx].Trim().ToUpperInvariant() : computerCode.Trim().ToUpperInvariant();

        // Get airport from BASE file
        codeToAirports.TryGetValue(computerCode, out var airports);
        var airport = airports?.Split(' ', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault() ?? "";

        // Register under both the "after dot" identifier and the "before dot" identifier
        // For STARs: "ALWYZ.FRDMM6" → register as "FRDMM6" (used in route strings)
        // For DPs: "ACCRA5.ACCRA" → register as "ACCRA5" (before dot is the SID name with number)
        var identifiers = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (!string.IsNullOrEmpty(afterDot)) identifiers.Add(afterDot);
        if (!string.IsNullOrEmpty(beforeDot) && beforeDot != afterDot) identifiers.Add(beforeDot);

        foreach (var ident in identifiers)
        {
            var def = new ProcedureDef(ident, airport, type, bodyFixes);
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

            // If not found, try stripping radial/distance suffix (e.g., CARNU020034 → CARNU)
            if (pt is null && token.Length > 5 && char.IsDigit(token[^1]))
            {
                // Find where digits start at the end
                var nameEnd = token.Length;
                while (nameEnd > 0 && char.IsDigit(token[nameEnd - 1])) nameEnd--;
                if (nameEnd >= 2 && nameEnd < token.Length)
                    pt = LookupPoint(token[..nameEnd], lastPt, nasr);
            }

            if (pt is not null)
            {
                waypoints.Add(new[] { pt.Lat, pt.Lon });
                lastPt = pt;
            }
            else if (nasr.Procedures.TryGetValue(token, out var procs))
            {
                // SID/STAR procedure — expand fix sequence
                // Pick the procedure for the matching airport (origin for SID, destination for STAR)
                var proc = procs.Count == 1 ? procs[0]
                    : procs.FirstOrDefault(p =>
                        (!string.IsNullOrEmpty(origin) && p.Airport.Equals(origin.TrimStart('K'), StringComparison.OrdinalIgnoreCase)) ||
                        (!string.IsNullOrEmpty(destination) && p.Airport.Equals(destination.TrimStart('K'), StringComparison.OrdinalIgnoreCase)))
                    ?? procs[0];

                foreach (var fixName in proc.Fixes)
                {
                    var fixPt = LookupPoint(fixName, lastPt, nasr);
                    if (fixPt is not null)
                    {
                        waypoints.Add(new[] { fixPt.Lat, fixPt.Lon });
                        lastPt = fixPt;
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

record NavPoint(string Ident, double Lat, double Lon);
record AirwayDef(string Id, string Designation, List<string> Fixes);

record ProcedureDef(string Id, string Airport, string Type, List<string> Fixes); // Type = "STAR" or "DP"
record PositionRecord(double Lat, double Lon, long Ticks, char Sym);

class NasrData
{
    public Dictionary<string, List<NavPoint>> Navaids { get; set; } = new();
    public Dictionary<string, List<NavPoint>> Fixes { get; set; } = new();
    public Dictionary<string, NavPoint> Airports { get; set; } = new();
    public Dictionary<string, NavPoint> AirportsIcao { get; set; } = new();
    public Dictionary<string, AirwayDef> Airways { get; set; } = new();
    public Dictionary<string, List<ProcedureDef>> Procedures { get; set; } = new(); // name → list (may have same name at different airports)
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
    public string? Squawk { get; set; }
    public string? FlightRules { get; set; }
    public string? Route { get; set; }
    public string? STAR { get; set; }
    public string? Remarks { get; set; }

    // Altitude
    public double? AssignedAltitude { get; set; }
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

    public object ToSummary(bool includeHistory = false) => new
    {
        Gufi, Callsign, ComputerId,
        ComputerIds = ComputerIds.IsEmpty ? null : new Dictionary<string, string>(ComputerIds),
        Operator, FlightStatus,
        Origin, Destination, AircraftType, WakeCategory,
        AssignedAltitude, InterimAltitude, ReportedAltitude,
        Latitude, Longitude, GroundSpeed, Squawk,
        TrackVelocityX, TrackVelocityY,
        ControllingFacility, ControllingSector,
        ReportingFacility,
        HandoffEvent, HandoffReceiving, HandoffTransferring, HandoffAccepting, HandoffForced,
        DataLinkCode, OtherDataLink,
        Route, FlightRules, STAR, Remarks,
        Registration, EquipmentQualifier, RequestedSpeed,
        CoordinationFix, CoordinationTime,
        ETA, ActualDepartureTime,
        LastMsgSource,
        LastSeen = LastSeen.ToString("HH:mm:ss"),
        History = includeHistory ? GetPositionHistory().Select(h => new { h.Lat, h.Lon, Sym = h.Sym.ToString() }).ToArray() : null
    };

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
            ModeSCode, EquipmentQualifier, Squawk, FlightRules,
            Route, STAR, Remarks,
            AssignedAltitude, InterimAltitude, ReportedAltitude,
            Latitude, Longitude, GroundSpeed, RequestedSpeed,
            ActualDepartureTime, ETA, CoordinationTime, CoordinationFix,
            ReportingFacility, ControllingFacility, ControllingSector,
            HandoffEvent, HandoffReceiving, HandoffTransferring, HandoffAccepting, HandoffForced,
            CommunicationCode, DataLinkCode, OtherDataLink, SELCAL,
            NavigationCode, PBNCode, SurveillanceCode,
            LastMsgSource, LastSeen = LastSeen.ToString("o"),
            Events = events,
            History = GetPositionHistory().Select(h => new { h.Lat, h.Lon, Sym = h.Sym.ToString() }).ToArray()
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
