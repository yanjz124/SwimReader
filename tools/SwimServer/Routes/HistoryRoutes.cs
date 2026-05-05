using System.Text.Json;

namespace SwimServer;

/// <summary>
/// Flight history search and retrieval — JSONL files persisted under flight-history/.
/// </summary>
static class HistoryRoutes
{
    public static void Register(WebApplication app, ServerContext ctx)
    {
        // Search history by callsign prefix / origin / destination / registration / CID.
        // Field-scoped match — avoids false positives where the query happens to appear
        // inside route strings, GUFIs, or other freeform text on the JSON line.
        app.MapGet("/api/history", (string? q, string? date) =>
        {
            var dir = ctx.HistoryDir;
            if (!Directory.Exists(dir)) return Results.Json(Array.Empty<object>(), ctx.JsonOpts);
            var query = (q ?? "").Trim().ToUpperInvariant();
            if (query.Length == 0) return Results.Json(Array.Empty<object>(), ctx.JsonOpts);

            var datePart = date ?? DateTime.UtcNow.ToString("yyyy-MM-dd");
            var filePath = Path.Combine(dir, $"{datePart}.jsonl");
            if (!File.Exists(filePath)) return Results.Json(Array.Empty<object>(), ctx.JsonOpts);

            var results = new List<JsonElement>();
            foreach (var line in File.ReadLines(filePath))
            {
                if (string.IsNullOrWhiteSpace(line)) continue;
                // Cheap pre-filter: skip lines that don't contain the query anywhere
                if (!line.Contains(query, StringComparison.OrdinalIgnoreCase)) continue;
                JsonElement el;
                try { el = JsonSerializer.Deserialize<JsonElement>(line); }
                catch { continue; }

                if (!HistoryMatches(el, query)) continue;
                results.Add(el);
                if (results.Count >= 100) break;
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

    // Match a history record against an uppercased query.
    // Matches: callsign starts-with, origin/destination (FAA LID or ICAO), registration prefix, CID exact.
    private static bool HistoryMatches(JsonElement el, string query)
    {
        if (TryStr(el, "callsign", out var cs) && cs.StartsWith(query, StringComparison.OrdinalIgnoreCase))
            return true;
        if (TryStr(el, "origin", out var or) && AirportMatches(or, query)) return true;
        if (TryStr(el, "destination", out var dst) && AirportMatches(dst, query)) return true;
        if (TryStr(el, "registration", out var reg) && reg.StartsWith(query, StringComparison.OrdinalIgnoreCase))
            return true;
        if (TryStr(el, "computerId", out var cid) && cid.Equals(query, StringComparison.OrdinalIgnoreCase))
            return true;
        return false;
    }

    // Airport code matches if equal, or if it's the 4-letter ICAO with K/P prefix and the rest equals query.
    private static bool AirportMatches(string field, string query)
    {
        if (field.Equals(query, StringComparison.OrdinalIgnoreCase)) return true;
        if (field.Length == 4 && (field[0] == 'K' || field[0] == 'P') &&
            field.AsSpan(1).Equals(query.AsSpan(), StringComparison.OrdinalIgnoreCase))
            return true;
        // Reverse: query is 4-letter ICAO, field is 3-letter LID
        if (query.Length == 4 && (query[0] == 'K' || query[0] == 'P') &&
            field.AsSpan().Equals(query.AsSpan(1), StringComparison.OrdinalIgnoreCase))
            return true;
        return false;
    }

    private static bool TryStr(JsonElement el, string name, out string value)
    {
        if (el.TryGetProperty(name, out var p) && p.ValueKind == JsonValueKind.String)
        {
            var v = p.GetString();
            if (v is not null) { value = v; return true; }
        }
        value = "";
        return false;
    }
}
