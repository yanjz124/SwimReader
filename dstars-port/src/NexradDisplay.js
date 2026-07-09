// Ported 1:1 from _source/NexradDisplay.cs
// namespace DGScope
// [TypeConverter(typeof(ExpandableObjectConverter))]
// Timer -> setInterval; WebClient -> fetch; Dictionary -> Map; Vector2 (System.Numerics) shim.
// NWSNexrad binary decode uses the external NexradDecoder stub (deferred); ScopeServer works.
import { GeoPoint } from "./GeoPoint.js";
import { Color, PointF } from "./_shims/SystemDrawing.js";
import { WXColor, WXColorTable, StippleType } from "./WXColorTable.js";
import { Vector2 } from "./_shims/OpenTK.js";
import { RadialPacketDecoder } from "./_shims/NexradDecoder.js";

export class NexradDisplay {
    WxRadarMode = WxRadarMode.ScopeServer;      // WxRadarMode { get; set; }
    #scopeServerRadars = new Map();             // Dictionary<string, ScopeServerWxRadarReport>
    // [DisplayName("Color Table"), Description(...)]
    ColorTable = [];                            // List<WXColor>
    // [Browsable(false)]
    Name = null;                                // string
    #enabled = true;                            // bool enabled = true
    get Enabled() { return this.#enabled; }
    set Enabled(value) {
        if (this.#timer == null && !this.#enabled && value)
            this.#timer = this.#startTimer(); // new Timer(cb, null, 0, DownloadInterval*1000)
        else if (!this.#enabled && value)
            this.#restartTimer();             // timer.Change(0, DownloadInterval*1000)
        this.#enabled = value;
    }
    // [Description("URL for NWS Radar Product File")]
    URL = null;                                 // string
    // [Description("Product Download Interval (sec.)")]
    DownloadInterval = 300;                     // int
    // [TypeConverter(typeof(ITWSSensorIDStringConverter))]
    SensorID = null;                            // string
    // [Browsable(false)] [XmlIgnore]
    LevelsAvailable = new Array(6).fill(false); // bool[6]
    get LevelsEnabled() { return NexradDisplay.#colortable == null ? this.#dummyLevelsE : NexradDisplay.#colortable.LevelsEnabled; } // bool[]
    // [Browsable(false)] [XmlIgnore]
    get Sensors() { return [...this.#scopeServerRadars.keys()]; } // List<string>
    #decoder = new RadialPacketDecoder();       // RadialPacketDecoder
    #symbology;                                 // RadialSymbologyBlock
    #description;                               // DescriptionBlock
    #dummyLevelsE = new Array(6).fill(false);   // bool[6]
    #dummyLevelsA = new Array(6).fill(false);   // bool[6]
    #gotdata = false;                           // bool

    async GetRadarData(url) { // void GetRadarData(string url)  -> async (WebClient -> fetch)
        if (!this.Enabled)
            return;
        if (url == null || url === "")
            return;
        try {
            // WebClient.OpenRead(url) + CopyTo(MemoryStream) -> fetch arrayBuffer
            const response = await fetch(url);
            const stream = new Uint8Array(await response.arrayBuffer());
            this.#decoder.setStreamResource(stream);
            this.#decoder.parseMHB();
            this.#description = this.#decoder.parsePDB();
            this.#symbology = this.#decoder.parsePSB();
            this.#gotdata = true;
        }
        catch (ex) {
        }
        this.RecomputeVertices();
    }
    constructor() {
    }
    #timer; // System.Threading.Timer
    #startTimer() {
        this.#cbTimerElapsed(null); // dueTime 0 -> fire immediately
        const t = (typeof setInterval !== "undefined") ? setInterval(() => this.#cbTimerElapsed(null), this.DownloadInterval * 1000) : 0;
        if (t && t.unref) t.unref();
        return t;
    }
    #restartTimer() { if (this.#timer && typeof clearInterval !== "undefined") clearInterval(this.#timer); this.#timer = this.#startTimer(); }
    #cbTimerElapsed(state) {
        this.GetRadarData(this.URL);
    }
    #recompute = true; // bool
    Polygons() { // Polygon[]
        if (this.#timer == null)
            this.#timer = this.#startTimer();
        if (this.#polygons == null || !this.Enabled)
            return []; // new Polygon[0]
        return this.#polygons;
    }

    #polygons; // Polygon[]

    #_center = new GeoPoint(); // GeoPoint
    #_scale = 0;   // double
    #_rotation = 0; // double

    static #colortable; // private static WXColorTable colortable
    RecomputeVertices() {
        if (this.ColorTable.length === 0) {
            this.ColorTable = [
                new WXColor(20, Color.FromArgb(38, 77, 77)),
                new WXColor(30, Color.FromArgb(38, 77, 77), Color.White, StippleType.LIGHT),
                new WXColor(40, Color.FromArgb(38, 77, 77), Color.White, StippleType.DENSE),
                new WXColor(45, Color.FromArgb(100, 100, 51)),
                new WXColor(50, Color.FromArgb(100, 100, 51), Color.White, StippleType.LIGHT),
                new WXColor(55, Color.FromArgb(100, 100, 51), Color.White, StippleType.DENSE),
            ];
        }
        if (NexradDisplay.#colortable == null) {
            NexradDisplay.#colortable = new WXColorTable(this.ColorTable);
        }
        if (!this.#gotdata && this.WxRadarMode === WxRadarMode.NWSNexrad)
            return;
        let polygons = []; // List<Polygon>
        let radarLocation; // GeoPoint
        let availableLevels = new Array(6).fill(false); // bool[6]
        switch (this.WxRadarMode) {
            case WxRadarMode.NWSNexrad: {
                radarLocation = new GeoPoint(this.#description.Latitude, this.#description.Longitude);
                let range;
                switch (this.#description.Code) {
                    case 94: range = 248; break;
                    case 180: range = 48; break;
                    default: return;
                }
                let scanrange = range * Math.cos(this.#description.ProductSpecific_3 * (Math.PI / 180));
                let resolution = scanrange / this.#symbology.LayerNumberOfRangeBins;
                for (let i = 0; i < this.#symbology.NumberOfRadials; i++) {
                    for (let j = 0; j < this.#symbology.Radials[i].ColorValues.length; j++) {
                        if (this.#symbology.Radials[i].ColorValues[j] > 0) {
                            let polygon = new Polygon();
                            polygon.Points.push(radarLocation.FromPoint(resolution * j, this.#symbology.Radials[i].StartAngle));
                            polygon.Points.push(radarLocation.FromPoint(resolution * j, this.#symbology.Radials[i].StartAngle + this.#symbology.Radials[i].AngleDelta));
                            polygon.Points.push(radarLocation.FromPoint(resolution * (j + 1), this.#symbology.Radials[i].StartAngle + this.#symbology.Radials[i].AngleDelta));
                            polygon.Points.push(radarLocation.FromPoint(resolution * (j + 1), this.#symbology.Radials[i].StartAngle));
                            let color = NexradDisplay.#colortable.GetWXColor(this.#symbology.Radials[i].Values[j], availableLevels);
                            if (color != null) {
                                polygon.Color = color.MinColor;
                                if (color.StippleColor != null)
                                    polygon.StippleColor = color.StippleColor;
                                if (color.StipplePattern != null)
                                    polygon.StipplePattern = color.StipplePattern;
                                polygon.ComputeVertices();
                                polygons.push(polygon);
                            }
                        }
                    }
                }
                this.LevelsAvailable = availableLevels;
                break;
            }
            case WxRadarMode.ScopeServer: {
                if (this.SensorID == null || this.SensorID === "") {
                    if (this.#scopeServerRadars.size === 0) {
                        break;
                    }
                    this.SensorID = [...this.#scopeServerRadars.keys()][0]; // Keys.First()
                }
                let radar = this.#scopeServerRadars.get(this.SensorID); // TryGetValue
                if (radar !== undefined) {
                    const METER_TO_NM = 0.000539957;
                    let rotation = radar.Rotation; // (double)radar.Rotation
                    radarLocation = radar.ReferencePoint.FromPoint(radar.OriginOffset.Y * METER_TO_NM, 360 + rotation).FromPoint(radar.OriginOffset.X * METER_TO_NM, 90 + rotation);
                    let rowStart = radarLocation.FromPoint(radar.GridSize.Y * radar.BoxSize.Y * METER_TO_NM, 360 + rotation);
                    for (let y = 0; y < radar.Values.length; y++) {
                        let row = radar.Values[y];
                        let lastPoint = rowStart;
                        for (let x = 0; x < row.length; x++) {
                            let polygon = new Polygon();
                            polygon.Points.push(lastPoint);
                            polygon.Points.push(lastPoint.FromPoint(radar.BoxSize.Y * METER_TO_NM, rotation));
                            polygon.Points.push(lastPoint.FromPoint(radar.BoxSize.Y * METER_TO_NM, rotation).FromPoint(radar.BoxSize.X * METER_TO_NM, 90 + rotation));
                            lastPoint = lastPoint.FromPoint(radar.BoxSize.X * METER_TO_NM, 90 + rotation);
                            polygon.Points.push(lastPoint);
                            let color = NexradDisplay.#colortable.GetWXColor(radar.Values[y][x], availableLevels);
                            if (color != null) {
                                polygon.Color = color.MinColor;
                                if (color.StippleColor != null)
                                    polygon.StippleColor = color.StippleColor;
                                if (color.StipplePattern != null)
                                    polygon.StipplePattern = color.StipplePattern;
                                polygon.ComputeVertices();
                                polygons.push(polygon);
                            }
                        }
                        rowStart = rowStart.FromPoint(radar.BoxSize.Y * METER_TO_NM, 180 + rotation);
                    }
                }
                break;
            }
        }
        this.LevelsAvailable = availableLevels;
        this.#polygons = polygons; // .ToArray()
    }

    AddWeatherRadarReport(RadarID, report) {
        // lock (scopeServerRadars)
        {
            if (!this.#scopeServerRadars.has(RadarID)) {
                this.#scopeServerRadars.set(RadarID, report);
            }
            else {
                this.#scopeServerRadars.set(RadarID, report);
            }
        }
        this.RecomputeVertices();
    }
    toString() {
        if (this.Name == null || this.Name === "") {
            return this.SensorID;
        }
        return this.Name;
    }
}

export class Polygon {
    vertices = null; // PointF[]
    Points = [];     // List<GeoPoint> { get; set; }
    Color = null;    // Color { get; set; }
    StippleColor = null; // Color { get; set; }
    StipplePattern = null; // byte[] { get; set; }

    ComputeVertices() {
        let points; // GeoPoint[]
        // lock (Points)
        points = [...this.Points]; // Points.ToArray()
        this.vertices = new Array(points.length);
        for (let i = 0; i < points.length; i++) {
            // C# mutates struct PointF elements; equivalent to assigning a new PointF.
            this.vertices[i] = new PointF(points[i].Longitude, points[i].Latitude);
        }
    }
}

export const WxRadarMode = Object.freeze({ NWSNexrad: 0, ScopeServer: 1 });

// struct ScopeServerWxRadarReport
export class ScopeServerWxRadarReport {
    ReferencePoint = null; // GeoPoint { get; set; }
    OriginOffset = new Vector2(); // Vector2 { get; set; }
    BoxSize = new Vector2();      // Vector2 { get; set; }
    GridSize = new Vector2();     // Vector2 { get; set; }
    Values = null;                // byte[][] { get; set; }
    Rotation = 0;                 // decimal { get; set; }
}
