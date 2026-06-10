// ─────────────────────────────────────────────────────────────────────────────
// STARS scope — Phase 1: foundation + chrome.
//
// Ported from github.com/yanjz124/scope:
//   • scope/STARS/PrefSet.cs            — every default value, mirrored verbatim
//   • scope/Radar.cs                    — haversine math + scan cadence
//   • scope/RadarWindow.cs              — colors (l. 60-110), AdjustedColor
//                                         (l. 782), DrawRangeRings (l. 5054),
//                                         DrawCompass (l. 4732), pan/zoom
//                                         (l. 1300-1320 mouse handlers).
//
// Anything not from the WPF source is documented in
// docs/stars/KNOWN-DEVIATIONS.md (G1..G6).
// ─────────────────────────────────────────────────────────────────────────────

const cv = document.getElementById("scope");
const ctx = cv.getContext("2d");

// ── Path params: /stars/{artcc}/{facility} ──────────────────────────────────
const pathMatch = location.pathname.match(/^\/stars\/([^/]+)\/([^/]+)/);
if (!pathMatch) { location.href = "/stars"; throw new Error("bad path"); }
const ARTCC = pathMatch[1];
const FACILITY = pathMatch[2];

// ── PrefSet — defaults exactly from scope/STARS/PrefSet.cs ──────────────────
// Anything we add beyond the WPF defaults is marked with // (web-only).
const prefSet = {
  ScreenCenterPoint: { Latitude: 0, Longitude: 0 },   // set from vNAS facility location
  DisplayedMaps: [],
  RangeRingsDisplayed: true,                          // (WPF defaults via ShowRangeRings field)
  RangeRingLocation: { Latitude: 0, Longitude: 0 },
  RangeRingSpacing: 5,                                // PrefSet.cs line 30
  RangeRingsCentered: true,                           // (WPF: false; we default centered for first-load convenience.
                                                      //  Right-click moves to point and unsets — see KNOWN-DEVIATIONS G7.)
  DCBLocation: "Top",                                 // PrefSet.cs line 31
  OwnedDataBlockPosition: 0,
  UnownedDataBlockPosition: 0,
  UnassociatedDataBlockPosition: 0,
  DCBVisible: true,
  PTLLength: 1,
  PTLOwn: false,
  PTLAll: false,
  HistoryNum: 10,
  HistoryRate: 4.5,
  LeaderLength: 1,
  Range: 6,
  AltitudeFilterAssociatedMax: 99900,
  AltitudeFilterAssociatedMin: -9900,
  AltitudeFilterUnAssociatedMax: 99900,
  AltitudeFilterUnAssociatedMin: -9900,
  LdbBeaconCodesInhibited: false,
  Brightness: {
    DCB: 100, Background: 100, RangeRings: 100, Compass: 100,
    VideoMapA: 100, VideoMapB: 100, DataBlock: 100,
    Lists: 100, Position: 100, History: 100, Weather: 100,
  },
};

// ── Colors — direct from RadarWindow.cs lines 60-110 ────────────────────────
const COLORS = {
  Back:        [0, 0, 0],         // BackColor = Color.Black
  RangeRing:   [140, 140, 140],   // line 63
  VideoMapA:   [140, 140, 140],   // line 66
  VideoMapB:   [140, 140, 140],   // line 69
  Return:      [30, 120, 255],    // line 72
  BeaconTarget:[0, 255, 0],       // line 74
  DataBlock:   [0, 255, 0],       // Color.Lime
  Pointout:    [255, 255, 0],     // line 80
  Owned:       [255, 255, 255],
  LDB:         [0, 255, 0],
  Selected:    [0, 255, 255],
  Emerg:       [255, 0, 0],
  RBL:         [255, 255, 255],
  TPA:         [90, 180, 255],
  ATPACaution: [255, 255, 0],
  ATPAAlert:   [255, 55, 0],
  Compass:     [140, 140, 140],   // RadarWindow.cs line 4736
};

