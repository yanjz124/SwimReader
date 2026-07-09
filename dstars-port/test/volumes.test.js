import { test } from "node:test";
import assert from "node:assert/strict";
import { MSAWVolume } from "../src/MSAWVolume.js";
import { CASuppressionVolume } from "../src/CASuppressionVolume.js";
import { GeoPoint } from "../src/GeoPoint.js";

test("MSAWVolume circle contains its center, excludes far point", () => {
    const v = new MSAWVolume();
    v.Center = new GeoPoint(40, -74);
    v.Radius = 5; // NM
    assert.equal(v.ContainsLocation(new GeoPoint(40, -74)), true);
    assert.equal(v.ContainsLocation(new GeoPoint(40, -74).FromPoint(3, 90)), true);
    assert.equal(v.ContainsLocation(new GeoPoint(40, -74).FromPoint(10, 90)), false);
});

test("MSAWVolume polygon point-in-polygon", () => {
    const v = new MSAWVolume();
    // unit-ish square around (40,-74)
    v.Points = [
        new GeoPoint(39.9, -74.1),
        new GeoPoint(40.1, -74.1),
        new GeoPoint(40.1, -73.9),
        new GeoPoint(39.9, -73.9),
    ];
    assert.equal(v.ContainsLocation(new GeoPoint(40.0, -74.0)), true);
    assert.equal(v.ContainsLocation(new GeoPoint(41.0, -74.0)), false);
});

test("MSAWVolume null / degenerate cases", () => {
    const v = new MSAWVolume();
    assert.equal(v.ContainsLocation(null), false);
    assert.equal(v.ContainsLocation(new GeoPoint(40, -74)), false); // no radius, <3 points
});

test("CASuppressionVolume contains a point on the final approach corridor", () => {
    const z = new CASuppressionVolume();
    z.RunwayThreshold = new GeoPoint(40, -74);
    z.TrueHeading = 360;      // landing north; corridor extends south (reciprocal 180)
    z.Length = 10;
    z.HalfWidth = 2;
    z.FieldElevation = 0;
    z.HeightAboveGlideslope = 1500;
    z.GlideslopeAngle = 3.0;
    // 5 NM south of threshold, on centerline, ~1600 ft (within glideslope + 1500)
    const onCourse = z.RunwayThreshold.FromPoint(5, 180);
    assert.equal(z.Contains(onCourse, 1600), true);
    // Same spot but far too high -> excluded
    assert.equal(z.Contains(onCourse, 40000), false);
    // Off to the side beyond half width -> excluded
    const offCourse = z.RunwayThreshold.FromPoint(5, 150);
    assert.equal(z.Contains(offCourse, 1600), false);
});
