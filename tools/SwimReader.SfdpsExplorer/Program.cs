using System.Text;
using System.Xml.Linq;
using SolaceSystems.Solclient.Messaging;

/// <summary>
/// Standalone console tool for exploring raw messages from FAA SFDPS (SWIM Flight Data Publication Service).
/// Connects to the Solace queue and displays/saves incoming AIXM, FIXM, and other SFDPS messages.
///
/// Usage: dotnet run -- [--output ./sfdps-captures] [--count 100] [--save]
///
/// Credentials default to the configured SFDPS subscription values.
/// Override with: --host, --vpn, --user, --pass, --queue
/// </summary>

// SFDPS defaults
var host = GetArg(args, "--host") ?? Environment.GetEnvironmentVariable("SFDPS_HOST") ?? "tcps://ems2.swim.faa.gov:55443";
var vpn = GetArg(args, "--vpn") ?? Environment.GetEnvironmentVariable("SFDPS_VPN") ?? "FDPS";
var user = GetArg(args, "--user") ?? Environment.GetEnvironmentVariable("SFDPS_USER") ?? "";
var pass = GetArg(args, "--pass") ?? Environment.GetEnvironmentVariable("SFDPS_PASS") ?? "";
var queue = GetArg(args, "--queue") ?? Environment.GetEnvironmentVariable("SFDPS_QUEUE") ?? "";
var outputDir = GetArg(args, "--output") ?? "./sfdps-captures";
var maxCount = int.Parse(GetArg(args, "--count") ?? "0"); // 0 = unlimited
var save = args.Contains("--save");

Console.WriteLine("=== SFDPS Explorer ===");
Console.WriteLine($"Host:  {host}");
Console.WriteLine($"VPN:   {vpn}");
Console.WriteLine($"User:  {user}");
Console.WriteLine($"Queue: {queue}");
if (save) Console.WriteLine($"Saving to: {Path.GetFullPath(outputDir)}");
if (maxCount > 0) Console.WriteLine($"Max messages: {maxCount}");
Console.WriteLine();

if (save) Directory.CreateDirectory(outputDir);

// Initialize Solace
var cfp = new ContextFactoryProperties { SolClientLogLevel = SolLogLevel.Warning };
cfp.LogToConsoleError();
ContextFactory.Instance.Init(cfp);

