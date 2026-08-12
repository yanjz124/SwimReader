// Ported from _source/ITWSRadarSiteStringConverter.cs
// namespace DGScope
// internal class ITWSSensorIDStringConverter : StringConverter — a WinForms property-grid
// TypeConverter that supplies the drop-down of available ITWS sensor IDs. There is no property
// grid in the browser, so the base StringConverter is dropped; the methods are kept (inert unless
// a DOM property editor calls them). GetStandardValues returns the NexradDisplay's Sensors.
export class ITWSSensorIDStringConverter {
    GetStandardValuesSupported(context) { // override bool
        return true;
    }
    GetStandardValuesExclusive(context) { // override bool
        return false;
    }
    GetStandardValues(context) { // override StandardValuesCollection
        const w = context ? context.Instance : null; // context.Instance as NexradDisplay
        return new StandardValuesCollection(w ? w.Sensors : []);
    }
}

// System.ComponentModel.TypeConverter.StandardValuesCollection (minimal)
export class StandardValuesCollection {
    constructor(values) { this.values = values || []; }
    [Symbol.iterator]() { return this.values[Symbol.iterator](); }
}
