using System.Collections.Concurrent;
using System.Globalization;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Xml.Linq;
using SolaceSystems.Solclient.Messaging;
using SwimServer;

/// <summary>
/// Manages ITWS (Integrated Terminal Weather System) data ingestion and WebSocket broadcasting.
///
/// Connects to ITWS Solace broker (own session, VPN "ITWS"), receives terminal-area weather
/// products (precip, winds, microbursts, gust fronts, lightning, storm cells, etc.), and
/// publishes them via REST + WebSocket for downstream consumers (frontends, X-Plane plugins).
///
/// ITWS messages vary in shape per product. To stay forward-compatible we keep a generic
/// state map keyed by (productType, site) and retain the raw XML so consumers can do their
/// own deep parsing. Lightweight extraction (time, airport, root element) is done up front
/// for indexing and discovery.
/// </summary>
class ItwsBridge
{
    private readonly string _user, _pass, _queue, _host, _vpn;
    private readonly JsonSerializerOptions _jsonOpts;

    // key "PRODUCTTYPE|SITE" → latest message
    private readonly ConcurrentDictionary<string, ItwsMessage> _latest = new(StringComparer.OrdinalIgnoreCase);
    // productType → count
    private readonly ConcurrentDictionary<string, long> _productCounts = new(StringComparer.OrdinalIgnoreCase);
    // site (airport) → count
    private readonly ConcurrentDictionary<string, long> _siteCounts = new(StringComparer.OrdinalIgnoreCase);
    // first XML sample by productType (truncated)
    private readonly ConcurrentDictionary<string, string> _samples = new(StringComparer.OrdinalIgnoreCase);
    // unique topics seen
    private readonly ConcurrentDictionary<string, long> _topics = new();

    // WS clients
    private readonly ConcurrentDictionary<string, WsClient> _allClients = new();              // /itws/ws
    private readonly ConcurrentDictionary<string, ConcurrentDictionary<string, WsClient>> _airportClients = new(StringComparer.OrdinalIgnoreCase); // /itws/ws/{airport}

    // Stats
    public long MessageCount;
    public DateTime LastMessageAt;
    public bool Connected;

    public ItwsBridge(string user, string pass, string queue, string host, string vpn,
        JsonSerializerOptions jsonOpts)
    {
        _user = user; _pass = pass; _queue = queue; _host = host; _vpn = vpn;
        _jsonOpts = jsonOpts;
    }

    public void Start()
    {
        if (string.IsNullOrEmpty(_user))
        {
            Console.WriteLine("[ITWS] No credentials configured — ITWS disabled");
            return;
        }
        var t = new Thread(Run) { IsBackground = true, Name = "ItwsReceiver" };
        t.Start();
    }

    // ── Solace receive loop ──────────────────────────────────────────────────

    private void Run()
    {
        while (true)
        {
            long lastMsgTicks = DateTime.UtcNow.Ticks;
            try
            {
                using var context = ContextFactory.Instance.CreateContext(new ContextProperties(), null);
                var sessionProps = new SessionProperties
                {
                    Host = _host, VPNName = _vpn, UserName = _user, Password = _pass,
                    ReconnectRetries = 100, ReconnectRetriesWaitInMsecs = 5000,
                    SSLValidateCertificate = false
                };

                using var session = context.CreateSession(sessionProps, null,
                    (_, e) => Console.WriteLine($"[ITWS] {e.Event} - {e.Info}"));

                var rc = session.Connect();
                if (rc != ReturnCode.SOLCLIENT_OK)
                {
                    Console.Error.WriteLine($"[ITWS] Connect returned {rc}, retrying...");
                    Thread.Sleep(10000);
                    continue;
                }

                Console.WriteLine("[ITWS] Connected to ITWS");
                Connected = true;
                Interlocked.Exchange(ref lastMsgTicks, DateTime.UtcNow.Ticks);

                var solQueue = ContextFactory.Instance.CreateQueue(_queue);
                using var flow = session.CreateFlow(
                    new FlowProperties { AckMode = MessageAckMode.AutoAck }, solQueue, null,
                    (_, msgArgs) =>
                    {
                        using var m = msgArgs.Message;
                        Interlocked.Exchange(ref lastMsgTicks, DateTime.UtcNow.Ticks);
                        ProcessMessage(m);
                    },
                    (_, flowArgs) => Console.WriteLine($"[ITWS Flow] {flowArgs.Event} - {flowArgs.Info}"));

                flow.Start();
                Console.WriteLine("[ITWS] Listening on ITWS queue");

                int watchdogCycles = 0;
                while (true)
                {
                    Thread.Sleep(10000);
                    watchdogCycles++;
                    var silence = (DateTime.UtcNow -
                        new DateTime(Interlocked.Read(ref lastMsgTicks), DateTimeKind.Utc)).TotalSeconds;
                    if (silence > 180) // ITWS products are less frequent than flight data
                    {
                        Console.WriteLine($"[ITWS] No messages for {silence:F0}s — reconnecting");
                        break;
                    }
                    if (watchdogCycles % 6 == 0)
                    {
                        Console.WriteLine($"[ITWS] {_latest.Count} products, {_siteCounts.Count} sites, " +
                            $"{Interlocked.Read(ref MessageCount)} msgs");
                    }
                }

                Connected = false;
                try { session.Disconnect(); }
                catch (Exception ex) { Console.WriteLine($"[ITWS] Disconnect: {ex.Message}"); }
            }
            catch (Exception ex) { Console.Error.WriteLine($"[ITWS] Error: {ex.Message}"); }

            Console.WriteLine("[ITWS] Reconnecting in 10 seconds...");
            Thread.Sleep(10000);
        }
    }

