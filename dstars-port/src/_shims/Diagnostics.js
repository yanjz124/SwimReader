// System.Diagnostics.Stopwatch shim (high-res elapsed timing).
function nowMs() { return (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now(); }

export class Stopwatch {
    #start = null; // null = not running
    #frozen = 0;   // accumulated ms while stopped
    static StartNew() { const s = new Stopwatch(); s.Restart(); return s; }
    Start() { if (this.#start == null) this.#start = nowMs(); }
    Restart() { this.#frozen = 0; this.#start = nowMs(); }
    Stop() { if (this.#start != null) { this.#frozen += nowMs() - this.#start; this.#start = null; } }
    Reset() { this.#start = null; this.#frozen = 0; }
    get IsRunning() { return this.#start != null; }
    get ElapsedMilliseconds() { return Math.trunc(this.#start == null ? this.#frozen : (this.#frozen + (nowMs() - this.#start))); }
    // Elapsed as a TimeSpan-like value (TotalSeconds/TotalMilliseconds/Ticks) for callers like TimeSync.
    get Elapsed() {
        const ms = this.#start == null ? this.#frozen : (this.#frozen + (nowMs() - this.#start));
        return { TotalMilliseconds: ms, TotalSeconds: ms / 1000, Ticks: ms * 10000 };
    }
}
