namespace SwimServer;

/// <summary>
/// Debug / introspection endpoints under /api/debug/*.
/// All read-only diagnostics — no behavior change vs Program.cs originals.
/// </summary>
static class DebugRoutes
{
    public static void Register(WebApplication app, ServerContext ctx)
    {
        // Debug: find duplicate CIDs for a facility
        app.MapGet("/api/debug/dupe-cids/{facility}", (string facility) =>
        {
            facility = facility.ToUpperInvariant();
            var cidMap = new Dictionary<string, List<object>>();
            foreach (var (gufi, f) in ctx.Flights)
            {
                if (f.ComputerIds.TryGetValue(facility, out var cid) && !string.IsNullOrEmpty(cid))
                {
                    if (!cidMap.ContainsKey(cid)) cidMap[cid] = new List<object>();
                    cidMap[cid].Add(new { gufi, f.Callsign, f.Origin, f.Destination, f.FlightStatus, cid });
                }
            }
            var dupes = cidMap.Where(kv => kv.Value.Count > 1)
                .ToDictionary(kv => kv.Key, kv => kv.Value);
            return Results.Json(new { facility, totalFlights = ctx.Flights.Count, cidsChecked = cidMap.Count, duplicates = dupes }, ctx.JsonOpts);
        });

        // Debug: search flights by callsign
        app.MapGet("/api/debug/search/{callsign}", (string callsign) =>
        {
            var needle = callsign.ToUpperInvariant();
            var matches = ctx.Flights.Where(kv =>
                (kv.Value.Callsign?.ToUpperInvariant().Contains(needle) ?? false) ||
                (kv.Value.ComputerId?.Contains(needle) ?? false))
                .Select(kv => new {
                    kv.Value.Gufi, kv.Value.Callsign, kv.Value.ComputerId,
                    ComputerIds = new Dictionary<string, string>(kv.Value.ComputerIds),
                    kv.Value.Origin, kv.Value.Destination, kv.Value.Squawk
                }).Take(20).ToList();
            return Results.Json(matches, ctx.JsonOpts);
        });

        // Debug: XML element discovery — shows all unique element paths seen in FIXM messages
        app.MapGet("/api/debug/elements", (string? filter) =>
        {
            var elements = ctx.XmlElements.ToArray()
                .Where(kv => string.IsNullOrEmpty(filter) ||
                    kv.Key.Contains(filter, StringComparison.OrdinalIgnoreCase))
                .OrderBy(kv => kv.Key)
                .Select(kv => new { path = kv.Key, count = kv.Value })
                .ToList();
            return Results.Json(new { totalPaths = ctx.XmlElements.Count, showing = elements.Count, elements }, ctx.JsonOpts);
        });

        // Debug: raw XML sample for a given message source type
        app.MapGet("/api/debug/raw/{source}", (string source) =>
        {
            source = source.ToUpperInvariant();
            if (ctx.XmlSampleStore.TryGetValue(source, out var xml))
                return Results.Content(xml, "application/xml");
            return Results.NotFound($"No sample for source '{source}'");
        });

        // Debug: search raw XML samples for a keyword (e.g., "cpdlc", "dataLink", "authority")
        app.MapGet("/api/debug/xml-search", (string q) =>
        {
            var results = ctx.XmlSampleStore
                .Where(kv => kv.Value.Contains(q, StringComparison.OrdinalIgnoreCase))
                .Select(kv => {
                    // Find context around the match
                    var idx = kv.Value.IndexOf(q, StringComparison.OrdinalIgnoreCase);
                    var start = Math.Max(0, idx - 200);
                    var end = Math.Min(kv.Value.Length, idx + q.Length + 200);
                    return new { source = kv.Key, context = kv.Value[start..end] };
                }).ToList();
            return Results.Json(new { query = q, sourcesSearched = ctx.XmlSampleStore.Count, matches = results }, ctx.JsonOpts);
        });

        // Debug: all unique nameValue keys seen in supplementalData
        app.MapGet("/api/debug/namevalue-keys", () =>
        {
            var keys = ctx.NameValueKeys.ToArray()
                .OrderByDescending(kv => kv.Value)
                .Select(kv => new { key = kv.Key, count = kv.Value })
                .ToList();
            return Results.Json(new { totalKeys = keys.Count, keys }, ctx.JsonOpts);
        });

        // Debug: position-age bucket histogram across all tracked flights
        app.MapGet("/api/debug/posage", () =>
        {
            var withPos = ctx.Flights.Values.Where(f => f.Latitude.HasValue).ToList();
            var nullPosTime = withPos.Count(f => f.LastPositionTime == default);
            var buckets = withPos.Where(f => f.LastPositionTime != default)
                .GroupBy(f => {
                    var age = (int)(DateTime.UtcNow - f.LastPositionTime).TotalSeconds;
                    return age switch { < 15 => "0-14s", < 30 => "15-29s", < 60 => "30-59s", < 300 => "1-5m", _ => ">5m" };
                })
                .ToDictionary(g => g.Key, g => g.Count());
            return Results.Json(new { total = withPos.Count, nullLastPositionTime = nullPosTime, buckets });
        });

        // Debug: CPDLC capability summary across all tracked flights
        app.MapGet("/api/debug/cpdlc", () =>
        {
            var cpdlcFlights = ctx.Flights.Values
                .Where(f => !string.IsNullOrEmpty(f.DataLinkCode) && f.DataLinkCode.Contains("J"))
                .Select(f => new {
                    f.Gufi, f.Callsign, f.AircraftType,
                    f.DataLinkCode, f.OtherDataLink, f.CommunicationCode,
                    f.Origin, f.Destination,
                    f.ControllingFacility, f.ControllingSector,
                    f.FlightStatus
                })
                .Take(100).ToList();
            var total = ctx.Flights.Count;
            var jCount = ctx.Flights.Values.Count(f => !string.IsNullOrEmpty(f.DataLinkCode) && f.DataLinkCode.Contains("J"));
            var cpdlcXCount = ctx.Flights.Values.Count(f =>
                !string.IsNullOrEmpty(f.OtherDataLink) &&
                f.OtherDataLink.Contains("CPDLC", StringComparison.OrdinalIgnoreCase));
            return Results.Json(new {
                totalFlights = total,
                dataLinkJ = jCount,
                otherDataLinkCPDLC = cpdlcXCount,
                sampleFlights = cpdlcFlights
            }, ctx.JsonOpts);
        });

        // Debug: flights with clearance data (heading/speed/text)
        app.MapGet("/api/debug/clearance", () =>
        {
            var clrFlights = ctx.Flights.Values
                .Where(f => !string.IsNullOrEmpty(f.ClearanceHeading) || !string.IsNullOrEmpty(f.ClearanceSpeed) || !string.IsNullOrEmpty(f.ClearanceText))
                .Select(f => new { f.Gufi, f.Callsign, f.ControllingFacility, f.ControllingSector, f.ClearanceHeading, f.ClearanceSpeed, f.ClearanceText, f.Origin, f.Destination })
                .OrderBy(f => f.ControllingFacility)
                .ToList();
            return Results.Json(new { total = ctx.Flights.Count, withClearance = clrFlights.Count, flights = clrFlights }, ctx.JsonOpts);
        });

        // Debug: clearance raw XML log — shows raw SFDPS XML for clearance-related events
        app.MapGet("/api/debug/clearance-log", (int? last) =>
        {
            var entries = ctx.ClearanceLog.ToArray();
            var n = last ?? 100;
            var recent = entries.Length > n ? entries[^n..] : entries;
            return Results.Text(string.Join("\n", recent), "text/plain");
        });

        app.MapGet("/api/debug/altitude-log", (int? last) =>
        {
            var entries = ctx.AltitudeLog.ToArray();
            var n = last ?? 200;
            var recent = entries.Length > n ? entries[^n..] : entries;
            return Results.Text(string.Join("\n", recent), "text/plain");
        });

        // Debug: STDDS message telemetry — all topic/root-element combinations received from STDDS
        app.MapGet("/api/debug/stdds", () =>
        {
            var entries = ctx.StddsMessageCounts
                .Select(kv => new { key = kv.Key, count = kv.Value })
                .OrderByDescending(x => x.count)
                .ToList();
            return Results.Json(new { totalKeys = entries.Count, messages = entries }, ctx.JsonOpts);
        });

        // Debug: STDDS sample XML — first message seen for each topic/root-element key
        app.MapGet("/api/debug/stdds/{key}", (string key) =>
        {
            // key is URL-encoded, e.g. "TAIS/TAStatus" or "APDS/someRoot"
            key = Uri.UnescapeDataString(key);
            if (ctx.StddsSamples.TryGetValue(key, out var sample))
                return Results.Text(sample, "application/xml");
            return Results.NotFound();
        });

        // Debug: enable raw-XML capture for matching callsigns. Body is a
        // CSV or comma-separated list. Empty body clears the watch list.
        // GET returns the current watch list + log file path + log size.
        app.MapGet("/api/debug/tais-watch", () =>
        {
            var path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "tais-watch.log");
            long size = System.IO.File.Exists(path) ? new System.IO.FileInfo(path).Length : 0;
            return Results.Json(new {
                callsigns = TaisBridge.WatchCallsigns.Keys.ToList(),
                logPath = path,
                logBytes = size,
            }, ctx.JsonOpts);
        });
        app.MapPut("/api/debug/tais-watch", async (HttpRequest req) =>
        {
            using var sr = new System.IO.StreamReader(req.Body);
            var body = (await sr.ReadToEndAsync()).Trim();
            TaisBridge.WatchCallsigns.Clear();
            foreach (var cs in body.Split(new[] { ',', '\n', ' ' }, StringSplitOptions.RemoveEmptyEntries))
                TaisBridge.WatchCallsigns.TryAdd(cs.Trim().ToUpperInvariant(), 0);
            return Results.Json(new { watching = TaisBridge.WatchCallsigns.Keys.ToList() }, ctx.JsonOpts);
        });
        // Read (and optionally clear) the captured log.
        app.MapGet("/api/debug/tais-watch/log", (bool? clear) =>
        {
            var path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "tais-watch.log");
            if (!System.IO.File.Exists(path)) return Results.Text("", "text/plain");
            var content = System.IO.File.ReadAllText(path);
            if (clear == true) System.IO.File.WriteAllText(path, "");
            return Results.Text(content, "text/plain");
        });
    }
}
