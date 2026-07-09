// Minimal shims for the few System.Windows.Forms bits the scope-rendering code touches.
// Full WinForms Forms/controls are ported/stubbed per-file; this holds cross-cutting statics.

// System.Windows.Forms.Cursor — DGScope sets Cursor.Clip to confine the mouse to a submenu.
// The browser has no equivalent (Pointer Lock is the closest); no-op with the value retained.
export const Cursor = {
    _clip: null,
    set Clip(rect) { this._clip = rect; /* no-op: browser can't clip the OS cursor */ },
    get Clip() { return this._clip; },
};

// System.Windows.Forms.RightToLeft
export const RightToLeft = Object.freeze({ No: 0, Yes: 1, Inherit: 2 });

// System.Windows.Forms.DialogResult
export const DialogResult = Object.freeze({ None: 0, OK: 1, Cancel: 2, Abort: 3, Retry: 4, Ignore: 5, Yes: 6, No: 7 });

// System.Windows.Forms.Clipboard.SetText — browser clipboard write is async & permission-gated,
// so this fires navigator.clipboard.writeText and ignores the promise (C#'s call is void/sync).
export const Clipboard = {
    SetText(text) { try { globalThis.navigator?.clipboard?.writeText(String(text)); } catch { /* clipboard unavailable */ } },
};
