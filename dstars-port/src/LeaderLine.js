// Ported 1:1 from _source/LeaderLine.cs
// namespace DGScope
// using System.Drawing;
import { PointF, SizeF, RectangleF } from "./_shims/SystemDrawing.js";

// class ConnectingLineF : IScreenObject   (IScreenObject = duck-typed interface)
export class ConnectingLineF {
    Start = new PointF(); // PointF
    End = new PointF();   // PointF
    get LocationF() { return new PointF(this.Start.X > this.End.X ? this.End.X : this.Start.X, this.Start.Y > this.End.Y ? this.End.Y : this.Start.Y); } // PointF
    set LocationF(value) { }
    NewLocation = new PointF(); // PointF
    get SizeF() { return new SizeF(Math.abs(this.Start.X - this.End.X), Math.abs(this.Start.Y - this.End.Y)); } // SizeF
    set SizeF(value) { }

    get BoundsF() { return new RectangleF(this.LocationF, this.SizeF); } // RectangleF

    // bool IntersectsWith(RectangleF Rectangle)
    IntersectsWith(arg) {
        // C# overloads: IntersectsWith(RectangleF) and IntersectsWith(ConnectingLineF)
        if (arg instanceof RectangleF) {
            return ConnectingLineF.#LineIntersectsRect(this.Start, this.End, arg);
        }
        // IntersectsWith(ConnectingLineF Line)
        const Line = arg;
        return ConnectingLineF.#LineIntersectsLine(Line.Start, Line.End, this.Start, this.End);
    }

    static #LineIntersectsRect(p1, p2, r) { // private static bool
        return ConnectingLineF.#LineIntersectsLine(p1, p2, new PointF(r.Left, r.Top), new PointF(r.Right, r.Top)) ||
               ConnectingLineF.#LineIntersectsLine(p1, p2, new PointF(r.Right, r.Y), new PointF(r.Right, r.Bottom)) ||
               ConnectingLineF.#LineIntersectsLine(p1, p2, new PointF(r.Right, r.Bottom), new PointF(r.Left, r.Bottom)) ||
               ConnectingLineF.#LineIntersectsLine(p1, p2, new PointF(r.Left, r.Bottom), new PointF(r.Left, r.Top)) ||
               (r.Contains(p1) && r.Contains(p2));
    }

    static #LineIntersectsLine(l1p1, l1p2, l2p1, l2p2) { // private static bool
        let q = (l1p1.Y - l2p1.Y) * (l2p2.X - l2p1.X) - (l1p1.X - l2p1.X) * (l2p2.Y - l2p1.Y); // float
        let d = (l1p2.X - l1p1.X) * (l2p2.Y - l2p1.Y) - (l1p2.Y - l1p1.Y) * (l2p2.X - l2p1.X); // float

        if (d === 0) {
            return false;
        }

        let r = q / d; // float

        q = (l1p1.Y - l2p1.Y) * (l1p2.X - l1p1.X) - (l1p1.X - l2p1.X) * (l1p2.Y - l1p1.Y);
        let s = q / d; // float

        if (r < 0 || r > 1 || s < 0 || s > 1) {
            return false;
        }

        return true;
    }
    ParentAircraft = null; // Aircraft
}
