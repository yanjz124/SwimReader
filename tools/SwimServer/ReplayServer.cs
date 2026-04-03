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

            using var ws = await ctx.WebSockets.AcceptWebSocketAsync();
            var dir = Path.Combine(_replayBaseDir, "eram");
            await RunReplaySession(ws, dir, startTime, speed);
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

            using var ws = await ctx.WebSockets.AcceptWebSocketAsync();
            var dir = Path.Combine(_replayBaseDir, "asdex", icao);
            await RunReplaySession(ws, dir, startTime, speed);
        });
    }

    private async Task RunReplaySession(WebSocket ws, string dataDir, DateTime startTime, double initialSpeed)
    {
        var speed = initialSpeed;
        var paused = false;
        var seekTarget = (DateTime?)null;
        var cts = new CancellationTokenSource();

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
            await PlaybackLoop(ws, dataDir, startTime, () => speed, () => paused, () =>
            {
                var t = seekTarget;
                seekTarget = null;
                return t;
            }, cts.Token);

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
        Func<double> getSpeed, Func<bool> isPaused, Func<DateTime?> consumeSeek, CancellationToken ct)
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
                currentTime = await PlayFile(ws, hourFile, currentTime, getSpeed, isPaused, consumeSeek, ct);
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
        Func<double> getSpeed, Func<bool> isPaused, Func<DateTime?> consumeSeek, CancellationToken ct)
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
                    await SendReplayRecord(ws, lastSnapshotLine, ct);
                }

                // Now play this record and continue in real-time
                await SendReplayRecord(ws, line, ct);
                lastSentTime = DateTimeOffset.FromUnixTimeMilliseconds(millis);
                break;
            }
        }

        // If we never found a record after startTime but have a snapshot, send it
        if (!foundSnapshot && lastSnapshotLine == null)
        {
            // No snapshot found — start from beginning of file
            fs.Seek(0, SeekOrigin.Begin);
            using var gz2 = new GZipStream(fs, CompressionMode.Decompress);
            using var sr2 = new StreamReader(gz2);
            // Re-read and play from start
            line = await sr2.ReadLineAsync(ct);
            if (line != null)
            {
                var (m, k) = ParseRecordHeader(line);
                await SendReplayRecord(ws, line, ct);
                lastSentTime = DateTimeOffset.FromUnixTimeMilliseconds(m);
            }
            // Continue reading from sr2 for the rest
            await PlayRemainingLines(ws, sr2, lastSentTime, getSpeed, isPaused, consumeSeek, ct);
            return DateTimeOffset.UtcNow.UtcDateTime; // approximate
        }
        else if (lastSentTime == DateTimeOffset.MinValue && foundSnapshot)
        {
            // All records were before startTime — send just the snapshot (full state)
            await SendReplayRecord(ws, lastSnapshotLine!, ct);
            lastSentTime = DateTimeOffset.FromUnixTimeMilliseconds(lastSnapshotMillis);
        }

        // Phase 2: Real-time paced playback of remaining lines
        var endTime = await PlayRemainingLines(ws, sr, lastSentTime, getSpeed, isPaused, consumeSeek, ct);
        return DateTimeOffset.FromUnixTimeMilliseconds(endTime).UtcDateTime;
    }

    private async Task<long> PlayRemainingLines(WebSocket ws, StreamReader sr, DateTimeOffset lastSentTime,
        Func<double> getSpeed, Func<bool> isPaused, Func<DateTime?> consumeSeek, CancellationToken ct)
    {
        long lastMillis = lastSentTime.ToUnixTimeMilliseconds();

        string? line;
        while ((line = await sr.ReadLineAsync(ct)) != null)
        {
            if (ct.IsCancellationRequested || ws.State != WebSocketState.Open) break;

            // Check for seek (breaks out to main loop)
            if (consumeSeek() != null) break;

            // Handle pause
            while (isPaused() && !ct.IsCancellationRequested && ws.State == WebSocketState.Open)
            {
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
                var spd = getSpeed();
                if (spd > 0 && deltaMs > 0)
                {
                    var waitMs = (int)(deltaMs / spd);
                    // Cap max wait to 5 seconds (skip gaps)
                    if (waitMs > 5000) waitMs = 100;
                    // Floor: never send faster than ~60 fps (16ms) — client merges by gufi per frame
                    if (waitMs < 16) waitMs = 16;
                    if (waitMs > 10)
                        await Task.Delay(waitMs, ct);
                }
            }

            await SendReplayRecord(ws, line, ct);
            lastMillis = millis;
        }

        return lastMillis;
    }

    private async Task SendReplayRecord(WebSocket ws, string jsonLine, CancellationToken ct)
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

            string type = kind switch
            {
                "S" => "snapshot",
                "B" => "batch",
                "R" => "remove",
                "H" => "holdbar",
                _ => "unknown"
            };

            // Build the output message with replay timestamp
            var time = DateTimeOffset.FromUnixTimeMilliseconds(millis).ToString("o");
            var msg = JsonSerializer.Serialize(new { type, data, replayTime = time }, _jsonOpts);
            var bytes = Encoding.UTF8.GetBytes(msg);
            await ws.SendAsync(bytes, WebSocketMessageType.Text, true, ct);
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
        // Quick parse of {"t":123456,"k":"B",...} without full deserialization
        try
        {
            var tIdx = line.IndexOf("\"t\":", StringComparison.Ordinal);
            var kIdx = line.IndexOf("\"k\":\"", StringComparison.Ordinal);
            if (tIdx < 0 || kIdx < 0) return (0, "");

            var tStart = tIdx + 4;
            var tEnd = line.IndexOf(',', tStart);
            if (tEnd < 0) tEnd = line.IndexOf('}', tStart);
            var millis = long.Parse(line.AsSpan(tStart, tEnd - tStart));

            var kStart = kIdx + 5;
            var kind = line.Substring(kStart, 1);

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
