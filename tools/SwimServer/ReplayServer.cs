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
    /// <summary>Inter-record gap above which playback skips ahead instead of waiting it out.
    /// Sized to separate a recording outage from a genuinely quiet facility: a small TRACON's
    /// normal reporting gaps run to tens of seconds (GTF: 41 gaps of 15-60 s in one hour, all
    /// real), while a restart or feed drop leaves minutes of nothing. Compared against real
    /// recording time, not scaled wait, so it is speed-independent.</summary>
    private const long GapSkipMs = 60_000;

    /// <summary>How far the readable tail of the newest hour file trails real time.
    /// ReplayRecorder flushes writer→gzip every 30 s, so anything newer than this is written but
    /// not yet readable.</summary>
    private const long RecorderFlushLagMs = 30_000;

    private readonly string _replayBaseDir;
    private readonly JsonSerializerOptions _jsonOpts;
    private int _sessions;

    /// <summary>Replay sessions playing right now, across every replay socket — live and incident,
    /// ERAM, ASDE-X and TAIS (the home page's server card sums these with the other feeds).</summary>
    public int ClientCount => Volatile.Read(ref _sessions);

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

    /// <summary>Facility ids we hold recorded TAIS data for. Steadier than the live list, which
    /// only contains facilities with traffic right now — a quiet TRACON drops out of that.</summary>
    public IReadOnlyCollection<string> RecordedTaisFacilities()
    {
        var dir = Path.Combine(_replayBaseDir, "tais");
        if (!Directory.Exists(dir)) return Array.Empty<string>();
        try { return Directory.GetDirectories(dir).Select(Path.GetFileName).OfType<string>().ToArray(); }
        catch { return Array.Empty<string>(); }
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

            // TAIS (STARS terminal), recorded per facility exactly like ASDE-X is per airport.
            var taisRanges = RangesUnder(Path.Combine(_replayBaseDir, "tais"));

            return Results.Json(new { eram = eramRange, asdex = asdexRanges, tais = taisRanges }, _jsonOpts);
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
            using var ws = await SwimWs.AcceptAsync(ctx);
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
            using var ws = await SwimWs.AcceptAsync(ctx);
            var dir = Path.Combine(_replayBaseDir, "asdex", icao);
            double.TryParse(ctx.Request.Query["preload"].FirstOrDefault(), out var preloadSeconds);
            await RunReplaySession(ws, dir, startTime, speed, initialBounds, preloadSeconds);
        });

        // STARS terminal (TAIS) replay WebSocket — the continuously recorded counterpart of the
        // per-incident stream, so a facility can be scrubbed back without archiving an incident first.
        app.Map("/replay/tais/ws/{facility}", async (HttpContext ctx, string facility) =>
        {
            if (facility.Contains("..") || facility.Contains('/') || facility.Contains('\\')) { ctx.Response.StatusCode = 400; return; }
            await DirSession(ctx, Path.Combine(_replayBaseDir, "tais", facility.ToUpperInvariant()));
        });
    }

    /// <summary>
    /// Replay endpoints for archived incidents — same engine as live replay, pointed at the incident's
    /// own sliced ERAM / per-airport ASDE-X gz files. incidentsDir is the permanent archive root.
    /// </summary>
    public void MapIncidentEndpoints(WebApplication app, string incidentsDir)
    {
        static bool SafeId(string id) => !(id.Contains("..") || id.Contains('/') || id.Contains('\\'));

        app.MapGet("/api/incident/{id}/range", (string id) =>
        {
            if (!SafeId(id)) return Results.BadRequest();
            var baseD = Path.Combine(incidentsDir, id);
            // Clamp every reported range to the incident's own window. Raw file ranges are
            // hour-aligned (a 15:37-16:37 incident lives in the 15:00 and 16:00 files), so reporting
            // them unclamped makes the replay scrubber span dead space on both ends — dragging into
            // it seeks past the archived data, the session ends, and the bar looks "Disconnected".
            var (winLo, winHi) = ReadIncidentWindow(Path.Combine(baseD, "meta.json"));
            var eram = GetTimeRange(Path.Combine(baseD, "eram"), winLo, winHi);
            var asdex = RangesUnder(Path.Combine(baseD, "asdex"), winLo, winHi);
            var tais = RangesUnder(Path.Combine(baseD, "tais"), winLo, winHi);
            return Results.Json(new { eram, asdex, tais }, _jsonOpts);
        });

        app.Map("/replay/incident/{id}/ws", async (HttpContext ctx, string id) =>
        {
            if (!SafeId(id)) { ctx.Response.StatusCode = 400; return; }
            await DirSession(ctx, Path.Combine(incidentsDir, id, "eram"));
        });

        app.Map("/replay/incident/{id}/asdex/ws/{airport}", async (HttpContext ctx, string id, string airport) =>
        {
            if (!SafeId(id)) { ctx.Response.StatusCode = 400; return; }
            var icao = airport.ToUpperInvariant();
            if (!icao.StartsWith("K") && !icao.StartsWith("P")) icao = "K" + icao;
            await DirSession(ctx, Path.Combine(incidentsDir, id, "asdex", icao));
        });

        app.Map("/replay/incident/{id}/tais/ws/{facility}", async (HttpContext ctx, string id, string facility) =>
        {
            if (!SafeId(id) || !SafeId(facility)) { ctx.Response.StatusCode = 400; return; }
            await DirSession(ctx, Path.Combine(incidentsDir, id, "tais", facility.ToUpperInvariant()));
        });
    }

    /// <summary>Time-range map for every subdirectory under <paramref name="baseDir"/> (name → range).</summary>
    private Dictionary<string, object> RangesUnder(string baseDir, DateTime? clampLo = null, DateTime? clampHi = null)
    {
        var map = new Dictionary<string, object>();
        if (Directory.Exists(baseDir))
            foreach (var d in Directory.GetDirectories(baseDir))
            {
                var r = GetTimeRange(d, clampLo, clampHi);
                if (r != null) map[Path.GetFileName(d)] = r;
            }
        return map;
    }

    /// <summary>
    /// Opens a replay session over one recording directory: start time, speed, viewport and preload all
    /// come off the query string. Shared by the incident streams and the continuously-recorded ones.
    /// </summary>
    private async Task DirSession(HttpContext ctx, string dir)
    {
        if (!ctx.WebSockets.IsWebSocketRequest) { ctx.Response.StatusCode = 400; return; }
        var startParam = ctx.Request.Query["start"].FirstOrDefault();
        if (string.IsNullOrEmpty(startParam)
            || !DateTime.TryParse(startParam, null, System.Globalization.DateTimeStyles.AdjustToUniversal, out var startTime))
        { ctx.Response.StatusCode = 400; return; }
        if (!Directory.Exists(dir)) { ctx.Response.StatusCode = 404; return; }
        var speed = 1.0;
        if (double.TryParse(ctx.Request.Query["speed"].FirstOrDefault(), out var sp) && sp > 0) speed = sp;
        var bounds = ParseBoundsFromQuery(ctx);
        double.TryParse(ctx.Request.Query["preload"].FirstOrDefault(), out var preload);
        using var ws = await SwimWs.AcceptAsync(ctx);
        await RunReplaySession(ws, dir, startTime, speed, bounds, preload);
    }

    private async Task RunReplaySession(WebSocket ws, string dataDir, DateTime startTime, double initialSpeed, Bounds? initialBounds = null, double preloadSeconds = 0)
    {
        Interlocked.Increment(ref _sessions);
        try { await RunReplaySessionCore(ws, dataDir, startTime, initialSpeed, initialBounds, preloadSeconds); }
        finally { Interlocked.Decrement(ref _sessions); }
    }

    private async Task RunReplaySessionCore(WebSocket ws, string dataDir, DateTime startTime, double initialSpeed, Bounds? initialBounds = null, double preloadSeconds = 0)
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
            // peek is deliberately NON-destructive: several nested loops test "is a seek
            // pending?" to unwind, and only PlaybackLoop acts on the value. See clearSeek below.
            await PlaybackLoop(ws, dataDir, startTime, SpeedAt, () => paused,
                () => seekTarget, () => seekTarget = null, state, vp, cts.Token);

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
        Func<long, double> speedAt, Func<bool> isPaused, Func<DateTime?> peekSeek, Action clearSeek,
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
            // Check for seek. This is the ONLY place the pending seek is cleared — the nested
            // loops below only peek, so the target survives the unwind back up to here.
            var seekTo = peekSeek();
            if (seekTo.HasValue)
            {
                clearSeek();
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
                currentTime = await PlayFile(ws, hourFile, currentTime, speedAt, isPaused, peekSeek, clearSeek, state, vp, ct);
                if (ct.IsCancellationRequested) break;
                if (peekSeek() != null) break;
            }
            if (ct.IsCancellationRequested) break;

            // If a seek happened during playback, loop back to handle it
            if (peekSeek() != null) continue;

            // Move to next hour
            currentTime = new DateTime(currentTime.Year, currentTime.Month, currentTime.Day,
                currentTime.Hour, 0, 0, DateTimeKind.Utc).AddHours(1);
        }
    }

    private async Task<DateTime> PlayFile(WebSocket ws, string filePath, DateTime startFrom,
        Func<long, double> speedAt, Func<bool> isPaused, Func<DateTime?> peekSeek, Action clearSeek,
        Dictionary<string, StateRec> state, Viewport vp, CancellationToken ct)
    {
        var lastSentTime = DateTimeOffset.MinValue;
        var foundSnapshot = false;
        var records = new List<(long millis, string kind, string rawJson)>();

        // Read entire file into memory (hourly files are ~50 MB compressed, decompresses to ~500MB max
        // but we stream line by line, not all at once)
        using var gz = ReplayFiles.OpenRead(filePath);   // .gz (live/recent hour) or .zst (compacted)
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
        var endTime = await PlayRemainingLines(ws, sr, lastSentTime, speedAt, isPaused, peekSeek, clearSeek, state, vp, ct);
        return DateTimeOffset.FromUnixTimeMilliseconds(endTime).UtcDateTime;
    }

    private async Task<long> PlayRemainingLines(WebSocket ws, StreamReader sr, DateTimeOffset lastSentTime,
        Func<long, double> speedAt, Func<bool> isPaused, Func<DateTime?> peekSeek, Action clearSeek,
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

            // Check for seek (breaks out to main loop, which consumes it)
            if (peekSeek() != null) break;

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
                if (peekSeek() != null) return lastMillis;
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
                    // A gap longer than GapSkipMs is a recording outage, not quiet traffic, so
                    // it is skipped and the client is told — the clock jump then shows as a gap
                    // instead of looking like a stall. The arithmetic is in PacingWaitMs.
                    if (deltaMs > GapSkipMs)
                    {
                        await SendJson(ws, new
                        {
                            type = "replay_gap",
                            from = DateTimeOffset.FromUnixTimeMilliseconds(lastMillis).ToString("o"),
                            to = DateTimeOffset.FromUnixTimeMilliseconds(millis).ToString("o"),
                        }, ct);
                    }
                    accWaitMs += PacingWaitMs(deltaMs, spd, millis,
                        DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - RecorderFlushLagMs);
                    if (accWaitMs >= 16)
                    {
                        // Drain the WHOLE accumulated wait. It used to be capped at 5000 ms per
                        // record, which was harmless only because the clause above had already
                        // thrown away anything longer; with real quiet time now paced, a cap would
                        // let the accumulator grow without bound and the stream would fall further
                        // behind its own clock on every record. The <=100 ms slicing below is what
                        // keeps a long wait responsive, so the cap bought nothing.
                        var waitMs = (int)accWaitMs;
                        accWaitMs -= waitMs;                // carry the sub-frame remainder

                        // Sleep in <=100 ms slices rather than one long await. A quiet stretch of
                        // data legitimately produces a multi-second wait, and a single Task.Delay
                        // over it makes the session look hung: a seek sits unserved and a speed
                        // change doesn't bite until the old wait expires. Re-checking per slice is
                        // what makes the transport controls feel attached to anything.
                        var spdUsed = spd;
                        while (waitMs > 0 && !ct.IsCancellationRequested)
                        {
                            if (peekSeek() != null) break;      // unwind now; don't serve it late
                            var spdNow = speedAt(millis);
                            if (spdNow > 0 && spdNow != spdUsed)
                            {
                                // Speed changed mid-wait: rescale what's left of it. 2x faster
                                // halves the remaining wait instead of honoring the old pacing.
                                waitMs = (int)(waitMs * spdUsed / spdNow);
                                spdUsed = spdNow;
                                if (waitMs <= 0) break;
                            }
                            var slice = Math.Min(waitMs, 100);
                            await Task.Delay(slice, ct);
                            waitMs -= slice;
                        }
                    }
                }
            }

            await SendReplayRecord(ws, line, state, vp, ct);
            lastMillis = millis;
        }

        return lastMillis;
    }

    /// <summary>
    /// How much wall-clock wait one record earns: the core of replay pacing, pure so it can be
    /// tested over a timestamp sequence (see ReplayPacingTests).
    /// </summary>
    /// <param name="deltaMs">Real recorded time since the previous record.</param>
    /// <param name="speed">Playback multiplier (1 = real time).</param>
    /// <param name="recordMs">This record's recorded time, for the live-edge test.</param>
    /// <param name="liveEdgeMs">Newest recorded instant that is readable (now minus the
    /// recorder's flush lag). Far in the future for a historical replay.</param>
    /// <remarks>
    /// The rule this replaced tested <c>deltaMs / speed > 5000</c> — five seconds of *scaled
    /// wait* — and served anything above it with ZERO wait. That silently broke 1x playback for
    /// every quiet facility: a TRACON reporting every 10-30 s has nearly all of its inter-record
    /// gaps above that threshold, so the replay clock ran away. Measured over one recorded hour:
    /// GTF 5.5x on average and 32x through its quietest stretches, FAI 123x, against 1.1x for
    /// A80 and PCT — which is why it only ever surfaced as a *STARS* complaint, TAIS being the
    /// one feed recorded per small facility (140 of 143 recorded facilities are small TRACONs).
    ///
    /// The consequence was not merely a fast clock. Racing let replay overtake the recorder, and
    /// reaching the end of the newest hour file is treated as end-of-archive, so a quiet
    /// facility's session ended within a couple of minutes — after which every track went
    /// unrefreshed and the scope blanked LostTargetSeconds (30 s) later with nothing on screen to
    /// say why. Hence both halves below: compare against REAL recorded time so the threshold
    /// means the same at every speed, and never skip past the live edge.
    /// </remarks>
    internal static double PacingWaitMs(long deltaMs, double speed, long recordMs, long liveEdgeMs)
    {
        if (deltaMs <= 0 || speed <= 0) return 0;
        if (deltaMs <= GapSkipMs) return deltaMs / speed;
        // Skipped gap: free when it is history, but never advance past data that does not exist
        // yet. Waiting out the overshoot is waiting for the recorder, which is what a replay
        // caught up to live should do instead of running off the end and ending.
        return recordMs > liveEdgeMs ? recordMs - liveEdgeMs : 0;
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

        var primary = ReplayFiles.Find(dir, baseName);
        if (primary != null) files.Add(primary);

        // Check for restart suffixes (-1, -2, etc.)
        for (int i = 1; i <= 10; i++)
        {
            var alt = ReplayFiles.Find(dir, $"{baseName}-{i}");
            if (alt != null) files.Add(alt);
            else break;
        }

        return files;
    }

    private static string? GetFileForTime(string dir, DateTime utcTime)
    {
        var files = GetFilesForTime(dir, utcTime);
        return files.Count > 0 ? files[0] : null;
    }

    /// <summary>Read an incident's archived window from meta.json, for clamping reported ranges.</summary>
    private static (DateTime? lo, DateTime? hi) ReadIncidentWindow(string metaPath)
    {
        try
        {
            if (!File.Exists(metaPath)) return (null, null);
            using var doc = JsonDocument.Parse(File.ReadAllText(metaPath));
            var r = doc.RootElement;
            DateTime? lo = r.TryGetProperty("startUtc", out var a) && a.TryGetDateTime(out var la) ? la.ToUniversalTime() : null;
            DateTime? hi = r.TryGetProperty("endUtc", out var b) && b.TryGetDateTime(out var hb) ? hb.ToUniversalTime() : null;
            return (lo, hi);
        }
        catch { return (null, null); }
    }

    private static object? GetTimeRange(string dir, DateTime? clampLo = null, DateTime? clampHi = null)
    {
        if (!Directory.Exists(dir)) return null;
        var files = ReplayFiles.List(dir)
            .Select(ReplayFiles.Stem)
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

        var rangeStart = start;
        var rangeEnd = end.AddHours(1);
        if (clampLo is { } cl && cl > rangeStart) rangeStart = cl;
        if (clampHi is { } ch && ch < rangeEnd) rangeEnd = ch;
        // Never advertise time that has not been recorded yet. The last file is the hour in
        // progress, so `end.AddHours(1)` can sit up to an hour in the FUTURE — the scrubber then
        // let you drag into unwritten time, where the session immediately reports end-of-data and
        // closes. The readable tail also trails real time by the recorder's flush interval
        // (ReplayRecorder flushes every 30 s), so the honest right edge is a little behind now.
        var written = DateTime.UtcNow.AddSeconds(-30);
        if (written < rangeEnd) rangeEnd = written;
        if (rangeEnd <= rangeStart) { rangeStart = start; rangeEnd = end.AddHours(1); }   // degenerate → unclamped

        return new
        {
            start = rangeStart.ToString("o"),
            end = rangeEnd.ToString("o"),
            hours = files.Count,
            totalSizeMB = ReplayFiles.List(dir).Sum(f => new FileInfo(f).Length) / (1024.0 * 1024.0)
        };
    }
}
