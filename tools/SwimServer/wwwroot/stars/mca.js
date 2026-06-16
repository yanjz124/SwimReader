// ─────────────────────────────────────────────────────────────────────────────
// STARS MCA (Message Composition Area) and Preview Area — Phase 5.
//
// Sources of truth:
//   • scope/RadarWindow.cs:1417-2900   — ProcessCommand giant switch
//   • scope/RadarWindow.cs:742-748     — PreviewArea + StatusArea label model
//   • scope/RadarWindow.cs:970-971     — KeyDown / KeyPress wiring
//   • scope/RadarWindow.cs:2920-2945   — PreviewArea render
//   • CRC docs § Command Reference     — full keybinding table & dot commands
//
// All keybindings here mirror the CRC table verbatim. F-key prefixes insert
// the command prefix into the preview buffer; subsequent keystrokes complete
// the command and Enter executes.
// ─────────────────────────────────────────────────────────────────────────────

const MCA = {
  buffer: "",          // current preview-area input
  response: "",        // last system response shown to user
  responseColor: null,
  clickedPlane: null,  // the aircraft last left-clicked (for "+ click" commands)
};

// STARS F-key prefixes — real STARS keyboards have dedicated function keys for
// these operations. CRC simulates them via F-key mappings, and DGScope's
// Window_KeyDown (RadarWindow.cs:3271-3450) wires each F-key to a KeyCode
// enum value (RadarWindow.cs:1395-1409). The preview text rendered for each
// KeyCode comes from GeneratePreviewString (RadarWindow.cs:3190-3240).
//
//   F1  — Beacon Code Readout (hold-to-show, no prefix inserted)
//   F2  — Track Reposition (RP per CRC docs)
//   F3  — INIT CNTL → "IC" preview text
//   F4  — TERM CNTL → "TC" preview text
//   F5  — HND OFF  → "HO" preview text
//   F6  — FLT DATA → "FD" preview text  (CRC docs call it "DA"; WPF code says FD)
//   F7  — MULTI FUNC → "F" preview text
//   F9  — VFR PLAN  → "VP" preview text
//   F11 — CA (Conflict Alert)
//
// NOTE: previous ERAM-style mappings (QF, QP, QX, QZ, QU, QL, QQ, QB, QS) were
// wrong - those are ERAM commands, NOT STARS. Removed entirely.
const FKEY_PREFIX = {
  F2:  "RP",
  F3:  "IC",
  F4:  "TC",
  F5:  "HO",
  F6:  "FD",
  F7:  "F",
  F9:  "VP",
  F11: "CA",
};

// Ctrl+F-key bindings per CRC docs.
//   Ctrl+F1: Re-center scope
//   Ctrl+F2: Open MAPS submenu
//   Ctrl+F3: Open BRITE submenu
//   Ctrl+F7: Toggle DCB menu position
//   Ctrl+F8: Toggle DCB visible
const FKEY_CTRL_ACTION = {
  F1: "recenter",
  F2: "open-maps",
  F3: "open-brite",
  F7: "dcb-position",
  F8: "dcb-visible",
};

// ── Wiring ──────────────────────────────────────────────────────────────────
function mountMca() {
  // Preview area + status area DOM (positioned per PrefSet.PreviewAreaLocation
  // in the WPF; web port renders bottom-left for now — exact corner is
  // user-configurable via dot command later).
  const pa = document.createElement("div");
  pa.id = "mca";
  pa.style.cssText = `
    position:fixed; left:8px; bottom:8px;
    background:transparent; color:#0f0;
    font-family:FixedDemiBold, ui-monospace, monospace; font-size:13px;
    padding:4px 8px; min-width:240px;
    z-index:18;
    white-space:pre; line-height:1.3;
  `;
  document.body.appendChild(pa);

  document.addEventListener("keydown", onKeyDown);
  // F1 release - clear hold-to-show-all-callsigns (RadarWindow.cs:3444-3450).
  document.addEventListener("keyup", (e) => {
    if (e.key === "F1") window.showAllCallsigns = false;
  });
  // End-key Min Sep tool (RadarWindow.cs:2579-2605).
  // 1st End on plane = arm with that plane as Plane1.
  // 2nd End on plane = commit MinSep(Plane1, Plane2). End with no clicked + Enter clears.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "End") return;
    e.preventDefault();
    const ms = window.starsState.minSeps ||= [];
    const clicked = MCA.clickedPlane;
    if (clicked) {
      window.starsState.tempLine = null;
      if (!window.starsState.tempMinSep) {
        window.starsState.tempMinSep = { plane1: clicked, plane2: null };
      } else {
        ms.push({ plane1: window.starsState.tempMinSep.plane1, plane2: clicked });
        window.starsState.tempMinSep = null;
      }
    } else {
      // No clicked plane + End = clear all min seps
      ms.length = 0;
      window.starsState.tempMinSep = null;
    }
  });
  refreshMca();
}

