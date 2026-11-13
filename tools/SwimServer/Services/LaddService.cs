using Microsoft.AspNetCore.Http;

namespace SwimServer;

/// <summary>
/// FAA LADD (Limiting Aircraft Data Displayed) compliance.
///
/// The FAA SWIM Terms of Service require blocking any general-aviation / on-demand
/// aircraft <b>registration, call sign, or flight number</b> that appears on the
/// monthly "IndustryLADD" list — from BOTH real-time and historical display and
/// distribution. This service loads that list and answers <see cref="IsBlocked"/>;
/// callers drop matching aircraft at ingestion so they never enter the flight
/// store, history files, exports, or any frontend.
///
/// <para><b>Operator setup (required for compliance):</b> the SCDS account holder
/// downloads the "IndustryLADD" file from the FAA ADX portal (https://adx.faa.gov,
/// SCBlockAtIndustry community) on/after the first Thursday of each month and drops
/// it in <c>&lt;working-dir&gt;/ladd/</c> (any <c>.txt</c> or <c>.csv</c>). We
/// reload every few hours, so a monthly update is picked up within a day without a
/// restart. The list must be updated within FIVE business days of publication.</para>
///
/// <para>If no file is present the block set is empty and NOTHING is filtered — a
/// prominent WARNING is logged so it's obvious LADD is inactive.</para>
/// </summary>
static class LaddService
{
    // Immutable snapshot swapped atomically on reload; readers never lock.
    private static volatile HashSet<string> _blocked = new(StringComparer.OrdinalIgnoreCase);
    private static string _dir = "ladd";
    private static DateTime _loadedAt = DateTime.MinValue;
    private static volatile int _count;
    private static readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(60) };

    public static int Count => _count;
    public static DateTime LoadedAt => _loadedAt;
    public static bool Active => _count > 0;
    public static string Directory_ => _dir;

    /// <summary>Label shown in place of a blocked aircraft's identity.</summary>
    public const string Label = "LADD";

    // Secret that lets a request see real (un-masked) identities — the owner "backdoor".
    // Set LADD_BYPASS_KEY in the environment; empty disables the bypass entirely.
    public static string? BypassKey { get; private set; }

    public static void Init(string workingDir)
    {
        BypassKey = Environment.GetEnvironmentVariable("LADD_BYPASS_KEY");
        Console.WriteLine(string.IsNullOrEmpty(BypassKey)
            ? "[LADD] No LADD_BYPASS_KEY — no private view; operator-only pages are OPEN to everyone"
            : "[LADD] LADD_BYPASS_KEY set — un-masked view and operator-only pages require /login");
        _dir = Path.Combine(workingDir, "ladd");
        try { Directory.CreateDirectory(_dir); } catch { /* best effort */ }
        Load();

        // Optional self-update: if LADD_FETCH_URL is set, pull the IndustryLADD file
        // ourselves (daily) so it's never more than a day stale — no manual download.
        // The ADX portal is auth-gated, so pass credentials via LADD_FETCH_COOKIE
        // (a full Cookie header) and/or LADD_FETCH_AUTH (an Authorization header).
        var fetchUrl = Environment.GetEnvironmentVariable("LADD_FETCH_URL");
        if (!string.IsNullOrWhiteSpace(fetchUrl))
        {
            _ = Task.Run(async () =>
            {
                while (true)
                {
                    try { await FetchOnce(fetchUrl); }
                    catch (Exception ex) { Console.Error.WriteLine("[LADD] fetch error: " + ex.Message); }
                    await Task.Delay(TimeSpan.FromHours(24));
                }
            });
        }

        // Reload periodically so a fresh monthly list is picked up without a restart.
        _ = Task.Run(async () =>
        {
            while (true)
            {
                await Task.Delay(TimeSpan.FromHours(6));
                Load();
            }
        });
    }

    /// <summary>Download the IndustryLADD file from LADD_FETCH_URL into the ladd dir,
    /// then reload. Credentials come from LADD_FETCH_COOKIE / LADD_FETCH_AUTH.</summary>
    private static async Task FetchOnce(string url)
    {
        using var req = new HttpRequestMessage(HttpMethod.Get, url);
        var cookie = Environment.GetEnvironmentVariable("LADD_FETCH_COOKIE");
        var auth = Environment.GetEnvironmentVariable("LADD_FETCH_AUTH");
        if (!string.IsNullOrWhiteSpace(cookie)) req.Headers.TryAddWithoutValidation("Cookie", cookie);
        if (!string.IsNullOrWhiteSpace(auth)) req.Headers.TryAddWithoutValidation("Authorization", auth);

        using var resp = await _http.SendAsync(req);
        resp.EnsureSuccessStatusCode();
        var body = await resp.Content.ReadAsStringAsync();

        // Guard against fetching an auth/login HTML page instead of the list.
        if (body.Length < 5 || body.Contains("<html", StringComparison.OrdinalIgnoreCase))
        {
            Console.Error.WriteLine("[LADD] fetch: response doesn't look like a LADD list " +
                "(login page / empty?) — keeping the existing file. Check LADD_FETCH_URL / credentials.");
            return;
        }

        var path = Path.Combine(_dir, "IndustryLADD.txt");
        var tmp = path + ".tmp";
        await File.WriteAllTextAsync(tmp, body);
        File.Move(tmp, path, overwrite: true);
        Console.WriteLine($"[LADD] fetched {body.Length} bytes → {path}");
        Load();
    }

    /// <summary>True if this call sign, registration, OR Mode S (ICAO 24-bit) address is
    /// on the LADD list and must be blocked. Cheap no-op (returns false) when no list is
    /// loaded. The IndustryLADD file lists aircraft by any of these identifiers — ~2/3 of
    /// its entries are hex Mode S addresses — so all three must be checked or blocked
    /// aircraft leak through when only their Mode S address is on the list.</summary>
    public static bool IsBlocked(string? callsign, string? registration, string? modeSCode = null)
    {
        if (_count == 0) return false;
        var set = _blocked;
        if (!string.IsNullOrEmpty(callsign) && set.Contains(Normalize(callsign))) return true;
        if (!string.IsNullOrEmpty(registration) && set.Contains(Normalize(registration))) return true;
        if (!string.IsNullOrEmpty(modeSCode) && set.Contains(Normalize(modeSCode))) return true;
        return false;
    }

    /// <summary>
    /// Load an explicit block list, for tests. Exists because the rule worth pinning is not
    /// <see cref="IsBlocked"/> itself — it is that each consumer OMITS a blocked aircraft rather
    /// than masking it, which cannot be tested without a loaded list. Callers must restore the
    /// empty list in a <c>finally</c>: this is process-global state.
    /// </summary>
    internal static void SetBlockedForTest(IEnumerable<string> ids)
    {
        var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var id in ids) set.Add(Normalize(id));
        _blocked = set;
        _count = set.Count;
    }

    /// <summary>Does this request carry the bypass key (query <c>?laddKey=</c>,
    /// header <c>X-LADD-Key</c>, or cookie <c>laddKey</c>)? Grants real identities.</summary>
    public static bool Reveal(HttpContext http) => Reveal(http, BypassKey);

    // Same, against an explicit key. Exists so the tests can pin the decision without calling
    // Init() and leaving BypassKey set for every other test in the run.
    internal static bool Reveal(HttpContext http, string? key)
    {
        if (string.IsNullOrEmpty(key)) return false;
        if (http.Request.Query.TryGetValue("laddKey", out var q) && q == key) return true;
        if (http.Request.Headers.TryGetValue("X-LADD-Key", out var h) && h == key) return true;
        if (http.Request.Cookies.TryGetValue("laddKey", out var c) && c == key) return true;
        return false;
    }

    /// <summary>
    /// May this request see <b>operator-only</b> material — the parts of the site that exist for
    /// whoever runs the deployment rather than for a visitor? Today that is the home page's
    /// SYSTEM group: per-feed throughput and lag, disk use and retention, process CPU / memory /
    /// client counts.
    ///
    /// <para>Deliberately the same gesture as the un-masked LADD view rather than a second
    /// login. There is one notion of "the operator" in this codebase — the <c>/login</c> sign-in
    /// that sets the <c>laddKey</c> cookie — and inventing a second one would mean two secrets to
    /// keep and two ways to be half signed in.</para>
    ///
    /// <para><b>Two widenings, both load-bearing.</b></para>
    ///
    /// <para><b>1. No LADD_BYPASS_KEY ⇒ open.</b> Without that key <see cref="Reveal"/> can never
    /// return true, so gating on it alone would hide this material from everyone — including the
    /// owner of a local or LAN deployment, with no way in. Same convention as
    /// <c>SWIM_GATE_HOST</c>: unset means no gate. A deployment that wants it private sets the
    /// key, and <c>Init</c> logs which of the two states is in effect.</para>
    ///
    /// <para><b>2. Loopback ⇒ open, but only when the request is unproxied.</b> This process sits
    /// behind a Cloudflare tunnel whose connector dials 127.0.0.1, and there is no
    /// <c>UseForwardedHeaders</c> in the pipeline — so <c>RemoteIpAddress</c> is loopback for
    /// every public request and testing it alone would make this whole gate a silent no-op.
    /// Requiring the absence of the proxy's own headers is what makes "local" mean local. It is
    /// worth having at all because <c>curl</c> against <c>/api/feed</c> on the box is the
    /// documented way to check feed health, and anyone who can do that can already read
    /// <c>.env</c>.</para>
    /// </summary>
    public static bool OperatorView(HttpContext http) => OperatorView(http, BypassKey);

    internal static bool OperatorView(HttpContext http, string? key)
    {
        if (Reveal(http, key)) return true;
        if (string.IsNullOrEmpty(key)) return true;   // no private view configured at all
        return IsLocalUnproxied(http);
    }

    /// <summary>
    /// 403 for a non-operator request, with a one-line body: these endpoints are checked by
    /// hand with <c>curl</c>, and an empty 403 reads as a bug rather than as a gate.
    /// </summary>
    public static IResult OperatorOnly() => Results.Json(
        new { error = "operator only", hint = "sign in at /login, or call from the host" },
        statusCode: 403);

    // Loopback AND nothing saying a proxy forwarded it. Either half on its own is worthless
    // here — see the remarks on OperatorView.
    private static readonly string[] ProxyHeaders =
    {
        "X-Forwarded-For", "X-Forwarded-Proto", "X-Forwarded-Host",
        "CF-Connecting-IP", "CF-Ray", "CF-Visitor", "X-Real-IP", "Forwarded",
    };

    private static bool IsLocalUnproxied(HttpContext http)
    {
        foreach (var h in ProxyHeaders)
            if (http.Request.Headers.ContainsKey(h)) return false;
        var ip = http.Connection.RemoteIpAddress;
        return ip is not null && System.Net.IPAddress.IsLoopback(ip);
    }

    /// <summary>The call sign to display: real when <paramref name="reveal"/>, else
    /// "LADD" if blocked, else the real call sign.</summary>
    public static string? MaskCallsign(string? callsign, string? registration, bool reveal, string? modeSCode = null)
        => reveal || !IsBlocked(callsign, registration, modeSCode) ? callsign : Label;

    /// <summary>Whether a (callsign, registration, Mode S) tuple should be masked for this reveal state.</summary>
    public static bool ShouldMask(string? callsign, string? registration, bool reveal, string? modeSCode = null)
        => !reveal && IsBlocked(callsign, registration, modeSCode);

    /// <summary>Validate reveal-login credentials for the secret "show me the real data"
    /// gesture. True only when the reveal feature is enabled (LADD_BYPASS_KEY set) AND the
    /// supplied password equals that key, OR it matches the private-gate username+password
    /// (SWIM_GATE_USER/PASS — the same login that fronts the site). The caller then stores
    /// the bypass key in an HttpOnly cookie, so the key never touches client JavaScript.</summary>
    public static bool ValidateReveal(string? user, string? pass)
    {
        var key = BypassKey;
        if (string.IsNullOrEmpty(key)) return false;                 // feature disabled
        if (!string.IsNullOrEmpty(pass) && pass == key) return true; // single-key form
        var gu = Environment.GetEnvironmentVariable("SWIM_GATE_USER");
        var gp = Environment.GetEnvironmentVariable("SWIM_GATE_PASS");
        return !string.IsNullOrWhiteSpace(gu) && !string.IsNullOrWhiteSpace(gp)
            && string.Equals(user, gu, StringComparison.OrdinalIgnoreCase) && pass == gp;
    }

    // Identifiers are matched case-insensitively with dashes/spaces removed, so the
    // list's "N123-AB" matches a feed's "N123AB" (and vice-versa).
    private static string Normalize(string s)
    {
        // Fast path: nothing to strip, so hand back the string we were given. The uppercasing is
        // redundant - every set this is looked up in uses OrdinalIgnoreCase - so a value with no
        // punctuation needs no new string at all, and SWIM callsigns, registrations and Mode S
        // codes almost never have any.
        //
        // This is not a micro-optimization: IsBlocked calls Normalize up to three times per
        // record, and the NAS fusion index runs it over ~26,000 records a pass. Measured, that
        // was ~2.5 MB of garbage every two seconds on a process already spending ~17% of its
        // time in GC. Every other caller (the /ws flight projection, each bridge's ToJson) gets
        // the same saving.
        var dirty = false;
        foreach (var c in s)
            if (c is '-' or ' ' or '.') { dirty = true; break; }
        if (!dirty) return s;

        Span<char> buf = stackalloc char[s.Length];
        int n = 0;
        foreach (var c in s)
            if (c is not ('-' or ' ' or '.')) buf[n++] = char.ToUpperInvariant(c);
        return new string(buf[..n]);
    }

    public static void Load()
    {
        try
        {
            if (!System.IO.Directory.Exists(_dir)) { WarnInactive(); return; }
            var files = System.IO.Directory.GetFiles(_dir, "*.txt")
                .Concat(System.IO.Directory.GetFiles(_dir, "*.csv"))
                .ToArray();
            if (files.Length == 0) { WarnInactive(); return; }

            var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var file in files)
            {
                foreach (var line in File.ReadLines(file))
                {
                    // The ADX list is essentially one identifier per line, but tolerate
                    // CSV/TSV by splitting on common delimiters and taking each token.
                    foreach (var tok in line.Split(new[] { ',', '\t', ';', '|', ' ' },
                             StringSplitOptions.RemoveEmptyEntries))
                    {
                        var t = Normalize(tok);
                        // Registrations/callsigns/flight numbers are 2–10 alphanumerics.
                        if (t.Length is < 2 or > 10) continue;
                        bool alnum = true;
                        foreach (var c in t) if (!char.IsLetterOrDigit(c)) { alnum = false; break; }
                        if (alnum) set.Add(t);
                    }
                }
            }

            _blocked = set;
            _count = set.Count;
            _loadedAt = DateTime.UtcNow;
            Console.WriteLine($"[LADD] Loaded {set.Count} blocked identifiers from {files.Length} file(s) in {_dir}");
            if (set.Count == 0) WarnInactive();
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[LADD] Load error: {ex.Message}");
        }
    }

    private static void WarnInactive()
    {
        _blocked = new(StringComparer.OrdinalIgnoreCase);
        _count = 0;
        Console.WriteLine($"[LADD] *** WARNING: no IndustryLADD list found in '{_dir}' — LADD filtering is INACTIVE. " +
            "Download IndustryLADD from https://adx.faa.gov and place it there to comply with the FAA SWIM Terms of Service. ***");
    }
}
