import { test } from "node:test";
import assert from "node:assert/strict";
import { BeaconCodeRange } from "../src/BeaconCodeRange.js";

test("Begin round-trips octal beacon code", () => {
    const r = new BeaconCodeRange();
    r.Begin = "1200";
    assert.equal(r.Begin, "1200");
});

test("single-code range matches exactly", () => {
    const r = new BeaconCodeRange();
    r.Begin = "1200";
    assert.equal(r.IsInRange("1200"), true);
    assert.equal(r.IsInRange("1201"), false);
});

test("range inclusive of endpoints (octal ordering)", () => {
    const r = new BeaconCodeRange();
    r.Begin = "1200";
    r.End = "1277";
    assert.equal(r.IsInRange("1200"), true);
    assert.equal(r.IsInRange("1234"), true);
    assert.equal(r.IsInRange("1277"), true);
    assert.equal(r.IsInRange("1300"), false); // 1300 octal > 1277 octal
});

test("non-octal / malformed squawk is not in range", () => {
    const r = new BeaconCodeRange();
    r.Begin = "1200";
    r.End = "1277";
    assert.equal(r.IsInRange("18AB"), false);
    assert.equal(r.IsInRange(null), false);
});

test("toString shows range", () => {
    const r = new BeaconCodeRange();
    r.Begin = "0100";
    r.End = "0177";
    assert.equal(r.toString(), "0100 - 0177");
});
