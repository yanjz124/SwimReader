// Ported 1:1 from _source/StarsSounds.cs
// namespace DGScope
// System.Media.SoundPlayer -> HTMLAudioElement. Embedded .wav resources
// (Assembly.GetManifestResourceStream("DGScope.Sounds.X.wav")) -> an Audio("Sounds/X.wav") asset URL.
// NOTE: the .wav assets must be served at Sounds/*.wav for playback. `ref bool playing` -> {value} holder.

/// <summary>Plays the CRC alert sounds (MSAW, MCI, Conflict Alert). Clips are one cycle, played
/// with loop and stopped when the alert clears.</summary>
export class StarsSounds { // : IDisposable
    #msaw = StarsSounds.#Load("DGScope.Sounds.Msaw.wav");                 // SoundPlayer
    #mci = StarsSounds.#Load("DGScope.Sounds.Mci.wav");
    #conflictAlert = StarsSounds.#Load("DGScope.Sounds.ConflictAlert.wav");
    #specialCode = StarsSounds.#Load("DGScope.Sounds.SpecialCode.wav");
    #msawPlaying = { value: false }; // ref bool -> holder
    #mciPlaying = { value: false };
    #caPlaying = { value: false };
    #spcPlaying = { value: false };
    // private readonly object sync -> lock() no-op

    constructor() {
    }

    static #Load(resourceName) { // SoundPlayer
        if (typeof Audio === "undefined") return null; // no HTMLAudioElement (e.g. Node) -> silent
        const url = resourceName.replace(/^DGScope\.Sounds\./, "Sounds/"); // resource -> asset URL
        const player = new Audio(url);
        try { player.load(); } catch (e) { /* ignore unloadable clip */ }
        return player;
    }

    SetMsaw(active) { this.#Set(this.#msaw, active, this.#msawPlaying); }
    SetMci(active) { this.#Set(this.#mci, active, this.#mciPlaying); }
    SetConflictAlert(active) { this.#Set(this.#conflictAlert, active, this.#caPlaying); }
    SetSpecialCode(active) { this.#Set(this.#specialCode, active, this.#spcPlaying); }

    #Set(player, active, playing) { // private void Set(SoundPlayer, bool, ref bool playing)
        if (player == null)
            return;
        // lock (sync)
        {
            if (active && !playing.value) {
                try { player.loop = true; player.play(); } catch (e) { } // PlayLooping()
                playing.value = true;
            }
            else if (!active && playing.value) {
                try { player.pause(); player.currentTime = 0; } catch (e) { } // Stop()
                playing.value = false;
            }
        }
    }

    Dispose() {
        // SoundPlayer.Dispose() -> stop + release
        for (const p of [this.#msaw, this.#mci, this.#conflictAlert, this.#specialCode]) {
            try { p?.pause(); } catch (e) { }
        }
    }
}
