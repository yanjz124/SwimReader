using System.Globalization;

namespace SwimServer;

/// <summary>
/// In-memory cache of the NEXRAD WSR-88D station table. Source:
///   https://www.ncei.noaa.gov/access/homr/file/nexrad-stations.txt
/// We pull the file once on startup (refreshed every 24h) and parse the
/// fixed-width columns. The single-image NWS product endpoint we proxy uses
/// the 4-letter ICAO ID lower-cased:
///   https://tgftp.nws.noaa.gov/SL.us008001/DF.of/DC.radar/DS.{prod}/SI.{kxxx}/sn.last
///
/// "Nearest" lookup is a straight great-circle pick of the closest active
/// site to a given lat/lon — the STARS scope uses it to pre-select the
/// local radar for whichever TRACON the user has open.
/// </summary>
public sealed class NexradStations
{
    public sealed record Station(string Icao, string Name, string State, double Lat, double Lon, int ElevFt, string Type);

    Station[] _stations = Array.Empty<Station>();
    DateTime _loadedAt = DateTime.MinValue;
    static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(10) };
    const string SourceUrl = "https://www.ncei.noaa.gov/access/homr/file/nexrad-stations.txt";

    public IReadOnlyList<Station> All => _stations;
    public DateTime LoadedAt => _loadedAt;

    /// <summary>Refresh the table from NOAA. Safe to call repeatedly.</summary>
    public async Task RefreshAsync(CancellationToken ct = default)
    {
        try
        {
            var text = await Http.GetStringAsync(SourceUrl, ct);
            var parsed = Parse(text);
            if (parsed.Length > 0)
            {
                _stations = parsed;
                _loadedAt = DateTime.UtcNow;
                Console.WriteLine($"[NEXRAD] Loaded {parsed.Length} stations from NOAA");
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[NEXRAD] station load failed: {ex.GetType().Name}: {ex.Message}");
        }
    }

    static Station[] Parse(string text)
    {
        var rows = new List<Station>();
        foreach (var rawLine in text.Split('\n'))
        {
            var line = rawLine.TrimEnd('\r');
            // Header / divider / empty rows
            if (line.Length < 100) continue;
            if (line.StartsWith("NCDCID", StringComparison.OrdinalIgnoreCase)) continue;
            if (line.StartsWith("--")) continue;
            // Fixed-width columns from inspection of the divider row in the
            // live NOAA file (each column is [start, end), 0-based):
            //   NCDCID   [  0..  8)
            //   ICAO     [  9.. 13)
            //   WBAN     [ 14.. 19)
            //   NAME     [ 20.. 50)
            //   COUNTRY  [ 51.. 71)
            //   ST       [ 72.. 74)
            //   COUNTY   [ 75..105)
            //   LAT      [106..115)
            //   LON      [116..126)
            //   ELEV     [127..133)
            //   UTC      [134..139)
            //   STNTYPE  [140..190)
            // Previous offsets were off by ~5 which read garbage state/lat/lon
            // and made the "nearest" lookup return random TDWR sites.
            string col(int start, int len) => line.Length >= start + len ? line.Substring(start, len).Trim() : "";
            var icao = col(9, 4);
            var name = col(20, 30);
            var state = col(72, 2);
            var lat = col(106, 9);
            var lon = col(116, 10);
            var elev = col(127, 6);
            var type = col(140, 50);
            if (icao.Length != 4) continue;
            if (!double.TryParse(lat, NumberStyles.Float, CultureInfo.InvariantCulture, out var latD)) continue;
            if (!double.TryParse(lon, NumberStyles.Float, CultureInfo.InvariantCulture, out var lonD)) continue;
            int.TryParse(elev, NumberStyles.Integer, CultureInfo.InvariantCulture, out var elevI);
            // Drop the few non-NEXRAD entries (the file also contains TDWR + others).
            if (!type.Contains("NEXRAD", StringComparison.OrdinalIgnoreCase)
                && !type.Contains("TDWR", StringComparison.OrdinalIgnoreCase))
                continue;
            rows.Add(new Station(icao.ToUpperInvariant(), name, state, latD, lonD, elevI, type));
        }
        return rows.ToArray();
    }

    /// <summary>
    /// Nearest station to the given point. Prefers WSR-88D NEXRAD over TDWR
    /// by default since STARS scope range (usually 50-100nm) exceeds TDWR
    /// coverage (~50nm) and the WSR-88D 248nm sweep matches the imagery
    /// the rest of the page is built around. Pass <paramref name="preferNexrad"/>=false
    /// to allow TDWR if it's truly the closer site (used by a "near terminal"
    /// product mode someday). Returns null only if the table is empty.
    /// </summary>
    public Station? Nearest(double lat, double lon, bool preferNexrad = true)
    {
        if (_stations.Length == 0) return null;
        Station? best = null;
        double bestD = double.MaxValue;
        foreach (var s in _stations)
        {
            // Skip TDWRs in the default mode.
            if (preferNexrad && s.Type.Contains("TDWR", StringComparison.OrdinalIgnoreCase)) continue;
            // Squared planar distance is fine for "nearest of ~150 sites in CONUS".
            var dx = s.Lon - lon;
            var dy = s.Lat - lat;
            var d = dx * dx + dy * dy;
            if (d < bestD) { bestD = d; best = s; }
        }
        // If preferNexrad excluded everything (unlikely with NOAA's table), fall back.
        if (best is null && preferNexrad) return Nearest(lat, lon, preferNexrad: false);
        return best;
    }
}
