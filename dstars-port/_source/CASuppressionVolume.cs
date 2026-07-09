using System;
using System.ComponentModel;

namespace DGScope
{
    /// <summary>
    /// A conflict-alert suppression zone along a runway's final approach course.
    /// Per CRC STARS: 4 NM wide (2 NM either side of the extended centerline),
    /// starting at the runway threshold and extending 30 NM out; vertically from
    /// field elevation up to 1,500 ft above the glideslope. The geometry can be
    /// built by the Profile Manager from NASR data.
    /// </summary>
    public class CASuppressionVolume
    {
        [DisplayName("Name"), Category("Identity")]
        public string Name { get; set; }
        [DisplayName("Active"), Category("Identity")]
        public bool Active { get; set; } = true;
        [Description("Draw the suppression zone on the scope."), Category("Identity")]
        public bool Draw { get; set; }
        [DisplayName("Runway Threshold"), Category("Geometry")]
        public GeoPoint RunwayThreshold { get; set; } = new GeoPoint();
        [DisplayName("Runway True Heading"), Description("Landing direction (degrees true). The approach corridor extends along the reciprocal."), Category("Geometry")]
        public int TrueHeading { get; set; }
        [DisplayName("Length (NM)"), Category("Geometry")]
        public double Length { get; set; } = 30;
        [DisplayName("Half Width (NM)"), Description("Distance either side of the extended centerline (default 2 NM = 4 NM total)."), Category("Geometry")]
        public double HalfWidth { get; set; } = 2;
        [DisplayName("Field Elevation (ft MSL)"), Category("Geometry")]
        public int FieldElevation { get; set; }
        [DisplayName("Glideslope Angle (deg)"), Category("Geometry")]
        public double GlideslopeAngle { get; set; } = 3.0;
        [DisplayName("Height Above Glideslope (ft)"), Category("Geometry")]
        public int HeightAboveGlideslope { get; set; } = 1500;

        private double GlideslopeFeetPerNM => Math.Tan(GlideslopeAngle * Math.PI / 180.0) * 6076.12;

        /// <summary>
        /// True if the given location and altitude fall within the suppression zone.
        /// </summary>
        public bool Contains(GeoPoint location, int altitude)
        {
            if (location == null || RunwayThreshold == null)
                return false;
            double dist = RunwayThreshold.DistanceTo(location);
            if (dist <= 0 || dist > Length + HalfWidth)
                return false;
            // Approach corridor runs from the threshold along the reciprocal of the
            // landing heading (i.e. out along the final approach course).
            double centerline = (TrueHeading + 180) % 360;
            double bearing = RunwayThreshold.BearingTo(location);
            double angleOff = ((bearing - centerline + 540) % 360) - 180; // [-180,180]
            double rad = angleOff * Math.PI / 180.0;
            double alongTrack = dist * Math.Cos(rad);
            double crossTrack = Math.Abs(dist * Math.Sin(rad));
            if (alongTrack < 0 || alongTrack > Length)
                return false;
            if (crossTrack > HalfWidth)
                return false;
            double glideslopeAlt = FieldElevation + alongTrack * GlideslopeFeetPerNM;
            double ceiling = glideslopeAlt + HeightAboveGlideslope;
            if (altitude < FieldElevation || altitude > ceiling)
                return false;
            return true;
        }

        public override string ToString()
        {
            return Name;
        }
    }
}
