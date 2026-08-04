using System.Collections.Concurrent;
using System.Globalization;
using System.Net.Http;
using System.Text;
using System.Text.Json;

namespace SwimServer;

/// Telegram bot bridge — lets you follow a flight over inflight "free messaging" wifi.
///
/// Those captive portals whitelist only messaging endpoints (Telegram/WhatsApp/iMessage) and block
/// all other HTTP/DNS, so the /t web page can't load — but Telegram's API can, in both directions.
/// This bot long-polls getUpdates, answers a callsign with the same aggregation the Track-a-Flight
/// page uses (TrackRoutes.TelegramSummary), and can push updates for subscribed flights.
///
/// Enabled only when TELEGRAM_BOT_TOKEN is set (create a bot with @BotFather). Self-contained:
/// Program.cs makes one instance and calls Start().
class TelegramBridge
{
    private readonly string _token;
    private readonly ServerContext _ctx;
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(40) };

    // chatId -> subscribed callsigns; and last summary sent per (chat, callsign) to push only on change.
    private readonly ConcurrentDictionary<long, HashSet<string>> _subs = new();
    private readonly ConcurrentDictionary<string, string> _lastSent = new();
    // Per-(chat, callsign) subscription time (for the 24h auto-expiry) and last route we sent (to
    // show previous-vs-new on a route amendment). Keyed by Key(chat, cs).
    private readonly ConcurrentDictionary<string, DateTime> _subAt = new();
    private readonly ConcurrentDictionary<string, string> _lastRoute = new();
    // Last plain summary text we sent per (chat, callsign) — diffed against the next one so a push can
    // bold the lines that actually changed since the follower last heard from us.
    private readonly ConcurrentDictionary<string, string> _lastSummary = new();
    // Per-(chat, callsign) "gone quiet" flag — set once a followed flight lands / stops updating so we
    // send a single final note and then stop re-pushing its frozen record (cleared when it revives).
    private readonly ConcurrentDictionary<string, byte> _quiet = new();
    // When the flight went quiet (UTC). After it stays quiet for LandedTtl we end the subscription —
    // the follow is meant to last for the flight, not a fixed clock. Cleared if it revives (radar gap).
    private readonly ConcurrentDictionary<string, DateTime> _quietAt = new();
    // A followed flight is auto-unsubscribed once it has been landed/quiet this long. The confirmation
    // window past the initial StaleSec silence lets a brief en-route radar gap recover before we stop.
    private static readonly TimeSpan LandedTtl = TimeSpan.FromMinutes(10);
    // Far backstop only — a flight that never produces a clean landing signal (e.g. never departs, or
    // an oceanic record with no position) still can't follow forever.
    private static readonly TimeSpan SubTtl = TimeSpan.FromHours(24);
    // No position update anywhere for this long ⇒ treat the flight as arrived/quiet. Well past a coast
    // (26s) or DROPPED grace (60s), so a brief en-route radar gap won't trip it; a landed flight whose
    // record lingers for the full 60-min retention is silenced within 5 minutes.
    private const int StaleSec = 300;
    // After a restart the flight cache is loaded before Solace reconnects, so the change-keys baselined
    // in LoadSubs are computed from stale state. Wait this long for the feed to repopulate, then
    // re-baseline every subscription, so a redeploy doesn't fire a spurious "update" to everyone.
    private static readonly TimeSpan WarmUp = TimeSpan.FromMinutes(2);
    private long _offset;

    // Subscriptions persist across restarts so a deploy doesn't silently drop everyone's follows.
    // Stored in the working dir (like flight-cache) so it survives clean rebuilds/redeploys.
    private const string SubsPath = "telegram-subs.json";
    private readonly object _saveLock = new();

    public TelegramBridge(string token, ServerContext ctx) { _token = token; _ctx = ctx; }

    public void Start()
    {
        LoadSubs();
        _ = Task.Run(PollLoop);
        _ = Task.Run(PushLoop);
        Console.WriteLine($"[telegram] bot started (long-poll) — {_subs.Count} chat(s) restored");
    }

    // ── persistence: {chatId(string) -> {callsign -> subscribedAt(ISO)}} ─────────
    // Times persist so the 24h expiry survives a restart (a restart must not silently
    // extend everyone's follows). Falls back to the old {chatId -> [callsigns]} format.
    private void LoadSubs()
    {
        try
        {
            if (!File.Exists(SubsPath)) return;
            var text = File.ReadAllText(SubsPath);
            Dictionary<string, Dictionary<string, string>>? map = null;
            try { map = JsonSerializer.Deserialize<Dictionary<string, Dictionary<string, string>>>(text); }
            catch { /* legacy array format handled below */ }
            if (map == null)
            {
                var old = JsonSerializer.Deserialize<Dictionary<string, List<string>>>(text);
                map = old?.ToDictionary(kv => kv.Key,
                    kv => kv.Value.ToDictionary(cs => cs, _ => DateTime.UtcNow.ToString("o")));
            }
            if (map == null) return;
            foreach (var (k, csMap) in map)
                if (long.TryParse(k, out var chat) && csMap is { Count: > 0 })
                {
                    var set = new HashSet<string>();
                    foreach (var (cs, iso) in csMap)
                    {
                        set.Add(cs);
                        var key = Key(chat, cs);
                        _subAt[key] = DateTime.TryParse(iso, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal, out var dt) ? dt : DateTime.UtcNow;
                        // Baseline change-key + route so restored subs don't all re-notify on first push.
                        _lastSent[key] = TrackRoutes.TelegramChangeKey(_ctx, cs);
                        _lastRoute[key] = TrackRoutes.TelegramRoute(_ctx, cs) ?? "";
                    }
                    _subs[chat] = set;
                }
        }
        catch (Exception ex) { Console.WriteLine("[telegram] load subs error: " + ex.Message); }
    }

    private void SaveSubs()
    {
        try
        {
            var snapshot = _subs.ToArray();
            var map = snapshot.ToDictionary(
                kv => kv.Key.ToString(),
                kv => { lock (kv.Value) return kv.Value.OrderBy(x => x).ToDictionary(
                            cs => cs,
                            cs => (_subAt.TryGetValue(Key(kv.Key, cs), out var dt) ? dt : DateTime.UtcNow).ToString("o")); });
            var json = JsonSerializer.Serialize(map);
            lock (_saveLock)
            {
                var tmp = SubsPath + ".tmp";
                File.WriteAllText(tmp, json);
                File.Move(tmp, SubsPath, overwrite: true);
            }
        }
        catch (Exception ex) { Console.WriteLine("[telegram] save subs error: " + ex.Message); }
    }

    // ── incoming: long-poll getUpdates ──────────────────────────────────────────
    private async Task PollLoop()
    {
        while (true)
        {
            try
            {
                var url = $"https://api.telegram.org/bot{_token}/getUpdates?timeout=30&offset={_offset}";
                var json = await _http.GetStringAsync(url);
                using var doc = JsonDocument.Parse(json);
                if (!doc.RootElement.TryGetProperty("result", out var result)) continue;
                foreach (var upd in result.EnumerateArray())
                {
                    if (upd.TryGetProperty("update_id", out var uid)) _offset = uid.GetInt64() + 1;
                    if (!upd.TryGetProperty("message", out var msg)) continue;
                    if (!msg.TryGetProperty("chat", out var chat) || !chat.TryGetProperty("id", out var cid)) continue;
                    var text = msg.TryGetProperty("text", out var t) ? (t.GetString() ?? "") : "";
                    await HandleCommand(cid.GetInt64(), text.Trim());
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine("[telegram] poll error: " + ex.Message);
                await Task.Delay(3000);
            }
        }
    }

    private async Task HandleCommand(long chat, string text)
    {
        if (text.Length == 0) return;
        var parts = text.Split(new[] { ' ' }, 2, StringSplitOptions.RemoveEmptyEntries);
        var cmd = parts[0].ToLowerInvariant();
        // Strip @botname suffix Telegram adds in groups (e.g. /track@MyBot)
        int at = cmd.IndexOf('@'); if (at >= 0) cmd = cmd[..at];
        var arg = (parts.Length > 1 ? parts[1] : "").Trim().ToUpperInvariant();

        switch (cmd)
        {
            case "/start":
            case "/help":
                await Send(chat,
                    "Follow flights over inflight wifi.\n\n" +
                    "Send one or more callsigns (e.g. AAL123 or 'AAL123 UAL456 DAL9') for status.\n" +
                    "/sub AAL123 UAL456 — get updates when they change (auto-stops once it lands)\n" +
                    "/unsub AAL123 — stop those\n" +
                    "/list — your subscriptions\n" +
                    "/unsuball (or /stop) — unsubscribe from everything");
                return;

            case "/track":
                await Send(chat, MultiSummary(Callsigns(arg)), html: true);
                return;

            case "/sub":
            {
                var css = Callsigns(arg);
                if (css.Count == 0) { await Send(chat, "Usage: /sub CALLSIGN [CALLSIGN…]"); return; }
                var set = _subs.GetOrAdd(chat, _ => new HashSet<string>());
                lock (set) foreach (var cs in css) set.Add(cs);
                // Baseline change-key/route/time now so the push loop only fires on a real change.
                foreach (var cs in css)
                {
                    var key = Key(chat, cs);
                    _subAt[key] = DateTime.UtcNow;
                    _lastSent[key] = TrackRoutes.TelegramChangeKey(_ctx, cs);
                    _lastRoute[key] = TrackRoutes.TelegramRoute(_ctx, cs) ?? "";
                    // If it already landed when they subscribed, start quiet — the summary just sent
                    // shows the stale position, so don't announce "arrived" two minutes later.
                    var age = TrackRoutes.TelegramPositionAgeSec(_ctx, cs);
                    if (age != null && age > StaleSec) { _quiet[key] = 0; _quietAt[key] = DateTime.UtcNow; }
                    else { _quiet.TryRemove(key, out _); _quietAt.TryRemove(key, out _); }
                }
                SaveSubs();
                await Send(chat, "Subscribed to " + string.Join(", ", css) + ". Updates when they change; auto-stops once it lands.\n\n" + MultiSummary(css), html: true);
                return;
            }

            case "/unsub":
            {
                var css = Callsigns(arg);
                if (_subs.TryGetValue(chat, out var set1)) { lock (set1) foreach (var cs in css) set1.Remove(cs); }
                foreach (var cs in css) Forget(chat, cs);
                SaveSubs();
                await Send(chat, css.Count > 0 ? "Unsubscribed from " + string.Join(", ", css) + "." : "Usage: /unsub CALLSIGN");
                return;
            }

            case "/stop":
            case "/unsuball":
                if (_subs.TryRemove(chat, out var gone)) { lock (gone) foreach (var cs in gone) Forget(chat, cs); }
                SaveSubs();
                await Send(chat, "Unsubscribed from all flights.");
                return;

            case "/list":
                var list = (_subs.TryGetValue(chat, out var s2) && s2.Count > 0)
                    ? string.Join(", ", s2.OrderBy(x => x)) : "(none)";
                await Send(chat, "Subscribed: " + list);
                return;

            default:
                // Bare callsign(s) → status. Otherwise nudge to /help.
                var bare = Callsigns(text);
                if (bare.Count > 0) await Send(chat, MultiSummary(bare), html: true);
                else await Send(chat, "Send a callsign (e.g. AAL123) or /help.");
                return;
        }
    }

    // Split a message into callsign tokens (space/comma/newline separated, 2–8 alphanumerics), max 6.
    private static List<string> Callsigns(string s) =>
        (s ?? "").Split(new[] { ' ', ',', '\n', '\t' }, StringSplitOptions.RemoveEmptyEntries)
            .Where(x => System.Text.RegularExpressions.Regex.IsMatch(x, "^[A-Za-z0-9]{2,8}$"))
            .Select(x => x.ToUpperInvariant()).Distinct().Take(6).ToList();

    private string MultiSummary(List<string> callsigns)
    {
        if (callsigns.Count == 0) return "Send a callsign, e.g. AAL123";
        // On-demand (no "previous"): just format each — header bold, everything HTML-escaped.
        return string.Join("\n\n———\n\n", callsigns.Select(cs => FormatSummary(TrackRoutes.TelegramSummary(_ctx, cs), null)));
    }

    private static string HtmlEsc(string s) => s.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;");

    // Render a summary as Telegram HTML. The header (✈ line) is always bold; when a previous summary
    // is supplied, any line that's new or changed vs it is bolded too, so a follower sees at a glance
    // what changed. Volatile lines (position, ground speed) are never bolded — they drift on every
    // update and aren't "news". All text is HTML-escaped.
    private static string FormatSummary(string cur, string? prev)
    {
        var prevLines = prev != null ? new HashSet<string>(prev.Split('\n')) : null;
        var lines = cur.Split('\n');
        var sb = new StringBuilder(cur.Length + 64);
        for (int i = 0; i < lines.Length; i++)
        {
            var line = lines[i];
            var esc = HtmlEsc(line);
            bool bold = i == 0
                || (prevLines != null && line.Length > 0 && !IsVolatileLine(line) && !prevLines.Contains(line));
            sb.Append(bold ? "<b>" + esc + "</b>" : esc);
            if (i < lines.Length - 1) sb.Append('\n');
        }
        return sb.ToString();
    }

    private static bool IsVolatileLine(string line) =>
        line.StartsWith("Pos:") || System.Text.RegularExpressions.Regex.IsMatch(line, @"^\d+ kt\b");

    // ── outgoing: push subscribed flights when their summary changes ─────────────
    private async Task PushLoop()
    {
        // Warm-up: let Solace reconnect and the feed repopulate after a restart, then re-baseline every
        // subscription against the settled state so a redeploy doesn't push a spurious "update" to
        // everyone. Flights already landed/quiet are pre-marked so they don't all announce "arrived".
        await Task.Delay(WarmUp);
        foreach (var (chat, set) in _subs)
        {
            string[] css; lock (set) css = set.ToArray();
            foreach (var cs in css)
            {
                var key = Key(chat, cs);
                _lastSent[key] = TrackRoutes.TelegramChangeKey(_ctx, cs);
                _lastRoute[key] = TrackRoutes.TelegramRoute(_ctx, cs) ?? "";
                var age = TrackRoutes.TelegramPositionAgeSec(_ctx, cs);
                if (age != null && age > StaleSec) _quiet[key] = 0; else _quiet.TryRemove(key, out _);
            }
        }

        while (true)
        {
            await Task.Delay(TimeSpan.FromSeconds(120));
            try
            {
                foreach (var (chat, set) in _subs)
                {
                    string[] callsigns; lock (set) callsigns = set.ToArray();
                    foreach (var cs in callsigns)
                    {
                        var key = Key(chat, cs);

                        // Auto-expire a follow after 24h so subscriptions don't accumulate forever.
                        if (_subAt.TryGetValue(key, out var since) && DateTime.UtcNow - since > SubTtl)
                        {
                            if (_subs.TryGetValue(chat, out var s)) { lock (s) s.Remove(cs); }
                            Forget(chat, cs);
                            SaveSubs();
                            await Send(chat, $"⏱ Stopped following {cs} after 24h. Send /sub {cs} to keep following.");
                            continue;
                        }

                        // Landed / no-longer-updating: once no source has a fresh position, send one final
                        // note and fall quiet — don't keep re-pushing a frozen record for its whole 60-min
                        // retention. A flight that never had a position (pre-departure) is left to normal
                        // handling so its EDCT/gate/route changes still push. Revives automatically when a
                        // fresh position returns (a diversion, or just a radar gap that filled back in).
                        var age = TrackRoutes.TelegramPositionAgeSec(_ctx, cs);
                        var fresh = age != null && age <= StaleSec;
                        if (fresh)
                        {
                            _quiet.TryRemove(key, out _);
                            _quietAt.TryRemove(key, out _);   // revived (e.g. radar gap filled in)
                        }
                        else if ((age != null && age > StaleSec) || _quiet.ContainsKey(key))
                        {
                            // Stale-with-position now, or already quiet (its record has since purged to
                            // null). Announce once, then stay silent.
                            if (_quiet.TryAdd(key, 0))
                            {
                                _quietAt[key] = DateTime.UtcNow;
                                if (age != null)
                                {
                                    _lastSent[key] = TrackRoutes.TelegramChangeKey(_ctx, cs);
                                    await Send(chat, $"🛬 {cs} — no position update for {age / 60}m. Likely arrived; I'll stop following it shortly unless it starts moving again. Send {cs} anytime for the last-known details.");
                                }
                            }
                            // Once it's stayed quiet/landed for the confirmation window, end the follow
                            // SILENTLY — the "arrived, I'll stop following shortly" note already went out,
                            // so we don't spam a second message. It just quietly drops off /list.
                            if (_quietAt.TryGetValue(key, out var quietSince) && DateTime.UtcNow - quietSince > LandedTtl)
                            {
                                if (_subs.TryGetValue(chat, out var qs)) { lock (qs) qs.Remove(cs); }
                                Forget(chat, cs);
                                SaveSubs();
                            }
                            continue;
                        }
                        // else: age == null and not quiet ⇒ pre-departure, fall through to normal handling.

                        // Notify only when the *meaningful* state changed (not position/age drift).
                        var sig = TrackRoutes.TelegramChangeKey(_ctx, cs);
                        if (_lastSent.TryGetValue(key, out var prev) && prev == sig) continue; // nothing worth pushing
                        _lastSent[key] = sig;

                        // Pass the previously-sent route so the summary can show "was: …" on an amendment.
                        var prevRoute = _lastRoute.TryGetValue(key, out var pr) && !string.IsNullOrEmpty(pr) ? pr : null;
                        _lastRoute[key] = TrackRoutes.TelegramRoute(_ctx, cs) ?? "";
                        var summary = TrackRoutes.TelegramSummary(_ctx, cs, prevRoute);
                        var prevSummary = _lastSummary.TryGetValue(key, out var psum) ? psum : null;
                        _lastSummary[key] = summary;
                        await Send(chat, FormatSummary(summary, prevSummary), html: true);
                    }
                }
            }
            catch (Exception ex) { Console.WriteLine("[telegram] push error: " + ex.Message); }
        }
    }

    private static string Key(long chat, string cs) => chat + "|" + cs;

    // Drop all per-(chat, callsign) push state (change-key, route, sub time) on unsubscribe/expiry.
    private void Forget(long chat, string cs)
    {
        var key = Key(chat, cs);
        _lastSent.TryRemove(key, out _);
        _lastRoute.TryRemove(key, out _);
        _lastSummary.TryRemove(key, out _);
        _subAt.TryRemove(key, out _);
        _quiet.TryRemove(key, out _);
        _quietAt.TryRemove(key, out _);
    }

    private async Task Send(long chat, string text, bool html = false)
    {
        try
        {
            object payloadObj = html
                ? new { chat_id = chat, text, disable_web_page_preview = true, parse_mode = "HTML" }
                : new { chat_id = chat, text, disable_web_page_preview = true };
            var payload = JsonSerializer.Serialize(payloadObj);
            using var content = new StringContent(payload, Encoding.UTF8, "application/json");
            await _http.PostAsync($"https://api.telegram.org/bot{_token}/sendMessage", content);
        }
        catch (Exception ex) { Console.WriteLine("[telegram] send error: " + ex.Message); }
    }
}
