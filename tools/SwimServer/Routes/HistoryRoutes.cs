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

        // Filter out 'pinned.jsonl' from the dates list — it's not a date file.
        app.MapGet("/api/history/dates", () =>
        {
            if (!Directory.Exists(ctx.HistoryDir)) return Results.Json(Array.Empty<object>(), ctx.JsonOpts);
            var files = Directory.GetFiles(ctx.HistoryDir, "*.jsonl")
                .Where(f => !Path.GetFileName(f).Equals("pinned.jsonl", StringComparison.OrdinalIgnoreCase))
                .Select(f => new {
                    date = Path.GetFileNameWithoutExtension(f),
                    sizeMb = Math.Round(new FileInfo(f).Length / 1024.0 / 1024.0, 1)
                })
                .OrderByDescending(x => x.date)
                .ToArray();
            return Results.Json(files, ctx.JsonOpts);
        });

        // ── Pinned flights: server-side, persists across restarts and disk cleanup ──

        // List all pin entries (active + within grace period). Returns:
        //   { gufi: { pinned: bool, pinnedAt: iso, unpinnedAt: iso?, callsign, origin, destination } }
        app.MapGet("/api/history/pins", () =>
        {
            var dict = FlightPinService.GetAll().ToDictionary(kv => kv.Key, kv => (object)kv.Value);
            return Results.Json(dict, ctx.JsonOpts);
        });

        // Full pinned-flight content (records as stored in pinned.jsonl).
        // Frontend uses this to populate historical pins regardless of date.
        app.MapGet("/api/history/pinned", () =>
        {
            return Results.Json(FlightPinService.ReadAllRecords(), ctx.JsonOpts);
        });

        // Pin a flight. Body: { gufi, record? }
        // If record is omitted, the server tries to look it up in the live flights dict.
        app.MapPost("/api/history/pin", async (HttpContext http) =>
        {
            using var doc = await JsonDocument.ParseAsync(http.Request.Body);
            var root = doc.RootElement;
            if (!root.TryGetProperty("gufi", out var gufiEl) || gufiEl.ValueKind != JsonValueKind.String)
                return Results.BadRequest(new { error = "gufi required" });
            var gufi = gufiEl.GetString()!;

            string? recordJson = null;
            string? callsign = null, origin = null, destination = null;
            DateTime? lastSeen = null;

            // Path A: caller passed the record body
            if (root.TryGetProperty("record", out var recEl) && recEl.ValueKind == JsonValueKind.Object)
            {
                recordJson = recEl.GetRawText();
                if (recEl.TryGetProperty("callsign", out var c) && c.ValueKind == JsonValueKind.String) callsign = c.GetString();
                if (recEl.TryGetProperty("origin", out var o) && o.ValueKind == JsonValueKind.String) origin = o.GetString();
                if (recEl.TryGetProperty("destination", out var d) && d.ValueKind == JsonValueKind.String) destination = d.GetString();
                if (recEl.TryGetProperty("lastSeen", out var ls) && ls.ValueKind == JsonValueKind.String &&
                    DateTime.TryParse(ls.GetString(), out var parsed)) lastSeen = parsed;
            }

            // Path B: live flight in the in-memory dict
            if (recordJson is null && ctx.Flights.TryGetValue(gufi, out var fp))
            {
                recordJson = JsonSerializer.Serialize(fp.ToSummary(true), ctx.JsonOpts);
                callsign = fp.Callsign;
                origin = fp.Origin;
                destination = fp.Destination;
                lastSeen = fp.LastSeen;
            }

            // Path C: scan flight-history files for this GUFI (last week of files)
            if (recordJson is null && Directory.Exists(ctx.HistoryDir))
            {
                var needle = $"\"gufi\":\"{gufi}\"";
                var files = Directory.GetFiles(ctx.HistoryDir, "*.jsonl")
                    .Where(f => !Path.GetFileName(f).Equals("pinned.jsonl", StringComparison.OrdinalIgnoreCase))
                    .OrderByDescending(f => f).Take(7);
                foreach (var file in files)
                {
                    foreach (var line in File.ReadLines(file))
                    {
                        if (!line.Contains(needle, StringComparison.OrdinalIgnoreCase)) continue;
                        try
                        {
                            var el = JsonSerializer.Deserialize<JsonElement>(line);
                            if (el.TryGetProperty("gufi", out var g) && g.GetString() == gufi)
                            {
                                recordJson = line;
                                if (el.TryGetProperty("callsign", out var c) && c.ValueKind == JsonValueKind.String) callsign = c.GetString();
                                if (el.TryGetProperty("origin", out var o) && o.ValueKind == JsonValueKind.String) origin = o.GetString();
                                if (el.TryGetProperty("destination", out var d) && d.ValueKind == JsonValueKind.String) destination = d.GetString();
                                if (el.TryGetProperty("lastSeen", out var ls) && ls.ValueKind == JsonValueKind.String &&
                                    DateTime.TryParse(ls.GetString(), out var parsed)) lastSeen = parsed;
                                break;
                            }
                        }
                        catch { }
                    }
                    if (recordJson is not null) break;
                }
            }

            if (recordJson is null)
                return Results.NotFound(new { error = "flight not found in live or history" });

            FlightPinService.Pin(gufi, recordJson, callsign, origin, destination, lastSeen);
            return Results.Ok(new { pinned = true, gufi });
        });

        // Unpin a flight. Body: { gufi }. Record stays for grace period.
        app.MapPost("/api/history/unpin", async (HttpContext http) =>
        {
            using var doc = await JsonDocument.ParseAsync(http.Request.Body);
            if (!doc.RootElement.TryGetProperty("gufi", out var gufiEl) || gufiEl.ValueKind != JsonValueKind.String)
                return Results.BadRequest(new { error = "gufi required" });
            var gufi = gufiEl.GetString()!;
            var ok = FlightPinService.Unpin(gufi);
            if (!ok) return Results.NotFound(new { error = "not pinned" });
            return Results.Ok(new { pinned = false, gufi });
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
    // Keys are unique lowercase forms. Long names are also accepted via the
    // dictionary's case-insensitive comparer, so 'callsign', 'CALLSIGN', etc. all work.
    private static readonly Dictionary<string, string> FieldAlias =
        new(StringComparer.OrdinalIgnoreCase)
    {
        { "cs", "callsign" }, { "callsign", "callsign" },
        { "op", "operator" }, { "operator", "operator" }, { "airline", "operator" },
        { "org", "origin" }, { "origin", "origin" }, { "from", "origin" }, { "dep", "origin" },
        { "dest", "destination" }, { "destination", "destination" }, { "to", "destination" }, { "arr", "destination" },
        { "alternate", "alternateAerodrome" }, { "altdest", "alternateAerodrome" },
        { "type", "aircraftType" }, { "actype", "aircraftType" }, { "ac", "aircraftType" },
        { "reg", "registration" }, { "registration", "registration" },
        { "wake", "wakeCategory" },
        { "modes", "modeSCode" },
        { "equip", "equipmentQualifier" }, { "equipment", "equipmentQualifier" },
        { "sq", "squawk" }, { "squawk", "squawk" }, { "beacon", "squawk" },
        { "bcn", "assignedSquawk" },
        { "rules", "flightRules" },
        { "ftype", "flightType" },
        { "route", "route" }, { "rte", "route" },
        { "origroute", "originalRoute" },
        { "star", "STAR" },
        { "rmk", "remarks" }, { "remarks", "remarks" }, { "rmks", "remarks" },
        { "alt", "assignedAltitude" }, { "altitude", "assignedAltitude" },
        { "status", "flightStatus" },
        { "cid", "computerId" },
        { "fac", "controllingFacility" }, { "facility", "controllingFacility" },
        { "sector", "controllingSector" },
        { "ho", "handoffEvent" }, { "handoff", "handoffEvent" },
        { "po", "pointoutOriginatingUnit" }, { "pointout", "pointoutOriginatingUnit" },
        { "hdg", "clearanceHeading" }, { "heading", "clearanceHeading" },
        { "speed", "clearanceSpeed" },
        { "text", "clearanceText" },
        { "tmi", "tmiIds" },
        { "datalink", "dataLinkCode" }, { "cpdlc", "dataLinkCode" },
        { "gufi", "gufi" }, { "fdpsgufi", "fdpsGufi" },
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
