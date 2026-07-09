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
import { DCBSubmenuButton, DCBAdjustmentButton, DCBButton, DCBToggleButton, DCBActionButton } from "./DCBButton.js";
import { DCBMenu } from "./DCBMenu.js";
import { DCB } from "./DCB.js";
import { Keyboard, Key, Mouse, ButtonState, Vector4, KeyToChar } from "./_shims/OpenTK.js";
import { Value } from "./_shims/MetarDecoder.js";
import { Clipboard, SaveFileDialog } from "./_shims/WinForms.js";
import { PropertyForm } from "./PropertyForm.js";
import { VideoMapSelector } from "./VideoMapSelector.js";
import { ADSBBeaconReaderForm } from "./ADSBBeaconReader/ADSBBeaconReaderForm.js";
import { Environment } from "./_shims/System.js";
import { tryParseDouble } from "./_shims/Primitives.js";
import { RangeBearingLine } from "./RangeBearingLine.js";
import { TPARing, TPACone, TPAType } from "./TPARing.js";
import { MinSep } from "./MinSep.js";

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

    // KeyList holds chars (1-char strings) and named keys (Key.* Symbols); see the Key shim contract.
    ProcessCommand(KeyList, clicked = null) { // (List<object> KeyList, object clicked = null)
        let clickedplane = false;
        let enter = false;
        if (KeyList.length === 0 && clicked != null) { // no keys, implied command
            this.ProcessImpliedCommand(clicked);
            return;
        }
        if (clicked != null)
            clickedplane = clicked.constructor === Aircraft; // GetType() == typeof(Aircraft)
        else {
            enter = true;
        }

        if (enter && this.CurrentPrefSet.DCBVisible) {
            this.dcb.ActiveMenu.MouseDown();
            this.dcb.ActiveMenu.MouseUp();
        }
        if (KeyList.length < 1 && clicked != null && clicked.constructor === Aircraft) {
            let plane = clicked; // (Aircraft)clicked
            if (plane.ForceQuickLook)
                plane.ForceQuickLook = false;
            else if (!plane.Owned)
                plane.FDB = plane.FDB ? false : true;
            else if (plane.PositionInd !== this.ThisPositionIndicator) {
                plane.Owned = false;
            }
            //GenerateDataBlock(plane);
        }
        else if (KeyList.length > 0) {
            let commands = KeyList.filter(x => { // KeyList.Count(x => {...})
                let type = typeof x; // x.GetType()
                if (type === "string") // == typeof(char)
                    if (x === " ") // (char)x == ' '
                        return true;
                return false;
            }).length + 1;
            let count = 0;
            let keys = new Array(commands); // object[commands][]
            for (let i = 0; i < commands; i++) {
                let command = []; // List<object>
                for (; count < KeyList.length; count++) {
                    if ((typeof KeyList[count] !== "string" || KeyList[count] !== " ")) {
                        //if ((int)KeyList[count] != (int)Key.Space)
                        command.push(KeyList[count]);
                    }
                    else {
                        count++;
                        break;
                    }
                }
                keys[i] = command; // command.ToArray()
            }
            let lastline = this.KeysToString(keys[commands - 1]);
            let typed; // Aircraft
            typed = RadarWindow.Aircraft.filter(x => x.FlightPlanCallsign != null)
                .find(x => x.FlightPlanCallsign.trim() === lastline.trim()) ?? null; // Find
            if (typed == null) {
                typed = RadarWindow.Aircraft.filter(x => x.Squawk != null)
                    .find(x => x.Squawk.trim() === lastline.trim()) ?? null;
            }
            if (!(lastline.trim() == null || lastline.trim() === "") && !clickedplane && typed != null) {
                if (typed.Squawk !== "1200" && typed.Squawk != null) {
                    clicked = typed;
                    clickedplane = true;
                }
            }
            if (keys[0].length < 1)
                return;
            // Manual SPC/alert tag: type a 2-letter code and slew a track to toggle it.
            if (clickedplane && keys.length === 1) {
                let spcCode = this.KeysToString(keys[0]).trim().toUpperCase(); // ToUpperInvariant()
                let spcCodes = ["HJ", "RF", "EM", "MI", "LL", "OD", "ME", "MF", "LN"];
                if (spcCodes.includes(spcCode)) {
                    let spcPlane = clicked; // clicked as Aircraft
                    if (spcPlane.ManualAlertCodes.includes(spcCode)) {
                        spcPlane.ManualAlertCodes.splice(spcPlane.ManualAlertCodes.indexOf(spcCode), 1); // Remove
                    }
                    else {
                        spcPlane.ManualAlertCodes.push(spcCode); // Add
                    }
                    spcPlane.RedrawDataBlock(this.#radar);
                    this.Preview.length = 0; // Preview.Clear()
                    return;
                }
            }
            switch (keys[0][0]) {
                case "1": if (keys[0].length === 1) { // case '1' when keys[0].Length == 1
                    if (clickedplane) {
                        if (!this.InvertKeyboard)
                            clicked.LDRDirection = LeaderDirection.NW;
                        else
                            clicked.LDRDirection = LeaderDirection.SW;
                        clicked.RedrawDataBlock(this.#radar);
                        this.Preview.length = 0;
                    }
                } break;
                case "2": if (keys[0].length === 1) {
                    if (clickedplane) {
                        if (!this.InvertKeyboard)
                            clicked.LDRDirection = LeaderDirection.N;
                        else
                            clicked.LDRDirection = LeaderDirection.S;
                        clicked.RedrawDataBlock(this.#radar);
                        this.Preview.length = 0;
                    }
                } break;
                case "3": if (keys[0].length === 1) {
                    if (clickedplane) {
                        if (!this.InvertKeyboard)
                            clicked.LDRDirection = LeaderDirection.NE;
                        else
                            clicked.LDRDirection = LeaderDirection.SE;
                        clicked.RedrawDataBlock(this.#radar);
                        this.Preview.length = 0;
                    }
                } break;
                case "4": if (keys[0].length === 1) {
                    if (clickedplane) {
                        clicked.LDRDirection = LeaderDirection.W;
                        clicked.RedrawDataBlock(this.#radar);
                        this.Preview.length = 0;
                    }
                } break;
                case "5": if (keys[0].length === 1) {
                    if (clickedplane) {
                        clicked.LDRDirection = null;
                        clicked.RedrawDataBlock(this.#radar);
                        this.Preview.length = 0;
                    }
                } break;
                case "6": if (keys[0].length === 1) {
                    if (clickedplane) {
                        clicked.LDRDirection = LeaderDirection.E;
                        clicked.RedrawDataBlock(this.#radar);
                        this.Preview.length = 0;
                    }
                } break;
                case "7": if (keys[0].length === 1) {
                    if (clickedplane) {
                        if (!this.InvertKeyboard)
                            clicked.LDRDirection = LeaderDirection.SW;
                        else
                            clicked.LDRDirection = LeaderDirection.NW;
                        clicked.RedrawDataBlock(this.#radar);
                        this.Preview.length = 0;
                    }
                } break;
                case "8": if (keys[0].length === 1) {
                    if (clickedplane) {
                        if (!this.InvertKeyboard)
                            clicked.LDRDirection = LeaderDirection.S;
                        else
                            clicked.LDRDirection = LeaderDirection.N;
                        clicked.RedrawDataBlock(this.#radar);
                        this.Preview.length = 0;
                    }
                } break;
                case "9": if (keys[0].length === 1) {
                    if (clickedplane) {
                        if (!this.InvertKeyboard)
                            clicked.LDRDirection = LeaderDirection.SE;
                        else
                            clicked.LDRDirection = LeaderDirection.NE;
                        clicked.RedrawDataBlock(this.#radar);
                        this.Preview.length = 0;
                    }
                } break;
                case Key.F3:
                    /*if (clickedplane)
                    {
                        ((Aircraft)clicked).Owned = true;
                        ((Aircraft)clicked).PositionInd = ThisPositionIndicator;
                        Preview.Clear();
                    }
                    */
                    break;
                case Key.F4:
                    if (clickedplane) {
                        let plane = clicked; // (Aircraft)clicked
                        if (!(plane.PendingHandoff == null || plane.PendingHandoff === "") || plane.PositionInd !== this.ThisPositionIndicator) {
                            this.DisplayPreviewMessage("ILL TRK");
                        }
                        else {
                            this.Preview.length = 0;
                            plane.DeleteFP();
                        }
                    }
                    else {
                        this.DisplayPreviewMessage("NO FLIGHT");
                    }
                    break;
                case Key.F12: {
                    let newpos = this.KeysToString(keys[0]);
                    if (newpos === "*")
                        this.ThisPositionIndicator = "NONE";
                    else
                        this.ThisPositionIndicator = newpos;
                    // lock (Aircraft)
                    RadarWindow.Aircraft.filter(x => x.PositionInd !== this.ThisPositionIndicator &&
                        x.PendingHandoff !== this.ThisPositionIndicator).forEach(x => x.Owned = false);
                    this.Preview.length = 0;
                } break;
                case "*": // splat commands
                    if (keys[0].length >= 2) {
                        switch (keys[0][1]) {
                            case "B":
                                if (keys[0].length === 3)
                                    if (enter) {
                                        if (keys[0][2] === "E")
                                            this.DrawATPAMonitorCones = true;
                                        else if (keys[0][2] === "I")
                                            this.DrawATPAMonitorCones = false;
                                        this.Preview.length = 0;
                                    }
                                break;
                            case "D":
                                if ((keys[0].length === 3 || keys[0].length === 4) && typeof keys[0][2] === "string" && keys[0][2] === "+") {
                                    if (enter) {
                                        if (keys[0].length === 3) {
                                            this.TPASize = !this.TPASize;
                                            this.Preview.length = 0;
                                        }
                                        else if (typeof keys[0][3] !== "string") {
                                            this.DisplayPreviewMessage("FORMAT");
                                        }
                                        else if (keys[0][3] === "E") {
                                            this.TPASize = true;
                                            this.Preview.length = 0;
                                        }
                                        else if (keys[0][3] === "I") {
                                            this.TPASize = false;
                                            this.Preview.length = 0;
                                        }
                                        else {
                                            this.DisplayPreviewMessage("FORMAT");
                                        }
                                    }
                                    else if (clickedplane) {
                                        let plane = clicked; // clicked as Aircraft
                                        if (plane.TPA == null) {
                                            this.DisplayPreviewMessage("ILL FNCT");
                                        }
                                        else if (keys[0].length === 3) {
                                            plane.TPA.ShowSize = !plane.TPA.ShowSize;
                                            this.Preview.length = 0;
                                        }
                                        else if (typeof keys[0][3] !== "string") {
                                            this.DisplayPreviewMessage("FORMAT");
                                        }
                                        else if (keys[0][3] === "E") {
                                            plane.TPA.ShowSize = true;
                                            this.Preview.length = 0;
                                        }
                                        else if (keys[0][3] === "I") {
                                            plane.TPA.ShowSize = false;
                                            this.Preview.length = 0;
                                        }
                                        else {
                                            this.DisplayPreviewMessage("FORMAT");
                                        }
                                    }
                                    else {
                                        this.DisplayPreviewMessage("NO TRK");
                                    }
                                }
                                break;
                            case "T":
                                if (clickedplane) {
                                    if (this.#tempLine == null) {
                                        this.#tempLine = Object.assign(new RangeBearingLine(), { StartPlane: clicked, End: this.LocationFromScreenPoint(this.MouseLocation) });
                                        this.#rangeBearingLines.push(this.#tempLine); // rangeBearingLines.Add
                                    }
                                    if (keys[0].length > 2) {
                                        let rblIndex = { value: 0 };
                                        let entered = this.KeysToString(keys[0]).substring(1);
                                        if (tryParseInt(entered, rblIndex)) {
                                            if (rblIndex.value <= this.#rangeBearingLines.length) {
                                                this.#rangeBearingLines.splice(rblIndex.value - 1, 1); // RemoveAt
                                                this.Preview.length = 0;
                                            }
                                        }
                                        else {
                                            let waypoint = this.Waypoints.find(x => x.ID === entered) ?? null;
                                            if (waypoint != null) {
                                                this.#tempLine.StartGeo = waypoint.Location;
                                                this.Preview.length = 0;
                                            }
                                        }
                                        if (clickedplane) {
                                            this.#tempLine.EndPlane = clicked; // (Aircraft)clicked
                                            this.#tempLine = null;
                                        }
                                    }
                                    this.Preview.length = 0;
                                }
                                else if (enter) {
                                    if (keys[0].length === 2) {
                                        this.#rangeBearingLines.length = 0; // Clear
                                        this.Preview.length = 0;
                                    }
                                    if (keys[0].length > 2) {
                                        let rblIndex = { value: 0 };
                                        let entered = this.KeysToString(keys[0]).substring(2);
                                        if (tryParseInt(entered, rblIndex)) {
                                            if (rblIndex.value <= this.#rangeBearingLines.length) {
                                                this.#rangeBearingLines.splice(rblIndex.value - 1, 1); // RemoveAt
                                                this.Preview.length = 0;
                                            }
                                        }
                                        else {
                                            let waypoint = this.Waypoints.find(x => x.ID === entered) ?? null;
                                            if (waypoint != null) {
                                                this.#tempLine = Object.assign(new RangeBearingLine(), { StartGeo: waypoint.Location, End: this.LocationFromScreenPoint(this.MouseLocation) });
                                                this.#rangeBearingLines.push(this.#tempLine);
                                                this.Preview.length = 0;
                                            }
                                        }
                                    }
                                }
                                else if (this.#tempLine == null) {
                                    this.#tempLine = Object.assign(new RangeBearingLine(), { StartGeo: this.ScreenToGeoPoint(clicked) }); // (PointF)clicked
                                    this.#rangeBearingLines.push(this.#tempLine);
                                    this.Preview.length = 0;
                                }
                                break;
                            case "J":
                                if (clickedplane) {
                                    if (keys[0].length >= 3 && keys[0].length <= 5) {
                                        let miles = { value: 0 };
                                        let entered = this.KeysToString(keys[0]).substring(2);
                                        if (tryParseDouble(entered, miles)) { // decimal.TryParse
                                            if (miles.value > 0 && miles.value <= 30) {
                                                clicked.TPA = new TPARing(clicked, miles.value, this.TPAColor, this.Font, this.TPASize);
                                            }
                                            else {
                                                this.DisplayPreviewMessage("FORMAT");
                                            }
                                            this.Preview.length = 0;
                                        }
                                    }
                                    else {
                                        clicked.TPA = null;
                                        this.Preview.length = 0;
                                    }
                                }
                                break;
                            case "P":
                                if (clickedplane) {
                                    if (keys[0].length >= 3 && keys[0].length <= 5) {
                                        let miles = { value: 0 };
                                        let entered = this.KeysToString(keys[0]).substring(2);
                                        if (tryParseDouble(entered, miles)) {
                                            if (miles.value > 0 && miles.value <= 30) {
                                                clicked.TPA = new TPACone(clicked, miles.value, this.TPAColor, this.Font, this.TPASize);
                                            }
                                            else {
                                                this.DisplayPreviewMessage("FORMAT");
                                            }
                                            this.Preview.length = 0;
                                        }
                                    }
                                    else {
                                        clicked.TPA = null;
                                        this.Preview.length = 0;
                                    }
                                }
                                else {
                                    this.DisplayPreviewMessage("NO TRK");
                                }
                                break;
                            case "*":
                                if (keys[0].length > 2) {
                                    switch (keys[0][2]) {
                                        case "J":
                                            // lock (Aircraft)
                                            RadarWindow.Aircraft.filter(x => x.TPA != null).filter(x => x.TPA.Type === TPAType.JRing).forEach(x => x.TPA = null);
                                            this.Preview.length = 0;
                                            break;
                                        case "P":
                                            RadarWindow.Aircraft.filter(x => x.TPA != null).filter(x => x.TPA.Type === TPAType.PCone).forEach(x => x.TPA = null);
                                            this.Preview.length = 0;
                                            break;
                                        default:
                                            if (keys[0].length === 4) {
                                                let pos = this.KeysToString(keys[0]).substring(2);
                                                if (clickedplane && pos === this.ThisPositionIndicator) {
                                                    let plane = clicked; // clicked as Aircraft
                                                    plane.ForceQuickLook = true;
                                                    //GenerateDataBlock(plane);
                                                    this.Preview.length = 0;
                                                }
                                            }
                                            break;
                                    }
                                }
                                break;
                        }
                    }
                    break;
                case ".":
                    if (keys[0].length === 1 && clickedplane) {
                        let plane = clicked; // clicked as Aircraft
                        if (!(plane.PendingHandoff == null || plane.PendingHandoff === "") || plane.PositionInd !== this.ThisPositionIndicator) {
                            this.DisplayPreviewMessage("ILL TRK");
                        }
                        else {
                            plane.Scratchpad = "";
                            this.Preview.length = 0;
                            plane.SendUpdate();
                        }
                    }
                    break;
                case "+":
                    if (keys[0].length === 1 && clickedplane) {
                        let plane = clicked; // clicked as Aircraft
                        if (!(plane.PendingHandoff == null || plane.PendingHandoff === "") || plane.PositionInd !== this.ThisPositionIndicator) {
                            this.DisplayPreviewMessage("ILL TRK");
                        }
                        else {
                            plane.Scratchpad2 = "";
                            this.Preview.length = 0;
                            plane.SendUpdate();
                        }
                    }
                    break;
                case Key.F7: {
                    //MultiFuntion
                    if (keys[0].length < 2) // keys[0].Count() < 2
                        break;
                    switch (keys[0][1]) {
                        case "2": //Multifunction 2
                            if (keys[0].length >= 6 && this.KeysToString(keys[0], 2).substring(0, 4) === "ATPA") { //ATPA Commands
                                if (keys[0].length === 7) { // Enable system-wide
                                    if (keys[0][6] === "E") { // Enable
                                        if (this.ATPA.Active) {
                                            this.DisplayPreviewMessage("NO CHANGE");
                                        }
                                        else if (this.ATPA.Volumes.length === 0) {
                                            this.DisplayPreviewMessage("ILL FNCT");
                                        }
                                        else {
                                            this.ATPA.Active = true;
                                            this.Preview.length = 0;
                                        }
                                    }
                                    else if (keys[0][6] === "I") { //Inhibit
                                        if (!this.ATPA.Active) {
                                            this.DisplayPreviewMessage("NO CHANGE");
                                        }
                                        else if (this.ATPA.Volumes.length === 0) {
                                            this.DisplayPreviewMessage("ILL FNCT");
                                        }
                                        else {
                                            this.ATPA.Active = false;
                                            this.Preview.length = 0;
                                        }
                                    }
                                    else {
                                        this.DisplayPreviewMessage("FORMAT");
                                    }
                                }
                                if (keys[0].length >= 8 && keys[0].length <= 12) {
                                    if (this.ATPA.Active) {
                                        let volnamefull = this.KeysToString(keys[0], 6);
                                        let volname = volnamefull.substring(0, volnamefull.length - 1);
                                        let volumes = this.ATPA.Volumes.filter(x => x.VolumeId === volname);
                                        if (volumes.length === 1) {
                                            let volume = volumes[0]; // First()
                                            if (volnamefull[volnamefull.length - 1] === "E") { // Last()
                                                if (volume.Active) {
                                                    this.DisplayPreviewMessage("NO CHANGE");
                                                }
                                                else {
                                                    volume.Active = true;
                                                    this.Preview.length = 0;
                                                }
                                            }
                                            else if (volnamefull[volnamefull.length - 1] === "I") {
                                                if (!volume.Active) {
                                                    this.DisplayPreviewMessage("NO CHANGE");
                                                }
                                                else {
                                                    volume.Active = false;
                                                    this.Preview.length = 0;
                                                }
                                            }
                                            else {
                                                this.DisplayPreviewMessage("FORMAT");
                                            }
                                        }
                                        else {
                                            this.DisplayPreviewMessage("ILL VOL");
                                        }
                                    }
                                    else {
                                        this.DisplayPreviewMessage("ILL FNCT");
                                    }
                                }
                            }
                            else if (keys[0].length >= 4 && this.KeysToString(keys[0], 1).substring(0, 3) === "2.5") {
                                if (keys[0].length >= 6 && keys[0].length <= 10) {
                                    if (this.ATPA.Active) {
                                        let volnamefull = this.KeysToString(keys[0], 4);
                                        let volname = volnamefull.substring(0, volnamefull.length - 1);
                                        let volumes = this.ATPA.Volumes.filter(x => x.VolumeId === volname && x.Active);
                                        if (volumes.length === 1) {
                                            let volume = volumes[0];
                                            if (volume.TwoPointFiveEnabled) {
                                                if (volnamefull[volnamefull.length - 1] === "E") {
                                                    if (volume.TwoPointFiveActive) {
                                                        this.DisplayPreviewMessage("NO CHANGE");
                                                    }
                                                    else {
                                                        volume.TwoPointFiveActive = true;
                                                        this.Preview.length = 0;
                                                    }
                                                }
                                                else if (volnamefull[volnamefull.length - 1] === "I") {
                                                    if (!volume.TwoPointFiveActive) {
                                                        this.DisplayPreviewMessage("NO CHANGE");
                                                    }
                                                    else {
                                                        volume.TwoPointFiveActive = false;
                                                        this.Preview.length = 0;
                                                    }
                                                }
                                                else {
                                                    this.DisplayPreviewMessage("FORMAT");
                                                }
                                            }
                                            else {
                                                this.DisplayPreviewMessage("ILL FNCT");
                                            }
                                        }
                                        else {
                                            this.DisplayPreviewMessage("ILL VOL");
                                        }
                                    }
                                    else {
                                        this.DisplayPreviewMessage("ILL FNCT");
                                    }
                                }
                                else {
                                    this.DisplayPreviewMessage("FORMAT");
                                }
                            }
                            else {
                                this.DisplayPreviewMessage("FORMAT");
                            }
                            break;
                        case "B": { //Mutlifunction B: Beacons
                            if (keys[0].length === 2 && enter) {
                                // F7 B ENTER: Toggle beacon code display in LDBs
                                this.CurrentPrefSet.LdbBeaconCodesInhibited = !this.CurrentPrefSet.LdbBeaconCodesInhibited;
                                this.Preview.length = 0;
                            }
                            else if (keys[0].length === 3 && keys[0][2] === "E" && enter) {
                                // F7 BE ENTER: Enable beacon code display in LDBs
                                this.CurrentPrefSet.LdbBeaconCodesInhibited = false;
                                this.Preview.length = 0;
                            }
                            else if (keys[0].length === 3 && keys[0][2] === "I" && enter) {
                                // F7 BI ENTER: Inhibit beacon code display in LDBs
                                this.CurrentPrefSet.LdbBeaconCodesInhibited = true;
                                this.Preview.length = 0;
                            }
                            else if (keys[0].length >= 4 && keys[0].length <= 6 && enter) {
                                let squawk = this.KeysToString(keys[0], 2);
                                if (this.SelectedBeaconCodes.includes(squawk))
                                    for (let i = this.SelectedBeaconCodes.length - 1; i >= 0; i--) { if (this.SelectedBeaconCodes[i] === squawk) this.SelectedBeaconCodes.splice(i, 1); } // RemoveAll
                                else
                                    this.SelectedBeaconCodes.push(squawk);
                                this.Preview.length = 0;
                            }
                            else if (keys[0].length === 3 && keys[0][2] === Key.KeypadMultiply) { // (int)keys[0][2] == (int)Key.KeypadMultiply
                                this.SelectedBeaconCodes.length = 0; // Clear
                                this.Preview.length = 0;
                            }
                            break;
                        }
                        case "D": { //Multifunction D
                            if (keys[0].length === 3 && keys[0][2] === "*" && !enter) {
                                let clickedlocation; // GeoPoint
                                if (clicked.constructor === PointF) { // GetType() == typeof(PointF)
                                    clickedlocation = this.ScreenToGeoPoint(clicked);
                                    this.DisplayPreviewMessage(clickedlocation.ToDmsString(), 30);
                                }
                            }
                            this.Preview.length = 0;
                            break;
                        }
                        case "F": { //Multifunction F: Filters
                            let success = false;
                            if (keys[0].length === 8) {
                                let alts = this.KeysToString(keys[0], 2);
                                let min = { value: 0 };
                                if (tryParseInt(alts.substring(0, 3), min)) {
                                    let max = { value: 0 };
                                    if (tryParseInt(alts.substring(3), max)) {
                                        if (min.value === 0) {
                                            this.MinAltitude = -9990;
                                        }
                                        else {
                                            this.MinAltitude = min.value * 100;
                                        }
                                        this.MaxAltitude = max.value * 100;
                                        success = true;
                                        this.Preview.length = 0;
                                    }
                                    else {
                                        this.DisplayPreviewMessage("FORMAT");
                                    }
                                }
                                else {
                                    this.DisplayPreviewMessage("FORMAT");
                                }
                            }
                            if (keys.length === 2 && keys[1].length === 6) {
                                let alts = this.KeysToString(keys[1]);
                                let min = { value: 0 };
                                if (tryParseInt(alts.substring(0, 3), min)) {
                                    let max = { value: 0 };
                                    if (tryParseInt(alts.substring(3), max)) {
                                        if (min.value === 0) {
                                            this.MinAltitudeAssociated = -9990;
                                        }
                                        else {
                                            this.MinAltitudeAssociated = min.value * 100;
                                        }
                                        this.MaxAltitudeAssociated = max.value * 100;
                                        this.Preview.length = 0;
                                    }
                                    else {
                                        this.DisplayPreviewMessage("FORMAT");
                                    }
                                }
                                else {
                                    this.DisplayPreviewMessage("FORMAT");
                                }
                            }
                            else if (keys.length !== 1) {
                                this.DisplayPreviewMessage("FORMAT");
                            }
                            if (!success) {
                                this.DisplayPreviewMessage("FORMAT");
                            }
                            break;
                        }
                        case "L": { //Leader Lines
                            if (keys[0].length > 2) {
                                let dirpos = 2;
                                let pos = null;
                                if (keys[0].length === 5) {
                                    dirpos += 2;
                                    pos = this.KeysToString(keys[0], 2).substring(0, 2);
                                }
                                let dirh = { value: 0 };
                                if (!tryParseInt(String(keys[0][dirpos]), dirh)) { // (keys[0][dirpos]).ToString()
                                    this.Preview.length = 0;
                                    this.DisplayPreviewMessage("FORMAT");
                                    break;
                                }
                                let dir = dirh.value;
                                let direction; // LeaderDirection
                                switch (dir) {
                                    case 7: direction = this.InvertKeyboard ? LeaderDirection.NW : LeaderDirection.SW; break; // 7 when Invert -> NW, else SW
                                    case 8: direction = this.InvertKeyboard ? LeaderDirection.N : LeaderDirection.S; break;
                                    case 9: direction = this.InvertKeyboard ? LeaderDirection.NE : LeaderDirection.SE; break;
                                    case 4: direction = LeaderDirection.W; break;
                                    case 6: direction = LeaderDirection.E; break;
                                    case 1: direction = !this.InvertKeyboard ? LeaderDirection.NW : LeaderDirection.SW; break; // 1 when !Invert -> NW, else SW
                                    case 2: direction = !this.InvertKeyboard ? LeaderDirection.N : LeaderDirection.S; break;
                                    case 3: direction = !this.InvertKeyboard ? LeaderDirection.NE : LeaderDirection.SE; break;
                                    default: direction = LeaderDirection.Invalid; break;
                                }
                                if (keys[0].length === 3) {
                                    if (direction !== LeaderDirection.Invalid) {
                                        this.CurrentPrefSet.OwnedDataBlockPosition = direction;
                                    }
                                }
                                else if (keys[0].length === 4 && keys[0][3] === "*") {
                                    if (direction !== LeaderDirection.Invalid) {
                                        this.CurrentPrefSet.UnownedDataBlockPosition = direction;
                                    }
                                }
                                else if (keys[0].length === 4 && keys[0][3] === "U") {
                                    if (direction !== LeaderDirection.Invalid) {
                                        this.CurrentPrefSet.UnassociatedDataBlockPosition = direction;
                                    }
                                }
                                else if (pos != null) {
                                    // lock (CurrentPrefSet.OtherOwnersLeaderDirections) — SerializableDictionary : Map
                                    if (this.CurrentPrefSet.OtherOwnersLeaderDirections.has(pos)) { // ContainsKey
                                        if (dir === 5) {
                                            this.CurrentPrefSet.OtherOwnersLeaderDirections.delete(pos); // Remove
                                        }
                                        else if (direction !== LeaderDirection.Invalid) {
                                            this.CurrentPrefSet.OtherOwnersLeaderDirections.set(pos, direction); // [pos] = direction
                                        }
                                    }
                                    else if (direction !== LeaderDirection.Invalid) {
                                        this.CurrentPrefSet.OtherOwnersLeaderDirections.set(pos, direction); // Add
                                    }
                                }
                            }
                            this.Preview.length = 0;
                            break;
                        }
                        case "P":
                            if (!clickedplane) {
                                this.PreviewLocation = clicked; // (PointF)clicked
                                this.Preview.length = 0;
                            }
                            break;
                        case "V": { // Multifunction V: MSAW processing
                            if (clickedplane && keys[0].length === 2) {
                                // F7 V <slew>: toggle MSAW processing for a track
                                let plane = clicked; // clicked as Aircraft
                                plane.MSAWInhibited = !plane.MSAWInhibited;
                                this.Preview.length = 0;
                            }
                            else if (enter && keys[0].length === 4
                                && typeof keys[0][2] === "string" && keys[0][2] === "M"
                                && typeof keys[0][3] === "string") {
                                // F7 VME / VMI: enable/inhibit MSAW system-wide
                                let mode = keys[0][3]; // (char)keys[0][3]
                                if (mode === "E") {
                                    this.MSAW.Active = true;
                                    this.Preview.length = 0;
                                }
                                else if (mode === "I") {
                                    this.MSAW.Active = false;
                                    this.Preview.length = 0;
                                }
                                else {
                                    this.DisplayPreviewMessage("FORMAT");
                                }
                            }
                            break;
                        }
                        case "Q": {
                            if (clickedplane && keys[0].length === 2) {
                                // F7 Q <slew>: inhibit MSAW for a track currently in MSAW alert
                                let plane = clicked; // clicked as Aircraft
                                if (plane.LowAltitude) {
                                    plane.MSAWInhibited = true;
                                    this.Preview.length = 0;
                                }
                                else {
                                    this.DisplayPreviewMessage("ILL TRK");
                                }
                            }
                            else if ((keys[0].length >= 4 || keys[0].length <= 6) && enter) {
                                let qlstring = this.KeysToString(keys[0]).substring(1);
                                let qlplus = false;
                                if (!(qlstring == null || qlstring === ""))
                                    qlplus = qlstring[qlstring.length - 1] === "+"; // Last()
                                let qlpos = qlstring;

                                if (qlpos == null || qlpos === "") {
                                    this.DisplayPreviewMessage("ILL POS", 10);
                                }
                                else if (qlplus) {
                                    qlpos = qlstring.substring(0, qlstring.length - 1);
                                    if (this.QuickLookList.includes(qlpos))
                                        this.QuickLookList.splice(this.QuickLookList.indexOf(qlpos), 1);
                                    if (this.QuickLookList.includes(qlpos + "+"))
                                        this.QuickLookList.splice(this.QuickLookList.indexOf(qlpos + "+"), 1);
                                    else
                                        this.QuickLookList.push(qlpos + "+");
                                }
                                else {
                                    if (this.QuickLookList.includes(qlpos))
                                        this.QuickLookList.splice(this.QuickLookList.indexOf(qlpos), 1);
                                    else if (this.QuickLookList.includes(qlpos + "+"))
                                        this.QuickLookList.splice(this.QuickLookList.indexOf(qlpos + "+"), 1);
                                    else
                                        this.QuickLookList.push(qlpos);
                                }
                                this.Preview.length = 0;
                            }
                            break;
                        }
                        case "S": { // Multifunction S: Status area / ATIS free text
                            if (!clickedplane && keys[0].length === 2) {
                                this.StatusLocation = clicked; // (PointF)clicked
                                this.Preview.length = 0;
                            }
                            else if (!clickedplane && keys[0].length >= 3 && typeof keys[0][2] === "string") {
                                let textchar = keys[0][2]; // (char)keys[0][2]
                                if (/\p{L}/u.test(textchar)) { // char.IsLetter
                                    this.#atises[0] = textchar;
                                    if (keys[0].length > 3) {
                                        let text = "";
                                        for (let i = 3; i < keys[0].length; i++) {
                                            if (typeof keys[0][i] === "string") {
                                                text += keys[0][i];
                                            }
                                        }
                                        if (keys.length > 1) {
                                            for (let i = 1; i < keys.length; i++) {
                                                text += " ";
                                                for (let j = 0; j < keys[i].length; j++) {
                                                    if (typeof keys[i][j] === "string") {
                                                        text += keys[i][j];
                                                    }
                                                }
                                            }
                                        }
                                        this.#gentexts[0] = text;
                                    }
                                    this.Preview.length = 0;
                                }
                            }
                            break;
                        }
                        case "O": //Multifunction O: Auto Offset
                            if (keys[0].length === 3 && enter) {
                                if (keys[0][2] === "I") //Inhibit
                                    this.AutoOffset = false;
                                else if (keys[0][2] === "E") //Enable
                                    this.AutoOffset = true;
                                else
                                    break;
                                this.Preview.length = 0;
                            }
                            break;
                        case "R":
                            if (clickedplane) {
                                let plane = clicked; // clicked as Aircraft
                                plane.ShowPTL = !plane.ShowPTL;
                                this.Preview.length = 0;
                            }
                            break;
                        case "Y": { // Multifunction Y: Scratchpads
                            if (clickedplane && keys.length === 1) {
                                let plane = clicked; // clicked as Aircraft
                                if (keys[0].length === 2) {
                                    if (!(plane.PendingHandoff == null || plane.PendingHandoff === "") || plane.PositionInd !== this.ThisPositionIndicator) {
                                        this.DisplayPreviewMessage("ILL TRK");
                                    }
                                    else {
                                        plane.Scratchpad = "";
                                        this.Preview.length = 0;
                                        plane.SendUpdate();
                                    }
                                }
                                else if (keys[0].length === 3 && keys[0][2] === "+") {
                                    if (!(plane.PendingHandoff == null || plane.PendingHandoff === "") || plane.PositionInd !== this.ThisPositionIndicator) {
                                        this.DisplayPreviewMessage("ILL TRK");
                                    }
                                    else {
                                        plane.Scratchpad2 = "";
                                        this.Preview.length = 0;
                                        plane.SendUpdate();
                                    }
                                }
                                else if (keys[0].length >= 3 && keys[0].length <= 6 && keys[0][2] !== "+") {
                                    if (!(plane.PendingHandoff == null || plane.PendingHandoff === "") || plane.PositionInd !== this.ThisPositionIndicator) {
                                        this.DisplayPreviewMessage("ILL TRK");
                                    }
                                    else {
                                        plane.Scratchpad = this.KeysToString(keys[0], 2);
                                        this.Preview.length = 0;
                                        plane.SendUpdate();
                                    }
                                }
                                else if (keys[0].length >= 4 && keys[0].length <= 7 && keys[0][2] === "+") {
                                    if (!(plane.PendingHandoff == null || plane.PendingHandoff === "") || plane.PositionInd !== this.ThisPositionIndicator) {
                                        this.DisplayPreviewMessage("ILL TRK");
                                    }
                                    else {
                                        plane.Scratchpad2 = this.KeysToString(keys[0], 3);
                                        this.Preview.length = 0;
                                        plane.SendUpdate();
                                    }
                                }
                                else {
                                    this.DisplayPreviewMessage("FORMAT");
                                }
                            }
                            else if (!clickedplane && keys.length === 2) {
                                let planestring = this.KeysToString(keys[0], 2);
                                let planes = RadarWindow.Aircraft.filter(x => {
                                    if (x.FlightPlanCallsign != null && x.FlightPlanCallsign.trim() === planestring) {
                                        return true;
                                    }
                                    if (x.AssignedSquawk != null && x.AssignedSquawk.trim() === planestring) {
                                        return true;
                                    }
                                    return false;
                                });
                                if (planes.length !== 1) {
                                    this.DisplayPreviewMessage("NO FLIGHT");
                                }
                                else {
                                    let plane = planes[0]; // First()
                                    if (keys[1][0] === "+" && keys[1].length >= 2 && keys[1].length <= 5) {
                                        plane.Scratchpad2 = this.KeysToString(keys[1], 1);
                                        this.Preview.length = 0;
                                        plane.SendUpdate();
                                    }
                                    else if (keys[1][0] !== "+" && keys[1].length >= 1 && keys[1].length <= 4) {
                                        plane.Scratchpad = this.KeysToString(keys[1]);
                                        this.Preview.length = 0;
                                        plane.SendUpdate();
                                    }
                                    else {
                                        this.DisplayPreviewMessage("FORMAT");
                                    }
                                }
                            }
                            else {
                                this.DisplayPreviewMessage("FORMAT");
                            }
                            break;
                        }
                    }
                    break;
                }
                case RadarWindow.KeyCode.RngRing: {
                    //Range Rings
                    if (keys[0].length === 1) {
                    }
                    else if (enter) {
                        let interval = { value: 0 };
                        if (tryParseDouble(this.KeysToString([...this.Preview]), interval)) { // Preview.ToArray()
                            this.CurrentPrefSet.RangeRingSpacing = Math.trunc(interval.value); // (int)interval
                        }
                    }
                    this.Preview.length = 0;
                    break;
                }
                case RadarWindow.KeyCode.WX: {
                    if (keys[0].length === 2 && typeof keys[0][1] === "string" && enter) {
                        let wxlevelstring = keys[0][1]; // ((char)keys[0][1]).ToString()
                        let level = { value: 0 };
                        if (tryParseInt(wxlevelstring, level)) {
                            if (level.value > 0 && level.value < 7) {
                                let lv = level.value - 1; // level--
                                this.Nexrad.LevelsEnabled[lv] = !this.Nexrad.LevelsEnabled[lv];
                                this.Nexrad.RecomputeVertices();
                            }
                        }
                        this.Preview.length = 0;
                    }
                    break;
                }
                case RadarWindow.KeyCode.RecenterEverything: {
                    if (keys.length === 2) {
                        let airportcode = this.KeysToString(keys[1]);
                        let airports = this.Airports.filter(x => x.ID === airportcode);
                        if (airports.length === 1) {
                            let airport = airports[0]; // First()
                            let loc = new GeoPoint(airport.Location.Latitude, airport.Location.Longitude);
                            this.CurrentPrefSet.ScopeCentered = true;
                            this.HomeLocation = loc;
                            this.CurrentPrefSet.RangeRingLocation = loc;
                            this.ScreenRotation = airport.MagVar; // (double)airport.MagVar
                            this.Preview.length = 0;
                        }
                        else {
                            this.DisplayPreviewMessage("NO AIRPORT");
                        }
                    }
                    break;
                }
                case Key.End: {
                    //Min Sep
                    this.#tempLine = null;
                    if (clickedplane) {
                        let plane = clicked; // clicked as Aircraft
                        if (this.#tempMinSep == null) {
                            this.#tempMinSep = new MinSep(plane, null);
                        }
                        else {
                            let minsep = new MinSep(this.#tempMinSep.Plane1, plane);
                            this.#tempMinSep = null;
                            this.#minSeps.push(minsep); // minSeps.Add
                            this.Preview.length = 0;
                        }
                    }
                    else if (enter) {
                        this.#minSeps.length = 0; // minSeps.Clear()
                        this.Preview.length = 0;
                        this.#tempMinSep = null;
                    }
                    break;
                }
                default: {
                    if (this.#tempLine != null && enter) {
                        if (clickedplane) {
                            this.#tempLine.EndPlane = clicked; // clicked as Aircraft
                            this.#tempLine = null;
                            this.Preview.length = 0;
                        }
                        else {
                            let entered = this.KeysToString(keys[0]);
                            let waypoint = this.Waypoints.find(x => x.ID === entered) ?? null;
                            if (waypoint != null) {
                                this.#tempLine.EndGeo = waypoint.Location;
                                this.#tempLine = null;
                                this.Preview.length = 0;
                            }
                        }
                    }
                    if (keys[0].length === 3 && clickedplane) {
                        let plane = clicked; // clicked as Aircraft
                        if (!(plane.PendingHandoff == null || plane.PendingHandoff === "") || plane.PositionInd !== this.ThisPositionIndicator) {
                            this.DisplayPreviewMessage("ILL TRK");
                        }
                        else {
                            plane.Scratchpad = this.KeysToString(keys[0]);
                            plane.SendUpdate();
                            this.Preview.length = 0;
                        }
                    }
                    else if (keys[0].length === 4 && clickedplane && this.KeysToString(keys[0]).endsWith("+")) { // Last() == '+'
                        let plane = clicked; // clicked as Aircraft
                        if (!(plane.PendingHandoff == null || plane.PendingHandoff === "") || plane.PositionInd !== this.ThisPositionIndicator) {
                            this.DisplayPreviewMessage("ILL TRK");
                        }
                        else {
                            plane.Scratchpad2 = this.KeysToString(keys[0]).substring(0, 3);
                            plane.SendUpdate();
                            this.Preview.length = 0;
                        }
                    }
                    else if (keys[0].length === 4 && clickedplane) {
                        let plane = clicked; // clicked as Aircraft
                        if (!(plane.PendingHandoff == null || plane.PendingHandoff === "") || plane.PositionInd !== this.ThisPositionIndicator) {
                            this.DisplayPreviewMessage("ILL TRK");
                        }
                        else {
                            plane.Type = this.KeysToString(keys[0]);
                            plane.SendUpdate();
                            this.Preview.length = 0;
                        }
                    }
                    else if (keys[0].length === 2 && clickedplane) {
                        let plane = clicked; // clicked as Aircraft
                        if (!(plane.PendingHandoff == null || plane.PendingHandoff === "") || plane.PositionInd !== this.ThisPositionIndicator) {
                            this.DisplayPreviewMessage("ILL TRK");
                        }
                        else {
                            plane.PendingHandoff = this.KeysToString(keys[0]);
                            plane.SendUpdate();
                            this.Preview.length = 0;
                        }
                    }
                    break;
                }
            } // end switch (keys[0][0])
        } // end else if (KeyList.length > 0)
    } // end ProcessCommand
    // ==== END ProcessCommand (source 1548-2879) ====

    ProcessImpliedCommand(clicked = null) { // (object clicked = null)
        /*
            Aircraft plane = (Aircraft)clicked;
            if (plane.Pointout)
                plane.Pointout = false;
            else if (!plane.Owned)
                plane.FDB = plane.FDB ? false : true;
            else if (plane.PositionInd != ThisPositionIndicator)
            {
                plane.Owned = false;
            }
            GenerateDataBlock(plane);
         */
        let clickedplane = false;
        let enter = false;
        if (clicked != null)
            clickedplane = clicked.constructor === Aircraft; // GetType() == typeof(Aircraft)
        else
            enter = true;
        if (clickedplane) {
            let plane = clicked; // clicked as Aircraft
            // Acknowledge alerts on this track (MSAW LA, Conflict Alert, and the
            // squawk-derived SPC): a slew silences the tone(s); CA goes solid.
            let unackedLA = plane.LowAltitude && !plane.LowAltitudeAcknowledged;
            let unackedCA = plane.ConflictAlert && !plane.ConflictAlertAcknowledged;
            let unackedSpc = plane.HasUnacknowledgedSpc;
            if (unackedLA || unackedCA || unackedSpc) {
                if (plane.LowAltitude)
                    plane.LowAltitudeAcknowledged = true;
                plane.SpcAcknowledged = true;
                if (unackedCA) {
                    plane.ConflictAlertAcknowledged = true;
                    for (const partner of [...plane.ConflictingTracks]) { // ConflictingTracks.ToList()
                        partner.ConflictAlertAcknowledged = true;
                        partner.RedrawDataBlock(this.#radar);
                    }
                }
                plane.RedrawDataBlock(this.#radar);
                return;
            }
            // Accept Handoff, Recall handoff
            if (plane.PendingHandoff === this.ThisPositionIndicator) {
                plane.PositionInd = this.ThisPositionIndicator;
                plane.PendingHandoff = null;
                plane.SendUpdate();
            }
            else if (plane.PositionInd === this.ThisPositionIndicator && !(plane.PendingHandoff == null || plane.PendingHandoff === "")) {
                plane.PendingHandoff = null;
                plane.SendUpdate();
            }
            // Accept pointout, Recall pointout, Clear pointout color, Clear/reject / cancel pointout indication
            else if (plane.Pointout) {
                plane.Pointout = false;
            }
            else if (plane.ForceQuickLook) {
                plane.ForceQuickLook = false;
            }
            // CRC STARS: first click during outbound-complete blink stops
            // the flashing (data block stays white). Subsequent click hits
            // the "Owned && PositionInd != me" branch below to go green.
            else if (plane.DataBlock.Flashing && plane.Owned
                && plane.PositionInd !== this.ThisPositionIndicator
                && plane.PendingHandoff !== this.ThisPositionIndicator) {
                plane.DataBlock.Flashing = false;
                plane.DataBlock2.Flashing = false;
                plane.DataBlock3.Flashing = false;
                plane.JustTransferredAt = new Date(-8640000000000000); // DateTime.MinValue
            }
            // acknowledge CA / MSAW / SPC / FMA track … (see source for the full behavior list)
            // Return data block to unowned color
            else if (plane.Owned && plane.PositionInd !== this.ThisPositionIndicator) {
                plane.Owned = false;
            }
            // Take control of interfacility track … Beacon readout - owned and associated track
            else if (plane.Owned && !(plane.FlightPlanCallsign == null || plane.FlightPlanCallsign === "")) {
                this.DisplayPreviewMessage(`${plane.FlightPlanCallsign} ${plane.Squawk ?? ""} ${plane.AssignedSquawk ?? ""}`);
            }
            // Toggle quick look for a single track
            else if (!plane.Owned && !(plane.FlightPlanCallsign == null || plane.FlightPlanCallsign === "")) {
                plane.FDB = !plane.FDB;
            }
            // Create FP and associate to LDB … Beacon Readout - unassociated track
            else if (plane.FlightPlanCallsign == null || plane.FlightPlanCallsign === "") {
                plane.FDB = !plane.FDB;
            }
            //GenerateDataBlock(plane);
        }
    }
    KeysToString(keys, start = 0) { // string KeysToString(object[] keys, int start = 0)
        let output = "";
        for (let i = start; i < keys.length; i++) {
            let key = keys[i];
            // type == typeof(KeyCode) || type == typeof(Key) → mapped via KeyToChar (the (int)Key switch)
            if (KeyToChar.has(key)) {
                output += KeyToChar.get(key);
            }
            else if (typeof key === "string") { // key.GetType() == typeof(char)
                output += key;
            }
        }
        return output;
    }

    RenderPreview() {
        let oldtext = this.#PreviewArea.Text;
        if (this.#previewmessage != null && this.#previewmessageexpiry <= RadarWindow.CurrentTime)
            this.#previewmessage = null;
        else if (this.#previewmessage != null && this.Preview.length === 0)
            this.#PreviewArea.Text = this.#previewmessage;
        else
            this.#PreviewArea.Text = this.GeneratePreviewString(this.Preview);
        this.#PreviewArea.ForceRedraw();
        this.#PreviewArea.ForeColor = RadarWindow.AdjustedColor(this.DataBlockColor, this.CurrentPrefSet.Brightness.FullDataBlocks);
        this.#PreviewArea.LocationF = new PointF(this.PreviewLocation.X, this.PreviewLocation.Y - this.#PreviewArea.SizeF.Height);
        this.DrawLabel(this.#PreviewArea);
    }
    #previewmessage = null;    // string
    #previewmessageexpiry;     // DateTime

    DisplayPreviewMessage(message, seconds = 5) {
        this.Preview.length = 0; // Preview.Clear()
        this.#previewmessage = message;
        this.#previewmessageexpiry = this.#addSeconds(RadarWindow.CurrentTime, seconds); // CurrentTime.AddSeconds(seconds)
    }
    #fps = 0; // private int fps = 0 (C# declares at ~3741; pulled early — RenderStatus reads it)
    // C# numeric/date format helpers: ToString("HHmm/ss"), ToString("00.00"), ToString("0.0").
    #fmtClock(t) {
        let hh = String(t.getUTCHours()).padStart(2, "0");
        let mm = String(t.getUTCMinutes()).padStart(2, "0");
        let ss = String(t.getUTCSeconds()).padStart(2, "0");
        return `${hh}${mm}/${ss}`;
    }
    #toFixedPad(v, intMin, dec) { // ToString("00.00") = (intMin=2,dec=2); "0.0" = (1,1)
        let neg = v < 0;
        let s = Math.abs(v).toFixed(dec);
        let dot = s.indexOf(".");
        let intPart = dot >= 0 ? s.slice(0, dot) : s;
        let fracPart = dot >= 0 ? s.slice(dot) : "";
        intPart = intPart.padStart(intMin, "0");
        return (neg ? "-" : "") + intPart + fracPart;
    }
    RenderStatus() {
        this.#StatusArea.ForeColor = RadarWindow.AdjustedColor(this.DataBlockColor, this.CurrentPrefSet.Brightness.Lists);
        this.#StatusArea.Font = this.Font;
        let oldtext = this.#StatusArea.Text;
        let timesyncind = RadarWindow.#timesync.Synchronized ? " " : "*";
        this.#StatusArea.Text = this.#fmtClock(RadarWindow.CurrentTime) + timesyncind + this.#toFixedPad(this.#wx.Altimeter.Value, 2, 2) + "\r\n";
        // Reserve a blank line below the clock for the SPC code line (drawn as
        // separate red/yellow labels in RenderSSAAlertCodes) so it doesn't overlap.
        let ssaSpcRed = { value: "" }, ssaSpcYellow = { value: "" }; // out var
        this.GetActiveSpcCodes(ssaSpcRed, ssaSpcYellow);
        if (ssaSpcRed.value.length > 0 || ssaSpcYellow.value.length > 0)
            this.#StatusArea.Text += "\r\n";
        for (let i = 0; i < 10; i++) {
            if (this.#atises[i] != null) {
                this.#StatusArea.Text += this.#atises[i] + " ";
                if (this.#gentexts[i] != null)
                    this.#StatusArea.Text += this.#gentexts[i];
                this.#StatusArea.Text += "\r\n";
            }
        }
        if (this.SelectedBeaconCodes.length > 0) {

            for (const squawk of this.SelectedBeaconCodes) {
                this.#StatusArea.Text += squawk + " ";
            }
            this.#StatusArea.Text += "\r\n";
        }
        this.#StatusArea.Text += Math.trunc(this.CurrentPrefSet.Range) + "NM" + " PTL: " + this.#toFixedPad(this.CurrentPrefSet.PTLLength, 1, 1) + "\r\n";
        this.#StatusArea.Text += this.ToFilterAltitudeString(this.MinAltitude) + " " + this.ToFilterAltitudeString(this.MaxAltitude) + " U "
            + this.ToFilterAltitudeString(this.MinAltitudeAssociated) + " " + this.ToFilterAltitudeString(this.MaxAltitudeAssociated) + " A\r\n";
        if (this.ATPA.Active) {
            this.#StatusArea.Text += "INTRAIL ON: ";
            this.ATPA.Volumes.forEach(x => {
                if (x.Active) {
                    this.#StatusArea.Text += x.VolumeId + " ";
                }
            });
            this.#StatusArea.Text += "\r\n";
            let tpfv = this.ATPA.Volumes.filter(v => v.TwoPointFiveEnabled && v.TwoPointFiveActive && v.Active);
            if (tpfv.length > 0) {
                this.#StatusArea.Text += "INTRAIL 2.5 ON: ";
                tpfv.forEach(v => this.#StatusArea.Text += v.VolumeId + " ");
                this.#StatusArea.Text += "\r\n";
            }
        }
        let metarnum = 0;
        let crlast = false;
        for (const metar of [...this.#wx.Metars].sort((a, b) => (a.ICAO < b.ICAO ? -1 : a.ICAO > b.ICAO ? 1 : 0))) { // OrderBy(x => x.ICAO)
            metarnum++;
            if (metar.IsValid) {
                try {
                    let station = metar.ICAO;
                    if (station.length === 4 && station[0] === "K") //not really correct, but whatever
                        station = station.substring(1);
                    if (metar.Pressure != null) {
                        this.#StatusArea.Text += station;
                        this.#StatusArea.Text += " ";
                        this.#StatusArea.Text += this.#toFixedPad(metar.Pressure.GetConvertedValue(Value.Unit.MercuryInch), 2, 2);

                    }
                    else {
                        this.#StatusArea.Text += station + " 00.00";
                    }
                    //if (WindInStatusArea)
                    //    StatusArea.Text += " " + metar.Wind.Raw;
                }
                catch {
                    this.#StatusArea.Text += metar.ICAO + " METAR ERR";
                }
                if (this.WindInStatusArea || metarnum % 3 === 0) {
                    this.#StatusArea.Text += "\r\n";
                    crlast = true;
                }
                else {
                    this.#StatusArea.Text += " ";
                    crlast = false;
                }
            }
        }
        if (!crlast) {
            this.#StatusArea.Text += "\r\n";
        }
        if (this.FPSInStatusArea) {
            this.#StatusArea.Text += `FPS: ${this.#fps} AC: ${RadarWindow.Aircraft.length}`; // Aircraft.Count
            this.#StatusArea.Text += "\r\n";
        }
        if (this.QuickLookList.length > 0) {
            this.#StatusArea.Text += "QL: ";
            for (const quicklook of this.QuickLookList) {
                this.#StatusArea.Text += `${quicklook} `;
            }
            this.#StatusArea.Text += "\r\n";
        }
        this.#StatusArea.LocationF = new PointF(this.StatusLocation.X, this.StatusLocation.Y - this.#StatusArea.SizeF.Height);
        this.DrawLabel(this.#StatusArea);
    }

    static LACAMCIId(ac) { // private static string LACAMCIId(Aircraft ac)
        if (!(ac.FlightPlanCallsign == null || ac.FlightPlanCallsign === ""))
            return ac.FlightPlanCallsign;
        return !(ac.Squawk == null || ac.Squawk === "") ? ac.Squawk : "----";
    }
    RenderLACAMCIList() {
        if (!this.ShowLACAMCIList)
            return;
        let tracks; // List<Aircraft>
        // lock (Aircraft)
        tracks = RadarWindow.Aircraft.filter(x => !x.Deleted && (x.LowAltitude || x.ConflictAlert));
        if (tracks.length === 0)
            return;
        // Per vSTARS, an unassociated alert track shows its reported beacon code
        // in place of the callsign (an MCI rather than a CA when one of a pair).
        let text = "LA/CA/MCI\r\n";
        for (const ac of tracks.filter(x => x.LowAltitude)) {
            let hundreds = Math.trunc(ac.TrueAltitude / 100);
            text += `LA ${RadarWindow.LACAMCIId(ac)} ${this.#padNum(hundreds, 3)}\r\n`; // {hundreds:000}
        }
        let shownPairs = new Set(); // HashSet<string>
        for (const ac of tracks.filter(x => x.ConflictAlert)) {
            for (const partner of [...ac.ConflictingTracks]) { // ConflictingTracks.ToList()
                let ids = [String(ac.TrackGuid), String(partner.TrackGuid)];
                ids.sort(); // Array.Sort(ids)
                let key = ids.join("|"); // string.Join("|", ids)
                if (shownPairs.has(key)) // !shownPairs.Add(key) -> continue
                    continue;
                shownPairs.add(key);
                // CA when both associated; MCI if either is unassociated.
                let label = ((ac.FlightPlanCallsign == null || ac.FlightPlanCallsign === "") || (partner.FlightPlanCallsign == null || partner.FlightPlanCallsign === "")) ? "MCI" : "CA";
                text += `${label} ${RadarWindow.LACAMCIId(ac)} ${RadarWindow.LACAMCIId(partner)}\r\n`;
            }
        }
        this.#LACAMCIListArea.ForeColor = RadarWindow.AdjustedColor(this.DataBlockColor, this.CurrentPrefSet.Brightness.Lists);
        this.#LACAMCIListArea.Font = this.Font;
        this.#LACAMCIListArea.Text = text;
        this.#LACAMCIListArea.ForceRedraw();
        this.#LACAMCIListArea.LocationF = new PointF(this.LACAMCIListLocation.X, this.LACAMCIListLocation.Y);
        this.DrawLabel(this.#LACAMCIListArea);
    }
    // C# ToString("000") on a possibly-negative integer.
    #padNum(n, width) { return (n < 0 ? "-" : "") + String(Math.abs(n)).padStart(width, "0"); }

    ToFilterAltitudeString(altitude) { // string ToFilterAltitudeString(int altitude)
        let hundreds = Math.abs(Math.trunc(altitude / 100));
        let altString = String(hundreds).padStart(3, "0"); // ToString("000")
        if (altitude < 0)
            altString = "N99";
        return altString;
    }
    // GeneratePreviewString's (int)Key / (int)KeyCode switch, built once as a lookup map.
    static #previewMap = new Map([
        ...KeyToChar, // A-Z, 0-9, period, plus
        [Key.KeypadMultiply, "*"],
        [Key.Slash, "/"], [Key.KeypadDivide, "/"],
        [Key.Space, "\r\n"],
        [RadarWindow.KeyCode.FltData, "FD\r\n"],
        [RadarWindow.KeyCode.HndOff, "HO\r\n"],
        [RadarWindow.KeyCode.InitCntl, "IC\r\n"],
        [RadarWindow.KeyCode.Min, "MIN\r\n"],
        [RadarWindow.KeyCode.MultiFunc, "F\r\n"],
        [RadarWindow.KeyCode.TermCntl, "TC\r\n"],
        [RadarWindow.KeyCode.SignOn, "SIGN ON\r\n"],
        [RadarWindow.KeyCode.VP, "VP\r\n"],
        [RadarWindow.KeyCode.RngRing, "RR"],
        [RadarWindow.KeyCode.WX, "WX"],
        [RadarWindow.KeyCode.RecenterEverything, "RECENTER"],
    ]);
    GeneratePreviewString(keys) { // string GeneratePreviewString(List<object> keys)
        let output = "";
        for (const key of keys) {
            if (typeof key === "string") { // type == typeof(char)
                switch (key) {
                    case " ":
                        output += "\r\n";
                        break;
                    case "`":
                        output += "▲";
                        break;
                    default:
                        output += key;
                        break;
                }
            }
            else if (RadarWindow.#previewMap.has(key)) { // type == typeof(KeyCode) || type == typeof(Key)
                output += RadarWindow.#previewMap.get(key);
            }
            // else: unmapped enum value -> default break (nothing)
        }
        output += " ";
        return output;
    }

    Window_KeyPress(sender, e) { // (object sender, KeyPressEventArgs e)
        let key = e.KeyChar.toUpperCase(); // char.ToUpper(e.KeyChar)
        this.Preview.push(key); // Preview.Add(key)
    }

    #showAllCallsigns = false; // private bool
    Window_KeyDown(sender, e) { // (object sender, KeyboardKeyEventArgs e)
        let oldscale = this.#scale;
        if (e.Control) {
            switch (e.Key) {
                case Key.C:
                    this.Preview.length = 0; // Preview.Clear()
                    this.StopReceivers();
                    Environment.Exit(0);
                    break;
                case Key.S:
                    if (e.Shift) {
                        // using (SaveFileDialog dialog = new SaveFileDialog())
                        {
                            let dialog = new SaveFileDialog();
                            dialog.RestoreDirectory = true;
                            dialog.Filter = "xml files (*.xml)|*.xml|All files (*.*)|*.*";
                            dialog.FilterIndex = 1;
                            if (dialog.ShowDialog() === DialogResult.OK) {
                                this.#settingsPath = dialog.FileName;
                            }
                            else {
                                dialog.Dispose();
                                break;
                            }
                            dialog.Dispose();
                        }
                    }
                    this.Preview.length = 0;
                    this.SaveSettings(this.#settingsPath);
                    break;
                case Key.P: {
                    let properties = new PropertyForm(this);
                    properties.Show();
                    break;
                }
                case Key.Q:
                    this.QuickLook = !this.QuickLook;
                    break;
                case Key.F1:
                    if (!e.Shift) {
                        if (this.CurrentPrefSet.ScopeCentered) {
                            this.CurrentPrefSet.ScopeCentered = false;
                        }
                        else {
                            this.CurrentPrefSet.ScopeCentered = true;
                        }
                    }
                    else {
                        this.Preview.push(RadarWindow.KeyCode.RecenterEverything);
                        this.Preview.push(" ");
                    }
                    break;
                case Key.F2: {
                    let selector = new VideoMapSelector(this.VideoMaps);
                    selector.Show();
                    selector.BringToFront();
                    selector.Focus();
                    break;
                }
                case Key.F8:
                    this.CurrentPrefSet.DCBVisible = !this.CurrentPrefSet.DCBVisible;
                    break;
                case Key.F9:
                    this.Preview.length = 0;
                    this.Preview.push(RadarWindow.KeyCode.RngRing);
                    break;
                case Key.B: {
                    this.ADSBSettings.EnsureBuiltInSources();
                    let adsbForm = new ADSBBeaconReaderForm(this.ADSBSettings, this.#adsbService);
                    adsbForm.Show();
                    adsbForm.BringToFront();
                    adsbForm.Focus();
                    adsbForm.FormClosed.add((s, args) => this.RestartADSBService());
                    break;
                }
            }
        }
        else if (e.Alt) {
            switch (e.Key) {
                case Key.Enter:
                case Key.KeypadEnter:
                    if (this.#isScreenSaver) {
                        this.StopReceivers();
                        Environment.Exit(0);
                    }
                    else
                        this.#window.WindowState = this.#window.WindowState === WindowState.Fullscreen ? WindowState.Normal : WindowState.Fullscreen;
                    break;
                case Key.F4:
                    this.Preview.length = 0;
                    this.StopReceivers();
                    this.SaveSettings(this.#settingsPath);
                    Environment.Exit(0);
                    break;
            }
        }
        else {
            switch (e.Key) {
                case Key.F13:
                case Key.F14:
                case Key.F15:
                case Key.F16:
                case Key.F17:
                    this.Preview.length = 0;
                    this.Preview.push(RadarWindow.KeyCode.WX);
                    break;
                case Key.F18:
                case Key.F19:
                case Key.F20:
                case Key.F21:
                case Key.F22:
                case Key.F23:
                case Key.F24:
                case Key.LShift:
                case Key.RShift:
                    break;
                case Key.Escape:
                    this.Preview.length = 0;
                    this.#previewmessage = null;
                    this.ReleaseDCBButton();
                    this.#centeredmouse = true;
                    this.#window.CursorVisible = true;
                    if (this.#tempLine != null) {
                        // lock (rangeBearingLines)
                        { let idx = this.#rangeBearingLines.indexOf(this.#tempLine); if (idx >= 0) this.#rangeBearingLines.splice(idx, 1); } // Remove(tempLine)
                        this.#tempLine = null;
                    }
                    if (this.#tempMinSep != null)
                        this.#tempMinSep = null;
                    break;
                case Key.Enter:
                case Key.KeypadEnter:
                case Key.PageDown:
                    this.ProcessCommand(this.Preview);
                    break;
                case Key.BackSpace:
                    if (this.Preview.length > 0)
                        this.Preview.splice(this.Preview.length - 1, 1); // RemoveAt(Count - 1)
                    break;
                case Key.F1:
                    if (!this.#showAllCallsigns) {
                        this.#showAllCallsigns = true;
                    }
                    break;
                default: {
                    if ((e.Key > 9 && e.Key < 22) || e.Key === Key.End)
                        this.Preview.length = 0;
                    let isText = (e.Key >= Key.A && e.Key <= Key.Z) || (e.Key >= Key.Number0 && e.Key <= Key.Number9) || (e.Key >= Key.Keypad0 && e.Key <= Key.Keypad9) || e.Key === Key.Period || e.Key === Key.KeypadPeriod
                        || e.Key === Key.Slash || e.Key === Key.Quote || e.Key === Key.Plus || e.Key === Key.BracketLeft || e.Key === Key.BracketRight || e.Key === Key.Minus || e.Key === Key.KeypadMultiply || e.Key === Key.KeypadPlus || e.Key === Key.Space || e.Key === Key.Grave;
                    if (!isText)
                        this.Preview.push(e.Key); // Preview.Add(e.Key)
                    break;
                }
            }
        }
    }
    #centeredmouse = false; // bool centeredmouse (C# declares @4368; pulled early — Escape handler sets it)
    Window_KeyUp(sender, e) { // (object sender, KeyboardKeyEventArgs e)
        switch (e.Key) {
            case Key.F1:
                if (this.#showAllCallsigns) {
                    this.#showAllCallsigns = false;
                }
                break;
        }
    }

    Window_Resize(sender, e) { // (object sender, EventArgs e)
        let oldscale = this.#scale;
        GL.Viewport(0, 0, this.#window.Width, this.#window.Height);
    }

    Window_UpdateFrame(sender, e) { // (object sender, FrameEventArgs e)
    }

    // ── DCB (Display Control Bar) buttons/menus — object-initializers → Object.assign ──
    #dcb = new DCB();
    #dcbMainMenu = new DCBMenu();
    activeDcbButton;                         // DCBButton (referenced by Window_MouseDown/Wheel)
    #dcbRangeButton = Object.assign(new DCBAdjustmentButton(), { Height: 80, Width: 80 });
    #dcbPlaceCntrButton = Object.assign(new DCBAdjustmentButton(), { Height: 40, Width: 80, Text: "PLACE\r\nCNTR" });
    #dcbOffCntrButton = Object.assign(new DCBToggleButton(), { Height: 40, Width: 80, Text: "OFF\r\nCNTR" });
    #dcbRRButton = Object.assign(new DCBAdjustmentButton(), { Height: 80, Width: 80 });
    dcbPlaceRRButton = Object.assign(new DCBActionButton(), { Height: 40, Width: 80, Text: "PLACE\r\nRR" }); // read by Window_MouseDown
    #dcbRRCntrButton = Object.assign(new DCBButton(), { Height: 40, Width: 80, Text: "RR\r\nCNTR" });
    #dcbMapsButton = Object.assign(new DCBSubmenuButton(), { Height: 80, Width: 80, Text: "MAPS" });
    #dcbMapsMenu = new DCBMenu();
    #dcbMapsSubmenuDoneButton = Object.assign(new DCBButton(), { Height: 40, Width: 80, Text: "DONE" });
    #dcbClearAllMapsButton = Object.assign(new DCBButton(), { Height: 40, Width: 80, Text: "CLR ALL" });
    #dcbMapButton = new Array(32);           // DCBToggleButton[32]
    #dcbWxButton = new Array(6);             // DCBToggleButton[6]
    #dcbBriteButton = Object.assign(new DCBSubmenuButton(), { Height: 80, Width: 80, Text: "BRITE" });
    #dcbLdrDirButton = Object.assign(new DCBAdjustmentButton(), { Height: 40, Width: 80 });
    #dcbLdrLenButton = Object.assign(new DCBAdjustmentButton(), { Height: 40, Width: 80 });
    #dcbCharSizeButton = Object.assign(new DCBSubmenuButton(), { Height: 80, Width: 80, Text: "CHAR\r\nSIZE", Disabled: true });
    #dcbModeButton = Object.assign(new DCBButton(), { Height: 80, Width: 80, Text: "MODE\r\nFSL", Disabled: true });
    #dcbSiteButton = Object.assign(new DCBSubmenuButton(), { Height: 80, Width: 80 });

    #dcbShiftButton = Object.assign(new DCBButton(), { Height: 80, Width: 80, Text: "SHIFT" });
    #dcbShiftButton2 = Object.assign(new DCBButton(), { Height: 80, Width: 80, Text: "SHIFT" });

    #dcbShiftMenu = new DCBMenu();
    #dcbVolumeButton = Object.assign(new DCBButton(), { Height: 80, Width: 80, Text: "VOL\r\nN/A", Disabled: true });
    #dcbHistoryNumButton = Object.assign(new DCBAdjustmentButton(), { Height: 40, Width: 80 });
    #dcbHistoryRateButton = Object.assign(new DCBAdjustmentButton(), { Height: 40, Width: 80 });
    #dcbCursorHomeButton = Object.assign(new DCBButton(), { Height: 80, Width: 80, Text: "CURSOR\r\nHOME", Disabled: true });
    #dcbCursorSpeedButton = Object.assign(new DCBAdjustmentButton(), { Height: 80, Width: 80, Text: "CSR SPD\r\nN/A", Disabled: true });
    #dcbMapUncorButton = Object.assign(new DCBButton(), { Height: 80, Width: 80, Text: "MAP\r\nUNCOR", Disabled: true });
    #dcbUncorButton = Object.assign(new DCBButton(), { Height: 80, Width: 80, Text: "UNCOR", Disabled: true });
    #dcbBeaconModeButton = Object.assign(new DCBButton(), { Height: 80, Width: 80, Text: "BEACON\r\nMODE-2", Disabled: true });
    #dcbRtqcButton = Object.assign(new DCBButton(), { Height: 80, Width: 80, Text: "RTQC", Disabled: true });
    #dcbMcpButton = Object.assign(new DCBButton(), { Height: 80, Width: 80, Text: "MCP", Disabled: true });
    #dcbDcbTopButton = Object.assign(new DCBButton(), { Height: 40, Width: 80, Text: "DCB\r\nTOP" });
    #dcbDcbLeftButton = Object.assign(new DCBButton(), { Height: 40, Width: 80, Text: "DCB\r\nLEFT" });
    #dcbDcbRightButton = Object.assign(new DCBButton(), { Height: 40, Width: 80, Text: "DCB\r\nRIGHT" });
    #dcbDcbBottomButton = Object.assign(new DCBButton(), { Height: 40, Width: 80, Text: "DCB\r\nBOTTOM" });
    #dcbPtlLengthButton = Object.assign(new DCBAdjustmentButton(), { Height: 80, Width: 80 });
    #dcbPtlOwnButton = Object.assign(new DCBToggleButton(), { Height: 40, Width: 80, Text: "PTL OWN" });
    #dcbPtlAllButton = Object.assign(new DCBToggleButton(), { Height: 40, Width: 80, Text: "PTL ALL" });

    #briteMenu = new DCBMenu();
    #briteDCBbutton = Object.assign(new DCBAdjustmentButton(), { Width: 80, Height: 40 });
    #briteBKCbutton = Object.assign(new DCBAdjustmentButton(), { Width: 80, Height: 40 });
    #briteMPAbutton = Object.assign(new DCBAdjustmentButton(), { Width: 80, Height: 40 });
    #briteMPBbutton = Object.assign(new DCBAdjustmentButton(), { Width: 80, Height: 40 });
    #briteFDBbutton = Object.assign(new DCBAdjustmentButton(), { Width: 80, Height: 40 });
    #briteLSTbutton = Object.assign(new DCBAdjustmentButton(), { Width: 80, Height: 40 });
    #britePOSbutton = Object.assign(new DCBAdjustmentButton(), { Width: 80, Height: 40 });
    #briteLDBbutton = Object.assign(new DCBAdjustmentButton(), { Width: 80, Height: 40 });
    #briteOTHbutton = Object.assign(new DCBAdjustmentButton(), { Width: 80, Height: 40 });
    #briteTLSbutton = Object.assign(new DCBAdjustmentButton(), { Width: 80, Height: 40 });
    #briteRRbutton = Object.assign(new DCBAdjustmentButton(), { Width: 80, Height: 40 });
    #briteCMPbutton = Object.assign(new DCBAdjustmentButton(), { Width: 80, Height: 40 });
    #briteBCNbutton = Object.assign(new DCBAdjustmentButton(), { Width: 80, Height: 40 });
    #britePRIbutton = Object.assign(new DCBAdjustmentButton(), { Width: 80, Height: 40 });
    #briteHSTbutton = Object.assign(new DCBAdjustmentButton(), { Width: 80, Height: 40 });
    #briteWXbutton = Object.assign(new DCBAdjustmentButton(), { Width: 80, Height: 40 });
    #briteWXCbutton = Object.assign(new DCBAdjustmentButton(), { Width: 80, Height: 40 });
    #briteDoneButton = Object.assign(new DCBButton(), { Width: 80, Height: 80, Text: "DONE" });

    #siteMenu = new DCBMenu();

    TCP = new TCP(); // public TCP TCP { get; set; } = new TCP()

    SetupDCB() {
        this.#dcbMainMenu.AddButton(this.#dcbRangeButton);
        this.#dcbRangeButton.Click.add(this.DcbButtonClick.bind(this)); // += DcbButtonClick
        this.#dcbMainMenu.AddButton(this.#dcbPlaceCntrButton);
        this.#dcbPlaceCntrButton.Click.add(this.DcbButtonClick.bind(this));
        this.#dcbMainMenu.AddButton(this.#dcbOffCntrButton);
        this.#dcbOffCntrButton.Click.add(this.DcbButtonClick.bind(this));
        this.#dcbMainMenu.AddButton(this.#dcbRRButton);
        this.#dcbRRButton.Click.add(this.DcbButtonClick.bind(this));
        this.#dcbMainMenu.AddButton(this.dcbPlaceRRButton);
        this.dcbPlaceRRButton.Click.add(this.DcbScopeActionButtonClick.bind(this));
        this.#dcbMainMenu.AddButton(this.#dcbRRCntrButton);
        this.#dcbRRCntrButton.Click.add(this.DcbButtonClick.bind(this));

        this.#dcbMainMenu.AddButton(this.#dcbMapsButton);
        this.#dcbMapsButton.Submenu = this.#dcbMapsMenu;
        this.#dcbMapsButton.Click.add(this.DcbSubmenuButtonClick.bind(this));
        for (let i = 0; i < 6; i++) {
            this.#dcbMapButton[i] = Object.assign(new DCBToggleButton(), { Height: 40, Width: 80, Text: "MAP\r\n" + (i + 1) });
            this.#dcbMainMenu.AddButton(this.#dcbMapButton[i]);
            this.#dcbMapButton[i].Click.add(this.DcbMapButtonClick.bind(this));
        }
        this.#dcbMapsMenu.AddButton(this.#dcbMapsSubmenuDoneButton);
        this.#dcbMapsMenu.AddButton(this.#dcbClearAllMapsButton);
        this.#dcbMapsSubmenuDoneButton.Click.add(this.DcbButtonClick.bind(this));
        this.#dcbClearAllMapsButton.Click.add(this.DcbClearAllMapsButton_Click.bind(this));
        for (let i = 6; i < this.#dcbMapButton.length; i++) {
            this.#dcbMapButton[i] = Object.assign(new DCBToggleButton(), { Height: 40, Width: 80, Text: "MAP\r\n" + (i + 1) });
            this.#dcbMapsMenu.AddButton(this.#dcbMapButton[i]);
            this.#dcbMapButton[i].Click.add(this.DcbMapButtonClick.bind(this));
        }
        for (let i = 0; i < this.#dcbWxButton.length; i++) {
            this.#dcbWxButton[i] = Object.assign(new DCBToggleButton(), { Height: 80, Width: 40, RotateIfVertical: true, Text: "WX" + (i + 1) });
            this.#dcbMainMenu.AddButton(this.#dcbWxButton[i]);
            this.#dcbWxButton[i].Click.add(this.DcbWxButtonClick.bind(this));
        }
        this.#dcbMainMenu.AddButton(this.#dcbBriteButton);
        this.#dcbBriteButton.Click.add(this.DcbSubmenuButtonClick.bind(this));
        this.#dcbBriteButton.Submenu = this.#briteMenu;
        this.#dcbMainMenu.AddButton(this.#dcbLdrDirButton);
        this.#dcbLdrDirButton.Click.add(this.DcbButtonClick.bind(this));
        this.#dcbLdrDirButton.Up.add(this.DcbLdrDirButton_Up.bind(this));
        this.#dcbLdrDirButton.Down.add(this.DcbLdrDirButton_Down.bind(this));
        this.#dcbMainMenu.AddButton(this.#dcbLdrLenButton);
        this.#dcbLdrLenButton.Click.add(this.DcbButtonClick.bind(this));
        this.#dcbMainMenu.AddButton(this.#dcbCharSizeButton);
        this.#dcbMainMenu.AddButton(this.#dcbModeButton);
        this.#dcbMainMenu.AddButton(this.#dcbSiteButton);
        this.#dcbSiteButton.Submenu = this.#siteMenu;
        this.#dcbSiteButton.Click.add(this.DcbSubmenuButtonClick.bind(this));
        this.#dcbMainMenu.AddButton(this.#dcbShiftButton);
        this.#dcbShiftButton.Click.add(this.DcbButtonClick.bind(this));

        //Auxiliary DCB Menu
        this.#dcbShiftMenu.AddButton(this.#dcbVolumeButton);
        this.#dcbShiftMenu.AddButton(this.#dcbHistoryNumButton);
        this.#dcbShiftMenu.AddButton(this.#dcbHistoryRateButton);
        this.#dcbShiftMenu.AddButton(this.#dcbCursorHomeButton);
        this.#dcbShiftMenu.AddButton(this.#dcbCursorSpeedButton);
        this.#dcbShiftMenu.AddButton(this.#dcbMapUncorButton);
        this.#dcbShiftMenu.AddButton(this.#dcbUncorButton);
        this.#dcbShiftMenu.AddButton(this.#dcbBeaconModeButton);
        this.#dcbShiftMenu.AddButton(this.#dcbRtqcButton);
        this.#dcbShiftMenu.AddButton(this.#dcbMcpButton);
        this.#dcbShiftMenu.AddButton(this.#dcbDcbTopButton);
        this.#dcbShiftMenu.AddButton(this.#dcbDcbLeftButton);
        this.#dcbShiftMenu.AddButton(this.#dcbDcbRightButton);
        this.#dcbShiftMenu.AddButton(this.#dcbDcbBottomButton);
        this.#dcbShiftMenu.AddButton(this.#dcbPtlLengthButton);
        this.#dcbShiftMenu.AddButton(this.#dcbPtlOwnButton);
        this.#dcbShiftMenu.AddButton(this.#dcbPtlAllButton);
        this.#dcbShiftMenu.AddButton(this.#dcbShiftButton2);
        this.#dcbHistoryNumButton.Click.add(this.DcbButtonClick.bind(this));
        this.#dcbHistoryRateButton.Click.add(this.DcbButtonClick.bind(this));
        this.#dcbDcbTopButton.Click.add(this.DcbButtonClick.bind(this));
        this.#dcbDcbLeftButton.Click.add(this.DcbButtonClick.bind(this));
        this.#dcbDcbRightButton.Click.add(this.DcbButtonClick.bind(this));
        this.#dcbDcbBottomButton.Click.add(this.DcbButtonClick.bind(this));
        this.#dcbPtlOwnButton.Click.add(this.DcbButtonClick.bind(this));
        this.#dcbPtlAllButton.Click.add(this.DcbButtonClick.bind(this));
        this.#dcbPtlLengthButton.Click.add(this.DcbButtonClick.bind(this));
        this.#dcbShiftButton2.Click.add(this.DcbButtonClick.bind(this));

        this.#briteMenu.AddButton(this.#briteDCBbutton);
        this.#briteMenu.AddButton(this.#briteBKCbutton);
        this.#briteMenu.AddButton(this.#briteMPAbutton);
        this.#briteMenu.AddButton(this.#briteMPBbutton);
        this.#briteMenu.AddButton(this.#briteFDBbutton);
        this.#briteMenu.AddButton(this.#briteLSTbutton);
        this.#briteMenu.AddButton(this.#britePOSbutton);
        this.#briteMenu.AddButton(this.#briteLDBbutton);
        this.#briteMenu.AddButton(this.#briteOTHbutton);
        this.#briteMenu.AddButton(this.#briteTLSbutton);
        this.#briteMenu.AddButton(this.#briteRRbutton);
        this.#briteMenu.AddButton(this.#briteCMPbutton);
        this.#briteMenu.AddButton(this.#briteBCNbutton);
        this.#briteMenu.AddButton(this.#britePRIbutton);
        this.#briteMenu.AddButton(this.#briteHSTbutton);
        this.#briteMenu.AddButton(this.#briteWXbutton);
        this.#briteMenu.AddButton(this.#briteWXCbutton);
        this.#briteMenu.AddButton(this.#briteDoneButton);
        this.#briteDCBbutton.Click.add(this.DcbButtonClick.bind(this));
        this.#briteBKCbutton.Click.add(this.DcbButtonClick.bind(this));
        this.#briteMPAbutton.Click.add(this.DcbButtonClick.bind(this));
        this.#briteMPBbutton.Click.add(this.DcbButtonClick.bind(this));
        this.#briteFDBbutton.Click.add(this.DcbButtonClick.bind(this));
        this.#briteLSTbutton.Click.add(this.DcbButtonClick.bind(this));
        this.#britePOSbutton.Click.add(this.DcbButtonClick.bind(this));
        this.#briteLDBbutton.Click.add(this.DcbButtonClick.bind(this));
        this.#briteOTHbutton.Click.add(this.DcbButtonClick.bind(this));
        this.#briteTLSbutton.Click.add(this.DcbButtonClick.bind(this));
        this.#briteRRbutton.Click.add(this.DcbButtonClick.bind(this));
        this.#briteCMPbutton.Click.add(this.DcbButtonClick.bind(this));
        this.#briteBCNbutton.Click.add(this.DcbButtonClick.bind(this));
        this.#britePRIbutton.Click.add(this.DcbButtonClick.bind(this));
        this.#briteHSTbutton.Click.add(this.DcbButtonClick.bind(this));
        this.#briteWXbutton.Click.add(this.DcbButtonClick.bind(this));
        this.#briteWXCbutton.Click.add(this.DcbButtonClick.bind(this));
        this.#briteDoneButton.Click.add(this.DcbButtonClick.bind(this));

        this.#dcb.ActiveMenu = this.#dcbMainMenu;
    }

    // ===== PORTED THROUGH LINE 3939 / 6962 — next chunk continues here (DcbLdrDirButton_Down @3940) =====
}
