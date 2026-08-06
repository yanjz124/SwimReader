using System.Net.WebSockets;

namespace SwimServer;

/// <summary>
/// ERAM-related endpoints: the main /ws WebSocket (flight snapshot/batch/remove),
/// /api/event-xml/{eventIndex}/{gufi} (lazy-loaded raw FIXM XML),
/// /api/flights/{gufi} (full flight detail), and /api/stats.
///
/// The /eram clean-URL page handler lives in StaticRoutes since it's a pure file send.
/// </summary>
static class EramRoutes
{
    public static void Register(WebApplication app, ServerContext ctx)
    {
        // WebSocket — streams flight updates to browser
        app.Map("/ws", async (HttpContext c) =>
        {
            if (!c.WebSockets.IsWebSocketRequest) { c.Response.StatusCode = 400; return; }

            using var ws = await c.WebSockets.AcceptWebSocketAsync();
            var clientId = Guid.NewGuid().ToString("N");
            var client = new WsClient(ws) { Reveal = LaddService.Reveal(c) };
            ctx.Clients[clientId] = client;

            // Background send pump — serializes all writes through a single task
            var sendTask = Task.Run(async () =>
            {
                try
                {
                    await foreach (var data in client.Queue.Reader.ReadAllAsync())
                    {
                        if (ws.State != WebSocketState.Open) break;
                        await ws.SendAsync(data, WebSocketMessageType.Text, true, CancellationToken.None);
                    }
                }
                catch (WebSocketException) { }
                catch (OperationCanceledException) { }
            });

            try
            {
                // Send initial snapshot of all flights
                ctx.SendSnapshot(client);

                var buf = new byte[4096];
                while (ws.State == WebSocketState.Open)
                {
                    var result = await ws.ReceiveAsync(buf, CancellationToken.None);
                    if (result.MessageType == WebSocketMessageType.Close) break;
                }
            }
            catch (WebSocketException) { }
            finally
            {
                ctx.Clients.TryRemove(clientId, out _);
                client.Queue.Writer.TryComplete();
                await sendTask;
            }
        });

        // ── Handoff display-code map (shared across all scopes) ─────────
        // GET returns the live JSON; PUT replaces it atomically. The eram.js
        // landing-page Codes Editor reads/writes through these endpoints, so
        // any user's edits become the single source of truth for every
        // scope. File on disk drives the static /handoff-codes.json fetch
        // that loadHandoffCodes() in eram.js calls on scope boot.
        var handoffCodesPath = Path.Combine(ctx.WebRootPath, "handoff-codes.json");
        var handoffWriteLock = new object();

        app.MapGet("/api/handoff-codes", () =>
        {
            try
            {
                var json = File.Exists(handoffCodesPath)
                    ? File.ReadAllText(handoffCodesPath)
                    : "{\"default\":{}}";
                return Results.Content(json, "application/json");
            }
            catch (Exception ex)
            {
                return Results.Problem($"failed to read handoff-codes.json: {ex.Message}");
            }
        });

        app.MapPut("/api/handoff-codes", async (HttpContext c) =>
        {
            // Accept the new mapping as a raw JSON body. Validate shape:
            //   { default: { FAC: "code" }, FAC1: { OTHERFAC: "code" }, ... }
            // Reject anything that isn't an object-of-objects-of-strings to
            // keep accidental garbage from breaking the scope on next load.
            using var reader = new StreamReader(c.Request.Body);
            var body = await reader.ReadToEndAsync();
            System.Text.Json.JsonDocument doc;
            try { doc = System.Text.Json.JsonDocument.Parse(body); }
            catch (System.Text.Json.JsonException ex) { return Results.BadRequest(new { error = "invalid JSON", message = ex.Message }); }

            if (doc.RootElement.ValueKind != System.Text.Json.JsonValueKind.Object)
                return Results.BadRequest(new { error = "root must be an object" });

            foreach (var section in doc.RootElement.EnumerateObject())
            {
                if (section.Name.StartsWith("_")) continue;   // tolerate _comment
                if (section.Value.ValueKind != System.Text.Json.JsonValueKind.Object)
                    return Results.BadRequest(new { error = $"section '{section.Name}' must be an object" });
                foreach (var entry in section.Value.EnumerateObject())
                {
                    if (entry.Value.ValueKind != System.Text.Json.JsonValueKind.String)
                        return Results.BadRequest(new { error = $"'{section.Name}.{entry.Name}' must be a string" });
                }
            }

            // Pretty-print with 2-space indent so the on-disk file stays
            // hand-editable / diff-friendly when someone bypasses the UI.
            var pretty = System.Text.Json.JsonSerializer.Serialize(doc.RootElement,
                new System.Text.Json.JsonSerializerOptions { WriteIndented = true });

            lock (handoffWriteLock)
            {
                File.WriteAllText(handoffCodesPath, pretty);
            }
            return Results.Json(new { ok = true, size = pretty.Length });
        });

        // REST API for event raw XML (must be before catch-all route)
        app.MapGet("/api/event-xml/{eventIndex}/{*gufi}", (int eventIndex, string gufi) =>
        {
            if (!ctx.Flights.TryGetValue(gufi, out var f)) return Results.NotFound();
            var evt = f.GetEvent(eventIndex);
            if (evt is null) return Results.NotFound();
            if (evt.RawXml is null) return Results.Json(new { xml = (string?)null }, ctx.JsonOpts);
            return Results.Json(new { xml = evt.RawXml }, ctx.JsonOpts);
        });

        // REST API for flight detail (full state + event log)
        app.MapGet("/api/flights/{*gufi}", (string gufi, HttpContext http) =>
        {
            if (!ctx.Flights.TryGetValue(gufi, out var f)) return Results.NotFound();
            return Results.Json(f.ToDetail(reveal: LaddService.Reveal(http)), ctx.JsonOpts);
        });

        // REST API for stats
        app.MapGet("/api/stats", () => Results.Json(ctx.Stats.Snapshot(ctx.Flights.Count), ctx.JsonOpts));

        // Per-facility/sector active-track breakdown + 1h sparkline history.
        //   Returns: [{ facility, totalTracks, sectorCount,
        //                sectors: [{ id, tracks, handoffsIn, handoffsOut,
        //                             history: [c,c,c,...] }] }, ...]
        // A flight contributes one track to its controllingFacility/sector.
        // Handoff legs add to handoffsIn (this facility receiving) or
        // handoffsOut (this facility transferring). Sectors with 0 current
        // tracks are STILL listed if they had a non-zero count anytime in
        // the last hour — so a sector that just closed remains visible.
        // Sectors are sorted by numeric ID ascending; non-numeric trailing
        // chars (e.g. "30R", "07A") break ties alphabetically.
        static (int num, string suffix) SectorSortKey(string id)
        {
            // Strip a leading run of digits for the numeric portion. Empty
            // numeric → -1 sorts before everything else.
            int i = 0;
            while (i < id.Length && char.IsDigit(id[i])) i++;
            if (i == 0) return (-1, id);
            int.TryParse(id.AsSpan(0, i), out var n);
            return (n, id.Length > i ? id[i..] : "");
        }
        app.MapGet("/api/sectors", (int? rangeMin) =>
        {
            // Inline sparkline window. Defaults to 1h; values are clamped to the
            // SectorTracker retention (24h). Server max-pools the full 1-min
            // ring buffer into 60 buckets covering the requested window so
            // the payload stays tiny regardless of which window is chosen.
            int windowMin = Math.Clamp(rangeMin ?? 60, 5, SectorTracker.HistorySamples);
            int totalSamples = SectorTracker.HistorySamples;
            int samplesInWindow = Math.Min(windowMin, totalSamples);
            var byFac = new Dictionary<string, Dictionary<string, (int tracks, int hIn, int hOut)>>(StringComparer.OrdinalIgnoreCase);
            string Norm(string? s) => string.IsNullOrEmpty(s) ? "" : s.Trim().ToUpperInvariant();
            (string fac, string sec) Split(string? raw)
            {
                if (string.IsNullOrEmpty(raw)) return ("", "");
                var slash = raw.IndexOf('/');
                if (slash < 0) return (Norm(raw), "");
                return (Norm(raw[..slash]), Norm(raw[(slash + 1)..]));
            }
            void Bump(string fac, string sec, bool isOwn, bool hIn, bool hOut)
            {
                if (string.IsNullOrEmpty(fac)) fac = "(none)";
                if (string.IsNullOrEmpty(sec)) sec = "(none)";
                if (!byFac.TryGetValue(fac, out var inner))
                {
                    inner = new(StringComparer.OrdinalIgnoreCase);
                    byFac[fac] = inner;
                }
                inner.TryGetValue(sec, out var cur);
                cur.tracks    += isOwn ? 1 : 0;
                cur.hIn       += hIn   ? 1 : 0;
                cur.hOut      += hOut  ? 1 : 0;
                inner[sec] = cur;
            }
            foreach (var f in ctx.Flights.Values)
            {
                if (f.FlightStatus is "CANCELLED" or "COMPLETED") continue;
                var fac = Norm(f.ControllingFacility);
                var sec = Norm(f.ControllingSector);
                if (!string.IsNullOrEmpty(fac)) Bump(fac, sec, isOwn: true, hIn: false, hOut: false);
                var (rFac, rSec) = Split(f.HandoffReceiving);
                if (!string.IsNullOrEmpty(rFac))  Bump(rFac, rSec, false, true,  false);
                var (tFac, tSec) = Split(f.HandoffTransferring);
                if (!string.IsNullOrEmpty(tFac) && (tFac != fac || tSec != sec))
                    Bump(tFac, tSec, false, false, true);
            }
            // Surface sectors that were active recently but currently have
            // zero tracks (closed-recently). Add them with empty buckets so
            // the page still renders a row and its history sparkline.
            foreach (var (fac, sec) in ctx.SectorTracker.AllKnownSectors())
            {
                if (!byFac.TryGetValue(fac, out var inner))
                {
                    inner = new(StringComparer.OrdinalIgnoreCase);
                    byFac[fac] = inner;
                }
                if (!inner.ContainsKey(sec) && ctx.SectorTracker.WasRecentlyActive(fac, sec))
                    inner[sec] = (0, 0, 0);
            }
            var rows = byFac
                .Select(kv => new
                {
                    facility    = kv.Key,
                    totalTracks = kv.Value.Values.Sum(v => v.tracks),
                    sectorCount = kv.Value.Count(s => s.Value.tracks > 0),
                    sectors = kv.Value
                        .OrderBy(s => SectorSortKey(s.Key).num)
                        .ThenBy(s => SectorSortKey(s.Key).suffix, StringComparer.OrdinalIgnoreCase)
                        .Select(s =>
                        {
                            // Pull the last `samplesInWindow` samples from
                            // the ring and max-pool to 60 buckets.
                            var full = ctx.SectorTracker.GetHistory(kv.Key, s.Key);
                            int[] window;
                            if (full.Length == 0) window = Array.Empty<int>();
                            else
                            {
                                int start = Math.Max(0, full.Length - samplesInWindow);
                                window = new int[full.Length - start];
                                Array.Copy(full, start, window, 0, window.Length);
                            }
                            // Down-sample to 60 buckets max-pooled.
                            const int Buckets = 60;
                            int[] hist;
                            if (window.Length <= Buckets) hist = window;
                            else
                            {
                                hist = new int[Buckets];
                                double step = (double)window.Length / Buckets;
                                for (int b = 0; b < Buckets; b++)
                                {
                                    int a = (int)(b * step);
                                    int e = Math.Min(window.Length, (int)((b + 1) * step));
                                    int m = 0;
                                    for (int i = a; i < e; i++) if (window[i] > m) m = window[i];
                                    hist[b] = m;
                                }
                            }
                            return new
                            {
                                id          = s.Key,
                                tracks      = s.Value.tracks,
                                handoffsIn  = s.Value.hIn,
                                handoffsOut = s.Value.hOut,
                                history     = hist,
                            };
                        })
                        .ToArray()
                })
                // Z-prefix ARTCCs first (alphabetical), then everything else
                // (TRACONs / towers) alphabetical. Within each band ties are
                // broken by name so the order is stable across refreshes.
                .OrderBy(r => r.facility.StartsWith("Z", StringComparison.OrdinalIgnoreCase) ? 0 : 1)
                .ThenBy(r => r.facility, StringComparer.OrdinalIgnoreCase)
                .ToArray();
            return Results.Json(new
            {
                rangeMinutes = windowMin,
                buckets      = 60,                          // page knows each bucket = windowMin/60 mins
                maxRangeMinutes = SectorTracker.HistorySamples,
                facilities   = rows,
            }, ctx.JsonOpts);
        });

        // Full per-minute history for a single sector. Returns the entire
        // 24-hour ring buffer (1440 ints) so a detail view can render at
        // full resolution without each /api/sectors poll shipping the same
        // mass of bytes for every sector.
        app.MapGet("/api/sectors/{fac}/{sec}/history", (string fac, string sec) =>
        {
            var hist = ctx.SectorTracker.GetHistory(fac, sec);
            return Results.Json(new
            {
                facility = fac.ToUpperInvariant(),
                sector   = sec.ToUpperInvariant(),
                sampleSeconds = 60,
                windowMinutes = SectorTracker.HistorySamples,
                history  = hist,
            }, ctx.JsonOpts);
        });

        // Top handoff transitions in / out of a given sector. Used by the
        // /sectors page's "where do my flights come from / go to" panel.
        // Counts accumulate since the server started.
        app.MapGet("/api/sectors/{fac}/{sec}/transitions", (string fac, string sec) =>
        {
            var into = ctx.SectorTracker.TopIn(fac, sec, 12)
                .Select(t => new { facility = t.Fac, sector = t.Sec, count = t.Count }).ToArray();
            var outOf = ctx.SectorTracker.TopOut(fac, sec, 12)
                .Select(t => new { facility = t.Fac, sector = t.Sec, count = t.Count }).ToArray();
            return Results.Json(new { facility = fac.ToUpperInvariant(), sector = sec.ToUpperInvariant(), into, outOf }, ctx.JsonOpts);
        });

        // Server performance / health: CPU, memory, GC, threads, uptime, WS clients, disk.
        app.MapGet("/api/system", () => Results.Json(SystemStats.Snapshot(ctx.Clients.Count, ctx.Flights.Count), ctx.JsonOpts));

        // Deployed build: current git commit + commit time (so the homepage can show what's live).
        app.MapGet("/api/version", () => Results.Json(VersionInfo.Get(ctx.RepoRoot), ctx.JsonOpts));

        // EDCT (Expected Departure Clearance Time) — flights currently under a GDP/CTOP/Ground Stop slot.
        // Returns ALL flights with EdctTime set, regardless of whether they've already departed.
        // Client can filter as needed.
        app.MapGet("/api/edct", (HttpContext http) =>
        {
            var reveal = LaddService.Reveal(http);
            var now = DateTime.UtcNow;
            var rows = new List<object>();
            foreach (var f in ctx.Flights.Values)
            {
                if (string.IsNullOrEmpty(f.EdctTime)) continue;
                DateTime? edctDt = null;
                if (DateTime.TryParse(f.EdctTime, null,
                    System.Globalization.DateTimeStyles.AdjustToUniversal | System.Globalization.DateTimeStyles.AssumeUniversal,
                    out var dt)) edctDt = dt;
                bool departed = !string.IsNullOrEmpty(f.ActualDepartureTime);
                int? minutesUntil = edctDt.HasValue ? (int)(edctDt.Value - now).TotalMinutes : null;
                rows.Add(new
                {
                    gufi = f.Gufi,
                    callsign = LaddService.MaskCallsign(f.Callsign, f.Registration, reveal, f.ModeSCode),
                    origin = f.Origin,
                    destination = f.Destination,
                    aircraftType = f.AircraftType,
                    edct = f.EdctTime,
                    minutesUntil,
                    actualDeparture = f.ActualDepartureTime,
                    departed,
                    eta = f.ETA,
                    route = f.Route,
                    star = f.STAR,
                    controllingFacility = f.ControllingFacility,
                    controllingSector = f.ControllingSector,
                    flightStatus = f.FlightStatus,
                    lastSeen = f.LastSeen.ToString("o")
                });
            }
            // Sort by EDCT ascending (soonest first)
            rows = rows.OrderBy(r => ((dynamic)r).edct as string).ToList();
            return Results.Json(new { count = rows.Count, flights = rows }, ctx.JsonOpts);
        });

        // Sector frequencies — returns all facility/sector → MHz mappings
        app.MapGet("/api/sectors/freqs", () =>
        {
            return Results.Json(ctx.SectorFreqs, ctx.JsonOpts);
        });
    }
}
