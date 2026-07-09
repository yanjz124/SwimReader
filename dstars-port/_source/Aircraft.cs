using System;
using System.Collections.Generic;
using System.Drawing;
using DGScope.STARS;

namespace DGScope
{
    public class Aircraft : IDisposable
    {
        public Guid TrackGuid { get; set; } = Guid.NewGuid();
        public Guid FlightPlanGuid { get; set; }
        public int ModeSCode { get; set; }
        public string Squawk { get; set; }
        public string AssignedSquawk { get; set; }
        public double Latitude => Location.Latitude;
        public double Longitude => Location.Longitude;
        public string Callsign { get; set; }
        public bool Deleted { get; set; } = false;
        public bool ShowPTL { get; set; } = false;
        public bool Pointout { get; set; } = false;
        public bool ForceQuickLook { get; set; } = false;
        public int PressureAltitude => Altitude.PressureAltitude;
        public int TrueAltitude => Altitude.TrueAltitude;
        public ATPAVolume? ATPAVolume { get; set; } = null;
        public Aircraft? ATPAFollowing { get; set; } = null;
        public double? ATPAMileageNow { get; set; } = null;
        public double? ATPAMileage24 { get; set; } = null;
        public double? ATPAMileage45 { get; set; } = null;
        public double? ATPARequiredMileage { get; set; } = null;
        public double? ATPATrackToLeader { get; set; } = null;
        public ATPAStatus? ATPAStatus { get; set; } = null;
        public TPACone? ATPACone { get; set; } = null;
        private double rateofturn;
        private string positionind;
        public string PositionInd
        {
            get => positionind;
            set
            {
                if (value != positionind && pendinghandoff != null && pendinghandoff != value)
                {
                    HandedOff?.Invoke(this, new HandoffEventArgs(this, value, pendinghandoff));
                    pendinghandoff = null;
                }
                // Fire Transferred whenever ownership actually changes from one
                // controller to another (ignoring the initial null→value set).
                // CRC STARS spec: after the receiver accepts your outbound, the
                // data block blinks white for 5 seconds. HandedOff above only
                // fires on UNEXPECTED transitions (new owner ≠ pending receiver),
                // so it doesn't cover the standard accept case. RadarWindow
                // subscribes to Transferred and drives the 5s flash from there.
                if (value != positionind && !string.IsNullOrEmpty(positionind))
                {
                    Transferred?.Invoke(this, new HandoffEventArgs(this, value, positionind));
                }
                positionind = value;
            }
        }
        // Stamped by RadarWindow.Aircraft_Transferred when an outbound handoff
        // we initiated has just been accepted. The render loop's standard
        // Flashing-clear branch (line ~6200) skips clearing while this window
        // is active so the data block stays in blinking-white state for 5s.
        public DateTime JustTransferredAt { get; set; } = DateTime.MinValue;
        private string pendinghandoff;
        public string PendingHandoff {
            get => pendinghandoff;
            set
            {
                if (value != pendinghandoff)
                {
                    HandoffInitiated?.Invoke(this, new HandoffEventArgs(this, value, PositionInd));
                    pendinghandoff = value;
                }
            }
        }
        public TPA TPA { get; set; }
        public Altitude Altitude
        {
            get; set;
        } = new Altitude();
        private DateTime lastLocationSetTime = DateTime.MinValue;
        private DateTime lastLocationExtrapolateTime = DateTime.MinValue;
        private GeoPoint extrapolatedpos;
        private DateTime lastTrackUpdate = DateTime.MinValue;
        public GeoPoint Location { get;  private set; }
        public PointF LocationF { get; set; }
        //public Receiver LocationReceivedBy { get; set; }
        public int GroundSpeed { get; set; }
        public int Track { get; private set; }
        public int VerticalRate { get; set; }
        public bool Ident { get => ident;
            set
            {
                ident = value;
            }
        }
        public bool IsOnGround { get; set; }
        public bool Emergency { get; set; }
        public bool Alert { get; set; }
        // MSAW low-altitude alert. LowAltitude is set by the MSAW engine; once the
        // controller slews the track, LowAltitudeAcknowledged silences the tone.
        public bool LowAltitude { get; set; }
        public bool LowAltitudeAcknowledged { get; set; }
        // Per-track MSAW processing inhibit (F7 V <slew> / F7 Q <slew>).
        public bool MSAWInhibited { get; set; }
        // True when MSAW is inhibited for this track for any reason (automatic VFR
        // inhibit or a manual inhibit). Drives both the MSAW engine and the "*"
        // shown after the aircraft ID.
        public bool IsMSAWInhibited =>
            MSAWInhibited || (!string.IsNullOrEmpty(FlightRules) && FlightRules[0] == 'V');
        // Conflict Alert (CA/STCA). ConflictAlert is set by the CA engine; once a
        // controller slews either track, ConflictAlertAcknowledged silences the tone
        // and makes the "CA" solid. ConflictingTracks is the current set of partners
        // (rebuilt each pass) so acknowledging one track acknowledges the pair.
        public bool ConflictAlert { get; set; }
        public bool ConflictAlertAcknowledged { get; set; }
        public List<Aircraft> ConflictingTracks { get; } = new List<Aircraft>();

