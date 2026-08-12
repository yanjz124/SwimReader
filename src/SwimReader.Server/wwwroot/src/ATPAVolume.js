// Ported 1:1 from _source/ATPAVolume.cs
// namespace DGScope
// using DGScope.STARS; using OpenTK;  (MathHelper.DegreesToRadians -> x * Math.PI/180)
import { GeoPoint } from "./GeoPoint.js";
import { ScratchpadFilterType } from "./ScratchpadFilter.js";
import { ATPAStatus } from "./ATPA.js";

export class ATPAVolume {
    // [DisplayName("Volume ID"), Category("Identity")]
    VolumeId = null;           // string
    Active = false;            // bool
    // [Description("Draw the volume on the scope, for testing purposes.")]
    Draw = false;              // bool
    // [DisplayName("Volume Name"), Category("Identity")]
    Name = null;               // string
    // [DisplayName("Runway Threshold Location"), Category("Geometry")]
    RunwayThreshold = new GeoPoint(); // GeoPoint
    // [DisplayName("Runway True Heading"), Category("Geometry")]
    TrueHeading = 0;           // int
    // [DisplayName("Maximum Heading Deviation (deg)"), Category("Geometry")]
    MaxHeadingDeviation = 0;   // int
    // [DisplayName("Ceiling (ft)"), Category("Geometry")]
    Ceiling = 0;               // int
    // [DisplayName("Floor (ft)"), Category("Geometry")]
    Floor = 0;                 // int
    // [DisplayName("Length (NM)"), Category("Geometry")]
    Length = 0;                // double
    // [DisplayName("Width Left (ft)"), Category("Geometry")]
    WidthLeft = 0;             // int
    // [DisplayName("Width Right (ft)"), Category("Geometry")]
    WidthRight = 0;            // int
    // [DisplayName("Enabled"), Category("2.5nm Approach")]
    TwoPointFiveEnabled = false; // bool
    // [DisplayName("Active"), Category("2.5nm Approach")]
    TwoPointFiveActive = false;  // bool
    //public List<ScratchpadFilter> ScratchpadFilters { get; set; } = new List<ScratchpadFilter>();
    // [DisplayName("Leader Line Direction"), Category("Filters")]
    LeaderFilters = [];        // List<LeaderDirection>
    // [DisplayName("Destination"), Category("Filters")]
    Destination = null;        // string
    // [DisplayName("Distance"), Category("2.5nm Approach")]
    TwoPointFiveDistance = 0;  // double
    // [DisplayName("Scratchpad"), Category("Filters")]
    ScratchpadFilters = [];    // List<ScratchpadFilter>
    // [DisplayName("TCP Display"), Category("Filters")]
    TcpDisplay = [];           // List<ATPATCPDisplay>
    // [DisplayName("TCP Exclusions"), Category("Filters")]
    // [Editor("System.Windows.Forms.Design.StringCollectionEditor, ...", typeof(UITypeEditor))]
    TcpExclusion = [];         // List<string>

    #order;                    // private List<Aircraft> order
    // private object orderlock  -> lock() is a no-op in single-threaded JS; field dropped.

    get #minHeading() { return this.TrueHeading - this.MaxHeadingDeviation; } // private int minHeading =>
    get #maxHeading() { return this.TrueHeading + this.MaxHeadingDeviation; } // private int maxHeading =>
    get #minBearing() { return this.TrueHeading - 90; } // private int minBearing =>
    get #maxBearing() { return this.TrueHeading + 90; } // private int maxBearing =>

