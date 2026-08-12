// Ported (STUB) from _source/PropertyForm.cs (+ .Designer.cs).
// CONFIG DIALOG — the WinForms settings property grid (edit RadarWindow config, load/save via
// OpenFileDialog/SaveFileDialog). No DOM UI is built; a real port would be a settings panel +
// file pickers. Public surface kept minimal (constructor(window), ShowDialog()).
import { DialogResult } from "./_shims/WinForms.js";

export class PropertyForm { // : Form
    #window; // RadarWindow
    constructor(window) { this.#window = window; }
    ShowDialog() { return DialogResult.Cancel; }
    Dispose() { }
}
