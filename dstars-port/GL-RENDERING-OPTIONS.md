# GL rendering — options for porting RadarWindow's draw loop

DGScope renders through **OpenTK immediate-mode OpenGL** on a WinForms `GLControl`:
`GL.Begin(PrimitiveType.Polygon)` / `GL.Vertex2(x,y)` / `GL.Color4(c)` / `GL.PushMatrix` /
`GL.MultMatrix(ref m)` / `GL.Translate` / `GL.LineWidth` / `GL.End`, plus `Matrix4` / `Vector4`.
`RadarWindow.cs` (6,962 lines) and `DCB`/`DCBButton`/`DCBMenu`/`PrimaryReturn`/`NexradDisplay`
are almost entirely these calls. Whatever we choose here decides how faithful the port of the
single largest file can be.

## Option A — 2D Canvas rewrite
Re-express each GL draw as an idiomatic HTML5 Canvas 2D op (`beginPath`/`lineTo`/`fill`,
`setTransform`, `fillText`).
- ➖ **Not 1:1.** Every `GL.Begin/Vertex2/End` becomes a *different* shape of code, so the
  transliteration diverges structurally from the source — exactly the "creativity" you want to avoid.
- ➖ Matrix stack (`PushMatrix`/`MultMatrix`) must be re-implemented by hand at each call site.
- ➕ Simplest runtime; no shim layer.

## Option B — WebGL (retained-mode)
Port to raw WebGL with vertex buffers + shaders.
- ➖ WebGL has **no immediate mode** — there is no `glBegin/glVertex`. The source's per-vertex
  calls can't map directly; you must batch into buffers, so RadarWindow is effectively rewritten.
- ➖ Most complex; shaders, buffer management, text is hard (no `fillText`).
- ➕ Fastest for NEXRAD/history-heavy scenes.

## Option C — Immediate-mode GL emulation shim  ⭐ recommended
Build one shim, `src/_shims/GL.js`, that implements **the exact OpenTK API the code calls**
(`GL.Begin/End/Vertex2/Color4/PushMatrix/PopMatrix/MultMatrix/Translate/LineWidth/…` + `Matrix4`,
`Vector4`), backed internally by Canvas 2D (a matrix stack + path batching between `Begin`/`End`).
- ➕ **RadarWindow transliterates ~verbatim** — `GL.Begin(...)`, `GL.Vertex2(...)`, `GL.End()`
  stay as-is. Fidelity is maximal; my "creativity" is confined to the ONE shim file.
- ➕ You review the shim **once**; after that the 7,000-line port is mechanical like everything else.
- ➕ Canvas 2D backing gives easy text (`fillText`) for data blocks, and maps cleanly to STARS's
  lines/polygons/points.
- ➖ One upfront shim to build + validate (est. a few hundred lines). Slightly slower than hand-tuned
  WebGL for very heavy weather frames (can swap the shim's internals to WebGL later without touching
  RadarWindow).

## Recommendation
**Option C.** It's the only choice consistent with the project's whole premise — a faithful,
low-creativity transliteration. The shim becomes the single reviewable "adaptation" for all GL,
and every rendering file (RadarWindow, DCB*, PrimaryReturn, Aircraft's stubbed `RedrawDataBlock`)
then ports the same mechanical way the logic tier did.

Sequence if C is chosen:
1. Build `_shims/GL.js` (Canvas2D-backed immediate-mode emulation) + `Matrix4`/`Vector4`. **← you review this**
2. Un-stub the small GL files first (DCB, then DCBButton/DCBMenu) to validate the shim on real code.
3. Un-stub `Aircraft.RedrawDataBlock`/`RedrawTarget` (needs `TransparentLabel` — a Canvas text label).
4. Port `RadarWindow.cs` in chunks against the manifest.
