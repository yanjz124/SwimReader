using System.IO.Compression;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

namespace SwimServer;

/// <summary>
/// Serves recorded replay data over WebSocket, supporting seek, speed control, and pause/resume.
/// Clients receive the same snapshot/batch/remove protocol as live connections.
/// </summary>
public class ReplayServer
{
    private readonly string _replayBaseDir;
    private readonly JsonSerializerOptions _jsonOpts;

    public ReplayServer(string replayBaseDir, JsonSerializerOptions jsonOpts)
    {
        _replayBaseDir = replayBaseDir;
        _jsonOpts = jsonOpts;
    }

    // ── Viewport filtering ────────────────────────────────────────────────────
    // When a client provides a viewport (map bounds, already padded with a buffer),
    // the replay stream is filtered to tracks inside it, and the server keeps a
    // running per-session state model so it can re-snapshot the visible region the
    // instant the viewport changes (pan/zoom) — no missing tracks, full integrity.
    // No viewport supplied → state is not maintained and records pass through
    // unchanged, identical to the original full-NAS stream (backward compatible).

    private sealed record Bounds(double MinLat, double MinLon, double MaxLat, double MaxLon)
    {
        public bool Contains(double lat, double lon) =>
            lat >= MinLat && lat <= MaxLat && lon >= MinLon && lon <= MaxLon;
    }

    /// <summary>Latest client viewport. Reference is swapped atomically by the receive
    /// loop and read by the playback loop; <see cref="Changed"/> signals a re-snapshot.</summary>
    private sealed class Viewport
    {
        private volatile Bounds? _b;
        public Bounds? Bounds { get => _b; set => _b = value; }
        public volatile bool Changed;
    }

    /// <summary>One track's last-known position + raw JSON, for viewport re-snapshots.</summary>
    private sealed class StateRec
    {
        public double? Lat;
        public double? Lon;
        public JsonElement El;   // detached clone — survives the source document
    }

    private static Bounds? ParseBoundsFromQuery(HttpContext ctx)
    {
        var q = ctx.Request.Query;
        if (double.TryParse(q["minLat"], System.Globalization.CultureInfo.InvariantCulture, out var minLat) &&
            double.TryParse(q["minLon"], System.Globalization.CultureInfo.InvariantCulture, out var minLon) &&
            double.TryParse(q["maxLat"], System.Globalization.CultureInfo.InvariantCulture, out var maxLat) &&
            double.TryParse(q["maxLon"], System.Globalization.CultureInfo.InvariantCulture, out var maxLon))
        {
            return new Bounds(minLat, minLon, maxLat, maxLon);
        }
        return null;
    }

