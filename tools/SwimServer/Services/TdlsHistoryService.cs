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

            // Same shape as TdlsMessage.ToJson() — already a stable contract used by the live API.
            var json = JsonSerializer.Serialize(msg.ToJson(), _jsonOpts);
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
    public static object Search(string historyDir, string? date, string? query, string? type, string? airport, int maxResults = 500)
    {
        var results = new List<JsonElement>();
        try
        {
            if (!Directory.Exists(historyDir))
                return new { count = 0, results = Array.Empty<object>() };

            var d = date ?? DateTime.UtcNow.ToString("yyyy-MM-dd");
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
                JsonDocument doc;
                try { doc = JsonDocument.Parse(line); } catch { continue; }
                var root = doc.RootElement.Clone();
                doc.Dispose();

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

    private static string? Get(JsonElement el, string prop) =>
        el.TryGetProperty(prop, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
}