// AdjustedColor — RadarWindow.cs line 776-786 (verbatim).
function adjusted([r, g, b], brightness) {
  if (brightness === 0) return "rgba(0,0,0,0)";
  const k = brightness / 100;
  return `rgb(${(r*k)|0}, ${(g*k)|0}, ${(b*k)|0})`;
}

// ── Geographic / screen math ────────────────────────────────────────────────
// Distance NM between two GeoPoints. From GeoPoint.cs DistanceTo (haversine).
function distanceNM(a, b) {
  const R = 3443.92; // nautical miles
  const φ1 = a.Latitude * Math.PI / 180;
  const φ2 = b.Latitude * Math.PI / 180;
  const dφ = (b.Latitude - a.Latitude) * Math.PI / 180;
  const dλ = (b.Longitude - a.Longitude) * Math.PI / 180;
  const h = Math.sin(dφ/2)**2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ/2)**2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Geometry: at runtime we track the canvas size, the "scale" (NM per pixel on
// the shorter axis), and we project from geo (lon, lat) → screen (px, py)
// using a simple equirectangular projection centered at the ScreenCenterPoint.
// This mirrors RadarWindow.cs's GeoToScreen path. NOT a Mercator: STARS is
// tangent-plane at home lat (correct for the scope-sized FOV).
const view = {
  W: 0, H: 0,
  // scale = NM per (half-shorter-axis pixel). Range is "half-shorter-axis NM",
  // so scale = Range / (shorterDim/2). RadarWindow.cs: scale = Range / halfDim.
  scale: 1,
};

function resize() {
  const dpr = window.devicePixelRatio || 1;
  view.W = window.innerWidth;
  view.H = window.innerHeight;
  cv.width = view.W * dpr;
  cv.height = view.H * dpr;
  cv.style.width = view.W + "px";
  cv.style.height = view.H + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  recomputeScale();
}
function recomputeScale() {
  const halfShort = Math.min(view.W, view.H) / 2;
  view.scale = prefSet.Range / halfShort; // NM per pixel
}
window.addEventListener("resize", resize);

// Geo → screen px (origin at canvas center).
function geoToScreen(geo) {
  const ctr = prefSet.ScreenCenterPoint;
  const latFactor = Math.cos(ctr.Latitude * Math.PI / 180);
  const dx_deg = geo.Longitude - ctr.Longitude;
  const dy_deg = geo.Latitude - ctr.Latitude;
  // 1 degree latitude = 60 NM. Longitude shrinks by cos(lat).
  const dx_NM = dx_deg * 60 * latFactor;
  const dy_NM = dy_deg * 60;
  return {
    x: view.W / 2 + dx_NM / view.scale,
    y: view.H / 2 - dy_NM / view.scale, // screen Y inverted
  };
}
function screenToGeo(px, py) {
  const ctr = prefSet.ScreenCenterPoint;
  const latFactor = Math.cos(ctr.Latitude * Math.PI / 180);
  const dx_NM = (px - view.W / 2) * view.scale;
  const dy_NM = -(py - view.H / 2) * view.scale;
  return {
    Latitude: ctr.Latitude + dy_NM / 60,
    Longitude: ctr.Longitude + dx_NM / (60 * latFactor),
  };
}

// ── Drawing primitives ──────────────────────────────────────────────────────
function clear() {
  ctx.fillStyle = adjusted(COLORS.Back, prefSet.Brightness.Background);
  ctx.fillRect(0, 0, view.W, view.H);
}

// DrawRangeRings — RadarWindow.cs line 5054.
//   rrr = (aspect>1 ? Range*1.414*aspect : Range*1.414/aspect) + distance
//   for i = spacing; i <= rrr; i += spacing: DrawCircle(rrCenter, i NM, color)
function drawRangeRings() {
  if (!prefSet.RangeRingsDisplayed) return;
  if (prefSet.Brightness.RangeRings === 0) return;
  if (prefSet.RangeRingSpacing <= 0) return;

  const ctr = prefSet.ScreenCenterPoint;
  const rrCenter = prefSet.RangeRingsCentered ? ctr : prefSet.RangeRingLocation;
  const distance = distanceNM(ctr, rrCenter);
  const aspect_ratio = view.W / view.H;
  const a = aspect_ratio > 1 ? aspect_ratio : 1 / aspect_ratio;
  const rrrMax = prefSet.Range * 1.414 * a + distance;

  const color = adjusted(COLORS.RangeRing, prefSet.Brightness.RangeRings);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;

  const rrScreen = geoToScreen(rrCenter);
  for (let i = prefSet.RangeRingSpacing; i <= rrrMax; i += prefSet.RangeRingSpacing) {
    const radiusPx = i / view.scale;
    ctx.beginPath();
    ctx.arc(rrScreen.x, rrScreen.y, radiusPx, 0, Math.PI * 2);
    ctx.stroke();
  }
}

// DrawCompass — RadarWindow.cs line 4732.
// Rectangle outline + 5°-spaced tick marks on each edge + 10°-labeled bearings.
function drawCompass() {
  if (prefSet.Brightness.Compass === 0) return;
  const color = adjusted(COLORS.Compass, prefSet.Brightness.Compass);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1;
  ctx.font = "11px ui-monospace, monospace";

  // pixelScale = scale (WPF: a single px in screen units; in canvas we use 1).
  const linelength = 15;
  // WPF: w = arscale.Column1.Length - pixelScale, h = arscale.Column0.Length - pixelScale
  // i.e. half-width/half-height in canvas space, minus a 1-pixel inset.
  let w = view.W / 2 - 1;
  let h = view.H / 2 - 1;
  // DCB occupies one edge — placeholder reservation (Phase 4 will populate).
  // Mirrors WPF lines 4744-4768.
  const dcbSize = 0; // Phase 4: will become non-zero.
  let dx = 0, dy = 0;
  if (prefSet.DCBVisible && dcbSize > 0) {
    if (prefSet.DCBLocation === "Left" || prefSet.DCBLocation === "Right") {
      w -= dcbSize / 2;
      dx = prefSet.DCBLocation === "Left" ? dcbSize / 2 : -dcbSize / 2;
    } else {
      h -= dcbSize / 2;
      dy = prefSet.DCBLocation === "Top" ? dcbSize / 2 : -dcbSize / 2;
    }
  }

  ctx.save();
  ctx.translate(view.W / 2 + dx, view.H / 2 + dy);
  // canvas Y is inverted relative to WPF GL coords; flip so that "up" = -y
  ctx.scale(1, -1);

  // Rectangle outline — DrawLine x4.
  ctx.beginPath();
  ctx.rect(-w, -h, 2 * w, 2 * h);
  ctx.stroke();

  const aspect_ratio = w / h;
  const atan = Math.atan(aspect_ratio) * 180 / Math.PI;
  const h1 = h - linelength;
  const w1 = w - linelength;
  const hr = h1 / h;
  const wr = w1 / w;

  let i;
  // Top + bottom edges, ticks from 0 to atan°.
  for (i = 0; i < atan; i += 5) {
    const x = Math.tan(i * Math.PI / 180) * h;
    const x1 = x * hr;
    drawLineNoFlip( x,  h,  x1,  h1, color);
    drawLineNoFlip(-x,  h, -x1,  h1, color);
    drawLineNoFlip( x, -h,  x1, -h1, color);
    drawLineNoFlip(-x, -h, -x1, -h1, color);

    if (i % 10 === 0) {
      const line = i / 10;
      labelAt(`${i}`,         x1, h1 - 8);
      labelAt(`${i + 180}`,  -x1, -h1 + 8);
      if (line > 0) {
        labelAt(`${180 - i}`,  x1, -h1 + 8);
        labelAt(`${360 - i}`, -x1,  h1 - 8);
      } else {
        // 360 (=0 at top center)
      }
    }
  }
  // Side edges, ticks from atan° to 90°.
  for (; i <= 90; i += 5) {
    const y = Math.tan((90 - i) * Math.PI / 180) * w;
    const y1 = y * wr;
    drawLineNoFlip( w,  y,  w1,  y1, color);
    drawLineNoFlip(-w,  y, -w1,  y1, color);
    drawLineNoFlip( w, -y,  w1, -y1, color);
    drawLineNoFlip(-w, -y, -w1, -y1, color);

    if (i % 10 === 0) {
      labelAt(`${i}`,         w1 + 4,  y1);
      labelAt(`${i + 180}`,  -w1 - 4, -y1);
      labelAt(`${180 - i}`,   w1 + 4, -y1);
      labelAt(`${360 - i}`,  -w1 - 4,  y1);
    }
  }
  ctx.restore();
}

function drawLineNoFlip(x1, y1, x2, y2, color) {
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}
function labelAt(text, x, y) {
  // Flip Y back for text rendering so glyphs aren't upside-down.
  ctx.save();
  ctx.scale(1, -1);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x, -y);
  ctx.restore();
}

