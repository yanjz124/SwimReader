// Ported (STUB) from _source/VideoMapSelector.cs (+ .Designer.cs).
// CONFIG DIALOG — WinForms Form to select video maps + its property-grid UITypeEditor. No DOM UI.
import { DialogResult } from "./_shims/WinForms.js";

export class VideoMapSelector { // : Form
    #videoMaps; // VideoMapList
    constructor(videoMaps) { this.#videoMaps = videoMaps; }
    ShowDialog() { return DialogResult.Cancel; }
    Dispose() { }
}

const UITypeEditorEditStyle_Modal = 1;
export class OldVideoMapCollectionEditor {
    GetEditStyle(context) { return UITypeEditorEditStyle_Modal; }
    EditValue(context, provider, value) { return value; }
}
