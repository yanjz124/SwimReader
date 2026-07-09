import { test } from "node:test";
import assert from "node:assert/strict";
import { Altitude, AltitudeType } from "../src/Altitude.js";
import { Altimeter } from "../src/WeatherService.js";

test("Pressure altitude passes through when type is Pressure", () => {
    const a = new Altitude();
    a.UpdateAltitude(35000, AltitudeType.Pressure);
    assert.equal(a.PressureAltitude, 35000);
});

test("True altitude corrects for altimeter setting", () => {
    const a = new Altitude();
    const altm = new Altimeter();
    altm.Value = 30.12; // +0.20 inHg over standard 29.92
    a.SetAltitudeProperties(18000, altm);
    a.UpdateAltitude(35000, AltitudeType.Pressure);
    // correction = (int)((30.12 - 29.92) * 1000). In IEEE-754, (30.12-29.92)*1000 = 199.9999…,
    // and C#'s (int) cast truncates to 199 — the port reproduces this exactly (Math.trunc).
    assert.equal(a.TrueAltitude, 35199);
});

test("Standard altimeter => pressure == true", () => {
    const a = new Altitude();
    a.UpdateAltitude(10000, AltitudeType.True);
    assert.equal(a.PressureAltitude, 10000);
    assert.equal(a.TrueAltitude, 10000);
});

test("ToString flight-level format", () => {
    const a = new Altitude();
    a.UpdateAltitude(35000, AltitudeType.Pressure);
    assert.equal(a.toString(), "FL350");
});

test("ToString feet format for True", () => {
    const a = new Altitude();
    a.UpdateAltitude(2500, AltitudeType.True);
    assert.equal(a.toString(), "2500ft.");
});

test("ConvertTo produces the converted value", () => {
    const a = new Altitude();
    const altm = new Altimeter();
    altm.Value = 29.42; // -0.50
    a.SetAltitudeProperties(18000, altm);
    a.UpdateAltitude(20000, AltitudeType.Pressure);
    const t = a.ConvertTo(AltitudeType.True);
    assert.equal(t.AltitudeType, AltitudeType.True);
    assert.equal(t.Value, 20000 - 500);
});
