// Shim for System.Threading.Timer / TimerCallback used by RadarWindow's periodic tasks
// (aircraft garbage-collect, weather update, data-block timeshare). Maps to setTimeout for
// the initial dueTime then setInterval for the recurring period. In Node the handles are
// .unref()'d so a lingering timer never keeps the test process alive.

// System.Threading.TimerCallback — a delegate; modeled as identity (the wrapped function IS the callback).
export function TimerCallback(fn) { return fn; }

// System.Threading.Tasks.Task — only Task.Run(Action) / Task.WhenAll are used.
// Task.Run schedules the delegate off the current tick (fire-and-forget microtask), matching
// C#'s "run on a thread-pool thread" for the side-effecting delegates DGScope passes.
export const Task = {
    Run(fn) { return Promise.resolve().then(fn); },
    WhenAll(tasks) { return Promise.all(tasks); },
    Delay(ms) { return new Promise(res => { const t = setTimeout(res, ms); if (t && t.unref) t.unref(); }); },
};

export class Timer {
    #callback; #state; #timeout = null; #handle = null;
    // new Timer(TimerCallback callback, object state, int dueTime, int period)  [ms]
    constructor(callback, state, dueTime, period) {
        this.#callback = callback; this.#state = state;
        this.Change(dueTime, period);
    }
    Change(dueTime, period) {
        this.Dispose();
        const fire = () => { try { this.#callback(this.#state); } catch { /* swallow — matches Timer thread */ } };
        this.#timeout = setTimeout(() => {
            fire();
            if (period > 0 && period !== 0x7fffffff /* Timeout.Infinite */) {
                this.#handle = setInterval(fire, period);
                if (this.#handle && this.#handle.unref) this.#handle.unref();
            }
        }, dueTime);
        if (this.#timeout && this.#timeout.unref) this.#timeout.unref();
        return true;
    }
    Dispose() {
        if (this.#timeout != null) { clearTimeout(this.#timeout); this.#timeout = null; }
        if (this.#handle != null) { clearInterval(this.#handle); this.#handle = null; }
    }
}