function refreshMca() {
  const el = document.getElementById("mca");
  if (!el) return;
  const cursor = "_";
  // RadarWindow.cs:2918-2945: PreviewArea + response both render as
  // DataBlockColor (green) modulated by Brightness.Lists. Errors do NOT
  // change color in WPF — they just set the message. We follow that.
  el.innerHTML =
    `<div>${MCA.response || ""}</div>` +
    `<div>${MCA.buffer}${cursor}</div>`;
  if (window.prefSet) {
    const b = window.prefSet.Brightness.Lists / 100;
    el.style.color = `rgb(0, ${(255 * b) | 0}, 0)`;
    el.style.fontSize = (window.prefSet.CharSize?.Lists ?? 13) + "px";
  }
}

function onKeyDown(e) {
  // Ignore typing inside text inputs (none currently, but defensive).
  if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;

  // STARS F-key handling per CRC docs / RadarWindow.cs Window_KeyDown.
  if (e.key && /^F\d+$/.test(e.key)) {
    e.preventDefault();
    const k = e.key.toUpperCase();
    // Ctrl+F-keys are scope-control shortcuts, not preview prefixes.
    if (e.ctrlKey) {
      const action = FKEY_CTRL_ACTION[k];
      if (!action) return;
      if (action === "recenter" && typeof window.recenterScope === "function") {
        window.recenterScope();
      } else if (action === "open-maps" && window.dcb) {
        window.dcb.popout = "MAPS"; window.dcb.popoutAnchorId = "MAPS"; window.dcb.render();
      } else if (action === "open-brite" && window.dcb) {
        window.dcb.popout = "BRITE"; window.dcb.popoutAnchorId = "BRITE"; window.dcb.render();
      } else if (action === "dcb-visible" && window.prefSet) {
        window.prefSet.DCBVisible = !window.prefSet.DCBVisible;
        const root = document.getElementById("dcb");
        if (root) root.style.display = window.prefSet.DCBVisible ? "" : "none";
      }
      return;
    }
    // F1 is hold-to-show-all-callsigns - no preview prefix (RadarWindow.cs:3421).
    // Just clear preview and set the flag.
    if (k === "F1") {
      window.showAllCallsigns = true;
      return;
    }
    // Other F-keys insert the STARS preview text from the KeyCode table.
    const prefix = FKEY_PREFIX[k];
    if (prefix) {
      MCA.buffer = prefix + " ";
      refreshMca();
    }
    return;
  }

  if (e.key === "Enter") {
    e.preventDefault();
    executeCommand(MCA.buffer.trim());
    MCA.buffer = "";
    refreshMca();
    return;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    MCA.buffer = "";
    refreshMca();
    return;
  }
  if (e.key === "Backspace") {
    e.preventDefault();
    MCA.buffer = MCA.buffer.slice(0, -1);
    refreshMca();
    return;
  }
  // Printable
  if (e.key.length === 1) {
    e.preventDefault();
    MCA.buffer += e.key.toUpperCase();
    refreshMca();
    return;
  }
}

// ── Command execution ──────────────────────────────────────────────────────
//
// Strict port of scope/RadarWindow.cs ProcessCommand (lines 1417-2900). Every
// branch cites its WPF line. ERAM-style Q-prefixes from earlier phases are
// removed entirely - those were wrong, STARS commands look nothing like ERAM.
//
// LEADER-DIRECTION KEY MAP (per RadarWindow.cs:1505-1593, numeric keypad):
//   1=NW   2=N   3=NE         (InvertKeyboard swaps 1/7, 2/8, 3/9)
//   4=W    5=clear  6=E
//   7=SW   8=S   9=SE
//
// PREVIEW MESSAGES (WPF DisplayPreviewMessage strings, RadarWindow.cs):
//   "ILL TRK"   — illegal action on track (not owned, pending handoff)
//   "ILL FNCT"  — illegal function (no TPA, ATPA not active, etc.)
//   "ILL POS"   — illegal position (empty TCP, etc.)
//   "ILL VOL"   — illegal volume (ATPA volume not found)
//   "FORMAT"    — bad command format
//   "NO FLIGHT" — no clicked aircraft for command
//   "NO TRK"    — no track (similar to ILL TRK)
//   "NO CHANGE" — state already matches requested
//
// IMPORTANT: This is a partial port. Sections marked TODO(test-in-crc) need
// you to test the WPF/CRC behavior so we can match it exactly.

function setResponse(msg) {
  // RadarWindow.cs:2937-2940: SetPreviewMessage stores text + expiry timestamp;
  // colour does NOT change. 4-second auto-clear matches WPF default.
  MCA.response = msg;
  refreshMca();
  setTimeout(() => {
    if (MCA.response === msg) { MCA.response = ""; refreshMca(); }
  }, 4000);
}

// FLID resolution: callsign first, then assigned beacon code.
// Mirrors RadarWindow.cs:1483-1500 (lastline lookup).
function findAircraft(token) {
  if (!token) return null;
  const up = token.toUpperCase();
  for (const t of tracks.values()) {
    const fp = trackToFp.get(t.Guid);
    if (fp?.Callsign && fp.Callsign.trim().toUpperCase() === up) return t;
  }
  for (const t of tracks.values()) {
    if (t.Squawk && t.Squawk.trim() === token && t.Squawk !== "1200") return t;
  }
  return null;
}

