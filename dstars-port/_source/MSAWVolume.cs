using System.Collections.Generic;
using System.ComponentModel;

namespace DGScope
{
    public class MSAWVolume
    {
        [DisplayName("Name"), Category("Identity")]
        public string Name { get; set; }
        [DisplayName("Active"), Category("Identity")]
        public bool Active { get; set; } = true;
        [Description("Draw the volume on the scope, for testing purposes."), Category("Identity")]
        public bool Draw { get; set; }
        [DisplayName("Floor (ft MSL)"), Category("Geometry")]
        public int Floor { get; set; }
        [DisplayName("Ceiling / Minimum Safe Altitude (ft MSL)"), Category("Geometry")]
        public int Ceiling { get; set; }
        [DisplayName("Polygon Points"), Category("Geometry")]
        public List<GeoPoint> Points { get; set; } = new List<GeoPoint>();
        // Circle volumes: VolumeShape="Circle" with a Center and Radius > 0.
        // Polygon volumes leave Radius at 0 and use Points.
        [DisplayName("Center (circle volumes)"), Category("Geometry")]
        public GeoPoint Center { get; set; }
        [DisplayName("Radius (NM, 0 = polygon)"), Category("Geometry")]
        public double Radius { get; set; }

        /// <summary>
        /// True if the given location is within this volume's horizontal footprint.
        /// </summary>
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

        public override string ToString()
        {
            return Name;
        }
    }
}
