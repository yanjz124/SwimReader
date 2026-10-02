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
            // Keep the callsign index current — otherwise an all-days search would miss
            // today's messages until the next rebuild.
            TdlsCallsignIndex.Note(msg.AircraftId, datePart);
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
    /// Search TDLS history. <paramref name="date"/> null or "all" searches EVERY recorded day,
    /// newest first; a specific YYYY-MM-DD searches just that file.
    ///
    /// The archive is ~1.5 GB over 128 days, so an all-days search cannot simply read it:
    ///  - A callsign query is resolved through <see cref="TdlsCallsignIndex"/> to the handful of days
    ///    that callsign appears in, usually one or two files instead of 128.
    ///  - Every candidate line is pre-filtered by raw substring BEFORE the JSON parse, which is what
    ///    makes a whole-file scan cheap: parsing is reserved for lines that can possibly match.
    ///  - Files are streamed, never ReadAllLines, and only the newest <paramref name="maxResults"/>
    ///    matches are held, so memory is bounded by the result cap rather than by file size.
    ///  - Anything the index can't answer (free text, or the index still building) is scanned
    ///    newest-first under a wall-clock budget and reported as truncated rather than hanging.
    /// </summary>
    public static object Search(string historyDir, string? date, string? query, string? type, string? airport,
        int maxResults = 500, bool reveal = false, int budgetMs = 4000)
    {
        try
        {
            if (!Directory.Exists(historyDir))
                return new { count = 0, results = Array.Empty<object>(), truncated = false };

            var q = query?.Trim().ToUpperInvariant();
            if (q?.Length == 0) q = null;
            var ap = airport?.Trim().ToUpperInvariant();
            var t = type?.Trim().ToUpperInvariant();
            var allDays = string.IsNullOrEmpty(date) || date.Equals("all", StringComparison.OrdinalIgnoreCase);

            // Which day files to look at, newest first.
            List<string> dates;
            var indexed = false;
            if (!allDays)
            {
                dates = new List<string> { Path.GetFileName(date!) };
            }
            else
            {
                TdlsCallsignIndex.EnsureBuilt(historyDir);
                // A callsign-shaped query can skip straight to the days it occurs on. An EMPTY hit is
                // treated as a miss, not as "no results": the index only knows aircraftId, while the
                // search also matches gate, runway and clearance text, so a token the index doesn't
                // recognise ("RNAV") still has to be scanned for.
                //
                // The converse is a deliberate trade: when the index DOES know the callsign we scan
                // only its days, so another day's clearance text that happens to mention it is not
                // returned. This is a callsign lookup, and paying a 1.5 GB scan to catch that would
                // defeat the point.
                IReadOnlyList<string>? hit = (q != null && LooksLikeCallsign(q)) ? TdlsCallsignIndex.DatesFor(q) : null;
                if (hit is { Count: > 0 })
                {
                    dates = hit.ToList();
                    indexed = true;
                }
                else
                {
                    dates = Directory.GetFiles(historyDir, "*.jsonl")
                        .Select(Path.GetFileNameWithoutExtension)
                        .Where(x => !string.IsNullOrEmpty(x))
                        .OrderByDescending(x => x, StringComparer.Ordinal)
                        .ToList()!;
                }
            }

            var results = new List<JsonElement>();
            var truncated = false;
            var sw = System.Diagnostics.Stopwatch.StartNew();
            var scannedDays = 0;

            foreach (var d in dates)
            {
                if (results.Count >= maxResults) { truncated = true; break; }
                // Only an unindexed sweep can run long; an index hit is already a short list.
                if (!indexed && allDays && sw.ElapsedMilliseconds > budgetMs) { truncated = true; break; }

                var path = Path.Combine(historyDir, $"{d}.jsonl");
                if (!File.Exists(path)) continue;
                scannedDays++;

                // Keep only the newest (maxResults - found) matches from this file. Streaming forward
                // with a rolling window costs one pass and bounded memory either way.
                var want = maxResults - results.Count;
                var window = new Queue<JsonElement>(want);
                foreach (var line in File.ReadLines(path))
                {
                    if (line.Length == 0) continue;
                    // Raw-line gates, cheapest first. These can only reject — every survivor is still
                    // fully checked after parsing, so masking rules below stay authoritative.
                    if (ap != null && !line.Contains("\"airport\":\"" + ap + "\"", StringComparison.OrdinalIgnoreCase)) continue;
                    if (q != null && !q.Equals("LADD", StringComparison.Ordinal)
                        && line.IndexOf(q, StringComparison.OrdinalIgnoreCase) < 0) continue;

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
                        }.Where(x => x != null)).ToUpperInvariant();
                        if (!hay.Contains(q)) continue;
                    }

                    window.Enqueue(root);
                    if (window.Count > want) window.Dequeue();     // keep the newest `want`
                }
                // Newest first within the file.
                results.AddRange(window.Reverse());
            }

            if (results.Count > maxResults) results.RemoveRange(maxResults, results.Count - maxResults);
            return new
            {
                count = results.Count,
                results,
                truncated,
                scannedDays,
                // So the UI can say "searching all days" honestly while the index is still warming.
                indexed,
                indexState = allDays ? TdlsCallsignIndex.State.ToString() : null,
            };
        }
        catch (Exception ex)
        {
            return new { error = ex.Message, count = 0, results = Array.Empty<object>(), truncated = false };
        }
    }

    /// <summary>
    /// Callsign shape (2-8 alphanumerics, at least one letter) — the queries the index can answer.
    /// Anything else (gate, runway, free text in a clearance) falls back to a scan.
    /// </summary>
    private static bool LooksLikeCallsign(string q) =>
        q.Length is >= 2 and <= 8 && q.All(char.IsLetterOrDigit) && q.Any(char.IsLetter);

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
