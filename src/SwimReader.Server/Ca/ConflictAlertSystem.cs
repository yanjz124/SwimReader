using System;
using System.Collections.Generic;
using System.Linq;

namespace SwimReader.Server.Ca
{
    /// <summary>
    /// Ported from DGScope's ConflictAlertSystem.cs — kept as close to the original as possible
    /// (runs against the Aircraft/Radar/GeoPoint shims in this namespace). The ONLY change from
    /// the source is the Active setter: DGScope's version reset RadarWindow.Aircraft, a global
    /// that doesn't exist server-side; Calculate() clears the flags on every pass regardless, so
    /// the reset is dropped. Everything below (Calculate/InConflict/IsSuppressed) is verbatim.
    ///
    /// Short Term Conflict Alert (STCA / CA) per CRC STARS. For each associated track owned by
    /// this facility, the engine projects position 5 seconds ahead and compares against every
    /// other track. If current or predicted separation is below the thresholds (3 NM / 1,000 ft)
    /// and separation is not increasing, the pair is in conflict. Conflicts are suppressed for
    /// tracks inside a final-approach suppression zone.
    /// </summary>
    public class ConflictAlertSystem
    {
        public List<CASuppressionVolume> SuppressionVolumes { get; set; } = new List<CASuppressionVolume>();
        public int LookAheadSeconds { get; set; } = 5;
        public double HorizontalSeparation { get; set; } = 3;   // NM
        public int VerticalSeparation { get; set; } = 1000;     // ft
        // True when any track has an unacknowledged conflict (drives the aural alert).
        public bool UnacknowledgedAlert { get; private set; }

        public bool Active { get; set; } = true;

        public void Calculate(ICollection<Aircraft> aircraftList, Radar radar)
        {
            List<Aircraft> aircraft;
            lock (aircraftList)
                aircraft = aircraftList.ToList();
            CASuppressionVolume[] zones;
            lock (SuppressionVolumes)
                zones = SuppressionVolumes.Where(v => v.Active).ToArray();

            // Tracks with a usable position and Mode C altitude.
            var valid = aircraft.Where(a => a != null && !a.Deleted && !a.PrimaryOnly
                && a.Altitude != null && a.Altitude.AltitudeType != AltitudeType.Unknown
                && a.SweptLocation(radar) != null).ToList();
            foreach (var a in valid)
                a.ConflictingTracks.Clear();

            var inConflict = new HashSet<Aircraft>();
            var owned = valid.Where(a => a.Owned && a.Associated).ToList();
            foreach (var a in owned)
            {
                foreach (var b in valid)
                {
                    if (ReferenceEquals(a, b))
                        continue;
                    if (!InConflict(a, b, radar))
                        continue;
                    if (IsSuppressed(a, radar, zones) || IsSuppressed(b, radar, zones))
                        continue;
                    if (!a.ConflictingTracks.Contains(b)) a.ConflictingTracks.Add(b);
                    if (!b.ConflictingTracks.Contains(a)) b.ConflictingTracks.Add(a);
                    inConflict.Add(a);
                    inConflict.Add(b);
                }
            }

            bool anyUnacked = false;
            foreach (var a in aircraft)
            {
                if (inConflict.Contains(a))
                {
                    a.ConflictAlert = true;
                    if (!a.ConflictAlertAcknowledged)
                        anyUnacked = true;
                }
                else
                {
                    a.ConflictAlert = false;
                    a.ConflictAlertAcknowledged = false;
                    a.ConflictingTracks.Clear();
                }
            }
            UnacknowledgedAlert = anyUnacked;
        }

        private bool InConflict(Aircraft a, Aircraft b, Radar radar)
        {
            var aloc = a.SweptLocation(radar);
            var bloc = b.SweptLocation(radar);
            if (aloc == null || bloc == null)
                return false;
            if (Math.Abs(a.TrueAltitude - b.TrueAltitude) >= VerticalSeparation)
                return false;
            double curHoriz = aloc.DistanceTo(bloc);
            var apred = aloc.FromPoint(a.GroundSpeed * LookAheadSeconds / 3600d, a.ExtrapolateTrack());
            var bpred = bloc.FromPoint(b.GroundSpeed * LookAheadSeconds / 3600d, b.ExtrapolateTrack());
            double predHoriz = apred.DistanceTo(bpred);
            bool within = curHoriz < HorizontalSeparation || predHoriz < HorizontalSeparation;
            bool notIncreasing = predHoriz <= curHoriz;
            return within && notIncreasing;
        }

        private bool IsSuppressed(Aircraft a, Radar radar, CASuppressionVolume[] zones)
        {
            if (zones.Length == 0)
                return false;
            var loc = a.SweptLocation(radar);
            if (loc == null)
                return false;
            int alt = a.TrueAltitude;
            foreach (var z in zones)
                if (z.Contains(loc, alt))
                    return true;
            return false;
        }
    }
}
