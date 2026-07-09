// Ported 1:1 from _source/MSAW.cs
// namespace DGScope
import { AltitudeType } from "./Altitude.js";
import { RadarWindow } from "./RadarWindow.js";

export class MSAW {
    #active = true; // private bool active = true
    Volumes = []; // List<MSAWVolume>
    // Suppression zones (vSTARS "MSAW suppression zones"): generic polygon/circle
    // volumes where MSAW alerts are inhibited, e.g. over an airport or along an
    // approach path where aircraft are expected to be low. A track inside any of
    // these (within its floor/ceiling band) does not generate an LA.
    SuppressionVolumes = []; // List<MSAWVolume>
    // Seconds to project the track forward when looking for a predicted violation.
    LookAheadSeconds = 30; // int
    // True when at least one aircraft has an unacknowledged low-altitude alert
    // (drives the repeating aural alert). Updated each Calculate().
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
                    x.LowAltitude = false;
                    x.LowAltitudeAcknowledged = false;
                });
            }
        }
    }

    Calculate(aircraftList, radar) { // void Calculate(ICollection<Aircraft> aircraftList, Radar radar)
        let aircraft;
        // lock (aircraftList)
        aircraft = [...aircraftList]; // aircraftList.ToList()
        let vols;
        // lock (Volumes)
        vols = this.Volumes.filter(v => v.Active); // Volumes.Where(v => v.Active).ToArray()
        let suppression;
        // lock (SuppressionVolumes)
        suppression = this.SuppressionVolumes.filter(v => v.Active);
        let anyUnacked = false;
        for (const ac of aircraft) {
            if (this.#IsLowAltitude(ac, radar, vols, suppression)) {
                ac.LowAltitude = true;
                if (!ac.LowAltitudeAcknowledged)
                    anyUnacked = true;
            }
            else {
                ac.LowAltitude = false;
                ac.LowAltitudeAcknowledged = false;
            }
        }
        this.UnacknowledgedAlert = anyUnacked;
    }

    #IsLowAltitude(ac, radar, vols, suppression) { // private bool
        if (ac == null || ac.Deleted || vols.length === 0)
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
        if (ac.PrimaryOnly || ac.Altitude == null || ac.Altitude.AltitudeType === AltitudeType.Unknown)
            return false;
        let loc = ac.SweptLocation(radar) ?? ac.Location;
        if (loc == null)
            return false;
        let alt = ac.TrueAltitude;
        let predicted = (ac.GroundSpeed > 0 && this.LookAheadSeconds > 0)
            ? loc.FromPoint(ac.GroundSpeed * this.LookAheadSeconds / 3600, ac.ExtrapolateTrack())
            : null;
        // Suppression zones win: if the track is (or is about to be) inside a
        // suppression volume, no alert.
        if (MSAW.#InsideAny(loc, alt, suppression) || (predicted != null && MSAW.#InsideAny(predicted, alt, suppression)))
            return false;
        // Trigger if currently or predicted to be inside an MSAW volume.
        if (MSAW.#InsideAny(loc, alt, vols))
            return true;
        if (predicted != null && MSAW.#InsideAny(predicted, alt, vols))
            return true;
        return false;
    }

    static #InsideAny(loc, alt, vols) { // private static bool
        for (const v of vols) {
            if (alt >= v.Ceiling || alt < v.Floor)
                continue;
            if (v.ContainsLocation(loc))
                return true;
        }
        return false;
    }
}
