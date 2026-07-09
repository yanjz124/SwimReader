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
import { GL } from "./_shims/GL.js";
import { Timer, TimerCallback } from "./_shims/Threading.js";
import { MD5 } from "./_shims/Crypto.js";
import { ObservableCollection, NotifyCollectionChangedAction } from "./_shims/Collections.js";
import { TCP } from "./STARS/TCP.js";
import { MapCategory } from "./VideoMap.js";
import { tryParseInt } from "./_shims/Primitives.js";
import { Task } from "./_shims/Threading.js";
import { Altitude } from "./Altitude.js";
import { ADSBBeaconReaderService } from "./ADSBBeaconReader/ADSBBeaconReaderService.js";
import { Aircraft } from "./Aircraft.js";
import { DCBSubmenuButton, DCBAdjustmentButton } from "./DCBButton.js";
import { Keyboard, Key, Mouse, ButtonState, Vector4 } from "./_shims/OpenTK.js";
import { Clipboard } from "./_shims/WinForms.js";
import { Environment } from "./_shims/System.js";

export class RadarWindow {
    // ── static members used across the module graph (keep live during the chunked port) ──
    static Aircraft = new ObservableCollection();  // ObservableCollection<Aircraft>

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

    #aircraftGCTimer; // Timer
    #settingshash;    // byte[]

