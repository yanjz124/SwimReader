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
                // ==== WIP boundary: source line ~2062. Next: case Key.F7 (Multifunction) onward ====