// ── Video maps (Phase 2) ────────────────────────────────────────────────────
// Mirrors scope/MapGeoJSON.cs (GeoJSON → Line decoder) + scope/VideoMap.cs
// (Number/Name/Mnemonic/Category/Lines) + RadarWindow.cs:5302 (DrawVideoMapLines).
//
// videoMaps[i] = {
//   id, name, shortName, starsId, starsBrightnessCategory, starsAlwaysVisible,
//   visible (runtime toggle),
//   category: "A" | "B",
//   lines: [{lat1,lon1,lat2,lon2}, ...]   // populated lazily on first display
// }
const videoMaps = [];

// GeoJSON geometry → flat line list (mirrors MapGeoJSON.cs GeometryToLines).
// We mirror the recursion: LineString, MultiLineString, Polygon (ring closure),
// MultiPolygon, GeometryCollection, Feature, FeatureCollection.
function geoJsonToLines(obj, out) {
  if (!obj) return;
  if (Array.isArray(obj)) { for (const o of obj) geoJsonToLines(o, out); return; }
  switch (obj.type) {
    case "FeatureCollection":
      for (const f of (obj.features || [])) geoJsonToLines(f, out);
      return;
    case "Feature":
      geoJsonToLines(obj.geometry, out);
      return;
    case "GeometryCollection":
      for (const g of (obj.geometries || [])) geoJsonToLines(g, out);
      return;
    case "LineString":
      lineStringToLines(obj.coordinates, out);
      return;
    case "MultiLineString":
      for (const ls of (obj.coordinates || [])) lineStringToLines(ls, out);
      return;
    case "Polygon":
      for (const ring of (obj.coordinates || [])) ringToLines(ring, out);
      return;
    case "MultiPolygon":
      for (const poly of (obj.coordinates || []))
        for (const ring of poly) ringToLines(ring, out);
      return;
    case "Point":
    case "MultiPoint":
      return; // no lines from points (matches WPF GeometryToLines no-op)
  }
}
function lineStringToLines(coords, out) {
  if (!Array.isArray(coords) || coords.length < 2) return;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1], b = coords[i];
    out.push({ lon1: a[0], lat1: a[1], lon2: b[0], lat2: b[1] });
  }
}
function ringToLines(coords, out) {
  // PolygonToLines + LinearRingToLines: connect consecutive vertices AND close ring.
  if (!Array.isArray(coords) || coords.length < 2) return;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1], b = coords[i];
    out.push({ lon1: a[0], lat1: a[1], lon2: b[0], lat2: b[1] });
  }
  // GeoJSON spec: first == last for valid rings, so the last segment closes it.
}

