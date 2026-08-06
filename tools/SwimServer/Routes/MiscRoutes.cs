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

        // ── LADD reveal ("show the real data behind the mask") ──────────────────
        // A private, UNADVERTISED un-mask for the operator: the frontend's secret
        // 5-click-in-the-footer gesture prompts for the login and POSTs it here. On success
        // we drop the bypass key into an HttpOnly cookie (so it never appears in page JS /
        // inspect element) plus a readable "laddRevealed" flag so the UI can show its state.
        // LaddService.Reveal() then un-masks every response for this browser. There is
        // deliberately NO status endpoint and NO distinct "feature disabled" response — a
        // failed attempt looks identical whether the key is unset or the login is wrong, so
        // the feature's existence isn't discoverable by probing.

        app.MapPost("/api/ladd/reveal", async (HttpContext http) =>
        {
            RevealBody? body;
            try { body = await http.Request.ReadFromJsonAsync<RevealBody>(); }
            catch { return Results.Json(new { ok = false, error = "invalid login" }, statusCode: 401); }

            // Uniform failure (disabled OR bad creds) — never reveal which.
            if (string.IsNullOrEmpty(LaddService.BypassKey) || !LaddService.ValidateReveal(body?.user, body?.pass))
                return Results.Json(new { ok = false, error = "invalid login" }, statusCode: 401);

            var opts = new CookieOptions
            {
                HttpOnly = true,                       // key not readable by JavaScript
                Secure = http.Request.IsHttps,         // https-only when behind the tunnel
                SameSite = SameSiteMode.Lax,
                Expires = DateTimeOffset.UtcNow.AddDays(30),
                Path = "/",
            };
            http.Response.Cookies.Append("laddKey", LaddService.BypassKey!, opts);
            // Non-secret companion flag the UI can read to show "revealed" state.
            http.Response.Cookies.Append("laddRevealed", "1", new CookieOptions
            {
                HttpOnly = false,
                Secure = http.Request.IsHttps,
                SameSite = SameSiteMode.Lax,
                Expires = DateTimeOffset.UtcNow.AddDays(30),
                Path = "/",
            });
            return Results.Json(new { ok = true });
        });

        app.MapPost("/api/ladd/hide", (HttpContext http) =>
        {
            http.Response.Cookies.Delete("laddKey", new CookieOptions { Path = "/" });
            http.Response.Cookies.Delete("laddRevealed", new CookieOptions { Path = "/" });
            return Results.Json(new { ok = true });
        });
    }

    private record RevealBody(string? user, string? pass);
}
