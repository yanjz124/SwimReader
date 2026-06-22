using System.Collections.Concurrent;

namespace SwimServer;

/// <summary>
/// STARS NEXRAD endpoints — list of stations + per-station product image proxy.
/// We proxy the NWS single-radar GIF so the browser can pull pixels via
/// canvas.getImageData() without CORS getting in the way.
///
/// Product codes from tgftp.nws.noaa.gov (subset; the rest are easy to add):
///   p94r0  Base Reflectivity Tilt 1 (0.5° cut, 248nm range)
///   p38cr  Composite Reflectivity (max-of-all-tilts)
///   p19r0  Storm Total Precipitation
///   p27v0  Base Velocity
///
/// URL template:
///   https://tgftp.nws.noaa.gov/SL.us008001/DF.of/DC.radar/DS.{prod}/SI.{kxxx}/sn.last
/// </summary>
static class NexradStarsRoutes
{
    // Allow-list of products so a malicious client can't proxy arbitrary URLs.
    static readonly HashSet<string> Allowed = new(StringComparer.OrdinalIgnoreCase)
    {
        "p94r0",   // Base Reflectivity
        "p38cr",   // Composite Reflectivity
        "p19r0",   // Storm Total Precipitation
        "p27v0",   // Base Velocity
        "p20-r",   // 0.5deg reflectivity (newer 256-level)
        "p25-r",
        "p37cr",
    };

    record CacheEntry(byte[] Bytes, DateTime At, string ContentType);
    static readonly ConcurrentDictionary<string, CacheEntry> _cache = new();
    static readonly TimeSpan Ttl = TimeSpan.FromMinutes(4);   // NWS updates every ~4-10 min
    static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(15) };

    public static void Register(WebApplication app, ServerContext ctx)
    {
        // The station table is owned by the server context (see Program.cs
        // hookup). On first GET we trigger a refresh if it's never been loaded.
        app.MapGet("/api/stars/nexrad/stations", async () =>
        {
            if (ctx.NexradStations.LoadedAt == DateTime.MinValue)
                await ctx.NexradStations.RefreshAsync();
            return Results.Json(new
            {
                loadedAt = ctx.NexradStations.LoadedAt.ToString("o"),
                count    = ctx.NexradStations.All.Count,
                stations = ctx.NexradStations.All.Select(s => new {
                    icao = s.Icao, name = s.Name, state = s.State,
                    lat = s.Lat, lon = s.Lon, elevFt = s.ElevFt, type = s.Type
                }).ToArray(),
            }, ctx.JsonOpts);
        });

        // Nearest station to a given point.
        app.MapGet("/api/stars/nexrad/nearest", async (double lat, double lon) =>
        {
            if (ctx.NexradStations.LoadedAt == DateTime.MinValue)
                await ctx.NexradStations.RefreshAsync();
            var s = ctx.NexradStations.Nearest(lat, lon);
            if (s is null) return Results.NotFound();
            return Results.Json(new
            {
                icao = s.Icao, name = s.Name, state = s.State,
                lat = s.Lat, lon = s.Lon, elevFt = s.ElevFt, type = s.Type,
            }, ctx.JsonOpts);
        });

        // Image proxy. The NWS image is a small GIF with a known palette;
        // we serve the bytes verbatim so the client can canvas-decode them.
        app.MapGet("/api/stars/nexrad/image/{station}/{product}", async (string station, string product) =>
        {
            station = station.ToUpperInvariant();
            product = product.ToLowerInvariant();
            if (station.Length != 4 || !Allowed.Contains(product))
                return Results.BadRequest("bad station or product");

            var cacheKey = $"{station}:{product}";
            if (_cache.TryGetValue(cacheKey, out var e) && DateTime.UtcNow - e.At < Ttl)
                return Results.Bytes(e.Bytes, e.ContentType);

            var url = $"https://tgftp.nws.noaa.gov/SL.us008001/DF.of/DC.radar/DS.{product}/SI.{station.ToLowerInvariant()}/sn.last";
            try
            {
                using var resp = await Http.GetAsync(url);
                if (!resp.IsSuccessStatusCode) return Results.StatusCode((int)resp.StatusCode);
                var bytes = await resp.Content.ReadAsByteArrayAsync();
                var ct = resp.Content.Headers.ContentType?.MediaType ?? "image/gif";
                _cache[cacheKey] = new CacheEntry(bytes, DateTime.UtcNow, ct);
                return Results.Bytes(bytes, ct);
            }
            catch
            {
                // If a fetch fails but we have a previous cached image, serve that
                // (stale-while-error) so weather doesn't disappear from the scope.
                if (e is not null) return Results.Bytes(e.Bytes, e.ContentType);
                return Results.StatusCode(502);
            }
        });
    }
}
