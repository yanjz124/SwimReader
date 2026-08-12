// Ported 1:1 from _source/Line.cs
// namespace DGScope
import { GeoPoint } from "./GeoPoint.js";

export class Line {
    End1 = null; // GeoPoint
    End2 = null; // GeoPoint
    get Direction() { return this.End1.BearingTo(this.End2); }  // double
    get Length() { return this.End1.DistanceTo(this.End2); }    // double

    // C# had two constructors: Line(GeoPoint, GeoPoint) and Line().
    // JS single constructor with defaults reproduces both.
    constructor(End1 = null, End2 = null) { this.End1 = End1; this.End2 = End2; }

    get MidPoint() { // GeoPoint
        if (this.End1 == null || this.End2 == null)
            return null;
        let latitude = -((this.End1.Latitude - this.End2.Latitude) / 2) + this.End1.Latitude;
        let longitude = ((this.End1.Longitude - this.End2.Longitude) / 2) + this.End2.Longitude;
        return new GeoPoint(latitude, longitude);
    }

    static TryParse(linestring, line /* out Line */) {
        linestring = linestring.trim();
        line.value = new Line();
        const lineparts = linestring.split(' ');
        if (lineparts.length < 4)
            return false;
        let point1 = lineparts[0] + " " + lineparts[1];
        let point2 = lineparts[2] + " " + lineparts[3];
        const geoPoint1 = {}; // out GeoPoint
        if (GeoPoint.TryParse(point1, geoPoint1)) {
            const geoPoint2 = {}; // out GeoPoint
            if (GeoPoint.TryParse(point2, geoPoint2)) {
                line.value.End1 = geoPoint1.value;
                line.value.End2 = geoPoint2.value;
                return true;
            }
        }
        return false;
    }
}