    public void MapEndpoints(WebApplication app)
    {
        // ERAM replay metadata
        app.MapGet("/api/replay/range", () =>
        {
            var eramDir = Path.Combine(_replayBaseDir, "eram");
            var eramRange = GetTimeRange(eramDir);

            var asdexBase = Path.Combine(_replayBaseDir, "asdex");
            var asdexRanges = new Dictionary<string, object>();
            if (Directory.Exists(asdexBase))
            {
                foreach (var dir in Directory.GetDirectories(asdexBase))
                {
                    var airport = Path.GetFileName(dir);
                    var range = GetTimeRange(dir);
                    if (range != null)
                        asdexRanges[airport] = range;
                }
            }

            return Results.Json(new { eram = eramRange, asdex = asdexRanges }, _jsonOpts);
        });

        // ERAM replay WebSocket
        app.Map("/replay/ws", async (HttpContext ctx) =>
        {
            if (!ctx.WebSockets.IsWebSocketRequest) { ctx.Response.StatusCode = 400; return; }
            var startParam = ctx.Request.Query["start"].FirstOrDefault();
            var speedParam = ctx.Request.Query["speed"].FirstOrDefault();
            if (string.IsNullOrEmpty(startParam))
            {
                ctx.Response.StatusCode = 400;
                await ctx.Response.WriteAsync("Missing 'start' query parameter");
                return;
            }

            if (!DateTime.TryParse(startParam, null, System.Globalization.DateTimeStyles.AdjustToUniversal, out var startTime))
            {
                ctx.Response.StatusCode = 400;
                await ctx.Response.WriteAsync("Invalid 'start' format. Use ISO 8601.");
                return;
            }

            var speed = 1.0;
            if (!string.IsNullOrEmpty(speedParam)) double.TryParse(speedParam, out speed);

            var initialBounds = ParseBoundsFromQuery(ctx);
            using var ws = await ctx.WebSockets.AcceptWebSocketAsync();
            var dir = Path.Combine(_replayBaseDir, "eram");
            double.TryParse(ctx.Request.Query["preload"].FirstOrDefault(), out var preloadSeconds);
            await RunReplaySession(ws, dir, startTime, speed, initialBounds, preloadSeconds);
        });

        // ASDE-X replay WebSocket
        app.Map("/replay/asdex/ws/{airport}", async (HttpContext ctx, string airport) =>
        {
            if (!ctx.WebSockets.IsWebSocketRequest) { ctx.Response.StatusCode = 400; return; }
            var startParam = ctx.Request.Query["start"].FirstOrDefault();
            var speedParam = ctx.Request.Query["speed"].FirstOrDefault();
            if (string.IsNullOrEmpty(startParam))
            {
                ctx.Response.StatusCode = 400;
                await ctx.Response.WriteAsync("Missing 'start' query parameter");
                return;
            }

            if (!DateTime.TryParse(startParam, null, System.Globalization.DateTimeStyles.AdjustToUniversal, out var startTime))
            {
                ctx.Response.StatusCode = 400;
                return;
            }

            var speed = 1.0;
            if (!string.IsNullOrEmpty(speedParam)) double.TryParse(speedParam, out speed);

            var icao = airport.ToUpperInvariant();
            if (!icao.StartsWith("K") && !icao.StartsWith("P")) icao = "K" + icao;

            var initialBounds = ParseBoundsFromQuery(ctx);
            using var ws = await ctx.WebSockets.AcceptWebSocketAsync();
            var dir = Path.Combine(_replayBaseDir, "asdex", icao);
            double.TryParse(ctx.Request.Query["preload"].FirstOrDefault(), out var preloadSeconds);
            await RunReplaySession(ws, dir, startTime, speed, initialBounds, preloadSeconds);
        });
    }