async function loadVideoMapsCatalog(starsConfig, vnasMaps) {
  // vnasMaps from /api/stars/facility/{...} carries id, name, shortName, starsId, starsBrightnessCategory.
  // starsConfig.videoMapIds is the ordered list this facility uses.
  if (!Array.isArray(vnasMaps)) return;
  for (const m of vnasMaps) {
    videoMaps.push({
      id: m.id,
      name: m.name || "",
      shortName: m.shortName || "",
      starsId: m.starsId ?? null,
      category: (m.starsBrightnessCategory === "B") ? "B" : "A",
      visible: !!m.starsAlwaysVisible,
      lines: null,        // lazy
      _loading: false,
    });
  }
  prefSet.DisplayedMaps = videoMaps.filter(m => m.visible && m.starsId != null).map(m => m.starsId);
}

async function ensureMapLoaded(map) {
  if (map.lines !== null || map._loading) return;
  map._loading = true;
  try {
    const r = await fetch(`/api/stars/videoMap/${encodeURIComponent(ARTCC)}/${encodeURIComponent(map.id)}`);
    if (!r.ok) { map.lines = []; return; }
    const gj = await r.json();
    const out = [];
    geoJsonToLines(gj, out);
    map.lines = out;
  } catch (e) {
    console.warn(`[STARS] map ${map.id} load failed:`, e);
    map.lines = [];
  } finally {
    map._loading = false;
  }
}

