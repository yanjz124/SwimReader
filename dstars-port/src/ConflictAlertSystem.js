// Ported 1:1 from _source/ConflictAlertSystem.cs
// namespace DGScope
import { AltitudeType } from "./Altitude.js";
import { RadarWindow } from "./RadarWindow.js";

/// <summary>
/// Short Term Conflict Alert (STCA / CA) per CRC STARS. For each associated track
/// owned by this facility, the engine projects position 5 seconds ahead and compares
/// against every other track. If current or predicted separation is below the
/// thresholds (3 NM / 1,000 ft) and separation is not increasing, the pair is in
/// conflict. Conflicts are suppressed for tracks inside a final-approach suppression
/// zone.
/// </summary>
export class ConflictAlertSystem {
    #active = true; // private bool active = true
    SuppressionVolumes = [];    // List<CASuppressionVolume>
    LookAheadSeconds = 5;       // int
    HorizontalSeparation = 3;   // double  NM
    VerticalSeparation = 1000;  // int     ft
    // True when any track has an unacknowledged conflict (drives the aural alert).
    UnacknowledgedAlert = false; // bool { get; private set; }

    get Active() { // bool
        return this.#active;
    }
    set Active(value) {
        if (value === this.#active)
            return;
        this.#active = value;
        if (!value) {
            // lock (RadarWindow.Aircraft)
            {
                RadarWindow.Aircraft.forEach(x => {
                    x.ConflictAlert = false;
                    x.ConflictAlertAcknowledged = false;
                    x.ConflictingTracks.length = 0; // ConflictingTracks.Clear()
                });
            }
        }
    }

    Calculate(aircraftList, radar) { // void Calculate(ICollection<Aircraft> aircraftList, Radar radar)
        let aircraft;
        // lock (aircraftList)
        aircraft = [...aircraftList]; // aircraftList.ToList()
        let zones;
        // lock (SuppressionVolumes)
        zones = this.SuppressionVolumes.filter(v => v.Active); // SuppressionVolumes.Where(v => v.Active).ToArray()

        // Tracks with a usable position and Mode C altitude.
        let valid = aircraft.filter(a => a != null && !a.Deleted && !a.PrimaryOnly
            && a.Altitude != null && a.Altitude.AltitudeType !== AltitudeType.Unknown
            && a.SweptLocation(radar) != null);
        for (const a of valid)
            a.ConflictingTracks.length = 0; // ConflictingTracks.Clear()

        let inConflict = new Set(); // HashSet<Aircraft>
        let owned = valid.filter(a => a.Owned && a.Associated);
        for (const a of owned) {
            for (const b of valid) {
                if (a === b) // ReferenceEquals(a, b)
                    continue;
                if (!this.#InConflict(a, b, radar))
                    continue;
                if (this.#IsSuppressed(a, radar, zones) || this.#IsSuppressed(b, radar, zones))
                    continue;
                if (!a.ConflictingTracks.includes(b)) a.ConflictingTracks.push(b);
                if (!b.ConflictingTracks.includes(a)) b.ConflictingTracks.push(a);
                inConflict.add(a);
                inConflict.add(b);
            }
        }

        let anyUnacked = false;
        for (const a of aircraft) {
            if (inConflict.has(a)) {
                a.ConflictAlert = true;
                if (!a.ConflictAlertAcknowledged)
                    anyUnacked = true;
            }
            else {
                a.ConflictAlert = false;
                a.ConflictAlertAcknowledged = false;
                a.ConflictingTracks.length = 0; // ConflictingTracks.Clear()
            }
        }
        this.UnacknowledgedAlert = anyUnacked;
    }

    #InConflict(a, b, radar) { // private bool
        let aloc = a.SweptLocation(radar);
        let bloc = b.SweptLocation(radar);
        if (aloc == null || bloc == null)
            return false;
        if (Math.abs(a.TrueAltitude - b.TrueAltitude) >= this.VerticalSeparation)
            return false;
        let curHoriz = aloc.DistanceTo(bloc);
        let apred = aloc.FromPoint(a.GroundSpeed * this.LookAheadSeconds / 3600, a.ExtrapolateTrack());
        let bpred = bloc.FromPoint(b.GroundSpeed * this.LookAheadSeconds / 3600, b.ExtrapolateTrack());
        let predHoriz = apred.DistanceTo(bpred);
        let within = curHoriz < this.HorizontalSeparation || predHoriz < this.HorizontalSeparation;
        let notIncreasing = predHoriz <= curHoriz;
        return within && notIncreasing;
    }

    #IsSuppressed(a, radar, zones) { // private bool
        if (zones.length === 0)
            return false;
        let loc = a.SweptLocation(radar);
        if (loc == null)
            return false;
        let alt = a.TrueAltitude;
        for (const z of zones)
            if (z.Contains(loc, alt))
                return true;
        return false;
    }
}