// Map keypad digit 1-9 to LeaderDirection, honouring InvertKeyboard.
// Source: RadarWindow.cs:1505-1593.
function leaderDirFromDigit(d, invert = false) {
  if (d === "5") return null;   // 5 = clear
  if (d === "4") return "W";
  if (d === "6") return "E";
  if (d === "1") return invert ? "SW" : "NW";
  if (d === "2") return invert ? "S"  : "N";
  if (d === "3") return invert ? "SE" : "NE";
  if (d === "7") return invert ? "NW" : "SW";
  if (d === "8") return invert ? "N"  : "S";
  if (d === "9") return invert ? "NE" : "SE";
  return undefined;
}

// Helper: precondition check identical to WPF "!owned or pending handoff".
function illTrk(plane, fp) {
  if (!fp) return true;
  if (fp.PendingHandoff) return true;
  if (fp.PositionInd && window.ownTcp && fp.PositionInd !== window.ownTcp()) return true;
  return false;
}

// Execute a command string. `clickedPlane` is the aircraft last left-clicked
// (or null). `enter` distinguishes Enter-pressed (true) from click-executed
// (false) - matches the WPF `enter` flag (RadarWindow.cs:1421-1431).
function executeCommand(line, opts = {}) {
  const clicked = opts.clickedPlane || MCA.clickedPlane;
  const clickedplane = clicked != null;
  const enter = opts.enter !== false;     // default = Enter-key path

  // Implied command on aircraft click with empty buffer.
  // Full priority chain from ProcessImpliedCommand (RadarWindow.cs:2688-2769).
  if (!line && clickedplane) {
    return processImplied(clicked);
  }
  if (!line) return;

  // Parse: WPF splits on space char. Each `keys[i]` is a token; keys[0] is
  // the verb. RadarWindow.cs:1453-1481.
  const parts = line.split(/\s+/);
  const keys = parts.map(s => s.split(""));
  const first = keys[0]?.[0];
  if (first == null) return;

  // ── Single-digit leader direction on clicked target (1505-1593) ─────────
  if (keys[0].length === 1 && /^[1-9]$/.test(first)) {
    if (!clickedplane) return;
    const dir = leaderDirFromDigit(first, prefSet?.InvertKeyboard);
    if (dir !== undefined) clicked._leaderOverride = dir;
    return;
  }

  // ── F4 + clicked plane = drop flight plan (1604-1622) ───────────────────
  // (F4 here means the token was parsed as F4 KeyCode literal; in our port
  // the user gets here by typing 'TC' after pressing F4. We accept both.)
  if (first === "T" && keys[0].length === 2 && keys[0][1] === "C") {
    if (!clickedplane) { setResponse("NO FLIGHT"); return; }
    const fp = trackToFp.get(clicked.Guid);
    if (illTrk(clicked, fp)) { setResponse("ILL TRK"); return; }
    // Locally just hide; WPF calls plane.DeleteFP() which terminates the FP.
    tracks.delete(clicked.Guid);
    return;
  }

  // ── F12 → set ThisPositionIndicator (1623-1635). Typed as ".SO <tcp>". ──
  // (".SO *" clears to NONE; ".SO XX" sets to XX). This is our extension; WPF
  // uses the F12 dedicated key.
  if (first === "." && keys[0].length === 3 && keys[0][1] === "S" && keys[0][2] === "O") {
    const newpos = parts[1] || "";
    if (newpos === "*" || newpos === "") window.setOwnTcp?.("NONE");
    else window.setOwnTcp?.(newpos.toUpperCase());
    return;
  }

  // ── '*' splat commands (1636-1893) ──────────────────────────────────────
  if (first === "*") {
    return processSplat(keys[0], parts, clicked, clickedplane, enter);
  }

  // ── '.' clear scratchpad #1 on clicked plane (1894-1909) ────────────────
  if (first === "." && keys[0].length === 1 && clickedplane) {
    const fp = trackToFp.get(clicked.Guid);
    if (illTrk(clicked, fp)) { setResponse("ILL TRK"); return; }
    if (fp) fp.Scratchpad1 = "";
    return;
  }

  // ── '+' clear scratchpad #2 on clicked plane (1910-1925) ────────────────
  if (first === "+" && keys[0].length === 1 && clickedplane) {
    const fp = trackToFp.get(clicked.Guid);
    if (illTrk(clicked, fp)) { setResponse("ILL TRK"); return; }
    if (fp) fp.Scratchpad2 = "";
    return;
  }

  // ── F7 multifunction tree (1926-2577) ───────────────────────────────────
  // User typed "F " prefix (from F7 keypress) plus subcommand.
  if (first === "F" && (keys[0].length >= 2 || parts.length >= 2)) {
    return processMultifunction(keys[0], parts, clicked, clickedplane, enter);
  }

  // ── KeyCode commands the user can type explicitly ──────────────────────
  if (parts[0] === "RR")       return cmdRangeRings(parts);       // 2528-2541
  if (parts[0] === "WX")       return cmdWeather(parts);          // 2542-2557
  if (parts[0] === "RECENTER") return cmdRecenter(parts);         // 2558-2577

  // ── Default catchall on clicked plane (cs:2606-2683) ───────────────────
  if (clickedplane && keys[0].length >= 2 && keys[0].length <= 4) {
    return cmdDefaultClickedPlane(line, clicked);
  }

  // Unknown command path - WPF silently does nothing. Match that.
}