    // ── Message processing ──────────────────────────────────────────────────

    private void ProcessMessage(IMessage message)
    {
        string? body = null;
        if (message.BinaryAttachment is { Length: > 0 })
            body = Encoding.UTF8.GetString(message.BinaryAttachment);
        else if (message.XmlContent is { Length: > 0 })
            body = Encoding.UTF8.GetString(message.XmlContent);
        if (body is null) return;

        var topic = message.Destination?.Name ?? "";
        Interlocked.Increment(ref MessageCount);
        LastMessageAt = DateTime.UtcNow;
        _topics.AddOrUpdate(topic, 1, (_, v) => v + 1);

        string productType = "Unknown";
        string? site = null;
        string? msgTime = null;
        try
        {
            var doc = XDocument.Parse(body);
            var root = doc.Root;
            if (root is not null)
            {
                productType = root.Name.LocalName;

                // Try common ITWS site / airport identifier locations
                site =
                    FirstNonEmpty(root, "airport", "airportID", "siteID", "site",
                        "itwsSite", "itwsSiteID", "stationID", "icao",
                        "asosID", "terminalID", "airportIdentifier");

                // Try common time fields
                msgTime =
                    FirstNonEmpty(root, "time", "msgTime", "messageTime", "validTime",
                        "issuanceTime", "productTime", "generationTime");

                // Topic frequently embeds airport: ITWS/.../KPHL — fall back to last path segment
                if (string.IsNullOrEmpty(site) && !string.IsNullOrEmpty(topic))
                {
                    var parts = topic.Split('/', StringSplitOptions.RemoveEmptyEntries);
                    for (int i = parts.Length - 1; i >= 0; i--)
                    {
                        var p = parts[i];
                        if (p.Length is >= 3 and <= 4 && p.All(ch => char.IsLetterOrDigit(ch)))
                        {
                            site = p.ToUpperInvariant();
                            break;
                        }
                    }
                }
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[ITWS] Parse error on {topic}: {ex.Message}");
        }

        if (string.IsNullOrEmpty(site)) site = "ALL";
        site = site.ToUpperInvariant();

        _productCounts.AddOrUpdate(productType, 1, (_, v) => v + 1);
        _siteCounts.AddOrUpdate(site, 1, (_, v) => v + 1);
        if (!_samples.ContainsKey(productType))
            _samples.TryAdd(productType, body.Length > 4096 ? body[..4096] + "\n... (truncated)" : body);

        var key = $"{productType}|{site}";
        var msg = new ItwsMessage
        {
            Key = key,
            ProductType = productType,
            Site = site,
            Topic = topic,
            MessageTime = msgTime,
            ReceivedAt = DateTime.UtcNow,
            RawXml = body
        };
        _latest[key] = msg;

        // Broadcast (lightweight notification + raw XML available via REST)
        BroadcastNew(msg);
    }

    private static string? FirstNonEmpty(XElement root, params string[] localNames)
    {
        foreach (var name in localNames)
        {
            var el = root.Descendants().FirstOrDefault(e =>
                string.Equals(e.Name.LocalName, name, StringComparison.OrdinalIgnoreCase));
            var val = el?.Value?.Trim();
            if (!string.IsNullOrEmpty(val)) return val;
        }
        return null;
    }

    // ── Broadcast ───────────────────────────────────────────────────────────

    private void BroadcastNew(ItwsMessage msg)
    {
        if (_allClients.IsEmpty && _airportClients.IsEmpty) return;

        var json = JsonSerializer.SerializeToUtf8Bytes(new WsMsg("update", msg.ToSummaryJson()), _jsonOpts);

        foreach (var (_, c) in _allClients)
        {
            if (c.Ws.State == WebSocketState.Open) c.Enqueue(json);
        }
        if (_airportClients.TryGetValue(msg.Site, out var airportSet))
        {
            foreach (var (_, c) in airportSet)
            {
                if (c.Ws.State == WebSocketState.Open) c.Enqueue(json);
            }
        }
    }

    // ── WS client management ────────────────────────────────────────────────

    public string AddAllClient(WsClient client)
    {
        var id = Guid.NewGuid().ToString("N");
        _allClients[id] = client;
        // Send snapshot of latest products
        var json = JsonSerializer.SerializeToUtf8Bytes(
            new WsMsg("snapshot", _latest.Values.Select(m => m.ToSummaryJson()).ToArray()), _jsonOpts);
        client.Enqueue(json);
        return id;
    }

    public void RemoveAllClient(string id) => _allClients.TryRemove(id, out _);

    public string AddAirportClient(string airport, WsClient client)
    {
        airport = airport.ToUpperInvariant();
        var id = Guid.NewGuid().ToString("N");
        _airportClients.GetOrAdd(airport, _ => new ConcurrentDictionary<string, WsClient>())[id] = client;

        var products = _latest.Values
            .Where(m => string.Equals(m.Site, airport, StringComparison.OrdinalIgnoreCase))
            .Select(m => m.ToSummaryJson())
            .ToArray();
        var json = JsonSerializer.SerializeToUtf8Bytes(new WsMsg("snapshot", products), _jsonOpts);
        client.Enqueue(json);
        return id;
    }

    public void RemoveAirportClient(string airport, string id)
    {
        if (!_airportClients.TryGetValue(airport.ToUpperInvariant(), out var set)) return;
        set.TryRemove(id, out _);
        if (set.IsEmpty) _airportClients.TryRemove(airport.ToUpperInvariant(), out _);
    }

    // ── REST helpers ────────────────────────────────────────────────────────

    public object GetStats() => new
    {
        connected = Connected,
        messageCount = Interlocked.Read(ref MessageCount),
        productTypeCount = _productCounts.Count,
        siteCount = _siteCounts.Count,
        latestCount = _latest.Count,
        lastMessageAt = LastMessageAt == default ? null : LastMessageAt.ToString("o"),
        host = _host,
        vpn = _vpn,
        queue = _queue,
    };

    public object GetProducts() =>
        _productCounts
            .Select(kv => new
            {
                productType = kv.Key,
                messageCount = kv.Value,
                latestSites = _latest.Values
                    .Where(m => string.Equals(m.ProductType, kv.Key, StringComparison.OrdinalIgnoreCase))
                    .Select(m => m.Site)
                    .Distinct()
                    .OrderBy(s => s)
                    .ToArray()
            })
            .OrderByDescending(x => x.messageCount)
            .ToArray();

    public object GetAirports() =>
        _siteCounts
            .Select(kv => new
            {
                airport = kv.Key,
                messageCount = kv.Value,
                products = _latest.Values
                    .Where(m => string.Equals(m.Site, kv.Key, StringComparison.OrdinalIgnoreCase))
                    .Select(m => m.ProductType)
                    .Distinct()
                    .OrderBy(p => p)
                    .ToArray()
            })
            .OrderByDescending(x => x.messageCount)
            .ToArray();

    /// <summary>Latest products for one airport — full payload incl. raw XML.</summary>
    public object GetAirport(string airport)
    {
        airport = airport.ToUpperInvariant();
        var items = _latest.Values
            .Where(m => string.Equals(m.Site, airport, StringComparison.OrdinalIgnoreCase))
            .OrderBy(m => m.ProductType)
            .Select(m => m.ToFullJson())
            .ToArray();
        return new { airport, products = items };
    }

    /// <summary>Latest messages for one product type across all sites — full payload.</summary>
    public object GetProduct(string productType)
    {
        var items = _latest.Values
            .Where(m => string.Equals(m.ProductType, productType, StringComparison.OrdinalIgnoreCase))
            .OrderBy(m => m.Site)
            .Select(m => m.ToFullJson())
            .ToArray();
        return new { productType, sites = items };
    }

    /// <summary>All latest messages keyed by productType|site.</summary>
    public object GetLatest() => _latest.Values.Select(m => m.ToSummaryJson()).ToArray();

    /// <summary>Raw XML for one specific product/site combination (for X-Plane plugin, etc.).</summary>
    public string? GetRaw(string productType, string site)
    {
        var key = $"{productType}|{site.ToUpperInvariant()}";
        return _latest.TryGetValue(key, out var m) ? m.RawXml : null;
    }

    /// <summary>Topic frequency table — discovery aid for new ITWS products.</summary>
    public object GetTopics() =>
        _topics
            .OrderByDescending(kv => kv.Value)
            .Take(500)
            .Select(kv => new { topic = kv.Key, count = kv.Value })
            .ToArray();

    /// <summary>Sample XML for a product type — discovery aid.</summary>
    public string? GetSample(string productType) =>
        _samples.TryGetValue(productType, out var s) ? s : null;
}

class ItwsMessage
{
    public required string Key { get; init; }
    public required string ProductType { get; init; }
    public required string Site { get; init; }
    public required string Topic { get; init; }
    public string? MessageTime { get; init; }
    public DateTime ReceivedAt { get; init; }
    public required string RawXml { get; init; }

    public object ToSummaryJson() => new
    {
        key = Key,
        productType = ProductType,
        site = Site,
        topic = Topic,
        messageTime = MessageTime,
        receivedAt = ReceivedAt.ToString("o"),
        xmlSize = RawXml.Length
    };

    public object ToFullJson() => new
    {
        key = Key,
        productType = ProductType,
        site = Site,
        topic = Topic,
        messageTime = MessageTime,
        receivedAt = ReceivedAt.ToString("o"),
        xmlSize = RawXml.Length,
        rawXml = RawXml
    };
}
