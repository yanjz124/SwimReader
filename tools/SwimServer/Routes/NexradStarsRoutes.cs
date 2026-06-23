using System.Collections.Concurrent;
using NexradDecoder;

namespace SwimServer;

/// <summary>
/// STARS NEXRAD endpoints. The previous implementation proxied tgftp's raw
/// NIDS bytes to the browser and tried to read a rendered RIDGE GIF to
/// reverse-engineer dBZ — both wrong vs DGScope.
///
/// DGScope (NexradDisplay.cs:60-95 + RecomputeVertices :125-193) downloads
/// the same tgftp NIDS file but DECODES it with the NexradDecoder library
/// (RadialPacketDecoder). It then generates one Polygon per radial × bin
/// where dBZ > 0, looks up colour via WXColorTable, and renders polygons.
///
/// We do the same here: server fetches NIDS, decodes radials, and ships
/// the radial structure to the client as JSON. The client mirrors
/// RecomputeVertices's polygon loop in canvas, using the same DGScope
/// default ColorTable (NexradDisplay.cs:127-138).
///
/// Product codes:
///   p94r0  Base Reflectivity Tilt 1 (0.5°, 248nm range)  → range 248
///   p180   (legacy 48nm)                                  → range 48
/// </summary>
static class NexradStarsRoutes
{
    static readonly HashSet<string> Allowed = new(StringComparer.OrdinalIgnoreCase)
    {
        "p94r0",   // Base Reflectivity (0.5°)
        "p38cr",   // Composite Reflectivity (max-of-all-tilts)
    };

    record CacheEntry(object Payload, DateTime At);
    static readonly ConcurrentDictionary<string, CacheEntry> _cache = new();
    static readonly TimeSpan Ttl = TimeSpan.FromMinutes(4);   // NWS publishes every ~4-10 min
    static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(15) };

    public static void Register(WebApplication app, ServerContext ctx)
    {
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

        // Decode tgftp NIDS → radials JSON, mirroring DGScope's
        // NexradDisplay.GetRadarData + RecomputeVertices NWSNexrad branch
        // (.stars-reference/scope/NexradDisplay.cs:66-193).
        app.MapGet("/api/stars/nexrad/radials/{station}/{product}", async (string station, string product) =>
        {
            station = station.ToUpperInvariant();
            product = product.ToLowerInvariant();
            if (station.Length != 4 || !Allowed.Contains(product))
                return Results.BadRequest("bad station or product");

            var cacheKey = $"{station}:{product}";
            if (_cache.TryGetValue(cacheKey, out var e) && DateTime.UtcNow - e.At < Ttl)
                return Results.Json(e.Payload, ctx.JsonOpts);

            // tgftp serves the raw NIDS file at sn.last — the same URL
            // DGScope's NexradDisplay.URL (NexradDisplay.cs:42) points at.
            var url = $"https://tgftp.nws.noaa.gov/SL.us008001/DF.of/DC.radar/DS.{product}/SI.{station.ToLowerInvariant()}/sn.last";
            try
            {
                using var resp = await Http.GetAsync(url);
                if (!resp.IsSuccessStatusCode) return Results.StatusCode((int)resp.StatusCode);
                var bytes = await resp.Content.ReadAsByteArrayAsync();

                // Mirror NexradDisplay.GetRadarData (cs:66-95) verbatim.
                // IMPORTANT: NexradDecoder's BZip2 path (NexradDecoder.cs:407-419)
                // writes decompressed Symbology data BACK into the input stream
                // via `inputStream.CopyTo(fs)`. That requires the stream to be
                // expandable — `new MemoryStream(byte[])` is fixed-size and
                // throws "Memory stream is not expandable" on the CopyTo.
                // Use the default ctor + Write so the capacity can grow.
                var decoder = new RadialPacketDecoder();
                using var ms = new MemoryStream();
                ms.Write(bytes, 0, bytes.Length);
                ms.Position = 0;
                decoder.setStreamResource(ms);
                decoder.parseMHB();
                var description = decoder.parsePDB();
                var symbology   = (RadialSymbologyBlock)decoder.parsePSB();

                // RecomputeVertices NWSNexrad branch (cs:150-192).
                int range = description.Code switch
                {
                    94  => 248,
                    180 =>  48,
                    _   => 248,                         // unknown code → assume max
                };
                // scanrange = range * cos(ProductSpecific_3 deg) (cs:164)
                double scanrange  = range * Math.Cos(description.ProductSpecific_3 * (Math.PI / 180));
                double resolution = scanrange / symbology.LayerNumberOfRangeBins;

                // Strip per-radial: startAngle, angleDelta, values[]. We
                // SKIP bins whose dBZ value is 0 server-side — saves a
                // significant chunk of payload (typical scan is 90%+ zero).
                var radials = new object[symbology.NumberOfRadials];
                for (int i = 0; i < symbology.NumberOfRadials; i++)
                {
                    var r = symbology.Radials[i];
                    // Pack as parallel arrays of bin-index + value for
                    // compactness vs a sparse [0,0,0,12,0,0,...] array.
                    var bins   = new List<int>(r.Values.Length / 8);
                    var values = new List<double>(r.Values.Length / 8);
                    for (int j = 0; j < r.Values.Length; j++)
                    {
                        if (r.Values[j] <= 0) continue;
                        bins.Add(j);
                        values.Add(r.Values[j]);
                    }
                    radials[i] = new {
                        startAngle = r.StartAngle,
                        angleDelta = r.AngleDelta,
                        bins, values,
                    };
                }

                var payload = new
                {
                    radarLat   = description.Latitude,
                    radarLon   = description.Longitude,
                    range,
                    scanrange,
                    resolution,                          // NM per bin
                    numRadials = symbology.NumberOfRadials,
                    numBins    = symbology.LayerNumberOfRangeBins,
                    radials,
                };
                _cache[cacheKey] = new CacheEntry(payload, DateTime.UtcNow);
                return Results.Json(payload, ctx.JsonOpts);
            }
            catch (Exception ex)
            {
                if (e is not null) return Results.Json(e.Payload, ctx.JsonOpts);   // stale-while-error
                return Results.Problem($"nexrad decode failed: {ex.Message}", statusCode: 502);
            }
        });
    }
}
