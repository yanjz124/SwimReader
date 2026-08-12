// Ported 1:1 from _source/RangeBearingLine.cs
// #nullable enable
// namespace DGScope
// using System.Drawing;
import { PointF, SizeF, RectangleF } from "./_shims/SystemDrawing.js";
import { Line } from "./Line.js";
import { TransparentLabel } from "./TransparentLabel.js";

export class RangeBearingLine {
    #_start = new PointF(); // PointF
    get Start() { return this.#_start; }        // PointF
    set Start(value) {
        this.#_start = value;
    }
    #_end = new PointF(); // PointF
    get End() { return this.#_end; }            // PointF
    set End(value) {
        this.#_end = value;
    }

    StartGeo = null; // GeoPoint?
    EndGeo = null;   // GeoPoint?

    StartPlane = null; // Aircraft?
    EndPlane = null;   // Aircraft?

    get LocationF() { return new PointF(this.Start.X > this.End.X ? this.End.X : this.Start.X, this.Start.Y > this.End.Y ? this.End.Y : this.Start.Y); } // PointF
    set LocationF(value) { }
    get SizeF() { return new SizeF(Math.abs(this.Start.X - this.End.X), Math.abs(this.Start.Y - this.End.Y)); } // SizeF
    set SizeF(value) { }

    get BoundsF() { return new RectangleF(this.LocationF, this.SizeF); } // RectangleF
    Line = new Line();  // Line
    Label = Object.assign(new TransparentLabel(), { AutoSize: true }); // TransparentLabel { AutoSize = true }
}