        // ---- Special Purpose Codes (SPC) and alert tags ----
        // Squawk-derived SPCs are red and sound the SpecialCode tone until acknowledged.
        // Manually-assigned tags (type code + slew) are silent: red HJ/RF/EM/MI/LL or
        // yellow OD/ME/MF/LN. CA/LA come from the alert engines (red, blinking).
        public List<string> ManualAlertCodes { get; } = new List<string>();
        public bool SpcAcknowledged { get; set; }
        public static readonly string[] AssignableSPCs = { "HJ", "RF", "EM", "MI", "LL", "OD", "ME", "MF", "LN" };
        private static readonly HashSet<string> RedAlertCodes = new HashSet<string> { "CA", "LA", "HJ", "RF", "EM", "MI", "LL" };
        private static readonly HashSet<string> YellowAlertCodes = new HashSet<string> { "OD", "ME", "MF", "LN" };
        public static bool IsRedAlertCode(string code) => RedAlertCodes.Contains(code);
        public static bool IsYellowAlertCode(string code) => YellowAlertCodes.Contains(code);

        // The SPC implied by the actual beacon code, or null. Only these sound.
        public string SquawkSPC
        {
            get
            {
                switch (Squawk)
                {
                    case "7500": return "HJ"; // hijack
                    case "7600": return "RF"; // radio failure
                    case "7700": return "EM"; // emergency
                    case "7777": return "MI"; // military intercept
                    case "7400": return "LL"; // lost link
                    default: return null;
                }
            }
        }

        // Active codes kept in activation order ("whichever comes first"), split by color.
        public List<string> ActiveRedCodes { get; } = new List<string>();
        public List<string> ActiveYellowCodes { get; } = new List<string>();
        public void UpdateAlertCodes()
        {
            // Reset the SPC acknowledgement once the beacon code is no longer an SPC,
            // so a subsequent SPC sounds again.
            if (SquawkSPC == null)
                SpcAcknowledged = false;
            var red = new List<string>();
            if (ConflictAlert) red.Add("CA");
            if (LowAltitude) red.Add("LA");
            var sq = SquawkSPC;
            if (sq != null && !red.Contains(sq)) red.Add(sq);
            foreach (var c in ManualAlertCodes)
                if (RedAlertCodes.Contains(c) && !red.Contains(c)) red.Add(c);
            var yellow = new List<string>();
            foreach (var c in ManualAlertCodes)
                if (YellowAlertCodes.Contains(c) && !yellow.Contains(c)) yellow.Add(c);
            SyncOrdered(ActiveRedCodes, red);
            SyncOrdered(ActiveYellowCodes, yellow);
        }
        private static void SyncOrdered(List<string> current, List<string> active)
        {
            current.RemoveAll(c => !active.Contains(c));
            foreach (var c in active)
                if (!current.Contains(c)) current.Add(c);
        }
        public bool HasAnyAlertCode => ActiveRedCodes.Count > 0 || ActiveYellowCodes.Count > 0;
        // Only CA/LA blink (until acknowledged); SPCs and manual tags are solid.
        public bool RedAlertBlinks => (ConflictAlert && !ConflictAlertAcknowledged) || (LowAltitude && !LowAltitudeAcknowledged);
        // The squawk-derived SPC sounds until the track is slewed to acknowledge.
        public bool HasUnacknowledgedSpc => SquawkSPC != null && !SpcAcknowledged;

        public DateTime LastMessageTime { get; set; }
        public DateTime LastPositionTime { get { return lastLocationSetTime; } }
        public Color TargetColor { get { return TargetReturn.ForeColor; } set { TargetReturn.ForeColor = value; } }
        public Font Font { get { return DataBlock.Font; } set { DataBlock.Font = value; } }
        public Line PTL { get; set; } = new Line();
        public string? Destination { get; set; }
        public string? Scratchpad { get; set; }
        public string? Type { get; set; }
        public string? Scratchpad2 { get; set; }
        public string? FlightRules { get; set; }
        public string? Runway { get; set; }
        public int RequestedAltitude { get; set; } = 0;
        public string? Category { get; set; }
        public string FlightPlanCallsign { get; set; }
        public DateTime LastHistoryDrawn { get; set; } = DateTime.MinValue;
        public bool Drawn { get; set; } = false;
        bool owned = false;
        public bool Owned 
        {
            get => owned;
            set
            {
                if (value != owned)
                    OwnershipChange?.Invoke(this, new AircraftEventArgs(this));
                owned = value;
            } 
        }
        public bool Marked { get; set; } = false;
        public bool QuickLook { get; set; } = false;
        public bool QuickLookPlus { get; set; } = false;

        public LeaderDirection? LDRDirection = null;
        public LeaderDirection? OwnerLeaderDirection = null;
        public bool ShowCallsignWithNoSquawk { get; set; } = false;
        public bool LdbBeaconCodesInhibited { get; set; } = false;
        public bool FDB { 
            get
            {
                if (Owned && !QuickLook) _fdb = true;
                else if (QuickLook)
                    return true;
                else if (ForceQuickLook)
                    return true;
                return _fdb;
            }
            set
            {
                var oldvalue = _fdb;
                _fdb = value;
                if (QuickLook)
                    QuickLook = false;
            }
        }
        public bool Associated
        {
            get
            {
                return FlightPlanGuid != null && FlightPlanGuid != Guid.Empty;
            }
        }

