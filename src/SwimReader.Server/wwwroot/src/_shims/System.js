// Shims for a few top-level System.* members DGScope calls.

// System.Environment.Exit(code) — terminates the process. In the browser there is no process to
// exit; close the window if the host allows it, else no-op. Under Node (tests) it maps to process.exit.
export const Environment = {
    Exit(code = 0) {
        if (typeof process !== "undefined" && process.exit) process.exit(code);
        else if (globalThis.window && globalThis.window.close) globalThis.window.close();
        // else: no-op (screensaver auto-exit path; the host tears the scope down instead)
    },
};