// ── '*' splat command tree (RadarWindow.cs:1636-1893) ─────────────────────
//   *B [E|I]    — DrawATPAMonitorCones toggle/enable/inhibit
//   *D+ [E|I]   — TPASize toggle/enable/inhibit (system-wide or per-plane)
//   *T          — TODO(test-in-crc)
//   *J          — TODO(test-in-crc) — J-ring radius prompt
//   *P          — TODO(test-in-crc)
//   **J / **P   — TODO(test-in-crc)
function processSplat(k, parts, clicked, clickedplane, enter) {
  if (k.length < 2) return;
  const sub = k[1];
  // *B (1641-1651): ATPA monitor cones
  if (sub === "B" && k.length === 3 && enter) {
    if (k[2] === "E") window.starsState.DrawATPAMonitorCones = true;
    else if (k[2] === "I") window.starsState.DrawATPAMonitorCones = false;
    return;
  }
  // *D+ (1652-1717): TPA size toggle/enable/inhibit
  if (sub === "D" && k.length >= 3 && k[2] === "+") {
    if (enter) {
      const v = window.starsState.TPASize;
      if (k.length === 3) window.starsState.TPASize = !v;
      else if (k[3] === "E") window.starsState.TPASize = true;
      else if (k[3] === "I") window.starsState.TPASize = false;
      else { setResponse("FORMAT"); return; }
    } else if (clickedplane) {
      const plane = clicked;
      if (!plane.TPA) { setResponse("ILL FNCT"); return; }
      if (k.length === 3) plane.TPA.ShowSize = !plane.TPA.ShowSize;
      else if (k[3] === "E") plane.TPA.ShowSize = true;
      else if (k[3] === "I") plane.TPA.ShowSize = false;
      else { setResponse("FORMAT"); return; }
    } else {
      setResponse("NO TRK");
    }
    return;
  }
  // *T  Range/Bearing Line tool (cs:1718-1801)
  //   click plane + *T               -> start RBL from plane to mouse
  //   *T then click plane            -> finalize end-plane
  //   *T<idx> enter                  -> remove RBL at index
  //   *T<waypoint> enter             -> new RBL from waypoint to mouse
  //   *T enter                       -> clear all RBLs
  //   click empty + *T               -> start RBL from clicked geo to mouse
  if (sub === "T") {
    const rbls = window.starsState.rangeBearingLines ||= [];
    if (clickedplane) {
      if (!window.starsState.tempLine) {
        window.starsState.tempLine = { startPlane: clicked, end: window.mouseGeo?.() };
        rbls.push(window.starsState.tempLine);
      }
      if (k.length > 2) {
        const entered = k.slice(1).join("").substring(1);
        const idx = parseInt(entered, 10);
        if (Number.isFinite(idx)) {
          if (idx <= rbls.length) rbls.splice(idx - 1, 1);
        } else {
          const wp = (window.starsWaypoints || []).find(w => w.id === entered);
          if (wp) window.starsState.tempLine.startGeo = { lat: wp.lat, lon: wp.lon };
        }
        window.starsState.tempLine.endPlane = clicked;
        window.starsState.tempLine = null;
      }
      return;
    }
    if (enter) {
      if (k.length === 2) { rbls.length = 0; return; }
      if (k.length > 2) {
        const entered = k.slice(2).join("");
        const idx = parseInt(entered, 10);
        if (Number.isFinite(idx)) {
          if (idx <= rbls.length) rbls.splice(idx - 1, 1);
        } else {
          const wp = (window.starsWaypoints || []).find(w => w.id === entered);
          if (wp) {
            window.starsState.tempLine = { startGeo: { lat: wp.lat, lon: wp.lon }, end: window.mouseGeo?.() };
            rbls.push(window.starsState.tempLine);
          }
        }
      }
      return;
    }
    if (!window.starsState.tempLine) {
      // Clicked empty location, start RBL from there
      window.starsState.tempLine = { startGeo: window.mouseGeo?.() };
      rbls.push(window.starsState.tempLine);
    }
    return;
  }
  // *J<miles>  + clicked plane (cs:1802-1828): J-Ring (TPA ring) of N miles
  //   no miles -> remove plane's TPA
  if (sub === "J") {
    if (!clickedplane) return;
    if (k.length >= 3 && k.length <= 5) {
      const miles = parseFloat(k.slice(2).join(""));
      if (!Number.isFinite(miles)) return;
      if (miles > 0 && miles <= 30) {
        clicked.TPA = { type: "JRing", miles, color: "#0f0", showSize: window.starsState.TPASize };
      } else {
        setResponse("FORMAT");
      }
    } else {
      clicked.TPA = null;
    }
    return;
  }
  // *P<miles>  + clicked plane (cs:1829-1858): P-Cone (predictive cone)
  if (sub === "P") {
    if (!clickedplane) { setResponse("NO TRK"); return; }
    if (k.length >= 3 && k.length <= 5) {
      const miles = parseFloat(k.slice(2).join(""));
      if (!Number.isFinite(miles)) return;
      if (miles > 0 && miles <= 30) {
        clicked.TPA = { type: "PCone", miles, color: "#0f0", showSize: window.starsState.TPASize };
      } else {
        setResponse("FORMAT");
      }
    } else {
      clicked.TPA = null;
    }
    return;
  }
  // **J / **P / **<pos>  (cs:1860-1889)
  if (sub === "*" && k.length > 2) {
    const c = k[2];
    if (c === "J") {
      // Clear all J-Rings
      for (const t of tracks.values()) if (t.TPA?.type === "JRing") t.TPA = null;
      return;
    }
    if (c === "P") {
      // Clear all P-Cones
      for (const t of tracks.values()) if (t.TPA?.type === "PCone") t.TPA = null;
      return;
    }
    // **<pos>  4 chars total = ForceQuickLook when pos == us
    if (k.length === 4) {
      const pos = k.slice(2).join("");
      if (clickedplane && pos === window.ownTcp?.()) {
        clicked._forceQuickLook = true;
      }
    }
    return;
  }
}