        public bool PrimaryOnly
        {
            get
            {
                return string.IsNullOrEmpty(Squawk) && ModeSCode == 0 && ((Altitude == null || Altitude.AltitudeType == AltitudeType.Unknown));
                return ((Altitude == null || Altitude.AltitudeType == AltitudeType.Unknown) && !Associated);
            }
        }

        bool ident;
        bool _fdb = false;
        private bool fdb()
        {
            if (Emergency || QuickLook)
            {
                return true;
            }
            else
            {
                return _fdb;
            }
        }

        public void SendUpdate()
        {
            Update?.Invoke(this, null);
        }
        public Aircraft(int icaoID)
        {
            ModeSCode = icaoID;
            Created?.Invoke(this, new EventArgs());
            History.Initialize();
        }
        public Aircraft(Guid guid)
        {
            TrackGuid = guid;
            Created?.Invoke(this, new EventArgs());
            History.Initialize();
        }

        public void SetLocation (GeoPoint Location, DateTime SetTime)
        {
            if (lastLocationSetTime > SetTime)
                return;
            int timeElapsed = (int)(SetTime - lastLocationSetTime).TotalSeconds;
            lastLocationSetTime = SetTime;
            this.Location = Location;
            extrapolatedpos = Location;
            lastLocationExtrapolateTime = SetTime;
            LocationUpdated?.Invoke(this, new UpdatePositionEventArgs(this, Location));
            Drawn = false;
            int updateAge = (int)(RadarWindow.CurrentTime - SetTime).TotalSeconds;
            if (timeElapsed > 15 )
                Console.WriteLine("Received update for {2} {0} sec late, after {1} seconds", updateAge, timeElapsed, FlightPlanCallsign);
        }
        public void SetLocation (double Latitude, double Longitude, DateTime SetTime)
        {
            var location = new GeoPoint(Latitude, Longitude);
            SetLocation(location, SetTime);
        }
        public void SetTrack (double Track, DateTime SetTime)
        {
            if (lastTrackUpdate > SetTime)
                return;
            var diff = Track - this.Track;
            if (Math.Abs(diff) > 180)
            {
                if (diff > 0)
                    diff = 360 - diff;
                else
                    diff += 360;
            }
            var seconds = (SetTime - lastTrackUpdate).TotalSeconds;
            this.Track = (int)Track;
            if (seconds == 0)
                return;
            rateofturn = diff / seconds;

            lastTrackUpdate = SetTime;
        }
        public double Bearing(GeoPoint FromPoint)
        {
            if (Location == null)
                return 0;
            double λ2 = Longitude * (Math.PI / 180);
            double λ1 = FromPoint.Longitude * (Math.PI / 180);
            double φ2 = Latitude * (Math.PI / 180);
            double φ1 = FromPoint.Latitude * (Math.PI / 180);

            double y = Math.Sin(λ2 - λ1) * Math.Cos(φ2);
            double x = Math.Cos(φ1) * Math.Sin(φ2) -
                      Math.Sin(φ1) * Math.Cos(φ2) * Math.Cos(λ2 - λ1);
            double θ = Math.Atan2(y, x);
            //θ = (Math.PI / 2) - θ;
            var bearing = (θ * 180 / Math.PI + 360) % 360; // in degrees
            return bearing;
        }

        public double Distance(GeoPoint FromPoint)
        {
            if (Location == null)
                return 0;
            double R = 3443.92; // nautical miles
            double φ1 = Latitude * Math.PI / 180; // φ, λ in radians
            double φ2 = FromPoint.Latitude * Math.PI / 180;
            double Δφ = (FromPoint.Latitude - Latitude) * Math.PI / 180;
            double Δλ = (FromPoint.Longitude - Longitude) * Math.PI / 180;

            double a = Math.Sin(Δφ / 2) * Math.Sin(Δφ / 2) +
                      Math.Cos(φ1) * Math.Cos(φ2) *
                      Math.Sin(Δλ / 2) * Math.Sin(Δλ / 2);
            double c = 2 * Math.Atan2(Math.Sqrt(a), Math.Sqrt(1 - a));

            double alt = TrueAltitude / 6076.12;


            double dist = Math.Sqrt((R * c) * (R * c) + (alt * alt)); // in nautical miles
            return dist;
        }

        public PrimaryReturn TargetReturn = new PrimaryReturn() { BackColor = Color.Transparent, ForeColor = Color.Lime };
        public PrimaryReturn[] History = new PrimaryReturn[10];
        public ConnectingLineF ConnectingLine = new ConnectingLineF() { };

