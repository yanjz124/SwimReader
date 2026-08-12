// Ported 1:1 from _source/TPARing.cs
// namespace DGScope
// using System.Drawing;  (Color, Font are opaque values here)
// NOTE: C# declares TPARing/TPACone before their base TPA. JS requires the base
// class to be declared first (extends is evaluated at load). Order swapped; the
// three classes and the enum are otherwise identical to the source.
import { TransparentLabel } from "./TransparentLabel.js";

// abstract class TPA
export class TPA {
    get Type() { throw new Error("abstract"); } // abstract TPAType Type
    ParentAircraft = null; // Aircraft
    ShowSize = true;       // bool
    Miles = 0;             // decimal  -> number
    get Color() { return this.Label.ForeColor; }       // Color
    set Color(value) { this.Label.ForeColor = value; }
    // TPA(Aircraft aircraft, decimal miles, Color color, Font font, bool showsize)
    constructor(aircraft, miles, color, font, showsize) {
        this.ParentAircraft = aircraft;
        this.Miles = miles;
        this.ShowSize = showsize;
        this.#Label = Object.assign(new TransparentLabel(), {
            AutoSize: true,
            ForeColor: color,
            Font: font,
        });
    }
    #Label; // TransparentLabel { get; private set; }
    get Label() { return this.#Label; }
}

export class TPARing extends TPA {
    get Type() { return TPAType.JRing; } // override TPAType Type
    // TPARing(Aircraft aircraft, decimal miles, Color color, Font font, bool showsize)
    constructor(aircraft, miles, color, font, showsize) {
        super(aircraft, miles, color, font, showsize);
    }
}

export class TPACone extends TPA {
    get Type() { return TPAType.PCone; } // override TPAType Type
    Track = null; // double?
    // TPACone(Aircraft aircraft, decimal miles, Color color, Font font, bool showsize, double? track = null)
    constructor(aircraft, miles, color, font, showsize, track = null) {
        super(aircraft, miles, color, font, showsize);
        this.Track = track;
    }
}

export const TPAType = Object.freeze({
    JRing: 0,
    PCone: 1,
});
