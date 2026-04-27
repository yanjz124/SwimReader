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
    }
}