        public TransparentLabel DataBlock = new TransparentLabel()
        {
            //ForeColor = Color.Lime,
            //BackColor = Color.Transparent,
            AutoSize = true
        };
        public TransparentLabel DataBlock2 = new TransparentLabel()
        {
            //ForeColor = Color.Lime,
            //BackColor = Color.Transparent,
            AutoSize = true
        };
        public TransparentLabel DataBlock3 = new TransparentLabel()
        {
            AutoSize = true
        };

        // Alert/SPC line shown above the first data-block line. Two labels because a
        // single line mixes red (CA/LA/HJ/RF/EM/MI/LL) and yellow (OD/ME/MF/LN) codes.
        public TransparentLabel AlertLabelRed = new TransparentLabel()
        {
            TextAlign = ContentAlignment.MiddleLeft,
            AutoSize = true
        };
        public TransparentLabel AlertLabelYellow = new TransparentLabel()
        {
            TextAlign = ContentAlignment.MiddleLeft,
            AutoSize = true
        };

        public TransparentLabel PositionIndicator = new TransparentLabel()
        {
            TextAlign = ContentAlignment.MiddleCenter,
            Text = "*",
            AutoSize = true
        };

        public void Dispose()
        {
            DataBlock.Dispose();
            TargetReturn.Dispose();
        }

        private int dbAlt, dbSpeed = 0;
        public LeaderDirection LastDrawnDirection;
        // True when the data block is right-justified (leader W/NW/SW); the alert line
        // matches this so it stays anchored to the data block's shifted edge.
        public bool LastDataBlockRightJustified;

