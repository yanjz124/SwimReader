// Ported (STUB) from _source/ATPAVolumeSelector.cs (+ .Designer.cs).
// CONFIG DIALOG — WinForms Form(s) to select/edit ATPA volumes, plus their property-grid
// UITypeEditors. No DOM UI is built; public surface kept. ShowDialog() -> Cancel.
import { DialogResult } from "./_shims/WinForms.js";

export class ATPAVolumeSelector { // : Form
    #ATPAVolumes; // List<ATPAVolume>
    constructor(ATPAVolumes) { this.#ATPAVolumes = ATPAVolumes; } // + parameterless ctor
    ShowDialog() { return DialogResult.Cancel; }
    Dispose() { }
}

export class ATPATwoPointFiveSelector extends ATPAVolumeSelector { // : ATPAVolumeSelector
    constructor(ATPAVolumes) { super(ATPAVolumes); }
}

// UITypeEditor: modal property-grid editors -> inert (no property grid in the browser).
const UITypeEditorEditStyle_Modal = 1;
export class ATPAVolumeSelectorEditor {
    GetEditStyle(context) { return UITypeEditorEditStyle_Modal; }
    EditValue(context, provider, value) { return value; } // no editor UI -> unchanged
}
export class ATPATwoPointFiveSelectorEditor {
    GetEditStyle(context) { return UITypeEditorEditStyle_Modal; }
    EditValue(context, provider, value) { return value; }
}
