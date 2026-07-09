// Shared test helpers for the dstars-port logic tier.
import { Aircraft } from "../src/Aircraft.js";
import { AltitudeType } from "../src/Altitude.js";

// Build a fully-associated Mode-C aircraft and prime its swept state for a radar,
// mimicking what Radar.ScanTarget would populate, so the CA/MSAW/ATPA engines can run.
export function makeAircraft(radar, { squawk = "1234", trueAlt = 5000, lat, lon, gs = 250, track = 0 }) {
    const ac = new Aircraft(0);
    ac.Squawk = squawk;
    ac.FlightPlanGuid = globalThis.crypto.randomUUID(); // -> Associated
    ac.Owned = true;
    ac.GroundSpeed = gs;
    ac.Altitude.UpdateAltitude(trueAlt, AltitudeType.True);
    ac.SetLocation(lat, lon, new Date());
    ac.SetTrack(track, new Date()); // so ExtrapolateTrack() returns ~track
    // Prime the swept dictionaries (Radar.ScanTarget would normally do this).
    const loc = ac.Location;
    ac.SweptLocations.set(radar, loc);
    ac.SweptTracks.set(radar, track);
    ac.SweptAltitudes.set(radar, trueAlt);
    ac.SweptSpeeds.set(radar, gs);
    return ac;
}

export const NM_TOL = 0.05;   // nautical-mile tolerance for great-circle round trips
export const DEG_TOL = 0.01;  // degree tolerance
