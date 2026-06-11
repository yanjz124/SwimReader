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

// F-key prefix table — CRC docs § STARS Keys + scope/RadarWindow.cs DcbButtonClick.
// Each F-key inserts its prefix; user appends a FLID (callsign / CID / squawk)
// and presses Enter.
const FKEY_PREFIX = {
  F1:  "QF",   // Flight plan readout (vSTARS Quick Flight)
  F2:  "QP",   // Point out acknowledge / acknowledge
  F4:  "QX",   // Drop track
  F5:  "QZ",   // Altitude assign
  F6:  "QU",   // Route display
  F7:  "QL",   // Quick Look (sector)
  F8:  "QQ",   // Interim altitude
  F9:  "QB",   // Beacon code
  F10: "QS",   // Heading / speed / free text
  // Shift+F2 = QD (clear response)
  // Shift+F7 = WR (METAR)
  // Shift+F8 = QR (controller reported altitude)
};

const FKEY_PREFIX_SHIFT = {
  F2:  "QD",
  F7:  "WR",
  F8:  "QR",
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
  refreshMca();
}

function refreshMca() {
  const el = document.getElementById("mca");
  if (!el) return;
  const cursor = "_";
  const rspColor = MCA.responseColor || "#0f0";
  el.innerHTML =
    `<div style="color:${rspColor};">${MCA.response || ""}</div>` +
    `<div style="color:#fff;">${MCA.buffer}${cursor}</div>`;
  // Apply Brightness.Lists + CharSize.Lists so MCA matches SSA visually
  if (window.prefSet) {
    const b = Math.max(30, window.prefSet.Brightness.Lists);
    el.style.color = `rgb(0, ${(255 * b / 100) | 0}, 0)`;
    el.style.fontSize = (window.prefSet.CharSize?.Lists ?? 13) + "px";
  }
}

