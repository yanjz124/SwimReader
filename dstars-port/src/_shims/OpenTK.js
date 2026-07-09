// Shim for the OpenTK math types DGScope uses (Matrix4, Vector4), reproducing OpenTK's
// EXACT semantics: row-major storage, row-vector convention (v' = v * M), and the same
// Create*/multiply formulas. This is what makes the GL shim's vertex pipeline faithful.
//
// Row indexing matches OpenTK: M{row}{col}, rows 1..4. Translation lives in Row4 (M41..M43),
// so Vector4(a,b,c,1) * CreateTranslation(x,y,z) = (a+x, b+y, c+z, 1).

export class Matrix4 {
    // 16 elements, row-major.
    M11 = 0; M12 = 0; M13 = 0; M14 = 0;
    M21 = 0; M22 = 0; M23 = 0; M24 = 0;
    M31 = 0; M32 = 0; M33 = 0; M34 = 0;
    M41 = 0; M42 = 0; M43 = 0; M44 = 0;

    static get Identity() {
        const m = new Matrix4();
        m.M11 = 1; m.M22 = 1; m.M33 = 1; m.M44 = 1;
        return m;
    }

    static CreateTranslation(x, y, z) {
        const m = Matrix4.Identity;
        m.M41 = x; m.M42 = y; m.M43 = z;
        return m;
    }

    static CreateScale(x, y, z) {
        // OpenTK also has CreateScale(scalar); DGScope only uses the (x,y,z) form.
        const m = new Matrix4();
        m.M11 = x; m.M22 = y; m.M33 = z; m.M44 = 1;
        return m;
    }

    static CreateRotationZ(angle) {
        const cos = Math.cos(angle), sin = Math.sin(angle);
        const m = Matrix4.Identity;
        // OpenTK: Row0=(cos,sin,0,0) Row1=(-sin,cos,0,0)
        m.M11 = cos; m.M12 = sin;
        m.M21 = -sin; m.M22 = cos;
        return m;
    }

    // OpenTK Matrix4.Mult(a,b) — standard row-major product, result.Mij = Σk a.Mik * b.Mkj.
    static Mult(a, b) {
        const r = new Matrix4();
        for (let i = 1; i <= 4; i++)
            for (let j = 1; j <= 4; j++) {
                let s = 0;
                for (let k = 1; k <= 4; k++) s += a["M" + i + k] * b["M" + k + j];
                r["M" + i + j] = s;
            }
        return r;
    }
    // a * b  (OpenTK operator*)
    mul(b) { return Matrix4.Mult(this, b); }
    clone() { return Object.assign(new Matrix4(), this); }
}

// OpenTK.WindowState (GameWindow state).
export const WindowState = Object.freeze({ Normal: 0, Minimized: 1, Maximized: 2, Fullscreen: 3 });
export const VSyncMode = Object.freeze({ Off: 0, On: 1, Adaptive: 2 });

// OpenTK.GameWindow — the windowing/GL host. Ported as a stub with the members RadarWindow reads
// (WindowState/TargetRenderFrequency/VSync/Size/Location/ClientSize). The browser host binds a
// real <canvas> size into ClientSize; render loop is driven by the host (requestAnimationFrame).
import { EventHandler } from "./DotNetEvent.js";
export class GameWindow {
    Title = "";
    WindowState = WindowState.Normal;
    TargetRenderFrequency = 60;
    VSync = VSyncMode.On;
    ClientSize = { Width: 0, Height: 0 };
    Size = { Width: 0, Height: 0 };
    Location = { X: 0, Y: 0 };
    // OpenTK window events RadarWindow.Initialize() subscribes to (`window.Load += …`).
    // The browser host raises these from requestAnimationFrame / DOM listeners.
    Load = new EventHandler();
    Closing = new EventHandler();
    RenderFrame = new EventHandler();
    UpdateFrame = new EventHandler();
    Resize = new EventHandler();
    WindowStateChanged = new EventHandler();
    KeyDown = new EventHandler();
    KeyPress = new EventHandler();
    KeyUp = new EventHandler();
    MouseWheel = new EventHandler();
    MouseMove = new EventHandler();
    MouseDown = new EventHandler();
    MouseUp = new EventHandler();
    constructor(width = 0, height = 0) {
        this.ClientSize = { Width: width, Height: height };
        this.Size = { Width: width, Height: height };
    }
    // OpenTK GameWindow.Run() enters a blocking render loop. In the browser the host drives the
    // loop via requestAnimationFrame and raises Load/RenderFrame/UpdateFrame itself, so this is a
    // no-op entry point (the host calls Load.Invoke then schedules RenderFrame).
    Run() { this.Load.Invoke(this, {}); }
}

// System.Numerics.Vector2 (used by NexradDisplay's ScopeServerWxRadarReport).
export class Vector2 {
    X = 0; Y = 0;
    constructor(x = 0, y = 0) { this.X = x; this.Y = y; }
    static get Zero() { return new Vector2(0, 0); }
}

export class Vector4 {
    X = 0; Y = 0; Z = 0; W = 0;
    constructor(x = 0, y = 0, z = 0, w = 0) { this.X = x; this.Y = y; this.Z = z; this.W = w; }
    static get Zero() { return new Vector4(0, 0, 0, 0); }

    // row-vector * matrix: result.X = X*M11 + Y*M21 + Z*M31 + W*M41, etc.
    static Transform(v, m) {
        return new Vector4(
            v.X * m.M11 + v.Y * m.M21 + v.Z * m.M31 + v.W * m.M41,
            v.X * m.M12 + v.Y * m.M22 + v.Z * m.M32 + v.W * m.M42,
            v.X * m.M13 + v.Y * m.M23 + v.Z * m.M33 + v.W * m.M43,
            v.X * m.M14 + v.Y * m.M24 + v.Z * m.M34 + v.W * m.M44,
        );
    }
    // v *= matrix  (OpenTK Vector4 *= Matrix4)
    mulEq(m) { const r = Vector4.Transform(this, m); this.X = r.X; this.Y = r.Y; this.Z = r.Z; this.W = r.W; return this; }
}
