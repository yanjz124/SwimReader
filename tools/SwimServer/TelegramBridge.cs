using System.Collections.Concurrent;
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
    private long _offset;

    public TelegramBridge(string token, ServerContext ctx) { _token = token; _ctx = ctx; }

    public void Start()
    {
        _ = Task.Run(PollLoop);
        _ = Task.Run(PushLoop);
        Console.WriteLine("[telegram] bot started (long-poll)");
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
                    "/sub AAL123 UAL456 — get updates when they change\n" +
                    "/unsub AAL123 — stop those\n" +
                    "/list — your subscriptions\n" +
                    "/stop — unsubscribe from everything");
                return;

            case "/track":
                await Send(chat, MultiSummary(Callsigns(arg)));
                return;

            case "/sub":
            {
                var css = Callsigns(arg);
                if (css.Count == 0) { await Send(chat, "Usage: /sub CALLSIGN [CALLSIGN…]"); return; }
                var set = _subs.GetOrAdd(chat, _ => new HashSet<string>());
                lock (set) foreach (var cs in css) set.Add(cs);
                await Send(chat, "Subscribed to " + string.Join(", ", css) + ". Updates when they change.\n\n" + MultiSummary(css));
                // Baseline the change-key now so the push loop only fires on a real change (no immediate re-send).
                foreach (var cs in css) _lastSent[Key(chat, cs)] = TrackRoutes.TelegramChangeKey(_ctx, cs);
                return;
            }

            case "/unsub":
            {
                var css = Callsigns(arg);
                if (_subs.TryGetValue(chat, out var set1)) { lock (set1) foreach (var cs in css) set1.Remove(cs); }
                foreach (var cs in css) _lastSent.TryRemove(Key(chat, cs), out _);
                await Send(chat, css.Count > 0 ? "Unsubscribed from " + string.Join(", ", css) + "." : "Usage: /unsub CALLSIGN");
                return;
            }

            case "/stop":
                _subs.TryRemove(chat, out _);
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
                if (bare.Count > 0) await Send(chat, MultiSummary(bare));
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
        return string.Join("\n\n———\n\n", callsigns.Select(cs => TrackRoutes.TelegramSummary(_ctx, cs)));
    }

    // ── outgoing: push subscribed flights when their summary changes ─────────────
    private async Task PushLoop()
    {
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
                        // Notify only when the *meaningful* state changed (not position/age drift).
                        var sig = TrackRoutes.TelegramChangeKey(_ctx, cs);
                        var key = Key(chat, cs);
                        if (_lastSent.TryGetValue(key, out var prev) && prev == sig) continue; // nothing worth pushing
                        _lastSent[key] = sig;
                        await Send(chat, TrackRoutes.TelegramSummary(_ctx, cs));
                    }
                }
            }
            catch (Exception ex) { Console.WriteLine("[telegram] push error: " + ex.Message); }
        }
    }

    private static string Key(long chat, string cs) => chat + "|" + cs;

    private async Task Send(long chat, string text)
    {
        try
        {
            var payload = JsonSerializer.Serialize(new { chat_id = chat, text, disable_web_page_preview = true });
            using var content = new StringContent(payload, Encoding.UTF8, "application/json");
            await _http.PostAsync($"https://api.telegram.org/bot{_token}/sendMessage", content);
        }
        catch (Exception ex) { Console.WriteLine("[telegram] send error: " + ex.Message); }
    }
}