function onKeyDown(e) {
  // Ignore typing inside text inputs (none currently, but defensive).
  if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;

  // F-key prefix insertion — CRC docs § STARS Keys.
  if (e.key && /^F\d+$/.test(e.key)) {
    e.preventDefault();
    const k = e.key.toUpperCase();
    const prefix = (e.shiftKey ? FKEY_PREFIX_SHIFT[k] : FKEY_PREFIX[k]);
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
// Phase 5 implements the highest-frequency commands per CRC docs § Command
// Reference. The remainder are documented as TODO at the bottom of
// docs/stars/PHASE-NOTES.md Phase 5 section.

function setResponse(msg, ok = true) {
  MCA.response = msg;
  MCA.responseColor = ok ? "#0f0" : "#f44";
  refreshMca();
  // Auto-clear after a few seconds, matching WPF behavior.
  setTimeout(() => {
    if (MCA.response === msg) { MCA.response = ""; refreshMca(); }
  }, 4000);
}

function findAircraft(token) {
  // CRC docs: FLID = callsign / CID / beacon code.
  // We look at tracks (associated only — Phase 8 brings sector ownership);
  // Phase 5 supports callsign + squawk lookup.
  if (!token) return null;
  const up = token.toUpperCase();
  for (const t of tracks.values()) {
    const fp = trackToFp.get(t.Guid);
    if (fp?.Callsign && fp.Callsign.toUpperCase() === up) return t;
    if (t.Callsign && t.Callsign.toUpperCase() === up) return t;
    if (t.Squawk === token) return t;
  }
  return null;
}

function executeCommand(line) {
  if (!line && MCA.clickedPlane) {
    // CRC: empty enter + clicked plane = FDB toggle.
    const t = MCA.clickedPlane;
    t._forcedMode = t._forcedMode === "FDB" ? null : "FDB";
    setResponse(`FDB ${t._forcedMode === "FDB" ? "ON" : "OFF"}`);
    return;
  }
  if (!line) return;

  const parts = line.split(/\s+/);
  const cmd = parts[0];

  switch (cmd) {
    case "QF": {
      const plane = findAircraft(parts[1]);
      if (!plane) return setResponse("NOT FOUND", false);
      const fp = trackToFp.get(plane.Guid);
      setResponse(formatFlightPlan(plane, fp));
      return;
    }
    case "QX": {
      const plane = findAircraft(parts[1]);
      if (!plane) return setResponse("NOT FOUND", false);
      tracks.delete(plane.Guid);
      setResponse(`DROPPED ${parts[1]}`);
      return;
    }
    case "QZ": {
      // QZ <alt> <FLID>  — set assigned altitude
      const plane = findAircraft(parts[2]);
      if (!plane) return setResponse("NOT FOUND", false);
      const fp = trackToFp.get(plane.Guid);
      if (fp) fp.RequestedAltitude = parseInt(parts[1], 10) * 100;
      setResponse(`QZ ${parts[1]} ${parts[2]}`);
      return;
    }
    case "QU": {
      // QU <FLID> — toggle route display.
      const plane = findAircraft(parts[1]);
      if (!plane) return setResponse("NOT FOUND", false);
      plane._showRoute = !plane._showRoute;
      setResponse(`ROUTE ${plane._showRoute ? "ON" : "OFF"} ${parts[1]}`);
      return;
    }
    case "QL": {
      // QL <sector...> — quick look TCPs. Toggles per sector.
      const sectors = parts.slice(1);
      if (sectors.length === 0) { prefSet.QuickLookedTCPs = []; setResponse("QL CLEARED"); }
      else { prefSet.QuickLookedTCPs = sectors; setResponse("QL " + sectors.join(" ")); }
      return;
    }
    case "QD": {
      MCA.response = "";
      refreshMca();
      return;
    }
    case "QP": {
      // QP <FLID> — clear point-out / FDB->LDB
      const plane = findAircraft(parts[1]);
      if (plane) plane._forcedMode = "LDB";
      setResponse("QP " + (parts[1] || ""));
      return;
    }
    case "QQ": {
      // QQ <alt> <FLID> — set interim altitude (Phase 8 propagates to handoff)
      const plane = findAircraft(parts[2]);
      if (!plane) return setResponse("NOT FOUND", false);
      const fp = trackToFp.get(plane.Guid);
      if (fp) fp.InterimAltitude = parseInt(parts[1], 10) * 100;
      setResponse(`QQ ${parts[1]} ${parts[2]}`);
      return;
    }
    case "QS": {
      // QS <heading|`text> <FLID>  — heading/speed/free-text (HSF) data
      const plane = findAircraft(parts[parts.length - 1]);
      if (!plane) return setResponse("NOT FOUND", false);
      const fp = trackToFp.get(plane.Guid);
      if (!fp) return setResponse("NO FP", false);
      const val = parts.slice(1, -1).join(" ");
      if (val.startsWith("`")) fp.ClearanceText = val.slice(1);
      else if (val.startsWith("/")) fp.ClearanceSpeed = val.slice(1);
      else fp.ClearanceHeading = val;
      setResponse(`QS ${val} ${parts[parts.length - 1]}`);
      return;
    }
    // ── Phase 8: tracking + handoffs (LOCAL ONLY; see G18) ─────────────────
    case "INIT": {
      // INIT <FLID> — acquire ownership locally. Sets fp.Owner = ownTcp.
      const plane = findAircraft(parts[1]);
      if (!plane) return setResponse("NOT FOUND", false);
      const fp = trackToFp.get(plane.Guid);
      if (!fp) return setResponse("NO FP", false);
      const me = window.ownTcp();
      if (!me) return setResponse("NO TCP - use .SO <id> first", false);
      fp.Owner = me;
      fp.PendingHandoff = null;
      setResponse(`INIT ${parts[1]} -> ${me}`);
      return;
    }
    case "TERM": {
      // TERM <FLID> — release ownership locally.
      const plane = findAircraft(parts[1]);
      if (!plane) return setResponse("NOT FOUND", false);
      const fp = trackToFp.get(plane.Guid);
      if (!fp) return setResponse("NO FP", false);
      fp.Owner = null;
      fp.PendingHandoff = null;
      setResponse(`TERM ${parts[1]}`);
      return;
    }
    case ".SO": {
      // .SO <tcp> — sign on as TCP.
      window.setOwnTcp(parts[1]);
      setResponse(`SIGNED ON ${parts[1] || "OFF"}`);
      return;
    }
    case "*": {
      // * <sector> <FLID> — initiate handoff. Local: sets PendingHandoff.
      const plane = findAircraft(parts[2]);
      if (!plane) return setResponse("NOT FOUND", false);
      const fp = trackToFp.get(plane.Guid);
      if (!fp) return setResponse("NO FP", false);
      fp.PendingHandoff = parts[1] ? parts[1].toUpperCase() : "ANY";
      setResponse(`HANDOFF ${parts[2]} -> ${fp.PendingHandoff}`);
      return;
    }
    // ── Phase 9: J-Ring + MinSep ───────────────────────────────────────────
    case "J": {
      // J <radius> <FLID>  — toggle J-ring of N nm. Same FLID toggles off.
      const radius = parseFloat(parts[1]);
      const flid = parts[2];
      if (!isFinite(radius) || !flid) return setResponse("J <nm> <FLID>", false);
      if (window.starsJRing(flid, radius)) setResponse(`J${radius} ${flid}`);
      else setResponse("NOT FOUND", false);
      return;
    }
    case "MS": {
      // MS <FLID1> <FLID2>  — show min separation between two aircraft (now).
      const d = window.starsMinSep(parts[1], parts[2]);
      if (d == null) return setResponse("NOT FOUND", false);
      setResponse(`MS ${parts[1]} ${parts[2]} = ${d.toFixed(2)} NM`);
      return;
    }
    case "MS-": {
      window.starsMinSepClear();
      setResponse("MS CLEARED");
      return;
    }
    case "PO": {
      // PO <sector> <FLID> — point out (local marker only).
      const plane = findAircraft(parts[2]);
      if (!plane) return setResponse("NOT FOUND", false);
      const fp = trackToFp.get(plane.Guid);
      if (!fp) return setResponse("NO FP", false);
      fp._pointoutTarget = parts[1] ? parts[1].toUpperCase() : "ANY";
      setResponse(`POINT OUT ${parts[2]} -> ${fp._pointoutTarget}`);
      return;
    }
    default: {
      // Position-data block / leader: digit 1-9 then aircraft click.
      if (/^[1-9]$/.test(cmd) && MCA.clickedPlane) {
        const t = MCA.clickedPlane;
        // Numeric keypad layout for leader direction
        // 1=NW 2=N 3=NE 4=W 6=E 7=SW 8=S 9=SE
        const map = { "1":1, "2":2, "3":3, "4":4, "6":6, "7":7, "8":8, "9":9 };
        t._leaderOverride = map[cmd];
        setResponse(`LDR ${cmd}`);
        return;
      }
      // Bare FLID = toggle FDB/LDB for that plane.
      const plane = findAircraft(cmd);
      if (plane) {
        plane._forcedMode = plane._forcedMode === "FDB" ? "LDB" : "FDB";
        setResponse(`${cmd} ${plane._forcedMode}`);
        return;
      }
      setResponse("UNKNOWN CMD", false);
    }
  }
}

function formatFlightPlan(t, fp) {
  if (!fp) return `${t.Callsign || t.Squawk || "?"} (no FP)`;
  return [
    fp.Callsign,
    fp.AircraftType + (fp.WakeCategory ? "/" + fp.WakeCategory : ""),
    `${fp.Origin || "?"} -> ${fp.Destination || "?"}`,
    `${fp.FlightRules || "?"} ${fp.RequestedAltitude || "?"}`,
    fp.Route ? "ROUTE " + fp.Route : "",
  ].filter(Boolean).join("\n");
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
