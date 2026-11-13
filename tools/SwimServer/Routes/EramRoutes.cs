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
    // Last good /feed body from the neighboring STDDS service, so a restart over there shows a
    // few seconds of stale numbers rather than an empty card on every dashboard poll.
    private static string? _stddsFeedCache;
    private static DateTime _stddsFeedAt;

    public static void Register(WebApplication app, ServerContext ctx)
    {
        // WebSocket — streams flight updates to browser
        app.Map("/ws", async (HttpContext c) =>
        {
            if (!c.WebSockets.IsWebSocketRequest) { c.Response.StatusCode = 400; return; }

            // permessage-deflate (see SwimWs). The opening snapshot is ~6,900 flights with full
            // flight plans: 17.6 MB uncompressed, 2.08 MB deflated. Over the Cloudflare tunnel
            // that transfer is what "the scope takes forever to load" was.
            using var ws = await SwimWs.AcceptAsync(c);
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
        // ── Correlation index for the STARS callsign enrichment ─────────────────
        //
        // A compact dump of every positioned SFDPS flight, for swimreader-stdds to correlate
        // uncorrelated TRACON targets against. It lives here because SFDPS is consumed by THIS
        // process and a Solace queue is competing-consumers — a second subscriber would split
        // the feed rather than duplicate it (see SWIM_FEED_HOST), so the other service must be
        // handed the data over HTTP instead of subscribing itself.
        //
        // Measured opportunity when this was written: across 142 facilities and 14,148 untagged
        // TRACON targets, a discrete beacon code plus a 5 NM / 1,000 ft gate against this set
        // names 31.0% of them, and 21.7% carry a Mode S code with a NON-discrete squawk, which
        // nothing but an exact Mode S match can reach.
        //
        // Operator-gated, which for the real consumer means the unproxied-loopback case: it is a
        // bulk dump of the whole en-route picture, and nothing on the public site needs it.
        // LADD-blocked aircraft are omitted ENTIRELY rather than masked — a masked row would
        // still let the far side put a position and a beacon code together, and the point of the
        // list is to turn exactly that pair into an identity.
        app.MapGet("/api/enrich/aircraft", (HttpContext http) =>
        {
            if (!LaddService.OperatorView(http)) return LaddService.OperatorOnly();
            var now = DateTime.UtcNow;
            var rows = new List<object>();
            foreach (var f in ctx.Flights.Values)
            {
                if (f.Latitude is null || f.Longitude is null) continue;
                if (string.IsNullOrEmpty(f.Callsign)) continue;
                if (f.FlightStatus == "CANCELLED") continue;
                if (LaddService.IsBlocked(f.Callsign, f.Registration)) continue;
                // Age is the caller's to judge: SFDPS keeps a flight for 60 minutes after its
                // last update, so a stale record still carries a position that was true once.
                // An exact Mode S match is unharmed by that; a position gate is not, which is
                // why the age travels with the row instead of being filtered to one value here.
                rows.Add(new
                {
                    cs = f.Callsign,
                    hex = f.ModeSCode,
                    sq = f.Squawk,
                    lat = f.Latitude,
                    lon = f.Longitude,
                    alt = f.ReportedAltitude,
                    age = (int)(now - f.LastSeen).TotalSeconds,
                });
            }
            return Results.Json(new { ts = now.ToString("o"), count = rows.Count, aircraft = rows },
                                ctx.JsonOpts);
        });

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
                cur.tracks += isOwn ? 1 : 0;
                cur.hIn += hIn ? 1 : 0;
                cur.hOut += hOut ? 1 : 0;
                inner[sec] = cur;
            }
            foreach (var f in ctx.Flights.Values)
            {
                if (f.FlightStatus is "CANCELLED" or "COMPLETED") continue;
                var fac = Norm(f.ControllingFacility);
                var sec = Norm(f.ControllingSector);
                if (!string.IsNullOrEmpty(fac)) Bump(fac, sec, isOwn: true, hIn: false, hOut: false);
                var (rFac, rSec) = Split(f.HandoffReceiving);
                if (!string.IsNullOrEmpty(rFac)) Bump(rFac, rSec, false, true, false);
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
            // NAS-code → real TRACON id (e.g. "ORT" → "C90"), same resolution the track/Telegram paths
            // use (they have the reporting ARTCC for context; the sectors view groups by code alone).
            // TraconIds is keyed "ARTCC/starsId"; build a bare code→id map but resolve ONLY codes that
            // map to a single real id across ARTCCs — a code that means different TRACONs in different
            // centers (or a pseudo controlling-facility) is ambiguous, so we leave it unresolved.
            var bareTracon = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
            foreach (var kv in ctx.TraconIds)
            {
                var i = kv.Key.IndexOf('/');
                if (i <= 0) continue;
                var code = kv.Key[(i + 1)..];
                if (bareTracon.TryGetValue(code, out var existing))
                {
                    if (existing != null && !string.Equals(existing, kv.Value, StringComparison.OrdinalIgnoreCase))
                        bareTracon[code] = null;   // maps to >1 real id ⇒ ambiguous
                }
                else bareTracon[code] = kv.Value;
            }
            var rows = byFac
                .Select(kv => new
                {
                    facility = kv.Key,
                    // Real TRACON id when this facility is an ERAM NAS code (null otherwise).
                    traconId = bareTracon.TryGetValue(kv.Key, out var rid)
                                  && !string.Equals(rid, kv.Key, StringComparison.OrdinalIgnoreCase) ? rid : null,
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
                                id = s.Key,
                                tracks = s.Value.tracks,
                                handoffsIn = s.Value.hIn,
                                handoffsOut = s.Value.hOut,
                                history = hist,
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
                buckets = 60,                          // page knows each bucket = windowMin/60 mins
                maxRangeMinutes = SectorTracker.HistorySamples,
                facilities = rows,
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
                sector = sec.ToUpperInvariant(),
                sampleSeconds = 60,
                windowMinutes = SectorTracker.HistorySamples,
                history = hist,
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

        // Server performance / health: CPU, memory, GC, threads, uptime, live clients, disk.
        // Every feed that holds live clients gets listed here. ctx.Clients is only the SFDPS /ws
        // socket (ERAM scope, flight table) — the other feeds keep their own registries, and STARS
        // rides the proxied DGScope HTTP stream rather than a WebSocket, so it is counted in
        // DgScopeRoutes. A feed missing from this array silently reads as zero.
        //
        // Operator-only (LaddService.OperatorView): who is connected, how much disk is left and
        // what this box is called are facts about the deployment, not about air traffic. The
        // home page hides the card that reads this for the same reason.
        app.MapGet("/api/system", (HttpContext http) =>
        {
            if (!LaddService.OperatorView(http)) return LaddService.OperatorOnly();
            return Results.Json(SystemStats.Snapshot(new (string, int)[]
            {
                ("SFDPS", ctx.Clients.Count),
                ("STARS", DgScopeRoutes.ActiveClients),
                ("ASDE-X", ctx.Asdex.ClientCount),
                ("TAIS", ctx.Tais.ClientCount),
                ("TDLS", ctx.Tdls.ClientCount),
                ("TFDM", ctx.Tfdm.ClientCount),
                ("TFMS", ctx.Tfms.ClientCount),
                ("ITWS", ctx.Itws.ClientCount),
                ("NAS", ctx.NasStream.ClientCount),
                ("Replay", ctx.ReplayServer.ClientCount),
            }, ctx.Flights.Count), ctx.JsonOpts);
        });

        // Feed health: per-feed throughput, how hard the parse thread is working, and any
        // broker-side discards (see FeedHealth — a non-zero discardEvents is confirmed data loss).
        //
        // Operator-only, same as /api/system: this is the state of our subscription — queue
        // sharing, flow counts, where the lag is — and it names the feed host.
        app.MapGet("/api/feed", (HttpContext http) =>
        {
            if (!LaddService.OperatorView(http)) return LaddService.OperatorOnly();
            return Results.Json(new
            {
                liveFeed = FeedGuard.LiveFeed,
                feedBlocked = FeedGuard.BlockedReason,
                feedHost = FeedGuard.FeedHost,
                host = Environment.MachineName,
                feeds = FeedHealth.Snapshot(),
            }, ctx.JsonOpts);
        });

        // The OTHER consumer of the STDDS queue.
        //
        // swimreader-stdds (port 5000) binds the SAME Solace queue as this process's AsdexBridge,
        // and a Solace queue is competing-consumers: each message is delivered to exactly ONE
        // bound flow. So the "STDDS" figure in /api/feed above is this process's SHARE, not the
        // queue's rate, and the two have to be read together. SWIM_FEED_HOST does not prevent
        // this — it stops a second HOST binding the queue, and both services run on the feed
        // host by design.
        //
        // Short timeout and a cached last-good answer: the dashboard polls this every 10s and a
        // restart of the neighboring service must degrade to "unreachable", not stall the card.
        app.MapGet("/api/feed/stdds", async (HttpContext req) =>
        {
            if (!LaddService.OperatorView(req)) return LaddService.OperatorOnly();
            var cached = _stddsFeedCache;
            if (cached is not null && (DateTime.UtcNow - _stddsFeedAt).TotalSeconds < 5)
                return Results.Content(cached, "application/json");
            try
            {
                using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
                var body = await http.GetStringAsync("http://127.0.0.1:5000/feed");
                _stddsFeedCache = body;
                _stddsFeedAt = DateTime.UtcNow;
                return Results.Content(body, "application/json");
            }
            catch (Exception ex)
            {
                return Results.Json(new { service = "STDDS", reachable = false, error = ex.Message },
                    ctx.JsonOpts);
            }
        });

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
