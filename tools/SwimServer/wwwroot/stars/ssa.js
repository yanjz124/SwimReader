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

// METAR fetcher — WPF wx.Altimeter.Value comes from the home station's METAR
// (RadarWindow.cs:2947). We mirror by hitting /api/metar/{station} for the
// facility's home airport. Station defaults to URL ?metar=XXX or facility name.
async function fetchAltimeter(station) {
  if (!station) return;
  try {
    const r = await fetch(`/api/metar/${encodeURIComponent(station)}`);
    if (!r.ok) return;
    const text = await r.text();
    // Parse altimeter from METAR: pattern A2986 (in.Hg × 100)
    const m = text.match(/\bA(\d{4})\b/);
    if (m) SSA.altimeter = parseInt(m[1], 10) / 100;
    SSA.metarRaw = text.trim();
  } catch (e) { /* ignore */ }
}
function startMetarPoll() {
  const station = (new URLSearchParams(location.search)).get("metar")
                || window.starsState?.facilityHomeStation
                || "KIAD";  // default IAD for PCT
  fetchAltimeter(station);
  setInterval(() => fetchAltimeter(station), 5 * 60 * 1000);   // every 5 min
}

function mountSsa() {
  const el = document.createElement("div");
  el.id = "ssa";
  el.style.cssText = `
    position:fixed;
    left:8px; top:90px;     /* below DCB; PrefSet.StatusAreaLocation overrides */
    background:transparent;
    color:#0f0;
    font-family:FixedDemiBold, ui-monospace, monospace; font-size:12px;
    padding:4px 8px; min-width:200px;
    z-index:17;
    white-space:pre; line-height:1.3;
    pointer-events:auto; user-select:none;
  `;
  el.draggable = false;
  document.body.appendChild(el);

  setInterval(refreshSsa, 1000);
  refreshSsa();
  startMetarPoll();

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

  // Line 0 (Phase 8) — signed-on TCP indicator, only when present.
  const tcp = window.ownTcp && window.ownTcp();
  if (tcp) lines.push(`TCP ${tcp}`);

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

  // Range + PTL — format from RadarWindow.cs:2967.
  lines.push(`${Math.round(prefSet.Range)}NM PTL: ${prefSet.PTLLength.toFixed(1)}`);

  // Altitude filter — WPF ToFilterAltitudeString format.
  lines.push(`${fa(prefSet.AltitudeFilterUnAssociatedMin)} ${fa(prefSet.AltitudeFilterUnAssociatedMax)} U ` +
             `${fa(prefSet.AltitudeFilterAssociatedMin)} ${fa(prefSet.AltitudeFilterAssociatedMax)} A`);

  // Quick Look TCPs — WPF: "QL: ALL" or "QL: TCP1 TCP2"
  const ql = prefSet.QuickLookedTCPs || [];
  if (ql.length === 0) lines.push("QL: ");
  else lines.push("QL: " + ql.join(" "));

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
  // RadarWindow.cs:2943: StatusArea.ForeColor = AdjustedColor(DataBlockColor,
  // Brightness.Lists). DataBlockColor is the configured green; brightness
  // multiplies linearly. No bold, no shadow.
  const b = prefSet.Brightness.Lists / 100;
  el.style.color = `rgb(0, ${(255 * b) | 0}, 0)`;
  el.style.fontSize = (prefSet.CharSize?.Lists ?? 12) + "px";
}

function fa(altFt) {
  // ToFilterAltitudeString — observed in DGScope: negative or extreme min
  // shows as "N99"; high max shows as 3-digit FL/100 (e.g. 99900 -> "999").
  // PrefSet defaults: AltitudeFilterUnAssociatedMin = -9900 -> "N99".
  if (altFt == null) return "N99";
  if (altFt <= -9900) return "N99";
  if (altFt <= 0) return "N" + String(Math.round(-altFt / 100)).padStart(2, "0");
  return String(Math.round(altFt / 100)).padStart(3, "0");
}
function escapeHtml(s) {
  return String(s).replace(/[<>&]/g, c => ({"<":"&lt;",">":"&gt;","&":"&amp;"}[c]));
}

// External hooks: parts of scope.js or future METAR fetches can poke SSA state.
window.SSA = SSA;
window.mountSsa = mountSsa;
window.refreshSsa = refreshSsa;
