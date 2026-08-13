using SwimReader.Server.Ca;

namespace SwimReader.Server.Msaw;

/// <summary>
/// Ported byte-faithful from DGScope's MSAW.cs (Minimum Safe Altitude Warning). For each associated,
/// airborne, Mode-C track it alerts when the current or 30 s-projected position is inside any active
/// MSAW volume (within its floor/ceiling band) and NOT inside a suppression volume. The only change
/// from the source is the Active setter: DGScope's reset a WPF global; Calculate() clears the flags
/// every pass, so the reset is dropped. Sets Aircraft.LowAltitude → JS "LA" line-0 annotation.
/// </summary>
public class MSAW
{
    public List<MSAWVolume> Volumes { get; set; } = new();
    public List<MSAWVolume> SuppressionVolumes { get; set; } = new();
    public int LookAheadSeconds { get; set; } = 30;
    public bool UnacknowledgedAlert { get; private set; }
    public bool Active { get; set; } = true;

    public void Calculate(ICollection<Aircraft> aircraftList, Radar radar)
    {
        List<Aircraft> aircraft;
        lock (aircraftList)
            aircraft = aircraftList.ToList();
        MSAWVolume[] vols;
        lock (Volumes)
            vols = Volumes.Where(v => v.Active).ToArray();
        MSAWVolume[] suppression;
        lock (SuppressionVolumes)
            suppression = SuppressionVolumes.Where(v => v.Active).ToArray();
        bool anyUnacked = false;
        foreach (var ac in aircraft)
        {
            if (IsLowAltitude(ac, radar, vols, suppression))
            {
                ac.LowAltitude = true;
                if (!ac.LowAltitudeAcknowledged)
                    anyUnacked = true;
            }
            else
            {
                ac.LowAltitude = false;
                ac.LowAltitudeAcknowledged = false;
            }
        }
        UnacknowledgedAlert = anyUnacked;
    }

    private bool IsLowAltitude(Aircraft ac, Radar radar, MSAWVolume[] vols, MSAWVolume[] suppression)
    {
        if (ac == null || ac.Deleted || vols.Length == 0)
            return false;
        if (ac.IsMSAWInhibited)
            return false;
        if (!ac.Associated)
            return false;
        if (ac.IsOnGround)
            return false;
        if (ac.PrimaryOnly || ac.Altitude == null || ac.Altitude.AltitudeType == AltitudeType.Unknown)
            return false;
        var loc = ac.SweptLocation(radar) ?? ac.Location;
        if (loc == null)
            return false;
        int alt = ac.TrueAltitude;
        GeoPoint? predicted = (ac.GroundSpeed > 0 && LookAheadSeconds > 0)
            ? loc.FromPoint(ac.GroundSpeed * LookAheadSeconds / 3600d, ac.ExtrapolateTrack())
            : null;
        if (InsideAny(loc, alt, suppression) || (predicted != null && InsideAny(predicted, alt, suppression)))
            return false;
        if (InsideAny(loc, alt, vols))
            return true;
        if (predicted != null && InsideAny(predicted, alt, vols))
            return true;
        return false;
    }

    private static bool InsideAny(GeoPoint loc, int alt, MSAWVolume[] vols)
    {
        foreach (var v in vols)
        {
            if (alt >= v.Ceiling || alt < v.Floor)
                continue;
            if (v.ContainsLocation(loc))
                return true;
        }
        return false;
    }
}
