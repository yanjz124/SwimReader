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
// Topic-tap mode: --topic 'STDDS/TAIS/>' subscribes directly to a topic and
// writes one JSONL line per matched message to --jsonl. Skips queue binding
// entirely so prod queue consumers are unaffected. Optional --src PCT
// filters to TAIS messages where <src>PCT</src>. --secs SECS bounds runtime.
var topic = GetArg(args, "--topic");
var jsonlPath = GetArg(args, "--jsonl");
var srcFilter = GetArg(args, "--src")?.ToUpperInvariant();
var maxSecs = int.Parse(GetArg(args, "--secs") ?? "0");

if (string.IsNullOrEmpty(user) || string.IsNullOrEmpty(pass) ||
    (string.IsNullOrEmpty(queue) && string.IsNullOrEmpty(topic)))
{
    Console.Error.WriteLine("Usage:");
    Console.Error.WriteLine("  Queue mode: --user U --pass P --queue Q");
    Console.Error.WriteLine("  Topic mode: --user U --pass P --topic 'STDDS/TAIS/>' --jsonl out.jsonl [--src PCT] [--secs 300]");
    Console.Error.WriteLine("  Or set SCDSCONNECTION__USERNAME, SCDSCONNECTION__PASSWORD, SCDSCONNECTION__QUEUENAME env vars.");
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

    var topicCount = 0;
    var topicWait = new ManualResetEvent(false);
    var jsonlLock = new object();
    using var session = context.CreateSession(sessionProps,
        // ── Topic mode: direct subscription, MessageEvent fires here ──
        (sender, msgArgs) =>
        {
            if (string.IsNullOrEmpty(topic)) return;        // queue mode handler below
            using var message = msgArgs.Message;
            var body = ExtractBody(message);
            if (body is null) return;
            if (srcFilter is not null)
            {
                // Cheap src-filter: TAIS messages have <src>XXX</src> near root.
                var i = body.IndexOf("<src>", StringComparison.Ordinal);
                if (i < 0) return;
                var j = body.IndexOf("</src>", i + 5, StringComparison.Ordinal);
                if (j < 0) return;
                var src = body.Substring(i + 5, j - i - 5).Trim().ToUpperInvariant();
                if (src != srcFilter) return;
            }
            Interlocked.Increment(ref topicCount);
            if (jsonlPath is not null)
            {
                var rx = DateTime.UtcNow.ToString("o");
                var safe = System.Text.Json.JsonSerializer.Serialize(body);
                lock (jsonlLock)
                    File.AppendAllText(jsonlPath, "{\"_rx\":\"" + rx + "\",\"xml\":" + safe + "}\n");
            }
            if (topicCount % 200 == 0) Console.WriteLine($"[topic] {topicCount} msgs");
        },
        (sender, eventArgs) => Console.WriteLine($"Session event: {eventArgs.Event} - {eventArgs.Info}"));

    var returnCode = session.Connect();
    if (returnCode != ReturnCode.SOLCLIENT_OK)
    {
        Console.Error.WriteLine($"Connection failed: {returnCode}");
        return 1;
    }
    Console.WriteLine("Connected to SCDS successfully.");

    // ── Topic-tap branch ──────────────────────────────────────────────
    if (!string.IsNullOrEmpty(topic))
    {
        var solTopic = ContextFactory.Instance.CreateTopic(topic);
        var sub = session.Subscribe(solTopic, true);
        if (sub != ReturnCode.SOLCLIENT_OK && sub != ReturnCode.SOLCLIENT_IN_PROGRESS)
        {
            Console.Error.WriteLine($"Subscribe failed: {sub}");
            return 1;
        }
        Console.WriteLine($"Subscribed to topic: {topic}");
        if (srcFilter is not null) Console.WriteLine($"  src filter: {srcFilter}");
        if (jsonlPath is not null) Console.WriteLine($"  writing JSONL to: {Path.GetFullPath(jsonlPath)}");
        if (maxSecs > 0) Console.WriteLine($"  capture window: {maxSecs}s");

        var ctsTopic = new CancellationTokenSource();
        Console.CancelKeyPress += (_, e) => { e.Cancel = true; topicWait.Set(); };
        if (maxSecs > 0) topicWait.WaitOne(TimeSpan.FromSeconds(maxSecs));
        else topicWait.WaitOne();

        Console.WriteLine($"Topic capture complete. {topicCount} matched messages.");
        return 0;
    }

    // Bind to queue (legacy mode)
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
