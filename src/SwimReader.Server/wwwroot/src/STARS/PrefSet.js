// Ported 1:1 from _source/STARS/PrefSet.cs
// namespace DGScope.STARS
// [Serializable()] [TypeConverter(typeof(ExpandableObjectConverter))] [JsonObject]
import { GeoPoint } from "../GeoPoint.js";
import { PointF } from "../_shims/SystemDrawing.js";
import { DCBLocation } from "../DCB.js";
import { LeaderDirection } from "./LeaderDirection.js";
import { SerializableDictionary } from "../SerializableDictionary.js";

export class PrefSet {
    ScreenCenterPoint = new GeoPoint();           // GeoPoint
    PreviewAreaLocation = new PointF();            // PointF
    StatusAreaLocation = new PointF();             // PointF
    DisplayedMaps = null;                          // int[]
    RangeRingsDisplayed = false;                   // bool
    RangeRingLocation = new GeoPoint();            // GeoPoint
    RangeRingSpacing = 5;                          // int
    QuickLookedTCPs = [];                          // List<string>
    DCBLocation = DCBLocation.Top;                 // DCBLocation
    OwnedDataBlockPosition = LeaderDirection.N;    // LeaderDirection
    UnownedDataBlockPosition = LeaderDirection.N;  // LeaderDirection
    UnassociatedDataBlockPosition = LeaderDirection.N; // LeaderDirection
    OtherOwnersLeaderDirections = new SerializableDictionary(); // SerializableDictionary<string, LeaderDirection>
    DCBVisible = true;                             // bool
    RangeRingsCentered = false;                    // bool
    ScopeCentered = false;                         // bool
    PTLLength = 1;                                 // double
    PTLOwn = false;                                // bool
    PTLAll = false;                                // bool
    HistoryNum = 10;                               // int
    HistoryRate = 4.5;                             // double
    LeaderLength = 1;                              // int
    Range = 6;                                     // int
    AltitudeFilterAssociatedMax = 99900;           // int
    AltitudeFilterAssociatedMin = -9900;           // int
    AltitudeFilterUnAssociatedMax = 99900;         // int
    AltitudeFilterUnAssociatedMin = -9900;         // int
    LdbBeaconCodesInhibited = false;               // bool
    Brightness = new BrightnessSettings();         // BrightnessSettings
}

// [Serializable()] [TypeConverter(typeof(ExpandableObjectConverter))] [JsonObject]
// (C# nested class PrefSet.BrightnessSettings)
export class BrightnessSettings {
    #dcb = 100;
    #bkc = 100;
    #mpa = 100;
    #mpb = 100;
    #fdb = 100;
    #lst = 100;
    #pos = 100;
    #ldb = 100;
    #oth = 100;
    #tls = 100;
    #rr = 100;
    #cmp = 100;
    #bcn = 100;
    #pri = 100;
    #hst = 100;
    #wx = 100;
    #wxc = 100;

    get DCB() { return BrightnessSettings.#getMinMaxValue(this.#dcb, 25, 100, false); }
    set DCB(value) { this.#dcb = BrightnessSettings.#getMinMaxValue(value, 25, 100, false); }
    get Background() { return BrightnessSettings.#getMinMaxValue(this.#bkc, 25, 100, false); }
    set Background(value) { this.#bkc = BrightnessSettings.#getMinMaxValue(value, 25, 100, false); }
    get MapA() { return BrightnessSettings.#getMinMaxValue(this.#mpa, 5, 100, false); }
    set MapA(value) { this.#mpa = BrightnessSettings.#getMinMaxValue(value, 5, 100, false); }
    get MapB() { return BrightnessSettings.#getMinMaxValue(this.#mpb, 5, 100, false); }
    set MapB(value) { this.#mpb = BrightnessSettings.#getMinMaxValue(value, 5, 100, false); }
    get FullDataBlocks() { return BrightnessSettings.#getMinMaxValue(this.#fdb, 5, 100, true); }
    set FullDataBlocks(value) { this.#fdb = BrightnessSettings.#getMinMaxValue(value, 5, 100, true); }
    get Lists() { return BrightnessSettings.#getMinMaxValue(this.#lst, 25, 100, false); }
    set Lists(value) { this.#lst = BrightnessSettings.#getMinMaxValue(value, 25, 100, false); }
    get PositionSymbols() { return BrightnessSettings.#getMinMaxValue(this.#pos, 5, 100, true); }
    set PositionSymbols(value) { this.#pos = BrightnessSettings.#getMinMaxValue(value, 5, 100, true); }
    get LimitedDataBlocks() { return BrightnessSettings.#getMinMaxValue(this.#ldb, 5, 100, true); }
    set LimitedDataBlocks(value) { this.#ldb = BrightnessSettings.#getMinMaxValue(value, 5, 100, true); }
    get OtherFDBs() { return BrightnessSettings.#getMinMaxValue(this.#oth, 5, 100, true); }
    set OtherFDBs(value) { this.#oth = BrightnessSettings.#getMinMaxValue(value, 5, 100, true); }
    get Tools() { return BrightnessSettings.#getMinMaxValue(this.#tls, 5, 100, true); }
    set Tools(value) { this.#tls = BrightnessSettings.#getMinMaxValue(value, 5, 100, true); }
    get RangeRings() { return BrightnessSettings.#getMinMaxValue(this.#rr, 5, 100, true); }
    set RangeRings(value) { this.#rr = BrightnessSettings.#getMinMaxValue(value, 5, 100, true); }
    get Compass() { return BrightnessSettings.#getMinMaxValue(this.#cmp, 5, 100, true); }
    set Compass(value) { this.#cmp = BrightnessSettings.#getMinMaxValue(value, 5, 100, true); }
    get BeaconTargets() { return BrightnessSettings.#getMinMaxValue(this.#bcn, 5, 100, true); }
    set BeaconTargets(value) { this.#bcn = BrightnessSettings.#getMinMaxValue(value, 5, 100, true); }
    get PrimaryTargets() { return BrightnessSettings.#getMinMaxValue(this.#pri, 5, 100, true); }
    set PrimaryTargets(value) { this.#pri = BrightnessSettings.#getMinMaxValue(value, 5, 100, true); }
    get History() { return BrightnessSettings.#getMinMaxValue(this.#hst, 5, 100, true); }
    set History(value) { this.#hst = BrightnessSettings.#getMinMaxValue(value, 5, 100, true); }
    get Weather() { return BrightnessSettings.#getMinMaxValue(this.#wx, 5, 100, false); }
    set Weather(value) { this.#wx = BrightnessSettings.#getMinMaxValue(value, 5, 100, false); }
    get WeatherContrast() { return BrightnessSettings.#getMinMaxValue(this.#wxc, 5, 100, false); }
    set WeatherContrast(value) { this.#wxc = BrightnessSettings.#getMinMaxValue(value, 5, 100, false); }

    static #getMinMaxValue(value, min, max, orZero) { // private static int
        if (value >= min && value <= max) {
            return value;
        }
        else if (value < min && (value > 0 || !orZero)) {
            return min;
        }
        else if (value > max) {
            return max;
        }
        else {
            return 0;
        }
    }
}
