// Ported (STUB) from _source/VideoMapForm.cs (+ .Designer.cs).
// CONFIG DIALOG — WinForms Form to manage a VideoMapList (import/export GeoJSON, edit maps) with
// many OpenFileDialog/SaveFileDialog interactions + a property-grid UITypeEditor. No DOM UI is
// built; the (fully-ported) VideoMapList + GeoJSONMapExporter do the actual work. Public surface
// kept minimal.
import { DialogResult } from "./_shims/WinForms.js";

export class VideoMapForm { // : Form
    #list;       // VideoMapList
    #filename;   // string
    #adaptation; // RadarWindow
    constructor(list, filename, adaptation = null) { this.#list = list; this.#filename = filename; this.#adaptation = adaptation; }
    ShowDialog() { return DialogResult.Cancel; }
    Dispose() { }
}

const UITypeEditorEditStyle_Modal = 1;
export class VideoMapCollectionEditor {
    GetEditStyle(context) { return UITypeEditorEditStyle_Modal; }
    EditValue(context, provider, value) { return value; }
}
