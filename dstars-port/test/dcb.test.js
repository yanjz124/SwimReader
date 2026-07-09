import { test } from "node:test";
import assert from "node:assert/strict";
import { DCB, DCBLocation } from "../src/DCB.js";
import { DCBMenu } from "../src/DCBMenu.js";
import { GL } from "../src/_shims/GL.js";
import { Matrix4 } from "../src/_shims/OpenTK.js";

function mockCtx() {
    const rec = { fills: [], cur: null, fillStyle: "" };
    return {
        rec,
        save() {}, restore() {}, setTransform() {},
        beginPath() { rec.cur = []; },
        moveTo(x, y) { rec.cur.push([x, y]); },
        lineTo(x, y) { rec.cur.push([x, y]); },
        closePath() { if (rec.cur) rec.cur.closed = true; },
        fill() { rec.fills.push({ pts: rec.cur, style: this.fillStyle }); },
        stroke() {}, fillRect() {},
        set fillStyle(v) { rec.fillStyle = v; }, get fillStyle() { return rec.fillStyle; },
        set strokeStyle(v) {}, get strokeStyle() { return ""; },
        set lineWidth(v) {}, get lineWidth() { return 1; },
        set globalCompositeOperation(v) {}, get globalCompositeOperation() { return ""; },
    };
}
const near = (a, b, t = 1e-6) => Math.abs(a - b) < t;

test("DCB.Draw renders the bottom bar to the correct pixels", () => {
    const W = 1000, H = 800, Size = 80;
    const ctx = mockCtx();
    GL.init(ctx, W, H); GL.Viewport(0, 0, W, H); GL.LoadIdentity();

    const dcb = new DCB();
    dcb.Location = DCBLocation.Bottom;
    dcb.Size = Size;
    dcb.Visible = true;
    dcb.ActiveMenu = new DCBMenu(); // empty menu -> no button fills

    const pixelTransform = Matrix4.CreateTranslation(-W / 2, -H / 2, 0).mul(Matrix4.CreateScale(2 / W, -2 / H, 1));
    dcb.Draw(W, H, pixelTransform, 100);

    // First fill is the DCB background polygon (bottom strip).
    assert.ok(ctx.rec.fills.length >= 1, "at least the background polygon filled");
    const bg = ctx.rec.fills[0];
    const want = [[0, H - Size], [0, H], [W, H], [W, H - Size]];
    for (let i = 0; i < 4; i++)
        assert.ok(near(bg.pts[i][0], want[i][0]) && near(bg.pts[i][1], want[i][1]),
            `bg vertex ${i}: got ${bg.pts[i]} want ${want[i]}`);
    // AdjustedColor(FromArgb(0,35,15), 100) => rgba(0,35,15,1)
    assert.equal(bg.style, "rgba(0,35,15,1)");

    assert.deepEqual(GL.modelview, Matrix4.Identity, "matrix stack unwound");
});

test("DCB hidden -> nothing drawn", () => {
    const ctx = mockCtx();
    GL.init(ctx, 1000, 800); GL.Viewport(0, 0, 1000, 800); GL.LoadIdentity();
    const dcb = new DCB();
    dcb.Visible = false;
    dcb.ActiveMenu = new DCBMenu();
    dcb.Draw(1000, 800, Matrix4.Identity, 100);
    assert.equal(ctx.rec.fills.length, 0);
});
