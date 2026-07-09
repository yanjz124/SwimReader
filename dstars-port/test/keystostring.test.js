// Locks the KeyList representation contract that ProcessCommand/KeysToString rely on:
// chars are 1-char strings (appended verbatim), named/letter keys are Key.* Symbols
// (mapped to characters via KeyToChar), everything else contributes nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RadarWindow } from "../src/RadarWindow.js";
import { Key } from "../src/_shims/OpenTK.js";

const KeysToString = RadarWindow.prototype.KeysToString;
const call = (keys, start) => KeysToString.call({}, keys, start); // pure — no instance state

test("chars pass through verbatim", () => {
    assert.equal(call(["A", "B", "1", "2", "*", "+", "."]), "AB12*+.");
});

test("letter/number Key symbols map to characters", () => {
    assert.equal(call([Key.A, Key.T, Key.P, Key.A]), "ATPA");
    assert.equal(call([Key.Number2, Key.Period, Key.Keypad5]), "2.5");
    assert.equal(call([Key.Plus, Key.KeypadPlus]), "++");
});

test("start index skips leading keys", () => {
    assert.equal(call([Key.F7, "Y", "A", "B"], 2), "AB");
});

test("unmapped keys (e.g. F7, End) contribute nothing", () => {
    assert.equal(call([Key.F7, "A", Key.End, "B"]), "AB");
});

// GeneratePreviewString maps enum keys (incl. KeyCode) + special chars, and appends a trailing space.
const GPS = RadarWindow.prototype.GeneratePreviewString;
const gps = (keys) => GPS.call({}, keys);

test("preview string maps chars, backtick, and space", () => {
    assert.equal(gps(["A", "B"]), "AB ");           // trailing space always appended
    assert.equal(gps(["`"]), "▲ ");                  // backtick -> up-triangle
    assert.equal(gps(["A", " ", "B"]), "A\r\nB ");   // space -> CRLF
});

test("preview string maps KeyCode/named keys", () => {
    assert.equal(gps([RadarWindow.KeyCode.RngRing]), "RR ");
    assert.equal(gps([RadarWindow.KeyCode.RecenterEverything]), "RECENTER ");
    assert.equal(gps([Key.KeypadMultiply, Key.Slash]), "*/ ");
});