try
{
    using var context = ContextFactory.Instance.CreateContext(new ContextProperties(), null);

    var sessionProps = new SessionProperties
    {
        Host = host,
        VPNName = vpn,
        UserName = user,
        Password = pass,
        ReconnectRetries = 3,
        SSLValidateCertificate = false
    };

    using var session = context.CreateSession(sessionProps, null,
        (sender, eventArgs) => Console.WriteLine($"[Session] {eventArgs.Event} - {eventArgs.Info}"));

    var returnCode = session.Connect();
    if (returnCode != ReturnCode.SOLCLIENT_OK)
    {
        Console.Error.WriteLine($"Connection failed: {returnCode}");
        return 1;
    }

    Console.WriteLine("Connected to SFDPS successfully.");
    Console.WriteLine();

    // Bind to queue
    var solQueue = ContextFactory.Instance.CreateQueue(queue);
    var flowProps = new FlowProperties { AckMode = MessageAckMode.ClientAck };

    var count = 0;
    var serviceTypeCounts = new Dictionary<string, int>();
    var topicCounts = new Dictionary<string, int>();
    var rootElementCounts = new Dictionary<string, int>();
    var firstSeen = DateTime.UtcNow;
    var waitHandle = new ManualResetEvent(false);

    using var flow = session.CreateFlow(flowProps, solQueue, null,
        (sender, msgArgs) =>
        {
            using var message = msgArgs.Message;
            count++;

            var body = ExtractBody(message);
            if (body is null)
            {
                Console.WriteLine($"[{count}] (empty message, skipping)");
                return;
            }

            var topic = message.Destination?.Name ?? "(no topic)";
            var serviceType = ClassifyTopic(topic);

            // Track counts
            Increment(serviceTypeCounts, serviceType);
            Increment(topicCounts, topic);

            // Try to parse XML root element info
            var (rootElement, rootNs, xmlSummary) = AnalyzeXml(body);
            if (rootElement is not null)
                Increment(rootElementCounts, rootNs is not null ? $"{rootElement} [{rootNs}]" : rootElement);

            // Save to file if requested
            string? savedFile = null;
            if (save)
            {
                var timestamp = DateTime.UtcNow.ToString("yyyyMMdd_HHmmss_fff");
                var ext = body.TrimStart().StartsWith("<") ? "xml" : "txt";
                savedFile = $"{serviceType}_{timestamp}_{count}.{ext}";
                File.WriteAllText(Path.Combine(outputDir, savedFile), body);
            }

            // Display
            Console.ForegroundColor = serviceType switch
            {
                "FIXM" => ConsoleColor.Cyan,
                "AIXM" => ConsoleColor.Green,
                "GENERAL" => ConsoleColor.Yellow,
                "STATUS" => ConsoleColor.Magenta,
                _ => ConsoleColor.Gray
            };
            Console.Write($"[{count}] {serviceType,-8}");
            Console.ResetColor();

            Console.WriteLine($" | {body.Length,7} bytes | {topic}");

            if (rootElement is not null)
                Console.WriteLine($"         Root: <{rootElement}>{(rootNs is not null ? $"  ns: {rootNs}" : "")}");

            if (xmlSummary is not null)
                Console.WriteLine($"         {xmlSummary}");

            if (savedFile is not null)
                Console.WriteLine($"         Saved: {savedFile}");

            Console.WriteLine();

            if (maxCount > 0 && count >= maxCount)
            {
                Console.WriteLine($"Reached {maxCount} messages, stopping.");
                waitHandle.Set();
            }
        },
        (sender, flowArgs) =>
        {
            Console.WriteLine($"[Flow] {flowArgs.Event} - {flowArgs.Info}");
        });

    flow.Start();
    Console.WriteLine($"Listening on queue: {queue}");
    Console.WriteLine("Waiting for messages... (Ctrl+C to stop)");
    Console.WriteLine(new string('-', 80));
    Console.WriteLine();

    var cts = new CancellationTokenSource();
    Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); waitHandle.Set(); };

    waitHandle.WaitOne();

    // Summary
    var elapsed = DateTime.UtcNow - firstSeen;
    Console.WriteLine();
    Console.WriteLine(new string('=', 80));
    Console.WriteLine($"Session summary: {count} messages in {elapsed:hh\\:mm\\:ss}");
    Console.WriteLine($"  Rate: {(elapsed.TotalSeconds > 0 ? count / elapsed.TotalSeconds : 0):F1} msg/sec");
    Console.WriteLine();

    Console.WriteLine("By service type:");
    foreach (var kvp in serviceTypeCounts.OrderByDescending(x => x.Value))
        Console.WriteLine($"  {kvp.Key,-12} {kvp.Value,6}");

    Console.WriteLine();
    Console.WriteLine("By XML root element:");
    foreach (var kvp in rootElementCounts.OrderByDescending(x => x.Value))
        Console.WriteLine($"  {kvp.Key,-50} {kvp.Value,6}");

    Console.WriteLine();
    Console.WriteLine("By topic (top 20):");
    foreach (var kvp in topicCounts.OrderByDescending(x => x.Value).Take(20))
        Console.WriteLine($"  {kvp.Value,6}  {kvp.Key}");

    if (save)
        Console.WriteLine($"\nAll messages saved to: {Path.GetFullPath(outputDir)}");
}
finally
{
    ContextFactory.Instance.Cleanup();
}

return 0;

// ── Helpers ─────────────────────────────────────────────────────────────────

static string? GetArg(string[] args, string name)
{
    var idx = Array.IndexOf(args, name);
    return idx >= 0 && idx + 1 < args.Length ? args[idx + 1] : null;
}

static string? ExtractBody(IMessage message)
{
    if (message.BinaryAttachment is { Length: > 0 })
        return Encoding.UTF8.GetString(message.BinaryAttachment);

    if (message.XmlContent is { Length: > 0 })
        return Encoding.UTF8.GetString(message.XmlContent);

    return null;
}