// ── F7 multifunction tree (RadarWindow.cs:1926-2577) ──────────────────────
//   F 2 ATPA E|I        — system-wide ATPA enable/inhibit  (1932-2023)
//   F 2 ATPA <vol> E|I  — per-volume ATPA enable/inhibit
//   F 2 2.5 <vol> E|I   — per-volume 2.5nm enable/inhibit  (2024-2086)
//   F B                 — toggle LDB beacon code display    (2092-2110)
//   F B E|I             — enable/inhibit LDB beacon codes
//   F B <squawk>        — toggle SelectedBeaconCodes        (2111-2119)
//   F B *               — clear SelectedBeaconCodes         (2120-2124)
//   F D *               — show clicked lat/lon DMS          (2126-2137)
//   F F NNNMMM          — set unassociated alt filter min/max  (2138-2167)
//   F F NNNMMM MMMNNN   — also associated min/max           (2168-2204)
//   F L <dir>           — own data block leader direction   (2206-2284)
//   F L <dir> *         — unowned data block leader
//   F L <dir> U         — unassociated leader
//   F L <pos><dir>      — per-other-owner leader direction
//   F P + click         — set PreviewLocation               (2316-2322)
//   F Q <pos>[+]        — quick-look toggle (+ = QL+ inverse) (2323-2357)
//   F S                 — set StatusLocation                (2358-2362)
//   F S <letter> [text] — set ATIS code + optional gentext  (2364-2398)
//   F O E|I             — auto-offset enable/inhibit        (2400-2410)
//   F R + click         — toggle ShowPTL on clicked plane   (2412-2418)
//   F Y                 — clear/set Scratchpad on clicked plane (2420-2480)
//   F Y <text>          — set Scratchpad
//   F Y +<text>         — set Scratchpad2
//   F Y <FLID> <text>   — set Scratchpad on typed FLID
function processMultifunction(k, parts, clicked, clickedplane, enter) {
  if (k.length < 2 && parts.length < 2) return;
  const sub = k[1] || parts[1]?.[0];
  // F B (2092-2125)
  if (sub === "B") {
    if (k.length === 2 && enter) {
      prefSet.LdbBeaconCodesInhibited = !prefSet.LdbBeaconCodesInhibited;
      return;
    }
    if (k.length === 3 && k[2] === "E" && enter) { prefSet.LdbBeaconCodesInhibited = false; return; }
    if (k.length === 3 && k[2] === "I" && enter) { prefSet.LdbBeaconCodesInhibited = true; return; }
    if (k.length >= 4 && k.length <= 6 && enter) {
      const sq = k.slice(2).join("");
      const arr = window.SSA?.selectedBeaconCodes || [];
      const i = arr.indexOf(sq);
      if (i >= 0) arr.splice(i, 1); else arr.push(sq);
      return;
    }
    if (k.length === 3 && k[2] === "*") {
      if (window.SSA) window.SSA.selectedBeaconCodes = [];
      return;
    }
    return;
  }
  // F F  alt filter (2138-2204) — TODO(test-in-crc) for layout precise format
  if (sub === "F") {
    if (k.length === 8) {
      const alts = k.slice(2).join("");
      const min = parseInt(alts.substring(0, 3), 10);
      const max = parseInt(alts.substring(3), 10);
      if (Number.isFinite(min) && Number.isFinite(max)) {
        prefSet.AltitudeFilterUnAssociatedMin = (min === 0) ? -9990 : min * 100;
        prefSet.AltitudeFilterUnAssociatedMax = max * 100;
        if (parts.length === 2 && parts[1].length === 6) {
          const alts2 = parts[1];
          const min2 = parseInt(alts2.substring(0, 3), 10);
          const max2 = parseInt(alts2.substring(3), 10);
          if (Number.isFinite(min2) && Number.isFinite(max2)) {
            prefSet.AltitudeFilterAssociatedMin = (min2 === 0) ? -9990 : min2 * 100;
            prefSet.AltitudeFilterAssociatedMax = max2 * 100;
          } else setResponse("FORMAT");
        }
        return;
      }
    }
    setResponse("FORMAT");
    return;
  }
  // F L  leader direction (2206-2314) — TODO(verify InvertKeyboard handling)
  if (sub === "L") {
    if (k.length <= 2) return;
    let dirpos = 2, pos = null;
    if (k.length === 5) { dirpos = 4; pos = k.slice(2, 4).join(""); }
    const digit = k[dirpos];
    if (!/^[1-9]$/.test(digit)) { setResponse("FORMAT"); return; }
    const direction = leaderDirFromDigit(digit, prefSet?.InvertKeyboard);
    if (k.length === 3 && direction !== undefined) {
      prefSet.OwnedDataBlockPosition = direction;
    } else if (k.length === 4 && k[3] === "*" && direction !== undefined) {
      prefSet.UnownedDataBlockPosition = direction;
    } else if (k.length === 4 && k[3] === "U" && direction !== undefined) {
      prefSet.UnassociatedDataBlockPosition = direction;
    } else if (pos != null) {
      prefSet.OtherOwnersLeaderDirections ??= {};
      if (digit === "5") delete prefSet.OtherOwnersLeaderDirections[pos];
      else if (direction !== undefined) prefSet.OtherOwnersLeaderDirections[pos] = direction;
    }
    return;
  }
  // F Q  quick-look (2323-2357)
  if (sub === "Q" && k.length >= 4 && k.length <= 6 && enter) {
    const qlstring = k.slice(1).join(""); // includes the Q
    // WPF takes Substring(1) so we get the position+optional+
    const after = qlstring.substring(1);
    const qlplus = after.endsWith("+");
    const qlpos = qlplus ? after.slice(0, -1) : after;
    if (!qlpos) { setResponse("ILL POS"); return; }
    const ql = prefSet.QuickLookedTCPs ||= [];
    const idx = ql.indexOf(qlpos);
    const idxPlus = ql.indexOf(qlpos + "+");
    if (qlplus) {
      if (idx >= 0) ql.splice(idx, 1);
      if (idxPlus >= 0) ql.splice(idxPlus, 1);
      else ql.push(qlpos + "+");
    } else {
      if (idx >= 0) ql.splice(idx, 1);
      else if (idxPlus >= 0) ql.splice(idxPlus, 1);
      else ql.push(qlpos);
    }
    return;
  }
  // F O  auto-offset (2400-2410)
  if (sub === "O" && k.length === 3 && enter) {
    if (k[2] === "I") window.starsState.AutoOffset = false;
    else if (k[2] === "E") window.starsState.AutoOffset = true;
    return;
  }
  // F R  toggle PTL on clicked plane (2412-2418)
  if (sub === "R" && clickedplane) {
    clicked._showPtl = !clicked._showPtl;
    return;
  }
  // F Y  scratchpad (2420-2480)
  if (sub === "Y") {
    if (clickedplane && parts.length === 1) {
      const fp = trackToFp.get(clicked.Guid);
      if (illTrk(clicked, fp)) { setResponse("ILL TRK"); return; }
      if (k.length === 2) { if (fp) fp.Scratchpad1 = ""; return; }
      if (k.length === 3 && k[2] === "+") { if (fp) fp.Scratchpad2 = ""; return; }
      if (k.length >= 3 && k.length <= 6 && k[2] !== "+") {
        if (fp) fp.Scratchpad1 = k.slice(2).join("");
        return;
      }
      if (k.length >= 4 && k.length <= 7 && k[2] === "+") {
        if (fp) fp.Scratchpad2 = k.slice(3).join("");
        return;
      }
      setResponse("FORMAT");
      return;
    }
    // Untargeted form: F Y <FLID> [text] - TODO(verify exact format-vs-FLID parsing)
    return;
  }
  // F D *  display clicked location as lat/lon DMS (cs:2126-2137)
  if (sub === "D" && k.length === 3 && k[2] === "*" && !enter) {
    const geo = window.mouseGeo?.();
    if (geo) setResponse(geoToDms(geo));
    return;
  }
  // F P  set MCA/PreviewArea location to clicked screen point (cs:2316-2322)
  if (sub === "P" && !clickedplane) {
    const m = window.mouseScreen?.();
    if (m) {
      prefSet.PreviewAreaLocation = { X: m.x, Y: m.y };
      const el = document.getElementById("mca");
      if (el) { el.style.left = m.x + "px"; el.style.bottom = "auto"; el.style.top = m.y + "px"; }
    }
    return;
  }
  // F S  set SSA location to clicked screen point (cs:2358-2362) - only when length 2
  if (sub === "S" && k.length === 2 && !clickedplane) {
    const m = window.mouseScreen?.();
    if (m) {
      prefSet.StatusAreaLocation = { X: m.x, Y: m.y };
      const el = document.getElementById("ssa");
      if (el) { el.style.left = m.x + "px"; el.style.top = m.y + "px"; }
    }
    return;
  }
  // F S <letter> [text...]  set ATIS slot 0 + free text (cs:2364-2398)
  if (sub === "S" && !clickedplane && k.length >= 3 && /^[A-Z]$/.test(k[2])) {
    const letter = k[2];
    window.SSA.atises[0] = letter;
    if (k.length > 3) {
      let text = k.slice(3).join("");
      // Additional tokens after first space append to free text with a space prefix.
      if (parts.length > 1) text += " " + parts.slice(1).join(" ");
      window.SSA.gentexts[0] = text;
    }
    return;
  }
  // F 2 ATPA[ <vol>] E|I  (cs:1932-2023)
  // F 2 2.5 <vol> E|I  (cs:2024-2086)
  if (sub === "2") {
    const rest = k.slice(2).join("");
    if (rest.startsWith("ATPA")) {
      const atpa = window.starsState.ATPA ||= { Active: false, Volumes: [] };
      if (rest.length === 5) {
        const op = rest[4];
        if (atpa.Volumes.length === 0) { setResponse("ILL FNCT"); return; }
        if (op === "E") {
          if (atpa.Active) { setResponse("NO CHANGE"); return; }
          atpa.Active = true; return;
        }
        if (op === "I") {
          if (!atpa.Active) { setResponse("NO CHANGE"); return; }
          atpa.Active = false; return;
        }
        setResponse("FORMAT"); return;
      }
      if (rest.length >= 6 && rest.length <= 10) {
        if (!atpa.Active) { setResponse("ILL FNCT"); return; }
        const op = rest[rest.length - 1];
        const volname = rest.substring(4, rest.length - 1);
        const vols = atpa.Volumes.filter(v => v.VolumeId === volname);
        if (vols.length !== 1) { setResponse("ILL VOL"); return; }
        const vol = vols[0];
        if (op === "E") {
          if (vol.Active) { setResponse("NO CHANGE"); return; }
          vol.Active = true; return;
        }
        if (op === "I") {
          if (!vol.Active) { setResponse("NO CHANGE"); return; }
          vol.Active = false; return;
        }
        setResponse("FORMAT"); return;
      }
    }
    if (rest.startsWith("2.5")) {
      const atpa = window.starsState.ATPA ||= { Active: false, Volumes: [] };
      if (!atpa.Active) { setResponse("ILL FNCT"); return; }
      if (rest.length >= 5 && rest.length <= 9) {
        const op = rest[rest.length - 1];
        const volname = rest.substring(3, rest.length - 1);
        const vols = atpa.Volumes.filter(v => v.VolumeId === volname && v.Active);
        if (vols.length !== 1) { setResponse("ILL VOL"); return; }
        const vol = vols[0];
        if (!vol.TwoPointFiveEnabled) { setResponse("ILL FNCT"); return; }
        if (op === "E") {
          if (vol.TwoPointFiveActive) { setResponse("NO CHANGE"); return; }
          vol.TwoPointFiveActive = true; return;
        }
        if (op === "I") {
          if (!vol.TwoPointFiveActive) { setResponse("NO CHANGE"); return; }
          vol.TwoPointFiveActive = false; return;
        }
        setResponse("FORMAT"); return;
      }
      setResponse("FORMAT"); return;
    }
    setResponse("FORMAT");
    return;
  }
  // F Y <FLID> <scratchpad>  - typed FLID variant (cs:2481-2520)
  if (sub === "Y" && !clickedplane && parts.length === 2) {
    const planestring = k.slice(2).join("");
    const planes = [];
    for (const t of tracks.values()) {
      const fp = trackToFp.get(t.Guid);
      if (fp?.Callsign?.trim() === planestring) planes.push({ t, fp });
      else if (fp?.AssignedSquawk?.trim() === planestring) planes.push({ t, fp });
    }
    if (planes.length !== 1) { setResponse("NO FLIGHT"); return; }
    const { fp } = planes[0];
    const tok = parts[1];
    if (tok.startsWith("+") && tok.length >= 2 && tok.length <= 5) {
      fp.Scratchpad2 = tok.slice(1);
      return;
    }
    if (!tok.startsWith("+") && tok.length >= 1 && tok.length <= 4) {
      fp.Scratchpad1 = tok;
      return;
    }
    setResponse("FORMAT");
    return;
  }
}

