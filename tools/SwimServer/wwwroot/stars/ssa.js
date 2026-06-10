// ─────────────────────────────────────────────────────────────────────────────
// STARS System Status Area (SSA) — Phase 7.
//
// Sources of truth:
//   • scope/RadarWindow.cs:2942-3060   — RenderStatus, line-by-line content
//   • scope/RadarWindow.cs:747-752     — StatusArea TransparentLabel
//   • CRC docs § System Status Area    — taxonomy: time, weather, network,
//                                        altitude filters, beacon select,
//                                        SPCs, quick-look, CRDA info
//
// Content lines, in WPF order:
//   1. HHmm/ss + timeSyncInd + altimeter         (RenderStatus:2947)
//   2. ATIS [0..9]                                (:2950-2956)
//   3. SelectedBeaconCodes (space-separated)      (:2959-2966)
//   4. "{Range}NM PTL: {PTLLength}"               (:2967)
//   5. Altitude filter row                        (:2968)
//   6. INTRAIL ON: {ATPA volumes}                 (:2970-2986)
//   7. INTRAIL 2.5 ON: {volumes}
//   8. METAR pressure line for each station       (:2993+)
// ─────────────────────────────────────────────────────────────────────────────

const SSA = {
  atises: new Array(10).fill(null),      // 10 ATIS slots per ATIS ID
  gentexts: new Array(10).fill(null),    // free-text suffix per ATIS slot
  selectedBeaconCodes: [],
  metars: new Map(),                     // ICAO → { pressure, raw }
  altimeter: null,                        // primary station altimeter for header
  intrailVolumes: [],                     // [{id, twoPointFive}]
  timeSynchronized: true,
};

function mountSsa() {
  const el = document.createElement("div");
  el.id = "ssa";
  el.style.cssText = `
    position:fixed;
    left:8px; top:90px;     /* below DCB; PrefSet.StatusAreaLocation overrides */
    background:rgba(0,0,0,0.6);
    color:#0f0;
    font-family:ui-monospace, monospace; font-size:12px;
    padding:4px 8px; min-width:200px;
    border:1px solid #0a3a0a; z-index:17;
    white-space:pre; line-height:1.4;
    pointer-events:auto; user-select:none;
  `;
  el.draggable = false;
  document.body.appendChild(el);

  setInterval(refreshSsa, 1000);
  refreshSsa();

  // PrefSet.StatusAreaLocation = where the user dragged this. We let the user
  // drag the SSA around with the mouse and persist to PrefSet.
  makeDraggable(el, (x, y) => {
    prefSet.StatusAreaLocation = { X: x, Y: y };
  });
}

function makeDraggable(el, onMove) {
  let dragging = false, ox = 0, oy = 0;
  el.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (e.shiftKey) {
      // Shift+drag moves the panel — leaves plain click for STARS commands.
      dragging = true;
      const r = el.getBoundingClientRect();
      ox = e.clientX - r.left;
      oy = e.clientY - r.top;
      e.preventDefault();
    }
  });
  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const x = e.clientX - ox, y = e.clientY - oy;
    el.style.left = x + "px";
    el.style.top = y + "px";
    onMove(x, y);
  });
  document.addEventListener("mouseup", () => { dragging = false; });
}

// Restore from PrefSet (saved location) if present.
function restoreSsaLocation(el) {
  const l = prefSet.StatusAreaLocation;
  if (l && typeof l.X === "number") {
    el.style.left = l.X + "px";
    el.style.top  = l.Y + "px";
  }
}

function refreshSsa() {
  const el = document.getElementById("ssa");
  if (!el) return;
  const lines = [];

  // Line 1 — Time HHmm/ss + sync + altimeter
  const d = new Date();
  const hhmm = String(d.getUTCHours()).padStart(2, "0") + String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  const syncInd = SSA.timeSynchronized ? " " : "*";
  const altimeterStr = SSA.altimeter != null ? SSA.altimeter.toFixed(2) : "—";
  lines.push(`${hhmm}/${ss}${syncInd}${altimeterStr}`);

  // Line 2..N — ATIS
  for (let i = 0; i < 10; i++) {
    if (SSA.atises[i]) {
      const suf = SSA.gentexts[i] ? " " + SSA.gentexts[i] : "";
      lines.push(`${SSA.atises[i]}${suf}`);
    }
  }

  // Selected beacon codes
  if (SSA.selectedBeaconCodes.length) lines.push(SSA.selectedBeaconCodes.join(" "));

  // Range + PTL
  lines.push(`${Math.round(prefSet.Range)}NM PTL: ${prefSet.PTLLength.toFixed(1)}`);

  // Altitude filter — WPF formats with ToFilterAltitudeString (3-digit FL).
  lines.push(`${fa(prefSet.AltitudeFilterUnAssociatedMin)} ${fa(prefSet.AltitudeFilterUnAssociatedMax)} U ` +
             `${fa(prefSet.AltitudeFilterAssociatedMin)} ${fa(prefSet.AltitudeFilterAssociatedMax)} A`);

  // INTRAIL
  const onVols = SSA.intrailVolumes.filter(v => v.active);
  if (onVols.length) {
    lines.push(`INTRAIL ON: ${onVols.map(v => v.id).join(" ")}`);
    const t25 = onVols.filter(v => v.twoPointFive);
    if (t25.length) lines.push(`INTRAIL 2.5 ON: ${t25.map(v => v.id).join(" ")}`);
  }

  // METAR pressure for known stations.
  const sorted = [...SSA.metars.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [icao, m] of sorted) {
    const station = (icao.length === 4 && icao[0] === "K") ? icao.slice(1) : icao;
    if (m.pressure != null) lines.push(`${station} ${m.pressure.toFixed(2)}`);
    else lines.push(`${station} 00.00`);
  }

  el.innerHTML = lines.map(escapeHtml).join("<br>");
  el.style.color = `rgb(0, ${(255 * prefSet.Brightness.Lists / 100) | 0}, 0)`;
}

function fa(altFt) {
  // WPF ToFilterAltitudeString: 3-digit "FL" (e.g., 18000 -> "180"). Negative
  // ranges show "—".
  if (altFt == null || altFt <= -9000) return "—";
  return String(Math.round(altFt / 100)).padStart(3, "0");
}
function escapeHtml(s) {
  return String(s).replace(/[<>&]/g, c => ({"<":"&lt;",">":"&gt;","&":"&amp;"}[c]));
}

// External hooks: parts of scope.js or future METAR fetches can poke SSA state.
window.SSA = SSA;
window.mountSsa = mountSsa;
window.refreshSsa = refreshSsa;
