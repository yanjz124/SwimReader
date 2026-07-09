// Ported 1:1 from _source/Radar.cs
// namespace DGScope
// [Browsable(true)] [TypeConverter(typeof(ExpandableObjectConverter))]
import { GeoPoint } from "./GeoPoint.js";
import { RadarWindow } from "./RadarWindow.js";

export class Radar {
    static #_fused = null; // private static Radar _fused
    Location = new GeoPoint(); // GeoPoint
    // [Browsable(false)]
    get Latitude() { return this.Location.Latitude; }   // double
    // [Browsable(false)]
    get Longitude() { return this.Location.Longitude; } // double
    Range = 200; // double
    // [DisplayName("Update Rate"), Description("The rate at which to draw targets. The rate at which the radar sweep rotates, if rotating is true")]
    UpdateRate = 1; // double
    // [DisplayName("Inhibit Extrapolation"), Description("Inhibit extrapolation of aircraft positions")]
    InhibitExtrapolation = false; // bool
    // [DisplayName("Radar Type")]
    RadarType = RadarType.FUSED; // RadarType
    Rotating = false; // bool
    // [Category("Identity")]
    Name = null; // string
    // [Category("Identity")]
    Char = '\0'; // char
    // [XmlIgnore]
    SweptTimes = new Map(); // Dictionary<Aircraft, DateTime> -> Map

    LatitudeOfTarget(distance, bearing) { // double
        let R = 3443.92; // nautical miles
        let brng = bearing * (Math.PI / 180);
        let d = distance;
        let φ1 = this.Latitude * (Math.PI / 180);

        return (Math.asin(Math.sin(φ1) * Math.cos(d / R) +
                Math.cos(φ1) * Math.sin(d / R) * Math.cos(brng))) * (180 / Math.PI);
    }

    LongitudeOfTarget(distance, bearing) { // double
        let R = 3443.92; // nautical miles
        let brng = bearing * (Math.PI / 180);
        let d = distance;
        let φ1 = this.Latitude * (Math.PI / 180);
        let λ1 = this.Longitude * (Math.PI / 180);

        return (λ1 + Math.atan2(Math.sin(brng) * Math.sin(d / R) * Math.cos(φ1),
                Math.cos(d / R) - Math.sin(φ1) * Math.sin(this.LatitudeOfTarget(distance, bearing)))) * (180 / Math.PI);
    }
    #lastScan = null;    // private DateTime? lastScan
    #lastazimuth = 0;    // private double lastazimuth = 0
    async Scan(time) { // async Task Scan(DateTime time)
        let TargetsScanned = []; // List<Aircraft>
        let tasks = [];          // List<Task>
        if (RadarWindow.Aircraft == null)
            return;
        if (!(this.#lastScan != null) || this.#lastScan > time) // !lastScan.HasValue || lastScan.Value > time
            this.#lastScan = time;
        let elapsed = (time.getTime() - this.#lastScan.getTime()) * 10000; // (time - lastScan).Value.Ticks  (ms -> 100ns ticks)
        let newazimuth = (this.#lastazimuth + ((elapsed / (this.UpdateRate * 10000000)) * 360)) % 360;
        let slicewidth = (this.#lastazimuth - newazimuth) % 360;
        if (!this.Rotating && (elapsed / (this.UpdateRate * 10000000)) < 1)
            return;
        if (RadarWindow.Aircraft == null)
            return;
        this.#lastScan = time;
        // lock (RadarWindow.Aircraft)
        TargetsScanned.push(...RadarWindow.Aircraft.filter(x =>
            (this.BearingIsBetween(x.Bearing(this.Location), this.#lastazimuth, newazimuth) || !this.Rotating) && !x.IsOnGround
            && x.Location != null));
        TargetsScanned.forEach(x => tasks.push(this.ScanTarget(x, time)));
        //Console.WriteLine("Scanned method returned {0} aircraft", TargetsScanned.Count);
        this.#lastazimuth = newazimuth;
        if (this.#lastazimuth === 360)
            this.#lastazimuth = 0;
        await Promise.all(tasks); // Task.WaitAll(tasks.ToArray())
        return;
    }

    async ScanTarget(plane, time) { // async Task ScanTarget(Aircraft plane, DateTime time)
        let location;
        if ((plane.PrimaryOnly && this.RadarType === RadarType.FUSED) || this.InhibitExtrapolation) {
            location = plane.Location;
        }
        else {
            location = plane.ExtrapolatePosition(time);
        }
        // lock (plane.SweptLocations)
        {
            if (plane.SweptLocations.has(this)) {
                plane.SweptLocations.set(this, location);
            }
            else {
                plane.SweptLocations.set(this, location);
            }
        }
        // lock (plane.SweptTracks)
        {
            let track; // int
            if (this.InhibitExtrapolation) {
                track = plane.Track;
            }
            else {
                track = Math.trunc(plane.ExtrapolateTrack(time));
            }
            if (plane.SweptTracks.has(this)) {
                plane.SweptTracks.set(this, Math.trunc(plane.ExtrapolateTrack(time)));
            }
            else {
                plane.SweptTracks.set(this, Math.trunc(plane.ExtrapolateTrack(time)));
            }
        }
        // lock (plane.SweptAltitudes)
        {
            if (plane.SweptAltitudes.has(this)) {
                plane.SweptAltitudes.set(this, plane.TrueAltitude);
            }
            else {
                plane.SweptAltitudes.set(this, plane.TrueAltitude);
            }
        }
        // lock (plane.SweptSpeeds)
        {
            if (plane.SweptSpeeds.has(this)) {
                plane.SweptSpeeds.set(this, plane.GroundSpeed);
            }
            else {
                plane.SweptSpeeds.set(this, plane.GroundSpeed);
            }
        }
        // lock (plane.LastHistoryTimes)
        {
            if (!plane.LastHistoryTimes.has(this)) {
                plane.LastHistoryTimes.set(this, new Date(-8640000000000000)); // DateTime.MinValue
            }
        }
        // lock (SweptTimes)
        {
            if (!this.SweptTimes.has(plane)) {
                this.SweptTimes.set(plane, RadarWindow.CurrentTime);
            }
            else {
                this.SweptTimes.set(plane, RadarWindow.CurrentTime);
            }
        }
    }

    BearingIsBetween(bearing, az1, az2) { // bool
        if (az2 === az1) {
            return bearing === az1;
        }
        if (az2 > az1) {
            return bearing >= az1 && bearing <= az2;
        }
        else {
            return (bearing >= az1 && bearing <= 360) || bearing <= az2;
        }
    }

    InRange(location, altitude) { // bool
        if (location == null)
            return false;
        let distance = location.DistanceTo(this.Location, altitude);
        if (distance <= this.Range)
            return true;
        return false;
    }
    constructor() {
    }
    static get FUSED() { // static Radar FUSED
        if (Radar.#_fused == null) {
            Radar.#_fused = Object.assign(new Radar(), {
                RadarType: RadarType.FUSED,
                Name: "FUSED",
            });
        }
        return Radar.#_fused;
    }
}

export const RadarType = Object.freeze({
    SLANT_RANGE: 0,
    GROUND_RANGE: 1,
    FUSED: 2,
});
