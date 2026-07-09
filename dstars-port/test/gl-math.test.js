import { test } from "node:test";
import assert from "node:assert/strict";
import { Matrix4, Vector4 } from "../src/_shims/OpenTK.js";

const approx = (a, b, t = 1e-9) => Math.abs(a - b) < t;

test("CreateTranslation via row-vector multiply", () => {
    const v = new Vector4(1, 2, 3, 1);
    const r = Vector4.Transform(v, Matrix4.CreateTranslation(10, 20, 30));
    assert.deepEqual([r.X, r.Y, r.Z, r.W], [11, 22, 33, 1]);
});

test("CreateScale via row-vector multiply", () => {
    const v = new Vector4(2, 3, 4, 1);
    const r = Vector4.Transform(v, Matrix4.CreateScale(2, 0.5, 10));
    assert.deepEqual([r.X, r.Y, r.Z], [4, 1.5, 40]);
});

test("CreateRotationZ 90deg maps +X to +Y (OpenTK orientation)", () => {
    const v = new Vector4(1, 0, 0, 1);
    const r = Vector4.Transform(v, Matrix4.CreateRotationZ(Math.PI / 2));
    assert.ok(approx(r.X, 0) && approx(r.Y, 1), `got ${r.X},${r.Y}`);
});

test("A*=B then v*(A*B) == (v*A)*B (associativity / compose order)", () => {
    const A = Matrix4.CreateTranslation(5, 0, 0);
    const B = Matrix4.CreateScale(2, 2, 2);
    const AB = A.mul(B); // translate-then-scale
    const v = new Vector4(1, 1, 0, 1);
    const viaCompose = Vector4.Transform(v, AB);
    const viaSteps = Vector4.Transform(Vector4.Transform(v, A), B);
    assert.ok(approx(viaCompose.X, viaSteps.X) && approx(viaCompose.Y, viaSteps.Y));
    // translate (1,1)->(6,1) then scale x2 -> (12,2)
    assert.ok(approx(viaCompose.X, 12) && approx(viaCompose.Y, 2), `got ${viaCompose.X},${viaCompose.Y}`);
});

// The load-bearing test: reproduce DCB.Draw's exact transform and confirm a bottom-DCB
// polygon vertex lands at the expected canvas pixel.
test("DCB pixelTransform + translate places vertex correctly", () => {
    const W = 1000, H = 800, Size = 80;
    // pixeltransform = CreateTranslation(-W/2,-H/2,0) *= CreateScale(2/W,-2/H,1)
    const pixelTransform = Matrix4.CreateTranslation(-W / 2, -H / 2, 0).mul(Matrix4.CreateScale(2 / W, -2 / H, 1));

    // GL modelview stack (pre-multiply convention): MultMatrix(pixelTransform) then Translate(0,H-Size,0)
    let modelview = Matrix4.Identity;
    modelview = pixelTransform.mul(modelview);                         // MultMatrix -> pixelTransform * I
    modelview = Matrix4.CreateTranslation(0, H - Size, 0).mul(modelview); // Translate (pre-mult)

    // Bottom-DCB local vertex (0,0) -> NDC -> canvas pixel
    const clip = Vector4.Transform(new Vector4(0, 0, 0, 1), modelview);
    const ndcX = clip.X / clip.W, ndcY = clip.Y / clip.W;
    const canvasX = (ndcX + 1) / 2 * W;
    const canvasY = (1 - ndcY) / 2 * H;
    assert.ok(approx(canvasX, 0) && approx(canvasY, H - Size), `vertex(0,0) -> canvas ${canvasX},${canvasY} (want 0,${H - Size})`);

    // local vertex (W, Size) -> should land at bottom-right corner of the bar: (W, H)
    const clip2 = Vector4.Transform(new Vector4(W, Size, 0, 1), modelview);
    const cx2 = (clip2.X / clip2.W + 1) / 2 * W;
    const cy2 = (1 - clip2.Y / clip2.W) / 2 * H;
    assert.ok(approx(cx2, W) && approx(cy2, H), `vertex(W,Size) -> canvas ${cx2},${cy2} (want ${W},${H})`);
});