        public void RedrawDataBlock(Radar radar, LeaderDirection? leaderDirection = null)
        {
            if (Callsign == null)
                Callsign = string.Empty;
            if (leaderDirection != null)
            {

            }
            else if (LDRDirection != null)
            {
                leaderDirection = LDRDirection.Value;
            }
            else if (OwnerLeaderDirection != null && Owned)
            {
                leaderDirection = OwnerLeaderDirection.Value;
            }
            if (leaderDirection != null)
            {
                LastDrawnDirection = leaderDirection.Value;
            }
            // The data block is right-justified (PadLeft) for W/NW/SW, left-justified
            // otherwise. The alert line aligns to match, so capture it here.
            LastDataBlockRightJustified = leaderDirection == LeaderDirection.W
                || leaderDirection == LeaderDirection.NW
                || leaderDirection == LeaderDirection.SW;
            string oldtext = DataBlock.Text;
            string oldtext2 = DataBlock2.Text;
            string oldtext3 = DataBlock3.Text;
            DataBlock.Text = "";
            DataBlock2.Text = "";
            DataBlock3.Text = "";
            string altstring;
            if (Altitude != null && Altitude.AltitudeType != AltitudeType.Unknown)
            {
                if (dbAlt % 100 > 50)
                    dbAlt = ((dbAlt / 100) * 100) + 100;
                altstring = (dbAlt / 100).ToString("D3");
            }
            else
            {
                altstring = "RDR";
            }
            dbAlt = SweptAltitude(radar);
            if (dbAlt % 100 > 50)
                dbAlt = ((dbAlt / 100) * 100) + 100;
            dbSpeed = SweptSpeed(radar);
            
            string vfrchar = " ";
            string catchar = " ";
            string handoffchar = " ";
            if (!string.IsNullOrEmpty(PendingHandoff))
                handoffchar = PendingHandoff.Substring(PendingHandoff.Length - 1);

            if (string.IsNullOrEmpty(FlightRules))
            {
                vfrchar = " ";
            }
            else if (FlightRules[0] == 'I')
            {
                vfrchar = " ";
            }
            else
            {
                vfrchar = FlightRules[0].ToString();
            }
            if (Ident)
            {
                vfrchar = "I";
                catchar = "D";
            }
            else if (!string.IsNullOrEmpty(Category))
            {
                catchar = Category;
            }
            string destination = "   ";
            string type = "    ";
            string yscratch = "   ";
            string yscratch2;
            string reqalt = "    ";

            if (string.IsNullOrEmpty(Destination))
            {
                destination = altstring;
            }
            else if (Destination.Trim() != "" && Destination != "unassigned")
            {
                destination = Destination.PadRight(3);
            }
            else
            {
                if (dbAlt % 100 > 50)
                    dbAlt = ((dbAlt / 100) * 100) + 100; 
                destination = (dbAlt / 100).ToString("D3");
            }
            
            if (!string.IsNullOrEmpty(Scratchpad))
            {
                yscratch = Scratchpad.PadRight(3);
            }
            else
            {
                yscratch = destination;
            }

            if (!string.IsNullOrEmpty(Scratchpad2))
            {
                yscratch2 = Scratchpad2.PadRight(3) + "+";
            }
            else if (!string.IsNullOrEmpty(Scratchpad))
            {
                yscratch2 = Scratchpad.PadRight(3);
            }
            else
            {
                yscratch2 = destination;
            }

            if (string.IsNullOrEmpty(Type))
            {
                type = (dbSpeed / 10).ToString("D2") + vfrchar + catchar;
            }
            else if (Type.Trim() != "")
            {
                type = Type.PadRight(4);
            }
            else
            {
                type = (dbSpeed / 10).ToString("D2") + vfrchar + catchar;
            }

            if (RequestedAltitude > 0)
            {
                reqalt = "R" + (RequestedAltitude / 100).ToString("D3");
            }
            else
            {
                reqalt = type;
            }

            string fdb1line2 = altstring + handoffchar + (dbSpeed / 10).ToString("D2") + vfrchar + catchar + " ";
            string fdb2line2 = yscratch + handoffchar + reqalt + " ";
            string fdb3line2;
            if (string.IsNullOrEmpty(yscratch2))
                fdb3line2 = yscratch + handoffchar + type + " ";
            else if (yscratch2.Length == 4)
                fdb3line2 = yscratch2 + type;
            else
                fdb3line2 = yscratch2 + handoffchar + type + " ";

            

            if (FDB || ShowCallsignWithNoSquawk)
            {
                if (!string.IsNullOrEmpty(FlightPlanCallsign) && !ShowCallsignWithNoSquawk)
                {
                    // An asterisk after the aircraft ID marks an MSAW-inhibited track:
                    // VFR tracks are automatically inhibited, plus any manual inhibit
                    // (F7 V/Q <slew>).
                    string acid = FlightPlanCallsign;
                    if (IsMSAWInhibited)
                        acid += "*";
                    if (leaderDirection == LeaderDirection.W ||
                leaderDirection == LeaderDirection.NW ||
                leaderDirection == LeaderDirection.SW)
                    {
                        DataBlock.Text = acid.PadLeft(9);
                        DataBlock2.Text = acid.PadLeft(9);
                        DataBlock3.Text = acid.PadLeft(9);
                    }
                    else
                    {
                        DataBlock.Text = acid.PadRight(9);
                        DataBlock2.Text = acid.PadRight(9);
                        DataBlock3.Text = acid.PadRight(9);
                    }
                }
                else if (Squawk != null)
                {
                    if (leaderDirection == LeaderDirection.W ||
                leaderDirection == LeaderDirection.NW ||
                leaderDirection == LeaderDirection.SW)
                    {
                        DataBlock.Text = Squawk.PadLeft(9);
                        DataBlock2.Text = Squawk.PadLeft(9);
                        DataBlock3.Text = Squawk.PadLeft(9);
                    }
                    else
                    {
                        DataBlock.Text = Squawk.PadRight(9);
                        DataBlock2.Text = Squawk.PadRight(9);
                        DataBlock3.Text = Squawk.PadRight(9);
                    }
                }
                else
                {
                    DataBlock.Text = "";
                    DataBlock2.Text = "";
                    DataBlock3.Text = "";
                }
                
                DataBlock.Text += "\r\n";
                DataBlock2.Text += "\r\n";
                DataBlock3.Text += "\r\n";

                if (FDB)
                {
                    DataBlock.Text += fdb1line2;
                    DataBlock2.Text += fdb2line2;
                    DataBlock3.Text += fdb3line2;
                    string assigned = "";
                    if (!string.IsNullOrEmpty(AssignedSquawk))
                        assigned = AssignedSquawk.PadLeft(4, '0');
                    if (!string.IsNullOrEmpty(assigned) && Squawk != assigned)
                    {
                        DataBlock.Text += "\r\n" + Squawk + " " + assigned;
                        DataBlock2.Text += "\r\n" + Squawk + " " + assigned;
                        DataBlock3.Text += "\r\n" + Squawk + " " + assigned;
                    }
                    else if (ATPAMileageNow != null)
                    {
                        var miles = (double)ATPAMileageNow;
                        DataBlock.Text += "\r\n" + miles.ToString("0.00");
                        DataBlock2.Text += "\r\n" + miles.ToString("0.00");
                        DataBlock3.Text += "\r\n" + miles.ToString("0.00");
                    }
                    else
                    {
                        DataBlock.Text += "\r\n ";
                        DataBlock2.Text += "\r\n ";
                        DataBlock3.Text += "\r\n ";
                    }
                }
                else
                {
                    if (leaderDirection == LeaderDirection.W ||
                leaderDirection == LeaderDirection.NW ||
                leaderDirection == LeaderDirection.SW)
                    {
                        DataBlock.Text += (altstring + handoffchar + vfrchar + catchar).PadLeft(9);
                        DataBlock2.Text += (yscratch.PadRight(3) + handoffchar + vfrchar + catchar).PadLeft(9);
                        DataBlock3.Text += (yscratch.PadRight(3) + handoffchar + vfrchar + catchar).PadLeft(9);
                    }
                    else
                    {
                        DataBlock.Text += altstring + handoffchar + vfrchar + catchar;
                        DataBlock2.Text += yscratch.PadRight(3) + handoffchar + vfrchar + catchar;
                        DataBlock3.Text += yscratch.PadRight(3) + handoffchar + vfrchar + catchar;
                    }
                }
                if (ShowCallsignWithNoSquawk && Callsign != null && !Associated)
                {
                    var cs = Callsign;
                    if (leaderDirection == LeaderDirection.W ||
                leaderDirection == LeaderDirection.NW ||
                leaderDirection == LeaderDirection.SW)
                    {
                        DataBlock.Text += "\r\n" + cs.PadLeft(9);
                        DataBlock2.Text += "\r\n" + cs.PadLeft(9);
                        DataBlock3.Text += "\r\n" + cs.PadLeft(9);
                    }
                    else
                    {
                        DataBlock.Text += "\r\n" + cs.PadRight(9);
                        DataBlock2.Text += "\r\n" + cs.PadRight(9);
                        DataBlock3.Text += "\r\n" + cs.PadRight(9);
                    }
                }
                else if (DataBlock.Text.Split('\n').Length < 3)
                {
                    DataBlock.Text += "\r\n ";
                    DataBlock2.Text += "\r\n ";
                    DataBlock3.Text += "\r\n ";
                }
            }
            else
            {
                //This is an LDB
                if (LdbBeaconCodesInhibited && !ShowCallsignWithNoSquawk)
                {
                    // BCB INH: single line, altitude only
                    DataBlock.Text = altstring + handoffchar + vfrchar + catchar + "\r\n     \r\n     ";
                    DataBlock2.Text = yscratch.PadRight(3) + handoffchar + vfrchar + catchar + "\r\n     \r\n     ";
                    DataBlock3.Text = yscratch.PadRight(3) + handoffchar + vfrchar + catchar + "\r\n     \r\n     ";
                }
                else if (ShowCallsignWithNoSquawk)
                {
                    // F1 beacon readout: show all 3 lines (squawk + altitude + callsign)
                    string squawkLine = !string.IsNullOrEmpty(Squawk) ? Squawk : "";
                    string csLine = !string.IsNullOrEmpty(Callsign) ? Callsign : "";
                    if (leaderDirection == LeaderDirection.W ||
                        leaderDirection == LeaderDirection.NW ||
                        leaderDirection == LeaderDirection.SW)
                    {
                        DataBlock.Text = squawkLine.PadLeft(9) + "\r\n" + (altstring + handoffchar + vfrchar + catchar).PadLeft(9) + "\r\n" + csLine.PadLeft(9);
                        DataBlock2.Text = squawkLine.PadLeft(9) + "\r\n" + (yscratch.PadRight(3) + handoffchar + vfrchar + catchar).PadLeft(9) + "\r\n" + csLine.PadLeft(9);
                        DataBlock3.Text = squawkLine.PadLeft(9) + "\r\n" + (yscratch.PadRight(3) + handoffchar + vfrchar + catchar).PadLeft(9) + "\r\n" + csLine.PadLeft(9);
                    }
                    else
                    {
                        DataBlock.Text = squawkLine.PadRight(9) + "\r\n" + altstring + handoffchar + vfrchar + catchar + "\r\n" + csLine.PadRight(9);
                        DataBlock2.Text = squawkLine.PadRight(9) + "\r\n" + yscratch.PadRight(3) + handoffchar + vfrchar + catchar + "\r\n" + csLine.PadRight(9);
                        DataBlock3.Text = squawkLine.PadRight(9) + "\r\n" + yscratch.PadRight(3) + handoffchar + vfrchar + catchar + "\r\n" + csLine.PadRight(9);
                    }
                }
                else
                {
                    // Normal LDB: beacon code + altitude (2 lines)
                    string squawkLine = !string.IsNullOrEmpty(Squawk) ? Squawk : "";
                    if (leaderDirection == LeaderDirection.W ||
                        leaderDirection == LeaderDirection.NW ||
                        leaderDirection == LeaderDirection.SW)
                    {
                        DataBlock.Text = squawkLine.PadLeft(9) + "\r\n" + (altstring + handoffchar + vfrchar + catchar).PadLeft(9) + "\r\n     ";
                        DataBlock2.Text = squawkLine.PadLeft(9) + "\r\n" + (yscratch.PadRight(3) + handoffchar + vfrchar + catchar).PadLeft(9) + "\r\n     ";
                        DataBlock3.Text = squawkLine.PadLeft(9) + "\r\n" + (yscratch.PadRight(3) + handoffchar + vfrchar + catchar).PadLeft(9) + "\r\n     ";
                    }
                    else
                    {
                        DataBlock.Text = squawkLine.PadRight(9) + "\r\n" + altstring + handoffchar + vfrchar + catchar + "\r\n     ";
                        DataBlock2.Text = squawkLine.PadRight(9) + "\r\n" + yscratch.PadRight(3) + handoffchar + vfrchar + catchar + "\r\n     ";
                        DataBlock3.Text = squawkLine.PadRight(9) + "\r\n" + yscratch.PadRight(3) + handoffchar + vfrchar + catchar + "\r\n     ";
                    }
                }
            }

            // Alert/SPC codes (CA/LA/HJ/RF/EM/MI/LL/OD/ME/MF/LN) are rendered on a
            // separate line above the data block (see RadarWindow alert-label drawing),
            // not inside the data block text.

            if (!string.IsNullOrEmpty(PositionInd))
                PositionIndicator.Text = PositionInd.Substring(PositionInd.Length - 1);
            else if (isSquawkSelected())
                PositionIndicator.Text = selectedSquawkChar.ToString();
            else if (Squawk == "1200")
                PositionIndicator.Text = "V";
            else if (PrimaryOnly)
                PositionIndicator.Text = "◇";
            else
                PositionIndicator.Text = "*";
        }

