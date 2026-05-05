using System.Text.Json;

namespace SwimServer;

/// <summary>
/// Flight history search and retrieval — JSONL files persisted under flight-history/.
/// </summary>
static class HistoryRoutes
{
    public static void Register(WebApplication app, ServerContext ctx)
    {
        // Search history with field-scoped query syntax:
        //   bare value       — default fields (callsign starts-with, origin/dest, reg, cid)
        //   field:value      — match a specific field
        //   value with *     — wildcard (foo*, *foo, *foo*)
        //   multiple terms   — AND'ed together (whitespace-separated)
        //
        // Supported field aliases:
        //   cs/callsign, op/operator, origin/org, dest/destination,
        //   reg/registration, cid/computerId, type/actype/aircraftType,
        //   sq/squawk, route, rmk/remarks, star, status/flightStatus,
        //   fac/facility/controllingFacility, sector/controllingSector,
        //   gufi, alt/altitude/assignedAltitude
        app.MapGet("/api/history", (string? q, string? date) =>
        {
            var dir = ctx.HistoryDir;
            if (!Directory.Exists(dir)) return Results.Json(Array.Empty<object>(), ctx.JsonOpts);
            var raw = (q ?? "").Trim();
            if (raw.Length == 0) return Results.Json(Array.Empty<object>(), ctx.JsonOpts);

            var clauses = ParseQuery(raw);
            if (clauses.Count == 0) return Results.Json(Array.Empty<object>(), ctx.JsonOpts);

            var datePart = date ?? DateTime.UtcNow.ToString("yyyy-MM-dd");
            var filePath = Path.Combine(dir, $"{datePart}.jsonl");
            if (!File.Exists(filePath)) return Results.Json(Array.Empty<object>(), ctx.JsonOpts);

            // Cheap line-level pre-filter: every clause's literal portion (with wildcards
            // stripped) must appear somewhere in the line. Field-scoped match decides inclusion.
            var preFilters = clauses.Select(c => c.Pattern.Replace("*", "").ToUpperInvariant())
                                    .Where(s => s.Length > 0)
                                    .ToList();

            var results = new List<JsonElement>();
            foreach (var line in File.ReadLines(filePath))
            {
                if (string.IsNullOrWhiteSpace(line)) continue;
                bool prePass = true;
                foreach (var p in preFilters)
                {
                    if (!line.Contains(p, StringComparison.OrdinalIgnoreCase)) { prePass = false; break; }
                }
                if (!prePass) continue;

                JsonElement el;
                try { el = JsonSerializer.Deserialize<JsonElement>(line); }
                catch { continue; }

                bool allMatch = true;
                foreach (var c in clauses)
                {
                    if (!ClauseMatches(el, c)) { allMatch = false; break; }
                }
                if (!allMatch) continue;

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

    // ── Query parsing ───────────────────────────────────────────────────────

    /// <summary>One parsed search clause: a field name (or null = default fields)
    /// and a pattern that may contain * wildcards.</summary>
    private record SearchClause(string? Field, string Pattern);

    /// <summary>Tokenize query into clauses. Whitespace-separated; quoted strings
    /// preserved as a single token (e.g. remarks:"new pilot" is one clause).</summary>
    private static List<SearchClause> ParseQuery(string raw)
    {
        var tokens = new List<string>();
        var sb = new System.Text.StringBuilder();
        bool inQuotes = false;
        foreach (var c in raw)
        {
            if (c == '"') { inQuotes = !inQuotes; continue; }
            if (!inQuotes && char.IsWhiteSpace(c))
            {
                if (sb.Length > 0) { tokens.Add(sb.ToString()); sb.Clear(); }
            }
            else sb.Append(c);
        }
        if (sb.Length > 0) tokens.Add(sb.ToString());

        var clauses = new List<SearchClause>();
        foreach (var t in tokens)
        {
            if (t.Length == 0) continue;
            var colon = t.IndexOf(':');
            if (colon > 0 && colon < t.Length - 1)
            {
                clauses.Add(new SearchClause(t[..colon], t[(colon + 1)..]));
            }
            else
            {
                clauses.Add(new SearchClause(null, t));
            }
        }
        return clauses;
    }

    // Map field aliases (case-insensitive) to actual JSON property names.
    private static readonly Dictionary<string, string> FieldAlias =
        new(StringComparer.OrdinalIgnoreCase)
    {
        { "cs", "callsign" }, { "callsign", "callsign" },
        { "op", "operator" }, { "operator", "operator" }, { "airline", "operator" },
        { "org", "origin" }, { "origin", "origin" }, { "from", "origin" }, { "dep", "origin" },
        { "dest", "destination" }, { "destination", "destination" }, { "to", "destination" }, { "arr", "destination" },
        { "alt", "alternateAerodrome" }, { "alternate", "alternateAerodrome" },
        { "type", "aircraftType" }, { "actype", "aircraftType" }, { "aircraftType", "aircraftType" }, { "ac", "aircraftType" },
        { "reg", "registration" }, { "registration", "registration" },
        { "wake", "wakeCategory" }, { "wakeCategory", "wakeCategory" },
        { "modes", "modeSCode" }, { "modeSCode", "modeSCode" },
        { "equip", "equipmentQualifier" }, { "equipment", "equipmentQualifier" },
        { "sq", "squawk" }, { "squawk", "squawk" }, { "beacon", "squawk" },
        { "bcn", "assignedSquawk" }, { "assignedSquawk", "assignedSquawk" },
        { "rules", "flightRules" }, { "flightRules", "flightRules" },
        { "ftype", "flightType" }, { "flightType", "flightType" },
        { "route", "route" }, { "rte", "route" },
        { "originalRoute", "originalRoute" },
        { "star", "STAR" }, { "STAR", "STAR" },
        { "rmk", "remarks" }, { "remarks", "remarks" }, { "rmks", "remarks" },
        { "altitude", "assignedAltitude" }, { "assignedAltitude", "assignedAltitude" },
        { "status", "flightStatus" }, { "flightStatus", "flightStatus" },
        { "cid", "computerId" }, { "computerId", "computerId" },
        { "fac", "controllingFacility" }, { "facility", "controllingFacility" }, { "controllingFacility", "controllingFacility" },
        { "sector", "controllingSector" }, { "controllingSector", "controllingSector" },
        { "ho", "handoffEvent" }, { "handoff", "handoffEvent" }, { "handoffEvent", "handoffEvent" },
        { "po", "pointoutOriginatingUnit" }, { "pointout", "pointoutOriginatingUnit" },
        { "hdg", "clearanceHeading" }, { "heading", "clearanceHeading" },
        { "speed", "clearanceSpeed" }, { "clearanceSpeed", "clearanceSpeed" },
        { "text", "clearanceText" }, { "clearanceText", "clearanceText" },
        { "tmi", "tmiIds" }, { "tmiIds", "tmiIds" },
        { "datalink", "dataLinkCode" }, { "cpdlc", "dataLinkCode" }, { "dataLinkCode", "dataLinkCode" },
        { "gufi", "gufi" }, { "fdpsGufi", "fdpsGufi" },
    };

    /// <summary>Default fields searched when a clause has no explicit field prefix.
    /// Each entry is (json field name, match style).</summary>
    private static readonly (string field, MatchStyle style)[] DefaultFields = new[]
    {
        ("callsign", MatchStyle.StartsWith),
        ("origin", MatchStyle.Airport),
        ("destination", MatchStyle.Airport),
        ("registration", MatchStyle.StartsWith),
        ("computerId", MatchStyle.Exact),
    };

    private enum MatchStyle { StartsWith, Exact, Contains, Airport }

    private static bool ClauseMatches(JsonElement el, SearchClause c)
    {
        // Field-scoped clause
        if (c.Field is not null)
        {
            if (!FieldAlias.TryGetValue(c.Field, out var jsonField)) return false;
            if (!TryStr(el, jsonField, out var v)) return false;
            return WildcardMatch(v, c.Pattern, defaultStyle: MatchStyle.Contains);
        }

        // Bare clause: try each default field
        foreach (var (jf, style) in DefaultFields)
        {
            if (TryStr(el, jf, out var v) && WildcardMatch(v, c.Pattern, style))
                return true;
        }
        return false;
    }

    /// <summary>Match value against a pattern that may contain * wildcards.
    /// If pattern has no wildcards, defaultStyle determines how to match
    /// (StartsWith, Exact, Contains, or Airport with K/P prefix tolerance).</summary>
    private static bool WildcardMatch(string value, string pattern, MatchStyle defaultStyle)
    {
        if (pattern.Contains('*'))
        {
            // *foo* = contains, foo* = starts-with, *foo = ends-with
            var leading = pattern.StartsWith('*');
            var trailing = pattern.EndsWith('*');
            var core = pattern.Trim('*');
            if (core.Length == 0) return value.Length > 0;
            if (leading && trailing) return value.Contains(core, StringComparison.OrdinalIgnoreCase);
            if (leading) return value.EndsWith(core, StringComparison.OrdinalIgnoreCase);
            if (trailing) return value.StartsWith(core, StringComparison.OrdinalIgnoreCase);
            // Wildcards only in the middle (e.g. AAL*23): regex-style with literal escape
            var parts = pattern.Split('*');
            int idx = 0;
            for (int i = 0; i < parts.Length; i++)
            {
                if (parts[i].Length == 0) continue;
                var found = value.IndexOf(parts[i], idx, StringComparison.OrdinalIgnoreCase);
                if (found < 0) return false;
                if (i == 0 && found != 0) return false; // first segment must anchor at start
                idx = found + parts[i].Length;
            }
            // Last segment must anchor at end
            if (parts[^1].Length > 0 && !value.EndsWith(parts[^1], StringComparison.OrdinalIgnoreCase)) return false;
            return true;
        }

        return defaultStyle switch
        {
            MatchStyle.StartsWith => value.StartsWith(pattern, StringComparison.OrdinalIgnoreCase),
            MatchStyle.Exact => value.Equals(pattern, StringComparison.OrdinalIgnoreCase),
            MatchStyle.Contains => value.Contains(pattern, StringComparison.OrdinalIgnoreCase),
            MatchStyle.Airport => AirportMatches(value, pattern),
            _ => false,
        };
    }

    // Airport code matches if equal, or if 4-letter ICAO with K/P prefix and rest matches.
    private static bool AirportMatches(string field, string query)
    {
        if (field.Equals(query, StringComparison.OrdinalIgnoreCase)) return true;
        if (field.Length == 4 && (field[0] == 'K' || field[0] == 'P') &&
            field.AsSpan(1).Equals(query.AsSpan(), StringComparison.OrdinalIgnoreCase))
            return true;
        if (query.Length == 4 && (query[0] == 'K' || query[0] == 'P') &&
            field.AsSpan().Equals(query.AsSpan(1), StringComparison.OrdinalIgnoreCase))
            return true;
        return false;
    }

    private static bool TryStr(JsonElement el, string name, out string value)
    {
        if (el.TryGetProperty(name, out var p))
        {
            if (p.ValueKind == JsonValueKind.String)
            {
                var v = p.GetString();
                if (v is not null) { value = v; return true; }
            }
            else if (p.ValueKind == JsonValueKind.Number)
            {
                value = p.ToString();
                return true;
            }
        }
        value = "";
        return false;
    }
}
