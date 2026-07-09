import { test } from "node:test";
import assert from "node:assert/strict";
import { Radar } from "../src/Radar.js";
import { ConflictAlertSystem } from "../src/ConflictAlertSystem.js";
import { MSAW } from "../src/MSAW.js";
import { MSAWVolume } from "../src/MSAWVolume.js";
import { GeoPoint } from "../src/GeoPoint.js";
import { makeAircraft } from "./helpers.js";

test("ConflictAlertSystem flags a close, converging co-altitude pair", () => {
    const radar = new Radar();
    // a heading east, b 2 NM east heading west -> closing (predicted sep < current sep).
    const a = makeAircraft(radar, { lat: 40.0, lon: -74.0, trueAlt: 5000, gs: 300, track: 90 });
    const b = makeAircraft(radar, { lat: 40.0, lon: -74.0, trueAlt: 5000, gs: 300, track: 270 });
    b.SweptLocations.set(radar, a.SweptLocations.get(radar).FromPoint(2, 90)); // 2 NM east

    const ca = new ConflictAlertSystem();
    ca.Calculate([a, b], radar);
    assert.equal(a.ConflictAlert, true);
    assert.equal(b.ConflictAlert, true);
    assert.ok(a.ConflictingTracks.includes(b));
});

test("ConflictAlertSystem ignores a well-separated pair", () => {
    const radar = new Radar();
    const a = makeAircraft(radar, { lat: 40.0, lon: -74.0, trueAlt: 5000, gs: 0 });
    const b = makeAircraft(radar, { lat: 40.0, lon: -74.0, trueAlt: 5000, gs: 0 });
    b.SweptLocations.set(radar, a.SweptLocations.get(radar).FromPoint(20, 0)); // 20 NM apart

    const ca = new ConflictAlertSystem();
    ca.Calculate([a, b], radar);
    assert.equal(a.ConflictAlert, false);
    assert.equal(b.ConflictAlert, false);
});

test("ConflictAlertSystem ignores vertically-separated pair", () => {
    const radar = new Radar();
    const a = makeAircraft(radar, { lat: 40.0, lon: -74.0, trueAlt: 5000, gs: 0 });
    const b = makeAircraft(radar, { lat: 40.0, lon: -74.0, trueAlt: 8000, gs: 0 }); // 3000 ft apart
    b.SweptLocations.set(radar, a.SweptLocations.get(radar).FromPoint(1, 0));

    const ca = new ConflictAlertSystem();
    ca.Calculate([a, b], radar);
    assert.equal(a.ConflictAlert, false);
});

test("MSAW flags a track inside a low-altitude volume", () => {
    const radar = new Radar();
    const ac = makeAircraft(radar, { lat: 40.0, lon: -74.0, trueAlt: 1000, gs: 0 });

    const vol = new MSAWVolume();
    vol.Center = new GeoPoint(40.0, -74.0);
    vol.Radius = 5;
    vol.Floor = 0;
    vol.Ceiling = 2000; // MSA 2000 ft; track at 1000 -> alert

    const msaw = new MSAW();
    msaw.Volumes.push(vol);
    msaw.LookAheadSeconds = 0;
    msaw.Calculate([ac], radar);
    assert.equal(ac.LowAltitude, true);
});

test("MSAW does not flag a track above the volume ceiling", () => {
    const radar = new Radar();
    const ac = makeAircraft(radar, { lat: 40.0, lon: -74.0, trueAlt: 5000, gs: 0 });

    const vol = new MSAWVolume();
    vol.Center = new GeoPoint(40.0, -74.0);
    vol.Radius = 5;
    vol.Floor = 0;
    vol.Ceiling = 2000;

    const msaw = new MSAW();
    msaw.Volumes.push(vol);
    msaw.LookAheadSeconds = 0;
    msaw.Calculate([ac], radar);
    assert.equal(ac.LowAltitude, false);
});
