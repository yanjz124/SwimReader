using System.Collections.Concurrent;
using System.Globalization;
using System.Text.RegularExpressions;
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
/// where dBZ > 0, looks up color via WXColorTable, and renders polygons.
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

    // ── Historical weather, for replay ───────────────────────────────────
    // Unidata mirrors the NEXRAD Level III (NIDS) feed to a public S3 bucket going back to 2015,
    // keyed `{SITE}_{PROD}_{yyyy}_{MM}_{dd}_{HH}_{mm}_{ss}` with SITE the 3-letter id (KDMX -> DMX,
    // PAHG -> AHG, TJUA -> JUA). Those files are byte-for-byte what tgftp serves live - same 30-byte
    // WMO header, same message/description/symbology blocks - so everything below decodes them
    // unchanged and we store no weather of our own.
    //
    // The product NAMES differ, because the archive carries the super-res set that replaced the ones
    // tgftp still publishes under the old names: N0B (code 153) is the 0.5 deg reflectivity in place
    // of N0Q/p94r0, and NCR (code 37, 124nm) is the composite in place of product 38 (248nm).
    static readonly Dictionary<string, string> ArchiveProduct = new(StringComparer.OrdinalIgnoreCase)
    {
        ["p94r0"] = "N0B",
        ["p38cr"] = "NCR",
    };
    const string Bucket = "https://unidata-nexrad-level3.s3.amazonaws.com";

    record CacheEntry(object Payload, DateTime At);
    static readonly ConcurrentDictionary<string, CacheEntry> _cache = new();
    static readonly TimeSpan Ttl = TimeSpan.FromMinutes(4);   // NWS publishes every ~4-10 min
    static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(15) };

    // A decoded super-res volume is a big object (720 radials x ~1800 bins), and replay invents a
    // new cache key for every volume it scrubs past, so this has to be bounded - memory on the Pi
    // is the scarce thing. Re-resolving an evicted volume is one cheap S3 GET.
    static void Remember(string key, object payload)
    {
        _cache[key] = new CacheEntry(payload, DateTime.UtcNow);
        if (_cache.Count <= 12) return;
        foreach (var k in _cache.OrderBy(kv => kv.Value.At).Take(_cache.Count - 8)
                                .Select(kv => kv.Key).ToList())
            _cache.TryRemove(k, out _);
    }

    record ListEntry(string[] Keys, DateTime At);
    static readonly ConcurrentDictionary<string, ListEntry> _lists = new();
    static readonly TimeSpan ListTtl = TimeSpan.FromMinutes(2);

    static async Task<string[]> ListKeys(string prefix)
    {
        if (_lists.TryGetValue(prefix, out var l) && DateTime.UtcNow - l.At < ListTtl)
            return l.Keys;
        var xml = await Http.GetStringAsync(
            $"{Bucket}/?list-type=2&prefix={Uri.EscapeDataString(prefix)}&max-keys=1000");
        var keys = Regex.Matches(xml, "<Key>([^<]+)</Key>")
                        .Select(m => m.Groups[1].Value).ToArray();
        _lists[prefix] = new ListEntry(keys, DateTime.UtcNow);
        if (_lists.Count > 256)
            foreach (var k in _lists.OrderBy(kv => kv.Value.At).Take(128)
                                    .Select(kv => kv.Key).ToList())
                _lists.TryRemove(k, out _);
        return keys;
    }

    static DateTime? KeyTime(string key)
    {
        // SITE_PROD_yyyy_MM_dd_HH_mm_ss - skip the two leading fields.
        var i = key.IndexOf('_');
        var j = i < 0 ? -1 : key.IndexOf('_', i + 1);
        if (j < 0) return null;
        return DateTime.TryParseExact(key[(j + 1)..], "yyyy_MM_dd_HH_mm_ss",
                   CultureInfo.InvariantCulture,
                   DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var t)
               ? t : null;
    }

    // Newest volume at or before t. Keys sort lexicographically in time order, so this is a prefix
    // list plus a scan. We look at t's hour AND the one before: at 15:01 the right answer is often a
    // 14:58 volume, and in clear-air mode (one volume per ~10 min) that gap is routine.
    static async Task<string?> FindArchiveKey(string site, string prod, DateTime t)
    {
        for (int back = 0; back < 2; back++)
        {
            string? best = null;
            foreach (var k in await ListKeys($"{site}_{prod}_{t.AddHours(-back):yyyy_MM_dd_HH}"))
                if (KeyTime(k) is DateTime kt && kt <= t &&
                    (best is null || string.CompareOrdinal(k, best) > 0))
                    best = k;
            if (best is not null) return best;
        }
        return null;
    }

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
        // `time` (optional, ISO-8601) asks for the volume that was current then, out of Unidata's
        // archive, instead of the latest one. Replay passes its clock here; without it the overlay
        // draws live weather under archived traffic, which is the one thing a replay must not do.
        app.MapGet("/api/stars/nexrad/radials/{station}/{product}", async (string station, string product, string? time) =>
        {
            station = station.ToUpperInvariant();
            product = product.ToLowerInvariant();
            if (station.Length != 4 || !Allowed.Contains(product))
                return Results.BadRequest("bad station or product");

            DateTime? at = null;
            if (!string.IsNullOrWhiteSpace(time))
            {
                if (!DateTime.TryParse(time, CultureInfo.InvariantCulture,
                        DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var parsed))
                    return Results.BadRequest("bad time");
                at = parsed;
            }

            string url, cacheKey;
            string? archiveKey = null;
            if (at is DateTime t)
            {
                if (!ArchiveProduct.TryGetValue(product, out var ap))
                    return Results.BadRequest("product has no archive equivalent");
                // Bucket keys use the 3-letter site id, ours is the 4-letter ICAO.
                archiveKey = await FindArchiveKey(station[1..], ap, t);
                if (archiveKey is null)
                    return Results.Json(new { error = $"no archived {ap} volume for {station} at or before {t:yyyy-MM-ddTHH:mm:ss}Z" },
                                        ctx.JsonOpts, statusCode: 404);
                url      = $"{Bucket}/{archiveKey}";
                cacheKey = archiveKey;     // a resolved volume is immutable, so it never goes stale
            }
            else
            {
                // tgftp serves the raw NIDS file at sn.last — the same URL
                // DGScope's NexradDisplay.URL (NexradDisplay.cs:42) points at.
                url      = $"https://tgftp.nws.noaa.gov/SL.us008001/DF.of/DC.radar/DS.{product}/SI.{station.ToLowerInvariant()}/sn.last";
                cacheKey = $"{station}:{product}";
            }

            if (_cache.TryGetValue(cacheKey, out var e) &&
                (archiveKey is not null || DateTime.UtcNow - e.At < Ttl))
                return Results.Json(e.Payload, ctx.JsonOpts);

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
                    94  => 248,                         // N0Q  base reflectivity      (live p94r0)
                    153 => 248,                         // N0B  super-res base refl    (archive)
                    38  => 248,                         // NCZ  composite reflectivity (live p38cr)
                    37  => 124,                         // NCR  composite reflectivity (archive)
                    180 =>  48,                         // legacy TDWR 48nm
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
                    // Which volume this actually is, so a replay can be checked against its clock
                    // rather than taken on trust.
                    code       = description.Code,
                    volumeTime = description.ScanTime == default
                                 ? null : description.ScanTime.ToString("yyyy-MM-ddTHH:mm:ss'Z'"),
                    archived   = archiveKey is not null,
                    radials,
                };
                Remember(cacheKey, payload);
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
