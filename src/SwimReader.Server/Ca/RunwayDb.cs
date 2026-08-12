using System.Globalization;

namespace SwimReader.Server.Ca;

/// <summary>One runway landing end: threshold position, landing heading, field elevation.</summary>
public readonly record struct RunwayEnd(string Apt, string Ident, double Lat, double Lon, int Elev, double Hdg);

/// <summary>
/// Loads the bundled OurAirports runway DB (trimmed to one record per landing end) and builds
/// DGScope <see cref="CASuppressionVolume"/> final-approach corridors on demand. DGScope loads these
/// from the facility profile XML; most watched facilities have no profile yet, so we auto-generate a
/// corridor per runway end near the facility so CA stops false-triggering on sequenced/parallel finals.
/// A 1° lat/lon grid keeps bounding-box queries cheap.
/// </summary>
public sealed class RunwayDb
{
    private readonly Dictionary<(int, int), List<RunwayEnd>> _grid = new();
    public int Count { get; private set; }

    private static (int, int) Cell(double lat, double lon) => ((int)Math.Floor(lat), (int)Math.Floor(lon));

    public static RunwayDb Load(string csvPath)
    {
        var db = new RunwayDb();
        if (!File.Exists(csvPath)) return db;
        using var sr = new StreamReader(csvPath);
        sr.ReadLine(); // header: apt,ident,lat,lon,elev,hdg
        string? line;
        while ((line = sr.ReadLine()) != null)
        {
            var p = line.Split(',');
            if (p.Length < 6) continue;
            if (!double.TryParse(p[2], NumberStyles.Float, CultureInfo.InvariantCulture, out var lat)) continue;
            if (!double.TryParse(p[3], NumberStyles.Float, CultureInfo.InvariantCulture, out var lon)) continue;
            int.TryParse(p[4], NumberStyles.Integer, CultureInfo.InvariantCulture, out var elev);
            if (!double.TryParse(p[5], NumberStyles.Float, CultureInfo.InvariantCulture, out var hdg)) continue;
            var end = new RunwayEnd(p[0], p[1], lat, lon, elev, hdg);
            var cell = Cell(lat, lon);
            if (!db._grid.TryGetValue(cell, out var list)) db._grid[cell] = list = new List<RunwayEnd>();
            list.Add(end);
            db.Count++;
        }
        return db;
    }

    /// <summary>All runway ends whose threshold falls in the (inclusive) lat/lon box.</summary>
    public List<RunwayEnd> EndsInBox(double minLat, double minLon, double maxLat, double maxLon)
    {
        var result = new List<RunwayEnd>();
        for (int la = (int)Math.Floor(minLat); la <= (int)Math.Floor(maxLat); la++)
            for (int lo = (int)Math.Floor(minLon); lo <= (int)Math.Floor(maxLon); lo++)
                if (_grid.TryGetValue((la, lo), out var list))
                    foreach (var e in list)
                        if (e.Lat >= minLat && e.Lat <= maxLat && e.Lon >= minLon && e.Lon <= maxLon)
                            result.Add(e);
        return result;
    }

    /// <summary>Build faithful CA suppression corridors (DGScope defaults) for the box.</summary>
    public List<CASuppressionVolume> VolumesInBox(double minLat, double minLon, double maxLat, double maxLon)
    {
        var vols = new List<CASuppressionVolume>();
        foreach (var e in EndsInBox(minLat, minLon, maxLat, maxLon))
        {
            vols.Add(new CASuppressionVolume
            {
                Name = $"{e.Apt} {e.Ident}",
                Active = true,
                RunwayThreshold = new GeoPoint(e.Lat, e.Lon),
                TrueHeading = (int)Math.Round(e.Hdg),
                Length = 30,
                HalfWidth = 2,
                FieldElevation = e.Elev,
                GlideslopeAngle = 3.0,
                HeightAboveGlideslope = 1500,
            });
        }
        return vols;
    }
}
