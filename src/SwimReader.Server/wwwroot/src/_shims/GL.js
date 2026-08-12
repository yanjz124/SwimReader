// Immediate-mode OpenGL (OpenTK) emulation on HTML5 Canvas 2D.
//
// DGScope calls OpenTK's static `GL.*` API. This shim reproduces exactly the subset it uses
// (surveyed from _source): Begin/End/Vertex2/Color3/Color4/TexCoord2, the modelview matrix
// stack (PushMatrix/PopMatrix/MultMatrix/Translate/Rotate/Scale/LoadIdentity/Ortho), viewport
// + clear, blend/enable state, LineWidth, and textures. So RadarWindow's GL calls transliterate
// verbatim.
//
// Pipeline (validated in test/gl-math.test.js): a vertex Vector4(x,y,0,1) is transformed as a
// ROW vector by the modelview then projection (v' = v * M), giving clip/NDC coords; the viewport
// maps NDC (-1..1, y-up) to canvas pixels. Matrix ops PRE-multiply (newOp * modelview), which
// reproduces GL's "last-specified transform applied first to the vertex" behavior.
import { Matrix4, Vector4 } from "./OpenTK.js";
import { Color } from "./SystemDrawing.js";

export const PrimitiveType = Object.freeze({ Polygon: 0, Lines: 1, Quads: 2, LineLoop: 3, LineStrip: 4, TriangleFan: 5, Triangles: 6 });
export const EnableCap = Object.freeze({ Blend: 0, PolygonStipple: 1, Texture2D: 2 });
export const BlendingFactor = Object.freeze({ SrcAlpha: 0, OneMinusSrcAlpha: 1, One: 2, Zero: 3 });
export const BlendEquationMode = Object.freeze({ FuncAdd: 0, Max: 1, Min: 2 });
export const ClearBufferMask = Object.freeze({ ColorBufferBit: 0x4000, DepthBufferBit: 0x100 });
export const TextureTarget = Object.freeze({ Texture2D: 0 });
export const TextureParameterName = Object.freeze({ TextureMagFilter: 0, TextureMinFilter: 1, TextureWrapS: 2, TextureWrapT: 3 });
export const PixelFormat = Object.freeze({ Bgra: 0, Rgba: 1 });
export const PixelType = Object.freeze({ UnsignedByte: 0 });
export const PixelInternalFormat = Object.freeze({ Rgba: 0 });
export const TextureMagFilter = Object.freeze({ Nearest: 0, Linear: 1 });
export const TextureMinFilter = Object.freeze({ Nearest: 0, Linear: 1 });
export const TextureWrapMode = Object.freeze({ ClampToEdge: 0, Repeat: 1 });

function colorFrom(args) {
    // GL.Color3/Color4 overloads: (Color) | (r,g,b[,a]) as floats 0..1 (OpenTK float overload).
    // Returns { css, r, g, b, a } — the parsed channels are needed to modulate textured quads (GL_MODULATE).
    let r, g, b, a;
    if (args.length === 1 && args[0] instanceof Color) {
        r = args[0].R; g = args[0].G; b = args[0].B; a = args[0].A / 255;
    } else {
        const [fr, fg, fb, fa = 1] = args;
        r = Math.round(fr * 255); g = Math.round(fg * 255); b = Math.round(fb * 255); a = fa;
    }
    return { css: `rgba(${r},${g},${b},${a})`, r, g, b, a };
}

export class GL {
    // ── bound canvas + pipeline state ──
    static ctx = null;         // CanvasRenderingContext2D
    static vpW = 0;            // viewport width  (GL.Viewport)
    static vpH = 0;            // viewport height
    static modelview = Matrix4.Identity;
    static projection = Matrix4.Identity;
    static #stack = [];
    static #clearColor = "rgba(0,0,0,1)";
    static #color = "rgba(0,255,0,1)";
    static #colorRGBA = { r: 0, g: 255, b: 0, a: 1 }; // parsed current color, for GL_MODULATE on textures
    static #tintScratch = null;                        // reused offscreen canvas for texture tinting
    static #lineWidth = 1;
    static #mode = null;       // current Begin() primitive
    static #verts = [];        // collected canvas-space points for the current primitive
    static #uvs = [];          // texcoords (textured quads)
    static #texEnabled = false;
    static #boundTex = 0;
    static #textures = new Map(); // id -> { canvas } (uploaded image)
    static #nextTexId = 1;
    static #curUV = [0, 0];

    /** Bind a 2D canvas context. (Setup helper — not part of OpenTK.) */
    static init(ctx, width, height) { GL.ctx = ctx; GL.vpW = width; GL.vpH = height; }

