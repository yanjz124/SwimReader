// Ported 1:1 from _source/GeoPoint.cs
// namespace DGScope
// [Serializable()] [TypeConverter(typeof(ExpandableObjectConverter))] [JsonObject] [ProtoContract]
import { Line } from "./Line.js";
import { tryParseDouble } from "./_shims/Primitives.js";

export class GeoPoint {
    // [DisplayName("Latitude")] [JsonProperty("Latitude")] [ProtoMember(1)]
    Latitude = 0;   // double
    // [DisplayName("Longitude")] [JsonProperty("Longitude")] [ProtoMember(2)]
    Longitude = 0;  // double

    BearingTo(From) { // double
        let λ1 = this.Longitude * (Math.PI / 180);
        let λ2 = From.Longitude * (Math.PI / 180);
        let φ1 = this.Latitude * (Math.PI / 180);
        let φ2 = From.Latitude * (Math.PI / 180);

        let y = Math.sin(λ2 - λ1) * Math.cos(φ2);
        let x = Math.cos(φ1) * Math.sin(φ2) -
                Math.sin(φ1) * Math.cos(φ2) * Math.cos(λ2 - λ1);
        let θ = Math.atan2(y, x);
        return (θ * (180 / Math.PI)) % 360; // in degrees
    }

    IsInsidePolygon(polygon) { // bool
        if (polygon.Points.length < 3)
            return false;
        let testline = new Line(this, new GeoPoint(this.Latitude, 720));
        let crosses = 0;
        for (let i = 0; i < polygon.Points.length - 1; i++) {
            let polyline = new Line(polygon.Points[i], polygon.Points[i + 1]);
            if (GeoPoint.#LineIntersectsLine(testline, polyline))
                crosses++;
        }
        return crosses % 2 != 0;
    }

    // C# constructors GeoPoint(double,double) and GeoPoint() merged.
    constructor(Latitude = 0, Longitude = 0) {
        this.Latitude = Latitude;
        this.Longitude = Longitude;
    }

    toString() {
        return this.Latitude.toString() + ", " + this.Longitude.toString();
    }

    ToDmsString() { // string
        let lat_deg = Math.trunc(Math.abs(this.Latitude));
        let lat_min = Math.trunc(Math.abs(this.Latitude * 60)) % 60;
        let lat_sec = Math.trunc(Math.abs(this.Latitude * 3600)) % 60;
        let lng_deg = Math.trunc(Math.abs(this.Longitude));
        let lng_min = Math.trunc(Math.abs(this.Longitude * 60)) % 60;
        let lng_sec = Math.trunc(Math.abs(this.Longitude * 3600)) % 60;
        let s = this.Latitude < 0 ? "S" : "";
        let e = this.Longitude > 0 ? "E" : "";

        return `${lat_deg} ${lat_min} ${lat_sec}${s}/${lng_deg} ${lng_min} ${lng_sec}${e}`;
    }

    DistanceTo(From, Altitude = 0) { // double
        if (From == null)
            return 0;
        let R = 3443.92; // nautical miles
        let φ2 = this.Latitude * (Math.PI / 180);
        let φ1 = From.Latitude * (Math.PI / 180);
        let Δφ = (From.Latitude - this.Latitude) * Math.PI / 180;
        let Δλ = (From.Longitude - this.Longitude) * Math.PI / 180;

        let a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
                Math.cos(φ1) * Math.cos(φ2) *
                Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
        let c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        let alt = Altitude / 6076.12;

        let dist = Math.sqrt((R * c) * (R * c) + (alt * alt));
        return dist;
    }

    // instance FromPoint(double, double)
    FromPoint(Distance, Bearing) {
        return GeoPoint.FromPoint(this, Distance, Bearing);
    }

    // C# overloads: LineIntersectsLine(Line,Line) and (GeoPoint,GeoPoint,GeoPoint,GeoPoint)
    static #LineIntersectsLine(a, b, c, d) { // private static bool
        if (arguments.length === 2) {
            const l1 = a, l2 = b;
            return GeoPoint.#LineIntersectsLine(l1.End1, l1.End2, l2.End1, l2.End2);
        }
        const l1p1 = a, l1p2 = b, l2p1 = c, l2p2 = d;
        let q = (l1p1.Latitude - l2p1.Latitude) * (l2p2.Longitude - l2p1.Longitude) - (l1p1.Longitude - l2p1.Longitude) * (l2p2.Latitude - l2p1.Latitude);
        let dd = (l1p2.Longitude - l1p1.Longitude) * (l2p2.Latitude - l2p1.Latitude) - (l1p2.Latitude - l1p1.Latitude) * (l2p2.Longitude - l2p1.Longitude);

        if (dd === 0) {
            return false;
        }

        let r = q / dd;

        q = (l1p1.Latitude - l2p1.Latitude) * (l1p2.Longitude - l1p1.Longitude) - (l1p1.Longitude - l2p1.Longitude) * (l1p2.Latitude - l1p1.Latitude);
        let s = q / dd;

        if (r < 0 || r > 1 || s < 0 || s > 1) {
            return false;
        }

        return true;
    }