        private List<string> selectedSquawks;
        private char selectedSquawkChar;
        public void SetSelectedSquawkList(List<string> selectedSquawks, char selectedChar)
        {
            this.selectedSquawks = selectedSquawks;
            this.selectedSquawkChar = selectedChar;
        }
        private bool isSquawkSelected()
        {
            if (selectedSquawks == null || Squawk == null)
                return false;
            foreach (string squawk in selectedSquawks)
            {
                if (Squawk.StartsWith(squawk))
                    return true;
            }
            return false;
        }
        public void OldRedrawDataBlock(bool updatepos = false)
        {
            if (updatepos || dbAlt == 0 || dbSpeed == 0)
            {
                dbAlt = TrueAltitude;
                if (dbAlt % 100 > 50)
                    dbAlt = ((dbAlt / 100) * 100) + 100;
                dbSpeed = GroundSpeed;
            }
            string vrchar = " ";
            if (PendingHandoff != null)
                if (PendingHandoff != PositionInd)
                    vrchar = PendingHandoff.Substring(PendingHandoff.Length - 1);
            var oldtext = DataBlock.Text;
            var oldtext2 = DataBlock.Text;

            string field1 = "";
            if (Scratchpad != null)
            {
                field1 = Scratchpad;
            }
            else if (Runway != null)
            {
                if (Runway != "NNNN")
                    field1 = Runway;
            }
            if (field1.Trim() == "" && Destination != null)
            {
                if (Destination != "unassigned")
                    field1 = Destination;
            }

            if (field1.Trim() == "")
            {
                if (dbAlt % 100 > 50)
                    dbAlt = ((dbAlt / 100) * 100) + 100; 
                field1 = (dbAlt / 100).ToString("D3");
            }

            field1 = field1.Trim();
            string field2 = "";
            if (Type == null && Scratchpad2 == null)
                field2 = (dbSpeed / 10).ToString("D2");
            else if (Scratchpad2 != null)
                field2 = Scratchpad2;
            else
                field2 = Type;
            field2 = field2.Trim();



            DataBlock.Text = "";
            if (Squawk == "7700")
                DataBlock.Text += "EM" + "\r\n";
            else if (Squawk == "7600")
                DataBlock.Text += "RF" + "\r\n";
            if (Callsign != null && fdb() && ((Squawk != "1200" && Squawk != null) || ShowCallsignWithNoSquawk || !(PositionInd == null || PositionInd == "*")))
                DataBlock.Text += Callsign + "\r\n";
            else if (Squawk == "1200" && fdb())
                DataBlock.Text = "1200\r\n";
            DataBlock2.Text = DataBlock.Text;
            if (!fdb())
            {
                if (dbAlt % 100 > 50)
                    dbAlt = ((dbAlt / 100) * 100) + 100; 
                DataBlock.Text = (dbAlt / 100).ToString("D3");
                DataBlock2.Text = field1;
            }
            else
            {
                if (dbAlt % 100 > 50)
                    dbAlt = ((dbAlt / 100) * 100) + 100; 
                DataBlock.Text += (dbAlt / 100).ToString("D3") + vrchar + (dbSpeed / 10).ToString("D2");
                DataBlock2.Text += field1 + vrchar + field2;
            }
            if (Squawk == "1200" || (FlightRules != "IFR" && FlightRules != null))
            {
                if (DataBlock2.Text == DataBlock.Text)
                    DataBlock2.Text += "V ";
                DataBlock.Text += "V";
            }
            if (fdb())
                DataBlock.Text += " " + Category;
            if (Ident)
            {
                DataBlock2.Text += "ID";
                DataBlock.Text += "ID";
            }
            if (PositionInd != null)
                PositionIndicator.Text = PositionInd.Substring(PositionInd.Length - 1);
            else
                PositionIndicator.Text = "*";
        }
        public void DropTrack()
        {
            Dropped?.Invoke(this, new EventArgs());
        }
        public void DeleteFP()
        {
            /*Type = null;
            FlightPlanCallsign = null;
            Destination = null;
            FlightRules = null;
            Category = null;
            PositionInd = null;
            PendingHandoff = null;
            RequestedAltitude = 0;
            Scratchpad = null;
            Scratchpad2 = null;
            Owned = false;
            QuickLook = false;
            QuickLookPlus = false;
            LDRDirection = null;
            Runway = null;
            */
            FpDeleted?.Invoke(this, new EventArgs());
        }
        public void RedrawTarget(GeoPoint Location, Radar radar)
        {
            TargetReturn.GeoLocation = Location;
            TargetReturn.LastDrawnRange = 0;
            //if (LocationF.X != 0 || LocationF.Y != 0)
            //{
                //TargetReturn.Angle = Location.BearingTo(LocationReceivedBy.Location);
                PositionIndicator.CenterOnPoint(LocationF);
                RedrawDataBlock(radar);
                TargetReturn.Intensity = 1;
                Drawn = false;
                LocationUpdated?.Invoke(this, new UpdatePositionEventArgs(this, Location));
            //}
        }