// Geo helpers used by F D *.
function geoToDms(geo) {
  const fmt = (deg, posCh, negCh) => {
    const ch = deg >= 0 ? posCh : negCh;
    const v = Math.abs(deg);
    const d = Math.floor(v);
    const m = Math.floor((v - d) * 60);
    const s = ((v - d) * 60 - m) * 60;
    return `${ch}${String(d).padStart(2,"0")}${String(m).padStart(2,"0")}${s.toFixed(2).padStart(5,"0")}`;
  };
  return `${fmt(geo.lat, "N", "S")} ${fmt(geo.lon, "E", "W")}`;
}

// ── ProcessImpliedCommand (RadarWindow.cs:2688-2769) ─────────────────────
// Priority chain when user clicks an aircraft with an empty MCA buffer:
//   1. PendingHandoff == us         -> accept handoff
//   2. PositionInd == us && pending -> recall handoff
//   3. Pointout                     -> clear pointout
//   4. ForceQuickLook               -> clear FQL
//   5. Owned & PositionInd != us    -> release ownership
//   6. Owned & has callsign         -> beacon readout in preview
//   7. !Owned & has callsign        -> toggle FDB
//   8. No callsign                  -> toggle FDB (unassociated)
function processImplied(plane) {
  const fp = trackToFp.get(plane.Guid) || {};
  const me = window.ownTcp?.();
  // 1. Accept handoff
  if (fp.PendingHandoff && fp.PendingHandoff === me) {
    fp.PositionInd = me;
    fp.PendingHandoff = null;
    return;
  }
  // 2. Recall handoff
  if (fp.PositionInd === me && fp.PendingHandoff) {
    fp.PendingHandoff = null;
    return;
  }
  // 3. Clear pointout
  if (plane._pointout) {
    plane._pointout = false;
    return;
  }
  // 4. Clear ForceQuickLook
  if (plane._forceQuickLook) {
    plane._forceQuickLook = false;
    return;
  }
  // 5. Release ownership (we own but display is elsewhere)
  if (plane._owned && fp.PositionInd && fp.PositionInd !== me) {
    plane._owned = false;
    return;
  }
  // 6. Beacon readout in preview area
  if (plane._owned && fp.Callsign) {
    setResponse(`${fp.Callsign} ${plane.Squawk || ""} ${fp.AssignedSquawk || ""}`.trim());
    return;
  }
  // 7. Toggle FDB on associated track we don't own
  if (!plane._owned && fp.Callsign) {
    plane._fdb = !plane._fdb;
    return;
  }
  // 8. Toggle FDB on unassociated track
  if (!fp.Callsign) {
    plane._fdb = !plane._fdb;
  }
}