    // ADAPTATION: VideoMapList.DeserializeFromJsonFile is async (fetch) in the browser, so this
    // method — synchronous void in C# — becomes async. Callers are fire-and-forget or awaited.
    async LoadVideoMapFile() {
        try {
            this.VideoMaps.Clear(); // Start fresh

            // NEW MULTI-FILE SYSTEM: Check if VideoMapFiles has entries
            if (this.VideoMapFiles != null && this.VideoMapFiles.length > 0) {
                // Warn about duplicate map numbers
                let counts = new Map();
                for (const vmf of this.VideoMapFiles) counts.set(vmf.MapNumber, (counts.get(vmf.MapNumber) || 0) + 1);
                let duplicateMapNumbers = [...counts.entries()].filter(([, c]) => c > 1).map(([k]) => k);

                if (duplicateMapNumbers.length > 0) { // Any()
                    console.log( // MessageBox.Show
                        `Warning: Duplicate MapNumber(s) detected in VideoMapFiles: ${duplicateMapNumbers.join(", ")}\n` +
                        "Maps will be auto-renumbered to avoid conflicts.");
                }

                // Clear DCBMapList to prevent old button assignments from persisting
                for (let i = 0; i < TCP.DCBMapList.length; i++) {
                    TCP.DCBMapList[i] = -1; // -1 means unassigned (no map will match)
                }

                // Load from multiple configured files
                let nextAutoMapNumber = 1; // For auto-assigning map numbers when not specified

                for (const mapFile of this.VideoMapFiles) {
                    if (mapFile.Filepath == null || mapFile.Filepath === "") { // IsNullOrEmpty
                        console.log("VideoMapFile entry has empty Filepath. Skipping.");
                        continue;
                    }

                    // ADAPTATION: System.IO.File.Exists cannot be checked synchronously in the browser;
                    // a missing file surfaces as a fetch failure caught by the try/catch below.
                    // if (!System.IO.File.Exists(mapFile.Filepath)) { … continue; }

                    // Load maps from this file
                    let loadedMaps = null; // VideoMapList
                    try {
                        loadedMaps = await VideoMapList.DeserializeFromJsonFile(mapFile.Filepath);
                    }
                    catch (loadEx) {
                        console.log( // MessageBox.Show
                            `Failed to parse GeoJSON file: ${mapFile.Filepath}\n\n` +
                            `Error: ${loadEx.message}\n\n` +
                            `Ensure the file is valid GeoJSON with LineString or GeometryCollection features.`);
                        continue;
                    }

                    if (loadedMaps == null || loadedMaps.length === 0) {
                        console.log( // MessageBox.Show
                            `No maps found in file: ${mapFile.Filepath}\n\n` +
                            `The file was loaded but contains no displayable map data.`);
                        continue;
                    }

                    // Apply metadata from XML configuration to loaded maps
                    let assignedMapNumber = mapFile.MapNumber; // Track actual assigned number for DCB mapping

                    for (const map of loadedMaps) {
                        // Fallback to filename (without extension) if names not specified
                        let fallbackName = this.#getFileNameWithoutExtension(mapFile.Filepath); // Path.GetFileNameWithoutExtension

                        // Auto-assign map number if not specified (0 or negative)
                        if (mapFile.MapNumber <= 0) {
                            map.Number = nextAutoMapNumber++;
                            assignedMapNumber = map.Number; // Remember the auto-assigned number
                        }
                        else {
                            map.Number = mapFile.MapNumber;
                        }

                        if (!(mapFile.ShortName == null || mapFile.ShortName === "")) // !IsNullOrEmpty
                            map.Mnemonic = mapFile.ShortName;
                        else
                            map.Mnemonic = fallbackName;

                        if (!(mapFile.FullName == null || mapFile.FullName === "")) // !IsNullOrEmpty
                            map.Name = mapFile.FullName;
                        else
                            map.Name = fallbackName;

                        // BrightnessGroup defaults to A if not specified
                        map.Category = mapFile.BrightnessGroup;

                        // Add to master collection (handles number conflicts automatically)
                        this.VideoMaps.Add(map);
                    }

                    // Update DCBMapList if DCBButton is specified (single "3" or comma-separated "3,11")
                    if (!(mapFile.DCBButton == null || mapFile.DCBButton.trim() === "")) { // !IsNullOrWhiteSpace
                        let buttonStrings = mapFile.DCBButton.split(/[,;]/).filter(s => s.length > 0); // Split(RemoveEmptyEntries)
                        for (const buttonStr of buttonStrings) {
                            let buttonNumber = { value: 0 };
                            if (tryParseInt(buttonStr.trim(), buttonNumber)) {
                                if (buttonNumber.value >= 1 && buttonNumber.value <= TCP.DCBMapList.length) {
                                    TCP.DCBMapList[buttonNumber.value - 1] = assignedMapNumber;
                                }
                            }
                        }
                    }
                }
            }
            // BACKWARD COMPATIBILITY: Fall back to old single-file system
            else if (!(this.#videoMapFilename == null || this.#videoMapFilename === "")) { // !IsNullOrEmpty(videoMapFilename)
                this.VideoMaps = await VideoMapList.DeserializeFromJsonFile(this.#videoMapFilename);
            }

            // Apply visibility state from preferences
            if (this.VideoMaps != null && this.CurrentPrefSet != null && this.CurrentPrefSet.DisplayedMaps != null) {
                this.VideoMaps.forEach(x => x.Visible = this.CurrentPrefSet.DisplayedMaps.includes(x.Number)); // Contains
            }
        }
        catch (ex) {
            console.log(`Error loading video maps: ${ex.message}\n\nStack trace:\n${ex.stack}`); // MessageBox.Show
        }
    }

    // Path.GetFileNameWithoutExtension helper (no System.IO in the browser).
    #getFileNameWithoutExtension(path) {
        let base = path.split(/[\\/]/).pop();
        let dot = base.lastIndexOf(".");
        return dot > 0 ? base.substring(0, dot) : base;
    }

    Initialize() {
        this.#window.Title = "DGScope";
        this.#window.Load.add(this.Window_Load.bind(this));                       // window.Load += Window_Load
        this.#window.Closing.add(this.Window_Closing.bind(this));
        this.#window.RenderFrame.add(this.Window_RenderFrame.bind(this));
        this.#window.UpdateFrame.add(this.Window_UpdateFrame.bind(this));
        this.#window.Resize.add(this.Window_Resize.bind(this));
        this.#window.WindowStateChanged.add(this.Window_WindowStateChanged.bind(this));
        this.#window.KeyDown.add(this.Window_KeyDown.bind(this));
        this.#window.KeyPress.add(this.Window_KeyPress.bind(this));
        this.#window.KeyUp.add(this.Window_KeyUp.bind(this));
        this.#window.MouseWheel.add(this.Window_MouseWheel.bind(this));
        this.#window.MouseMove.add(this.Window_MouseMove.bind(this));
        this.#window.MouseDown.add(this.Window_MouseDown.bind(this));
        this.#window.MouseUp.add(this.Window_MouseUp.bind(this));
        if (this.RadarSites.length > 0)
            this.#radar = this.RadarSites[0];
        else
            this.#radar = new Radar();
        this.#aircraftGCTimer = new Timer(new TimerCallback(this.cbAircraftGarbageCollectorTimer.bind(this)), null, this.AircraftGCInterval * 1000, this.AircraftGCInterval * 1000);
        this.#wxUpdateTimer = new Timer(new TimerCallback(this.cbWxUpdateTimer.bind(this)), null, 0, 180000);
        GL.ClearColor(RadarWindow.AdjustedColor(this.BackColor, this.CurrentPrefSet.Brightness.Background));
        let settingsstring = XmlSerializer.Serialize(this); // XmlSerializer<RadarWindow>.Serialize(this)
        if (settingsstring != null) {
            {
                let md5 = MD5.Create();
                md5.Initialize();
                md5.ComputeHash(new TextEncoder().encode(settingsstring)); // Encoding.UTF8.GetBytes
                this.#settingshash = md5.Hash;
            }
        }
        else {
            this.#settingshash = new Uint8Array(0); // new byte[0]
        }
        this.OrderWaypoints();
        RadarWindow.Aircraft.CollectionChanged.add(this.Aircraft_CollectionChanged.bind(this)); // Aircraft.CollectionChanged += …
    }

    Window_MouseUp(sender, e) { // (object sender, MouseButtonEventArgs e)
        if (this.CurrentPrefSet.DCBVisible)
            this.dcb.ActiveMenu.MouseUp();
    }

    Aircraft_CollectionChanged(sender, e) { // (object sender, NotifyCollectionChangedEventArgs e)
        switch (e.Action) {
            case NotifyCollectionChangedAction.Add:
                for (const item of e.NewItems) { // foreach (Aircraft item in e.NewItems)
                    item.HandedOff.add(this.Aircraft_HandedOff);           // += (stable arrow-field ref, see below)
                    item.HandoffInitiated.add(this.Aircraft_HandoffInitiated);
                    item.Transferred.add(this.Aircraft_Transferred);
                    item.OwnershipChange.add(this.Aircraft_OwnershipChange);
                    if (item.Altitude == null)
                        item.Altitude = new Altitude();
                    item.Altitude.SetAltitudeProperties(18000, this.#wx.Altimeter);
                    item.SetSelectedSquawkList(this.SelectedBeaconCodes, this.SelectedBeaconCodeChar);
                }
                break;
            case NotifyCollectionChangedAction.Remove:
                for (const item of e.OldItems) { // foreach (Aircraft item in e.OldItems)
                    item.HandedOff.remove(this.Aircraft_HandedOff);        // -=
                    item.OwnershipChange.remove(this.Aircraft_OwnershipChange);
                    item.HandoffInitiated.remove(this.Aircraft_HandoffInitiated);
                    item.Transferred.remove(this.Aircraft_Transferred);

                    this.DeletePlane(item, false);
                }
                break;
        }
    }

    DeletePlane(plane, leaveHistory = true) {
        // lock (plane) / lock (dataBlocks) / lock (posIndicators) / … — no-ops (single-threaded JS)
        {
            {
                this.dataBlocks.Remove(plane.DataBlock);
                this.dataBlocks.Remove(plane.DataBlock2);
                this.dataBlocks.Remove(plane.DataBlock3);
            }
            {
                this.posIndicators.Remove(plane.PositionIndicator);
            }
            // rangeBearingLines.RemoveAll(line => line.EndPlane == plane || line.StartPlane == plane)
            for (let i = this.#rangeBearingLines.length - 1; i >= 0; i--)
                if (this.#rangeBearingLines[i].EndPlane === plane || this.#rangeBearingLines[i].StartPlane === plane)
                    this.#rangeBearingLines.splice(i, 1);
            // minSeps.RemoveAll(minsep => minsep.Plane1 == plane || minsep.Plane2 == plane)
            for (let i = this.#minSeps.length - 1; i >= 0; i--)
                if (this.#minSeps[i].Plane1 === plane || this.#minSeps[i].Plane2 === plane)
                    this.#minSeps.splice(i, 1);
            plane.Deleted = true;
            this.#deletedPlanes.push(plane); // deletedPlanes.Add(plane)
        }
    }

    // ── The 4 per-aircraft event handlers are arrow-field properties, NOT methods. ──
    // ADAPTATION: C# subscribes/unsubscribes with method groups (`x.HandedOff += Aircraft_HandedOff`
    // then `-= Aircraft_HandedOff`), which are stable references. `this.method.bind(this)` would mint
    // a fresh function each time, so `-=` could never find it. Arrow class fields give one stable
    // per-instance reference, preserving the +=/-= symmetry exactly.
    Aircraft_HandoffInitiated = (sender, e) => { // (object sender, HandoffEventArgs e)
        if (e.PositionTo === this.ThisPositionIndicator) {
            if (e.Aircraft.Owned && e.Aircraft.DataBlock.Flashing)
                return;
            e.Aircraft.Owned = true;
            e.Aircraft.DataBlock.Flashing = true;
            e.Aircraft.DataBlock2.Flashing = true;
            e.Aircraft.DataBlock3.Flashing = true;
        }
        /*if (e.Aircraft.LastPositionTime > CurrentTime.AddSeconds(-LostTargetSeconds))
            GenerateDataBlock(e.Aircraft);*/
    };

    Aircraft_OwnershipChange = (sender, e) => { // (object sender, AircraftEventArgs e)
        /*e.Aircraft.RedrawDataBlock();*/
    };

    PositionChange() {
        // lock (Aircraft)
        {
            let aclist = [...RadarWindow.Aircraft]; // Aircraft.ToList()
            aclist.forEach(x => x.Owned = x.PositionInd === this.ThisPositionIndicator || x.PendingHandoff === this.ThisPositionIndicator);
            aclist.forEach(x => x.DataBlock.Flashing = x.PendingHandoff === this.ThisPositionIndicator);
            aclist.forEach(x => x.DataBlock2.Flashing = x.PendingHandoff === this.ThisPositionIndicator);
            aclist.forEach(x => x.DataBlock3.Flashing = x.PendingHandoff === this.ThisPositionIndicator);
            aclist.forEach(x => x.FDB = false);
        }
        // QuickLookList.Remove(item) — List<string>.Remove removes first matching element
        { let i = this.QuickLookList.indexOf(this.ThisPositionIndicator); if (i >= 0) this.QuickLookList.splice(i, 1); }
        { let i = this.QuickLookList.indexOf(this.ThisPositionIndicator + "+"); if (i >= 0) this.QuickLookList.splice(i, 1); }
    }

    Aircraft_HandedOff = (sender, e) => { // (object sender, HandoffEventArgs e)
        /*e.Aircraft.RedrawDataBlock(false);*/
    };

    // CRC STARS spec: when the receiving controller accepts your outbound handoff, the data block
    // blinks white for 5 seconds, then stays white until you click. Stamp JustTransferredAt and turn
    // on Flashing; the render loop's Flashing-clear branch is guarded to skip clearing during the 5s.
    Aircraft_Transferred = (sender, e) => { // (object sender, HandoffEventArgs e)
        if (e.PositionFrom === this.ThisPositionIndicator) {
            e.Aircraft.JustTransferredAt = new Date(); // DateTime.UtcNow
            e.Aircraft.DataBlock.Flashing = true;
            e.Aircraft.DataBlock2.Flashing = true;
            e.Aircraft.DataBlock3.Flashing = true;
        }
    };

    // #settingshash declared in the previous chunk (byte[] settingshash)
    #settingsPath; // string settingsPath
    Run(isScreenSaver, settingsPath) {
        this.#settingsPath = settingsPath;
        this.#isScreenSaver = isScreenSaver;
        this.#window.Run();
    }

    cbWxUpdateTimer(state) {
        Task.Run(() => this.#wx.GetWeather(true));
    }

    cbAircraftGarbageCollectorTimer(state) {
        let delplane; // List<Aircraft>
        // lock (Aircraft)
        delplane = RadarWindow.Aircraft.filter(x => x.LastMessageTime < this.#addSeconds(RadarWindow.CurrentTime, -this.AircraftGCInterval)); // .Where(...).ToList()
        for (const plane of delplane) {
            // lock (Aircraft)
            RadarWindow.Aircraft.Remove(plane);
            this.DeletePlane(plane, false);
        }
    }
    // CurrentTime.AddSeconds(n) helper (DateTime.AddSeconds -> new Date shifted by n seconds).
    #addSeconds(date, n) { return new Date(date.getTime() + n * 1000); }

    #deletedPlanes = []; // private List<Aircraft> deletedPlanes = new List<Aircraft>()
    DeleteTextures() {
        // lock (deletedPlanes)
        {
            [...this.#deletedPlanes].forEach(plane => { // deletedPlanes.ToList().ForEach(...)
                if (plane.DataBlock.TextureID !== 0) {
                    GL.DeleteTexture(plane.DataBlock.TextureID);
                    GL.DeleteTexture(plane.DataBlock2.TextureID);
                    GL.DeleteTexture(plane.DataBlock3.TextureID);
                    GL.DeleteTexture(plane.PositionIndicator.TextureID);
                    plane.DataBlock.TextureID = 0;
                    plane.DataBlock2.TextureID = 0;
                    plane.DataBlock3.TextureID = 0;
                    plane.PositionIndicator.TextureID = 0;
                    plane.DataBlock.Dispose();
                    plane.DataBlock2.Dispose();
                    plane.DataBlock3.Dispose();
                    plane.PositionIndicator.Dispose();
                }
                // lock (plane.History)
                {
                    for (let i = 0; i < plane.History.length; i++) {
                        if (plane.History[i] != null) {
                            plane.History[i].Dispose();
                        }
                    }
                }
                plane.TargetReturn.Dispose();
                { let idx = this.#deletedPlanes.indexOf(plane); if (idx >= 0) this.#deletedPlanes.splice(idx, 1); } // deletedPlanes.Remove(plane)
            });
        }
    }
    StartReceivers() {
        for (const receiver of this.Receivers) { // foreach (Receiver receiver in Receivers)
            receiver.SetAircraftList(RadarWindow.Aircraft);
            receiver.SetWeatherRadarDisplay(this.Nexrad);
            if (receiver.Enabled)
                try {
                    receiver.Start();
                }
                catch (ex) {
                    console.log(`An error occured starting receiver ${receiver.Name}.\r\n${ex.message}`); // MessageBox.Show
                }
        }
        this.StartADSBService();
    }

    StopReceivers() {
        for (const receiver of this.Receivers)
            receiver.Stop();
        this.StopADSBService();
    }

    StartADSBService() {
        this.ADSBSettings.EnsureBuiltInSources();
        if (this.ADSBSettings.AnyEnabled) {
            this.#adsbService = new ADSBBeaconReaderService(
                RadarWindow.Aircraft,
                () => this.HomeLocation,
                () => this.CurrentPrefSet.Range,
                this.ADSBSettings);
            this.#adsbService.Start();
        }
    }

    StopADSBService() {
        if (this.#adsbService != null) this.#adsbService.Stop(); // adsbService?.Stop()
        this.#adsbService = null;
    }

    RestartADSBService() {
        this.StopADSBService();
        this.StartADSBService();
    }
    OrderWaypoints() {
        // Waypoints.ToList().OrderBy(x => x.Location.DistanceTo(HomeLocation)).ToList()
        this.Waypoints = [...this.Waypoints].sort((a, b) => a.Location.DistanceTo(this.HomeLocation) - b.Location.DistanceTo(this.HomeLocation));
    }
    Window_WindowStateChanged(sender, e) { // (object sender, EventArgs e)
        //window.CursorVisible = window.WindowState != WindowState.Fullscreen;
    }

    #_mousesettled = false; // bool
    MouseLocation = new Point(0, 0); // Point
    Window_MouseMove(sender, e) { // (object sender, MouseMoveEventArgs e)
        this.MouseLocation = e.Position;
        if (this.CurrentPrefSet.DCBVisible)
            this.dcb.ActiveMenu.MouseMove(e.Position);
        if (this.#tempLine != null)
            this.#tempLine.End = this.LocationFromScreenPoint(e.Position);
        if (!e.Mouse.IsAnyButtonDown) {

            let move = Math.sqrt(Math.pow(e.XDelta, 2) + Math.pow(e.YDelta, 2));
            if (move > 10 && this.#isScreenSaver && this.#_mousesettled) {
                this.StopReceivers();
                Environment.Exit(0);
            }
            this.#_mousesettled = true;

        }
        else if (e.Mouse.RightButton === ButtonState.Pressed) {
            /*if (centeredmouse)
                return;
            float xMove = e.XDelta * pixelScale;
            float yMove = e.YDelta * pixelScale;
            var center = new Vector4((float)ScreenCenterPoint.Longitude, (float)ScreenCenterPoint.Latitude, 0.0f, 1.0f);
            Vector4 move = new Vector4(-xMove, yMove, 0.0f, 1.0f);
            move *= rotscale;
            var trans = Matrix4.CreateTranslation(move.X, move.Y, move.Z);
            center *= trans;
            CurrentPrefSet.ScopeCentered = false;
            CurrentPrefSet.ScreenCenterPoint = new GeoPoint(center.Y, center.X);
            */
        }
    }
    #hidewx = false; // bool
    ClickedObject(ClickedPoint) { // object ClickedObject(Point ClickedPoint)
        let clickpoint; // PointF
        if (ClickedPoint == null)
            clickpoint = this.LocationFromScreenPoint(new Point(Math.trunc(this.mouseprev.X), Math.trunc(this.mouseprev.Y)));
        else
            clickpoint = this.LocationFromScreenPoint(ClickedPoint);
        let clicked; // object
        if (this.CurrentPrefSet.DCBVisible && this.dcb.ActiveMenu.DrawnBounds.Contains(ClickedPoint)) {
            return ClickedPoint;
        }
        // lock (Aircraft)
        {
            clicked = RadarWindow.Aircraft.filter(x => x.PositionIndicator.BoundsF.Contains(clickpoint)
                && x.LastPositionTime > this.#addSeconds(RadarWindow.CurrentTime, -this.LostTargetSeconds)
                && x.TargetReturn.Intensity > .001)[0] ?? null; // FirstOrDefault()
            if (clicked == null) {
                clicked = clickpoint;
            }
        }
        return clicked;
    }
    #debugPlane; // Aircraft
    Window_MouseDown(sender, e) { // (object sender, MouseEventArgs e)
        let clicked; // object
        let enterclick = false;
        let mousepos; // Point
        if (e != null) {
            mousepos = e.Position;
        }
        else {
            mousepos = new Point(Math.trunc(this.mouseprev.X), Math.trunc(this.mouseprev.Y));
            enterclick = true;
        }
        clicked = this.ClickedObject(mousepos);
        if (this.CurrentPrefSet.DCBVisible)
            this.dcb.ActiveMenu.MouseDown();
        if (enterclick || e.Mouse.LeftButton === ButtonState.Pressed) {
            if ((Keyboard.GetState().IsKeyDown(Key.ControlLeft) || Keyboard.GetState().IsKeyDown(Key.ControlRight)) &&
                (Keyboard.GetState().IsKeyDown(Key.ShiftLeft) || Keyboard.GetState().IsKeyDown(Key.ShiftRight))) {
                Clipboard.SetText(this.ScreenToGeoPoint(e.Position).ToString());
            }
            else if (this.activeDcbButton != null && this.activeDcbButton.constructor !== DCBSubmenuButton) { // GetType() != typeof(DCBSubmenuButton)
                if (this.activeDcbButton === this.dcbPlaceRRButton) {
                    this.CurrentPrefSet.RangeRingLocation = this.ScreenToGeoPoint(e.Position);
                    this.CurrentPrefSet.RangeRingsCentered = false;
                }
                else if (this.activeDcbButton.constructor === DCBAdjustmentButton) { // GetType() == typeof(DCBAdjustmentButton)
                    let loc = new Point(this.#window.Location.X + this.activeDcbButton.DrawnBounds.X + this.activeDcbButton.Width / 2, this.#window.Location.Y + this.activeDcbButton.DrawnBounds.Y + this.activeDcbButton.Height / 2);
                    Mouse.SetPosition(loc.X, loc.Y);
                    this.#window.CursorVisible = true;
                }
                this.ReleaseDCBButton();
            }
            else if (this.#tempLine == null) {
                this.ProcessCommand(this.Preview, clicked);
            }
            else if (clicked.constructor === Aircraft) { // GetType() == typeof(Aircraft)
                this.#tempLine.EndPlane = clicked; // (Aircraft)clicked
                this.#tempLine = null;
                this.Preview.length = 0; // Preview.Clear()
            }
            else {
                this.#tempLine.EndGeo = this.ScreenToGeoPoint(e.Position);
                this.#tempLine = null;
                this.Preview.length = 0; // Preview.Clear()
            }
        }
        else if (e.Mouse.MiddleButton === ButtonState.Pressed) {
            if (clicked.constructor === Aircraft) {
                let plane = clicked; // (Aircraft)clicked
                plane.Marked = plane.Marked ? false : true;
                //GenerateDataBlock(plane);
            }
        }
        else if (e.Mouse.RightButton === ButtonState.Pressed) {
            if (clicked.constructor === Aircraft) {
                this.#debugPlane = clicked; // (Aircraft)clicked
            }
        }
    }

    LocationFromScreenPoint(point) { // PointF LocationFromScreenPoint(Point point)
        let vec = new Vector4(point.X, point.Y, 0, 1);
        vec.mulEq(this.pixeltransform); // vec *= pixeltransform
        return new PointF(vec.X, vec.Y);
        // (unreachable — kept 1:1 with the C# source, which also has dead code after the return)
        let x = (2 * (point.X / this.#window.ClientSize.Width) - 1);
        let y = 1 - 2 * (point.Y / this.#window.ClientSize.Height);
        if (this.#window.ClientSize.Width > this.#window.ClientSize.Height) {
            x *= this.#aspect_ratio;
        }
        else {
            y /= this.#aspect_ratio;
        }
        return new PointF(x, y);
    }
    Window_MouseWheel(sender, e) { // (object sender, MouseWheelEventArgs e)
        let button = (this.activeDcbButton instanceof DCBAdjustmentButton) ? this.activeDcbButton : null; // as DCBAdjustmentButton
        if (button != null) {
            button.MouseWheel(e.Delta);
        }
        /*
        if (e.Delta > 0 && CurrentPrefSet.Range > 6)
            CurrentPrefSet.Range -= 1;
        else if (e.Delta < 0)
            CurrentPrefSet.Range += 1;
        */
    }

    static KeyCode = Object.freeze({ // public enum KeyCode
        Min: 59,
        InitCntl: 12,
        TermCntl: 13,
        HndOff: 14,
        VP: 15,
        MultiFunc: 16,
        FltData: 18,
        CA: 20,
        SignOn: 21,
        RngRing: 201,
        WX: 202,
        RecenterEverything: 500,
    });

    Preview = []; // public List<object> Preview

    #waitingfortarget = false; // bool
    #tempLine;    // RangeBearingLine tempLine
    #tempMinSep;  // MinSep tempMinSep

    // ===== PORTED THROUGH LINE 1542 / 6962 — next chunk continues here (ProcessCommand @1543) =====
}
