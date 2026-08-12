using System;

namespace SwimReader.Server.Ca;

/// <summary>
/// Ported byte-faithful from DGScope's CASuppressionVolume.cs. A conflict-alert
/// suppression zone along a runway's final approach course: 4 NM wide (HalfWidth either
/// side of the extended centerline), from the threshold out Length NM, vertically from
/// field elevation up to HeightAboveGlideslope above the glideslope. Without these,
/// sequenced/parallel approaches trip CA constantly. DGScope loads them from the profile
/// XML (ConflictAlertSuppressionVolumes); we also auto-generate them from runway data.
/// </summary>
public class CASuppressionVolume
{
    public string? Name { get; set; }
    public bool Active { get; set; } = true;
    public bool Draw { get; set; }
    public GeoPoint RunwayThreshold { get; set; } = new GeoPoint();
    public int TrueHeading { get; set; }
    public double Length { get; set; } = 30;
    public double HalfWidth { get; set; } = 2;
    public int FieldElevation { get; set; }
    public double GlideslopeAngle { get; set; } = 3.0;
    public int HeightAboveGlideslope { get; set; } = 1500;

    private double GlideslopeFeetPerNM => Math.Tan(GlideslopeAngle * Math.PI / 180.0) * 6076.12;

    /// <summary>True if the given location and altitude fall within the suppression zone.</summary>
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

    public override string ToString() => Name ?? "";
}