        public GeoPoint SweptLocation(Radar radar)
        {
            if (!PrimaryOnly)
            {
                lock(SweptLocations)
                    if (SweptLocations.ContainsKey(radar))
                    {
                        return SweptLocations[radar];
                    }
                    else
                    {
                        return null;
                    }
            }
            else
            {
                return Location;
            }
        }

        public int SweptTrack(Radar radar)
        {
            if (!PrimaryOnly)
            {
                lock (SweptTracks)
                    if (SweptTracks.ContainsKey(radar))
                    {
                        return SweptTracks[radar];
                    }
                    else
                    {
                        return Track;
                    }
            }
            else
            {
                return Track;
            }
        }
        public int SweptAltitude(Radar radar)
        {
            if (!PrimaryOnly)
            {
                lock (SweptAltitudes)
                    if (SweptAltitudes.ContainsKey(radar))
                    {
                        return SweptAltitudes[radar];
                    }
                    else
                    {
                        return PressureAltitude;
                    }
            }
            else
            {
                return PressureAltitude;
            }
        }

        public int SweptSpeed(Radar radar)
        {
            if (!PrimaryOnly)
            {
                lock (SweptSpeeds)
                    if (SweptSpeeds.ContainsKey(radar))
                    {
                        return SweptSpeeds[radar];
                    }
                    else
                    {
                        return GroundSpeed;
                    }
            }
            else
            {
                return GroundSpeed;
            }
        }