// ── KeyCode.RngRing  "RR <interval>" + enter (RadarWindow.cs:2528-2541) ──
function cmdRangeRings(parts) {
  if (parts.length < 2) return;
  const interval = parseFloat(parts[1]);
  if (Number.isFinite(interval)) prefSet.RangeRingSpacing = Math.floor(interval);
}

// ── KeyCode.WX  "WX <level>" + enter (RadarWindow.cs:2542-2557) ───────────
function cmdWeather(parts) {
  if (parts.length < 2 || parts[1].length !== 1) return;
  const level = parseInt(parts[1], 10);
  if (level > 0 && level < 7 && window.starsState?.Nexrad) {
    const arr = window.starsState.Nexrad.LevelsEnabled ||= [];
    arr[level - 1] = !arr[level - 1];
  }
}

// ── KeyCode.RecenterEverything  "RECENTER <ICAO>" (RadarWindow.cs:2558-2577)
function cmdRecenter(parts) {
  if (parts.length !== 2) return;
  const code = parts[1].toUpperCase();
  // Look up in vNAS airports loaded by scope.js applyProfile.
  const airport = (window.starsAirports || []).find(a => a.id === code);
  if (!airport) { setResponse("NO AIRPORT"); return; }
  prefSet.ScopeCentered = true;
  prefSet.RangeRingLocation = { Latitude: airport.lat, Longitude: airport.lon };
  if (window.recenterScope) window.recenterScope(airport.lat, airport.lon);
  if (airport.magVar != null) prefSet.ScreenRotation = airport.magVar;
}

