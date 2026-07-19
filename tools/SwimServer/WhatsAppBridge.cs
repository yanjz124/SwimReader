using System.Collections.Concurrent;
using System.Globalization;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace SwimServer;

/// WhatsApp bot bridge — follow a flight over inflight "free messaging" wifi, via WhatsApp.
///
/// Same idea as TelegramBridge (see that file), but over the WhatsApp Cloud API. Airline
/// "free messaging" captive portals whitelist WhatsApp/iMessage/Telegram and block all other
/// HTTP/DNS, so the /t web page can't load — but WhatsApp's servers can be reached in both
/// directions. Some portals whitelist WhatsApp but not Telegram, which is why this exists.
///
/// Unlike Telegram (long-poll getUpdates), the WhatsApp Cloud API is *webhook only*: Meta POSTs
/// inbound messages to a public HTTPS endpoint, so we register GET/POST /whatsapp/webhook on the
/// app (reachable at https://swim.vncrcc.org/whatsapp/webhook via the Cloudflare tunnel). The GET
/// is Meta's one-time verification handshake; the POST delivers messages and delivery receipts.
///
/// Outbound uses the Graph API messages endpoint. WhatsApp only allows free-form messages within
/// 24h of the user's last inbound message (the "customer service window"); conveniently that lines
/// up with our 24h subscription TTL, so an active follower stays inside the window.
///
/// Enabled only when WHATSAPP_TOKEN, WHATSAPP_PHONE_ID and WHATSAPP_VERIFY_TOKEN are all set.
/// Self-contained: Program.cs makes one instance and calls Register(app).
class WhatsAppBridge
{
    private readonly string _token;        // permanent access token (Graph API bearer)
    private readonly string _phoneId;      // WhatsApp business phone-number ID (send endpoint)
    private readonly string _verifyToken;  // arbitrary shared secret for the webhook GET handshake
    private readonly ServerContext _ctx;
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(20) };

    // Graph API version pinned; bump when Meta deprecates.
    private const string GraphBase = "https://graph.facebook.com/v21.0";

    // phone (E.164, e.g. "14155551234") -> subscribed callsigns; last change-key per (phone, cs)
    // so we push only on a meaningful change. Mirrors TelegramBridge exactly, keyed by string phone.
    private readonly ConcurrentDictionary<string, HashSet<string>> _subs = new();
    private readonly ConcurrentDictionary<string, string> _lastSent = new();
    private readonly ConcurrentDictionary<string, DateTime> _subAt = new();
    private readonly ConcurrentDictionary<string, string> _lastRoute = new();
    private static readonly TimeSpan SubTtl = TimeSpan.FromHours(24);

    // Meta redelivers a webhook until it gets a 200 (and sometimes even after), so drop already-seen
    // message ids. Bounded FIFO so it can't grow without limit.
    private readonly ConcurrentDictionary<string, byte> _seenMsgIds = new();
    private readonly ConcurrentQueue<string> _seenOrder = new();

    // Subscriptions persist across restarts so a deploy doesn't silently drop everyone's follows.
    private const string SubsPath = "whatsapp-subs.json";
    private readonly object _saveLock = new();

    public WhatsAppBridge(string token, string phoneId, string verifyToken, ServerContext ctx)
    {
        _token = token; _phoneId = phoneId; _verifyToken = verifyToken; _ctx = ctx;
    }

    // Register the webhook routes and start the proactive push loop. Called from Program.cs with the app.
    public void Register(WebApplication app)
    {
        LoadSubs();

        // Meta webhook verification handshake: echo hub.challenge iff the token matches.
        app.MapGet("/whatsapp/webhook", (HttpRequest req) =>
        {
            var mode = req.Query["hub.mode"].ToString();
            var token = req.Query["hub.verify_token"].ToString();
            var challenge = req.Query["hub.challenge"].ToString();
            if (mode == "subscribe" && token == _verifyToken)
                return Results.Text(challenge, "text/plain");
            return Results.StatusCode(403);
        });

        // Inbound messages + delivery receipts. Return 200 fast; do the work off the request thread
        // (Send() is a network call and Meta retries slow webhooks).
        app.MapPost("/whatsapp/webhook", async (HttpRequest req) =>
        {
            string body;
            using (var reader = new StreamReader(req.Body, Encoding.UTF8))
                body = await reader.ReadToEndAsync();
            _ = Task.Run(() => ProcessWebhook(body));
            return Results.Ok();
        });

        _ = Task.Run(PushLoop);
        Console.WriteLine($"[whatsapp] bot started (webhook /whatsapp/webhook) — {_subs.Count} chat(s) restored");
    }

    // ── persistence: {phone -> {callsign -> subscribedAt(ISO)}} ──────────────────
    // Same on-disk shape as telegram-subs.json (keys are strings there too). Times persist so the
    // 24h expiry survives a restart. Falls back to the old {phone -> [callsigns]} array format.
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
            foreach (var (phone, csMap) in map)
                if (!string.IsNullOrEmpty(phone) && csMap is { Count: > 0 })
                {
                    var set = new HashSet<string>();
                    foreach (var (cs, iso) in csMap)
                    {
                        set.Add(cs);
                        var key = Key(phone, cs);
                        _subAt[key] = DateTime.TryParse(iso, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal, out var dt) ? dt : DateTime.UtcNow;
                        // Baseline change-key + route so restored subs don't all re-notify on first push.
                        _lastSent[key] = TrackRoutes.TelegramChangeKey(_ctx, cs);
                        _lastRoute[key] = TrackRoutes.TelegramRoute(_ctx, cs) ?? "";
                    }
                    _subs[phone] = set;
                }
        }
        catch (Exception ex) { Console.WriteLine("[whatsapp] load subs error: " + ex.Message); }
    }

    private void SaveSubs()
    {
        try
        {
            var snapshot = _subs.ToArray();
            var map = snapshot.ToDictionary(
                kv => kv.Key,
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
        catch (Exception ex) { Console.WriteLine("[whatsapp] save subs error: " + ex.Message); }
    }

    // ── incoming: parse the Cloud API webhook payload ───────────────────────────
    // Shape: {entry:[{changes:[{value:{messages:[{from, id, type, text:{body}}], statuses:[...]}}]}]}
    // We only act on text messages; delivery/read receipts (statuses) are ignored.
    private async Task ProcessWebhook(string body)
    {
        try
        {
            using var doc = JsonDocument.Parse(body);
            if (!doc.RootElement.TryGetProperty("entry", out var entries)) return;
            foreach (var entry in entries.EnumerateArray())
            {
                if (!entry.TryGetProperty("changes", out var changes)) continue;
                foreach (var change in changes.EnumerateArray())
                {
                    if (!change.TryGetProperty("value", out var value)) continue;
                    if (!value.TryGetProperty("messages", out var messages)) continue; // statuses-only payload
                    foreach (var msg in messages.EnumerateArray())
                    {
                        if (msg.TryGetProperty("type", out var ty) && ty.GetString() != "text") continue;
                        var from = msg.TryGetProperty("from", out var fr) ? fr.GetString() : null;
                        if (string.IsNullOrEmpty(from)) continue;

                        // Dedup: Meta redelivers unacked/duplicate webhooks.
                        var id = msg.TryGetProperty("id", out var mid) ? mid.GetString() : null;
                        if (!string.IsNullOrEmpty(id) && !MarkSeen(id)) continue;

                        var text = msg.TryGetProperty("text", out var t) && t.TryGetProperty("body", out var b)
                            ? (b.GetString() ?? "") : "";
                        await HandleCommand(from, text.Trim());
                    }
                }
            }
        }
        catch (Exception ex) { Console.WriteLine("[whatsapp] webhook parse error: " + ex.Message); }
    }

    // Returns true if this id is new (and records it). Bounded to the last ~500 ids.
    private bool MarkSeen(string id)
    {
        if (!_seenMsgIds.TryAdd(id, 0)) return false;
        _seenOrder.Enqueue(id);
        while (_seenOrder.Count > 500 && _seenOrder.TryDequeue(out var old)) _seenMsgIds.TryRemove(old, out _);
        return true;
    }

    private async Task HandleCommand(string phone, string text)
    {
        if (text.Length == 0) return;
        var parts = text.Split(new[] { ' ' }, 2, StringSplitOptions.RemoveEmptyEntries);
        // WhatsApp users won't naturally type a leading "/", so accept commands with or without it.
        var cmd = parts[0].ToLowerInvariant().TrimStart('/');
        var arg = (parts.Length > 1 ? parts[1] : "").Trim().ToUpperInvariant();

        switch (cmd)
        {
            case "start":
            case "help":
                await Send(phone,
                    "Follow flights over inflight wifi.\n\n" +
                    "Send one or more callsigns (e.g. AAL123 or 'AAL123 UAL456 DAL9') for status.\n" +
                    "sub AAL123 UAL456 — get updates when they change (auto-expires after 24h)\n" +
                    "unsub AAL123 — stop those\n" +
                    "list — your subscriptions\n" +
                    "stop — unsubscribe from everything");
                return;

            case "track":
                await Send(phone, MultiSummary(Callsigns(arg)));
                return;

            case "sub":
            {
                var css = Callsigns(arg);
                if (css.Count == 0) { await Send(phone, "Usage: sub CALLSIGN [CALLSIGN…]"); return; }
                var set = _subs.GetOrAdd(phone, _ => new HashSet<string>());
                lock (set) foreach (var cs in css) set.Add(cs);
                // Baseline change-key/route/time now so the push loop only fires on a real change.
                foreach (var cs in css)
                {
                    var key = Key(phone, cs);
                    _subAt[key] = DateTime.UtcNow;
                    _lastSent[key] = TrackRoutes.TelegramChangeKey(_ctx, cs);
                    _lastRoute[key] = TrackRoutes.TelegramRoute(_ctx, cs) ?? "";
                }
                SaveSubs();
                await Send(phone, "Subscribed to " + string.Join(", ", css) + ". Updates when they change; auto-expires in 24h.\n\n" + MultiSummary(css));
                return;
            }

            case "unsub":
            {
                var css = Callsigns(arg);
                if (_subs.TryGetValue(phone, out var set1)) { lock (set1) foreach (var cs in css) set1.Remove(cs); }
                foreach (var cs in css) Forget(phone, cs);
                SaveSubs();
                await Send(phone, css.Count > 0 ? "Unsubscribed from " + string.Join(", ", css) + "." : "Usage: unsub CALLSIGN");
                return;
            }

            case "stop":
            case "unsuball":
                if (_subs.TryRemove(phone, out var gone)) { lock (gone) foreach (var cs in gone) Forget(phone, cs); }
                SaveSubs();
                await Send(phone, "Unsubscribed from all flights.");
                return;

            case "list":
                var list = (_subs.TryGetValue(phone, out var s2) && s2.Count > 0)
                    ? string.Join(", ", s2.OrderBy(x => x)) : "(none)";
                await Send(phone, "Subscribed: " + list);
                return;

            default:
                // Bare callsign(s) → status. Otherwise nudge to help.
                var bare = Callsigns(text);
                if (bare.Count > 0) await Send(phone, MultiSummary(bare));
                else await Send(phone, "Send a callsign (e.g. AAL123) or 'help'.");
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
                foreach (var (phone, set) in _subs)
                {
                    string[] callsigns; lock (set) callsigns = set.ToArray();
                    foreach (var cs in callsigns)
                    {
                        var key = Key(phone, cs);

                        // Auto-expire a follow after 24h so subscriptions don't accumulate forever.
                        // (Also matches WhatsApp's 24h free-form messaging window — past it, Meta would
                        // reject the send unless it's a pre-approved template anyway.)
                        if (_subAt.TryGetValue(key, out var since) && DateTime.UtcNow - since > SubTtl)
                        {
                            if (_subs.TryGetValue(phone, out var s)) { lock (s) s.Remove(cs); }
                            Forget(phone, cs);
                            SaveSubs();
                            await Send(phone, $"⏱ Stopped following {cs} after 24h. Send 'sub {cs}' to keep following.");
                            continue;
                        }

                        // Notify only when the *meaningful* state changed (not position/age drift).
                        var sig = TrackRoutes.TelegramChangeKey(_ctx, cs);
                        if (_lastSent.TryGetValue(key, out var prev) && prev == sig) continue; // nothing worth pushing
                        _lastSent[key] = sig;

                        // Pass the previously-sent route so the summary can show "was: …" on an amendment.
                        var prevRoute = _lastRoute.TryGetValue(key, out var pr) && !string.IsNullOrEmpty(pr) ? pr : null;
                        _lastRoute[key] = TrackRoutes.TelegramRoute(_ctx, cs) ?? "";
                        await Send(phone, TrackRoutes.TelegramSummary(_ctx, cs, prevRoute));
                    }
                }
            }
            catch (Exception ex) { Console.WriteLine("[whatsapp] push error: " + ex.Message); }
        }
    }

    private static string Key(string phone, string cs) => phone + "|" + cs;

    // Drop all per-(phone, callsign) push state (change-key, route, sub time) on unsubscribe/expiry.
    private void Forget(string phone, string cs)
    {
        var key = Key(phone, cs);
        _lastSent.TryRemove(key, out _);
        _lastRoute.TryRemove(key, out _);
        _subAt.TryRemove(key, out _);
    }

    private async Task Send(string phone, string text)
    {
        try
        {
            var payload = JsonSerializer.Serialize(new
            {
                messaging_product = "whatsapp",
                to = phone,
                type = "text",
                text = new { body = text, preview_url = false }
            });
            using var req = new HttpRequestMessage(HttpMethod.Post, $"{GraphBase}/{_phoneId}/messages")
            {
                Content = new StringContent(payload, Encoding.UTF8, "application/json")
            };
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _token);
            var resp = await _http.SendAsync(req);
            if (!resp.IsSuccessStatusCode)
                Console.WriteLine($"[whatsapp] send {(int)resp.StatusCode}: {await resp.Content.ReadAsStringAsync()}");
        }
        catch (Exception ex) { Console.WriteLine("[whatsapp] send error: " + ex.Message); }
    }
}
