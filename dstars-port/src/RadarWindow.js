// Ported 1:1 from _source/RadarWindow.cs  (namespace DGScope) — the main STARS scope class.
// It hosts an OpenTK GLControl and drives the immediate-mode render loop; ported STANDALONE
// (WinForms Control/Form/GLControl/Application wiring -> own fields / commented stubs; GL drawing
// -> the _shims/GL.js immediate-mode shim, verbatim).
//
// ⏳ PORTED IN CHUNKS. Current: lines 1–175 of 6962. The three static members that other modules
// (Aircraft/Radar/MSAW/ConflictAlertSystem/ATPA...) import and use — Aircraft, CurrentTime,
// AdjustedColor — are kept working throughout; real definitions replace stubs as their source is reached.
import { LeaderDirection } from "./STARS/LeaderDirection.js";
import { TimeSync } from "./TimeSync.js";
import { Color, Point, Size, PointF, Font, ContentAlignment } from "./_shims/SystemDrawing.js";
import { WindowState, GameWindow } from "./_shims/OpenTK.js";
import { Stopwatch } from "./_shims/Diagnostics.js";
import { ClockPhase } from "./STARS/ClockPhase.js";
import { VideoMapList } from "./VideoMapList.js";
import { ATPA } from "./ATPA.js";
import { MSAW } from "./MSAW.js";
import { ConflictAlertSystem } from "./ConflictAlertSystem.js";
import { StarsSounds } from "./StarsSounds.js";
import { GeoPoint } from "./GeoPoint.js";
import { Radar } from "./Radar.js";
import { ListOfIReceiver } from "./CustomLists.js";
import { NexradDisplay } from "./NexradDisplay.js";
import { ADSBBeaconReaderSettings } from "./ADSBBeaconReader/ADSBBeaconReaderSettings.js";
import { PrefSet } from "./STARS/PrefSet.js";
import { TransparentLabel } from "./TransparentLabel.js";
import { Waypoints } from "./Waypoints.js";
import { Airports } from "./AirportsXml.js";
import { WeatherService } from "./WeatherService.js";
import { XmlSerializer } from "./XmlSerializer.js";
import { MSAWImporter } from "./MSAWImporter.js";
import { TargetExtentSymbols, SearchTargetParams, AzimuthExtentValues, FusedTrackTargetSymbolParams, BeaconTargetParams, FMATargetSymbolParams } from "./STARS/TargetExtentSymbols.js";

export class RadarWindow {
    // ── static members used across the module graph (keep live during the chunked port) ──
    static Aircraft = [];  // ObservableCollection<Aircraft>  (real init reached in a later chunk)