// ── Default catchall — typed text on clicked plane (cs:2606-2683) ─────────
//   1 token, 3 chars: Scratchpad1                 (cs:2627-2640)
//   1 token, 4 chars trailing '+': Scratchpad2    (cs:2641-2654)
//   1 token, 4 chars no '+': aircraft Type        (cs:2655-2668)
//   1 token, 2 chars: PendingHandoff (initiate)   (cs:2669-2683)
//   tempLine end-target (RBL):                    (cs:2607-2626) TODO(rbl)
function cmdDefaultClickedPlane(line, clicked) {
  const fp = trackToFp.get(clicked.Guid);
  if (illTrk(clicked, fp)) { setResponse("ILL TRK"); return; }
  if (!fp) return;
  const token = line.trim();
  if (token.length === 3) {
    fp.Scratchpad1 = token;
    return;
  }
  if (token.length === 4 && token.endsWith("+")) {
    fp.Scratchpad2 = token.slice(0, 3);
    return;
  }
  if (token.length === 4) {
    fp.AircraftType = token;
    return;
  }
  if (token.length === 2) {
    fp.PendingHandoff = token;
    return;
  }
}

// Aircraft click → set as "clicked plane" + handle implicit commands.
// scope.js binds clicks; we expose this entry point.
window.MCA = MCA;
window.mcaSetClickedPlane = (plane) => {
  MCA.clickedPlane = plane;
  if (!MCA.buffer) {
    // Empty buffer + click = FDB toggle (Phase 3b _forcedMode).
    plane._forcedMode = plane._forcedMode === "FDB" ? null : "FDB";
    setResponse(`FDB ${plane._forcedMode || "OFF"}`);
  } else {
    // Buffer + click = execute command with this plane appended.
    const before = MCA.buffer;
    const plid = (plane.Callsign || plane.Squawk || "");
    MCA.buffer = (before + " " + plid).trim();
    executeCommand(MCA.buffer);
    MCA.buffer = "";
  }
  refreshMca();
};
window.mountMca = mountMca;
