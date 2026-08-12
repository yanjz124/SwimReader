// Ported 1:1 from _source/Aircraft.cs
// namespace DGScope
// using System.Drawing; using DGScope.STARS;
//
// LOGIC ported in full (state, extrapolation, alert-code state machine, Swept* accessors,
// geodesy, handoff/ownership events). RENDERING is DEFERRED:
//   - fields TargetReturn/History/DataBlock*/AlertLabel*/PositionIndicator are WinForms
//     types (PrimaryReturn / TransparentLabel) -> stubbed null (see GL/UI ruling).
//   - methods RedrawDataBlock / OldRedrawDataBlock / RedrawTarget / Dispose manipulate
//     those objects -> stubbed to throw until the rendering ruling lands.
import { GeoPoint } from "./GeoPoint.js";
import { Altitude, AltitudeType } from "./Altitude.js";
import { Line } from "./Line.js";
import { ConnectingLineF } from "./LeaderLine.js";
import { PointF, Color, ContentAlignment } from "./_shims/SystemDrawing.js";
import { EventHandler, EventArgs } from "./_shims/DotNetEvent.js";
import { RadarWindow } from "./RadarWindow.js";
import { PrimaryReturn } from "./PrimaryReturn.js";
import { TransparentLabel } from "./TransparentLabel.js";
import { LeaderDirection } from "./STARS/LeaderDirection.js";

// Guid -> string; Guid.NewGuid() -> crypto.randomUUID(); Guid.Empty -> all-zero string.
const GUID_EMPTY = "00000000-0000-0000-0000-000000000000";
const newGuid = () => globalThis.crypto.randomUUID();
// DateTime.MinValue -> JS minimum Date (used as "never" sentinel).
const MIN_DATE = () => new Date(-8640000000000000);