function drawVideoMapLines() {
  // RadarWindow.cs:5302. Two passes: Category A then Category B, each with its
  // own brightness multiplier (Brightness.VideoMapA / VideoMapB). Lines color
  // = RGB(140,140,140) for both categories at 100%.
  const prevBlend = ctx.globalCompositeOperation;
  ctx.globalCompositeOperation = "lighter";   // G11 — additive ≈ max for grey

  for (const cat of ["A", "B"]) {
    const brightness = (cat === "A")
      ? prefSet.Brightness.VideoMapA
      : prefSet.Brightness.VideoMapB;
    if (brightness === 0) continue;
    const baseColor = (cat === "A") ? COLORS.VideoMapA : COLORS.VideoMapB;
    const color = adjusted(baseColor, brightness);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;

    let count = 0;
    ctx.beginPath();
    for (const m of videoMaps) {
      if (m.category !== cat) continue;
      if (!m.visible) continue;
      if (m.lines === null) { ensureMapLoaded(m); continue; }
      for (const ln of m.lines) {
        const p1 = geoToScreen({ Latitude: ln.lat1, Longitude: ln.lon1 });
        const p2 = geoToScreen({ Latitude: ln.lat2, Longitude: ln.lon2 });
        // Cull lines wholly off-screen
        if ((p1.x < 0 && p2.x < 0) || (p1.x > view.W && p2.x > view.W) ||
            (p1.y < 0 && p2.y < 0) || (p1.y > view.H && p2.y > view.H)) continue;
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        if (++count > 8000) { ctx.stroke(); ctx.beginPath(); count = 0; }
      }
    }
    ctx.stroke();
  }
  ctx.globalCompositeOperation = prevBlend;
}

// Temp UI to toggle individual maps (DCB MAP buttons land in Phase 4). G9-style TEMP.
function buildMapListPanel() {
  const div = document.createElement("div");
  div.id = "mapPanel";
  div.style.cssText = `position:fixed; right:0; top:30px; bottom:0; width:200px;
    background:rgba(0,0,0,0.7); color:#6f6; font:11px ui-monospace;
    overflow-y:auto; padding:6px; border-left:1px solid #1a3a1a; z-index:9;`;
  document.body.appendChild(div);
  refreshMapList();
}
function refreshMapList() {
  const div = document.getElementById("mapPanel");
  if (!div) return;
  const html = videoMaps.map((m, i) => `
    <label style="display:flex; gap:4px; padding:2px 0; cursor:pointer;">
      <input type="checkbox" data-i="${i}" ${m.visible ? "checked" : ""}/>
      <span style="color:${m.category === "A" ? "#6f6" : "#cfc"}">${m.shortName || m.name || m.id.slice(0, 8)}</span>
    </label>`).join("");
  div.innerHTML = `<div style="color:#888; padding-bottom:4px;">MAPS (${videoMaps.length})</div>${html}`;
  for (const ip of div.querySelectorAll("input[type=checkbox]")) {
    ip.onchange = () => {
      const m = videoMaps[+ip.dataset.i];
      m.visible = ip.checked;
      if (m.visible && m.lines === null) ensureMapLoaded(m);
    };
  }
}

