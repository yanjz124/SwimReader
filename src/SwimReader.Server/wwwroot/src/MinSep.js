// Ported 1:1 from _source/MinSep.cs
// namespace DGScope
// NOTE: `{ get; private set; }` -> plain public field (JS has no property-level
// access modifier without a backing field; the private-set enforcement is dropped,
// runtime behavior is identical).
import { Line } from "./Line.js";
import { TransparentLabel } from "./TransparentLabel.js";

export class MinSep {
    static #DESIREDPRECISION = 0.01;  // const double
    static #START_SECONDS_STEP = 30;  // const int

    Plane1 = null;         // Aircraft { get; private set; }
    Plane2 = null;         // Aircraft { get; private set; }
    MinSepDistance = null; // double?  { get; private set; }
    NoXing = null;         // bool?    { get; private set; }
    Point1 = null;         // GeoPoint { get; private set; }
    Point2 = null;         // GeoPoint { get; private set; }
    Line1 = new Line();    // Line     { get; private set; }
    Line2 = new Line();    // Line     { get; private set; }
    SepLine = new Line();  // Line     { get; private set; }
    Label = Object.assign(new TransparentLabel(), { AutoSize: true }); // TransparentLabel { get; private set; }

    // MinSep(Aircraft Plane1, Aircraft Plane2)
    constructor(Plane1, Plane2) {
        this.Plane1 = Plane1;
        this.Plane2 = Plane2;
    }

    #workingonit = false; // bool workingonit = false

    async CalculateMinSep(radar) { // async Task<bool> CalculateMinSep(Radar radar)
        if (this.#workingonit)
            return false;
        this.#workingonit = true;
        if (this.Plane1 == null || this.Plane2 == null) {
            this.#workingonit = false;
            return false;
        }
        if (this.Plane1.SweptLocation(radar) == null || this.Plane2.SweptLocation(radar) == null) {
            this.#workingonit = false;
            return false;
        }
        let secondsStep = MinSep.#START_SECONDS_STEP; // double
        let minsep = this.Plane1.SweptLocation(radar).DistanceTo(this.Plane2.SweptLocation(radar));
        let testdistance = this.Plane1.SweptLocation(radar).FromPoint(this.Plane1.GroundSpeed / 3600, this.Plane1.ExtrapolateTrack()).DistanceTo(this.Plane2.SweptLocation(radar).FromPoint(this.Plane2.GroundSpeed / 3600, this.Plane2.ExtrapolateTrack()));
        if (testdistance >= minsep) {
            // Planes are moving away from each other
            // NO XING
            this.Point1 = this.Plane1.SweptLocation(radar);
            this.Point2 = this.Plane2.SweptLocation(radar);
            this.SepLine.End1 = this.Point1;
            this.SepLine.End2 = this.Point2;
            this.Line1 = new Line();
            this.Line2 = new Line();
            this.MinSepDistance = minsep;
            this.NoXing = true;
            this.#workingonit = false;
            return false;
        }

        let lastdistance = 0;
        let hours = 0;
        let minPoint1 = null, minPoint2 = null; // GeoPoint
        while (Math.abs(testdistance - minsep) > MinSep.#DESIREDPRECISION || Math.abs(testdistance - lastdistance) > MinSep.#DESIREDPRECISION) {
            hours += 1 / (3600 / secondsStep);
            let point1 = this.Plane1.SweptLocation(radar).FromPoint(this.Plane1.SweptSpeed(radar) * hours, this.Plane1.SweptTrack(radar));
            let point2 = this.Plane2.SweptLocation(radar).FromPoint(this.Plane2.SweptSpeed(radar) * hours, this.Plane2.SweptTrack(radar));
            lastdistance = testdistance;
            testdistance = point1.DistanceTo(point2);
            if (testdistance < minsep) {
                minsep = testdistance;
                minPoint1 = point1;
                minPoint2 = point2;
            }
            else if (testdistance > lastdistance) { // going the wrong way
                secondsStep = -(secondsStep / 2); // reverse at half speed
            }
        }
        this.NoXing = false;
        this.MinSepDistance = minsep;
        this.Point1 = minPoint1;
        this.Point2 = minPoint2;
        this.Line1.End1 = this.Plane1.SweptLocation(radar);
        this.Line1.End2 = this.Point1;
        this.Line2.End1 = this.Plane2.SweptLocation(radar);
        this.Line2.End2 = this.Point2;
        this.SepLine.End1 = this.Point1;
        this.SepLine.End2 = this.Point2;
        this.#workingonit = false;
        return true;
    }
}