export class Aircraft { // class Aircraft : IDisposable
    TrackGuid = newGuid();      // Guid
    FlightPlanGuid = GUID_EMPTY; // Guid
    ModeSCode = 0;              // int
    Squawk = null;             // string
    AssignedSquawk = null;     // string
    get Latitude() { return this.Location.Latitude; }   // double =>
    get Longitude() { return this.Location.Longitude; } // double =>
    Callsign = null;           // string
    Deleted = false;           // bool
    ShowPTL = false;           // bool
    Pointout = false;          // bool
    ForceQuickLook = false;    // bool
    get PressureAltitude() { return this.Altitude.PressureAltitude; } // int =>
    get TrueAltitude() { return this.Altitude.TrueAltitude; }         // int =>
    ATPAVolume = null;         // ATPAVolume?
    ATPAFollowing = null;      // Aircraft?
    ATPAMileageNow = null;     // double?
    ATPAMileage24 = null;      // double?
    ATPAMileage45 = null;      // double?
    ATPARequiredMileage = null; // double?
    ATPATrackToLeader = null;  // double?
    ATPAStatus = null;         // ATPAStatus?
    ATPACone = null;           // TPACone?
    #rateofturn = 0;           // private double
    #positionind;              // private string
    get PositionInd() { return this.#positionind; } // string
    set PositionInd(value) {
        if (value !== this.#positionind && this.#pendinghandoff != null && this.#pendinghandoff !== value) {
            this.HandedOff.Invoke(this, new HandoffEventArgs(this, value, this.#pendinghandoff)); // HandedOff?.Invoke
            this.#pendinghandoff = null;
        }
        // Fire Transferred whenever ownership actually changes from one controller to
        // another (ignoring the initial null->value set). (See CRC STARS 5s blink.)
        if (value !== this.#positionind && !(this.#positionind == null || this.#positionind === "")) { // !string.IsNullOrEmpty(positionind)
            this.Transferred.Invoke(this, new HandoffEventArgs(this, value, this.#positionind)); // Transferred?.Invoke
        }
        this.#positionind = value;
    }
    JustTransferredAt = MIN_DATE(); // DateTime  (DateTime.MinValue)
    #pendinghandoff;                // private string
    get PendingHandoff() { return this.#pendinghandoff; } // string
    set PendingHandoff(value) {
        if (value !== this.#pendinghandoff) {
            this.HandoffInitiated.Invoke(this, new HandoffEventArgs(this, value, this.PositionInd)); // HandoffInitiated?.Invoke
            this.#pendinghandoff = value;
        }
    }
    TPA = null;                // TPA
    Altitude = new Altitude(); // Altitude { get; set; } = new Altitude()
    #lastLocationSetTime = new Date();         // private DateTime (initialized to now, not MIN_DATE)
    #lastLocationExtrapolateTime = MIN_DATE(); // private DateTime
    #extrapolatedpos = null;                   // private GeoPoint
    #lastTrackUpdate = MIN_DATE();             // private DateTime
    Location = null;           // GeoPoint { get; private set; }
    LocationF = new PointF();  // PointF
    GroundSpeed = 0;           // int
    Track = 0;                 // int { get; private set; }
    VerticalRate = 0;          // int
    #ident;                    // bool ident
    get Ident() { return this.#ident; } // bool
    set Ident(value) { this.#ident = value; }
    IsOnGround = false;        // bool
    Emergency = false;         // bool
    Alert = false;             // bool
    // MSAW low-altitude alert. LowAltitude is set by the MSAW engine; once the
    // controller slews the track, LowAltitudeAcknowledged silences the tone.
    LowAltitude = false;               // bool
    LowAltitudeAcknowledged = false;   // bool
    // Per-track MSAW processing inhibit (F7 V <slew> / F7 Q <slew>).
    MSAWInhibited = false;             // bool
    // True when MSAW is inhibited for this track for any reason (automatic VFR
    // inhibit or a manual inhibit). Drives the MSAW engine and the "*" after the ID.
    get IsMSAWInhibited() {
        return this.MSAWInhibited || (!(this.FlightRules == null || this.FlightRules === "") && this.FlightRules[0] === 'V');
    }
    ConflictAlert = false;             // bool
    ConflictAlertAcknowledged = false; // bool
    ConflictingTracks = [];            // List<Aircraft> { get; }

    // ---- Special Purpose Codes (SPC) and alert tags ----
    ManualAlertCodes = [];             // List<string> { get; }
    SpcAcknowledged = false;           // bool
    static AssignableSPCs = ["HJ", "RF", "EM", "MI", "LL", "OD", "ME", "MF", "LN"]; // static readonly string[]
    static #RedAlertCodes = new Set(["CA", "LA", "HJ", "RF", "EM", "MI", "LL"]);    // static readonly HashSet<string>
    static #YellowAlertCodes = new Set(["OD", "ME", "MF", "LN"]);                    // static readonly HashSet<string>
    static IsRedAlertCode(code) { return Aircraft.#RedAlertCodes.has(code); }        // static bool =>
    static IsYellowAlertCode(code) { return Aircraft.#YellowAlertCodes.has(code); }  // static bool =>

    // The SPC implied by the actual beacon code, or null. Only these sound.
    get SquawkSPC() { // string
        switch (this.Squawk) {
            case "7500": return "HJ"; // hijack
            case "7600": return "RF"; // radio failure
            case "7700": return "EM"; // emergency
            case "7777": return "MI"; // military intercept
            case "7400": return "LL"; // lost link
            default: return null;
        }
    }

    // Active codes kept in activation order, split by color.
    ActiveRedCodes = [];    // List<string> { get; }
    ActiveYellowCodes = []; // List<string> { get; }
    UpdateAlertCodes() {
        // Reset the SPC acknowledgement once the beacon code is no longer an SPC.
        if (this.SquawkSPC == null)
            this.SpcAcknowledged = false;
        let red = [];
        if (this.ConflictAlert) red.push("CA");
        if (this.LowAltitude) red.push("LA");
        let sq = this.SquawkSPC;
        if (sq != null && !red.includes(sq)) red.push(sq);
        for (const c of this.ManualAlertCodes)
            if (Aircraft.#RedAlertCodes.has(c) && !red.includes(c)) red.push(c);
        let yellow = [];
        for (const c of this.ManualAlertCodes)
            if (Aircraft.#YellowAlertCodes.has(c) && !yellow.includes(c)) yellow.push(c);
        Aircraft.#SyncOrdered(this.ActiveRedCodes, red);
        Aircraft.#SyncOrdered(this.ActiveYellowCodes, yellow);
    }
    static #SyncOrdered(current, active) { // private static void
        // current.RemoveAll(c => !active.Contains(c));
        for (let i = current.length - 1; i >= 0; i--)
            if (!active.includes(current[i])) current.splice(i, 1);
        for (const c of active)
            if (!current.includes(c)) current.push(c);
    }
    get HasAnyAlertCode() { return this.ActiveRedCodes.length > 0 || this.ActiveYellowCodes.length > 0; }
    // Only CA/LA blink (until acknowledged); SPCs and manual tags are solid.
    get RedAlertBlinks() { return (this.ConflictAlert && !this.ConflictAlertAcknowledged) || (this.LowAltitude && !this.LowAltitudeAcknowledged); }
    // The squawk-derived SPC sounds until the track is slewed to acknowledge.
    get HasUnacknowledgedSpc() { return this.SquawkSPC != null && !this.SpcAcknowledged; }

    LastMessageTime = MIN_DATE(); // DateTime
    get LastPositionTime() { return this.#lastLocationSetTime; } // DateTime
    // (rendering) delegate to deferred TargetReturn / DataBlock:
    get TargetColor() { return this.TargetReturn.ForeColor; }        // Color
    set TargetColor(value) { this.TargetReturn.ForeColor = value; }
    get Font() { return this.DataBlock.Font; }                       // Font
    set Font(value) { this.DataBlock.Font = value; }
    PTL = new Line();          // Line
    Destination = null;        // string?
    Scratchpad = null;         // string?
    Type = null;               // string?
    Scratchpad2 = null;        // string?
    FlightRules = null;        // string?
    Runway = null;             // string?
    RequestedAltitude = 0;     // int
    Category = null;           // string?
    FlightPlanCallsign = null; // string
    LastHistoryDrawn = MIN_DATE(); // DateTime
    Drawn = false;             // bool
    #owned = false;            // bool owned
    get Owned() { return this.#owned; } // bool
    set Owned(value) {
        if (value !== this.#owned)
            this.OwnershipChange.Invoke(this, new AircraftEventArgs(this)); // OwnershipChange?.Invoke
        this.#owned = value;
    }
    Marked = false;            // bool
    QuickLook = false;         // bool
    QuickLookPlus = false;     // bool

    LDRDirection = null;       // LeaderDirection?
    OwnerLeaderDirection = null; // LeaderDirection?
    ShowCallsignWithNoSquawk = false; // bool
    LdbBeaconCodesInhibited = false;  // bool
    #_fdb = false;             // bool _fdb
    get FDB() { // bool
        if (this.Owned && !this.QuickLook) this.#_fdb = true;
        else if (this.QuickLook)
            return true;
        else if (this.ForceQuickLook)
            return true;
        return this.#_fdb;
    }
    set FDB(value) {
        let oldvalue = this.#_fdb;
        this.#_fdb = value;
        if (this.QuickLook)
            this.QuickLook = false;
    }
    get Associated() { // bool
        return this.FlightPlanGuid != null && this.FlightPlanGuid !== GUID_EMPTY;
    }
    get PrimaryOnly() { // bool
        return (this.Squawk == null || this.Squawk === "") && this.ModeSCode === 0 && ((this.Altitude == null || this.Altitude.AltitudeType === AltitudeType.Unknown));
        // return ((Altitude == null || Altitude.AltitudeType == AltitudeType.Unknown) && !Associated);  // unreachable in source
    }

    #fdb() { // private bool fdb()
        if (this.Emergency || this.QuickLook) {
            return true;
        }
        else {
            return this.#_fdb;
        }
    }

    SendUpdate() {
        this.Update.Invoke(this, null); // Update?.Invoke(this, null)
    }
    // C# constructors Aircraft(int icaoID) and Aircraft(Guid guid) merged.
    constructor(idOrGuid) {
        if (typeof idOrGuid === 'number') { // Aircraft(int icaoID)
            this.ModeSCode = idOrGuid;
        } else { // Aircraft(Guid guid)
            this.TrackGuid = idOrGuid;
        }
        this.Created.Invoke(this, new EventArgs()); // Created?.Invoke(this, new EventArgs())
        // History.Initialize();  (Array.Initialize is a no-op for reference-type arrays)
    }

    // C# overloads SetLocation(GeoPoint, DateTime) and SetLocation(double, double, DateTime).
    SetLocation(...args) {
        if (args.length === 3) { // SetLocation(double Latitude, double Longitude, DateTime SetTime)
            const [Latitude, Longitude, SetTime] = args;
            let location = new GeoPoint(Latitude, Longitude);
            this.SetLocation(location, SetTime);
            return;
        }
        // SetLocation(GeoPoint Location, DateTime SetTime)
        const [Location, SetTime] = args;
        if (this.#lastLocationSetTime > SetTime)
            return;
        let timeElapsed = Math.trunc((SetTime.getTime() - this.#lastLocationSetTime.getTime()) / 1000); // (int)(...).TotalSeconds
        this.#lastLocationSetTime = SetTime;
        this.Location = Location;
        this.#extrapolatedpos = Location;
        this.#lastLocationExtrapolateTime = SetTime;
        this.LocationUpdated.Invoke(this, new UpdatePositionEventArgs(this, Location)); // LocationUpdated?.Invoke
        this.Drawn = false;
        let updateAge = Math.trunc((RadarWindow.CurrentTime.getTime() - SetTime.getTime()) / 1000); // (int)(...).TotalSeconds
        if (timeElapsed > 15)
            console.log(`Received update for ${this.FlightPlanCallsign} ${updateAge} sec late, after ${timeElapsed} seconds`);
    }

    SetTrack(Track, SetTime) {
        if (this.#lastTrackUpdate > SetTime)
            return;
        let diff = Track - this.Track;
        if (Math.abs(diff) > 180) {
            if (diff > 0)
                diff = 360 - diff;
            else
                diff += 360;
        }
        let seconds = (SetTime.getTime() - this.#lastTrackUpdate.getTime()) / 1000; // .TotalSeconds
        this.Track = Math.trunc(Track); // (int)Track
        if (seconds === 0)
            return;
        this.#rateofturn = diff / seconds;

        this.#lastTrackUpdate = SetTime;
    }

    Bearing(FromPoint) { // double
        if (this.Location == null)
            return 0;
        let λ2 = this.Longitude * (Math.PI / 180);
        let λ1 = FromPoint.Longitude * (Math.PI / 180);
        let φ2 = this.Latitude * (Math.PI / 180);
        let φ1 = FromPoint.Latitude * (Math.PI / 180);

        let y = Math.sin(λ2 - λ1) * Math.cos(φ2);
        let x = Math.cos(φ1) * Math.sin(φ2) -
                Math.sin(φ1) * Math.cos(φ2) * Math.cos(λ2 - λ1);
        let θ = Math.atan2(y, x);
        //θ = (Math.PI / 2) - θ;
        let bearing = (θ * 180 / Math.PI + 360) % 360; // in degrees
        return bearing;
    }

    Distance(FromPoint) { // double
        if (this.Location == null)
            return 0;
        let R = 3443.92; // nautical miles
        let φ1 = this.Latitude * Math.PI / 180; // φ, λ in radians
        let φ2 = FromPoint.Latitude * Math.PI / 180;
        let Δφ = (FromPoint.Latitude - this.Latitude) * Math.PI / 180;
        let Δλ = (FromPoint.Longitude - this.Longitude) * Math.PI / 180;

        let a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
                Math.cos(φ1) * Math.cos(φ2) *
                Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
        let c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

        let alt = this.TrueAltitude / 6076.12;

        let dist = Math.sqrt((R * c) * (R * c) + (alt * alt)); // in nautical miles
        return dist;
    }

    // ── RENDERING fields ──
    TargetReturn = Object.assign(new PrimaryReturn(), { BackColor: Color.Transparent, ForeColor: Color.Lime }); // PrimaryReturn
    History = new Array(10).fill(null); // PrimaryReturn[] = new PrimaryReturn[10]  (Array.Initialize no-op for ref types)
    ConnectingLine = new ConnectingLineF(); // ConnectingLineF
    DataBlock = Object.assign(new TransparentLabel(), { AutoSize: true });  // TransparentLabel { AutoSize = true }
    DataBlock2 = Object.assign(new TransparentLabel(), { AutoSize: true }); // TransparentLabel { AutoSize = true }
    DataBlock3 = Object.assign(new TransparentLabel(), { AutoSize: true }); // TransparentLabel { AutoSize = true }
    AlertLabelRed = Object.assign(new TransparentLabel(), { TextAlign: ContentAlignment.MiddleLeft, AutoSize: true });
    AlertLabelYellow = Object.assign(new TransparentLabel(), { TextAlign: ContentAlignment.MiddleLeft, AutoSize: true });
    PositionIndicator = Object.assign(new TransparentLabel(), { TextAlign: ContentAlignment.MiddleCenter, Text: "*", AutoSize: true });

    Dispose() {
        this.DataBlock.Dispose?.(); // DataBlock.Dispose()
        this.TargetReturn.Dispose(); // TargetReturn.Dispose()
    }

    #dbAlt = 0;            // private int dbAlt
    #dbSpeed = 0;          // private int dbSpeed = 0
    LastDrawnDirection;    // LeaderDirection
    LastDataBlockRightJustified; // bool

    RedrawDataBlock(radar, leaderDirection = null) { // void RedrawDataBlock(Radar radar, LeaderDirection? leaderDirection = null)
        if (this.Callsign == null)
            this.Callsign = ""; // string.Empty
        if (leaderDirection != null) {
        }
        else if (this.LDRDirection != null) {
            leaderDirection = this.LDRDirection; // LDRDirection.Value
        }
        else if (this.OwnerLeaderDirection != null && this.Owned) {
            leaderDirection = this.OwnerLeaderDirection; // OwnerLeaderDirection.Value
        }
        if (leaderDirection != null) {
            this.LastDrawnDirection = leaderDirection; // leaderDirection.Value
        }
        this.LastDataBlockRightJustified = leaderDirection === LeaderDirection.W
            || leaderDirection === LeaderDirection.NW
            || leaderDirection === LeaderDirection.SW;
        let oldtext = this.DataBlock.Text;
        let oldtext2 = this.DataBlock2.Text;
        let oldtext3 = this.DataBlock3.Text;
        this.DataBlock.Text = "";
        this.DataBlock2.Text = "";
        this.DataBlock3.Text = "";
        let altstring;
        if (this.Altitude != null && this.Altitude.AltitudeType !== AltitudeType.Unknown) {
            if (this.#dbAlt % 100 > 50)
                this.#dbAlt = (Math.trunc(this.#dbAlt / 100) * 100) + 100;
            altstring = Math.trunc(this.#dbAlt / 100).toString().padStart(3, '0'); // (dbAlt/100).ToString("D3")
        }
        else {
            altstring = "RDR";
        }
        this.#dbAlt = this.SweptAltitude(radar);
        if (this.#dbAlt % 100 > 50)
            this.#dbAlt = (Math.trunc(this.#dbAlt / 100) * 100) + 100;
        this.#dbSpeed = this.SweptSpeed(radar);

        let vfrchar = " ";
        let catchar = " ";
        let handoffchar = " ";
        if (!(this.PendingHandoff == null || this.PendingHandoff === ""))
            handoffchar = this.PendingHandoff.substring(this.PendingHandoff.length - 1);

        if (this.FlightRules == null || this.FlightRules === "") {
            vfrchar = " ";
        }
        else if (this.FlightRules[0] === 'I') {
            vfrchar = " ";
        }
        else {
            vfrchar = this.FlightRules[0]; // FlightRules[0].ToString()
        }
        if (this.Ident) {
            vfrchar = "I";
            catchar = "D";
        }
        else if (!(this.Category == null || this.Category === "")) {
            catchar = this.Category;
        }
        let destination = "   ";
        let type = "    ";
        let yscratch = "   ";
        let yscratch2;
        let reqalt = "    ";

        if (this.Destination == null || this.Destination === "") {
            destination = altstring;
        }
        else if (this.Destination.trim() !== "" && this.Destination !== "unassigned") {
            destination = this.Destination.padEnd(3);
        }
        else {
            if (this.#dbAlt % 100 > 50)
                this.#dbAlt = (Math.trunc(this.#dbAlt / 100) * 100) + 100;
            destination = Math.trunc(this.#dbAlt / 100).toString().padStart(3, '0');
        }

        if (!(this.Scratchpad == null || this.Scratchpad === "")) {
            yscratch = this.Scratchpad.padEnd(3);
        }
        else {
            yscratch = destination;
        }

        if (!(this.Scratchpad2 == null || this.Scratchpad2 === "")) {
            yscratch2 = this.Scratchpad2.padEnd(3) + "+";
        }
        else if (!(this.Scratchpad == null || this.Scratchpad === "")) {
            yscratch2 = this.Scratchpad.padEnd(3);
        }
        else {
            yscratch2 = destination;
        }

        if (this.Type == null || this.Type === "") {
            type = Math.trunc(this.#dbSpeed / 10).toString().padStart(2, '0') + vfrchar + catchar;
        }
        else if (this.Type.trim() !== "") {
            type = this.Type.padEnd(4);
        }
        else {
            type = Math.trunc(this.#dbSpeed / 10).toString().padStart(2, '0') + vfrchar + catchar;
        }

        if (this.RequestedAltitude > 0) {
            reqalt = "R" + Math.trunc(this.RequestedAltitude / 100).toString().padStart(3, '0');
        }
        else {
            reqalt = type;
        }

        let fdb1line2 = altstring + handoffchar + Math.trunc(this.#dbSpeed / 10).toString().padStart(2, '0') + vfrchar + catchar + " ";
        let fdb2line2 = yscratch + handoffchar + reqalt + " ";
        let fdb3line2;
        if (yscratch2 == null || yscratch2 === "")
            fdb3line2 = yscratch + handoffchar + type + " ";
        else if (yscratch2.length === 4)
            fdb3line2 = yscratch2 + type;
        else
            fdb3line2 = yscratch2 + handoffchar + type + " ";

        if (this.FDB || this.ShowCallsignWithNoSquawk) {
            if (!(this.FlightPlanCallsign == null || this.FlightPlanCallsign === "") && !this.ShowCallsignWithNoSquawk) {
                // An asterisk after the aircraft ID marks an MSAW-inhibited track.
                let acid = this.FlightPlanCallsign;
                if (this.IsMSAWInhibited)
                    acid += "*";
                if (leaderDirection === LeaderDirection.W || leaderDirection === LeaderDirection.NW || leaderDirection === LeaderDirection.SW) {
                    this.DataBlock.Text = acid.padStart(9);
                    this.DataBlock2.Text = acid.padStart(9);
                    this.DataBlock3.Text = acid.padStart(9);
                }
                else {
                    this.DataBlock.Text = acid.padEnd(9);
                    this.DataBlock2.Text = acid.padEnd(9);
                    this.DataBlock3.Text = acid.padEnd(9);
                }
            }
            else if (this.Squawk != null) {
                if (leaderDirection === LeaderDirection.W || leaderDirection === LeaderDirection.NW || leaderDirection === LeaderDirection.SW) {
                    this.DataBlock.Text = this.Squawk.padStart(9);
                    this.DataBlock2.Text = this.Squawk.padStart(9);
                    this.DataBlock3.Text = this.Squawk.padStart(9);
                }
                else {
                    this.DataBlock.Text = this.Squawk.padEnd(9);
                    this.DataBlock2.Text = this.Squawk.padEnd(9);
                    this.DataBlock3.Text = this.Squawk.padEnd(9);
                }
            }
            else {
                this.DataBlock.Text = "";
                this.DataBlock2.Text = "";
                this.DataBlock3.Text = "";
            }

            this.DataBlock.Text += "\r\n";
            this.DataBlock2.Text += "\r\n";
            this.DataBlock3.Text += "\r\n";

            if (this.FDB) {
                this.DataBlock.Text += fdb1line2;
                this.DataBlock2.Text += fdb2line2;
                this.DataBlock3.Text += fdb3line2;
                let assigned = "";
                if (!(this.AssignedSquawk == null || this.AssignedSquawk === ""))
                    assigned = this.AssignedSquawk.padStart(4, '0');
                if (!(assigned == null || assigned === "") && this.Squawk !== assigned) {
                    this.DataBlock.Text += "\r\n" + this.Squawk + " " + assigned;
                    this.DataBlock2.Text += "\r\n" + this.Squawk + " " + assigned;
                    this.DataBlock3.Text += "\r\n" + this.Squawk + " " + assigned;
                }
                else if (this.ATPAMileageNow != null) {
                    let miles = this.ATPAMileageNow; // (double)ATPAMileageNow
                    this.DataBlock.Text += "\r\n" + miles.toFixed(2); // ToString("0.00")
                    this.DataBlock2.Text += "\r\n" + miles.toFixed(2);
                    this.DataBlock3.Text += "\r\n" + miles.toFixed(2);
                }
                else {
                    this.DataBlock.Text += "\r\n ";
                    this.DataBlock2.Text += "\r\n ";
                    this.DataBlock3.Text += "\r\n ";
                }
            }
            else {
                if (leaderDirection === LeaderDirection.W || leaderDirection === LeaderDirection.NW || leaderDirection === LeaderDirection.SW) {
                    this.DataBlock.Text += (altstring + handoffchar + vfrchar + catchar).padStart(9);
                    this.DataBlock2.Text += (yscratch.padEnd(3) + handoffchar + vfrchar + catchar).padStart(9);
                    this.DataBlock3.Text += (yscratch.padEnd(3) + handoffchar + vfrchar + catchar).padStart(9);
                }
                else {
                    this.DataBlock.Text += altstring + handoffchar + vfrchar + catchar;
                    this.DataBlock2.Text += yscratch.padEnd(3) + handoffchar + vfrchar + catchar;
                    this.DataBlock3.Text += yscratch.padEnd(3) + handoffchar + vfrchar + catchar;
                }
            }
            if (this.ShowCallsignWithNoSquawk && this.Callsign != null && !this.Associated) {
                let cs = this.Callsign;
                if (leaderDirection === LeaderDirection.W || leaderDirection === LeaderDirection.NW || leaderDirection === LeaderDirection.SW) {
                    this.DataBlock.Text += "\r\n" + cs.padStart(9);
                    this.DataBlock2.Text += "\r\n" + cs.padStart(9);
                    this.DataBlock3.Text += "\r\n" + cs.padStart(9);
                }
                else {
                    this.DataBlock.Text += "\r\n" + cs.padEnd(9);
                    this.DataBlock2.Text += "\r\n" + cs.padEnd(9);
                    this.DataBlock3.Text += "\r\n" + cs.padEnd(9);
                }
            }
            else if (this.DataBlock.Text.split('\n').length < 3) {
                this.DataBlock.Text += "\r\n ";
                this.DataBlock2.Text += "\r\n ";
                this.DataBlock3.Text += "\r\n ";
            }
        }
        else {
            //This is an LDB
            if (this.LdbBeaconCodesInhibited && !this.ShowCallsignWithNoSquawk) {
                // BCB INH: single line, altitude only
                this.DataBlock.Text = altstring + handoffchar + vfrchar + catchar + "\r\n     \r\n     ";
                this.DataBlock2.Text = yscratch.padEnd(3) + handoffchar + vfrchar + catchar + "\r\n     \r\n     ";
                this.DataBlock3.Text = yscratch.padEnd(3) + handoffchar + vfrchar + catchar + "\r\n     \r\n     ";
            }
            else if (this.ShowCallsignWithNoSquawk) {
                // F1 beacon readout: show all 3 lines (squawk + altitude + callsign)
                let squawkLine = !(this.Squawk == null || this.Squawk === "") ? this.Squawk : "";
                let csLine = !(this.Callsign == null || this.Callsign === "") ? this.Callsign : "";
                if (leaderDirection === LeaderDirection.W || leaderDirection === LeaderDirection.NW || leaderDirection === LeaderDirection.SW) {
                    this.DataBlock.Text = squawkLine.padStart(9) + "\r\n" + (altstring + handoffchar + vfrchar + catchar).padStart(9) + "\r\n" + csLine.padStart(9);
                    this.DataBlock2.Text = squawkLine.padStart(9) + "\r\n" + (yscratch.padEnd(3) + handoffchar + vfrchar + catchar).padStart(9) + "\r\n" + csLine.padStart(9);
                    this.DataBlock3.Text = squawkLine.padStart(9) + "\r\n" + (yscratch.padEnd(3) + handoffchar + vfrchar + catchar).padStart(9) + "\r\n" + csLine.padStart(9);
                }
                else {
                    this.DataBlock.Text = squawkLine.padEnd(9) + "\r\n" + altstring + handoffchar + vfrchar + catchar + "\r\n" + csLine.padEnd(9);
                    this.DataBlock2.Text = squawkLine.padEnd(9) + "\r\n" + yscratch.padEnd(3) + handoffchar + vfrchar + catchar + "\r\n" + csLine.padEnd(9);
                    this.DataBlock3.Text = squawkLine.padEnd(9) + "\r\n" + yscratch.padEnd(3) + handoffchar + vfrchar + catchar + "\r\n" + csLine.padEnd(9);
                }
            }
            else {
                // Normal LDB: beacon code + altitude (2 lines)
                let squawkLine = !(this.Squawk == null || this.Squawk === "") ? this.Squawk : "";
                if (leaderDirection === LeaderDirection.W || leaderDirection === LeaderDirection.NW || leaderDirection === LeaderDirection.SW) {
                    this.DataBlock.Text = squawkLine.padStart(9) + "\r\n" + (altstring + handoffchar + vfrchar + catchar).padStart(9) + "\r\n     ";
                    this.DataBlock2.Text = squawkLine.padStart(9) + "\r\n" + (yscratch.padEnd(3) + handoffchar + vfrchar + catchar).padStart(9) + "\r\n     ";
                    this.DataBlock3.Text = squawkLine.padStart(9) + "\r\n" + (yscratch.padEnd(3) + handoffchar + vfrchar + catchar).padStart(9) + "\r\n     ";
                }
                else {
                    this.DataBlock.Text = squawkLine.padEnd(9) + "\r\n" + altstring + handoffchar + vfrchar + catchar + "\r\n     ";
                    this.DataBlock2.Text = squawkLine.padEnd(9) + "\r\n" + yscratch.padEnd(3) + handoffchar + vfrchar + catchar + "\r\n     ";
                    this.DataBlock3.Text = squawkLine.padEnd(9) + "\r\n" + yscratch.padEnd(3) + handoffchar + vfrchar + catchar + "\r\n     ";
                }
            }
        }

        // Alert/SPC codes are rendered on a separate line above the data block (RadarWindow).
        if (!(this.PositionInd == null || this.PositionInd === ""))
            this.PositionIndicator.Text = this.PositionInd.substring(this.PositionInd.length - 1);
        else if (this.#isSquawkSelected())
            this.PositionIndicator.Text = String(this.#selectedSquawkChar);
        else if (this.Squawk === "1200")
            this.PositionIndicator.Text = "V";
        else if (this.PrimaryOnly)
            this.PositionIndicator.Text = "◇";
        else
            this.PositionIndicator.Text = "*";
    }

    #selectedSquawks;      // private List<string>
    #selectedSquawkChar;   // private char
    SetSelectedSquawkList(selectedSquawks, selectedChar) {
        this.#selectedSquawks = selectedSquawks;
        this.#selectedSquawkChar = selectedChar;
    }
    #isSquawkSelected() { // private bool
        if (this.#selectedSquawks == null || this.Squawk == null)
            return false;
        for (const squawk of this.#selectedSquawks) {
            if (this.Squawk.startsWith(squawk))
                return true;
        }
        return false;
    }
    OldRedrawDataBlock(updatepos = false) { // void OldRedrawDataBlock(bool updatepos = false)
        if (updatepos || this.#dbAlt === 0 || this.#dbSpeed === 0) {
            this.#dbAlt = this.TrueAltitude;
            if (this.#dbAlt % 100 > 50)
                this.#dbAlt = (Math.trunc(this.#dbAlt / 100) * 100) + 100;
            this.#dbSpeed = this.GroundSpeed;
        }
        let vrchar = " ";
        if (this.PendingHandoff != null)
            if (this.PendingHandoff !== this.PositionInd)
                vrchar = this.PendingHandoff.substring(this.PendingHandoff.length - 1);
        let oldtext = this.DataBlock.Text;
        let oldtext2 = this.DataBlock.Text;

        let field1 = "";
        if (this.Scratchpad != null) {
            field1 = this.Scratchpad;
        }
        else if (this.Runway != null) {
            if (this.Runway !== "NNNN")
                field1 = this.Runway;
        }
        if (field1.trim() === "" && this.Destination != null) {
            if (this.Destination !== "unassigned")
                field1 = this.Destination;
        }

        if (field1.trim() === "") {
            if (this.#dbAlt % 100 > 50)
                this.#dbAlt = (Math.trunc(this.#dbAlt / 100) * 100) + 100;
            field1 = Math.trunc(this.#dbAlt / 100).toString().padStart(3, '0');
        }

        field1 = field1.trim();
        let field2 = "";
        if (this.Type == null && this.Scratchpad2 == null)
            field2 = Math.trunc(this.#dbSpeed / 10).toString().padStart(2, '0');
        else if (this.Scratchpad2 != null)
            field2 = this.Scratchpad2;
        else
            field2 = this.Type;
        field2 = field2.trim();

        this.DataBlock.Text = "";
        if (this.Squawk === "7700")
            this.DataBlock.Text += "EM" + "\r\n";
        else if (this.Squawk === "7600")
            this.DataBlock.Text += "RF" + "\r\n";
        if (this.Callsign != null && this.#fdb() && ((this.Squawk !== "1200" && this.Squawk != null) || this.ShowCallsignWithNoSquawk || !(this.PositionInd == null || this.PositionInd === "*")))
            this.DataBlock.Text += this.Callsign + "\r\n";
        else if (this.Squawk === "1200" && this.#fdb())
            this.DataBlock.Text = "1200\r\n";
        this.DataBlock2.Text = this.DataBlock.Text;
        if (!this.#fdb()) {
            if (this.#dbAlt % 100 > 50)
                this.#dbAlt = (Math.trunc(this.#dbAlt / 100) * 100) + 100;
            this.DataBlock.Text = Math.trunc(this.#dbAlt / 100).toString().padStart(3, '0');
            this.DataBlock2.Text = field1;
        }
        else {
            if (this.#dbAlt % 100 > 50)
                this.#dbAlt = (Math.trunc(this.#dbAlt / 100) * 100) + 100;
            this.DataBlock.Text += Math.trunc(this.#dbAlt / 100).toString().padStart(3, '0') + vrchar + Math.trunc(this.#dbSpeed / 10).toString().padStart(2, '0');
            this.DataBlock2.Text += field1 + vrchar + field2;
        }
        if (this.Squawk === "1200" || (this.FlightRules !== "IFR" && this.FlightRules != null)) {
            if (this.DataBlock2.Text === this.DataBlock.Text)
                this.DataBlock2.Text += "V ";
            this.DataBlock.Text += "V";
        }
        if (this.#fdb())
            this.DataBlock.Text += " " + (this.Category ?? ""); // C# "x" + null == "x"
        if (this.Ident) {
            this.DataBlock2.Text += "ID";
            this.DataBlock.Text += "ID";
        }
        if (this.PositionInd != null)
            this.PositionIndicator.Text = this.PositionInd.substring(this.PositionInd.length - 1);
        else
            this.PositionIndicator.Text = "*";
    }
    DropTrack() {
        this.Dropped.Invoke(this, new EventArgs()); // Dropped?.Invoke
    }
    DeleteFP() {
        this.FpDeleted.Invoke(this, new EventArgs()); // FpDeleted?.Invoke  (commented-out body preserved in source)
    }
    RedrawTarget(Location, radar) { // void RedrawTarget(GeoPoint Location, Radar radar)
        this.TargetReturn.GeoLocation = Location;
        this.TargetReturn.LastDrawnRange = 0;
        //if (LocationF.X != 0 || LocationF.Y != 0) {
        //TargetReturn.Angle = Location.BearingTo(LocationReceivedBy.Location);
        this.PositionIndicator.CenterOnPoint(this.LocationF);
        this.RedrawDataBlock(radar);
        this.TargetReturn.Intensity = 1;
        this.Drawn = false;
        this.LocationUpdated.Invoke(this, new UpdatePositionEventArgs(this, Location)); // LocationUpdated?.Invoke
        //}
    }

    SweptLocation(radar) { // GeoPoint
        if (!this.PrimaryOnly) {
            // lock (SweptLocations)
            if (this.SweptLocations.has(radar)) {
                return this.SweptLocations.get(radar);
            }
            else {
                return null;
            }
        }
        else {
            return this.Location;
        }
    }

    SweptTrack(radar) { // int
        if (!this.PrimaryOnly) {
            // lock (SweptTracks)
            if (this.SweptTracks.has(radar)) {
                return this.SweptTracks.get(radar);
            }
            else {
                return this.Track;
            }
        }
        else {
            return this.Track;
        }
    }
    SweptAltitude(radar) { // int
        if (!this.PrimaryOnly) {
            // lock (SweptAltitudes)
            if (this.SweptAltitudes.has(radar)) {
                return this.SweptAltitudes.get(radar);
            }
            else {
                return this.PressureAltitude;
            }
        }
        else {
            return this.PressureAltitude;
        }
    }

    SweptSpeed(radar) { // int
        if (!this.PrimaryOnly) {
            // lock (SweptSpeeds)
            if (this.SweptSpeeds.has(radar)) {
                return this.SweptSpeeds.get(radar);
            }
            else {
                return this.GroundSpeed;
            }
        }
        else {
            return this.GroundSpeed;
        }
    }

    SweptHistory(radar) { // PrimaryReturn[]
        // lock (SweptHistories)
        if (this.SweptHistories.has(radar)) {
            return this.SweptHistories.get(radar);
        }
        else {
            return this.History;
        }
    }

    // C# overloads ExtrapolateTrack(DateTime) and ExtrapolateTrack().
    ExtrapolateTrack(time) { // double
        if (time === undefined)
            return this.ExtrapolateTrack(RadarWindow.CurrentTime);
        if (Math.abs(this.#rateofturn) > 5) // sanity check
        {
            return this.Track;
        }
        return ((this.Track + ((this.#rateofturn / 2) * ((time.getTime() - this.#lastTrackUpdate.getTime()) / 1000))) + 360) % 360; // .TotalSeconds
    }

    // C# overloads ExtrapolatePosition(DateTime) and ExtrapolatePosition().
    ExtrapolatePosition(time) { // GeoPoint
        if (time === undefined)
            return this.ExtrapolatePosition(RadarWindow.CurrentTime);
        if (!this.#extrapolatedpos) return this.Location ?? new GeoPoint(0, 0);
        let miles = this.GroundSpeed * ((time.getTime() - this.#lastLocationExtrapolateTime.getTime()) / 3600000); // .TotalHours
        let track = this.ExtrapolateTrack();
        let location = this.#extrapolatedpos.FromPoint(miles, track);
        this.#extrapolatedpos = location;
        this.#lastLocationExtrapolateTime = time;
        return location;
    }

    SweptLocations = new Map();  // Dictionary<Radar, GeoPoint>
    SweptTracks = new Map();     // Dictionary<Radar, int>
    SweptAltitudes = new Map();  // Dictionary<Radar, int>
    SweptSpeeds = new Map();     // Dictionary<Radar, int>
    SweptHistories = new Map();  // Dictionary<Radar, PrimaryReturn[]>
    LastHistoryTimes = new Map(); // Dictionary<Radar, DateTime>
    toString() {
        return this.Callsign;
    }

    // events (C# `event EventHandler<T>`) -> EventHandler shim instances
    LocationUpdated = new EventHandler();  // event EventHandler<UpdatePositionEventArgs>
    HandoffInitiated = new EventHandler(); // event EventHandler<HandoffEventArgs>
    HandedOff = new EventHandler();        // event EventHandler<HandoffEventArgs>
    Transferred = new EventHandler();      // event EventHandler<HandoffEventArgs>
    Created = new EventHandler();          // event EventHandler
    OwnershipChange = new EventHandler();  // event EventHandler<AircraftEventArgs>
    Dropped = new EventHandler();          // event EventHandler
    FpDeleted = new EventHandler();        // event EventHandler
    Update = new EventHandler();           // event EventHandler
}

export class AircraftEventArgs extends EventArgs {
    Aircraft = null;  // Aircraft { get; set; }
    Time = null;      // DateTime { get; private set; }
    constructor(Aircraft) {
        super();
        this.Aircraft = Aircraft;
        this.Time = RadarWindow.CurrentTime;
    }
}

export class HandoffEventArgs extends AircraftEventArgs {
    PositionFrom = null; // string? { get; private set; }
    PositionTo = null;   // string  { get; private set; }
    constructor(Aircraft, to, from = null) {
        super(Aircraft);
        this.PositionFrom = from;
        this.PositionTo = to;
    }
}

export class UpdatePositionEventArgs extends AircraftEventArgs {
    Location = null; // GeoPoint { get; private set; }
    constructor(Aircraft, Location, intrafacility = false) {
        super(Aircraft);
        this.Location = Location;
        //Intrafacility = intrafacility;
    }
}