    IsInside(aircraft, radar, atpa) { // bool
        if (aircraft == null)
            return false;
        if (this.TcpExclusion.includes(aircraft.PositionInd))
            return false;
        if (atpa.ExcludedACIDs.some(x => aircraft.FlightPlanCallsign != null && x.trim() === aircraft.FlightPlanCallsign.trim()))
            return false;
        if (atpa.ExcludedSSRCodes.some(x => aircraft.Squawk != null && x.IsInRange(aircraft.Squawk)))
            return false;
        if (aircraft.TrueAltitude > this.Ceiling || aircraft.TrueAltitude < this.Floor)
            return false;
        if (this.Destination != null && this.Destination !== aircraft.Destination)
            return false;
        if (this.LeaderFilters.length > 0 && (!(aircraft.OwnerLeaderDirection != null) || !this.LeaderFilters.includes(aircraft.OwnerLeaderDirection)))
            return false;
        let acloc = aircraft.SweptLocation(radar);
        if (acloc == null)
            return false;
        let acdistancetothreshold = acloc.DistanceTo(this.RunwayThreshold);
        if (acdistancetothreshold > this.Length)
            return false;
        let acbearingtothreshold = acloc.BearingTo(this.RunwayThreshold);
        if (!this.#BearingIsBetween(acbearingtothreshold, this.#minBearing, this.#maxBearing))
            return false;
        if (!this.#BearingIsBetween(aircraft.SweptTrack(radar), this.#minHeading, this.#maxHeading))
            return false;
        let angletothreshold = acbearingtothreshold - this.TrueHeading;
        let disttocenterline = acdistancetothreshold * Math.sin((Math.abs(angletothreshold)) * Math.PI / 180); // MathHelper.DegreesToRadians(...)
        if (angletothreshold > 0 && disttocenterline * 6076 > this.WidthLeft) // left
            return false;
        if (angletothreshold < 0 && disttocenterline * 6076 > this.WidthRight) // right
            return false;
        if (this.ScratchpadFilters.filter(x => x.Match(aircraft) && x.ScratchpadFilterType === ScratchpadFilterType.Exclusion).length > 0)
            return false;
        return true;
    }

    #BearingIsBetween(bearing, az1, az2) { // private bool
        bearing = (bearing + 360) % 360;
        az1 = (az1 + 360) % 360;
        az2 = (az2 + 360) % 360;
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

    static ResetAircraftATPAValues(aircraft, resetAcATPARef = true) { // static void
        if (resetAcATPARef)
            aircraft.ATPAVolume = null;
        aircraft.ATPAFollowing = null;
        aircraft.ATPAMileageNow = null;
        aircraft.ATPAMileage24 = null;
        aircraft.ATPAMileage45 = null;
        aircraft.ATPARequiredMileage = null;
        aircraft.ATPAStatus = null;
        aircraft.ATPACone = null;
    }

    CalculateATPA(aircraft, atpa, radar) { // void CalculateATPA(List<Aircraft> aircraft, ATPA atpa, Radar radar)
        // lock (orderlock)
        {
            if (!this.Active) {
                aircraft.filter(x => x.ATPAVolume === this).forEach(x => ATPAVolume.ResetAircraftATPAValues(x));
                return;
            }
            this.#order = aircraft.filter(x => this.IsInside(x, radar, atpa))
                .sort((a, b) => a.SweptLocation(radar).DistanceTo(this.RunwayThreshold) - b.SweptLocation(radar).DistanceTo(this.RunwayThreshold)); // Where(...).OrderBy(...).ToList()
            aircraft.filter(x => x.ATPAVolume === this && !this.#order.includes(x)).forEach(x => {
                ATPAVolume.ResetAircraftATPAValues(x);
            });
            if (this.#order.length > 1) {
                this.#order[0].ATPAVolume = this;
                ATPAVolume.ResetAircraftATPAValues(this.#order[0], false);
                for (let i = 1; i < this.#order.length; i++) {
                    let leader = this.#order[i - 1];
                    let follower = this.#order[i];
                    follower.ATPAVolume = this;
                    follower.ATPAFollowing = leader;
                    follower.ATPAMileageNow = follower.SweptLocation(radar).DistanceTo(leader.SweptLocation(radar));
                    if (this.ScratchpadFilters.filter(x => x.Match(follower) && x.ScratchpadFilterType === ScratchpadFilterType.Ineligible).length === 0) {
                        follower.ATPAMileage24 = follower.SweptLocation(radar).FromPoint(follower.GroundSpeed * 24 / 3600, follower.ExtrapolateTrack())
                            .DistanceTo(leader.SweptLocation(radar).FromPoint(leader.GroundSpeed * 24 / 3600, leader.ExtrapolateTrack()));
                        follower.ATPAMileage45 = follower.SweptLocation(radar).FromPoint(follower.GroundSpeed * 45 / 3600, follower.ExtrapolateTrack())
                            .DistanceTo(leader.SweptLocation(radar).FromPoint(leader.GroundSpeed * 45 / 3600, leader.ExtrapolateTrack()));
                        let minsep = 3;
                        if (this.TwoPointFiveEnabled && this.TwoPointFiveActive && follower.SweptLocation(radar).DistanceTo(this.RunwayThreshold) <= this.TwoPointFiveDistance)
                            minsep = 2.5;
                        let leaderTable = {}; // out SerializableDictionary<string, double>
                        if (follower.Category != null && atpa.RequiredSeparation.TryGetValue(follower.Category, leaderTable)) {
                            let miles = {}; // out double
                            if (leader.Category != null && leaderTable.value != null && leaderTable.value.TryGetValue(leader.Category, miles))
                                follower.ATPARequiredMileage = miles.value;
                            else
                                follower.ATPARequiredMileage = minsep;
                        }
                        else {
                            follower.ATPARequiredMileage = minsep;
                        }

                        if (follower.ATPAMileageNow < follower.ATPARequiredMileage || follower.ATPAMileage24 < follower.ATPARequiredMileage)
                            follower.ATPAStatus = ATPAStatus.Alert;
                        else if (follower.ATPAMileage45 < follower.ATPARequiredMileage)
                            follower.ATPAStatus = ATPAStatus.Caution;
                        else
                            follower.ATPAStatus = ATPAStatus.Monitor;
                    }
                    else {
                        follower.ATPAStatus = ATPAStatus.Monitor;
                    }
                    follower.ATPATrackToLeader = follower.SweptLocation(radar).BearingTo(leader.SweptLocation(radar));
                }
            }
            else if (this.#order.length === 1) {
                this.#order[0].ATPAVolume = this;
                ATPAVolume.ResetAircraftATPAValues(this.#order[0], false);
            }
        }
    }
    toString() {
        return this.Name;
    }
}