    private async Task RunReplaySession(WebSocket ws, string dataDir, DateTime startTime, double initialSpeed, Bounds? initialBounds = null, double preloadSeconds = 0)
    {
        var speed = initialSpeed;
        var paused = false;
        // Preload: for the first `preloadSeconds` of replay time, run at effectively infinite speed
        // so the client is fully populated up front, then settle into paced playback at `speed`.
        long preloadUntilMs = preloadSeconds > 0
            ? new DateTimeOffset(startTime.AddSeconds(preloadSeconds), TimeSpan.Zero).ToUnixTimeMilliseconds() : 0;
        double SpeedAt(long ms) => (preloadUntilMs > 0 && ms <= preloadUntilMs) ? 1_000_000.0 : speed;
        var seekTarget = (DateTime?)null;
        var cts = new CancellationTokenSource();

        // Viewport filtering state (null bounds → no filtering, original behavior).
        var vp = new Viewport { Bounds = initialBounds };
        var state = new Dictionary<string, StateRec>();

        // Start a receive loop to handle client commands
        var receiveTask = Task.Run(async () =>
        {
            var buf = new byte[1024];
            try
            {
                while (ws.State == WebSocketState.Open && !cts.Token.IsCancellationRequested)
                {
                    var result = await ws.ReceiveAsync(buf, cts.Token);
                    if (result.MessageType == WebSocketMessageType.Close) { cts.Cancel(); break; }
                    if (result.MessageType != WebSocketMessageType.Text) continue;

                    var json = Encoding.UTF8.GetString(buf, 0, result.Count);
                    try
                    {
                        using var doc = JsonDocument.Parse(json);
                        var cmd = doc.RootElement.GetProperty("cmd").GetString();
                        switch (cmd)
                        {
                            case "speed":
                                speed = doc.RootElement.GetProperty("value").GetDouble();
                                break;
                            case "pause":
                                paused = true;
                                break;
                            case "resume":
                                paused = false;
                                break;
                            case "seek":
                                var timeStr = doc.RootElement.GetProperty("time").GetString();
                                if (DateTime.TryParse(timeStr, null, System.Globalization.DateTimeStyles.AdjustToUniversal, out var t))
                                    seekTarget = t;
                                break;
                            case "viewport":
                                var r = doc.RootElement;
                                if (r.TryGetProperty("minLat", out var mnLat) && r.TryGetProperty("minLon", out var mnLon) &&
                                    r.TryGetProperty("maxLat", out var mxLat) && r.TryGetProperty("maxLon", out var mxLon))
                                {
                                    vp.Bounds = new Bounds(mnLat.GetDouble(), mnLon.GetDouble(), mxLat.GetDouble(), mxLon.GetDouble());
                                    vp.Changed = true;   // playback loop will re-snapshot the new region
                                }
                                break;
                        }
                    }
                    catch { }
                }
            }
            catch (OperationCanceledException) { }
            catch (WebSocketException) { }
        });

        try
        {
            // Send replay_start message with available range
            var range = GetTimeRange(dataDir);
            await SendJson(ws, new { type = "replay_start", range, speed, startTime = startTime.ToString("o") }, cts.Token);

            // Main playback loop
            await PlaybackLoop(ws, dataDir, startTime, SpeedAt, () => paused, () =>
            {
                var t = seekTarget;
                seekTarget = null;
                return t;
            }, state, vp, cts.Token);

            // End of data
            if (ws.State == WebSocketState.Open)
                await SendJson(ws, new { type = "replay_end" }, cts.Token);
        }
        catch (OperationCanceledException) { }
        catch (WebSocketException) { }
        finally
        {
            cts.Cancel();
            try { await receiveTask; } catch { }
            if (ws.State == WebSocketState.Open)
                await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "Replay ended", CancellationToken.None);
        }
    }

    private async Task PlaybackLoop(WebSocket ws, string dataDir, DateTime startTime,
        Func<long, double> speedAt, Func<bool> isPaused, Func<DateTime?> consumeSeek,
        Dictionary<string, StateRec> state, Viewport vp, CancellationToken ct)
    {
        if (!Directory.Exists(dataDir))
        {
            await SendJson(ws, new { type = "replay_error", message = "No replay data available" }, ct);
            return;
        }

        // Find the starting file and position
        var currentTime = startTime;

        while (!ct.IsCancellationRequested && ws.State == WebSocketState.Open)
        {
            // Check for seek
            var seekTo = consumeSeek();
            if (seekTo.HasValue)
            {
                currentTime = seekTo.Value;
                state.Clear();  // running model is rebuilt from the new position's snapshot
                // Send a clear signal so client resets state
                await SendJson(ws, new { type = "replay_seek", time = currentTime.ToString("o") }, ct);
            }

            // Find files for the current hour
            var hourFiles = GetFilesForTime(dataDir, currentTime);
            if (hourFiles.Count == 0)
            {
                // Try next hour
                var nextHour = new DateTime(currentTime.Year, currentTime.Month, currentTime.Day,
                    currentTime.Hour, 0, 0, DateTimeKind.Utc).AddHours(1);
                var nextFiles = GetFilesForTime(dataDir, nextHour);
                if (nextFiles.Count == 0)
                {
                    // No more data
                    break;
                }
                // Gap — skip forward
                await SendJson(ws, new { type = "replay_gap", from = currentTime.ToString("o"), to = nextHour.ToString("o") }, ct);
                currentTime = nextHour;
                continue;
            }

            // Read and play back all files for this hour
            foreach (var hourFile in hourFiles)
            {
                currentTime = await PlayFile(ws, hourFile, currentTime, speedAt, isPaused, consumeSeek, state, vp, ct);
                if (ct.IsCancellationRequested) break;
                if (consumeSeek() != null) break;
            }
            if (ct.IsCancellationRequested) break;

            // If a seek happened during playback, loop back to handle it
            if (consumeSeek() != null) continue;

            // Move to next hour
            currentTime = new DateTime(currentTime.Year, currentTime.Month, currentTime.Day,
                currentTime.Hour, 0, 0, DateTimeKind.Utc).AddHours(1);
        }
    }

    private async Task<DateTime> PlayFile(WebSocket ws, string filePath, DateTime startFrom,
        Func<long, double> speedAt, Func<bool> isPaused, Func<DateTime?> consumeSeek,
        Dictionary<string, StateRec> state, Viewport vp, CancellationToken ct)
    {
        var lastSentTime = DateTimeOffset.MinValue;
        var foundSnapshot = false;
        var records = new List<(long millis, string kind, string rawJson)>();

        // Read entire file into memory (hourly files are ~50 MB compressed, decompresses to ~500MB max
        // but we stream line by line, not all at once)
        using var fs = new FileStream(filePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        using var gz = new GZipStream(fs, CompressionMode.Decompress);
        using var sr = new StreamReader(gz);

        var startMillis = new DateTimeOffset(startFrom).ToUnixTimeMilliseconds();

        // Phase 1: Find nearest snapshot before startFrom, fast-forward
        string? lastSnapshotLine = null;
        long lastSnapshotMillis = 0;
        var postSnapshotLines = new List<(long millis, string line)>();

        string? line;
        while ((line = await sr.ReadLineAsync(ct)) != null)
        {
            if (ct.IsCancellationRequested) return startFrom;
            if (string.IsNullOrWhiteSpace(line)) continue;

            var (millis, kind) = ParseRecordHeader(line);
            if (millis == 0) continue;

            if (millis <= startMillis)
            {
                if (kind == "S")
                {
                    lastSnapshotLine = line;
                    lastSnapshotMillis = millis;
                    postSnapshotLines.Clear();
                    foundSnapshot = true;
                }
                else if (foundSnapshot)
                {
                    postSnapshotLines.Add((millis, line));
                }
            }
            else
            {
                // We've passed the start time — send just the snapshot (full state),
                // skip intermediate batches to avoid flooding the client
                if (foundSnapshot && lastSnapshotLine != null)
                {
                    await SendReplayRecord(ws, lastSnapshotLine, state, vp, ct);
                }

                // Now play this record and continue in real-time
                await SendReplayRecord(ws, line, state, vp, ct);
                lastSentTime = DateTimeOffset.FromUnixTimeMilliseconds(millis);
                break;
            }
        }

        // All records in this file were before startTime, but we have a snapshot → send it as catchup.
        // The outer loop will then move to the next hour file.
        if (lastSentTime == DateTimeOffset.MinValue && foundSnapshot)
        {
            await SendReplayRecord(ws, lastSnapshotLine!, state, vp, ct);
            lastSentTime = DateTimeOffset.FromUnixTimeMilliseconds(lastSnapshotMillis);
            return lastSentTime.UtcDateTime;
        }

        // No snapshot AND no records after startTime → nothing to play in this file.
        // Return startFrom so the outer loop advances to the next hour.
        if (lastSentTime == DateTimeOffset.MinValue)
        {
            return startFrom;
        }

        // Phase 2: Real-time paced playback of remaining lines (after the first record we already sent)
        var endTime = await PlayRemainingLines(ws, sr, lastSentTime, speedAt, isPaused, consumeSeek, state, vp, ct);
        return DateTimeOffset.FromUnixTimeMilliseconds(endTime).UtcDateTime;
    }

    private async Task<long> PlayRemainingLines(WebSocket ws, StreamReader sr, DateTimeOffset lastSentTime,
        Func<long, double> speedAt, Func<bool> isPaused, Func<DateTime?> consumeSeek,
        Dictionary<string, StateRec> state, Viewport vp, CancellationToken ct)
    {
        long lastMillis = lastSentTime.ToUnixTimeMilliseconds();
        // Accumulate the scaled inter-record wait and only actually sleep in ~16ms chunks.
        // Flooring each record to 16ms (as before) capped the effective rate at ~60×; accumulating
        // lets high speeds (120/300×) burn through dense data while never awaiting faster than 60fps.
        double accWaitMs = 0;

        string? line;
        while ((line = await sr.ReadLineAsync(ct)) != null)
        {
            if (ct.IsCancellationRequested || ws.State != WebSocketState.Open) break;

            // Check for seek (breaks out to main loop)
            if (consumeSeek() != null) break;

            // Viewport changed (client panned/zoomed) → re-snapshot the now-visible
            // region from the running state model so no tracks are missing.
            if (vp.Changed)
            {
                vp.Changed = false;
                await SendViewportSnapshot(ws, state, vp.Bounds, lastMillis, ct);
            }

            // Handle pause — still honor viewport changes so panning while paused repaints.
            while (isPaused() && !ct.IsCancellationRequested && ws.State == WebSocketState.Open)
            {
                if (vp.Changed)
                {
                    vp.Changed = false;
                    await SendViewportSnapshot(ws, state, vp.Bounds, lastMillis, ct);
                }
                await Task.Delay(100, ct);
                if (consumeSeek() != null) return lastMillis;
            }

            if (string.IsNullOrWhiteSpace(line)) continue;
            var (millis, kind) = ParseRecordHeader(line);
            if (millis == 0) continue;

            // Pacing: wait the appropriate scaled time
            if (lastMillis > 0 && millis > lastMillis)
            {
                var deltaMs = millis - lastMillis;
                var spd = speedAt(millis);   // huge during a preload window → bursts with no wait
                if (spd > 0 && deltaMs > 0)
                {
                    var scaled = deltaMs / spd;
                    if (scaled > 5000) accWaitMs = 0;      // large real gap → skip, don't sit idle
                    else accWaitMs += scaled;
                    if (accWaitMs >= 16)
                    {
                        var waitMs = (int)Math.Min(accWaitMs, 5000);
                        accWaitMs -= waitMs;                // carry the sub-frame remainder
                        await Task.Delay(waitMs, ct);
                    }
                }
            }

            await SendReplayRecord(ws, line, state, vp, ct);
            lastMillis = millis;
        }

        return lastMillis;
    }

    private static string KindToType(string? kind) => kind switch
    {
        "S" => "snapshot",
        "B" => "batch",
        "R" => "remove",
        "H" => "holdbar",
        _ => "unknown"
    };

    private static string? GetGufi(JsonElement item)
        => item.TryGetProperty("gufi", out var g) && g.ValueKind == JsonValueKind.String ? g.GetString() : null;

    private static (double? lat, double? lon) GetLatLon(JsonElement item)
    {
        double? lat = null, lon = null;
        if (item.TryGetProperty("latitude", out var la) && la.ValueKind == JsonValueKind.Number) lat = la.GetDouble();
        if (item.TryGetProperty("longitude", out var lo) && lo.ValueKind == JsonValueKind.Number) lon = lo.GetDouble();
        return (lat, lon);
    }

    private async Task SendMsg(WebSocket ws, string type, object data, long millis, CancellationToken ct)
    {
        if (ws.State != WebSocketState.Open) return;
        var time = DateTimeOffset.FromUnixTimeMilliseconds(millis).ToString("o");
        var bytes = JsonSerializer.SerializeToUtf8Bytes(new { type, data, replayTime = time }, _jsonOpts);
        await ws.SendAsync(bytes, WebSocketMessageType.Text, true, ct);
    }

    /// <summary>Re-emit a recorded snapshot of just the visible region from the running
    /// state model — sent when the client's viewport changes so panning never reveals
    /// blank areas (the tracks were filtered out of the stream but are still in state).</summary>
    private async Task SendViewportSnapshot(WebSocket ws, Dictionary<string, StateRec> state, Bounds? bounds, long millis, CancellationToken ct)
    {
        if (ws.State != WebSocketState.Open) return;
        var list = new List<JsonElement>();
        foreach (var rec in state.Values)
        {
            if (rec.Lat == null || rec.Lon == null) continue;
            if (bounds == null || bounds.Contains(rec.Lat.Value, rec.Lon.Value))
                list.Add(rec.El);
        }
        await SendMsg(ws, "snapshot", list, millis, ct);
    }

    private async Task SendReplayRecord(WebSocket ws, string jsonLine, Dictionary<string, StateRec> state, Viewport vp, CancellationToken ct)
    {
        if (ws.State != WebSocketState.Open) return;

        // Parse the record and re-emit as the standard WS message format
        try
        {
            using var doc = JsonDocument.Parse(jsonLine);
            var root = doc.RootElement;
            var kind = root.GetProperty("k").GetString();
            var millis = root.GetProperty("t").GetInt64();
            var data = root.GetProperty("d");

            var bounds = vp.Bounds;

            // No viewport supplied → original passthrough, no state maintenance.
            if (bounds == null)
            {
                await SendMsg(ws, KindToType(kind), data, millis, ct);
                return;
            }

            switch (kind)
            {
                case "S":   // snapshot: rebuild state, send only in-view tracks
                case "B":   // batch: upsert state, send only in-view changes
                {
                    if (kind == "S") state.Clear();
                    var outList = new List<JsonElement>();
                    foreach (var item in data.EnumerateArray())
                    {
                        var (lat, lon) = GetLatLon(item);
                        var clone = item.Clone();   // detach so it survives the document
                        var gufi = GetGufi(item);
                        if (gufi != null) state[gufi] = new StateRec { Lat = lat, Lon = lon, El = clone };
                        if (lat != null && lon != null && bounds.Contains(lat.Value, lon.Value))
                            outList.Add(clone);
                    }
                    await SendMsg(ws, kind == "S" ? "snapshot" : "batch", outList, millis, ct);
                    break;
                }
                case "R":   // remove: drop from state, always forward (no-op if absent client-side)
                {
                    if (data.ValueKind == JsonValueKind.Object &&
                        data.TryGetProperty("gufi", out var gEl) && gEl.ValueKind == JsonValueKind.String)
                    {
                        var gufi = gEl.GetString();
                        if (gufi != null) state.Remove(gufi);
                    }
                    await SendMsg(ws, "remove", data, millis, ct);
                    break;
                }
                default:    // holdbar / unknown — pass through
                    await SendMsg(ws, KindToType(kind), data, millis, ct);
                    break;
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[REPLAY] Send error: {ex.Message}");
        }
    }

    private async Task SendJson(WebSocket ws, object msg, CancellationToken ct)
    {
        if (ws.State != WebSocketState.Open) return;
        var bytes = JsonSerializer.SerializeToUtf8Bytes(msg, _jsonOpts);
        await ws.SendAsync(bytes, WebSocketMessageType.Text, true, ct);
    }

    private static (long millis, string kind) ParseRecordHeader(string line)
    {
        // Parse {"t":123456,"k":"B",...} using Utf8JsonReader — tolerates whitespace
        // and property ordering changes, and skips malformed lines without throwing.
        try
        {
            var reader = new Utf8JsonReader(System.Text.Encoding.UTF8.GetBytes(line));
            long millis = 0;
            string kind = "";
            while (reader.Read())
            {
                if (reader.TokenType != JsonTokenType.PropertyName) continue;
                var prop = reader.GetString();
                reader.Read();
                if (prop == "t" && reader.TokenType == JsonTokenType.Number)
                    millis = reader.GetInt64();
                else if (prop == "k" && reader.TokenType == JsonTokenType.String)
                    kind = reader.GetString() ?? "";
                if (millis != 0 && kind.Length > 0) break;
                // Skip nested structures to avoid wasted work
                if (reader.TokenType == JsonTokenType.StartObject || reader.TokenType == JsonTokenType.StartArray)
                    reader.Skip();
            }
            return (millis, kind);
        }
        catch
        {
            return (0, "");
        }
    }

    /// <summary>Get all replay files for a given hour (base + restart suffixes), in order.</summary>
    private static List<string> GetFilesForTime(string dir, DateTime utcTime)
    {
        if (!Directory.Exists(dir)) return new();
        var baseName = utcTime.ToString("yyyy-MM-dd'T'HH");
        var files = new List<string>();

        var primary = Path.Combine(dir, baseName + ".jsonl.gz");
        if (File.Exists(primary)) files.Add(primary);

        // Check for restart suffixes (-1, -2, etc.)
        for (int i = 1; i <= 10; i++)
        {
            var alt = Path.Combine(dir, $"{baseName}-{i}.jsonl.gz");
            if (File.Exists(alt)) files.Add(alt);
            else break;
        }

        return files;
    }

    private static string? GetFileForTime(string dir, DateTime utcTime)
    {
        var files = GetFilesForTime(dir, utcTime);
        return files.Count > 0 ? files[0] : null;
    }

    private static object? GetTimeRange(string dir)
    {
        if (!Directory.Exists(dir)) return null;
        var files = Directory.GetFiles(dir, "*.jsonl.gz")
            .Select(f => Path.GetFileName(f).Replace(".jsonl.gz", ""))
            .Where(f => DateTime.TryParseExact(f, "yyyy-MM-dd'T'HH",
                System.Globalization.CultureInfo.InvariantCulture,
                System.Globalization.DateTimeStyles.AssumeUniversal | System.Globalization.DateTimeStyles.AdjustToUniversal,
                out _))
            .OrderBy(f => f)
            .ToList();

        if (files.Count == 0) return null;

        DateTime.TryParseExact(files[0], "yyyy-MM-dd'T'HH",
            System.Globalization.CultureInfo.InvariantCulture,
            System.Globalization.DateTimeStyles.AssumeUniversal | System.Globalization.DateTimeStyles.AdjustToUniversal,
            out var start);
        DateTime.TryParseExact(files[^1], "yyyy-MM-dd'T'HH",
            System.Globalization.CultureInfo.InvariantCulture,
            System.Globalization.DateTimeStyles.AssumeUniversal | System.Globalization.DateTimeStyles.AdjustToUniversal,
            out var end);

        return new
        {
            start = start.ToString("o"),
            end = end.AddHours(1).ToString("o"),
            hours = files.Count,
            totalSizeMB = Directory.GetFiles(dir, "*.jsonl.gz").Sum(f => new FileInfo(f).Length) / (1024.0 * 1024.0)
        };
    }
}
