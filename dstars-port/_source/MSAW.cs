using System.Collections.Generic;
using System.Linq;

namespace DGScope
{
    public class MSAW
    {
        private bool active = true;
        public List<MSAWVolume> Volumes { get; set; } = new List<MSAWVolume>();
        // Suppression zones (vSTARS "MSAW suppression zones"): generic polygon/circle
        // volumes where MSAW alerts are inhibited, e.g. over an airport or along an
        // approach path where aircraft are expected to be low. A track inside any of
        // these (within its floor/ceiling band) does not generate an LA.
        public List<MSAWVolume> SuppressionVolumes { get; set; } = new List<MSAWVolume>();
        // Seconds to project the track forward when looking for a predicted violation.
        public int LookAheadSeconds { get; set; } = 30;
        // True when at least one aircraft has an unacknowledged low-altitude alert
        // (drives the repeating aural alert). Updated each Calculate().
        public bool UnacknowledgedAlert { get; private set; }

        public bool Active
        {
            get => active;
            set
            {
                if (value == active)
                    return;
                active = value;
                if (!value)
                {
                    lock (RadarWindow.Aircraft)
                    {
                        RadarWindow.Aircraft.ToList().ForEach(x =>
                        {
                            x.LowAltitude = false;
                            x.LowAltitudeAcknowledged = false;
                        });
                    }
                }
            }
        }

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
            // MSAW inhibited (automatic VFR inhibit or manual F7 V/Q <slew>).
            if (ac.IsMSAWInhibited)
                return false;
            // MSAW only applies to correlated (associated) tracks.
            if (!ac.Associated)
                return false;
            // Aircraft on the airport surface do not generate MSAW.
            if (ac.IsOnGround)
                return false;
            // Need a Mode C altitude to evaluate.
            if (ac.PrimaryOnly || ac.Altitude == null || ac.Altitude.AltitudeType == AltitudeType.Unknown)
                return false;
            var loc = ac.SweptLocation(radar) ?? ac.Location;
            if (loc == null)
                return false;
            int alt = ac.TrueAltitude;
            GeoPoint predicted = (ac.GroundSpeed > 0 && LookAheadSeconds > 0)
                ? loc.FromPoint(ac.GroundSpeed * LookAheadSeconds / 3600d, ac.ExtrapolateTrack())
                : null;
            // Suppression zones win: if the track is (or is about to be) inside a
            // suppression volume, no alert.
            if (InsideAny(loc, alt, suppression) || (predicted != null && InsideAny(predicted, alt, suppression)))
                return false;
            // Trigger if currently or predicted to be inside an MSAW volume.
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
}
