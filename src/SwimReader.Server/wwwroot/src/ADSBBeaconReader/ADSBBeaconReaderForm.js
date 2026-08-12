// Ported (STUB) from _source/ADSBBeaconReader/ADSBBeaconReaderForm.cs (+ .Designer.cs).
// CONFIG DIALOG — WinForms Form to manage ADS-B sources (add/remove, toggle HideLADD). It edits
// the ADSBBeaconReaderSettings that the (fully-ported) ADSBBeaconReaderService consumes. No DOM UI
// is built; a real port would be a settings panel. Public surface kept minimal.
import { DialogResult } from "../_shims/WinForms.js";

export class ADSBBeaconReaderForm { // : Form
    #settings; // ADSBBeaconReaderSettings
    #service;  // ADSBBeaconReaderService
    constructor(settings, service = null) { this.#settings = settings; this.#service = service; }
    ShowDialog() { return DialogResult.Cancel; }
    Dispose() { }
}
