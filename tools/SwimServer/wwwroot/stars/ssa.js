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
  // Mirrors RadarWindow.cs:1042-1057 — atises (char[10]) + gentexts (string[10]).
  atises: new Array(10).fill(null),
  gentexts: new Array(10).fill(null),
  // SelectedBeaconCodes — RadarWindow.cs:1058 (List<string>). Written by F B
  // command in preview.js.
  selectedBeaconCodes: [],
  // METAR cache — port-only (DGScope fetches via Weather.cs MetarRequester).
  metars: new Map(),                     // ICAO → { pressure, raw }
  altimeter: null,                       // primary station altimeter for header
  // timesync.Synchronized — RadarWindow.cs:2978. Set from /api/time-sync.
  timeSynchronized: true,
};

// METAR fetcher — populates the SSA altimeter stations from the selected area's
// ssaAirports (e.g. RDU), plus the header altimeter (RadarWindow.cs:2947).
// /api/metar/{station} proxies aviationweather.gov.
function ssaStations() {
  const override = (new URLSearchParams(location.search)).get("metar");
  if (override) return override.split(",").map(s => s.trim()).filter(Boolean);
  const ap = window.starsState?.area?.ssaAirports;
  if (Array.isArray(ap) && ap.length) return ap;
  if (window.starsState?.facilityHomeStation) return [window.starsState.facilityHomeStation];
  return [];
}
async function fetchMetar(station) {
  const icao = station.length === 3 ? "K" + station.toUpperCase() : station.toUpperCase();
  try {
    const r = await fetch(`/api/metar/${encodeURIComponent(icao)}`);
    if (!r.ok) return null;
    const text = (await r.text()).trim();
    if (!text) return null;
    // A2986 = 29.86 inHg. Also accept Q#### (hPa, ICAO format) and convert.
    const m = text.match(/\bA(\d{4})\b/);
    const q = text.match(/\bQ(\d{4})\b/);
    let pressure = null;
    if (m)      pressure = parseInt(m[1], 10) / 100;
    else if (q) pressure = parseInt(q[1], 10) * 0.029530;   // hPa → inHg
    // Only store when we got a real pressure; avoids rendering "00.00" rows
    // for airports whose METAR is unavailable or unparseable.
    if (pressure != null) SSA.metars.set(icao, { pressure, raw: text });
    return pressure;
  } catch { return null; }
}
async function pollMetars() {
  const stations = ssaStations();
  if (!stations.length) return false;          // facility not loaded yet
  // Per WeatherService.Altimeter (WeatherService.cs:51-83): sum all valid
  // station pressures, divide by count of pressures that parsed. Default
  // 29.92 when none. Single-station case still goes through the average
  // and just returns that one station's value.
  let sum = 0, count = 0;
  for (const s of stations) {
    const p = await fetchMetar(s);
    if (p != null && Number.isFinite(p)) { sum += p; count++; }
  }
  SSA.altimeter = (count > 0) ? (sum / count) : 29.92;
  return true;
}

// Boot loop: keep retrying every 3s until we get the first successful poll
// (i.e. until starsState.area has populated and at least one airport returned
// a parseable METAR). Once we have data, fall back to the 5-minute cadence
// matching the publish frequency of METAR. Without this, an empty first poll
// would leave the SSA stuck on "00.00 …" for 5 full minutes after page load.
async function startMetarPoll() {
  let ready = false;
  while (!ready) {
    ready = await pollMetars();
    if (!ready) await new Promise(r => setTimeout(r, 3000));
  }
  setInterval(pollMetars, 5 * 60 * 1000);
}

