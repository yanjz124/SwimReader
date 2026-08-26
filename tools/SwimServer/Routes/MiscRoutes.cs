namespace SwimServer;

/// <summary>
/// Miscellaneous endpoints that don't fit a feature group:
///   - /api/nexrad/tile  (NEXRAD tile proxy through ctx.NexradHttp so canvas pixel manipulation works without CORS)
///   - /api/metar/{station}  (live METAR fetch from aviationweather.gov)
///   - /api/kml + /api/kml/{name}  (KML overlay file listing/serving from repo root)
/// </summary>
static class MiscRoutes
{
    public static void Register(WebApplication app, ServerContext ctx)
    {
        // NEXRAD tile proxy — serves IEM tiles from same origin so canvas pixel manipulation works (no CORS)
        app.MapGet("/api/nexrad/tile", async (int z, int x, int y) =>
        {
            try
            {
                var url = $"https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/ridge::USCOMP-N0Q-0/{z}/{x}/{y}.png";
                var bytes = await ctx.NexradHttp.GetByteArrayAsync(url);
                return Results.Bytes(bytes, "image/png");
            }
            catch
            {
                return Results.StatusCode(502);
            }
        });

        // CARTO basemap tile proxy — served same-origin so the CARTO API key lives ONLY in the
        // server's .env (CARTO_API_KEY), never in the committed frontend or the browser. Appends the
        // key and caches hard (7 days) so browsers / Cloudflare serve most tiles without hitting the
        // Pi. Frontends use /basemap/{style}/{z}/{x}/{y}{r}.png instead of *.basemaps.cartocdn.com.
        var cartoKey = Environment.GetEnvironmentVariable("CARTO_API_KEY");
        app.MapGet("/basemap/{**path}", async (string path, HttpContext http) =>
        {
            if (string.IsNullOrEmpty(path) || path.Contains("..")
                || !path.EndsWith(".png", StringComparison.OrdinalIgnoreCase))
                return Results.NotFound();
            var url = string.IsNullOrEmpty(cartoKey)
                ? $"https://basemaps.cartocdn.com/{path}"
                : $"https://basemaps.cartocdn.com/{path}?key={cartoKey}";
            try
            {
                var bytes = await ctx.NexradHttp.GetByteArrayAsync(url);
                http.Response.Headers.CacheControl = "public, max-age=604800, immutable";
                return Results.Bytes(bytes, "image/png");
            }
            catch { return Results.StatusCode(502); }
        });

        // Live METAR fetch
        app.MapGet("/api/metar/{station}", async (string station) =>
        {
            station = station.ToUpperInvariant();
            if (station.Length == 3) station = "K" + station;
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
            try
            {
                var resp = await http.GetAsync($"https://aviationweather.gov/api/data/metar?ids={Uri.EscapeDataString(station)}");
                if (!resp.IsSuccessStatusCode) return Results.StatusCode((int)resp.StatusCode);
                var text = (await resp.Content.ReadAsStringAsync()).Trim();
                if (string.IsNullOrEmpty(text)) return Results.NotFound();
                return Results.Text(text);
            }
            catch { return Results.StatusCode(502); }
        });

        // KML overlay files served from repo root (gitignored, see CLAUDE.md)
        app.MapGet("/api/kml", () =>
        {
            var files = Directory.GetFiles(ctx.RepoRoot, "*.kml").Select(Path.GetFileName).ToArray();
            return Results.Json(files, ctx.JsonOpts);
        });

        app.MapGet("/api/kml/{name}", (string name) =>
        {
            if (!name.EndsWith(".kml")) name += ".kml";
            name = Path.GetFileName(name); // prevent path traversal
            var path = Path.Combine(ctx.RepoRoot, name);
            if (!File.Exists(path)) return Results.NotFound();
            return Results.File(path, "application/vnd.google-earth.kml+xml");
        });

        // ── Operator sign-in (private view) ─────────────────────────────────────
        // Reached either by the client's unlabeled 5-tap gesture or by typing /login. Both
        // navigate here so the NATIVE browser credential dialog appears — the browser owns all
        // the text, nothing on screen says what it is for, and the URL is generic. Valid creds
        // set an HttpOnly cookie that LaddService.Reveal() reads to serve this browser the
        // un-masked view. Absent/wrong creds (or the feature being off) all look identical:
        // another 401 dialog, so the feature isn't discoverable by probing.
        app.MapGet("/login", LoginHandler);
        app.MapGet("/api/login", LoginHandler);

        app.MapPost("/api/logout", (HttpContext http) =>
        {
            http.Response.Cookies.Delete("laddKey", new CookieOptions { Path = "/" });
            http.Response.Cookies.Delete("sv", new CookieOptions { Path = "/" });
            return Results.Json(new { ok = true });
        });
    }

    private static async Task LoginHandler(HttpContext http)
    {
        string? u = null, p = null;
        var hdr = http.Request.Headers["Authorization"].ToString();
        if (hdr.StartsWith("Basic ", StringComparison.OrdinalIgnoreCase))
        {
            try
            {
                var dec = System.Text.Encoding.UTF8.GetString(Convert.FromBase64String(hdr[6..].Trim()));
                var i = dec.IndexOf(':');
                if (i >= 0) { u = dec[..i]; p = dec[(i + 1)..]; }
            }
            catch { /* malformed header ⇒ treated as no creds */ }
        }

        // Local return path only (guards against open redirect).
        var back = http.Request.Query["r"].ToString();
        if (string.IsNullOrEmpty(back) || !back.StartsWith('/') || back.StartsWith("//")) back = "/";

        if (string.IsNullOrEmpty(LaddService.BypassKey) || !LaddService.ValidateReveal(u, p))
        {
            http.Response.StatusCode = 401;
            http.Response.Headers["WWW-Authenticate"] = "Basic realm=\"Login\"";
            // If the visitor cancels the dialog, bounce back instead of showing a blank 401.
            http.Response.ContentType = "text/html";
            await http.Response.WriteAsync(
                $"<meta http-equiv=\"refresh\" content=\"0;url={System.Net.WebUtility.HtmlEncode(back)}\">");
            return;
        }

        var secure = http.Request.IsHttps;
        http.Response.Cookies.Append("laddKey", LaddService.BypassKey!, new CookieOptions
        {
            HttpOnly = true, Secure = secure, SameSite = SameSiteMode.Lax,
            Expires = DateTimeOffset.UtcNow.AddDays(30), Path = "/",
        });
        // Neutral, non-secret flag the UI reads to show the "exit" chip.
        http.Response.Cookies.Append("sv", "1", new CookieOptions
        {
            HttpOnly = false, Secure = secure, SameSite = SameSiteMode.Lax,
            Expires = DateTimeOffset.UtcNow.AddDays(30), Path = "/",
        });
        http.Response.Redirect(back);
    }
}
