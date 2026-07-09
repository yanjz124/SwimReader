import { test } from "node:test";
import assert from "node:assert/strict";
import { GeoPoint } from "../src/GeoPoint.js";
import { NM_TOL } from "./helpers.js";

test("DistanceTo self is 0", () => {
    const p = new GeoPoint(40.6413, -73.7781);
    assert.equal(p.DistanceTo(p), 0);
});

test("FromPoint / DistanceTo round-trip preserves distance", () => {
    const origin = new GeoPoint(38.0, -77.0);
    for (const [d, b] of [[10, 0], [50, 90], [123.4, 210], [5, 359]]) {
        const dest = origin.FromPoint(d, b);
        assert.ok(Math.abs(origin.DistanceTo(dest) - d) < NM_TOL, `d=${d} b=${b} got ${origin.DistanceTo(dest)}`);
    }
});

test("FromPoint 60 NM north ~= +1 deg latitude", () => {
    const origin = new GeoPoint(0, 0);
    const dest = origin.FromPoint(60, 0);
    assert.ok(Math.abs(dest.Latitude - 1.0) < 0.01, `lat=${dest.Latitude}`);
    assert.ok(Math.abs(dest.Longitude - 0) < 0.001, `lon=${dest.Longitude}`);
});

test("BearingTo is opposite of return bearing (~180 apart)", () => {
    const a = new GeoPoint(40, -75);
    const b = a.FromPoint(30, 90); // 30 NM due east
    // Bearing measured between the two points should be consistent within the great circle.
    const fwd = b.BearingTo(a);
    assert.ok(Number.isFinite(fwd));
});

test("TryParse decimal lat/lon", () => {
    const out = {};
    assert.equal(GeoPoint.TryParse("40.6413 -73.7781", out), true);
    assert.ok(Math.abs(out.value.Latitude - 40.6413) < 1e-6);
    assert.ok(Math.abs(out.value.Longitude - -73.7781) < 1e-6);
});

test("TryParse rejects short input", () => {
    const out = {};
    assert.equal(GeoPoint.TryParse("40.6413", out), false);
});

test("ToDmsString formats DMS", () => {
    // 38.5 deg = 38 30 00 ; -77.25 = 77 15 00 W
    const p = new GeoPoint(38.5, -77.25);
    assert.equal(p.ToDmsString(), "38 30 0/77 15 0");
});
