using System.Text;
using SolaceSystems.Solclient.Messaging;

/// <summary>
/// Standalone console tool for capturing raw XML messages from FAA SCDS.
/// Saves each message to a file for schema discovery and parser development.
///
/// Usage: dotnet run -- --host tcps://ems2.swim.faa.gov:55443 --vpn STDDS --user YOUR_USER --pass YOUR_PASS --queue YOUR_QUEUE [--output ./captures] [--count 100]
/// </summary>

var host = GetArg(args, "--host") ?? Environment.GetEnvironmentVariable("SCDSCONNECTION__HOST") ?? "tcps://ems2.swim.faa.gov:55443";
var vpn = GetArg(args, "--vpn") ?? Environment.GetEnvironmentVariable("SCDSCONNECTION__MESSAGEVPN") ?? "STDDS";
var user = GetArg(args, "--user") ?? Environment.GetEnvironmentVariable("SCDSCONNECTION__USERNAME") ?? "";
var pass = GetArg(args, "--pass") ?? Environment.GetEnvironmentVariable("SCDSCONNECTION__PASSWORD") ?? "";
var queue = GetArg(args, "--queue") ?? Environment.GetEnvironmentVariable("SCDSCONNECTION__QUEUENAME") ?? "";
var outputDir = GetArg(args, "--output") ?? "./captures";
var maxCount = int.Parse(GetArg(args, "--count") ?? "0"); // 0 = unlimited

if (string.IsNullOrEmpty(user) || string.IsNullOrEmpty(pass) || string.IsNullOrEmpty(queue))
{
    Console.Error.WriteLine("Usage: SwimReader.MessageCapture --user <user> --pass <pass> --queue <queue>");
    Console.Error.WriteLine("  Or set SCDSCONNECTION__USERNAME, SCDSCONNECTION__PASSWORD, SCDSCONNECTION__QUEUENAME env vars.");
    Console.Error.WriteLine();
    Console.Error.WriteLine("Options:");
    Console.Error.WriteLine("  --host    SCDS host URL (default: tcps://ems2.swim.faa.gov:55443)");
    Console.Error.WriteLine("  --vpn     Message VPN (default: STDDS)");
    Console.Error.WriteLine("  --output  Output directory (default: ./captures)");
    Console.Error.WriteLine("  --count   Number of messages to capture (default: 0 = unlimited)");
    return 1;
}

Directory.CreateDirectory(outputDir);

Console.WriteLine($"Connecting to {host} as {user}@{vpn}...");
Console.WriteLine($"Queue: {queue}");
Console.WriteLine($"Output: {Path.GetFullPath(outputDir)}");
Console.WriteLine($"Count: {(maxCount == 0 ? "unlimited" : maxCount)}");
Console.WriteLine();

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
        (sender, eventArgs) => Console.WriteLine($"Session event: {eventArgs.Event} - {eventArgs.Info}"));

    var returnCode = session.Connect();
    if (returnCode != ReturnCode.SOLCLIENT_OK)
    {
        Console.Error.WriteLine($"Connection failed: {returnCode}");
        return 1;
    }

    Console.WriteLine("Connected to SCDS successfully.");

    // Bind to queue
    var solQueue = ContextFactory.Instance.CreateQueue(queue);
    var flowProps = new FlowProperties { AckMode = MessageAckMode.ClientAck };

    var count = 0;
    var serviceTypeCounts = new Dictionary<string, int>();
    var waitHandle = new ManualResetEvent(false);

    using var flow = session.CreateFlow(flowProps, solQueue, null,
        (sender, msgArgs) =>
        {
            using var message = msgArgs.Message;
            count++;

            var body = ExtractBody(message);
            if (body is null)
            {
                Console.WriteLine($"[{count}] Empty message, skipping");
                return;
            }

            var topic = message.Destination?.Name ?? "unknown";
            var serviceType = InferServiceType(topic);

            // Track counts
            if (!serviceTypeCounts.TryGetValue(serviceType, out var svcCount))
                svcCount = 0;
            serviceTypeCounts[serviceType] = svcCount + 1;

            // Save to file
            var timestamp = DateTime.UtcNow.ToString("yyyyMMdd_HHmmss_fff");
            var filename = $"{serviceType}_{timestamp}_{count}.xml";
            var filePath = Path.Combine(outputDir, filename);
            File.WriteAllText(filePath, body);

            // Display summary
            var bodyPreview = body.Length > 120 ? body[..120] + "..." : body;
            bodyPreview = bodyPreview.Replace("\n", " ").Replace("\r", "");
            Console.WriteLine($"[{count}] {serviceType} | Topic: {topic}");
            Console.WriteLine($"     Size: {body.Length} bytes | Saved: {filename}");
            Console.WriteLine($"     Preview: {bodyPreview}");
            Console.WriteLine();

            if (maxCount > 0 && count >= maxCount)
            {
                Console.WriteLine($"Captured {maxCount} messages, stopping.");
                waitHandle.Set();
            }
        },
        (sender, flowArgs) =>
        {
            Console.WriteLine($"Flow event: {flowArgs.Event} - {flowArgs.Info}");
        });

    flow.Start();
    Console.WriteLine($"Listening on queue: {queue}");
    Console.WriteLine("Waiting for messages... (Ctrl+C to stop)");
    Console.WriteLine(new string('-', 60));

    var cts = new CancellationTokenSource();
    Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); waitHandle.Set(); };

    // Wait for either max count or Ctrl+C
    waitHandle.WaitOne();

    // Summary
    Console.WriteLine(new string('=', 60));
    Console.WriteLine($"Capture complete. {count} messages saved to {Path.GetFullPath(outputDir)}");
    Console.WriteLine("Messages by service type:");
    foreach (var kvp in serviceTypeCounts.OrderByDescending(x => x.Value))
    {
        Console.WriteLine($"  {kvp.Key}: {kvp.Value}");
    }
}
finally
{
    ContextFactory.Instance.Cleanup();
}

return 0;

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

static string InferServiceType(string topic)
{
    var upper = topic.ToUpperInvariant();
    if (upper.Contains("TAIS")) return "TAIS";
    if (upper.Contains("TDES")) return "TDES";
    if (upper.Contains("SMES")) return "SMES";
    if (upper.Contains("APDS")) return "APDS";
    if (upper.Contains("ISMC")) return "ISMC";
    return "UNKNOWN";
}
