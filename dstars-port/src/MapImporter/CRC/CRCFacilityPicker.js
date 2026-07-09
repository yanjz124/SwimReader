// Ported (STUB) from _source/MapImporter/CRC/CRCFacilityPicker.cs (+ .Designer.cs).
// CONFIG DIALOG — a WinForms Form to pick a facility during CRC map import. No DOM UI is built;
// the public surface CRCMapImporter uses (constructor(facilities), PickedFacility, ShowDialog())
// is kept. ShowDialog() returns Cancel (no interactive picker); a real port needs a DOM dialog.
import { DialogResult } from "../../_shims/WinForms.js";

export class CRCFacilityPicker {
    PickedFacility = null; // string (set to the chosen facility on OK)
    #facilities;           // List<string>
    constructor(facilities) { this.#facilities = facilities; }
    ShowDialog() { return DialogResult.Cancel; } // WinForms modal -> no DOM dialog
    Dispose() { }
}
