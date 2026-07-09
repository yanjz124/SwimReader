import { test } from "node:test";
import assert from "node:assert/strict";
import { GL, PrimitiveType } from "../src/_shims/GL.js";
import { Matrix4 } from "../src/_shims/OpenTK.js";
import { Color } from "../src/_shims/SystemDrawing.js";

// Minimal recording 2D context — captures path ops so we can assert geometry.
function mockCtx() {
    const rec = { paths: [], fills: [], strokes: [], cur: null, fillStyle: "", strokeStyle: "", lineWidth: 1, globalCompositeOperation: "" };
    return {
        rec,
        save() {}, restore() {}, setTransform() {},
        beginPath() { rec.cur = []; },
        moveTo(x, y) { rec.cur.push([x, y]); },
        lineTo(x, y) { rec.cur.push([x, y]); },
        closePath() { if (rec.cur) rec.cur.closed = true; },
        fill() { rec.paths.push(rec.cur); rec.fills.push({ pts: rec.cur, style: this.fillStyle }); },
        stroke() { rec.strokes.push({ pts: rec.cur, style: this.strokeStyle }); },
        fillRect() {},
        set fillStyle(v) { rec.fillStyle = v; }, get fillStyle() { return rec.fillStyle; },
        set strokeStyle(v) { rec.strokeStyle = v; }, get strokeStyle() { return rec.strokeStyle; },
        set lineWidth(v) { rec.lineWidth = v; }, get lineWidth() { return rec.lineWidth; },
        set globalCompositeOperation(v) { rec.globalCompositeOperation = v; }, get globalCompositeOperation() { return rec.globalCompositeOperation; },
    };
}

const near = (a, b, t = 1e-6) => Math.abs(a - b) < t;

test("GL replays DCB bottom-bar polygon to correct canvas pixels", () => {
    const W = 1000, H = 800, Size = 80;
    const ctx = mockCtx();
    GL.init(ctx, W, H);
    GL.Viewport(0, 0, W, H);
    GL.LoadIdentity();

    const pixelTransform = Matrix4.CreateTranslation(-W / 2, -H / 2, 0).mul(Matrix4.CreateScale(2 / W, -2 / H, 1));

    // ---- exactly the calls DCB.Draw makes for a Bottom (non-vertical) bar ----
    GL.PushMatrix();
    GL.MultMatrix(pixelTransform);
    GL.PushMatrix();
    GL.Translate(0, H - Size, 0);         // drawloc for Bottom
    GL.Begin(PrimitiveType.Polygon);
    GL.Color4(Color.FromArgb(0, 35, 15)); // AdjustedColor input in DCB
    GL.Vertex2(0, 0);
    GL.Vertex2(0, Size);
    GL.Vertex2(W, Size);
    GL.Vertex2(W, 0);
    GL.End();
    GL.PopMatrix();
    GL.PopMatrix();

    assert.equal(ctx.rec.fills.length, 1, "one filled polygon");
    const pts = ctx.rec.fills[0].pts;
    assert.equal(pts.closed, true, "polygon closed");
    const want = [[0, H - Size], [0, H], [W, H], [W, H - Size]];
    for (let i = 0; i < 4; i++)
        assert.ok(near(pts[i][0], want[i][0]) && near(pts[i][1], want[i][1]),
            `vertex ${i}: got ${pts[i]} want ${want[i]}`);
    assert.equal(ctx.rec.fills[0].style, "rgba(0,35,15,1)", "fill color from Color.FromArgb");

    // matrix stack fully unwound
    assert.deepEqual(GL.modelview, Matrix4.Identity);
});

test("GL.Lines strokes vertex pairs", () => {
    const ctx = mockCtx();
    GL.init(ctx, 200, 200); GL.Viewport(0, 0, 200, 200); GL.LoadIdentity();
    // identity modelview: v*(I) then NDC map. Use NDC-space verts directly.
    GL.Begin(PrimitiveType.Lines);
    GL.Color3(0, 1, 0);
    GL.Vertex2(-1, -1); // -> canvas (0,200)
    GL.Vertex2(1, 1);   // -> canvas (200,0)
    GL.End();
    assert.equal(ctx.rec.strokes.length, 1);
    const p = ctx.rec.strokes[0].pts;
    assert.ok(near(p[0][0], 0) && near(p[0][1], 200));
    assert.ok(near(p[1][0], 200) && near(p[1][1], 0));
    assert.equal(ctx.rec.strokes[0].style, "rgba(0,255,0,1)");
});