    static FromPoint(Origin, Distance, Bearing) { // static GeoPoint
        let R = 3443.92; // nautical miles
        let brng = Bearing * (Math.PI / 180);
        let d = Distance;
        let φ1 = Origin.Latitude * (Math.PI / 180);
        let λ1 = Origin.Longitude * (Math.PI / 180);
        let φ2 = Math.asin(Math.sin(φ1) * Math.cos(d / R) +
                 Math.cos(φ1) * Math.sin(d / R) * Math.cos(brng));
        let λ2 = λ1 + Math.atan2(Math.sin(brng) * Math.sin(d / R) * Math.cos(φ1),
                 Math.cos(d / R) - Math.sin(φ1) * Math.sin(φ2));
        let newLatitude = φ2 * (180 / Math.PI);
        let newLongitude = λ2 * (180 / Math.PI);
        return new GeoPoint(newLatitude, newLongitude);
    }

    static TryParse(pointString, point /* out GeoPoint */) { // static bool
        point.value = new GeoPoint();
        pointString = pointString.trim();
        let pointSplit = pointString.split(' ');
        if (pointSplit.length < 2)
            return false;
        let lat = pointSplit[0].split('.');
        let lon = pointSplit[1].split('.');
        let value = { value: 0 };    // double value = 0  (out target, reused)
        let latitude = 0;            // double latitude = 0
        let latOut = { value: 0 };
        if (lat.length === 2 && tryParseDouble(pointSplit[0], latOut)) {
            latitude = latOut.value;
        }
        else { //  Try VRC format
            if (lat[0].length < 2)
                return false;
            if (tryParseDouble(lat[0].substring(1), value))
                latitude += value.value;
            else
                return false;
            if (lat.length > 2 && tryParseDouble(lat[1], value))
                latitude += value.value / 60;
            if (lat.length >= 3 && tryParseDouble(lat[2], value))
                latitude += value.value / 3600;
            if (lat.length >= 4 && tryParseDouble(lat[3], value))
                latitude += value.value / 3600000;
        }
        if (pointSplit[0].includes('S'))
            latitude *= -1;

        let longitude = 0;
        let lonOut = { value: 0 };
        if (lon.length === 2 && tryParseDouble(pointSplit[1], lonOut)) {
            longitude = lonOut.value;
        }
        else { //  Try VRC format
            if (tryParseDouble(lon[0].substring(1), value))
                longitude += value.value;
            else
                return false;
            if (lon.length > 2 && tryParseDouble(lon[1], value))
                longitude += value.value / 60;
            if (lon.length >= 3 && tryParseDouble(lon[2], value))
                longitude += value.value / 3600;
            if (lon.length >= 4 && tryParseDouble(lon[3], value))
                longitude += value.value / 3600000;
        }
        if (pointSplit[1].includes('W'))
            longitude *= -1;
        point.value.Latitude = latitude;
        point.value.Longitude = longitude;
        return true;
    }
}
