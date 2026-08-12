// Ported 1:1 from _source/TimeSync.cs
// namespace DGScope
// Yort.Ntp (NTP over UDP) is IMPOSSIBLE in the browser -> Resync is a no-op, Synchronized stays
// false, and CurrentTime() falls back to the system clock (DateTime.UtcNow -> new Date()).
import { Stopwatch } from "./_shims/Diagnostics.js";

export class TimeSync {
    static #stopwatch = new Stopwatch();   // private static Stopwatch
    static #syncTime = new Date();          // private static DateTime syncTime = DateTime.UtcNow
    static #lastSync = new Stopwatch();     // private static Stopwatch
    Synchronized = false;                   // bool { get; private set; } = false
    Server = "pool.ntp.org";                // string { get; set; }
    TimeSyncInterval = { TotalMilliseconds: 10 * 60 * 1000 }; // TimeSpan.FromMinutes(10)
    constructor() {
        this.Resync();
    }
    CurrentTime() { // DateTime
        if (TimeSync.#stopwatch.Elapsed.TotalMilliseconds >= this.TimeSyncInterval.TotalMilliseconds)
            this.Resync(); // Task.Run(Resync) — no-op in browser
        if (TimeSync.#lastSync.IsRunning)
            return new Date(TimeSync.#syncTime.getTime() + TimeSync.#lastSync.Elapsed.TotalMilliseconds); // syncTime + lastSync.Elapsed
        return new Date(); // DateTime.UtcNow
    }
    async Resync() { // private async Task
        TimeSync.#stopwatch.Restart();
        // var client = new NtpClient(Server);  -> no NTP in the browser.
        // The C# loop retries NTP forever; here it's a no-op: Synchronized stays false and
        // CurrentTime() uses the system clock. (Replace with an HTTP time source if needed.)
        this.Synchronized = false;
    }
}