// ── DSTARS track stream (Phase 3a) ──────────────────────────────────────────
// Source: DGScope.Receivers.ScopeServer/JsonUpdate.cs + ScopeServerClient.cs
// + Track.cs + FlightPlan.cs (the DGScope client this scope mirrors).
//
// SwimReader.Server emits newline-delimited JSON at /dstars/{facility}/updates
// matching DstarsTrackUpdate / DstarsFlightPlanUpdate / DstarsDeletionUpdate
// (see src/SwimReader.Server/Adapters/Dstars*.cs).
//
// We use HTTP streaming via fetch+ReadableStream (the WebSocket alternative
// requires proxy work and HTTP-stream is well-supported in browsers).
//
// Phase 3a renders position SYMBOLS ONLY (no data blocks, leaders, history,
// PTLs). Phase 3b adds the rest.

const tracks = new Map();        // Guid → Track {Location, Squawk, Callsign, ...}
const flightPlans = new Map();   // Guid → FlightPlan {AssociatedTrackGuid, Owner, ...}
const trackToFp = new Map();     // trackGuid → flightPlan (cached lookup)
const dstarsState = { connected: false, msgCount: 0, lastError: null };

function dstarsFacility() {
  const qs = new URLSearchParams(location.search);
  return qs.get("dstars") || FACILITY;
}

async function startDstars() {
  const fac = dstarsFacility();
  const url = `/dstars/${encodeURIComponent(fac)}/updates`;
  while (true) {
    try {
      dstarsState.lastError = null;
      const r = await fetch(url, { credentials: "omit" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      dstarsState.connected = true;
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try { handleUpdate(JSON.parse(line)); }
          catch (e) { /* skip malformed */ }
        }
      }
    } catch (e) {
      dstarsState.lastError = String(e).slice(0, 100);
      dstarsState.connected = false;
    }
    // Reconnect with backoff
    await new Promise(res => setTimeout(res, 3000));
  }
}

function handleUpdate(u) {
  dstarsState.msgCount++;
  switch (u.UpdateType) {
    case 0: handleTrackUpdate(u); return;
    case 1: handleFlightPlanUpdate(u); return;
    case 2: handleDeletion(u); return;
    // 3 = weather, handled in Phase 10
  }
}

// Track: per scope/DGScope.Receivers.ScopeServer/Track.cs — partial-update
// semantics. Any field present overwrites; absent fields preserved.
function handleTrackUpdate(u) {
  let t = tracks.get(u.Guid);
  if (!t) { t = { Guid: u.Guid, lastUpdate: 0 }; tracks.set(u.Guid, t); }
  t.lastUpdate = Date.now();
  if (u.Location)      t.Location = u.Location;
  if (u.Altitude)      t.Altitude = u.Altitude;
  if (u.GroundSpeed != null)  t.GroundSpeed = u.GroundSpeed;
  if (u.GroundTrack != null)  t.GroundTrack = u.GroundTrack;
  if (u.VerticalRate != null) t.VerticalRate = u.VerticalRate;
  if (u.Squawk != null)       t.Squawk = u.Squawk;
  if (u.Callsign != null)     t.Callsign = u.Callsign;
  if (u.ModeSCode != null)    t.ModeSCode = u.ModeSCode;
  if (u.IsOnGround != null)   t.IsOnGround = u.IsOnGround;
  if (u.Ident != null)        t.Ident = u.Ident;
}