static string ClassifyTopic(string topic)
{
    var upper = topic.ToUpperInvariant();
    if (upper.Contains("FIXM") || upper.Contains("FLIGHT")) return "FIXM";
    if (upper.Contains("AIXM") || upper.Contains("AIRSPACE")) return "AIXM";
    if (upper.Contains("GENERAL") || upper.Contains("GENM") || upper.Contains("EGMP")) return "GENERAL";
    if (upper.Contains("STATUS")) return "STATUS";
    if (upper.Contains("FDPS") || upper.Contains("SFDPS")) return "FDPS";
    return "OTHER";
}

static (string? rootElement, string? rootNs, string? summary) AnalyzeXml(string body)
{
    try
    {
        if (!body.TrimStart().StartsWith("<"))
            return (null, null, null);

        var doc = XDocument.Parse(body);
        var root = doc.Root;
        if (root is null) return (null, null, null);

        var rootName = root.Name.LocalName;
        var rootNs = root.Name.NamespaceName;
        if (string.IsNullOrEmpty(rootNs)) rootNs = null;

        // Build a short summary based on what we find
        string? summary = null;

        // For FIXM flight messages, try to extract callsign / gufi / airports
        if (rootName.Contains("Flight", StringComparison.OrdinalIgnoreCase) ||
            body.Contains("flightIdentification", StringComparison.OrdinalIgnoreCase))
        {
            summary = ExtractFlightSummary(root);
        }
        // For AIXM, try to extract feature type
        else if (body.Contains("aixm", StringComparison.OrdinalIgnoreCase))
        {
            summary = ExtractAixmSummary(root);
        }
        // Generic: show child element names
        else
        {
            var children = root.Elements().Select(e => e.Name.LocalName).Distinct().Take(8);
            summary = $"Children: {string.Join(", ", children)}";
        }

        return (rootName, rootNs, summary);
    }
    catch
    {
        // Malformed XML — just return what we can
        return (null, null, "(malformed XML)");
    }
}

static string? ExtractFlightSummary(XElement root)
{
    var parts = new List<string>();

    // Walk all descendants looking for key fields
    foreach (var el in root.DescendantsAndSelf())
    {
        var local = el.Name.LocalName;

        if (local == "aircraftIdentification" && el.Parent?.Name.LocalName == "flightIdentification")
        {
            var val = el.Value.Trim();
            if (!string.IsNullOrEmpty(val)) parts.Add($"CS:{val}");
        }
        else if (local == "gufi")
        {
            var cdr = el.Attribute("cdr")?.Value ?? el.Value.Trim();
            if (!string.IsNullOrEmpty(cdr) && parts.All(p => !p.StartsWith("GUFI:")))
                parts.Add($"GUFI:{(cdr.Length > 16 ? cdr[..16] + ".." : cdr)}");
        }
        else if (local == "departureAerodrome" || local == "arrivalAerodrome")
        {
            var icao = el.Elements().FirstOrDefault(e => e.Name.LocalName == "locationIndicator")?.Value.Trim()
                     ?? el.Value.Trim();
            if (!string.IsNullOrEmpty(icao))
            {
                var prefix = local.StartsWith("departure") ? "DEP" : "ARR";
                parts.Add($"{prefix}:{icao}");
            }
        }
        else if (local == "assignedAltitude" || local == "cruisingLevel")
        {
            var val = el.Value.Trim();
            if (!string.IsNullOrEmpty(val) && parts.All(p => !p.StartsWith("ALT:")))
                parts.Add($"ALT:{val}");
        }
    }

    return parts.Count > 0 ? string.Join("  ", parts) : null;
}

static string? ExtractAixmSummary(XElement root)
{
    // Look for the AIXM feature type (e.g., Airspace, Route, Navaid)
    foreach (var el in root.DescendantsAndSelf())
    {
        var local = el.Name.LocalName;
        if (local.EndsWith("TimeSlice") || local.EndsWith("Feature"))
        {
            return $"Feature: {local}";
        }
    }
    var children = root.Elements().Select(e => e.Name.LocalName).Distinct().Take(6);
    return $"Children: {string.Join(", ", children)}";
}

static void Increment(Dictionary<string, int> dict, string key)
{
    dict.TryGetValue(key, out var val);
    dict[key] = val + 1;
}
