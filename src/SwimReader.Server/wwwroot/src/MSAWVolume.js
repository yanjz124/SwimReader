// Ported 1:1 from _source/MSAWVolume.cs
// namespace DGScope

export class MSAWVolume {
    // [DisplayName("Name"), Category("Identity")]
    Name = null;    // string
    // [DisplayName("Active"), Category("Identity")]
    Active = true;  // bool
    // [Description("Draw the volume on the scope, for testing purposes."), Category("Identity")]
    Draw = false;   // bool
    // [DisplayName("Floor (ft MSL)"), Category("Geometry")]
    Floor = 0;      // int
    // [DisplayName("Ceiling / Minimum Safe Altitude (ft MSL)"), Category("Geometry")]
    Ceiling = 0;    // int
    // [DisplayName("Polygon Points"), Category("Geometry")]
    Points = [];    // List<GeoPoint>
    // Circle volumes: VolumeShape="Circle" with a Center and Radius > 0.
    // Polygon volumes leave Radius at 0 and use Points.
    // [DisplayName("Center (circle volumes)"), Category("Geometry")]
    Center = null;  // GeoPoint
    // [DisplayName("Radius (NM, 0 = polygon)"), Category("Geometry")]
    Radius = 0.0;   // double

    /// <summary>
    /// True if the given location is within this volume's horizontal footprint.
    /// </summary>
    ContainsLocation(location) { // bool ContainsLocation(GeoPoint location)
        if (location == null)
            return false;
        if (this.Radius > 0 && this.Center != null)
            return location.DistanceTo(this.Center) <= this.Radius;
        // Ray-casting point-in-polygon (handles the closing edge via the j=i++ wrap).
        if (this.Points == null || this.Points.length < 3)
            return false;
        let inside = false;
        let n = this.Points.length;
        for (let i = 0, j = n - 1; i < n; j = i++) {
            let xi = this.Points[i].Longitude, yi = this.Points[i].Latitude;
            let xj = this.Points[j].Longitude, yj = this.Points[j].Latitude;
            let intersect = ((yi > location.Latitude) != (yj > location.Latitude)) &&
                (location.Longitude < (xj - xi) * (location.Latitude - yi) / (yj - yi) + xi);
            if (intersect)
                inside = !inside;
        }
        return inside;
    }

    toString() {
        return this.Name;
    }
}
