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
    CursorVisible = true;
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
    get Width() { return this.ClientSize.Width; }   // GameWindow.Width (drawable area)
    get Height() { return this.ClientSize.Height; } // GameWindow.Height
    // NativeWindow.PointToScreen: client-space point → screen coords (offset by window location).
    PointToScreen(p) { return { X: this.Location.X + p.X, Y: this.Location.Y + p.Y }; }
}

// System.Numerics.Vector2 (used by NexradDisplay's ScopeServerWxRadarReport).
export class Vector2 {
    X = 0; Y = 0;
    constructor(x = 0, y = 0) { this.X = x; this.Y = y; }
    static get Zero() { return new Vector2(0, 0); }
}

// OpenTK.Input — mouse button state, key codes, and the polling Keyboard/Mouse statics.
// ADAPTATION: OpenTK polls hardware state; the browser has no synchronous "is key down now?" API.
// The host tracks modifier/button state from DOM key/mouse events and pushes it into these singletons,
// so DGScope's `Keyboard.GetState().IsKeyDown(Key.X)` call-sites transliterate unchanged.
export const ButtonState = Object.freeze({ Released: 0, Pressed: 1 });

// OpenTK.Input.Key — only the codes DGScope references are enumerated (grow as needed).
// KEY-REPRESENTATION CONTRACT (see RadarWindow.ProcessCommand): items in the command KeyList are
// either a C# `char` — modeled as a 1-char JS string — or a `Key` enum value used for named/function
// keys — modeled as a unique Symbol. So `x.GetType()==typeof(char)` transliterates to
// `typeof x === "string"`, and `switch(item){ case Key.F3: … }` matches by Symbol identity.
// Modifier keys (Control/Shift/Alt) are kept as strings matching DOM event.code, since they only
// flow through Keyboard.GetState().IsKeyDown(...) (Set membership), never into the KeyList.
// OpenTK 3.x Key enum's actual INTEGER values (contiguous where the C# relies on ordering:
// A..Z, Number0..9, Keypad0..9, F1..F12). RadarWindow's KeyCode command enum deliberately shares
// this numeric space with the F-keys (F3=InitCntl=12, …), exactly as in DGScope, so KeyToChar /
// #previewMap conflate them the same way the C# `(int)` cast does.
export const Key = Object.freeze({
    Unknown: 0,
    ShiftLeft: 1, LShift: 1, ShiftRight: 2, RShift: 2,
    ControlLeft: 3, LControl: 3, ControlRight: 4, RControl: 4,
    AltLeft: 5, LAlt: 5, AltRight: 6, RAlt: 6,
    WinLeft: 7, LWin: 7, WinRight: 8, RWin: 8, Menu: 9,
    F1: 10, F2: 11, F3: 12, F4: 13, F5: 14, F6: 15, F7: 16, F8: 17, F9: 18, F10: 19, F11: 20, F12: 21,
    F13: 22, F14: 23, F15: 24, F16: 25, F17: 26, F18: 27, F19: 28, F20: 29, F21: 30, F22: 31, F23: 32, F24: 33, F25: 34,
    Up: 45, Down: 46, Left: 47, Right: 48,
    Enter: 49, Escape: 50, Space: 51, Tab: 52, BackSpace: 53, Back: 53, Insert: 54, Delete: 55,
    PageUp: 56, PageDown: 57, Home: 58, End: 59,
    CapsLock: 60, ScrollLock: 61, PrintScreen: 62, Pause: 63, NumLock: 64, Clear: 65, Sleep: 66,
    Keypad0: 67, Keypad1: 68, Keypad2: 69, Keypad3: 70, Keypad4: 71, Keypad5: 72, Keypad6: 73, Keypad7: 74, Keypad8: 75, Keypad9: 76,
    KeypadDivide: 77, KeypadMultiply: 78, KeypadSubtract: 79, KeypadMinus: 79, KeypadAdd: 80, KeypadPlus: 80,
    KeypadDecimal: 81, KeypadPeriod: 81, KeypadEnter: 82,
    A: 83, B: 84, C: 85, D: 86, E: 87, F: 88, G: 89, H: 90, I: 91, J: 92, K: 93, L: 94, M: 95, N: 96,
    O: 97, P: 98, Q: 99, R: 100, S: 101, T: 102, U: 103, V: 104, W: 105, X: 106, Y: 107, Z: 108,
    Number0: 109, Number1: 110, Number2: 111, Number3: 112, Number4: 113, Number5: 114, Number6: 115, Number7: 116, Number8: 117, Number9: 118,
    Tilde: 119, Grave: 119, Minus: 120, Plus: 121, BracketLeft: 122, LBracket: 122, BracketRight: 123, RBracket: 123,
    Semicolon: 124, Quote: 125, Comma: 126, Period: 127, Slash: 128, BackSlash: 129, NonUSBackSlash: 130,
});

// Map of Key symbol → output character (RadarWindow.KeysToString's (int)Key switch, 1:1).
export const KeyToChar = new Map([
    [Key.A, "A"], [Key.B, "B"], [Key.C, "C"], [Key.D, "D"], [Key.E, "E"], [Key.F, "F"], [Key.G, "G"],
    [Key.H, "H"], [Key.I, "I"], [Key.J, "J"], [Key.K, "K"], [Key.L, "L"], [Key.M, "M"], [Key.N, "N"],
    [Key.O, "O"], [Key.P, "P"], [Key.Q, "Q"], [Key.R, "R"], [Key.S, "S"], [Key.T, "T"], [Key.U, "U"],
    [Key.V, "V"], [Key.W, "W"], [Key.X, "X"], [Key.Y, "Y"], [Key.Z, "Z"],
    [Key.Keypad0, "0"], [Key.Number0, "0"], [Key.Keypad1, "1"], [Key.Number1, "1"], [Key.Keypad2, "2"], [Key.Number2, "2"],
    [Key.Keypad3, "3"], [Key.Number3, "3"], [Key.Keypad4, "4"], [Key.Number4, "4"], [Key.Keypad5, "5"], [Key.Number5, "5"],
    [Key.Keypad6, "6"], [Key.Number6, "6"], [Key.Keypad7, "7"], [Key.Number7, "7"], [Key.Keypad8, "8"], [Key.Number8, "8"],
    [Key.Keypad9, "9"], [Key.Number9, "9"], [Key.Period, "."], [Key.KeypadPeriod, "."], [Key.Plus, "+"], [Key.KeypadPlus, "+"],
]);

// Live keyboard state — the host sets/clears entries from DOM keydown/keyup.
class KeyboardState {
    #down = new Set();
    IsKeyDown(key) { return this.#down.has(key); }
    _set(key, isDown) { if (isDown) this.#down.add(key); else this.#down.delete(key); }
}
const _keyboardState = new KeyboardState();
export const Keyboard = { GetState() { return _keyboardState; }, _state: _keyboardState };

// OpenTK.Input.Mouse.SetPosition warps the OS cursor — impossible in the browser (security). No-op.
export const Mouse = { SetPosition(x, y) { /* cursor warp not permitted in the browser — no-op */ } };

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
