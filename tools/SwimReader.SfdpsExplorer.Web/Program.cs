using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Channels;
using System.Xml.Linq;
using SolaceSystems.Solclient.Messaging;

// ── Configuration ───────────────────────────────────────────────────────────

// Load .env file if present
var envFile = Path.Combine(AppContext.BaseDirectory, ".env");
if (!File.Exists(envFile)) envFile = Path.Combine(Directory.GetCurrentDirectory(), ".env");
if (File.Exists(envFile))
{
    foreach (var line in File.ReadAllLines(envFile))
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
app.MapGet("/api/flights/{gufi}", (string gufi) =>
{
    if (!flights.TryGetValue(gufi, out var f)) return Results.NotFound();
    return Results.Json(f.ToDetail(), jsonOpts);
});

// REST API for stats
app.MapGet("/api/stats", () => Results.Json(stats.Snapshot(), jsonOpts));

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
        if (!string.IsNullOrEmpty(cid)) state.ComputerId = cid;
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
                state.HandoffEvent = evt;
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
    // Send all current flights as a batch via the client's send queue
    var summaries = flights.Values.Select(f => f.ToSummary()).ToArray();
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

class FlightState
{
    public string Gufi { get; set; } = "";
    public string? FdpsGufi { get; set; }
    public string? Callsign { get; set; }
    public string? ComputerId { get; set; }
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

    public object ToSummary() => new
    {
        Gufi, Callsign, ComputerId, Operator, FlightStatus,
        Origin, Destination, AircraftType, WakeCategory,
        AssignedAltitude, InterimAltitude, ReportedAltitude,
        Latitude, Longitude, GroundSpeed, Squawk,
        TrackVelocityX, TrackVelocityY,
        ControllingFacility, ControllingSector,
        ReportingFacility,
        HandoffEvent, HandoffReceiving, HandoffTransferring, HandoffAccepting,
        DataLinkCode, OtherDataLink,
        Route, FlightRules, STAR, Remarks,
        Registration, EquipmentQualifier,
        CoordinationFix, CoordinationTime,
        ETA, ActualDepartureTime,
        LastMsgSource,
        LastSeen = LastSeen.ToString("HH:mm:ss")
    };

    public object ToDetail()
    {
        List<object> events;
        lock (_events) { events = _events.Select(e => (object)e).ToList(); }
        return new
        {
            Gufi, FdpsGufi, Callsign, ComputerId, Operator, FlightStatus,
            Origin, Destination, AircraftType, Registration, WakeCategory,
            ModeSCode, EquipmentQualifier, Squawk, FlightRules,
            Route, STAR, Remarks,
            AssignedAltitude, InterimAltitude, ReportedAltitude,
            Latitude, Longitude, GroundSpeed, RequestedSpeed,
            ActualDepartureTime, ETA, CoordinationTime, CoordinationFix,
            ReportingFacility, ControllingFacility, ControllingSector,
            HandoffEvent, HandoffReceiving, HandoffTransferring, HandoffAccepting,
            CommunicationCode, DataLinkCode, OtherDataLink, SELCAL,
            NavigationCode, PBNCode, SurveillanceCode,
            LastMsgSource, LastSeen = LastSeen.ToString("o"),
            Events = events
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