function handleFlightPlanUpdate(u) {
  let fp = flightPlans.get(u.Guid);
  if (!fp) { fp = { Guid: u.Guid }; flightPlans.set(u.Guid, fp); }
  for (const k of ["Callsign","AircraftType","WakeCategory","FlightRules",
       "Origin","Destination","EntryFix","ExitFix","Route","RequestedAltitude",
       "Scratchpad1","Scratchpad2","Runway","Owner","PendingHandoff",
       "AssignedSquawk","EquipmentSuffix","LDRDirection","AssociatedTrackGuid"]) {
    if (u[k] !== undefined) fp[k] = u[k];
  }
  if (fp.AssociatedTrackGuid) trackToFp.set(fp.AssociatedTrackGuid, fp);
}

function handleDeletion(u) {
  // Could be a track guid or fp guid — try both.
  if (tracks.delete(u.Guid)) trackToFp.delete(u.Guid);
  flightPlans.delete(u.Guid);
}

// ── Track rendering: position symbols only (Phase 3a) ───────────────────────
// CRC docs § "Track types" + RadarWindow.cs:
//   ◇ diamond  — associated track (has a flight plan)
//   \  back-slash — correlated beacon (squawk + no flight plan)
//   /  slash      — uncorrelated beacon (squawk but no flight plan or out of area)
//   +  plus       — uncorrelated primary (no squawk)
//   #  hash       — coast track (no position update for >2 scan cycles)
// At/below FL230 the associated diamond becomes a small bullet (•) per ERAM
// convention; STARS uses the diamond throughout — KEEP DIAMOND. See CRC docs.
function symbolFor(track) {
  const hasSquawk = !!track.Squawk && track.Squawk !== "" && track.Squawk !== "0000";
  const hasFp = trackToFp.has(track.Guid);
  const isCoast = (Date.now() - track.lastUpdate) > 24000; // 2 × 12s scan cycle
  if (isCoast) return "#";
  if (hasFp) return "◇";
  if (hasSquawk) return "\\";
  return "+";
}

function drawTracks() {
  ctx.font = "12px ui-monospace, monospace";
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.fillStyle = adjusted(COLORS.BeaconTarget, prefSet.Brightness.Position);

  for (const t of tracks.values()) {
    if (!t.Location) continue;
    if (t.IsOnGround) continue;            // Radar.cs Scan filters on-ground
    // Altitude filter — PrefSet AltitudeFilterAssociatedMin/Max.
    const altFt = t.Altitude?.Value;
    const fp = trackToFp.get(t.Guid);
    if (altFt != null) {
      if (fp) {
        if (altFt < prefSet.AltitudeFilterAssociatedMin) continue;
        if (altFt > prefSet.AltitudeFilterAssociatedMax) continue;
      } else {
        if (altFt < prefSet.AltitudeFilterUnAssociatedMin) continue;
        if (altFt > prefSet.AltitudeFilterUnAssociatedMax) continue;
      }
    }
    const p = geoToScreen(t.Location);
    // Cull off-screen
    if (p.x < -10 || p.x > view.W + 10 || p.y < -10 || p.y > view.H + 10) continue;
    ctx.fillText(symbolFor(t), p.x, p.y);
  }
}

// ── Main render loop ────────────────────────────────────────────────────────
function frame() {
  clear();
  drawVideoMapLines();
  drawRangeRings();
  drawCompass();
  drawTracks();
  updateTopbar();
  requestAnimationFrame(frame);
}

function updateTopbar() {
  const c = prefSet.ScreenCenterPoint;
  document.getElementById("rangeLbl").textContent  = `RNG ${prefSet.Range}`;
  document.getElementById("ringLbl").textContent   = `RR ${prefSet.RangeRingSpacing}${prefSet.RangeRingsCentered ? " (CTR)" : ""}`;
  document.getElementById("centerLbl").textContent = `CTR ${c.Latitude.toFixed(4)}/${c.Longitude.toFixed(4)}`;
  const tracksLbl = document.getElementById("tracksLbl");
  if (tracksLbl)
    tracksLbl.textContent = `T ${tracks.size}/${flightPlans.size}` +
      ` ${dstarsState.connected ? "LIVE" : (dstarsState.lastError || "off")}`;
}

