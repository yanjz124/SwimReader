using System.Text.Json;

namespace SwimServer;

/// <summary>
/// Flight history search and retrieval — JSONL files persisted under flight-history/.
/// </summary>
static class HistoryRoutes
{
    public static void Register(WebApplication app, ServerContext ctx)
    {
        // Search history by callsign/origin/dest substring (max 100 results)
        app.MapGet("/api/history", (string? q, string? date) =>
        {
            var dir = ctx.HistoryDir;
            if (!Directory.Exists(dir)) return Results.Json(Array.Empty<object>(), ctx.JsonOpts);
            var query = (q ?? "").Trim().ToUpperInvariant();
            if (query.Length == 0) return Results.Json(Array.Empty<object>(), ctx.JsonOpts);

            // Pick file: specific date or today
            var datePart = date ?? DateTime.UtcNow.ToString("yyyy-MM-dd");
            var filePath = Path.Combine(dir, $"{datePart}.jsonl");
            if (!File.Exists(filePath)) return Results.Json(Array.Empty<object>(), ctx.JsonOpts);

            var results = new List<JsonElement>();
            foreach (var line in File.ReadLines(filePath))
            {
                if (string.IsNullOrWhiteSpace(line)) continue;
                if (line.Contains(query, StringComparison.OrdinalIgnoreCase))
                {
                    results.Add(JsonSerializer.Deserialize<JsonElement>(line));
                    if (results.Count >= 100) break;
                }
            }
            return Results.Json(results, ctx.JsonOpts);
        });

        // List available history dates with file sizes
        app.MapGet("/api/history/dates", () =>
        {
            if (!Directory.Exists(ctx.HistoryDir)) return Results.Json(Array.Empty<object>(), ctx.JsonOpts);
            var files = Directory.GetFiles(ctx.HistoryDir, "*.jsonl")
                .Select(f => new {
                    date = Path.GetFileNameWithoutExtension(f),
                    sizeMb = Math.Round(new FileInfo(f).Length / 1024.0 / 1024.0, 1)
                })
                .OrderByDescending(x => x.date)
                .ToArray();
            return Results.Json(files, ctx.JsonOpts);
        });
    }
}