    static ParseLDR(direction) { // static LeaderDirection
        if (direction == null)
            return LeaderDirection.N;
        direction = direction.toUpperCase().trim();
        switch (direction) {
            case "NW": return LeaderDirection.NW;
            case "N": return LeaderDirection.N;
            case "NE": return LeaderDirection.NE;
            case "W": return LeaderDirection.W;
            case "E": return LeaderDirection.E;
            case "SW": return LeaderDirection.SW;
            case "S": return LeaderDirection.S;
            case "SE": return LeaderDirection.SE;
            default: return LeaderDirection.N;
        }
    }
    static #timesync = new TimeSync(); // private static TimeSync timesync = new TimeSync()
    static #timeManual = false;            // private static bool timeManual
    static #manualTime = new Date(0);      // private static DateTime manualTime
    static #manualTimer = new Stopwatch(); // private static Stopwatch manualTimer
    // [XmlIgnore] public static DateTime CurrentTime
    static get CurrentTime() {
        if (RadarWindow.#timeManual) {
            return new Date(RadarWindow.#manualTime.getTime() + RadarWindow.#manualTimer.Elapsed.TotalMilliseconds); // manualTime + manualTimer.Elapsed
        }
        return RadarWindow.#timesync.CurrentTime();
    }
    static set CurrentTime(value) {
        RadarWindow.#manualTime = value;
        RadarWindow.#manualTimer.Restart();
        RadarWindow.#timeManual = true;
    }

    // ── Colors (config) ──
    // [XmlIgnore] [DisplayName("Background Color"), Category("Colors")]
    BackColor = Color.Black;                          // Color
    RangeRingColor = Color.FromArgb(140, 140, 140);  // Color
    VideoMapLineColor = Color.FromArgb(140, 140, 140);
    VideoMapBLineColor = Color.FromArgb(140, 140, 140);
    ReturnColor = Color.FromArgb(30, 120, 255);
    BeaconTargetColor = Color.FromArgb(0, 255, 0);
    DataBlockColor = Color.Lime;
    PointoutColor = Color.Yellow;
    OwnedColor = Color.White;
    LDBColor = Color.Lime;
    SelectedColor = Color.FromArgb(0, 255, 255);
    DataBlockEmergencyColor = Color.Red;
    RBLColor = Color.White;
    TPAColor = Color.FromArgb(90, 180, 255);
    ATPACautionColor = Color.FromArgb(255, 255, 0);
    ATPAAlertColor = Color.FromArgb(255, 55, 0);

    // ── ARGB XML-serialization helpers ([XmlElement] int <-> Color) ──
    get BackColorAsArgb() { return this.BackColor.ToArgb(); }
    set BackColorAsArgb(value) { this.BackColor = Color.FromArgb(value); }
    get RangeRingColorAsArgb() { return this.RangeRingColor.ToArgb(); }
    set RangeRingColorAsArgb(value) { this.RangeRingColor = Color.FromArgb(value); }
    get VideoMapLineColorAsArgb() { return this.VideoMapLineColor.ToArgb(); }
    set VideoMapLineColorAsArgb(value) { this.VideoMapLineColor = Color.FromArgb(value); }
    get VideoMapBLineColorAsArgb() { return this.VideoMapBLineColor.ToArgb(); }
    set VideoMapBLineColorAsArgb(value) { this.VideoMapBLineColor = Color.FromArgb(value); }
    get ReturnColorAsArgb() { return this.ReturnColor.ToArgb(); }
    set ReturnColorAsArgb(value) { this.ReturnColor = Color.FromArgb(value); }
    get BeaconColorAsArgb() { return this.BeaconTargetColor.ToArgb(); }
    set BeaconColorAsArgb(value) { this.BeaconTargetColor = Color.FromArgb(value); }
    get DataBlockColorAsArgb() { return this.DataBlockColor.ToArgb(); }
    set DataBlockColorAsArgb(value) { this.DataBlockColor = Color.FromArgb(value); }
    get PointoutColorAsArgb() { return this.PointoutColor.ToArgb(); }
    set PointoutColorAsArgb(value) { this.PointoutColor = Color.FromArgb(value); }
    get LDBColorAsArgb() { return this.LDBColor.ToArgb(); }
    set LDBColorAsArgb(value) { this.LDBColor = Color.FromArgb(value); }
    get SelectedColorAsArgb() { return this.SelectedColor.ToArgb(); }
    set SelectedColorAsArgb(value) { this.SelectedColor = Color.FromArgb(value); }

    // ── Ported 1:1 from RadarWindow.cs ~883 (pulled early; other files call RadarWindow.AdjustedColor) ──
    static AdjustedColor(color, brightness) { // static Color AdjustedColor(Color color, int brightness)
        let brightnesslevel = brightness / 100;
        let a = Math.trunc(color.A * 1);
        if (brightnesslevel === 0) {
            a = 0;
        }
        let r = Math.trunc(color.R * brightnesslevel);
        let g = Math.trunc(color.G * brightnesslevel);
        let b = Math.trunc(color.B * brightnesslevel);
        return Color.FromArgb(a, r, g, b);
    }

    get OwnedColorAsArgb() { return this.OwnedColor.ToArgb(); }
    set OwnedColorAsArgb(value) { this.OwnedColor = Color.FromArgb(value); }
    get DataBlockEmergencyColorAsArgb() { return this.DataBlockEmergencyColor.ToArgb(); }
    set DataBlockEmergencyColorAsArgb(value) { this.DataBlockEmergencyColor = Color.FromArgb(value); }
    get RBLColorAsArgb() { return this.RBLColor.ToArgb(); }
    set RBLColorAsArgb(value) { this.RBLColor = Color.FromArgb(value); }
    get TPAColorAsArgb() { return this.TPAColor.ToArgb(); }
    set TPAColorAsArgb(value) { this.TPAColor = Color.FromArgb(value); }

    // [XmlElement("HistoryColors")] int[] <-> Color[]
    get HistoryColorsAsArgb() {
        let array = new Array(this.HistoryColors.length);
        for (let i = 0; i < array.length; i++) {
            array[i] = this.HistoryColors[i].ToArgb();
        }
        return array;
    }
    set HistoryColorsAsArgb(value) {
        if (value == null)
            return;
        this.HistoryColors = new Array(value.length);
        for (let i = 0; i < value.length; i++) {
            this.HistoryColors[i] = Color.FromArgb(value[i]);
        }
    }

    // [XmlIgnore] [DisplayName("History Colors"), Category("Colors")]
    HistoryColors = [Color.FromArgb(30, 80, 200), Color.FromArgb(70, 70, 170), Color.FromArgb(50, 50, 130), Color.FromArgb(40, 40, 110), Color.FromArgb(30, 30, 90)];

    // ── Display properties ──
    FadeTime = 30;          // double
    LostTargetSeconds = 30; // int
    AircraftGCInterval = 60; // int
    ScreenRotation = 0;     // double
    ShowRangeRings = true;  // bool
    #tpasize = true; // private bool tpasize = true
    get TPASize() { return this.#tpasize; }
    set TPASize(value) {
        // lock (Aircraft)
        RadarWindow.Aircraft.forEach(x => { // Aircraft.ToList().ForEach(...)
            if (x.TPA != null)
                x.TPA.ShowSize = value;
        });
        this.#tpasize = value;
    }
    // [Editor(StringCollectionEditor)]
    QuickLookList = [];              // List<string>
    ClockPhase = new ClockPhase();   // ClockPhase
    // (TimeshareInterval property commented out in source)
    HistoryFade = false;
    PrimaryFade = false;
    HistoryDirectionAngle = false;
    InvertMouse = false;
    InvertKeyboard = false;
    // OpenTK GameWindow/GLControl (set in the constructor).
    #window;
    get WindowState() { return this.#window.WindowState; }
    set WindowState(value) { this.#window.WindowState = value; }
    get TargetFrameRate() { return Math.trunc(this.#window.TargetRenderFrequency); }
    set TargetFrameRate(value) { this.#window.TargetRenderFrequency = value; }
    get WindowSize() { return this.#window.Size; }
    set WindowSize(value) { this.#window.Size = value; }
    get WindowLocation() { return this.#window.Location; }
    set WindowLocation(value) {
        this.#window.Location = value;
        if (value.X === -32000 && value.Y === -32000) { // value == new Point(-32000, -32000)
            this.#window.Location = new Point(0, 0);
        }
    }
    // [Editor(VideoMapCollectionEditor)] [XmlIgnore]
    VideoMaps = new VideoMapList(); // VideoMapList
    #videoMapFilename = null;
    get VideoMapFilename() { return this.#videoMapFilename; }
    set VideoMapFilename(value) {
        this.#videoMapFilename = value;
        if (value == null || value === "") {
            this.LoadVideoMapFile();
        }
    }
    VideoMapFiles = []; // List<VideoMapFile>
    // [XmlIgnore]
    ATPA = new ATPA();                       // ATPA
    MSAW = new MSAW();                        // MSAW
    ConflictAlert = new ConflictAlertSystem(); // ConflictAlertSystem
    #sounds = new StarsSounds();             // private readonly StarsSounds sounds

    // ── ATPA facades ──
    get ATPASeparationTable() { return this.ATPA.RequiredSeparation; }
    set ATPASeparationTable(value) { this.ATPA.RequiredSeparation = value; }
    get ATPAVolumes() { return this.ATPA.Volumes; }
    set ATPAVolumes(value) { this.ATPA.Volumes = value; }
    get ATPAActive() { return this.ATPA.Active; }
    set ATPAActive(value) { this.ATPA.Active = value; }
    get ATPAExcludedACIDs() { return this.ATPA.ExcludedACIDs; }
    set ATPAExcludedACIDs(value) { this.ATPA.ExcludedACIDs = [...value]; } // value.ToList()
    get ATPAExcludedSSR() { return this.ATPA.ExcludedSSRCodes; }
    set ATPAExcludedSSR(value) { this.ATPA.ExcludedSSRCodes = value; }
    DrawATPAMonitorCones = false;
    ActiveVolumes = [];              // List<ATPAVolume>
    ActiveATPATwoPointFive = [];     // List<ATPAVolume>

    // ── MSAW facades ──
    get MSAWActive() { return this.MSAW.Active; }
    set MSAWActive(value) { this.MSAW.Active = value; }
    get MSAWLookAheadSeconds() { return this.MSAW.LookAheadSeconds; }
    set MSAWLookAheadSeconds(value) { this.MSAW.LookAheadSeconds = value; }
    get MSAWVolumes() { return this.MSAW.Volumes; }
    set MSAWVolumes(value) { this.MSAW.Volumes = value; }
    get MSAWSuppressionVolumes() { return this.MSAW.SuppressionVolumes; }
    set MSAWSuppressionVolumes(value) { this.MSAW.SuppressionVolumes = value; }
    DrawAllMSAWVolumes = false;
    MSAWSound = true;

    // ── Conflict Alert facades ──
    get ConflictAlertActive() { return this.ConflictAlert.Active; }
    set ConflictAlertActive(value) { this.ConflictAlert.Active = value; }
    get ConflictAlertLookAheadSeconds() { return this.ConflictAlert.LookAheadSeconds; }
    set ConflictAlertLookAheadSeconds(value) { this.ConflictAlert.LookAheadSeconds = value; }
    get ConflictAlertHorizontalSeparation() { return this.ConflictAlert.HorizontalSeparation; }
    set ConflictAlertHorizontalSeparation(value) { this.ConflictAlert.HorizontalSeparation = value; }
    get ConflictAlertVerticalSeparation() { return this.ConflictAlert.VerticalSeparation; }
    set ConflictAlertVerticalSeparation(value) { this.ConflictAlert.VerticalSeparation = value; }
    get ConflictAlertSuppressionVolumes() { return this.ConflictAlert.SuppressionVolumes; }
    set ConflictAlertSuppressionVolumes(value) { this.ConflictAlert.SuppressionVolumes = value; }
    DrawAllCASuppressionVolumes = false;
    ConflictAlertSound = true;

    // [Editor(FileNameEditor)] [XmlIgnore]  MSAW volume import
    get MSAWImportFile() { return ""; }
    set MSAWImportFile(value) {
        if (value == null || value.trim() === "") // IsNullOrWhiteSpace
            return;
        // MSAWImporter.Import is async (fetch) -> fire-and-forget (a setter cannot await).
        (async () => {
            try {
                let imported = await MSAWImporter.Import(value);
                // lock (MSAW.Volumes)
                this.MSAW.Volumes.push(...imported); // AddRange
                console.log(`Imported ${imported.length} MSAW volume(s) from ${value}.`); // MessageBox
            }
            catch (ex) {
                console.log("Error importing " + value + "\r\n" + ex.message);
            }
        })();
    }
    get #scale() { return this.CurrentPrefSet.Range; } // float scale => (float)(CurrentPrefSet.Range)
    #pixelScale = 0;    // float
    #aspect_ratio = 0;  // float
    #oldar = 0;         // float
    // [Editor(StringCollectionEditor)]
    SelectedBeaconCodes = [];         // List<string>
    SelectedBeaconCodeChar = '□';     // char

    #cps = "NONE"; // private string cps = "NONE"
    // [XmlIgnore] This Position Indicator
    get ThisPositionIndicator() { return this.#cps; }
    set ThisPositionIndicator(value) {
        if (this.#cps !== value) {
            this.#cps = value;
            this.PositionChange();
        }
    }
    // [Editor(FileNameEditor)]  Airports file
    get AirportsFileName() { return this.#airportsFileName; }
    set AirportsFileName(value) {
        // XmlSerializer<Airports>.DeserializeFromFile is async (fetch) -> fire-and-forget setter.
        (async () => {
            try {
                this.Airports = (await XmlSerializer.DeserializeFromFile(value, Airports)).Airport; // .ToList()
                this.#airportsFileName = value;
                this.OrderWaypoints();
            }
            catch (e) {
                this.Airports = new Airports().Airport;
            }
        })();
    }
    #airportsFileName = ""; // private string
    // [Editor(FileNameEditor)]  Waypoints file
    get WaypointsFileName() { return this.#waypointsFileName; }
    set WaypointsFileName(value) {
        (async () => {
            try {
                this.Waypoints = (await XmlSerializer.DeserializeFromFile(value, Waypoints)).Waypoint;
                this.#waypointsFileName = value;
                this.OrderWaypoints();
            }
            catch (e) {
                this.Waypoints = new Waypoints().Waypoint;
            }
        })();
    }
    #waypointsFileName = ""; // private string
    get AltimeterStations() { return [...this.#wx.AltimeterStations]; } // wx.AltimeterStations.ToArray()
    set AltimeterStations(value) {
        this.#wx.AltimeterStations = [...value]; // value.ToList()
        this.cbWxUpdateTimer(null);
    }
    #radar; // private Radar radar
    // [Editor(ReceiverCollectionEditor)]
    Receivers = new ListOfIReceiver(); // ListOfIReceiver
    #_homeLocation = new GeoPoint(0, 0); // private GeoPoint
    get HomeLocation() { return this.#_homeLocation; } // Facility Center
    set HomeLocation(value) {
        this.#_homeLocation = value;
        this.OrderWaypoints();
    }
    MaxAltitude = 0;             // int
    MinAltitude = 0;            // int
    MinAltitudeAssociated = -9900; // int
    MaxAltitudeAssociated = 99900; // int
    RadarSites = [];            // List<Radar>
    get ActiveRadarSite() { return this.RadarSites.indexOf(this.#radar); } // int
    set ActiveRadarSite(value) {
        if (value >= this.RadarSites.length) {
            this.#radar = this.RadarSites[this.RadarSites.length - 1]; // .Last()
        }
        else if (value < 0) {
            this.#radar = Radar.FUSED;
        }
        else {
            this.#radar = this.RadarSites[value];
        }
    }
    // Vertical Sync
    get VSync() { return this.#window.VSync; }
    set VSync(value) { this.#window.VSync = value; }
    // Target Extent Symbols (nested object initializers -> Object.assign)
    TargetExtentSymbols = Object.assign(new TargetExtentSymbols(), {
        SearchTargets: Object.assign(new SearchTargetParams(), {
            RangeExtent: 5,
            AzimuthExtents: Object.assign(new AzimuthExtentValues(), { Ten: 28, Twenty: 19, Thirty: 16, Forty: 12, Fifty: 11, Sixty: 9 }),
            AzimuthExtentMinimum: 75,
        }),
        FusedTracks: Object.assign(new FusedTrackTargetSymbolParams(), { MinimumPixelDimension: 12, NormalSymbolDistanceDimension: 22, SymbolOpacity: 100 }),
        BeaconTargets: Object.assign(new BeaconTargetParams(), { RangeExtent: 1, AzimuthExtentFactor: 20, RangeOffset: 3 }),
        PositionSymbolOffset: 8,
        FMATargetSymbols: Object.assign(new FMATargetSymbolParams(), { Radius: 3 }),
    });
    TPAConeWidth = 10; // float
    Nexrad = new NexradDisplay(); // NexradDisplay
    Nexrads = null;               // List<NexradDisplay>
    // [XmlIgnore] Data Block Font
    Font = new Font("Consolas", 10); // Font
    // [XmlElement("FontName")]  (C# Font.FontFamily.Name -> our Font.FontFamily is the name string)
    get FontName() { return this.Font.FontFamily; }
    set FontName(value) { this.Font = new Font(value, this.Font.Size, this.Font.Unit); }
    get FontSize() { return Math.trunc(this.Font.Size); }
    set FontSize(value) { this.Font = new Font(this.Font.FontFamily, value, this.Font.Unit); }
    get FontSizeUnit() { return this.Font.Unit; }
    set FontSizeUnit(value) { this.Font = new Font(this.Font.FontFamily, this.Font.Size, value); }
    // DCB Font (dcb field ported in a later chunk)
    get DCBFont() { return this.dcb.Font; }
    set DCBFont(value) { this.dcb.Font = value; }
    get DCBFontName() { return this.DCBFont.FontFamily; }
    set DCBFontName(value) { this.DCBFont = new Font(value, this.DCBFont.Size, this.DCBFont.Unit); }
    get DCBFontSize() { return Math.trunc(this.DCBFont.Size); }
    set DCBFontSize(value) { this.DCBFont = new Font(this.DCBFont.FontFamily, value, this.DCBFont.Unit); }
    get DCBFontSizeUnit() { return this.DCBFont.Unit; }
    set DCBFontSizeUnit(value) { this.DCBFont = new Font(this.DCBFont.FontFamily, this.DCBFont.Size, value); }
    AutoOffset = false; // bool
    // NTP
    get NTPServerAddress() { return RadarWindow.#timesync.Server; }
    set NTPServerAddress(value) { RadarWindow.#timesync.Server = value; }
    // [XmlIgnore] TimeSpan
    get NTPInterval() { return RadarWindow.#timesync.TimeSyncInterval; }
    set NTPInterval(value) { RadarWindow.#timesync.TimeSyncInterval = value; }
    get NTPIntervalMs() { return Math.trunc(this.NTPInterval.TotalMilliseconds); }
    set NTPIntervalMs(value) { this.NTPInterval = { TotalMilliseconds: value }; } // TimeSpan.FromMilliseconds(value)
    PreviewLocation = new PointF();  // PointF
    StatusLocation = new PointF();   // PointF
    ShowLACAMCIList = true;          // bool
    LACAMCIListLocation = new PointF(20, 100); // PointF
    WindInStatusArea = false;        // bool
    FPSInStatusArea = false;         // bool
    ADSBSettings = new ADSBBeaconReaderSettings(); // ADSBBeaconReaderSettings
    #adsbService; // private ADSBBeaconReaderService
    UseADSBCallsigns = false;          // bool
    UseADSBCallsigns1200 = false;      // bool
    UseADSBCallsignsAssociated = false; // bool
    QuickLook = false;                 // bool
    // Pref Set
    get CurrentPrefSet() { return this.#prefSet; }
    set CurrentPrefSet(value) {
        this.#prefSet = value;
        this.VideoMaps.forEach(x => x.Visible = value.DisplayedMaps.includes(x.Number)); // DisplayedMaps.Contains(x.Number)
    }
    #atises = new Array(10).fill(null);   // char?[10]
    #gentexts = new Array(10).fill(null); // string?[10]
    #prefSet = new PrefSet();             // private PrefSet
    #isScreenSaver = false;               // private bool
    get #ScreenCenterPoint() { return this.CurrentPrefSet.ScopeCentered ? this.HomeLocation : this.CurrentPrefSet.ScreenCenterPoint; }
    get #RangeRingCenter() { return this.CurrentPrefSet.RangeRingsCentered ? this.HomeLocation : this.CurrentPrefSet.RangeRingLocation; }
    #PreviewArea = Object.assign(new TransparentLabel(), { TextAlign: ContentAlignment.MiddleLeft, AutoSize: true });
    #StatusArea = Object.assign(new TransparentLabel(), { TextAlign: ContentAlignment.MiddleLeft, AutoSize: true });
    #LACAMCIListArea = Object.assign(new TransparentLabel(), { TextAlign: ContentAlignment.MiddleLeft, AutoSize: true });
    #SSAAlertRed = Object.assign(new TransparentLabel(), { TextAlign: ContentAlignment.MiddleLeft, AutoSize: true });
    #SSAAlertYellow = Object.assign(new TransparentLabel(), { TextAlign: ContentAlignment.MiddleLeft, AutoSize: true });

    // C# constructors RadarWindow(GameWindow Window) and RadarWindow() merged.
    constructor(Window = undefined) {
        this.#window = (Window !== undefined) ? Window : new GameWindow(1000, 1000);
        this.Initialize();
    }
    #rangeBearingLines = []; // List<RangeBearingLine>
    #minSeps = [];           // List<MinSep>
    #wxUpdateTimer;          // Timer
    #timeshareinterval = 1500; // int
    #dataBlockTimeshareTimer; // Timer
    Waypoints = new Waypoints().Waypoint; // List<WaypointsWaypoint> (new Waypoints().Waypoint.ToList())
    Airports = new Airports().Airport;    // List<Airport>
    #wx = new WeatherService();           // WeatherService

    // Stub — real Initialize()/OrderWaypoints()/PositionChange()/cbWxUpdateTimer() ported in later chunks.
    Initialize() { /* GL/timer/event setup — ported in a later chunk */ }

    // ===== PORTED THROUGH LINE 882 / 6962 — next chunk continues here (AdjustedColor @883 already ported) =====
}