function mountSsa() {
  const el = document.createElement("div");
  el.id = "ssa";
  el.style.cssText = `
    position:fixed;
    left:20px; top:120px;   /* below the DCB, nudged in for breathing room; StatusAreaLocation overrides */
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

  // PrefSet.StatusAreaLocation = where the user dragged this. DGScope cs:3080
  // anchors it BOTTOM-LEFT, so save bottom-anchored too — restoreSsaLocation
  // will reverse the height offset on next load.
  makeDraggable(el, (x, y) => {
    const h = el.getBoundingClientRect().height || 0;
    prefSet.StatusAreaLocation = { X: x, Y: y + h };
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
// DGScope cs:3080 anchors StatusLocation as BOTTOM-LEFT
// (`StatusArea.LocationF = (StatusLocation.X, StatusLocation.Y - SizeF.Height)`).
// Our CSS positions use top-left. Translate by subtracting the SSA's
// rendered height — defer to next animation frame to get the real height.
function restoreSsaLocation(el) {
  const l = prefSet.StatusAreaLocation;
  if (l && typeof l.X === "number") {
    el.style.left = l.X + "px";
    requestAnimationFrame(() => {
      const h = el.getBoundingClientRect().height || 0;
      el.style.top = (l.Y - h) + "px";
    });
  }
}

function refreshSsa() {
  const el = document.getElementById("ssa");
  if (!el) return;
  const lines = [];

  // RenderStatus — RadarWindow.cs:2947 verbatim:
  //   CurrentTime.ToString("HHmm/ss") + timesyncind + wx.Altimeter.Value.ToString("00.00")
  // No TCP line, no other prefix lines. DGScope simply does not display a
  // signed-on TCP in the SSA — that earlier addition was invented; removed.
  const d = new Date();
  const hhmm = String(d.getUTCHours()).padStart(2, "0") + String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  const syncInd = SSA.timeSynchronized ? " " : "*";
  // wx.Altimeter.Value defaults to 29.92 (WeatherService.cs:172) when no
  // METARs are loaded; we use the same fallback instead of "00.00" so the
  // SSA never shows a value that's outside the realistic 28-31 inHg range.
  const altInHg = (SSA.altimeter != null) ? SSA.altimeter : 29.92;
  lines.push(`${hhmm}/${ss}${syncInd}${altInHg.toFixed(2)}`);

  // Line 2..N — ATIS
  for (let i = 0; i < 10; i++) {
    if (SSA.atises[i]) {
      const suf = SSA.gentexts[i] ? " " + SSA.gentexts[i] : "";
      lines.push(`${SSA.atises[i]}${suf}`);
    }
  }

  // Selected beacon codes
  if (SSA.selectedBeaconCodes.length) lines.push(SSA.selectedBeaconCodes.join(" "));

  // Range + PTL — format from RadarWindow.cs:2967 ((int) cast truncates toward zero).
  lines.push(`${Math.trunc(prefSet.Range)}NM PTL: ${prefSet.PTLLength.toFixed(1)}`);

  // Altitude filter — WPF ToFilterAltitudeString format.
  lines.push(`${fa(prefSet.AltitudeFilterUnAssociatedMin)} ${fa(prefSet.AltitudeFilterUnAssociatedMax)} U ` +
             `${fa(prefSet.AltitudeFilterAssociatedMin)} ${fa(prefSet.AltitudeFilterAssociatedMax)} A`);

  // INTRAIL (RenderStatus order: after the altitude filter, before METARs).
  // Reads window.starsState.ATPA — single source of truth, written by the
  // F 2 ATPA command (preview.js). Mirrors RadarWindow.cs:3001-3019:
  // emit "INTRAIL ON: …" when ATPA.Active and the volume is Active,
  // then "INTRAIL 2.5 ON: …" for active 2.5nm-enabled volumes.
  const atpa = window.starsState && window.starsState.ATPA;
  if (atpa && atpa.Active && Array.isArray(atpa.Volumes)) {
    const onVols = atpa.Volumes.filter(v => v.Active);
    if (onVols.length) {
      lines.push(`INTRAIL ON: ${onVols.map(v => v.VolumeId).join(" ")}`);
      const t25 = onVols.filter(v => v.TwoPointFiveEnabled && v.TwoPointFiveActive);
      if (t25.length) lines.push(`INTRAIL 2.5 ON: ${t25.map(v => v.VolumeId).join(" ")}`);
    }
  }

  // METAR altimeters — DGScope packs 3 stations per line (RadarWindow.cs:3019-3028).
  const sorted = [...SSA.metars.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  let metarRow = [];
  for (const [icao, m] of sorted) {
    const station = (icao.length === 4 && icao[0] === "K") ? icao.slice(1) : icao;
    metarRow.push(`${station} ${m.pressure != null ? m.pressure.toFixed(2) : "00.00"}`);
    if (metarRow.length === 3) { lines.push(metarRow.join(" ")); metarRow = []; }
  }
  if (metarRow.length) lines.push(metarRow.join(" "));

  // Quick Look TCPs — the LAST block in RenderStatus (cs:3040, after METAR/FPS).
  const ql = prefSet.QuickLookedTCPs || [];
  if (ql.length > 0) lines.push("QL: " + ql.join(" "));

  el.innerHTML = lines.map(escapeHtml).join("<br>");
  // RadarWindow.cs:2943: StatusArea.ForeColor = AdjustedColor(DataBlockColor,
  // Brightness.Lists). DataBlockColor is the configured green; brightness
  // multiplies linearly. No bold, no shadow.
  const b = prefSet.Brightness.Lists / 100;
  el.style.color = `rgb(0, ${(255 * b) | 0}, 0)`;
  el.style.fontSize = (prefSet.CharSize?.Lists ?? 12) + "px";

  // Keep the preview (MCA) pinned just below the SSA so it follows when the SSA
  // grows/shrinks (e.g. signing on adds a TCP line) — otherwise the SSA grows
  // down OVER the preview and the typed text disappears. Stops tracking once the
  // user drags it (userMoved) or sets PreviewLocation by command.
  const mca = document.getElementById("mca");
  if (mca && !mca.dataset.userMoved && !prefSet.PreviewLocation) {
    const r = el.getBoundingClientRect();
    mca.style.top = (r.bottom + 8) + "px";
    mca.style.left = r.left + "px";
    mca.style.bottom = "auto";
  }
}

function fa(altFt) {
  // ToFilterAltitudeString (RadarWindow.cs:3053-3060): negative → "N99",
  // else abs(altitude/100) as a 3-digit string (e.g. 99900 → "999").
  if (altFt == null) return "N99";
  if (altFt < 0) return "N99";
  return String(Math.abs(Math.trunc(altFt / 100))).padStart(3, "0");
}
function escapeHtml(s) {
  return String(s).replace(/[<>&]/g, c => ({"<":"&lt;",">":"&gt;","&":"&amp;"}[c]));
}

// External hooks: parts of scope.js or future METAR fetches can poke SSA state.
window.SSA = SSA;
window.mountSsa = mountSsa;
window.refreshSsa = refreshSsa;
