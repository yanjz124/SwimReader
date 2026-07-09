// Ported from _source/InputBox.cs
// namespace DGScope
// A WinForms modal input dialog (Form + Label + TextBox + OK/Cancel) -> window.prompt.
// `ref string value` -> {value} holder. Returns a DialogResult.
import { DialogResult } from "./_shims/WinForms.js";

export class Input { // public static class
    static InputBox(title, promptText, value /* ref {value} */) { // DialogResult
        if (typeof window === "undefined" || !window.prompt)
            return DialogResult.Cancel; // no DOM (e.g. Node)
        // The WinForms dialog builds Form/Label/TextBox/OK/Cancel; window.prompt is the browser analog.
        const result = window.prompt(promptText, (value && value.value != null) ? value.value : "");
        if (result == null) // Cancel
            return DialogResult.Cancel;
        if (value) value.value = result;
        return DialogResult.OK;
    }
}
