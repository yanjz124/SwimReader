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
