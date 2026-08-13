using SwimReader.Server.Ca;

namespace SwimReader.Server.Msaw;

/// <summary>
/// Ported byte-faithful from DGScope's MSAWVolume.cs. A polygon or circle volume with a vertical
/// band [Floor, Ceiling); Ceiling doubles as the minimum safe altitude. Deserialized directly from
/// the profile XML's &lt;MSAWVolume&gt; elements (property names match DGScope).
/// </summary>
public class MSAWVolume
{
    public string? Name { get; set; }
    public bool Active { get; set; } = true;
    public bool Draw { get; set; }
    public int Floor { get; set; }
    public int Ceiling { get; set; }
    public List<GeoPoint> Points { get; set; } = new();
    public GeoPoint? Center { get; set; }
    public double Radius { get; set; }

    /// <summary>True if the given location is within this volume's horizontal footprint.</summary>
    public bool ContainsLocation(GeoPoint location)
    {
        if (location == null)
            return false;
        if (Radius > 0 && Center != null)
            return location.DistanceTo(Center) <= Radius;
        // Ray-casting point-in-polygon (handles the closing edge via the j=i++ wrap).
        if (Points == null || Points.Count < 3)
            return false;
        bool inside = false;
        int n = Points.Count;
        for (int i = 0, j = n - 1; i < n; j = i++)
        {
            double xi = Points[i].Longitude, yi = Points[i].Latitude;
            double xj = Points[j].Longitude, yj = Points[j].Latitude;
            bool intersect = ((yi > location.Latitude) != (yj > location.Latitude)) &&
                (location.Longitude < (xj - xi) * (location.Latitude - yi) / (yj - yi) + xi);
            if (intersect)
                inside = !inside;
        }
        return inside;
    }

    public override string ToString() => Name ?? "";
}