    static Viewport(x, y, w, h) { GL.vpW = w; GL.vpH = h; }

    static ClearColor(color) { GL.#clearColor = (color instanceof Color) ? color.toCanvasRgba() : color; }
    static Clear(_mask) {
        const c = GL.ctx; if (!c) return;
        c.save(); c.setTransform(1, 0, 0, 1, 0, 0);
        c.fillStyle = GL.#clearColor; c.fillRect(0, 0, GL.vpW, GL.vpH);
        c.restore();
    }

    static Enable(cap) { if (cap === EnableCap.Texture2D) GL.#texEnabled = true; }
    static Disable(cap) { if (cap === EnableCap.Texture2D) GL.#texEnabled = false; }
    static BlendFunc(_s, _d) { /* canvas default is source-over (SrcAlpha, OneMinusSrcAlpha) */ }
    static BlendEquation(mode) {
        // FuncAdd -> source-over; Max -> 'lighten' (used for weather). Applied per-draw in End().
        GL.#blendMode = (mode === BlendEquationMode.Max) ? "lighten" : "source-over";
    }
    static #blendMode = "source-over";
    static LineWidth(w) { GL.#lineWidth = w; }
    static Flush() { /* no-op */ }
    static PolygonStipple(_pattern) { /* TODO: stipple pattern (used once); no-op for now */ }

    // ── matrix stack ──
    static LoadIdentity() { GL.modelview = Matrix4.Identity; }
    static PushMatrix() { GL.#stack.push(GL.modelview.clone()); }
    static PopMatrix() { GL.modelview = GL.#stack.pop() ?? Matrix4.Identity; }
    static MultMatrix(m) { GL.modelview = m.mul(GL.modelview); }         // pre-multiply
    static Translate(x, y, z) { GL.modelview = Matrix4.CreateTranslation(x, y, z).mul(GL.modelview); }
    static Scale(x, y, z) { GL.modelview = Matrix4.CreateScale(x, y, z).mul(GL.modelview); }
    static Rotate(angleDeg, x, y, z) {
        // DGScope rotates about +Z; reproduce that (other axes not used in the 2D scope).
        GL.modelview = Matrix4.CreateRotationZ(angleDeg * Math.PI / 180).mul(GL.modelview);
    }
    static Ortho(left, right, bottom, top, near, far) {
        // Standard orthographic projection (OpenTK/GL). Used for texture-to-screen blits.
        const m = new Matrix4();
        m.M11 = 2 / (right - left); m.M22 = 2 / (top - bottom); m.M33 = -2 / (far - near); m.M44 = 1;
        m.M41 = -(right + left) / (right - left);
        m.M42 = -(top + bottom) / (top - bottom);
        m.M43 = -(far + near) / (far - near);
        GL.projection = m;
    }

    // ── colors ──
    static Color4(...args) { const col = colorFrom(args); GL.#color = col.css; GL.#colorRGBA = col; }
    static Color3(...args) { const col = colorFrom(args.length === 1 ? args : [args[0], args[1], args[2], 1]); GL.#color = col.css; GL.#colorRGBA = col; }

    // ── immediate mode ──
    static Begin(mode) { GL.#mode = mode; GL.#verts = []; GL.#uvs = []; }
    static TexCoord2(u, v) { GL.#curUV = [u, v]; }
    static Vertex2(x, y) {
        // v * modelview * projection -> NDC -> canvas pixels
        let clip = Vector4.Transform(new Vector4(x, y, 0, 1), GL.modelview);
        clip = Vector4.Transform(clip, GL.projection);
        const ndcX = clip.X / clip.W, ndcY = clip.Y / clip.W;
        GL.#verts.push([(ndcX + 1) / 2 * GL.vpW, (1 - ndcY) / 2 * GL.vpH]);
        GL.#uvs.push(GL.#curUV.slice());
    }

    static End() {
        const c = GL.ctx, pts = GL.#verts;
        GL.#mode_saved = GL.#mode; GL.#mode = null;
        if (!c || pts.length === 0) return;
        c.save();
        c.setTransform(1, 0, 0, 1, 0, 0);          // we pre-transform vertices ourselves
        c.globalCompositeOperation = GL.#blendMode;
        c.fillStyle = GL.#color; c.strokeStyle = GL.#color; c.lineWidth = GL.#lineWidth;

        if (GL.#texEnabled && GL.#boundTex && GL.#mode_saved === PrimitiveType.Quads) {
            GL.#drawTexturedQuads(c, pts, GL.#uvs);
        } else {
            switch (GL.#mode_saved) {
                case PrimitiveType.Polygon:
                case PrimitiveType.TriangleFan:
                    GL.#path(c, pts, true); c.fill(); break;
                case PrimitiveType.Quads:
                    for (let i = 0; i + 3 < pts.length; i += 4) { GL.#path(c, pts.slice(i, i + 4), true); c.fill(); }
                    break;
                case PrimitiveType.Triangles:
                    for (let i = 0; i + 2 < pts.length; i += 3) { GL.#path(c, pts.slice(i, i + 3), true); c.fill(); }
                    break;
                case PrimitiveType.Lines:
                    for (let i = 0; i + 1 < pts.length; i += 2) { c.beginPath(); c.moveTo(...pts[i]); c.lineTo(...pts[i + 1]); c.stroke(); }
                    break;
                case PrimitiveType.LineLoop:
                    GL.#path(c, pts, true); c.stroke(); break;
                case PrimitiveType.LineStrip:
                    GL.#path(c, pts, false); c.stroke(); break;
            }
        }
        c.restore();
    }
    static #mode_saved = null;
    static #path(c, pts, close) {
        c.beginPath(); c.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
        if (close) c.closePath();
    }

    // ── textures (first cut: axis-aligned quads, sufficient for NEXRAD/history tiles) ──
    static GenTexture() { const id = GL.#nextTexId++; GL.#textures.set(id, { canvas: null }); return id; }
    static BindTexture(_target, id) { GL.#boundTex = id; }
    static DeleteTexture(id) { GL.#textures.delete(id); }
    static TexParameter(_t, _pname, _param) { /* filtering/wrap — canvas handles smoothing itself */ }
    static TexImage2D(_target, _level, _internal, w, h, _border, _fmt, _type, pixels) {
        // pixels: a Uint8Array (RGBA/BGRA) OR an ImageBitmap/HTMLCanvas the caller already built.
        const tex = GL.#textures.get(GL.#boundTex) || {};
        if (pixels && pixels.width) { tex.canvas = pixels; }        // already an image/canvas
        else if (pixels && GL.ctx) {
            const off = new OffscreenCanvas(w, h);
            const octx = off.getContext("2d");
            octx.putImageData(new ImageData(new Uint8ClampedArray(pixels.buffer || pixels), w, h), 0, 0);
            tex.canvas = off;
        }
        GL.#textures.set(GL.#boundTex, tex);
    }
    static #drawTexturedQuads(c, pts, uvs) {
        const tex = GL.#textures.get(GL.#boundTex);
        if (!tex || !tex.canvas) return;
        // GL_MODULATE: fragment = texture.rgb × color.rgb, alpha = texture.a × color.a. DGScope draws
        // WHITE text into the texture and tints it with GL.Color3(color), so this modulation is what
        // makes labels/DCB text their intended color. A white opaque color leaves the texture unchanged
        // (e.g. NEXRAD tiles drawn with Color=white).
        const col = GL.#colorRGBA;
        const white = col.r >= 255 && col.g >= 255 && col.b >= 255;
        const src = (white && col.a >= 1) ? tex.canvas : GL.#tintTexture(tex.canvas, col);
        const prevA = c.globalAlpha;
        if (!white || col.a < 1) c.globalAlpha = col.a; // modulate alpha
        for (let i = 0; i + 3 < pts.length; i += 4) {
            const xs = pts.slice(i, i + 4).map(p => p[0]), ys = pts.slice(i, i + 4).map(p => p[1]);
            const x0 = Math.min(...xs), y0 = Math.min(...ys), x1 = Math.max(...xs), y1 = Math.max(...ys);
            c.drawImage(src, x0, y0, x1 - x0, y1 - y0); // axis-aligned approximation
        }
        c.globalAlpha = prevA;
    }
    // Multiply a texture's RGB by (r,g,b) while preserving its alpha mask — Canvas2D GL_MODULATE.
    static #tintTexture(canvas, col) {
        const w = canvas.width, h = canvas.height;
        let t = GL.#tintScratch;
        if (!t || t.width !== w || t.height !== h) t = GL.#tintScratch = new OffscreenCanvas(w, h);
        const tc = t.getContext("2d");
        tc.globalCompositeOperation = "source-over";
        tc.clearRect(0, 0, w, h);
        tc.globalAlpha = 1;
        tc.drawImage(canvas, 0, 0);
        tc.globalCompositeOperation = "multiply";          // texture.rgb × color.rgb (also fills transparent px)
        tc.fillStyle = `rgb(${col.r},${col.g},${col.b})`;
        tc.fillRect(0, 0, w, h);
        tc.globalCompositeOperation = "destination-in";     // restore texture's alpha mask
        tc.drawImage(canvas, 0, 0);
        return t;
    }
}