// ── Input: pan / zoom / right-click set RR center ───────────────────────────
// Mouse handlers mirror RadarWindow.cs ~lines 1300-1320 + 4636-4650 for zoom.
let panning = false;
let lastPan = null;
cv.addEventListener("mousedown", (e) => {
  if (e.button === 1) {            // middle = pan
    panning = true;
    lastPan = { x: e.clientX, y: e.clientY };
    e.preventDefault();
  }
});
cv.addEventListener("mousemove", (e) => {
  if (!panning) return;
  const dx_px = e.clientX - lastPan.x;
  const dy_px = e.clientY - lastPan.y;
  lastPan = { x: e.clientX, y: e.clientY };
  const ctr = prefSet.ScreenCenterPoint;
  const latFactor = Math.cos(ctr.Latitude * Math.PI / 180);
  ctr.Latitude  += ( dy_px * view.scale) / 60;
  ctr.Longitude -= ( dx_px * view.scale) / (60 * latFactor);
});
window.addEventListener("mouseup", () => { panning = false; });

cv.addEventListener("wheel", (e) => {
  e.preventDefault();
  // RadarWindow.cs cycles Range via DCB buttons; mouse-wheel here is a web-only
  // convenience (G7). Doubles/halves rounded to nearest integer NM.
  const step = e.deltaY < 0 ? 0.85 : 1.18;
  prefSet.Range = Math.max(1, Math.min(400, Math.round(prefSet.Range * step)));
  recomputeScale();
}, { passive: false });

cv.addEventListener("contextmenu", (e) => {
  e.preventDefault();  // G6
  // RadarWindow.cs line 1317-1318: right-click sets RangeRingLocation and
  // unsets RangeRingsCentered.
  prefSet.RangeRingLocation = screenToGeo(e.clientX, e.clientY);
  prefSet.RangeRingsCentered = false;
});

// ── Bootstrap: load facility, set HomeLocation, kick off render ─────────────
async function bootstrap() {
  document.getElementById("facilityLbl").textContent = `${ARTCC} / ${FACILITY}`;
  resize();
  try {
    const fac = await fetch(`/api/stars/facility/${encodeURIComponent(ARTCC)}/${encodeURIComponent(FACILITY)}`).then(r => r.json());
    if (fac && fac.location) {
      const loc = fac.location;
      prefSet.ScreenCenterPoint = { Latitude: loc.lat, Longitude: loc.lon };
      prefSet.RangeRingLocation = { Latitude: loc.lat, Longitude: loc.lon };
    } else {
      // Fall back to first ASR site if facility has no direct location field.
      // (vNAS schema: some facility levels carry asrSites rather than a single lat/lon.)
      const sc = fac && fac.starsConfiguration;
      if (sc && sc.areas && sc.areas[0] && sc.areas[0].defaultRange) {
        prefSet.Range = sc.areas[0].defaultRange;
      }
      console.warn("[STARS] Facility has no top-level location field; using default 0,0.");
    }
    document.getElementById("facilityLbl").textContent =
      `${ARTCC} / ${FACILITY}${fac && fac.name ? " — " + fac.name : ""}`;
    recomputeScale();

    // Phase 2: load video map catalog + render panel
    if (fac) {
      await loadVideoMapsCatalog(fac.starsConfiguration, fac.videoMaps);
      buildMapListPanel();
    }
  } catch (e) {
    console.error("[STARS] Failed to load facility:", e);
  }
  // Phase 3a: DSTARS streaming connection. Runs independent of facility load.
  startDstars();
  requestAnimationFrame(frame);
}
bootstrap();
