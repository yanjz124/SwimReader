import { test } from "node:test";
import assert from "node:assert/strict";
import { Aircraft } from "../src/Aircraft.js";
import { AltitudeType } from "../src/Altitude.js";

test("SquawkSPC maps emergency codes", () => {
    const ac = new Aircraft(0);
    ac.Squawk = "7500"; assert.equal(ac.SquawkSPC, "HJ");
    ac.Squawk = "7600"; assert.equal(ac.SquawkSPC, "RF");
    ac.Squawk = "7700"; assert.equal(ac.SquawkSPC, "EM");
    ac.Squawk = "1200"; assert.equal(ac.SquawkSPC, null);
});

test("UpdateAlertCodes orders CA/LA then SPC", () => {
    const ac = new Aircraft(0);
    ac.ConflictAlert = true;
    ac.LowAltitude = true;
    ac.Squawk = "7700"; // EM
    ac.UpdateAlertCodes();
    assert.deepEqual(ac.ActiveRedCodes, ["CA", "LA", "EM"]);
    assert.deepEqual(ac.ActiveYellowCodes, []);
});

test("Manual yellow codes populate yellow list", () => {
    const ac = new Aircraft(0);
    ac.ManualAlertCodes.push("OD");
    ac.UpdateAlertCodes();
    assert.deepEqual(ac.ActiveYellowCodes, ["OD"]);
});

test("PrimaryOnly true with no squawk/mode-C, false once squawking", () => {
    const ac = new Aircraft(0);
    assert.equal(ac.PrimaryOnly, true);
    ac.Squawk = "1234";
    assert.equal(ac.PrimaryOnly, false);
});

test("Associated flips when a flight plan GUID is assigned", () => {
    const ac = new Aircraft(0);
    assert.equal(ac.Associated, false);
    ac.FlightPlanGuid = globalThis.crypto.randomUUID();
    assert.equal(ac.Associated, true);
});

test("IsMSAWInhibited true for VFR flight rules", () => {
    const ac = new Aircraft(0);
    assert.equal(ac.IsMSAWInhibited, false);
    ac.FlightRules = "VFR";
    assert.equal(ac.IsMSAWInhibited, true);
});

test("ExtrapolateTrack with no turn returns current track", () => {
    const ac = new Aircraft(0);
    const t0 = new Date();
    ac.SetTrack(90, t0);
    // first SetTrack derives a micro rateofturn off the epoch (as in DGScope), so allow tolerance
    assert.ok(Math.abs(ac.ExtrapolateTrack(new Date(t0.getTime() + 10000)) - 90) < 1e-3);
});

test("RedrawDataBlock builds an FDB (callsign / alt+speed) — 1-frame alt lag is faithful", async () => {
    const { Radar } = await import("../src/Radar.js");
    const radar = new Radar();
    const ac = new Aircraft(0);
    ac.Squawk = "1234"; ac.FlightPlanCallsign = "AAL123"; ac.Callsign = "AAL123";
    ac.FlightPlanGuid = globalThis.crypto.randomUUID(); ac.Owned = true; // -> Associated + FDB
    ac.GroundSpeed = 420; ac.Type = "B738"; ac.Destination = "DCA";
    ac.Altitude.UpdateAltitude(35000, AltitudeType.Pressure);
    ac.SweptAltitudes.set(radar, 35000); ac.SweptSpeeds.set(radar, 420);
    ac.RedrawDataBlock(radar); // 1st draw: altstring uses stale dbAlt (=0) -> "000"
    let lines = ac.DataBlock.Text.split("\r\n");
    assert.equal(lines[0], "AAL123   ");           // callsign, left-justified PadRight(9)
    assert.equal(lines[1], "000 42   ");           // stale alt + speed (DGScope one-frame lag)
    ac.RedrawDataBlock(radar); // 2nd draw: dbAlt now current -> FL350
    assert.equal(ac.DataBlock.Text.split("\r\n")[1], "350 42   ");
});

test("RedrawDataBlock builds an LDB (squawk + altitude) for an untracked target", async () => {
    const { Radar } = await import("../src/Radar.js");
    const radar = new Radar();
    const ac = new Aircraft(0);
    ac.Squawk = "4567";
    ac.Altitude.UpdateAltitude(12000, AltitudeType.Pressure);
    ac.SweptAltitudes.set(radar, 12000); ac.SweptSpeeds.set(radar, 250);
    ac.RedrawDataBlock(radar);
    const lines = ac.DataBlock.Text.split("\r\n");
    assert.equal(lines[0], "4567     ");           // beacon code, PadRight(9)
    assert.equal(lines.length, 3);                 // LDB is 3 lines
});

test("events fire through the EventHandler shim", () => {
    const ac = new Aircraft(0);
    let fired = 0;
    ac.OwnershipChange.add(() => fired++);
    ac.Owned = true;   // change -> fires
    ac.Owned = true;   // no change -> no fire
    ac.Owned = false;  // change -> fires
    assert.equal(fired, 2);
});
