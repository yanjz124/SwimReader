// Ported 1:1 from _source/CASuppressionVolume.cs
// namespace DGScope
import { GeoPoint } from "./GeoPoint.js";

/// <summary>
/// A conflict-alert suppression zone along a runway's final approach course.
/// Per CRC STARS: 4 NM wide (2 NM either side of the extended centerline),
/// starting at the runway threshold and extending 30 NM out; vertically from
/// field elevation up to 1,500 ft above the glideslope. The geometry can be
/// built by the Profile Manager from NASR data.
/// </summary>
export class CASuppressionVolume {
    // [DisplayName("Name"), Category("Identity")]
    Name = null;    // string
    // [DisplayName("Active"), Category("Identity")]
    Active = true;  // bool
    // [Description("Draw the suppression zone on the scope."), Category("Identity")]
    Draw = false;   // bool
    // [DisplayName("Runway Threshold"), Category("Geometry")]
    RunwayThreshold = new GeoPoint(); // GeoPoint
    // [DisplayName("Runway True Heading"), Description("Landing direction (degrees true). The approach corridor extends along the reciprocal."), Category("Geometry")]
    TrueHeading = 0; // int
    // [DisplayName("Length (NM)"), Category("Geometry")]
    Length = 30;     // double
    // [DisplayName("Half Width (NM)"), Description("Distance either side of the extended centerline (default 2 NM = 4 NM total)."), Category("Geometry")]
    HalfWidth = 2;   // double
    // [DisplayName("Field Elevation (ft MSL)"), Category("Geometry")]
    FieldElevation = 0; // int
    // [DisplayName("Glideslope Angle (deg)"), Category("Geometry")]
    GlideslopeAngle = 3.0; // double
    // [DisplayName("Height Above Glideslope (ft)"), Category("Geometry")]
    HeightAboveGlideslope = 1500; // int

    // private double GlideslopeFeetPerNM
    get #GlideslopeFeetPerNM() { return Math.tan(this.GlideslopeAngle * Math.PI / 180.0) * 6076.12; }

    /// <summary>
    /// True if the given location and altitude fall within the suppression zone.
    /// </summary>
    Contains(location, altitude) { // bool Contains(GeoPoint location, int altitude)
        if (location == null || this.RunwayThreshold == null)
            return false;
        let dist = this.RunwayThreshold.DistanceTo(location);
        if (dist <= 0 || dist > this.Length + this.HalfWidth)
            return false;
        // Approach corridor runs from the threshold along the reciprocal of the
        // landing heading (i.e. out along the final approach course).
        let centerline = (this.TrueHeading + 180) % 360;
        let bearing = this.RunwayThreshold.BearingTo(location);
        let angleOff = ((bearing - centerline + 540) % 360) - 180; // [-180,180]
        let rad = angleOff * Math.PI / 180.0;
        let alongTrack = dist * Math.cos(rad);
        let crossTrack = Math.abs(dist * Math.sin(rad));
        if (alongTrack < 0 || alongTrack > this.Length)
            return false;
        if (crossTrack > this.HalfWidth)
            return false;
        let glideslopeAlt = this.FieldElevation + alongTrack * this.#GlideslopeFeetPerNM;
        let ceiling = glideslopeAlt + this.HeightAboveGlideslope;
        if (altitude < this.FieldElevation || altitude > ceiling)
            return false;
        return true;
    }

    toString() {
        return this.Name;
    }
}
