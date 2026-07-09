    // ==== ProcessCommand — ported 1:1 from RadarWindow.cs 1548-2879 (accumulated across iterations) ====
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