        public PrimaryReturn[] SweptHistory(Radar radar)
        {
            lock(SweptHistories)
                if (SweptHistories.ContainsKey(radar))
                {
                    return SweptHistories[radar];
                }
                else
                {
                    return History;
                }
        }

        public double ExtrapolateTrack(DateTime time)
        {
            if (Math.Abs(rateofturn) > 5) // sanity check
            {
                return Track;
            }
            return ((Track + ((rateofturn / 2) * (time - lastTrackUpdate).TotalSeconds)) + 360) % 360;
        }

        public double ExtrapolateTrack()
        {
            return ExtrapolateTrack(RadarWindow.CurrentTime);
        }

        public GeoPoint ExtrapolatePosition(DateTime time)
        {
            var miles = GroundSpeed * (time - lastLocationExtrapolateTime).TotalHours;
            var track = ExtrapolateTrack();
            var location = extrapolatedpos.FromPoint(miles, track);
            extrapolatedpos = location;
            lastLocationExtrapolateTime = time;
            return location;
        }
        public GeoPoint ExtrapolatePosition()
        {
            return ExtrapolatePosition(RadarWindow.CurrentTime);
        }

        public Dictionary<Radar, GeoPoint> SweptLocations = new Dictionary<Radar, GeoPoint>();
        public Dictionary<Radar, int> SweptTracks = new Dictionary<Radar, int>();
        public Dictionary<Radar, int> SweptAltitudes = new Dictionary<Radar, int>();
        public Dictionary<Radar, int> SweptSpeeds = new Dictionary<Radar, int>();
        public Dictionary<Radar, PrimaryReturn[]> SweptHistories = new Dictionary<Radar, PrimaryReturn[]>();
        public Dictionary<Radar, DateTime> LastHistoryTimes = new Dictionary<Radar, DateTime>();
        public override string ToString()
        {
            return Callsign;
        }

        public event EventHandler<UpdatePositionEventArgs> LocationUpdated;
        public event EventHandler<HandoffEventArgs> HandoffInitiated;
        public event EventHandler<HandoffEventArgs> HandedOff;
        // Fires whenever PositionInd transitions from one non-null/non-empty
        // value to another. Used for the CRC STARS outbound-complete blink.
        public event EventHandler<HandoffEventArgs> Transferred;
        public event EventHandler Created;
        public event EventHandler<AircraftEventArgs> OwnershipChange;
        public event EventHandler Dropped;
        public event EventHandler FpDeleted;
        public event EventHandler Update;
        //public event EventHandler Tracked;
        //public event EventHandler Idented;

    }

    public class HandoffEventArgs : AircraftEventArgs
    {
        public string? PositionFrom { get; private set; }
        public string PositionTo { get; private set; }
        public HandoffEventArgs(Aircraft Aircraft, string to, string from = null) :base(Aircraft)
        {
            PositionFrom = from;
            PositionTo = to;
        }
    }
    public class UpdatePositionEventArgs : AircraftEventArgs
    {
        public GeoPoint Location { get; private set; }
        //public bool Intrafacility { get; private set; }
        public UpdatePositionEventArgs(Aircraft Aircraft, GeoPoint Location, bool intrafacility = false) : base(Aircraft)
        {
            this.Location = Location;
            //Intrafacility = intrafacility;
        }
    }

    
    public class AircraftEventArgs : EventArgs
    {
        public Aircraft Aircraft { get; set; }
        public DateTime Time { get; private set; }
        public AircraftEventArgs(Aircraft Aircraft)
        {
            this.Aircraft = Aircraft;
            Time = RadarWindow.CurrentTime;
        }
    }
}
