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
            // Fixed-width columns from inspection of the header:
            //   NCDCID (8) ICAO(4) WBAN(5) NAME(30) COUNTRY(20) ST(2) COUNTY(30)
            //   LAT(9) LON(10) ELEV(6) UTC(5) STNTYPE(50)
            // Offsets are stable so we slice; whitespace-pad survives this.
            string col(int start, int len) => line.Length >= start + len ? line.Substring(start, len).Trim() : "";
            var icao = col(9, 4);
            var name = col(15, 30);
            var state = col(67, 2);
            var lat = col(101, 9);
            var lon = col(111, 10);
            var elev = col(122, 6);
            var type = col(135, 50);
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

    /// <summary>Nearest station to the given point. Returns null only if the table is empty.</summary>
    public Station? Nearest(double lat, double lon)
    {
        if (_stations.Length == 0) return null;
        Station? best = null;
        double bestD = double.MaxValue;
        foreach (var s in _stations)
        {
            // Squared planar distance is fine for "nearest of ~150 sites in CONUS".
            var dx = s.Lon - lon;
            var dy = s.Lat - lat;
            var d = dx * dx + dy * dy;
            if (d < bestD) { bestD = d; best = s; }
        }
        return best;
    }
}
