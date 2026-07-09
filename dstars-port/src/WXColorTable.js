// Ported 1:1 from NexradDecoder/WXColorTable.cs (namespace DGScope, so a real DGScope type
// even though it physically lives in the NexradDecoder project).
import { Color } from "./_shims/SystemDrawing.js";

export class WXColorTable {
    Colors = [];         // List<WXColor>
    LevelsEnabled = null; // bool[]

    // ref bool[] availableLevels — JS arrays are reference types; element mutation is visible
    // to the caller, and neither overload reassigns the array, so a plain param is faithful.
    // C# overloads GetWXColor(double, ref bool[]) and GetWXColor(int, ref bool[]) merged, keyed
    // on whether value is an integer level (1..6) vs a raw double reflectivity.
    GetWXColor(value, availableLevels) { // WXColor
        let colors = [...this.Colors].sort((a, b) => a.MinValue - b.MinValue); // OrderBy(x=>x.MinValue).ToArray()
        // ---- int-value overload (ScopeServer levels 1..6) ----
        if (Number.isInteger(value) && !this.#preferDouble) {
            if (colors.length < 1 || value < 1 || value > 6)
                return null;
            if (this.LevelsEnabled == null || this.LevelsEnabled.length !== colors.length)
                this.LevelsEnabled = new Array(colors.length).fill(false);
            for (let i = colors.length - 1; i >= 0; i--) {
                if (value > i) {
                    availableLevels[i] = true;
                    if (this.LevelsEnabled[i]) {
                        return colors[i];
                    }
                }
            }
            return null;
            // (unreachable in source)
            // if (value <= 1) return colors[0];
            // if (value <= colors.length) return colors[value - 1];
            // return colors[colors.length - 1];
        }
        // ---- double-value overload (NWS reflectivity dBZ) ----
        if (colors.length < 1)
            return null;
        if (value < colors[0].MinValue)
            return null;
        if (this.LevelsEnabled == null || this.LevelsEnabled.length !== colors.length)
            this.LevelsEnabled = new Array(colors.length).fill(false);
        for (let i = colors.length - 1; i >= 0; i--) {
            if (value > colors[i].MinValue) {
                availableLevels[i] = true;
                if (this.LevelsEnabled[i]) {
                    return colors[i];
                }
            }
        }
        return null;
    }
    #preferDouble = false; // internal: the NWS path passes doubles that may be whole numbers

    constructor(colors) { // () and (List<WXColor> colors)
        if (colors !== undefined) {
            this.Colors = colors;
            this.LevelsEnabled = new Array(colors.length).fill(false);
            for (let i = 0; i < colors.length; i++) {
                this.LevelsEnabled[i] = true;
            }
        }
    }
}

const denseStipple = new Uint8Array([
    0, 0, 0, 0, 0, 0, 0, 0, 32, 32, 32, 32, 0, 0, 0, 0,
    0, 0, 0, 0, 4, 4, 4, 4, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 32, 32, 32, 32, 0, 0, 0, 0,
    0, 0, 0, 0, 4, 4, 4, 4, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 32, 32, 32, 32, 0, 0, 0, 0,
    0, 0, 0, 0, 4, 4, 4, 4, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 32, 32, 32, 32, 0, 0, 0, 0,
    0, 0, 0, 0, 4, 4, 4, 4, 0, 0, 0, 0, 0, 0, 0, 0,
]);
const lightStipple = new Uint8Array([
    0, 0, 0, 0, 0, 0, 0, 0, 32, 32, 32, 32, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 2, 2, 2, 2, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 32, 32, 32, 32, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 2, 2, 2, 2, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
]);

export class WXColor {
    MinValue = 0;                    // double
    // [XmlIgnore]
    MinColor = null;                 // Color
    // [XmlIgnore]
    StippleColor = null;             // Color
    Stipple = StippleType.NONE;      // StippleType

    // Constructors: (double,Color) | (double,Color,Color,StippleType) | ()
    constructor(minvalue, mincolor, stippleColor, stippleType) {
        if (minvalue === undefined) return; // WXColor()
        this.MinValue = minvalue;
        this.MinColor = mincolor;
        if (stippleColor === undefined) {
            this.StippleColor = Color.Transparent;
        } else {
            this.StippleColor = stippleColor;
            this.Stipple = stippleType;
        }
    }

    // [XmlElement("MinColor")]
    get MinColorAsArgb() { return this.MinColor.ToArgb(); }
    set MinColorAsArgb(value) { this.MinColor = Color.FromArgb(value); }
    // [XmlElement("StippleColor")]
    get StippleColorAsArgb() { return this.StippleColor.ToArgb(); }
    set StippleColorAsArgb(value) { this.StippleColor = Color.FromArgb(value); }
    // [XmlIgnore]
    get StipplePattern() { // byte[]
        switch (this.Stipple) {
            case StippleType.LIGHT: return lightStipple;
            case StippleType.DENSE: return denseStipple;
        }
        return new Uint8Array(256);
    }

    toString() { return ">=" + this.MinValue; }
}

export const StippleType = Object.freeze({ NONE: 0, LIGHT: 1, DENSE: 2 });
