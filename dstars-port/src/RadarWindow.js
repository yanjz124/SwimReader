// Ported 1:1 from _source/RadarWindow.cs  (namespace DGScope) — the main STARS scope class.
// It hosts an OpenTK GLControl and drives the immediate-mode render loop; ported STANDALONE
// (WinForms Control/Form/GLControl/Application wiring -> own fields / commented stubs; GL drawing
// -> the _shims/GL.js immediate-mode shim, verbatim).
//
// ⏳ PORTED IN CHUNKS. Current: lines 1–175 of 6962. The three static members that other modules
// (Aircraft/Radar/MSAW/ConflictAlertSystem/ATPA...) import and use — Aircraft, CurrentTime,
// AdjustedColor — are kept working throughout; real definitions replace stubs as their source is reached.
import { LeaderDirection, LeaderDirectionName } from "./STARS/LeaderDirection.js";
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
import { GL, EnableCap, BlendingFactor, BlendEquationMode, ClearBufferMask, PrimitiveType, TextureTarget, PixelInternalFormat, PixelFormat, PixelType, TextureParameterName, TextureMagFilter, TextureMinFilter, TextureWrapMode } from "./_shims/GL.js";
import { ConnectingLineF } from "./LeaderLine.js";
import { ATPAStatus } from "./ATPA.js";
import { PrimaryReturn } from "./PrimaryReturn.js";
import { Matrix4 } from "./_shims/OpenTK.js";
import { MathHelper } from "./_shims/MathHelper.js";
import { Timer, TimerCallback } from "./_shims/Threading.js";
import { MD5 } from "./_shims/Crypto.js";
import { ObservableCollection, NotifyCollectionChangedAction, List } from "./_shims/Collections.js";
import { TCP } from "./STARS/TCP.js";
import { MapCategory } from "./VideoMap.js";
import { tryParseInt } from "./_shims/Primitives.js";
import { Task } from "./_shims/Threading.js";
import { Altitude } from "./Altitude.js";
import { ADSBBeaconReaderService } from "./ADSBBeaconReader/ADSBBeaconReaderService.js";
import { Aircraft } from "./Aircraft.js";
import { DCBSubmenuButton, DCBAdjustmentButton, DCBButton, DCBToggleButton, DCBActionButton } from "./DCBButton.js";
import { DCBMenu } from "./DCBMenu.js";
import { DCB, DCBLocation } from "./DCB.js";
import { RadarType } from "./Radar.js";
import { Keyboard, Key, Mouse, ButtonState, Vector4, KeyToChar } from "./_shims/OpenTK.js";
import { Value } from "./_shims/MetarDecoder.js";
import { Clipboard, SaveFileDialog, Cursor } from "./_shims/WinForms.js";
import { Rectangle, RectangleF, SizeF } from "./_shims/SystemDrawing.js";
import { PropertyForm } from "./PropertyForm.js";
import { VideoMapSelector } from "./VideoMapSelector.js";
import { ADSBBeaconReaderForm } from "./ADSBBeaconReader/ADSBBeaconReaderForm.js";
import { Environment } from "./_shims/System.js";
import { tryParseDouble } from "./_shims/Primitives.js";
import { RangeBearingLine } from "./RangeBearingLine.js";
import { TPARing, TPACone, TPAType } from "./TPARing.js";
import { MinSep } from "./MinSep.js";
import { Line } from "./Line.js";

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
    get DCBFont() { return this.#dcb.Font; }
    set DCBFont(value) { this.#dcb.Font = value; }
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
        let settingsstring = new XmlSerializer(RadarWindow).Serialize(this); // XmlSerializer<RadarWindow>.Serialize(this)
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
            this.#dcb.ActiveMenu.MouseUp();
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
            this.#dcb.ActiveMenu.MouseMove(e.Position);
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
        if (this.CurrentPrefSet.DCBVisible && this.#dcb.ActiveMenu.DrawnBounds.Contains(ClickedPoint)) {
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
            this.#dcb.ActiveMenu.MouseDown();
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
            this.#dcb.ActiveMenu.MouseDown();
            this.#dcb.ActiveMenu.MouseUp();
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

    DcbLdrDirButton_Down(sender, e) { // (object sender, EventArgs e)
        switch (this.CurrentPrefSet.OwnedDataBlockPosition) {
            case LeaderDirection.NW:
                this.CurrentPrefSet.OwnedDataBlockPosition = LeaderDirection.W;
                break;
            case LeaderDirection.N:
                this.CurrentPrefSet.OwnedDataBlockPosition = LeaderDirection.NW;
                break;
            case LeaderDirection.NE:
                this.CurrentPrefSet.OwnedDataBlockPosition = LeaderDirection.N;
                break;
            case LeaderDirection.E:
                this.CurrentPrefSet.OwnedDataBlockPosition = LeaderDirection.NE;
                break;
            case LeaderDirection.SE:
                this.CurrentPrefSet.OwnedDataBlockPosition = LeaderDirection.E;
                break;
            case LeaderDirection.S:
                this.CurrentPrefSet.OwnedDataBlockPosition = LeaderDirection.SE;
                break;
            case LeaderDirection.SW:
                this.CurrentPrefSet.OwnedDataBlockPosition = LeaderDirection.S;
                break;
            case LeaderDirection.W:
                this.CurrentPrefSet.OwnedDataBlockPosition = LeaderDirection.SW;
                break;
        }
    }

    DcbLdrDirButton_Up(sender, e) { // (object sender, EventArgs e)
        switch (this.CurrentPrefSet.OwnedDataBlockPosition) {
            case LeaderDirection.NW:
                this.CurrentPrefSet.OwnedDataBlockPosition = LeaderDirection.N;
                break;
            case LeaderDirection.N:
                this.CurrentPrefSet.OwnedDataBlockPosition = LeaderDirection.NE;
                break;
            case LeaderDirection.NE:
                this.CurrentPrefSet.OwnedDataBlockPosition = LeaderDirection.E;
                break;
            case LeaderDirection.E:
                this.CurrentPrefSet.OwnedDataBlockPosition = LeaderDirection.SE;
                break;
            case LeaderDirection.SE:
                this.CurrentPrefSet.OwnedDataBlockPosition = LeaderDirection.S;
                break;
            case LeaderDirection.S:
                this.CurrentPrefSet.OwnedDataBlockPosition = LeaderDirection.SW;
                break;
            case LeaderDirection.SW:
                this.CurrentPrefSet.OwnedDataBlockPosition = LeaderDirection.W;
                break;
            case LeaderDirection.W:
                this.CurrentPrefSet.OwnedDataBlockPosition = LeaderDirection.NW;
                break;
        }
    }

    DcbSubmenuButtonClick(sender, e) { // (object sender, EventArgs e)
        let button = sender; // sender as DCBSubmenuButton
        button.SetScreenLocation(this.#window.PointToScreen(new Point(0, 0)));
        this.activeDcbButton = button;


        if (sender === this.#dcbSiteButton) {
            this.activeDcbButton = this.#dcbSiteButton;
            this.#siteMenu.ClearButtons();
            let i = 1;
            this.RadarSites.forEach(x => {
                if (x.RadarType !== RadarType.SLANT_RANGE)
                    return;
                let siteButton = Object.assign(new DCBButton(), {
                    Height: 80,
                    Width: 80,
                    Text: x.Char + "\r\n" + x.Name,
                    Value: x,
                    Active: this.#radar === x,
                });
                this.#siteMenu.AddButton(siteButton);
                siteButton.Click.add(this.SiteButton_Click.bind(this));
            });
            let multiButton = Object.assign(new DCBButton(), {
                Height: 80,
                Width: 80,
                Text: "MULTI",
                Enabled: false,
            });
            this.#siteMenu.AddButton(multiButton);
            multiButton.Click.add(this.SiteButton_Click.bind(this));
            let fusedButton = Object.assign(new DCBButton(), {
                Height: 80,
                Width: 80,
                Text: "FUSED",
                Value: Radar.FUSED,
                Active: this.#radar === Radar.FUSED,
            });
            this.#siteMenu.AddButton(fusedButton);
            fusedButton.Click.add(this.SiteButton_Click.bind(this));
        }
    }

    DcbButtonClick(sender, e) { // (object sender, EventArgs e)
        if (sender === this.#dcbShiftButton) {
            this.#dcb.ActiveMenu = this.#dcbShiftMenu;
        }
        else if (sender === this.#dcbShiftButton2) {
            this.#dcb.ActiveMenu = this.#dcbMainMenu;
        }
        else if (sender === this.#dcbDcbTopButton) {
            this.CurrentPrefSet.DCBLocation = DCBLocation.Top;
        }
        else if (sender === this.#dcbDcbLeftButton) {
            this.CurrentPrefSet.DCBLocation = DCBLocation.Left;
        }
        else if (sender === this.#dcbDcbBottomButton) {
            this.CurrentPrefSet.DCBLocation = DCBLocation.Bottom;
        }
        else if (sender === this.#dcbDcbRightButton) {
            this.CurrentPrefSet.DCBLocation = DCBLocation.Right;
        }
        else if (sender === this.#dcbRRCntrButton) {
            this.CurrentPrefSet.RangeRingsCentered = !this.CurrentPrefSet.RangeRingsCentered;
        }
        else if (sender === this.#dcbOffCntrButton) {
            if (this.CurrentPrefSet.ScopeCentered) {
                this.CurrentPrefSet.ScopeCentered = false;
            }
            else {
                this.CurrentPrefSet.ScopeCentered = true;
            }
        }
        else if (sender === this.#dcbPtlOwnButton) {
            this.CurrentPrefSet.PTLOwn = !this.CurrentPrefSet.PTLOwn;
            if (this.CurrentPrefSet.PTLOwn)
                this.CurrentPrefSet.PTLAll = false;
        }
        else if (sender === this.#dcbPtlAllButton) {
            this.CurrentPrefSet.PTLAll = !this.CurrentPrefSet.PTLAll;
            if (this.CurrentPrefSet.PTLAll)
                this.CurrentPrefSet.PTLOwn = false;
        }
        else if (sender.constructor === DCBAdjustmentButton) { // sender.GetType() == typeof(DCBAdjustmentButton)
            this.#window.CursorVisible = false;
            this.CenterMouse();
            this.activeDcbButton = sender; // sender as DCBAdjustmentButton
        }
        else if (sender === this.#dcbMapsSubmenuDoneButton) {
            this.#dcbMapsButton.OnClick(e);
        }
        else if (sender === this.#briteDoneButton) {
            this.#dcbBriteButton.OnClick(e);
        }
    }

    SiteButton_Click(sender, e) { // (object sender, EventArgs e)
        this.#dcbSiteButton.Active = false;
        let button = sender; // sender as DCBButton
        //button.ParentMenu.Enabled = true;
        if (button == null) { return; }
        let site = (button.Value instanceof Radar) ? button.Value : null; // button.Value as Radar
        if (site == null) { return; }
        this.#radar = site;
        this.ReleaseDCBButton();
    }

    DcbClearAllMapsButton_Click(sender, e) { // (object sender, EventArgs e)
        this.VideoMaps.forEach(x => x.Visible = false);
    }

    DcbMapsSubmenuDoneButton_Click(sender, e) { // (object sender, EventArgs e)
    }

    DcbScopeActionButtonClick(sender, e) { // (object sender, EventArgs e)
        this.activeDcbButton = sender; // sender as DCBButton
        if (this.activeDcbButton.constructor === DCBActionButton) // GetType() == typeof(DCBActionButton)
            this.activeDcbButton.Active = true;
    }

    DcbMapButtonClick(sender, e) { // (object sender, EventArgs e)
        for (let i = 0; i < this.#dcbMapButton.length; i++) {
            if (sender === this.#dcbMapButton[i]) {
                let map = this.VideoMaps.filter(x => x.Number === this.TCP.DCBMapList[i])[0] ?? null; // FirstOrDefault
                if (map == null)
                    return;
                map.Visible = !map.Visible;
            }
        }
    }

    DcbWxButtonClick(sender, e) { // (object sender, EventArgs e)
        for (let i = 0; i < this.#dcbWxButton.length; i++) {
            if (sender === this.#dcbWxButton[i]) {
                this.Nexrad.LevelsEnabled[i] = !this.Nexrad.LevelsEnabled[i];
            }
        }
        this.Nexrad.RecomputeVertices();
    }
    ReleaseDCBButton() {
        //if (activeDcbButton.GetType() != typeof(DCBAdjustmentButton))
        //    activeDcbButton.Active = false;
        if (this.activeDcbButton == null)
            return;
        if (this.activeDcbButton.constructor === DCBActionButton) // GetType() == typeof(DCBActionButton)
            this.activeDcbButton.ActionDone(); // ((DCBActionButton)activeDcbButton).ActionDone()
        this.activeDcbButton.Active = false;
        if (this.activeDcbButton.ParentMenu != null) {
            this.activeDcbButton.ParentMenu.Enabled = true;
            this.activeDcbButton = this.activeDcbButton.ParentMenu.SubmenuButton;
        }
        else {
            this.activeDcbButton = null;
        }
        this.#window.CursorVisible = true;
        Cursor.Clip = new Rectangle(); // System.Windows.Forms.Cursor.Clip = new Rectangle()
    }
    UpdateDCB() {
        this.#dcb.Location = this.CurrentPrefSet.DCBLocation;
        this.#dcb.Visible = this.CurrentPrefSet.DCBVisible;
        this.#dcbRangeButton.Text = "RANGE\r\n" + this.CurrentPrefSet.Range;
        this.#dcbOffCntrButton.Active = this.#ScreenCenterPoint !== this.HomeLocation;
        this.#dcbRRButton.Text = "RR\r\n" + Math.trunc(this.CurrentPrefSet.RangeRingSpacing);
        this.#dcbRRCntrButton.Active = this.#RangeRingCenter === this.HomeLocation;
        for (let i = 0; i < this.#dcbMapButton.length; i++) {
            let map = this.VideoMaps.filter(x => x.Number === this.TCP.DCBMapList[i])[0] ?? null; // FirstOrDefault
            if (map == null)
                continue;
            this.#dcbMapButton[i].Text = map.Number + "\r\n" + map.Mnemonic;
            this.#dcbMapButton[i].Active = map.Visible;
        }
        for (let i = 0; i < this.#dcbWxButton.length; i++) {
            if (this.Nexrad.LevelsEnabled == null || this.Nexrad.LevelsEnabled.length <= i)
                break;
            this.#dcbWxButton[i].Active = this.Nexrad.LevelsEnabled[i];
            if (this.Nexrad.LevelsAvailable == null || this.Nexrad.LevelsAvailable.length <= i)
                break;
            this.#dcbWxButton[i].Text = this.Nexrad.LevelsAvailable[i] ? "WX" + (i + 1) + "\r\nAVL" : "WX" + (i + 1) + "\r\n ";
            this.#dcbWxButton[i].BackColorActive = this.Nexrad.LevelsAvailable[i] ? Color.SlateBlue : Color.Green;
            this.#dcbWxButton[i].BackColorInactive = this.Nexrad.LevelsAvailable[i] ? Color.DarkSlateBlue : Color.FromArgb(0, 80, 0);
        }
        this.#dcbLdrDirButton.Text = "LDR DIR\r\n" + LeaderDirectionName(this.CurrentPrefSet.OwnedDataBlockPosition); // C# enum→name (port enum is numeric)
        this.#dcbLdrLenButton.Text = "LDR LEN\r\n" + this.CurrentPrefSet.LeaderLength;
        this.#dcbSiteButton.Text = "SITE\r\n" + (this.#radar.Name ?? ""); // C# string+null = "" (JS would give "null")
        this.#dcbDcbTopButton.Active = this.#dcb.Location === DCBLocation.Top;
        this.#dcbDcbBottomButton.Active = this.#dcb.Location === DCBLocation.Bottom;
        this.#dcbDcbLeftButton.Active = this.#dcb.Location === DCBLocation.Left;
        this.#dcbDcbRightButton.Active = this.#dcb.Location === DCBLocation.Right;
        this.#dcbHistoryNumButton.Text = "HISTORY\r\n" + this.CurrentPrefSet.HistoryNum;
        this.#dcbHistoryRateButton.Text = "H_RATE\r\n" + this.CurrentPrefSet.HistoryRate;
        this.#dcbPtlLengthButton.Text = "PTL\r\nLNTH\r\n" + this.CurrentPrefSet.PTLLength;
        this.#dcbPtlOwnButton.Active = this.CurrentPrefSet.PTLOwn;
        this.#dcbPtlAllButton.Active = this.CurrentPrefSet.PTLAll;
        this.#briteDCBbutton.Text = "DCB " + this.CurrentPrefSet.Brightness.DCB;
        this.#briteBKCbutton.Text = "BKC " + this.CurrentPrefSet.Brightness.Background;
        this.#briteMPAbutton.Text = "MPA " + this.CurrentPrefSet.Brightness.MapA;
        this.#briteMPBbutton.Text = "MPB " + this.CurrentPrefSet.Brightness.MapB;
        this.#briteFDBbutton.Text = "FDB " + this.CurrentPrefSet.Brightness.FullDataBlocks;
        this.#briteLSTbutton.Text = "LST " + this.CurrentPrefSet.Brightness.Lists;
        this.#britePOSbutton.Text = "POS " + this.CurrentPrefSet.Brightness.PositionSymbols;
        this.#briteLDBbutton.Text = "LDB " + this.CurrentPrefSet.Brightness.LimitedDataBlocks;
        this.#briteOTHbutton.Text = "OTH " + this.CurrentPrefSet.Brightness.OtherFDBs;
        this.#briteTLSbutton.Text = "TLS " + this.CurrentPrefSet.Brightness.Tools;
        this.#briteRRbutton.Text = "RR " + this.CurrentPrefSet.Brightness.RangeRings;
        this.#briteCMPbutton.Text = "CMP " + this.CurrentPrefSet.Brightness.Compass;
        this.#briteBCNbutton.Text = "BCN " + this.CurrentPrefSet.Brightness.BeaconTargets;
        this.#britePRIbutton.Text = "PRI " + this.CurrentPrefSet.Brightness.PrimaryTargets;
        this.#briteHSTbutton.Text = "HST " + this.CurrentPrefSet.Brightness.History;
        this.#briteWXbutton.Text = "WX " + this.CurrentPrefSet.Brightness.Weather;
        this.#briteWXCbutton.Text = "WXC " + this.CurrentPrefSet.Brightness.WeatherContrast;
    }

    // render-loop transform matrices (C# private; public here — referenced via this.* across methods)
    geoToScreen;    // Matrix4
    rotscale;       // Matrix4
    arscale;        // Matrix4
    pixeltransform; // Matrix4
    #centeredlast = false; // private bool

    dataBlockOffset = 0; dataBlockDiagonalOffset = 0; dataBlockOffsetScale = 0; // float

    Window_RenderFrame(sender, e) { // (object sender, FrameEventArgs e)
        let state = Mouse.GetState();
        let mousecurrent = new Vector4(state.X, state.Y, 0, 1);
        if (!this.#centeredlast) {
            this.mousemove = Vector4.Sub(mousecurrent, this.mouseprev); // mousecurrent - mouseprev
            if (this.InvertMouse) {
                this.mousemove.scaleEq(-1); // mousemove *= -1
            }
        }
        this.#centeredlast = this.#centeredmouse;
        this.#centeredmouse = false;
        this.ProcessMouse();

        this.mouseprev = mousecurrent;
        this.DeleteTextures();

        if (this.#window.WindowState === WindowState.Minimized)
            return;
        this.#aspect_ratio = this.#window.ClientSize.Width / this.#window.ClientSize.Height;
        this.#pixelScale = this.#window.ClientSize.Width < this.#window.ClientSize.Height ? 2 / this.#window.ClientSize.Width : 2 / this.#window.ClientSize.Height;
        let mtrans = Matrix4.CreateTranslation(-this.#ScreenCenterPoint.Longitude, -this.#ScreenCenterPoint.Latitude, 0.0);
        let mscale = Matrix4.CreateScale((60 / this.#scale) * Math.cos(MathHelper.DegreesToRadians(this.#ScreenCenterPoint.Latitude)), (60 / this.#scale), 1.0);
        let mrot = Matrix4.CreateRotationZ(MathHelper.DegreesToRadians(this.ScreenRotation));
        this.geoToScreen = mtrans.mul(mscale).mul(mrot); // mtrans * mscale * mrot
        this.rotscale = mscale.mul(mrot).Inverted(); // (mscale * mrot).Inverted()
        this.pixeltransform = Matrix4.CreateTranslation(-this.#window.ClientSize.Width / 2, -this.#window.ClientSize.Height / 2, 0);
        this.pixeltransform = this.pixeltransform.mul(Matrix4.CreateScale(2 / this.#window.ClientSize.Width, -2 / this.#window.ClientSize.Height, 1.0)); // pixeltransform *= ...
        this.dataBlockOffsetScale = this.Font.Height * this.#pixelScale;
        this.dataBlockOffset = (0.5 + this.CurrentPrefSet.LeaderLength) * this.dataBlockOffsetScale;
        this.dataBlockDiagonalOffset = (this.dataBlockOffset * Math.sqrt(2)) / 2;
        GL.ClearColor(RadarWindow.AdjustedColor(this.BackColor, this.CurrentPrefSet.Brightness.Background));
        GL.Clear(ClearBufferMask.ColorBufferBit);
        GL.Enable(EnableCap.Blend);
        GL.BlendEquation(BlendEquationMode.FuncAdd);
        GL.BlendFunc(BlendingFactor.SrcAlpha, BlendingFactor.OneMinusSrcAlpha);
        GL.LoadIdentity();
        GL.PushMatrix();
        if (this.#window.ClientSize.Width < this.#window.ClientSize.Height) {
            GL.Scale(1.0, this.#aspect_ratio, 1.0);
            this.arscale = Matrix4.CreateScale(1 / this.#aspect_ratio, 1.0, 1.0);
            this.pixeltransform = this.pixeltransform.mul(Matrix4.CreateScale(1, 1 / this.#aspect_ratio, 1));
        }
        else if (this.#window.ClientSize.Width > this.#window.ClientSize.Height) {
            GL.Scale(1 / this.#aspect_ratio, 1.0, 1.0);
            this.arscale = Matrix4.CreateScale(1.0, this.#aspect_ratio, 1.0);
            this.pixeltransform = this.pixeltransform.mul(Matrix4.CreateScale(this.#aspect_ratio, 1, 1));
        }
        else {
            this.arscale = Matrix4.Identity;
        }
        if (!this.#hidewx) {
            this.DrawNexrad();
        }
        this.DrawRangeRings();
        this.DrawVideoMapLines();
        this.DrawStatic();
        this.DrawCompass();
        this.DrawRBLs();
        this.UpdateDCB();
        this.#dcb.Draw(this.#window.ClientSize.Width, this.#window.ClientSize.Height, this.pixeltransform, this.CurrentPrefSet.Brightness.DCB); // ref pixeltransform (JS objects are by-reference)
        if (this.ATPA.Active) {
            this.ATPA.Calculate(RadarWindow.Aircraft, this.#radar);
            this.DrawATPAVolumes();
        }
        if (this.MSAW.Active) {
            this.MSAW.Calculate(RadarWindow.Aircraft, this.#radar);
            if (this.DrawAllMSAWVolumes)
                this.DrawMSAWVolumes();
        }
        this.#sounds.SetMsaw(this.MSAWSound && this.MSAW.Active && this.MSAW.UnacknowledgedAlert);
        if (this.ConflictAlert.Active) {
            this.ConflictAlert.Calculate(RadarWindow.Aircraft, this.#radar);
            if (this.DrawAllCASuppressionVolumes)
                this.DrawCASuppressionVolumes();
        }
        this.#sounds.SetConflictAlert(this.ConflictAlertSound && this.ConflictAlert.Active && this.ConflictAlert.UnacknowledgedAlert);
        let anyUnackedSpc;
        // lock (Aircraft)
        anyUnackedSpc = RadarWindow.Aircraft.some(x => !x.Deleted && x.HasUnacknowledgedSpc); // Aircraft.Any(...)
        this.#sounds.SetSpecialCode(anyUnackedSpc);
        this.GenerateTargets();
        this.DrawTargets();
        this.DrawMinSeps();
        GL.PopMatrix();
        GL.Flush();
        this.#window.SwapBuffers();
        this.#fps = Math.trunc(1 / e.Time); // (int)(1f / e.Time)
        if (this.UseADSBCallsigns || this.UseADSBCallsignsAssociated || this.UseADSBCallsigns1200 || this.#adsbService != null) {
            // lock (Aircraft)
            for (const ac of RadarWindow.Aircraft)
                this.ADSBtoFlightPlanCallsign(ac);
        }
        this.#oldar = this.#aspect_ratio;
    }
    mouseprev = Vector4.Zero;  // Vector4
    mousemove = Vector4.Zero;  // Vector4
    #mousescrollcount = 0;     // int

    ProcessMouse() {
        let button = (this.activeDcbButton instanceof DCBAdjustmentButton) ? this.activeDcbButton : null; // activeDcbButton as DCBAdjustmentButton
        if (button != null) {
            let mousethreshold = 20;
            if ((this.mousemove.Y >= 0) === (this.#mousescrollcount >= 0) || (this.mousemove.Y <= 0) === (this.#mousescrollcount <= 0)) {
                this.#mousescrollcount += Math.trunc(this.mousemove.Y); // (int)mousemove.Y
            }
            else {
                this.#mousescrollcount = 0;
            }
            if (button === this.#dcbPlaceCntrButton) {
                let centervec = new Vector4(this.#ScreenCenterPoint.Longitude, this.#ScreenCenterPoint.Latitude, 0, 1);
                let mousevec = Vector4.Transform(this.mousemove, this.pixeltransform); // mousemove * pixeltransform
                mousevec.mulEq(this.geoToScreen.Inverted()); // mousevec *= geoToScreen.Inverted()
                mousevec.scaleEq(0.5); // mousevec *= 0.5f
                centervec.addEq(mousevec); // centervec += mousevec
                this.CurrentPrefSet.ScreenCenterPoint = new GeoPoint(centervec.Y, centervec.X);
                this.CurrentPrefSet.ScopeCentered = false;
            }
            else if (button === this.#dcbHistoryNumButton) {
                let d = 0;
                if (this.#mousescrollcount > mousethreshold)
                    d = 1;
                else if (this.#mousescrollcount < -mousethreshold)
                    d = -1;

                let newnum = this.CurrentPrefSet.HistoryNum + d;
                if (newnum > 10) {
                    this.CurrentPrefSet.HistoryNum = 10;
                }
                else if (newnum < 0) {
                    this.CurrentPrefSet.HistoryNum = 0;
                }
                else {
                    this.CurrentPrefSet.HistoryNum = newnum;
                }
            }
            else if (button === this.#dcbHistoryRateButton) {
                let d = 0;
                if (this.#mousescrollcount > mousethreshold)
                    d = 0.5;
                else if (this.#mousescrollcount < -mousethreshold)
                    d = -0.5;

                let newnum = this.CurrentPrefSet.HistoryRate + d;
                if (newnum > 4.5) {
                    this.CurrentPrefSet.HistoryRate = 4.5;
                }
                else if (newnum < 0) {
                    this.CurrentPrefSet.HistoryRate = 0;
                }
                else {
                    this.CurrentPrefSet.HistoryRate = newnum;
                }
            }
            else if (button === this.#dcbLdrLenButton) {
                let d = 0;
                if (this.#mousescrollcount > mousethreshold)
                    d = 1;
                else if (this.#mousescrollcount < -mousethreshold)
                    d = -1;

                let newnum = this.CurrentPrefSet.LeaderLength + d;
                if (newnum > 8) {
                    this.CurrentPrefSet.LeaderLength = 8;
                }
                else if (newnum < 0) {
                    this.CurrentPrefSet.LeaderLength = 0;
                }
                else {
                    this.CurrentPrefSet.LeaderLength = newnum;
                }
            }
            else if (button === this.#dcbPtlLengthButton) {
                let d = 0;
                if (this.#mousescrollcount > mousethreshold)
                    d = 0.5;
                else if (this.#mousescrollcount < -mousethreshold)
                    d = -0.5;

                let newnum = this.CurrentPrefSet.PTLLength + d;
                if (newnum > 5) {
                    this.CurrentPrefSet.PTLLength = 5;
                }
                else if (newnum < 0) {
                    this.CurrentPrefSet.PTLLength = 0;
                }
                else {
                    this.CurrentPrefSet.PTLLength = newnum;
                }
            }
            else if (button === this.#dcbRangeButton) {
                let d = 0;
                if (this.#mousescrollcount > mousethreshold)
                    d = 1;
                else if (this.#mousescrollcount < -mousethreshold)
                    d = -1;

                let newnum = this.CurrentPrefSet.Range + d;
                if (newnum > 512) {
                    this.CurrentPrefSet.Range = 512;
                }
                else if (newnum < 6) {
                    this.CurrentPrefSet.Range = 6;
                }
                else {
                    this.CurrentPrefSet.Range = Math.trunc(newnum); // (int)newnum
                }
            }
            else if (button === this.#briteDCBbutton) {
                let d = 0;
                if (this.#mousescrollcount > mousethreshold) d = 1;
                else if (this.#mousescrollcount < -mousethreshold) d = -1;
                let step = 5; let max = 100; let min = 25;
                let newnum = this.CurrentPrefSet.Brightness.DCB + (d * step);
                if (newnum > max) this.CurrentPrefSet.Brightness.DCB = max;
                else if (newnum < min) this.CurrentPrefSet.Brightness.DCB = min;
                else this.CurrentPrefSet.Brightness.DCB = newnum;
            }
            else if (button === this.#briteBKCbutton) {
                let d = 0;
                if (this.#mousescrollcount > mousethreshold) d = 1;
                else if (this.#mousescrollcount < -mousethreshold) d = -1;
                let step = 5; let max = 100; let min = 0;
                let newnum = this.CurrentPrefSet.Brightness.Background + (d * step);
                if (newnum > max) this.CurrentPrefSet.Brightness.Background = max;
                else if (newnum < min) this.CurrentPrefSet.Brightness.Background = min;
                else this.CurrentPrefSet.Brightness.Background = newnum;
            }
            else if (button === this.#briteMPAbutton) {
                let d = 0;
                if (this.#mousescrollcount > mousethreshold) d = 1;
                else if (this.#mousescrollcount < -mousethreshold) d = -1;
                let step = 5; let max = 100; let min = 5;
                let newnum = this.CurrentPrefSet.Brightness.MapA + (d * step);
                if (newnum > max) this.CurrentPrefSet.Brightness.MapA = max;
                else if (newnum < min) this.CurrentPrefSet.Brightness.MapA = min;
                else this.CurrentPrefSet.Brightness.MapA = newnum;
            }
            else if (button === this.#briteMPBbutton) {
                let d = 0;
                if (this.#mousescrollcount > mousethreshold) d = 1;
                else if (this.#mousescrollcount < -mousethreshold) d = -1;
                let step = 5; let max = 100; let min = 5;
                let newnum = this.CurrentPrefSet.Brightness.MapB + (d * step);
                if (newnum > max) this.CurrentPrefSet.Brightness.MapB = max;
                else if (newnum < min) this.CurrentPrefSet.Brightness.MapB = min;
                else this.CurrentPrefSet.Brightness.MapB = newnum;
            }
            else if (button === this.#briteFDBbutton) {
                let d = 0;
                if (this.#mousescrollcount > mousethreshold) d = 1;
                else if (this.#mousescrollcount < -mousethreshold) d = -1;
                let step = 5; let max = 100; let min = 0;
                let newnum = this.CurrentPrefSet.Brightness.FullDataBlocks + (d * step);
                if (newnum > max) this.CurrentPrefSet.Brightness.FullDataBlocks = max;
                else if (newnum < min) this.CurrentPrefSet.Brightness.FullDataBlocks = min;
                else this.CurrentPrefSet.Brightness.FullDataBlocks = newnum;
            }
            else if (button === this.#briteLSTbutton) {
                let d = 0;
                if (this.#mousescrollcount > mousethreshold) d = 1;
                else if (this.#mousescrollcount < -mousethreshold) d = -1;
                let step = 5; let max = 100; let min = 25;
                let newnum = this.CurrentPrefSet.Brightness.Lists + (d * step);
                if (newnum > max) this.CurrentPrefSet.Brightness.Lists = max;
                else if (newnum < min) this.CurrentPrefSet.Brightness.Lists = min;
                else this.CurrentPrefSet.Brightness.Lists = newnum;
            }
            else if (button === this.#britePOSbutton) {
                let d = 0;
                if (this.#mousescrollcount > mousethreshold) d = 1;
                else if (this.#mousescrollcount < -mousethreshold) d = -1;
                let step = 5; let max = 100; let min = 0;
                let newnum = this.CurrentPrefSet.Brightness.PositionSymbols + (d * step);
                if (newnum > max) this.CurrentPrefSet.Brightness.PositionSymbols = max;
                else if (newnum < min) this.CurrentPrefSet.Brightness.PositionSymbols = min;
                else this.CurrentPrefSet.Brightness.PositionSymbols = newnum;
            }
            else if (button === this.#briteLDBbutton) {
                let d = 0;
                if (this.#mousescrollcount > mousethreshold) d = 1;
                else if (this.#mousescrollcount < -mousethreshold) d = -1;
                let step = 5; let max = 100; let min = 0;
                let newnum = this.CurrentPrefSet.Brightness.LimitedDataBlocks + (d * step);
                if (newnum > max) this.CurrentPrefSet.Brightness.LimitedDataBlocks = max;
                else if (newnum < min) this.CurrentPrefSet.Brightness.LimitedDataBlocks = min;
                else this.CurrentPrefSet.Brightness.LimitedDataBlocks = newnum;
            }
            else if (button === this.#briteOTHbutton) {
                let d = 0;
                if (this.#mousescrollcount > mousethreshold) d = 1;
                else if (this.#mousescrollcount < -mousethreshold) d = -1;
                let step = 5; let max = 100; let min = 0;
                let newnum = this.CurrentPrefSet.Brightness.OtherFDBs + (d * step);
                if (newnum > max) this.CurrentPrefSet.Brightness.OtherFDBs = max;
                else if (newnum < min) this.CurrentPrefSet.Brightness.OtherFDBs = min;
                else this.CurrentPrefSet.Brightness.OtherFDBs = newnum;
            }
            else if (button === this.#briteTLSbutton) {
                let d = 0;
                if (this.#mousescrollcount > mousethreshold) d = 1;
                else if (this.#mousescrollcount < -mousethreshold) d = -1;
                let step = 5; let max = 100; let min = 0;
                let newnum = this.CurrentPrefSet.Brightness.Tools + (d * step);
                if (newnum > max) this.CurrentPrefSet.Brightness.Tools = max;
                else if (newnum < min) this.CurrentPrefSet.Brightness.Tools = min;
                else this.CurrentPrefSet.Brightness.Tools = newnum;
            }
            else if (button === this.#briteRRbutton) {
                let d = 0;
                if (this.#mousescrollcount > mousethreshold) d = 1;
                else if (this.#mousescrollcount < -mousethreshold) d = -1;
                let step = 5; let max = 100; let min = 0;
                let newnum = this.CurrentPrefSet.Brightness.RangeRings + (d * step);
                if (newnum > max) this.CurrentPrefSet.Brightness.RangeRings = max;
                else if (newnum < min) this.CurrentPrefSet.Brightness.RangeRings = min;
                else this.CurrentPrefSet.Brightness.RangeRings = newnum;
            }
            else if (button === this.#briteCMPbutton) {
                let d = 0;
                if (this.#mousescrollcount > mousethreshold) d = 1;
                else if (this.#mousescrollcount < -mousethreshold) d = -1;
                let step = 5; let max = 100; let min = 0;
                let newnum = this.CurrentPrefSet.Brightness.Compass + (d * step);
                if (newnum > max) this.CurrentPrefSet.Brightness.Compass = max;
                else if (newnum < min) this.CurrentPrefSet.Brightness.Compass = min;
                else this.CurrentPrefSet.Brightness.Compass = newnum;
            }
            else if (button === this.#briteBCNbutton) {
                let d = 0;
                if (this.#mousescrollcount > mousethreshold) d = 1;
                else if (this.#mousescrollcount < -mousethreshold) d = -1;
                let step = 5; let max = 100; let min = 0;
                let newnum = this.CurrentPrefSet.Brightness.BeaconTargets + (d * step);
                if (newnum > max) this.CurrentPrefSet.Brightness.BeaconTargets = max;
                else if (newnum < min) this.CurrentPrefSet.Brightness.BeaconTargets = min;
                else this.CurrentPrefSet.Brightness.BeaconTargets = newnum;
            }
            else if (button === this.#britePRIbutton) {
                let d = 0;
                if (this.#mousescrollcount > mousethreshold) d = 1;
                else if (this.#mousescrollcount < -mousethreshold) d = -1;
                let step = 5; let max = 100; let min = 0;
                let newnum = this.CurrentPrefSet.Brightness.PrimaryTargets + (d * step);
                if (newnum > max) this.CurrentPrefSet.Brightness.PrimaryTargets = max;
                else if (newnum < min) this.CurrentPrefSet.Brightness.PrimaryTargets = min;
                else this.CurrentPrefSet.Brightness.PrimaryTargets = newnum;
            }
            else if (button === this.#briteHSTbutton) {
                let d = 0;
                if (this.#mousescrollcount > mousethreshold) d = 1;
                else if (this.#mousescrollcount < -mousethreshold) d = -1;
                let step = 5; let max = 100; let min = 0;
                let newnum = this.CurrentPrefSet.Brightness.History + (d * step);
                if (newnum > max) this.CurrentPrefSet.Brightness.History = max;
                else if (newnum < min) this.CurrentPrefSet.Brightness.History = min;
                else this.CurrentPrefSet.Brightness.History = newnum;
            }
            else if (button === this.#briteWXbutton) {
                let d = 0;
                if (this.#mousescrollcount > mousethreshold) d = 1;
                else if (this.#mousescrollcount < -mousethreshold) d = -1;
                let step = 5; let max = 100; let min = 5;
                let newnum = this.CurrentPrefSet.Brightness.Weather + (d * step);
                if (newnum > max) this.CurrentPrefSet.Brightness.Weather = max;
                else if (newnum < min) this.CurrentPrefSet.Brightness.Weather = min;
                else this.CurrentPrefSet.Brightness.Weather = newnum;
            }
            else if (button === this.#briteWXCbutton) {
                let d = 0;
                if (this.#mousescrollcount > mousethreshold) d = 1;
                else if (this.#mousescrollcount < -mousethreshold) d = -1;
                let step = 5; let max = 100; let min = 5;
                let newnum = this.CurrentPrefSet.Brightness.WeatherContrast + (d * step);
                if (newnum > max) this.CurrentPrefSet.Brightness.WeatherContrast = max;
                else if (newnum < min) this.CurrentPrefSet.Brightness.WeatherContrast = min;
                else this.CurrentPrefSet.Brightness.WeatherContrast = newnum;
            }

            else if (button === this.#dcbRRButton) {
                let d = 0;
                if (this.#mousescrollcount > mousethreshold)
                    d = 1;
                else if (this.#mousescrollcount < -mousethreshold)
                    d = -1;

                if (d !== 0) {
                    switch (this.CurrentPrefSet.RangeRingSpacing) {
                        case 2: if (d > 0) { this.CurrentPrefSet.RangeRingSpacing = 5; break; } else { this.CurrentPrefSet.RangeRingSpacing = 2; break; } // 2 when d>0 -> 5; else default
                        case 5:
                            if (d > 0) this.CurrentPrefSet.RangeRingSpacing = 10; // 5 when d>0
                            else if (d < 0) this.CurrentPrefSet.RangeRingSpacing = 2; // 5 when d<0
                            break;
                        case 10:
                            if (d > 0) this.CurrentPrefSet.RangeRingSpacing = 20; // 10 when d>0
                            else if (d < 0) this.CurrentPrefSet.RangeRingSpacing = 5; // 10 when d<0
                            break;
                        case 20:
                            if (d < 0) this.CurrentPrefSet.RangeRingSpacing = 10; // 20 when d<0
                            // 20 when d>0: no change
                            break;
                        default:
                            this.CurrentPrefSet.RangeRingSpacing = 2;
                            break;
                    }
                }
            }
            if (this.#mousescrollcount > mousethreshold)
                button.OnAdjustUp(null);
            else if (this.#mousescrollcount < -mousethreshold)
                button.OnAdjustDown(null);

            if (Math.abs(this.#mousescrollcount) > mousethreshold)
                this.#mousescrollcount = 0;
            if (this.activeDcbButton !== this.#dcbPlaceCntrButton) {
                let clientOrigin = this.#window.PointToScreen(new Point(0, 0));
                let relativeloc = new Point(clientOrigin.X + this.activeDcbButton.DrawnBounds.X, clientOrigin.Y + this.activeDcbButton.DrawnBounds.Y);
                Cursor.Clip = new Rectangle(relativeloc, this.activeDcbButton.DrawnBounds.Size);
            }
            this.CenterMouse();
        }
    }

    CenterMouse() {
        if (this.#centeredlast)
            return;
        let clip = this.#window.Bounds; // Rectangle clip = window.Bounds
        if (this.activeDcbButton != null && this.activeDcbButton.constructor === DCBAdjustmentButton && this.activeDcbButton !== this.#dcbPlaceCntrButton)
            clip = Cursor.Clip;
        let mousecenter = new Point(clip.Location.X + Math.trunc(clip.Width / 2), clip.Location.Y + Math.trunc(clip.Height / 2));
        Mouse.SetPosition(mousecenter.X, mousecenter.Y);
        this.#centeredmouse = true;
    }

    GeoToScreenPoint(geoPoint) { // PointF GeoToScreenPoint(GeoPoint geoPoint)
        let vec = new Vector4(geoPoint.Longitude, geoPoint.Latitude, 0.0, 1.0);

        vec.mulEq(this.geoToScreen); // vec *= geoToScreen
        return new PointF(vec.X, vec.Y);
    }

    GeoToPixel(geoPoint) { // Point GeoToPixel(GeoPoint geoPoint)
        let vec = new Vector4(geoPoint.Longitude, geoPoint.Latitude, 0, 1);
        vec.mulEq(this.geoToScreen);
        vec.mulEq(this.pixeltransform.Inverted());
        return new Point(Math.trunc(vec.X), Math.trunc(vec.Y)); // (int)vec.X, (int)vec.Y
    }

    // C# overloads ScreenToGeoPoint(PointF) [NDC coords] and ScreenToGeoPoint(Point) [pixel coords];
    // merged and dispatched on the argument's runtime type (Point vs PointF are distinct shim classes).
    ScreenToGeoPoint(Point_) {
        if (Point_ instanceof Point) { // private GeoPoint ScreenToGeoPoint(Point Point)
            let vec = new Vector4(Point_.X, Point_.Y, 0.0, 1.0);
            vec.mulEq(this.pixeltransform);
            vec.mulEq(this.geoToScreen.Inverted());
            return new GeoPoint(vec.Y, vec.X);
            return this.ScreenToGeoPoint(this.LocationFromScreenPoint(Point_)); // (dead code, kept 1:1)
        }
        else { // private GeoPoint ScreenToGeoPoint(PointF Point)
            let vec = new Vector4(Point_.X, Point_.Y, 0.0, 1.0);
            vec.mulEq(this.geoToScreen.Inverted());
            return new GeoPoint(vec.Y, vec.X);
            // (dead code below, kept 1:1)
            let r = Math.sqrt(Math.pow(Point_.X, 2) + Math.pow(Point_.Y, 2));
            let angle = Math.atan(Point_.Y / Point_.X);
            if (Point_.X < 0)
                angle += Math.PI;
            let bearing = 90 - (angle * 180 / Math.PI) + this.ScreenRotation;
            let distance = r * this.#scale;
            return this.#ScreenCenterPoint.FromPoint(distance, bearing);
        }
    }

    #cmp_labels = new Array(36); // TransparentLabel[36]
    #cmp_ar = 0; // float
    DrawCompass() {
        if (this.CurrentPrefSet.Brightness.Compass === 0)
            return;
        let color = RadarWindow.AdjustedColor(Color.FromArgb(140, 140, 140), this.CurrentPrefSet.Brightness.Compass);
        let linelength = 15 * this.#pixelScale;
        let w = this.arscale.Column1.Length - this.#pixelScale;
        let h = this.arscale.Column0.Length - this.#pixelScale;
        GL.PushMatrix();
        if (!this.#dcb.Visible) {

        }
        else if (this.#dcb.Location === DCBLocation.Left || this.#dcb.Location === DCBLocation.Right) {
            w -= this.#dcb.Size * this.#pixelScale / 2;
            if (this.#dcb.Location === DCBLocation.Left) {
                GL.Translate(this.#dcb.Size / 2 * this.#pixelScale, 0, 0);
            }
            else {
                GL.Translate(-this.#dcb.Size / 2 * this.#pixelScale, 0, 0);
            }
        }
        else {
            h -= this.#dcb.Size * this.#pixelScale / 2;
            if (this.#dcb.Location === DCBLocation.Top) {
                GL.Translate(0, -this.#dcb.Size / 2 * this.#pixelScale, 0);
            }
            else {
                GL.Translate(0, this.#dcb.Size / 2 * this.#pixelScale, 0);
            }
        }
        let aspect_ratio = w / h;
        this.DrawLine(new PointF(w, -h), new PointF(-w, -h), color);
        this.DrawLine(new PointF(-w, -h), new PointF(-w, h), color);
        this.DrawLine(new PointF(-w, h), new PointF(w, h), color);
        this.DrawLine(new PointF(w, h), new PointF(w, -h), color);
        let atan = MathHelper.RadiansToDegrees(Math.atan(aspect_ratio));
        let i;
        let h1 = h - linelength;
        let w1 = w - linelength;
        let hr = (h1 / h);
        let wr = (w1 / w);
        for (i = 0; i < atan; i += 5) {
            let x = Math.tan(MathHelper.DegreesToRadians(i)) * h;
            let x1 = x * hr;
            this.DrawLine(new PointF(x, h), new PointF(x1, h1), color);
            this.DrawLine(new PointF(-x, h), new PointF(-x1, h1), color);
            this.DrawLine(new PointF(x, -h), new PointF(x1, -h1), color);
            this.DrawLine(new PointF(-x, -h), new PointF(-x1, -h1), color);
            let line = Math.trunc(i / 10); // (i / 10) integer division
            if (i / 10 === line) {
                if (this.#cmp_labels[line] == null) {
                    this.#cmp_labels[line] = Object.assign(new TransparentLabel(), { Font: this.Font, Text: i.toString(), ForeColor: color });
                    this.#cmp_labels[line + 18] = Object.assign(new TransparentLabel(), { Font: this.Font, Text: (i + 180).toString(), ForeColor: color });
                    if (line > 0) {
                        this.#cmp_labels[36 - line] = Object.assign(new TransparentLabel(), { Font: this.Font, Text: (360 - i).toString(), ForeColor: color });
                        this.#cmp_labels[18 - line] = Object.assign(new TransparentLabel(), { Font: this.Font, Text: (180 - i).toString(), ForeColor: color });
                    }
                    else {
                        this.#cmp_labels[line].Text = "360";
                    }
                }
                this.#cmp_labels[line].ForeColor = color;
                this.#cmp_labels[line + 18].ForeColor = color;
                this.DrawLabel(this.#cmp_labels[line]);
                this.DrawLabel(this.#cmp_labels[line + 18]);
                this.#cmp_labels[line].CenterOnPoint(new PointF(x1, h1 - this.#cmp_labels[line].SizeF.Height));
                this.#cmp_labels[line + 18].CenterOnPoint(new PointF(-x1, -h1 + this.#cmp_labels[line].SizeF.Height));
                if (line > 0) {
                    this.#cmp_labels[18 - line].ForeColor = color;
                    this.#cmp_labels[36 - line].ForeColor = color;
                    this.DrawLabel(this.#cmp_labels[18 - line]);
                    this.DrawLabel(this.#cmp_labels[36 - line]);
                    this.#cmp_labels[18 - line].CenterOnPoint(new PointF(x1, this.#cmp_labels[line].SizeF.Height - h1));
                    this.#cmp_labels[36 - line].CenterOnPoint(new PointF(-x1, h1 - this.#cmp_labels[line].SizeF.Height));
                }
            }
        }
        for (; i <= 90; i += 5) {
            let y = Math.tan(MathHelper.DegreesToRadians(90 - i)) * w;
            let y1 = y * wr;
            this.DrawLine(new PointF(w, y), new PointF(w1, y1), color);
            this.DrawLine(new PointF(-w, y), new PointF(-w1, y1), color);
            this.DrawLine(new PointF(w, -y), new PointF(w1, -y1), color);
            this.DrawLine(new PointF(-w, -y), new PointF(-w1, -y1), color);
            let line = Math.trunc(i / 10);
            if (i / 10 === line) {
                if (this.#cmp_labels[line] == null) {
                    this.#cmp_labels[line] = Object.assign(new TransparentLabel(), { Font: this.Font, Text: i.toString(), ForeColor: color });
                    this.#cmp_labels[line + 18] = Object.assign(new TransparentLabel(), { Font: this.Font, Text: (i + 180).toString(), ForeColor: color });
                    this.#cmp_labels[36 - line] = Object.assign(new TransparentLabel(), { Font: this.Font, Text: (360 - i).toString(), ForeColor: color });
                    this.#cmp_labels[18 - line] = Object.assign(new TransparentLabel(), { Font: this.Font, Text: (180 - i).toString(), ForeColor: color });
                }
                this.#cmp_labels[line].ForeColor = color;
                this.#cmp_labels[line + 18].ForeColor = color;
                this.DrawLabel(this.#cmp_labels[line]);
                this.DrawLabel(this.#cmp_labels[line + 18]);
                this.#cmp_labels[line].CenterOnPoint(new PointF(w1 - this.#cmp_labels[line].SizeF.Width, y1));
                this.#cmp_labels[line + 18].CenterOnPoint(new PointF(this.#cmp_labels[line].SizeF.Width - w1, -y1));
                if (line > 0) {
                    this.#cmp_labels[18 - line].ForeColor = color;
                    this.#cmp_labels[36 - line].ForeColor = color;
                    this.DrawLabel(this.#cmp_labels[18 - line]);
                    this.DrawLabel(this.#cmp_labels[36 - line]);
                    this.#cmp_labels[36 - line].CenterOnPoint(new PointF(this.#cmp_labels[line].SizeF.Width - w1, y1));
                    this.#cmp_labels[18 - line].CenterOnPoint(new PointF(w1 - this.#cmp_labels[line].SizeF.Width, -y1));
                }
            }
        }
        GL.PopMatrix();
        if (this.#cmp_ar !== aspect_ratio) {
            this.#cmp_ar = aspect_ratio;
            for (const label of this.#cmp_labels) {
                label.ForceRedraw();
            }
        }
        //for (int l = 0; l < 36; l++) { … } (commented in source)
    }
    DrawATPAVolumes() {
        for (const volume of this.ATPA.Volumes.filter(v => v.Draw)) {
            let one, two, three, four; // GeoPoint
            one = volume.RunwayThreshold.FromPoint(volume.WidthLeft / 6076, volume.TrueHeading - 90);
            two = one.FromPoint(volume.Length, volume.TrueHeading + 180);
            three = two.FromPoint((volume.WidthLeft / 6076) + (volume.WidthRight / 6076), volume.TrueHeading + 90);
            four = volume.RunwayThreshold.FromPoint(volume.WidthRight / 6076, volume.TrueHeading + 90);
            let l1, l2, l3, l4; // Line
            l1 = new Line(one, two);
            l2 = new Line(two, three);
            l3 = new Line(three, four);
            l4 = new Line(four, one);
            this.DrawLine(l1, Color.Aqua);
            this.DrawLine(l2, Color.Aqua);
            this.DrawLine(l3, Color.Aqua);
            this.DrawLine(l4, Color.Aqua);
        }
    }
    DrawMSAWVolumes() {
        let volumes; // List<MSAWVolume>
        // lock (MSAW.Volumes)
        volumes = this.MSAW.Volumes.filter(v => v.Draw || this.DrawAllMSAWVolumes);
        for (const volume of volumes)
            this.DrawMSAWVolumeOutline(volume, Color.Red);
        let suppression; // List<MSAWVolume>
        // lock (MSAW.SuppressionVolumes)
        suppression = this.MSAW.SuppressionVolumes.filter(v => v.Draw || this.DrawAllMSAWVolumes);
        for (const volume of suppression)
            this.DrawMSAWVolumeOutline(volume, Color.Lime);
    }
    DrawMSAWVolumeOutline(volume, color) { // (MSAWVolume volume, Color color)
        let pts = volume.Points;
        if (pts == null || pts.length < 2)
            return;
        for (let i = 0; i < pts.length; i++) {
            let a = pts[i];
            let b = pts[(i + 1) % pts.length];
            this.DrawLine(new Line(a, b), color);
        }
    }

    DrawCASuppressionVolumes() {
        let volumes; // List<CASuppressionVolume>
        // lock (ConflictAlert.SuppressionVolumes)
        volumes = this.ConflictAlert.SuppressionVolumes.filter(v => v.Draw || this.DrawAllCASuppressionVolumes);
        for (const v of volumes) {
            if (v.RunwayThreshold == null)
                continue;
            let centerline = (v.TrueHeading + 180) % 360;
            let nearLeft = v.RunwayThreshold.FromPoint(v.HalfWidth, centerline - 90);
            let nearRight = v.RunwayThreshold.FromPoint(v.HalfWidth, centerline + 90);
            let farCenter = v.RunwayThreshold.FromPoint(v.Length, centerline);
            let farLeft = farCenter.FromPoint(v.HalfWidth, centerline - 90);
            let farRight = farCenter.FromPoint(v.HalfWidth, centerline + 90);
            this.DrawLine(new Line(nearLeft, farLeft), Color.Yellow);
            this.DrawLine(new Line(farLeft, farRight), Color.Yellow);
            this.DrawLine(new Line(farRight, nearRight), Color.Yellow);
            this.DrawLine(new Line(nearRight, nearLeft), Color.Yellow);
        }
    }
    DrawMinSeps() {
        let seps; // List<MinSep>
        // lock (minSeps)
        seps = [...this.#minSeps];
        for (const minsep of seps) {
            if (minsep.Line1.End1 != null && minsep.Line2.End1 != null &&
                minsep.Line1.End2 != null && minsep.Line2.End2 != null) {
                this.DrawLine(minsep.Line1, RadarWindow.AdjustedColor(this.RBLColor, this.CurrentPrefSet.Brightness.Tools));
                this.DrawLine(minsep.Line2, RadarWindow.AdjustedColor(this.RBLColor, this.CurrentPrefSet.Brightness.Tools));
                let point1 = this.GeoToScreenPoint(minsep.Line1.End2);
                let point2 = this.GeoToScreenPoint(minsep.Line2.End2);
                this.DrawCircle(point1.X, point1.Y, 4 * this.#pixelScale, 1, 3, RadarWindow.AdjustedColor(this.RBLColor, this.CurrentPrefSet.Brightness.Tools), true);
                this.DrawCircle(point2.X, point2.Y, 4 * this.#pixelScale, 1, 3, RadarWindow.AdjustedColor(this.RBLColor, this.CurrentPrefSet.Brightness.Tools), true);
            }
            if (minsep.SepLine.End1 != null && minsep.SepLine.End2 != null) {
                this.DrawLine(minsep.SepLine, RadarWindow.AdjustedColor(this.RBLColor, this.CurrentPrefSet.Brightness.Tools));
            }
            else
                continue;
            if (minsep.SepLine.MidPoint == null)
                continue;
            let labelloc = this.GeoToScreenPoint(minsep.SepLine.MidPoint);
            if (minsep.MinSepDistance != null)
                minsep.Label.Text = this.#toFixedPad(minsep.MinSepDistance, 1, 2) + " NM"; // ((double)MinSepDistance).ToString("0.00")
            if (minsep.NoXing === true)
                minsep.Label.Text += "\r\nNO XING";
            minsep.Label.ForeColor = RadarWindow.AdjustedColor(this.RBLColor, this.CurrentPrefSet.Brightness.Tools);
            minsep.Label.Font = this.Font;
            minsep.Label.CenterOnPoint(labelloc);
            this.DrawLabel(minsep.Label);
        }
    }
    DrawRBLs() {
        let lines; // List<RangeBearingLine>
        // lock (rangeBearingLines)
        lines = [...this.#rangeBearingLines];
        for (const line of lines) {
            let index = this.#rangeBearingLines.indexOf(line) + 1;
            if (line.End == null || (line.End.X === 0 && line.End.Y === 0))
                return;
            if (line.StartPlane != null) {
                line.Start = line.StartPlane.LocationF;
                line.StartGeo = line.StartPlane.SweptLocation(this.#radar);
                line.Line.End1 = line.StartPlane.SweptLocation(this.#radar);
            }
            else if (line.StartGeo != null) {
                line.Start = this.GeoToScreenPoint(line.StartGeo); // (GeoPoint)line.StartGeo
                line.Line.End1 = line.StartGeo;
            }
            else {
                return;
            }

            if (line.EndPlane != null) {
                line.End = line.EndPlane.LocationF;
                line.EndGeo = line.EndPlane.SweptLocation(this.#radar);
                line.Line.End2 = line.EndPlane.SweptLocation(this.#radar);
            }
            else if (line.EndGeo != null) {
                line.End = this.GeoToScreenPoint(line.EndGeo); // (GeoPoint)line.EndGeo
                line.Line.End2 = line.EndGeo;
            }

            this.DrawLine(line.Start, line.End, RadarWindow.AdjustedColor(this.RBLColor, this.CurrentPrefSet.Brightness.Tools));
            line.Label.ForeColor = RadarWindow.AdjustedColor(this.RBLColor, this.CurrentPrefSet.Brightness.Tools);
            line.Label.LocationF = line.End;
            let bearing = 0;
            let range = 0;
            if (line.EndGeo != null) {
                bearing = line.StartGeo.BearingTo(line.EndGeo) - this.ScreenRotation;
                if (bearing === 0)
                    bearing = 360;
                range = line.StartGeo.DistanceTo(line.EndGeo);
            }
            else {
                let tempEndGeo = this.ScreenToGeoPoint(line.End);
                bearing = line.StartGeo.BearingTo(tempEndGeo) - this.ScreenRotation;
                if (bearing === 0)
                    bearing = 360;
                range = line.StartGeo.DistanceTo(tempEndGeo);
            }
            bearing = Math.trunc((bearing + 720.5) % 360); // (int)((bearing + 720.5) % 360)
            if ((line.StartPlane != null && line.EndPlane == null) || (line.StartPlane == null && line.EndPlane != null)) {
                let plane; // Aircraft
                if (line.StartPlane == null)
                    plane = line.EndPlane;
                else
                    plane = line.StartPlane;
                let traversalTime = range * 60 / plane.GroundSpeed;
                let time;
                if (traversalTime - Math.trunc(traversalTime) >= 0.5)
                    time = Math.trunc(traversalTime) + 1;
                else
                    time = Math.trunc(traversalTime);
                line.Label.Text = `${this.#padNum(bearing, 3)}/${this.#toFixedPad(range, 1, 2)}/${time}-${index}`; // "{0}/{1}/{3}-{2}"
            }
            else
                line.Label.Text = `${this.#padNum(bearing, 3)}/${this.#toFixedPad(range, 1, 2)}-${index}`; // "{0}/{1}-{2}"
            this.DrawLabel(line.Label);
        }
    }
    DrawStatic() {
        this.RenderPreview();
        this.RenderStatus();
        this.RenderLACAMCIList();
        this.RenderSSAAlertCodes();
    }
    GetActiveSpcCodes(red, yellow) { // (out string[] red, out string[] yellow) → holder objects {value}
        let acs; // List<Aircraft>
        // lock (Aircraft)
        acs = RadarWindow.Aircraft.filter(x => !x.Deleted);
        // SPC codes active anywhere in the system (CA/LA live in the LA/CA/MCI list).
        let redOrder = ["HJ", "RF", "EM", "LL", "MI"];
        let yellowOrder = ["OD", "ME", "MF", "LN"];
        red.value = redOrder.filter(c => acs.some(a => a.ActiveRedCodes.includes(c)));
        yellow.value = yellowOrder.filter(c => acs.some(a => a.ActiveYellowCodes.includes(c)));
    }
    RenderSSAAlertCodes() {
        let red = { value: [] }, yellow = { value: [] }; // out var
        this.GetActiveSpcCodes(red, yellow);
        if (red.value.length === 0 && yellow.value.length === 0)
            return;
        let redText = red.value.join(" "); // string.Join(" ", red)
        let yellowText = yellow.value.join(" ");
        if (red.value.length > 0 && yellow.value.length > 0)
            redText += " ";
        this.#SSAAlertRed.Font = this.Font;
        this.#SSAAlertYellow.Font = this.Font;
        this.#SSAAlertRed.Text = redText;
        this.#SSAAlertYellow.Text = yellowText;
        this.#SSAAlertRed.ForeColor = RadarWindow.AdjustedColor(this.DataBlockEmergencyColor, this.CurrentPrefSet.Brightness.Lists);
        this.#SSAAlertYellow.ForeColor = RadarWindow.AdjustedColor(Color.Yellow, this.CurrentPrefSet.Brightness.Lists);
        // Size now so placement is correct the same frame.
        this.#SSAAlertRed.Measure(this.#pixelScale);
        this.#SSAAlertYellow.Measure(this.#pixelScale);
        // The line directly below the clock (the reserved blank line in RenderStatus).
        let lineHeight = Math.max(this.#SSAAlertRed.SizeF.Height, this.#SSAAlertYellow.SizeF.Height);
        let y = this.StatusLocation.Y - (2 * lineHeight);
        if (!(redText == null || redText === "")) {
            this.#SSAAlertRed.LocationF = new PointF(this.StatusLocation.X, y);
            this.DrawLabel(this.#SSAAlertRed);
        }
        if (!(yellowText == null || yellowText === "")) {
            this.#SSAAlertYellow.LocationF = new PointF(this.StatusLocation.X + this.#SSAAlertRed.SizeF.Width, y);
            this.DrawLabel(this.#SSAAlertYellow);
        }
    }
    Window_Load(sender, e) { // (object sender, EventArgs e)
        if (this.#isScreenSaver) {
            this.#window.WindowState = WindowState.Fullscreen;
            this.#window.CursorVisible = false;
        }
        this.StartReceivers();
        this.SetupDCB();
        this.LoadVideoMapFile(); // async → fire-and-forget (C# void)
    }
    Window_Closing(sender, e) { // (object sender, CancelEventArgs e)
        //System.Xml.Serialization.XmlSerializer x = new ...(this.GetType());
        this.StopReceivers();
    }

    ShowRangeRings = true;                          // public bool (C# @248)
    RangeRingColor = Color.FromArgb(140, 140, 140); // public Color (C# @63)
    SaveSettings(path) { // public void SaveSettings(string path)
        let settingsxml = "";
        try {
            settingsxml = new XmlSerializer(RadarWindow).Serialize(this); // XmlSerializer<RadarWindow>.Serialize(this)
            if (settingsxml == null || settingsxml.length === 0) {
                console.log("There was a problem serializing the settings"); // MessageBox.Show
                return;
            }
            // ADAPTATION: StreamWriter(path).Write(...) has no browser equivalent (no arbitrary path write).
            // XmlSerializer.WriteToFile (if provided by the host) triggers a download; else log.
            if (typeof XmlSerializer.WriteToFile === "function") XmlSerializer.WriteToFile(path, settingsxml);
            else console.log(`[SaveSettings] ${path} (${settingsxml.length} bytes)`);
        }
        catch (ex) {
            console.log(ex.message); // MessageBox.Show(ex.Message, …)
        }
    }

    DrawRangeRings() {
        if (!this.ShowRangeRings)
            return;
        /* … dead code kept out (bearing/x/y calc) … */
        let distance = this.#ScreenCenterPoint.DistanceTo(this.#RangeRingCenter);
        let rrr = (this.#aspect_ratio > 1 ? this.CurrentPrefSet.Range * 1.414 * this.#aspect_ratio : this.CurrentPrefSet.Range * 1.414 / this.#aspect_ratio) + distance;
        let x = this.#RangeRingCenter.Longitude;
        let y = this.#RangeRingCenter.Latitude;
        let latfactor = Math.cos(MathHelper.DegreesToRadians(this.#ScreenCenterPoint.Latitude));
        GL.PushMatrix();
        GL.MultMatrix(this.geoToScreen); // MultMatrix(ref geoToScreen)

        for (let i = this.CurrentPrefSet.RangeRingSpacing; i <= rrr && this.CurrentPrefSet.RangeRingSpacing > 0; i += this.CurrentPrefSet.RangeRingSpacing) {
            this.DrawCircle(x, y, (i / 60) / latfactor, latfactor, 1000, RadarWindow.AdjustedColor(this.RangeRingColor, this.CurrentPrefSet.Brightness.RangeRings));
        }
        GL.PopMatrix();
    }

    // C# overloads DrawCircle(double cx,cy,r,aspect,segs,color,fill) and DrawCircle(GeoPoint,radius,color,fill)
    // merged; dispatched on whether the first arg is a GeoPoint.
    DrawCircle(a, b, c, d, e, f, g) {
        if (a instanceof GeoPoint) { // DrawCircle(GeoPoint Location, float radius, Color color, bool fill=false)
            let Location = a, radius = b, color = c, fill = (d === undefined ? false : d);
            let LocationF = this.GeoToScreenPoint(Location);
            let x = LocationF.X;
            let y = LocationF.Y;
            let r = radius / this.#scale;
            this.DrawCircle(x, y, r, 1, 100, color, fill);
            return;
        }
        // DrawCircle(double cx, double cy, double r, double aspect_ratio, int num_segments, Color color, bool fill=false)
        let cx = a, cy = b, r = c, aspect_ratio = d, num_segments = e, color = f, fill = (g === undefined ? false : g);
        GL.Begin(fill ? PrimitiveType.Polygon : PrimitiveType.LineLoop);
        GL.Color4(color);
        for (let ii = 0; ii < num_segments; ii++) {
            let theta = 2.0 * Math.PI * ii / num_segments;
            let x = r * Math.cos(theta);
            let y = r * Math.sin(theta) * aspect_ratio;

            GL.Vertex2(x + cx, y + cy);
        }
        GL.End();
    }
    DrawTPA(plane) { // (Aircraft plane)
        if (plane.Location == null)
            return;
        if (plane.ATPAStatus === ATPAStatus.Caution || plane.ATPAStatus === ATPAStatus.Alert) {
            switch (plane.ATPAStatus) {
                case ATPAStatus.Caution:
                    if (plane.PositionInd === this.ThisPositionIndicator || plane.ATPAVolume.TcpDisplay.some(x => x.TCP === this.ThisPositionIndicator)) { // when guard
                        if (plane.ATPACone == null)
                            plane.ATPACone = new TPACone(plane, plane.ATPARequiredMileage, this.ATPACautionColor, this.Font, true, plane.ATPATrackToLeader);
                        else {
                            plane.ATPACone.Miles = plane.ATPARequiredMileage;
                            plane.ATPACone.Color = this.ATPACautionColor;
                            plane.ATPACone.Track = plane.ATPATrackToLeader;
                        }
                    }
                    break;
                case ATPAStatus.Alert:
                    if (plane.PositionInd === this.ThisPositionIndicator || plane.ATPAVolume.TcpDisplay.some(x => x.TCP === this.ThisPositionIndicator)) { // when guard
                        if (plane.ATPACone == null)
                            plane.ATPACone = new TPACone(plane, plane.ATPARequiredMileage, this.ATPAAlertColor, this.Font, true, plane.ATPATrackToLeader);
                        else {
                            plane.ATPACone.Miles = plane.ATPARequiredMileage;
                            plane.ATPACone.Color = this.ATPAAlertColor;
                            plane.ATPACone.Track = plane.ATPATrackToLeader;
                        }
                    }
                    break;
            }
            this.DrawATPACone(plane);
        }
        if (plane.TPA == null) {
            if (((plane.PositionInd === this.ThisPositionIndicator && this.DrawATPAMonitorCones) ||
                plane.ATPAVolume.TcpDisplay.some(x => x.TCP === this.ThisPositionIndicator && x.ConeType === ATPAStatus.Monitor))
                && plane.ATPAStatus === ATPAStatus.Monitor && plane.ATPATrackToLeader != null && plane.ATPARequiredMileage != null) {
                if (plane.ATPACone == null)
                    plane.ATPACone = new TPACone(plane, plane.ATPARequiredMileage, this.TPAColor, this.Font, true, plane.ATPATrackToLeader);
                else {
                    plane.ATPACone.Miles = plane.ATPARequiredMileage;
                    plane.ATPACone.Color = this.TPAColor;
                    plane.ATPACone.Track = plane.ATPATrackToLeader;
                }
                this.DrawATPACone(plane);
            }

            return;
        }
        else if (plane.TPA.Type === TPAType.JRing) {
            //DrawCircle(plane.SweptLocation, (float)plane.TPA.Miles, plane.TPA.Color, false);
            this.DrawJRing(plane);
        }
        else if (plane.TPA.Type === TPAType.PCone) {
            this.DrawPCone(plane);
        }
        return;
    }

    DrawJRing(plane) { // (Aircraft plane)
        let location = this.GeoToScreenPoint(plane.SweptLocation(this.#radar));
        let x = RadarWindow.RoundUpToNearest(location.X, this.#pixelScale);
        let y = RadarWindow.RoundUpToNearest(location.Y, this.#pixelScale);

        if (plane.TPA.Miles < 10) {
            plane.TPA.Label.Text = String(plane.TPA.Miles); // Miles.ToString()
        }
        else {
            plane.TPA.Label.Text = String(Math.trunc(plane.TPA.Miles)); // ((int)Miles).ToString()
        }
        let labellocation; // PointF
        let circlesize = plane.TPA.Miles / this.#scale;
        let angle;
        let ldr; // LeaderDirection
        if (plane.LDRDirection != null)
            ldr = plane.LDRDirection; // LDRDirection.Value
        else if (plane.PositionInd === this.ThisPositionIndicator) // owned LDR direction
            ldr = this.CurrentPrefSet.OwnedDataBlockPosition;
        else if (!plane.Associated) // Unassociated LDR direction
            ldr = this.CurrentPrefSet.UnassociatedDataBlockPosition;
        else
            ldr = this.CurrentPrefSet.UnownedDataBlockPosition;

        switch (ldr) {
            case LeaderDirection.N:
                angle = Math.PI;
                break;
            case LeaderDirection.NW:
                angle = Math.PI * .75;
                break;
            case LeaderDirection.W:
                angle = Math.PI * .5;
                break;
            case LeaderDirection.SW:
                angle = Math.PI * .25;
                break;
            case LeaderDirection.S:
                angle = 0;
                break;
            case LeaderDirection.SE:
                angle = Math.PI * 1.75;
                break;
            case LeaderDirection.E:
                angle = Math.PI * 1.5;
                break;
            case LeaderDirection.NE:
                angle = Math.PI * 1.25;
                break;
            default:
                angle = 0;
                break;
        }


        let labelsize = Math.sqrt(Math.pow(plane.TPA.Label.Width, 2) + Math.pow(plane.TPA.Label.Height, 2));
        labelsize *= this.#pixelScale;
        labelsize /= 2;
        labellocation = new PointF((Math.sin(angle)) * (circlesize - labelsize), (Math.cos(angle) * (circlesize - labelsize)));
        plane.TPA.Label.CenterOnPoint(labellocation);
        GL.Translate(x, y, 0.0);
        GL.PushMatrix();
        //GL.Rotate(-ScreenRotation, 0, 0, 1);
        this.DrawCircle(0, 0, circlesize, 1, 500, plane.TPA.Color, false);
        plane.TPA.Label.ForeColor = plane.TPA.Color;
        if (plane.TPA.ShowSize)
            this.DrawLabel(plane.TPA.Label);
        GL.PopMatrix();
        GL.Translate(-x, -y, 0.0);
    }

    DrawPCone(planeOrCone) { // C# overloads DrawPCone(Aircraft) and DrawPCone(TPACone) — dispatched by type
        if (planeOrCone instanceof Aircraft) { // DrawPCone(Aircraft plane)
            this.DrawPCone(planeOrCone.TPA); // plane.TPA as TPACone
            return;
        }
        // DrawPCone(TPACone cone) — ported in the next chunk
        this.#DrawPConeCore(planeOrCone);
    }
    #DrawPConeCore(cone) { // private void DrawPCone(TPACone cone)
        if (cone == null || cone.ParentAircraft == null) {
            return;
        }
        let plane = cone.ParentAircraft; // Aircraft
        let track = 0;
        if (cone.Track == null)
            track = plane.SweptTrack(this.#radar);
        else
            track = cone.Track; // (double)cone.Track
        let planelocation = plane.SweptLocation(this.#radar); // GeoPoint
        let location = this.GeoToScreenPoint(planelocation); // PointF
        let textline = new Line(planelocation, planelocation.FromPoint(cone.Miles, track));

        if (cone.Miles < 10) {
            cone.Label.Text = String(cone.Miles); // cone.Miles.ToString()
        }
        else {
            cone.Label.Text = String(Math.trunc(cone.Miles)); // ((int)cone.Miles).ToString()
        }

        let endwidth = this.#pixelScale * this.TPAConeWidth;
        let y = cone.Miles / this.#scale; // (float)cone.Miles / scale
        //var endwidth = y * (2d / 30);
        let x1 = endwidth / 2;
        let x2 = -x1;
        let clearanceWidth = cone.ShowSize ? (Math.sqrt(Math.pow(cone.Label.Height, 2) + Math.pow(cone.Label.Width, 2)) * this.#pixelScale) : 0;
        if (y > clearanceWidth) {
            GL.Translate(location.X, location.Y, 0.0);
            GL.PushMatrix();
            GL.Rotate(-track + this.ScreenRotation, 0, 0, 1);
            let y1 = y / 2 - clearanceWidth / 2;
            let y2 = y1 + clearanceWidth;
            let x3 = x1 * (y1 / y);
            let x4 = -x3;
            let x5 = (y2 / y1) * x3;
            let x6 = -x5;
            let color = RadarWindow.AdjustedColor(cone.Color, this.CurrentPrefSet.Brightness.Tools);
            this.DrawLine(0, 0, x3, y1, color);
            this.DrawLine(0, 0, x4, y1, color);
            this.DrawLine(x5, y2, x1, y, color);
            this.DrawLine(x6, y2, x2, y, color);
            this.DrawLine(x1, y, x2, y, color);
            GL.PopMatrix();
            GL.Translate(-location.X, -location.Y, 0.0);
            cone.Label.ForeColor = cone.Color;
            cone.Label.CenterOnPoint(this.GeoToScreenPoint(textline.MidPoint));
            if (cone.ShowSize)
                this.DrawLabel(cone.Label);
        }
    }
    DrawATPACone(plane) { // (Aircraft plane)
        this.DrawPCone(plane.ATPACone);
    }

    // C# static float RoundUpToNearest(float, float) — body is `return passednumber;` (rounding disabled).
    static RoundUpToNearest(passednumber, roundto) {
        return passednumber;
    }

    DrawVideoMapLines() {
        let lines = new List(); // List<Line>
        if (this.VideoMaps.length > 0) {
            this.CurrentPrefSet.DisplayedMaps = this.VideoMaps.filter(x => x.Visible).map(x => x.Number); // .Select(...).ToArray()
        }
        // Use Max blending so overlapping lines always show the brighter color
        GL.BlendEquation(BlendEquationMode.Max);
        for (const map of this.VideoMaps.filter(map => map.Category === MapCategory.A)) {
            if (this.CurrentPrefSet.DisplayedMaps.includes(map.Number)) {
                lines.AddRange(map.Lines);
            }
        }
        let colora = RadarWindow.AdjustedColor(this.VideoMapLineColor, this.CurrentPrefSet.Brightness.MapA);
        this.DrawLines(lines, colora);
        lines.Clear();
        for (const map of this.VideoMaps.filter(map => map.Category === MapCategory.B)) {
            if (this.CurrentPrefSet.DisplayedMaps.includes(map.Number)) {
                lines.AddRange(map.Lines);
            }
        }
        let colorb = RadarWindow.AdjustedColor(this.VideoMapBLineColor, this.CurrentPrefSet.Brightness.MapB);
        this.DrawLines(lines, colorb);
        // Restore standard alpha blending for subsequent rendering
        GL.BlendEquation(BlendEquationMode.FuncAdd);
    }

    DrawLines(lines, color) { // (List<Line> lines, Color color)
        GL.PushMatrix();
        GL.MultMatrix(this.geoToScreen); // MultMatrix(ref geoToScreen)
        for (const line of lines) {
            this.DrawLine(line.End1.Longitude, line.End1.Latitude, line.End2.Longitude, line.End2.Latitude, color);
        }
        GL.PopMatrix();
    }

    // C# overloads DrawLine(PointF,PointF,Color), DrawLine(Line,Color), DrawLine(double,double,double,double,Color,width=1)
    // merged; dispatched on the first argument's type.
    DrawLine(a, b, c, d, e, f) {
        if (a instanceof Line) { // DrawLine(Line line, Color color) → b = color
            /* dead code kept out (GeoToScreenPoint end1/end2) */
            GL.PushMatrix();
            GL.MultMatrix(this.geoToScreen); // MultMatrix(ref geoToScreen)
            this.DrawLine(a.End1.Longitude, a.End1.Latitude, a.End2.Longitude, a.End2.Latitude, b);
            GL.PopMatrix();
            return;
        }
        if (a instanceof PointF) { // DrawLine(PointF Point1, PointF Point2, Color color) → b=Point2, c=color
            this.DrawLine(a.X, a.Y, b.X, b.Y, c);
            return;
        }
        // DrawLine(double x1, double y1, double x2, double y2, Color color, float width = 1)
        let x1 = a, y1 = b, x2 = c, y2 = d, color = e, width = (f === undefined ? 1 : f);
        //x1 = RoundUpToNearest(x1, pixelScale); … (commented in source)
        GL.Begin(PrimitiveType.Lines);
        GL.LineWidth(width);
        GL.Color4(color);
        GL.Vertex2(x1, y1);
        GL.Vertex2(x2, y2);
        GL.End();
    }

    DrawPolygon(polygon) { // (Polygon polygon)
        //GL.Scale(aspect_ratio, 1.0f, 1.0f);
        GL.Begin(PrimitiveType.Polygon);
        let color = RadarWindow.AdjustedColor(polygon.Color, this.CurrentPrefSet.Brightness.Weather);
        GL.Color4(color);
        for (let i = 0; i < polygon.vertices.length; i++) {
            GL.Vertex2(polygon.vertices[i].X, polygon.vertices[i].Y);
        }
        GL.End();
        if (polygon.StippleColor != null && polygon.StipplePattern.length === 128) {
            GL.Enable(EnableCap.PolygonStipple);
            GL.PolygonStipple(polygon.StipplePattern);
            GL.Begin(PrimitiveType.Polygon);
            let scolor = RadarWindow.AdjustedColor(polygon.StippleColor, this.CurrentPrefSet.Brightness.Weather);
            GL.Color4(scolor);
            for (let i = 0; i < polygon.vertices.length; i++) {
                GL.Vertex2(polygon.vertices[i].X, polygon.vertices[i].Y);
            }
            GL.End();
            GL.Disable(EnableCap.PolygonStipple);
        }
    }

    DrawNexrad() {
        //convert old nexrads list to new nexrad object
        if (this.Nexrads != null && this.Nexrads.length > 0) {
            this.Nexrad = this.Nexrads[0];
            this.Nexrad.ColorTable = new List(); // new List<WXColor>()
            this.Nexrads = null;
        }

        let polygons = this.Nexrad.Polygons();
        GL.PushMatrix();
        GL.MultMatrix(this.geoToScreen); // MultMatrix(ref geoToScreen)

        for (let i = 0; i < polygons.length; i++) {
            if (polygons[i].Color.A > 0)
                this.DrawPolygon(polygons[i]);
        }

        GL.PopMatrix();
    }

    dataBlocks = new List();    // List<TransparentLabel> (referenced by DeletePlane/GenerateDataBlock)
    posIndicators = new List(); // List<TransparentLabel>

    async GenerateDataBlock(aircraft) { // private async Task GenerateDataBlock(Aircraft aircraft)
        // lock (aircraft)
        {
            if (aircraft.Deleted)
                return;
            let oldcolor = aircraft.DataBlock.ForeColor;
            // Alerts/SPCs no longer recolor the tag; they show on a separate red/yellow line above.
            if (aircraft.Marked) {
                aircraft.DataBlock.ForeColor = this.SelectedColor;
                aircraft.DataBlock2.ForeColor = this.SelectedColor;
                aircraft.DataBlock3.ForeColor = this.SelectedColor;
            }
            else if (aircraft.ForceQuickLook) {
                aircraft.DataBlock.ForeColor = this.PointoutColor;
                aircraft.DataBlock2.ForeColor = this.PointoutColor;
                aircraft.DataBlock3.ForeColor = this.PointoutColor;
            }
            else if (aircraft.Owned || aircraft.QuickLookPlus) {
                aircraft.DataBlock.ForeColor = this.OwnedColor;
                aircraft.DataBlock2.ForeColor = this.OwnedColor;
            }
            else if (aircraft.FDB) {
                aircraft.DataBlock.ForeColor = this.DataBlockColor;
                aircraft.DataBlock2.ForeColor = this.DataBlockColor;
            }
            else {
                aircraft.DataBlock.ForeColor = this.LDBColor;
                aircraft.DataBlock2.ForeColor = this.LDBColor;
            }
            aircraft.PositionIndicator.ForeColor = aircraft.DataBlock.ForeColor;
            aircraft.DataBlock3.ForeColor = aircraft.DataBlock.ForeColor;
            aircraft.LdbBeaconCodesInhibited = this.CurrentPrefSet.LdbBeaconCodesInhibited;
            aircraft.RedrawDataBlock(this.#radar);
            let realWidth = aircraft.DataBlock.Width * this.#pixelScale;
            let realHeight = aircraft.DataBlock.Height * this.#pixelScale;

            aircraft.DataBlock.SizeF = new SizeF(realWidth, realHeight);
            aircraft.DataBlock.ParentAircraft = aircraft;
            aircraft.DataBlock2.ParentAircraft = aircraft;
            aircraft.DataBlock3.ParentAircraft = aircraft;
            aircraft.DataBlock.LocationF = this.OffsetDatablockLocation(aircraft);
            aircraft.DataBlock2.LocationF = aircraft.DataBlock.LocationF;
            aircraft.DataBlock3.LocationF = aircraft.DataBlock.LocationF;
            // Alert/SPC line above the data block (red + yellow). Positioned/blinked in the draw loop.
            aircraft.UpdateAlertCodes();
            let redText = aircraft.ActiveRedCodes.join("/"); // string.Join("/", …)
            let yellowText = aircraft.ActiveYellowCodes.join("/");
            if (!(redText == null || redText === "") && !(yellowText == null || yellowText === ""))
                redText += "/"; // connect the two colored segments
            aircraft.AlertLabelRed.Font = this.Font;
            aircraft.AlertLabelYellow.Font = this.Font;
            aircraft.AlertLabelRed.Text = redText;
            aircraft.AlertLabelYellow.Text = yellowText;
            aircraft.AlertLabelRed.ForeColor = this.DataBlockEmergencyColor;
            aircraft.AlertLabelYellow.ForeColor = Color.Yellow;
            aircraft.AlertLabelRed.ParentAircraft = aircraft;
            aircraft.AlertLabelYellow.ParentAircraft = aircraft;
            // Size now (same frame the text changes) so right-alignment doesn't lag a frame.
            aircraft.AlertLabelRed.Measure(this.#pixelScale);
            aircraft.AlertLabelYellow.Measure(this.#pixelScale);
            if (!this.dataBlocks.Contains(aircraft.DataBlock)) {
                // lock (dataBlocks)
                this.dataBlocks.Add(aircraft.DataBlock);
            }
        }
    }

    async GenerateTargetAsync(aircraft) { // private async Task GenerateTargetAsync(Aircraft aircraft)
        if (aircraft === this.#debugPlane)
            void 0; // Console.Write("")
        let extrapolatedpos = aircraft.SweptLocation(this.#radar);
        /* … dead code kept out (bearing/distance/x/y) … */
        if (extrapolatedpos == null)
            return;
        if (aircraft.LastHistoryTimes.has(this.#radar) &&
            (this.#radar.SweptTimes.get(aircraft).getTime() - aircraft.LastHistoryTimes.get(this.#radar).getTime()) / 1000 >= this.CurrentPrefSet.HistoryRate) { // TotalSeconds
            aircraft.TargetReturn.ForeColor = this.HistoryColors[0];
            if (!this.HistoryFade) {
                aircraft.TargetReturn.Fading = false;
                aircraft.TargetReturn.Intensity = 1;
                let lastHistory = aircraft.History.length - 1;
                // lock (aircraft.History)
                {
                    if (aircraft.History[lastHistory] != null)
                        aircraft.History[lastHistory].Dispose();
                    for (let i = lastHistory; i > 0; i--) {
                        aircraft.History[i] = aircraft.History[i - 1];
                        if (aircraft.History[i] == null)
                            continue;
                        if (i >= this.HistoryColors.length)
                            aircraft.History[i].ForeColor = this.HistoryColors[this.HistoryColors.length - 1];
                        else
                            aircraft.History[i].ForeColor = this.HistoryColors[i];
                    }
                }
            }
            else {
                aircraft.TargetReturn.Fading = true;
            }
            let newreturn = new PrimaryReturn();
            aircraft.History[0] = aircraft.TargetReturn;
            aircraft.TargetReturn = newreturn;
            newreturn.ParentAircraft = aircraft;
            newreturn.Fading = this.PrimaryFade;
            newreturn.FadeTime = this.FadeTime;
            newreturn.GeoLocation = extrapolatedpos;
            newreturn.Intensity = 1;
            newreturn.ForeColor = this.ReturnColor;
            aircraft.LastHistoryTimes.set(this.#radar, RadarWindow.CurrentTime);
        }

        if (aircraft.LastMessageTime > this.#addSeconds(RadarWindow.CurrentTime, -this.LostTargetSeconds)) {
            // lock (aircraft)
            aircraft.RedrawTarget(extrapolatedpos, this.#radar);
            aircraft.PTL.End1 = aircraft.SweptLocation(this.#radar);
            let ptldistance = (aircraft.SweptSpeed(this.#radar) / 60) * this.CurrentPrefSet.PTLLength;
            aircraft.PTL.End2 = extrapolatedpos.FromPoint(ptldistance, aircraft.SweptTrack(this.#radar));

            if (this.InFilter(aircraft) ||
                aircraft.Owned || aircraft.QuickLook || aircraft.PendingHandoff === this.ThisPositionIndicator || aircraft.ShowCallsignWithNoSquawk || aircraft.FDB)
                this.GenerateDataBlock(aircraft);
            else if (!aircraft.Owned && !aircraft.FDB)
                // lock (dataBlocks)
                this.dataBlocks.Remove(aircraft.DataBlock);


            let realWidth = aircraft.PositionIndicator.Width * this.#pixelScale;
            let realHeight = aircraft.PositionIndicator.Height * this.#pixelScale;
            aircraft.PositionIndicator.SizeF = new SizeF(realWidth, realHeight);
            let posindlocation = this.GeoToScreenPoint(this.TargetExtentSymbols.PositionSymbolLocation(aircraft, this.#radar)); // instance member (field shadows class)
            aircraft.PositionIndicator.CenterOnPoint(posindlocation);
            if (!(aircraft.PositionInd == null || aircraft.PositionInd === ""))
                aircraft.PositionIndicator.Text = aircraft.PositionInd[aircraft.PositionInd.length - 1]; // PositionInd.Last().ToString()
            if (aircraft.Marked)
                aircraft.PositionIndicator.ForeColor = this.SelectedColor;
            else if (aircraft.Owned)
                aircraft.PositionIndicator.ForeColor = this.OwnedColor;
            else
                aircraft.PositionIndicator.ForeColor = this.DataBlockColor;

            if (!this.posIndicators.Contains(aircraft.PositionIndicator)) {
                // lock (aircraft)
                {
                    if (aircraft.Deleted)
                        return;
                    aircraft.PositionIndicator.ParentAircraft = aircraft;
                    // lock (posIndicators)
                    this.posIndicators.Add(aircraft.PositionIndicator);
                }
            }
            // lock (minSeps)
            {
                for (let mi = 0; mi < this.#minSeps.length; mi++) {
                    let ms = this.#minSeps[mi];
                    if (ms.Plane1 === aircraft || ms.Plane2 === aircraft)
                        ms.CalculateMinSep(this.#radar);
                }
            }
            aircraft.Drawn = true;
        }
        else {
            // lock (dataBlocks)
            this.dataBlocks.Remove(aircraft.DataBlock);
            // lock (posIndicators)
            this.posIndicators.Remove(aircraft.PositionIndicator);
        }
    }
    async ADSBtoFlightPlanCallsigns(aircraft) { // (List<Aircraft> aircraft)
        aircraft.forEach(x => this.ADSBtoFlightPlanCallsign(x));
    }
    async ADSBtoFlightPlanCallsign(aircraft) { // (Aircraft aircraft)
        // LADD backfill: SWIM sets Callsign=Squawk for LADD correlated tracks.
        // Re-apply cached ADSB callsign every frame since SWIM continuously overwrites.
        if (this.#adsbService != null && !this.ADSBSettings.HideLADDCallsigns) {
            let cached = this.#adsbService.GetCachedCallsign(aircraft);
            if (cached != null) {
                aircraft.Callsign = cached;
                aircraft.FlightPlanCallsign = cached;
                return;
            }
        }

        if ((aircraft.FlightPlanCallsign == null || aircraft.FlightPlanCallsign.trim() === "") && !(aircraft.Callsign == null || aircraft.Callsign.trim() === "")) { // IsNullOrWhiteSpace
            let associated = aircraft.Associated;

            // If ADSB service is running and Callsign is a real callsign (not squawk),
            // always fill FlightPlanCallsign — SWIM sometimes leaves FPC empty even when Callsign is set.
            if (this.#adsbService != null && aircraft.Callsign !== aircraft.Squawk) {
                aircraft.FlightPlanCallsign = aircraft.Callsign;
            }
            else if (this.UseADSBCallsigns && !associated && aircraft.Squawk != null && aircraft.Squawk !== "1200") {
                aircraft.FlightPlanCallsign = aircraft.Callsign;
            }
            else if (this.UseADSBCallsigns1200 && !associated && aircraft.Squawk != null && aircraft.Squawk === "1200") {
                aircraft.FlightPlanCallsign = aircraft.Callsign;
            }
            else if (this.UseADSBCallsignsAssociated && associated) {
                aircraft.FlightPlanCallsign = aircraft.Callsign;
            }
        }
    }
    GenerateTarget(aircraft) {
        Task.Run(() => this.GenerateTargetAsync(aircraft));
    }
    #generating = false; // bool generating
    async GenerateTargets() {
        if (this.#generating)
            return;
        this.#generating = true;
        let tasks = new List(); // List<Task> (created but not awaited, as in source)
        let time = RadarWindow.CurrentTime;
        let ac; // Aircraft[]
        // lock (Aircraft)
        {
            ac = [...RadarWindow.Aircraft]; // Aircraft.ToArray()
            this.RadarSites.forEach(x => x.Scan(time));
            if (!this.RadarSites.includes(this.#radar))
                this.#radar.Scan(time);
        }

        for (let i = 0; i < ac.length; i++) {
            let aircraft = ac[i];
            let associated = !((aircraft.PositionInd == null || aircraft.PositionInd === "") || aircraft.PositionInd === "*");
            let qlall = associated && this.QuickLookList.includes("ALL");
            let qlallplus = associated && this.QuickLookList.includes("ALL+");
            if (this.QuickLookList.includes(aircraft.PositionInd) || qlall) {
                aircraft.QuickLookPlus = false;
                aircraft.QuickLook = true;
            }
            else if (this.QuickLookList.includes(aircraft.PositionInd + "+") || qlallplus) {
                aircraft.QuickLook = true;
                aircraft.QuickLookPlus = true;
            }
            else if (this.QuickLook && this.InFilter(aircraft) &&
                aircraft.LastMessageTime >= this.#addSeconds(RadarWindow.CurrentTime, -this.LostTargetSeconds)) {
                aircraft.QuickLook = true;
                aircraft.QuickLookPlus = false;
            }
            else {
                aircraft.QuickLookPlus = false;
                aircraft.QuickLook = false;
            }
            if (aircraft.Location != null)
                this.GenerateTargetAsync(aircraft);
            for (let j = 0; j < aircraft.History.length; j++) {
                let target = aircraft.History[j];
                if (target == null)
                    continue;
                if (target.Intensity < .001) {
                    if (target.ParentAircraft.TargetReturn === target) {
                        // lock (dataBlocks)
                        this.dataBlocks.Remove(target.ParentAircraft.DataBlock);
                        // lock (posIndicators)
                        this.posIndicators.Remove(target.ParentAircraft.PositionIndicator);
                    }
                }
            }
        }
        this.#generating = false;
    }

    // C# overloads OffsetDatablockLocation(Aircraft, LeaderDirection) and OffsetDatablockLocation(Aircraft)
    // merged; the 1-arg form (direction===undefined) resolves the leader direction then calls the 2-arg form.
    OffsetDatablockLocation(thisAircraft, direction) {
        if (direction === undefined) { // private PointF OffsetDatablockLocation(Aircraft thisAircraft)
            let newDirection = this.CurrentPrefSet.UnassociatedDataBlockPosition;
            let oldDirection = this.CurrentPrefSet.UnassociatedDataBlockPosition;
            if (thisAircraft.LDRDirection != null) {
                oldDirection = thisAircraft.LDRDirection; // .Value
                newDirection = thisAircraft.LDRDirection;
            }
            else if (thisAircraft.PositionInd == null) {

            }
            else if (thisAircraft.PositionInd === this.ThisPositionIndicator && thisAircraft.OwnerLeaderDirection != null) {
                oldDirection = thisAircraft.OwnerLeaderDirection; // .Value
                newDirection = thisAircraft.OwnerLeaderDirection;
            }
            else if (thisAircraft.PositionInd === this.ThisPositionIndicator) {
                oldDirection = this.CurrentPrefSet.OwnedDataBlockPosition;
                newDirection = this.CurrentPrefSet.OwnedDataBlockPosition;
            }
            else if (this.CurrentPrefSet.OtherOwnersLeaderDirections.has(thisAircraft.PositionInd)) { // TryGetValue(…, out dir)
                let dir = this.CurrentPrefSet.OtherOwnersLeaderDirections.get(thisAircraft.PositionInd);
                oldDirection = dir;
                newDirection = dir;
            }
            else if (thisAircraft.Associated) {
                oldDirection = this.CurrentPrefSet.UnownedDataBlockPosition;
                newDirection = this.CurrentPrefSet.UnownedDataBlockPosition;
            }

            let blockLocation = this.OffsetDatablockLocation(thisAircraft, newDirection);

            if (this.AutoOffset && thisAircraft.FDB && thisAircraft.LDRDirection == null) {

                let bounds = new RectangleF(blockLocation, thisAircraft.DataBlock.SizeF);
                let minconflicts = 2147483647; // int.MaxValue
                let bestDirection = newDirection;
                let sequence = [0, 2, 6, 7, 1, 3, 5, 4];
                for (let i = 0; i < 8; i++) {
                    let conflictcount = 0;
                    let otherDataBlocks = new List(); // List<TransparentLabel>
                    // lock (dataBlocks)
                    otherDataBlocks.AddRange(this.dataBlocks);
                    let d = newDirection; // (int)newDirection (LeaderDirection is numeric)
                    if (d >= 5) {
                        d--;
                    }
                    d = (d + sequence[i]) % 8;
                    if (d >= 5) {
                        d++;
                    }
                    newDirection = d; // (LeaderDirection)d
                    blockLocation = this.OffsetDatablockLocation(thisAircraft, newDirection);

                    bounds.Location = blockLocation;

                    for (const otherDataBlock of otherDataBlocks) {
                        let otherPlane = otherDataBlock.ParentAircraft;
                        if (thisAircraft !== otherPlane) {
                            let otherBounds = new RectangleF(otherPlane.DataBlock.LocationF, otherPlane.DataBlock.SizeF);

                            if (bounds.IntersectsWith(otherBounds) && otherPlane.FDB) {
                                conflictcount += 2;
                            }
                            if (bounds.IntersectsWith(otherPlane.TargetReturn.BoundsF)) {
                                conflictcount++;
                            }
                            if (thisAircraft.ConnectingLine.IntersectsWith(otherPlane.ConnectingLine) ||
                                thisAircraft.ConnectingLine.IntersectsWith(otherPlane.PositionIndicator.BoundsF) ||
                                thisAircraft.ConnectingLine.IntersectsWith(otherBounds)) {
                                conflictcount += 2;
                            }
                        }
                    }
                    if (conflictcount < minconflicts) {
                        minconflicts = conflictcount;
                        bestDirection = newDirection;
                    }
                    if (conflictcount === 0) {
                        break;
                    }
                    else {

                    }
                }
                if (minconflicts > 0) {
                    newDirection = bestDirection;
                }
                blockLocation = this.OffsetDatablockLocation(thisAircraft, newDirection);
            }

            return blockLocation;
        }

        // private PointF OffsetDatablockLocation(Aircraft thisAircraft, LeaderDirection direction)
        let blockLocation = new PointF();
        blockLocation.X = thisAircraft.LocationF.X;
        blockLocation.Y = thisAircraft.LocationF.Y;

        switch (direction) {
            case LeaderDirection.N:
                blockLocation.Y = thisAircraft.PositionIndicator.BoundsF.Bottom + this.dataBlockOffset;
                break;
            case LeaderDirection.S:
                blockLocation.Y = thisAircraft.PositionIndicator.BoundsF.Top - this.dataBlockOffset;
                break;
            case LeaderDirection.E:
                blockLocation.X = thisAircraft.PositionIndicator.BoundsF.Right + this.dataBlockOffset;
                break;
            case LeaderDirection.W:
                blockLocation.X = thisAircraft.PositionIndicator.BoundsF.Left - this.dataBlockOffset;
                if (thisAircraft.DataBlock.SizeF.Width > thisAircraft.DataBlock2.SizeF.Width &&
                    thisAircraft.DataBlock.SizeF.Width > thisAircraft.DataBlock3.SizeF.Width)
                    blockLocation.X -= thisAircraft.DataBlock.SizeF.Width;
                else if (thisAircraft.DataBlock2.SizeF.Width > thisAircraft.DataBlock3.SizeF.Width)
                    blockLocation.X -= thisAircraft.DataBlock2.SizeF.Width;
                else
                    blockLocation.X -= thisAircraft.DataBlock3.SizeF.Width;
                break;
            case LeaderDirection.NE:
                blockLocation.X = thisAircraft.PositionIndicator.BoundsF.Right + this.dataBlockDiagonalOffset;
                blockLocation.Y = thisAircraft.PositionIndicator.BoundsF.Bottom + this.dataBlockDiagonalOffset;
                break;
            case LeaderDirection.SE:
                blockLocation.X = thisAircraft.PositionIndicator.BoundsF.Right + this.dataBlockDiagonalOffset;
                blockLocation.Y = thisAircraft.PositionIndicator.BoundsF.Top - this.dataBlockDiagonalOffset;
                break;
            case LeaderDirection.NW:
                blockLocation.X = thisAircraft.PositionIndicator.BoundsF.Left - this.dataBlockDiagonalOffset;
                if (thisAircraft.DataBlock.SizeF.Width > thisAircraft.DataBlock2.SizeF.Width &&
                    thisAircraft.DataBlock.SizeF.Width > thisAircraft.DataBlock3.SizeF.Width)
                    blockLocation.X -= thisAircraft.DataBlock.SizeF.Width;
                else if (thisAircraft.DataBlock2.SizeF.Width > thisAircraft.DataBlock3.SizeF.Width)
                    blockLocation.X -= thisAircraft.DataBlock2.SizeF.Width;
                else
                    blockLocation.X -= thisAircraft.DataBlock3.SizeF.Width;
                blockLocation.Y = thisAircraft.PositionIndicator.BoundsF.Bottom + this.dataBlockDiagonalOffset;
                break;
            case LeaderDirection.SW:
                blockLocation.X = thisAircraft.PositionIndicator.BoundsF.Left - this.dataBlockDiagonalOffset;
                if (thisAircraft.DataBlock.SizeF.Width > thisAircraft.DataBlock2.SizeF.Width &&
                    thisAircraft.DataBlock.SizeF.Width > thisAircraft.DataBlock3.SizeF.Width)
                    blockLocation.X -= thisAircraft.DataBlock.SizeF.Width;
                else if (thisAircraft.DataBlock2.SizeF.Width > thisAircraft.DataBlock3.SizeF.Width)
                    blockLocation.X -= thisAircraft.DataBlock2.SizeF.Width;
                else
                    blockLocation.X -= thisAircraft.DataBlock3.SizeF.Width;
                blockLocation.Y = thisAircraft.PositionIndicator.BoundsF.Top - this.dataBlockDiagonalOffset;
                break;
        }

        blockLocation.Y -= this.dataBlockOffsetScale * 2.5;
        let leaderStart = new PointF(thisAircraft.LocationF.X, thisAircraft.LocationF.Y);

        switch (direction) {
            case LeaderDirection.NE:
                leaderStart.Y = thisAircraft.PositionIndicator.BoundsF.Bottom;
                leaderStart.X = thisAircraft.PositionIndicator.BoundsF.Right;
                break;
            case LeaderDirection.N:
                leaderStart.Y = thisAircraft.PositionIndicator.BoundsF.Bottom;
                break;
            case LeaderDirection.NW:
                leaderStart.Y = thisAircraft.PositionIndicator.BoundsF.Bottom;
                leaderStart.X = thisAircraft.PositionIndicator.BoundsF.Left;
                break;
            case LeaderDirection.SE:
                leaderStart.Y = thisAircraft.PositionIndicator.BoundsF.Top;
                leaderStart.X = thisAircraft.PositionIndicator.BoundsF.Right;
                break;
            case LeaderDirection.S:
                leaderStart.Y = thisAircraft.PositionIndicator.BoundsF.Top;
                break;
            case LeaderDirection.SW:
                leaderStart.Y = thisAircraft.PositionIndicator.BoundsF.Top;
                leaderStart.X = thisAircraft.PositionIndicator.BoundsF.Left;
                break;
            case LeaderDirection.E:
                leaderStart.X = thisAircraft.PositionIndicator.BoundsF.Right;
                break;
            case LeaderDirection.W:
                leaderStart.X = thisAircraft.PositionIndicator.BoundsF.Left;
                break;
            default:
                void 0; // Console.Write("wat")
                break;
        }
        if (blockLocation.X < thisAircraft.LocationF.X) {
            if (thisAircraft.DataBlock.SizeF.Width > thisAircraft.DataBlock2.SizeF.Width)
                thisAircraft.ConnectingLine.End = new PointF(blockLocation.X + thisAircraft.DataBlock.SizeF.Width,
                    blockLocation.Y + (this.dataBlockOffsetScale * 2.5));
            else
                thisAircraft.ConnectingLine.End = new PointF(blockLocation.X + thisAircraft.DataBlock2.SizeF.Width,
                    blockLocation.Y + (this.dataBlockOffsetScale * 2.5));
        }
        else {
            thisAircraft.ConnectingLine.End = new PointF(blockLocation.X, blockLocation.Y + (this.dataBlockOffsetScale * 2.5));
        }
        thisAircraft.ConnectingLine.Start = leaderStart;
        if (direction !== thisAircraft.LastDrawnDirection)
            // lock (thisAircraft)
            thisAircraft.RedrawDataBlock(this.#radar, direction);

        return blockLocation;
    }

    // #aircraftGCTimer field already declared (C# `Timer aircraftGCTimer;` @6406 — skipped)

    InFilter(aircraft) { // private bool InFilter(Aircraft aircraft)
        if (!aircraft.Associated)
            return (aircraft.TrueAltitude <= this.MaxAltitude && aircraft.TrueAltitude >= this.MinAltitude);
        return (aircraft.TrueAltitude <= this.MaxAltitudeAssociated && aircraft.TrueAltitude >= this.MinAltitudeAssociated);
    }

    DrawTarget(target) { // private void DrawTarget(PrimaryReturn target)
        if (target == null)
            return;
        if (target.ParentAircraft.Location == null)
            return;
        if ((target.LastDrawnScreenCenter !== this.#ScreenCenterPoint || target.LastDrawnRange !== this.CurrentPrefSet.Range || target.LastDrawnScreenRotation !== this.ScreenRotation) && target.GeoLocation != null) {
            target.LocationF = this.GeoToScreenPoint(target.GeoLocation);
            target.LastDrawnScreenRotation = this.ScreenRotation;
            target.LastDrawnScreenCenter = this.#ScreenCenterPoint;
            target.LastDrawnRange = this.CurrentPrefSet.Range;
            if (target.ParentAircraft != null && target === target.ParentAircraft.TargetReturn) {
                target.ParentAircraft.LocationF = target.LocationF;
            }
        }
        if (target.LocationF.X === 0 || target.LocationF.Y === 0)
            return;
        let history = target !== target.ParentAircraft.TargetReturn;
        if (history) { // history
            if (!this.InFilter(target.ParentAircraft) && !target.ParentAircraft.FDB)
                return;
            if (target.ParentAircraft.History.indexOf(target) >= this.CurrentPrefSet.HistoryNum) // Array.IndexOf
                return;
        }
        let primarycolor = RadarWindow.AdjustedColor(this.ReturnColor, this.CurrentPrefSet.Brightness.PrimaryTargets);
        let beaconcolor = RadarWindow.AdjustedColor(this.BeaconTargetColor, this.CurrentPrefSet.Brightness.BeaconTargets);
        let rt = this.#radar.RadarType;
        if (history)
            rt = RadarType.FUSED;
        let location = target.ParentAircraft.SweptLocation(this.#radar);
        if (location == null)
            return;
        let targetWidth;
        let targetHeight;
        let targetHypotenuse;
        let x1;
        let angle;
        switch (rt) {
            case RadarType.SLANT_RANGE: {
                targetWidth = this.TargetExtentSymbols.TargetWidth(target.ParentAircraft, this.#radar, this.#scale, this.#pixelScale);
                targetHeight = (this.TargetExtentSymbols.SearchTargets.RangeExtent / 32) / this.#scale;
                targetHypotenuse = (Math.sqrt((targetHeight * targetHeight) + (targetWidth * targetWidth)) / 2);
                let beaconoffset = this.TargetExtentSymbols.BeaconTargets.RangeOffset / (32 * this.#scale);
                x1 = (targetWidth / 2);
                let y1 = (targetHeight / 2);
                let x2 = x1 * (this.TargetExtentSymbols.BeaconTargets.AzimuthExtentFactor / 10);
                let y2 = (this.TargetExtentSymbols.BeaconTargets.RangeExtent / 32) / this.#scale;

                target.SizeF = new SizeF(targetHypotenuse * 2, targetHypotenuse * 2);

                GL.PushMatrix();
                angle = (-(location.BearingTo(this.#radar.Location) + 360) % 360) + this.ScreenRotation;
                GL.Translate(target.LocationF.X, target.LocationF.Y, 0.0);
                GL.Rotate(angle, 0.0, 0.0, 1.0);
                GL.Ortho(-1.0, 1.0, -1.0, 1.0, 0.1, 0.0);

                GL.Begin(PrimitiveType.Polygon);

                GL.Color4(primarycolor);
                GL.Vertex2(x1, y1);
                GL.Vertex2(-x1, y1);
                GL.Vertex2(-x1, -y1);
                GL.Vertex2(x1, -y1);
                GL.End();
                if (!target.ParentAircraft.PrimaryOnly && !history) {
                    GL.Begin(PrimitiveType.Polygon);
                    GL.Color4(beaconcolor);
                    GL.Vertex2(x2, y2 - beaconoffset);
                    GL.Vertex2(-x2, y2 - beaconoffset);
                    GL.Vertex2(-x2, -y2 - beaconoffset);
                    GL.Vertex2(x2, -y2 - beaconoffset);
                    GL.End();
                }

                GL.Translate(-target.LocationF.X, -target.LocationF.Y, 0.0);


                GL.PopMatrix();
                break;
            }
            case RadarType.FUSED: {
                let size;
                if (!target.ParentAircraft.PrimaryOnly && !history) {
                    size = this.TargetExtentSymbols.TargetWidth(target.ParentAircraft, this.#radar, this.#scale, this.#pixelScale);
                    target.SizeF = new SizeF(size, size);
                    this.DrawCircle(target.LocationF.X, target.LocationF.Y, size / 2, 1, 30, primarycolor, true);
                }
                else if (!history) {
                    targetWidth = this.TargetExtentSymbols.MultiRadarTargets.UncorrSymbolPlotSize * this.#pixelScale;
                    targetHypotenuse = (Math.sqrt((targetWidth * targetWidth) + (targetWidth * targetWidth)) / 2);
                    x1 = (Math.sqrt(2) * targetHypotenuse);
                    target.SizeF = new SizeF(targetHypotenuse * 2, targetHypotenuse * 2);
                    GL.PushMatrix();

                    angle = 0; // -(float)ScreenRotation;
                    GL.Translate(target.LocationF.X, target.LocationF.Y, 0.0);
                    GL.Rotate(angle, 0.0, 0.0, 1.0);
                    GL.Ortho(-1.0, 1.0, -1.0, 1.0, 0.1, 0.0);
                    GL.Begin(PrimitiveType.Polygon);

                    GL.Color4(RadarWindow.AdjustedColor(this.ReturnColor, this.CurrentPrefSet.Brightness.PrimaryTargets));
                    GL.Vertex2(x1, x1);
                    GL.Vertex2(-x1, x1);
                    GL.Vertex2(-x1, -x1);
                    GL.Vertex2(x1, -x1);


                    GL.End();
                    GL.Translate(-target.LocationF.X, -target.LocationF.Y, 0.0);


                    GL.PopMatrix();
                }
                else {
                    size = this.TargetExtentSymbols.FMATargetSymbols.Radius * this.#pixelScale;
                    target.SizeF = new SizeF(size, size);
                    this.DrawCircle(target.LocationF.X, target.LocationF.Y, size, 1, 30, RadarWindow.AdjustedColor(target.ForeColor, this.CurrentPrefSet.Brightness.History), true);
                }
                break;
            }
        }
    }

    DrawTargets() {
        let aclist; // List<Aircraft>
        let cutoff = this.#addSeconds(RadarWindow.CurrentTime, -this.LostTargetSeconds);
        // lock (Aircraft)
        {
            aclist = new List(); // new List<Aircraft>(Aircraft.Count) — capacity hint dropped
            for (const ac of RadarWindow.Aircraft) {
                if (ac.LastMessageTime > cutoff)
                    aclist.Add(ac);
            }
        }

        // Single pass for ownership, TPA, handoff, flashing, and beaconator updates
        for (let i = 0; i < aclist.length; i++) {
            let x = aclist[i];

            if (x.PositionInd === this.ThisPositionIndicator)
                x.Owned = true;

            if (x.TPA != null || x.ATPAFollowing != null)
                this.DrawTPA(x);

            if (x.PendingHandoff === this.ThisPositionIndicator) {
                if (!(x.Owned && x.DataBlock.Flashing)) {
                    x.Owned = true;
                    x.DataBlock.Flashing = true;
                    x.DataBlock2.Flashing = true;
                }
            }

            if (x.PositionInd === x.PendingHandoff) {
                if (x.PendingHandoff != null)
                    x.PendingHandoff = null;
                if (x.DataBlock.Flashing) {
                    x.DataBlock.Flashing = false;
                    x.DataBlock2.Flashing = false;
                    x.DataBlock3.Flashing = false;
                }
            }

            if (x.DataBlock.Flashing && x.PendingHandoff !== this.ThisPositionIndicator
                && (new Date().getTime() - x.JustTransferredAt.getTime()) > 5000) { // (DateTime.UtcNow - JustTransferredAt) > TimeSpan.FromSeconds(5)
                x.DataBlock.Flashing = false;
                x.DataBlock2.Flashing = false;
                x.DataBlock3.Flashing = false;
            }

            if (x.ShowCallsignWithNoSquawk !== this.#showAllCallsigns && x.LocationF.X !== 0) {
                x.ShowCallsignWithNoSquawk = this.#showAllCallsigns;
                // lock (x)
                x.RedrawDataBlock(this.#radar);
            }
        }

        // Draw history trails and target returns
        for (let i = 0; i < aclist.length; i++) {
            let x = aclist[i];
            if (!x.PrimaryOnly || x.Associated) {
                // lock (x.History)
                {
                    for (let j = x.History.length - 1; j >= 0; j--) {
                        if (x.History[j] != null) {
                            if (x.History[j].ParentAircraft == null)
                                x.History[j].ParentAircraft = x;
                            this.DrawTarget(x.History[j]);
                        }
                    }
                }
            }
        }
        for (let i = 0; i < aclist.length; i++) {
            let x = aclist[i];
            if (x.TargetReturn.ParentAircraft == null)
                x.TargetReturn.ParentAircraft = x;
            this.DrawTarget(x.TargetReturn);
        }

        // Build HashSet for O(1) membership checks
        let acSet = new Set(aclist); // new HashSet<Aircraft>(aclist)

        // lock (posIndicators)
        {
            for (let i = 0; i < this.posIndicators.length; i++) {
                let x = this.posIndicators[i];
                if (!x.ParentAircraft.FDB && acSet.has(x.ParentAircraft))
                    this.DrawLabel(x);
            }
        }
        // lock (dataBlocks)
        {
            // Collect, filter, and sort into a reusable list to avoid allocating per-frame
            let sortedBlocks = new List(); // new List<TransparentLabel>(dataBlocks.Count)
            let toRemove = null; // (List<TransparentLabel>)null
            for (let i = 0; i < this.dataBlocks.length; i++) {
                let block = this.dataBlocks[i];
                if (block.ParentAircraft == null)
                    continue;
                if (!acSet.has(block.ParentAircraft)) {
                    if (toRemove == null) toRemove = new List();
                    toRemove.Add(block);
                    toRemove.Add(block.ParentAircraft.DataBlock2);
                    toRemove.Add(block.ParentAircraft.DataBlock3);
                    continue;
                }
                if (block.ParentAircraft.FDB || block.ParentAircraft.Associated || !block.ParentAircraft.PrimaryOnly)
                    sortedBlocks.Add(block);
            }
            if (toRemove != null) {
                for (let i = 0; i < toRemove.length; i++)
                    this.dataBlocks.Remove(toRemove[i]);
            }
            sortedBlocks.sort((a, b) => { // bool.CompareTo: false(0) < true(1)
                let cmp = Number(a.ParentAircraft.FDB) - Number(b.ParentAircraft.FDB);
                if (cmp !== 0) return cmp;
                return Number(a.ParentAircraft.Owned) - Number(b.ParentAircraft.Owned);
            });
            for (let i = 0; i < sortedBlocks.length; i++) {
                let block = sortedBlocks[i];
                if (block.ParentAircraft === this.#debugPlane)
                    this.#debugPlane = null;
                if (this.CurrentPrefSet.PTLLength > 0 && (block.ParentAircraft.ShowPTL || (block.ParentAircraft.Owned && this.CurrentPrefSet.PTLOwn) || (block.ParentAircraft.FDB && this.CurrentPrefSet.PTLAll))) {
                    this.DrawLine(block.ParentAircraft.PTL, RadarWindow.AdjustedColor(this.RBLColor, this.CurrentPrefSet.Brightness.Tools));
                }
                if (ClockPhase.Phase === 0)
                    this.DrawLabel(block);
                else if (ClockPhase.Phase === 1)
                    this.DrawLabel(block.ParentAircraft.DataBlock2);
                else if (ClockPhase.Phase === 2)
                    this.DrawLabel(block.ParentAircraft.DataBlock3);
                this.DrawAlertLine(block.ParentAircraft);
            }
        }
        // lock (posIndicators)
        {
            for (let i = 0; i < this.posIndicators.length; i++) {
                let x = this.posIndicators[i];
                if (x.ParentAircraft.FDB && acSet.has(x.ParentAircraft))
                    this.DrawLabel(x);
            }
        }
    }
    DrawAlertLine(ac) { // (Aircraft ac)
        if (ac == null || !ac.HasAnyAlertCode)
            return;
        let db = ac.DataBlock;
        let hasRed = !(ac.AlertLabelRed.Text == null || ac.AlertLabelRed.Text === "");
        let hasYellow = !(ac.AlertLabelYellow.Text == null || ac.AlertLabelYellow.Text === "");
        if (!hasRed && !hasYellow)
            return;
        let redW = ac.AlertLabelRed.SizeF.Width;
        let yelW = ac.AlertLabelYellow.SizeF.Width;
        // Sits directly above the first data-block line (LocationF is bottom-left).
        let top = db.LocationF.Y + db.SizeF.Height;
        // Match the data block's justification so the alert stays on the shifted edge.
        let rightAlign = ac.LastDataBlockRightJustified;
        let blockWidth = Math.max(ac.DataBlock.SizeF.Width,
            Math.max(ac.DataBlock2.SizeF.Width, ac.DataBlock3.SizeF.Width));
        let leftX = rightAlign
            ? db.LocationF.X + blockWidth - (redW + yelW)
            : db.LocationF.X;
        // Only CA/LA blink (hidden on phase 1); SPCs and yellow tags stay solid.
        let hideRed = ac.RedAlertBlinks && ClockPhase.Phase === 1;
        if (hasRed && !hideRed) {
            ac.AlertLabelRed.LocationF = new PointF(leftX, top);
            this.DrawLabel(ac.AlertLabelRed);
        }
        if (hasYellow) {
            ac.AlertLabelYellow.LocationF = new PointF(leftX + redW, top);
            this.DrawLabel(ac.AlertLabelYellow);
        }
    }
    DrawLabel(Label) { // private void DrawLabel(TransparentLabel Label)
        // lock (Label)
        {
            let outline = false;
            if (Label.Text == null || Label.Text === "")
                return;
            if (Label.ParentAircraft != null && Label === Label.ParentAircraft.PositionIndicator) {
                outline = true;
            }
            GL.Enable(EnableCap.Texture2D);
            let isNewTexture = Label.TextureID === 0;
            if (isNewTexture)
                Label.TextureID = GL.GenTexture();
            let text_texture = Label.TextureID;
            let color = Label.DrawColor; // Color

            if (Label.Redraw) {
                Label.Font = this.Font;
                let text_bmp = Label.NewTextBitmap(outline); // Bitmap -> OffscreenCanvas
                let realWidth = text_bmp.width * this.#pixelScale;
                let realHeight = text_bmp.height * this.#pixelScale;
                Label.SizeF = new SizeF(realWidth, realHeight);
                GL.BindTexture(TextureTarget.Texture2D, text_texture);
                // ADAPTATION: GDI Bitmap.LockBits/BitmapData/Scan0 → pass the OffscreenCanvas directly to
                // TexImage2D (the Canvas2D GL shim uploads the canvas as the texture; see DCBButton).
                GL.TexImage2D(TextureTarget.Texture2D, 0, PixelInternalFormat.Rgba, text_bmp.width, text_bmp.height, 0,
                    PixelFormat.Bgra, PixelType.UnsignedByte, text_bmp);
                GL.TexParameter(TextureTarget.Texture2D, TextureParameterName.TextureMagFilter, TextureMagFilter.Nearest);
                GL.TexParameter(TextureTarget.Texture2D, TextureParameterName.TextureMinFilter, TextureMinFilter.Nearest);
                GL.TexParameter(TextureTarget.Texture2D, TextureParameterName.TextureWrapS, TextureWrapMode.ClampToEdge);
                GL.TexParameter(TextureTarget.Texture2D, TextureParameterName.TextureWrapT, TextureWrapMode.ClampToEdge);
            }
            if (Label.ParentAircraft != null) {
                if (Label.ParentAircraft.Owned && Label === Label.ParentAircraft.PositionIndicator) {
                    color = RadarWindow.AdjustedColor(Label.DrawColor, this.CurrentPrefSet.Brightness.PositionSymbols);
                }
                else if (Label.ParentAircraft.Owned) {
                    color = RadarWindow.AdjustedColor(Label.DrawColor, this.CurrentPrefSet.Brightness.FullDataBlocks);
                }
                else if (Label.ParentAircraft.FDB) {
                    color = RadarWindow.AdjustedColor(Label.DrawColor, this.CurrentPrefSet.Brightness.OtherFDBs);
                }
                else {
                    color = RadarWindow.AdjustedColor(Label.DrawColor, this.CurrentPrefSet.Brightness.LimitedDataBlocks);
                }
                if (Label.ParentAircraft.LocationF.X !== 0 || Label.ParentAircraft.LocationF.Y !== 0) {
                    if (Label === Label.ParentAircraft.DataBlock) {
                        Label.LocationF = this.OffsetDatablockLocation(Label.ParentAircraft);
                        Label.ParentAircraft.DataBlock2.LocationF = Label.LocationF;
                        Label.ParentAircraft.DataBlock3.LocationF = Label.LocationF;
                    }
                    else if (Label === Label.ParentAircraft.DataBlock2) {
                        Label.ParentAircraft.DataBlock.LocationF = this.OffsetDatablockLocation(Label.ParentAircraft);
                        Label.LocationF = Label.ParentAircraft.DataBlock.LocationF;
                        Label.ParentAircraft.DataBlock3.LocationF = Label.LocationF;
                    }
                    else if (Label === Label.ParentAircraft.DataBlock3) {
                        Label.ParentAircraft.DataBlock.LocationF = this.OffsetDatablockLocation(Label.ParentAircraft);
                        Label.LocationF = Label.ParentAircraft.DataBlock.LocationF;
                        Label.ParentAircraft.DataBlock2.LocationF = Label.LocationF;
                    }
                }

            }

            GL.BindTexture(TextureTarget.Texture2D, text_texture);

            let Location = Label.LocationF;
            let x = RadarWindow.RoundUpToNearest(Location.X, this.#pixelScale);
            let y = RadarWindow.RoundUpToNearest(Location.Y, this.#pixelScale);
            let width = Label.SizeF.Width;
            let height = Label.SizeF.Height;
            let w1 = Label.SizeF.Width + (4 * this.#pixelScale);
            let h1 = Label.SizeF.Height + (4 * this.#pixelScale);
            let x1 = x - (2 * this.#pixelScale);
            let y1 = y - (2 * this.#pixelScale);

            /* black backing quad — commented out in source */

            GL.Begin(PrimitiveType.Quads);
            GL.Color3(color);
            GL.TexCoord2(0, 0);
            GL.Vertex2(x, height + y);
            GL.TexCoord2(1, 0);
            GL.Vertex2(width + x, height + y);
            GL.TexCoord2(1, 1);
            GL.Vertex2(width + x, y);
            GL.TexCoord2(0, 1);
            GL.Vertex2(x, y);
            GL.End();

            GL.BindTexture(TextureTarget.Texture2D, 0);
            GL.Disable(EnableCap.Texture2D);


            GL.Begin(PrimitiveType.Lines);
            GL.Color4(color);
        }
        if (Label.ParentAircraft != null && this.CurrentPrefSet.LeaderLength > 0) {
            if (Label === Label.ParentAircraft.DataBlock || Label === Label.ParentAircraft.DataBlock2 || Label === Label.ParentAircraft.DataBlock3) {
                let line = new ConnectingLineF();
                line = Label.ParentAircraft.ConnectingLine;
                GL.Vertex2(line.Start.X, line.Start.Y);
                GL.Vertex2(line.End.X, line.End.Y);
            }
        }
        GL.End();
    }

    DrawAllScreenObjectBounds() {
        let screenObjects = new List(); // List<IScreenObject>

        for (const item of screenObjects) {
            let bounds = new RectangleF(item.LocationF, item.SizeF);
            this.DrawRectangle(bounds, Color.Gray);
        }
    }

    DrawScreenObjectBounds(screenObject, color) { // (IScreenObject screenObject, Color color)
        this.DrawRectangle(screenObject.BoundsF, color, false);
    }
    DrawRectangle(rectangle, color, fill = false) { // (RectangleF rectangle, Color color, bool fill=false)
        GL.Begin(PrimitiveType.Lines);
        GL.Color4(color);
        GL.Vertex2(rectangle.Left, rectangle.Top);
        GL.Vertex2(rectangle.Right, rectangle.Top);
        GL.Vertex2(rectangle.Right, rectangle.Top);
        GL.Vertex2(rectangle.Right, rectangle.Bottom);
        GL.Vertex2(rectangle.Right, rectangle.Bottom);
        GL.Vertex2(rectangle.Left, rectangle.Bottom);
        GL.Vertex2(rectangle.Left, rectangle.Bottom);
        GL.Vertex2(rectangle.Left, rectangle.Top);
        GL.End();
    }
    // RoundUpToNearest (C# @6927) already ported early (static, identity). C# IScreenObject interface
    // (@6950) is a duck-typed contract — no JS equivalent needed (LocationF/NewLocation/SizeF/BoundsF/
    // ParentAircraft are provided ad hoc by TransparentLabel/PrimaryReturn).

    // ===== RadarWindow.cs FULLY PORTED (6962 / 6962). IScreenObject interface dropped (JS duck-typed). =====
}
