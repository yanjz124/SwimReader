using System.Text.Json;

namespace SwimServer;

/// <summary>
/// Persists every TDLS message (CPDLC clearance + departure event) to daily JSONL files.
/// Files are written under tdls-history/YYYY-MM-DD.jsonl. The PersistenceBudget service
/// trims oldest files when the global cap is exceeded.
/// </summary>
static class TdlsHistoryService
{
    private static readonly object _lock = new();
    private static readonly JsonSerializerOptions _jsonOpts = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull
    };

    public static void Append(TdlsMessage msg, string historyDir)
    {
        try
        {
            Directory.CreateDirectory(historyDir);
            var datePart = msg.Time == default
                ? DateTime.UtcNow.ToString("yyyy-MM-dd")
                : msg.Time.ToString("yyyy-MM-dd");
            var filePath = Path.Combine(historyDir, $"{datePart}.jsonl");

            // Same shape as TdlsMessage.ToJson(), but the TRUE identity (reveal) plus a "ladd" flag
            // when the aircraft is on the LADD list at write time. Readers mask on output (Search,
            // LoadRecent via the live ToJson), like flight-history — so the signed-in reveal can still
            // see it, and a later list change can't un-hide something that was blocked when recorded.
            // Lines written before this change are already masked ("LADD") and stay that way.
            var node = System.Text.Json.Nodes.JsonNode.Parse(JsonSerializer.Serialize(msg.ToJson(reveal: true), _jsonOpts))!.AsObject();
            if (LaddService.IsBlocked(msg.AircraftId, null)) node["ladd"] = true;
            var json = node.ToJsonString(_jsonOpts);
            lock (_lock)
            {
                File.AppendAllText(filePath, json + "\n");
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[TDLS-HIST] Append error: {ex.Message}");
        }
    }

    // Per-date airport counts for the directory's HISTORY view. Past days never change, so they're
    // cached; today's file is re-scanned when it has grown and the cached copy is over a minute old.
    private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, (object data, long len, DateTime at)> _airportCache = new();

    /// <summary>Airports in one day's file: [{airport, aircraftCount, messageCount}] — only the airport
    /// and callsign are pulled from each line (no full JSON parse).</summary>
    public static object AirportsForDate(string historyDir, string date)
    {
        var path = Path.Combine(historyDir, Path.GetFileName(date) + ".jsonl");
        if (!File.Exists(path)) return Array.Empty<object>();
        var len = new FileInfo(path).Length;
        if (_airportCache.TryGetValue(date, out var c) && (c.len == len || DateTime.UtcNow - c.at < TimeSpan.FromMinutes(1)))
            return c.data;
        var msgs = new Dictionary<string, int>();
        var acft = new Dictionary<string, HashSet<string>>();
        using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
        using (var sr = new StreamReader(fs))
        {
            string? line;
            while ((line = sr.ReadLine()) != null)
            {
                var ap = Field(line, "\"airport\":\"");
                if (ap is null) continue;
                msgs[ap] = msgs.GetValueOrDefault(ap) + 1;
                if (!acft.TryGetValue(ap, out var set)) acft[ap] = set = new HashSet<string>();
                if (Field(line, "\"aircraftId\":\"") is { } id) set.Add(id);
            }
        }
        var data = msgs.Select(kv => new { airport = kv.Key, aircraftCount = acft[kv.Key].Count, messageCount = kv.Value })
            .OrderBy(x => x.airport).ToArray();
        _airportCache[date] = (data, len, DateTime.UtcNow);
        return data;
    }

    private static string? Field(string line, string key)
    {
        var i = line.IndexOf(key, StringComparison.Ordinal);
        if (i < 0) return null;
        i += key.Length;
        var j = line.IndexOf('"', i);
        return j > i ? line[i..j] : null;
    }

    /// <summary>List dates that have history files, plus their sizes.</summary>
    public static object ListDates(string historyDir)
    {
        if (!Directory.Exists(historyDir))
            return new { dates = Array.Empty<object>() };
        var dates = Directory.GetFiles(historyDir, "*.jsonl")
            .Select(f =>
            {
                var fi = new FileInfo(f);
                return new
                {
                    date = Path.GetFileNameWithoutExtension(fi.Name),
                    sizeBytes = fi.Length
                };
            })
            .OrderByDescending(x => x.date)
            .ToArray();
        return new { dates };
    }

    /// <summary>
    /// Search TDLS history. Filters: date (YYYY-MM-DD or null=today),
    /// query (case-insensitive substring on callsign/airport/destination/dataBody),
    /// type ("CPDLC"|"DEPART"|null), airport. Caps results at maxResults.
    /// </summary>
    public static object Search(string historyDir, string? date, string? query, string? type, string? airport,
        int maxResults = 500, bool reveal = false)
    {
        var results = new List<JsonElement>();
        try
        {
            if (!Directory.Exists(historyDir))
                return new { count = 0, results = Array.Empty<object>() };

            var d = Path.GetFileName(date ?? DateTime.UtcNow.ToString("yyyy-MM-dd"));
            var path = Path.Combine(historyDir, $"{d}.jsonl");
            if (!File.Exists(path)) return new { count = 0, results = Array.Empty<object>() };

            var q = query?.Trim().ToUpperInvariant();
            var ap = airport?.Trim().ToUpperInvariant();
            var t = type?.Trim().ToUpperInvariant();

            // Reverse order — newest first per file
            var lines = File.ReadAllLines(path);
            for (int i = lines.Length - 1; i >= 0 && results.Count < maxResults; i--)
            {
                var line = lines[i];
                if (string.IsNullOrWhiteSpace(line)) continue;
                // Cheap pre-filter before the JSON parse: an airport-day view skips ~all other lines.
                if (ap != null && !line.Contains("\"airport\":\"" + ap + "\"", StringComparison.OrdinalIgnoreCase)) continue;
                JsonDocument doc;
                try { doc = JsonDocument.Parse(line); } catch { continue; }
                var root = doc.RootElement.Clone();
                doc.Dispose();
                // Mask BEFORE filtering, so a callsign search can't find a hidden flight by its real id.
                if (!reveal && IsLadd(root)) root = Masked(root);

                if (t != null && Get(root, "type")?.ToUpperInvariant() != t) continue;
                if (ap != null && Get(root, "airport")?.ToUpperInvariant() != ap) continue;
                if (q != null)
                {
                    var hay = string.Join(' ', new[]
                    {
                        Get(root, "aircraftId"), Get(root, "airport"), Get(root, "destination"),
                        Get(root, "dataBody"), Get(root, "dataHeader"), Get(root, "runway"),
                        Get(root, "gate"), Get(root, "beaconCode")
                    }.Where(s => s != null)).ToUpperInvariant();
                    if (!hay.Contains(q)) continue;
                }
                results.Add(root);
            }
            return new { count = results.Count, results };
        }
        catch (Exception ex)
        {
            return new { error = ex.Message, count = 0, results = Array.Empty<object>() };
        }
    }

    /// <summary>Flagged when written, or on the current list (catches additions since).</summary>
    public static bool IsLadd(JsonElement r) =>
        (r.TryGetProperty("ladd", out var f) && f.ValueKind == JsonValueKind.True) ||
        LaddService.IsBlocked(Get(r, "aircraftId"), null);

    /// <summary>The public view of a LADD record: id → "LADD", CID and the CPDLC text (which embeds
    /// the call sign) blanked — the same fields TdlsMessage.ToJson masks live.</summary>
    private static JsonElement Masked(JsonElement r)
    {
        var o = System.Text.Json.Nodes.JsonObject.Create(r)!;
        o["aircraftId"] = LaddService.Label;
        o.Remove("cid"); o.Remove("dataHeader"); o.Remove("dataBody"); o.Remove("ladd");
        return JsonSerializer.SerializeToElement(o);
    }

    private static string? Get(JsonElement el, string prop) =>
        el.TryGetProperty(prop, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
}
