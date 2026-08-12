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
// Crisp STARS-style glyph rendering (KNOWN-DEVIATIONS G1 workaround): prefer
// geometric glyph metrics over hinted anti-aliasing so text matches the WPF look.
if ("textRendering" in ctx) ctx.textRendering = "geometricPrecision";

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
  RangeRingsCentered: false,                          // WPF default: rings anchored to RangeRingLocation (a geo
                                                      //  point set to facility center on load) so they pan with
                                                      //  the map. RR CNTR toggles screen-centered.
  DCBLocation: "Top",                                 // PrefSet.cs line 31
  OwnedDataBlockPosition: 2,        // N (LeaderDirection enum) — 0 would render "INV"
  UnownedDataBlockPosition: 2,
  UnassociatedDataBlockPosition: 2,
  DCBVisible: true,
  PTLLength: 1,
  PTLOwn: false,
  PTLAll: false,
  HistoryNum: 10,                 // PrefSet.cs:38 — WPF default 10
  HistoryRate: 4.5,
  LeaderLength: 1,
  Range: 6,                       // PrefSet.cs:41 — WPF default 6 NM

  AltitudeFilterAssociatedMax: 99900,
  AltitudeFilterAssociatedMin: -9900,
  AltitudeFilterUnAssociatedMax: 99900,
  AltitudeFilterUnAssociatedMin: -9900,
  LdbBeaconCodesInhibited: false,
  // PrefSet.cs:47 → BrightnessSettings: 15 separate fields per cs:72-152.
  // Each defaults to 100 (the WPF property getters return 100 when unset).
  // Compass defaults to 100 in WPF; the user's RDU profile turns it to 0 —
  // profile load supplies the override.
  // The renderer reads the SPECIFIC field per element type so the BRITE
  // submenu sliders can move them independently. Legacy collapsed aliases
  // (DataBlock / Position / Weather sole) live alongside as last-write-wins
  // mirrors for renderers that haven't been split yet.
  Brightness: {
    DCB: 100, Background: 100,
    MapA: 100, MapB: 100,
    FullDataBlocks: 100, LimitedDataBlocks: 100, OtherFDBs: 100,
    Lists: 100, Tools: 100, RangeRings: 100, Compass: 100,
    PositionSymbols: 100, BeaconTargets: 100, PrimaryTargets: 100,
    History: 100, Weather: 100, WeatherContrast: 100,
    // Legacy aliases (KEEP — many call sites still reference these):
    VideoMapA: 100, VideoMapB: 100,
    DataBlock: 100, Position: 100,
  },
  // Per CRC § CHAR SIZE — 5 adjustable categories. Sizes here are in pixels.
  // The DCB CHAR SIZE submenu cycles each value in steps.
  CharSize: {
    DataBlock: 14,
    Lists:     12,
    DCB:       11,
    Tools:     11,
    Position:  15,
  },
};

// ── Colors — direct from RadarWindow.cs lines 60-110 ────────────────────────
// MUTABLE so profile.js can overwrite each field from <BackColor>/<ReturnColor>
// /etc. in the DGScope XML. The defaults below are the RadarWindow.cs ctor
// values; a loaded profile replaces only the fields it carries.
const COLORS = window.COLORS = {
  Back:        [0, 0, 0],         // BackColor = Color.Black
  RangeRing:   [140, 140, 140],   // line 63
  VideoMapA:   [140, 140, 140],   // line 66
  VideoMapB:   [140, 140, 140],   // line 69
  Return:      [30, 120, 255],    // line 72
  BeaconTarget:[0, 255, 0],       // line 74
  DataBlock:   [0, 255, 0],       // Color.Lime
  Pointout:    [255, 255, 0],     // line 80
  Claimed:     [0, 255, 255],     // Light blue for middle-clicked aircraft (#00FFFF)
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
// RadarWindow.cs applies GL.Rotate(ScreenRotation, 0, 0, 1) to the scope
// matrix before rendering tracks/maps/rings. We fold the equivalent
// rotation into the projection so every consumer (drawTracks, drawRBLs,
// nexrad polygons, video maps) honours it without a separate ctx transform.
function geoToScreen(geo) {
  const ctr = prefSet.ScreenCenterPoint;
  const latFactor = Math.cos(ctr.Latitude * Math.PI / 180);
  // 1 degree latitude = 60 NM. Longitude shrinks by cos(lat).
  const dx_NM = (geo.Longitude - ctr.Longitude) * 60 * latFactor;
  const dy_NM = (geo.Latitude  - ctr.Latitude)  * 60;
  const rot = ((prefSet.ScreenRotation || 0) * Math.PI) / 180;
  const cosR = Math.cos(rot), sinR = Math.sin(rot);
  // Positive rotation = CCW in math; WPF GL.Rotate uses the same convention.
  // North (dy_NM > 0) at ScreenRotation=0 lands at top of screen (y = -dy_NM/scale).
  const rx = dx_NM * cosR - dy_NM * sinR;
  const ry = dx_NM * sinR + dy_NM * cosR;
  return {
    x: view.W / 2 + rx / view.scale,
    y: view.H / 2 - ry / view.scale, // screen Y inverted
  };
}
function screenToGeo(px, py) {
  const ctr = prefSet.ScreenCenterPoint;
  const latFactor = Math.cos(ctr.Latitude * Math.PI / 180);
  // Invert the rotation when going back screen → geo.
  const rx = (px - view.W / 2) * view.scale;
  const ry = -(py - view.H / 2) * view.scale;
  const rot = ((prefSet.ScreenRotation || 0) * Math.PI) / 180;
  const cosR = Math.cos(rot), sinR = Math.sin(rot);
  const dx_NM =  rx * cosR + ry * sinR;
  const dy_NM = -rx * sinR + ry * cosR;
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
  ctx.font = "11px FixedDemiBold, ui-monospace, monospace";

  // pixelScale = scale (WPF: a single px in screen units; in canvas we use 1).
  const linelength = 15;
  // WPF: w = arscale.Column1.Length - pixelScale, h = arscale.Column0.Length - pixelScale
  // i.e. half-width/half-height in canvas space, minus a 1-pixel inset.
  let w = view.W / 2 - 1;
  let h = view.H / 2 - 1;
  // DCB occupies one edge — reserve its actual thickness so the compass sits
  // BELOW it (WPF lines 4744-4768: h -= dcb.Size/2 + translate dcb.Size/2).
  const dcbEl = document.getElementById("dcb");
  const dcbRect = dcbEl ? dcbEl.getBoundingClientRect() : null;
  const sideDcb = prefSet.DCBLocation === "Left" || prefSet.DCBLocation === "Right";
  const dcbSize = (prefSet.DCBVisible && dcbRect)
    ? (sideDcb ? dcbRect.width : dcbRect.height) : 0;
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
      // DGScope offsets labels inward by the label height (cs:4809).
      const lh = 14;
      // RadarWindow.cs:4791-4803 — special case for i=0: top-centre label
      // reads "360" not "0", AND the south-centre tick stays "180" (we
      // already emit that via `${i + 180}`). For i>0 the symmetric labels
      // at 180-i (south) and 360-i (north, west side) also render.
      labelAt(line === 0 ? "360" : `${i}`, x1, h1 - lh);
      labelAt(`${i + 180}`,                -x1, -h1 + lh);
      if (line > 0) {
        labelAt(`${180 - i}`,  x1, -h1 + lh);
        labelAt(`${360 - i}`, -x1,  h1 - lh);
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
      // INSIDE the border by the label width (cs:4844-4853), not outside it.
      const lw = ctx.measureText(`${i}`).width + 6;
      labelAt(`${i}`,         w1 - lw,  y1);
      labelAt(`${i + 180}`,  -w1 + lw, -y1);
      labelAt(`${180 - i}`,   w1 - lw, -y1);
      labelAt(`${360 - i}`,  -w1 + lw,  y1);
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
    // Drop starsAlwaysVisible maps entirely (airport diagrams / towers /
    // runways) — we don't render them.
    if (m.starsAlwaysVisible) continue;
    videoMaps.push({
      id: m.id,
      name: m.name || "",
      shortName: m.shortName || "",
      starsId: m.starsId ?? null,
      category: (m.starsBrightnessCategory === "B") ? "B" : "A",
      visible: false,
      lines: null,        // lazy
      _loading: false,
    });
  }
  // vNAS starsConfiguration.mapGroups is the canonical DCB-button binding
  // table. Each Mapgroup (CRCARTCC.cs:171-176) has:
  //   mapIds[38] → STARS map numbers for DCB slots 1..38
  //                slots 1..6   = inline MAP buttons on the main DCB page
  //                slots 7..32  = MAPS submenu (26 buttons, per
  //                              .stars-reference/GUIDE_MultipleVideoMaps.md:7)
  //                slots 33..38 = unused by DCB toolbar (reserved)
  //   tcps[]    → controller positions (e.g. "1S","1B","3M") this group
  //               applies to. Different positions in the same TRACON can
  //               and do see different DCB map layouts.
  // Selection: ?tcp=NAME overrides; otherwise first mapGroup.
  starsState.mapGroups = Array.isArray(starsConfig?.mapGroups) ? starsConfig.mapGroups : [];
  const tcpSel = new URLSearchParams(location.search).get("tcp");
  let activeGroup = null;
  if (tcpSel && starsState.mapGroups.length) {
    activeGroup = starsState.mapGroups.find(g =>
      Array.isArray(g.tcps) && g.tcps.some(t => (t || "").toUpperCase() === tcpSel.toUpperCase())
    ) || null;
  }
  if (!activeGroup) activeGroup = starsState.mapGroups[0] || null;
  starsState.activeMapGroup = activeGroup;
  // Length-38 nullable starsId array (matches DGScope TCP.DCBMapList).
  activeMapIds = Array(38).fill(null);
  if (activeGroup && Array.isArray(activeGroup.mapIds)) {
    for (let i = 0; i < Math.min(38, activeGroup.mapIds.length); i++) {
      activeMapIds[i] = (activeGroup.mapIds[i] != null) ? activeGroup.mapIds[i] : null;
    }
  }
  // ?maps= overrides which maps are visible (persisted selection).
  if (_urlMapIds) {
    for (const m of videoMaps) m.visible = m.starsId != null && _urlMapIds.includes(m.starsId);
    for (const m of videoMaps) if (m.visible && m.lines === null) ensureMapLoaded(m);
  }
  prefSet.DisplayedMaps = videoMaps.filter(m => m.visible && m.starsId != null).map(m => m.starsId);
}

// Warm the lazy line cache for ALL of the facility's maps in the background,
// so toggling a MAP button later renders instantly. Runs at low concurrency
// after the scope is interactive; DCB-assigned maps (MAP1-6) go first. A few
// seconds of fetching up front is fine — the user opted into that tradeoff.
async function warmAllMaps() {
  const assigned = new Set(activeMapIds.filter(x => x != null));
  const queue = [...videoMaps].sort((a, b) =>
    (assigned.has(b.starsId) ? 1 : 0) - (assigned.has(a.starsId) ? 1 : 0));
  const CONCURRENCY = 6;
  let i = 0;
  async function worker() {
    while (i < queue.length) {
      const m = queue[i++];
      if (m.lines === null && !m._loading) await ensureMapLoaded(m);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
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
    // WPF line width = GL default 1.0 px; on canvas2D a 1px stroke gets
    // antialiased to near-invisible thinness. 1.25 matches the WPF visual
    // weight after subpixel rendering.
    ctx.lineWidth = 1.25;

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

// Phase 2 temp map panel removed in Phase 4 — real DCB MAPS submenu serves the
// same toggles. (G9 retirement.)

// DCB state — DGScope TCP.DCBMapList[38] (RadarWindow.cs:812-814, 3909, 3959):
//   activeMapIds[0..5]  = inline MAP buttons on the main DCB page
//   activeMapIds[6..31] = MAPS submenu (26 buttons)
//   activeMapIds[32..37] = reserved/unused by DCB
// Sourced from the vNAS Mapgroup matching the active TCP (per area /
// position selection). A DGScope profile XML can still overwrite this when
// loaded.
let activeMapIds = Array(38).fill(null);
function dcbMapAt(i) {
  // i ∈ [0..5] for inline MAP buttons.
  const starsId = activeMapIds[i];
  if (starsId == null) return null;
  return videoMaps.find(m => m.starsId === starsId) || null;
}
function dcbSubmenuMapAt(i) {
  // i ∈ [0..25] for MAPS submenu (offsets into activeMapIds[6..31]).
  const starsId = activeMapIds[i + 6];
  if (starsId == null) return null;
  return videoMaps.find(m => m.starsId === starsId) || null;
}
// Kept as a back-compat alias for the global window export below; the
// underlying state is now `activeMapIds`.
let mapButtonAssignments = activeMapIds;

// Apply a DGScope profile XML: prefSet overrides + DCBMapList + DisplayedMaps.
// Backend serializes with camelCase per ServerContext JsonSerializer settings.
async function applyProfile(profileName) {
  try {
    // vNAS-format JSON profile (?profile=NAME). DGScope XML profile lives at
    // /api/stars/profile/{x}/{y} and is loaded by profile.js StarsProfile.load.
    const p = await fetch(`/api/stars/profile-json/${encodeURIComponent(ARTCC)}/${encodeURIComponent(profileName)}`)
      .then(r => r.json());
    if (!p) return;
    // Map camelCase API field → PascalCase prefSet field.
    const fieldMap = {
      range: "Range", rangeRingSpacing: "RangeRingSpacing",
      dcbLocation: "DCBLocation", dcbVisible: "DCBVisible",
      historyNum: "HistoryNum", historyRate: "HistoryRate",
      leaderLength: "LeaderLength", ptlLength: "PTLLength",
      altitudeFilterAssociatedMin: "AltitudeFilterAssociatedMin",
      altitudeFilterAssociatedMax: "AltitudeFilterAssociatedMax",
      altitudeFilterUnAssociatedMin: "AltitudeFilterUnAssociatedMin",
      altitudeFilterUnAssociatedMax: "AltitudeFilterUnAssociatedMax",
    };
    if (p.prefSet) {
      for (const [src, dst] of Object.entries(fieldMap)) {
        if (p.prefSet[src] != null) prefSet[dst] = p.prefSet[src];
      }
      // Brightness keys. WPF PrefSet.cs:55-63 has 14 separate categories.
      // Several map to a single slot in our scheme (DataBlock collapses
      // FullDataBlocks/LimitedDataBlocks/OtherFDBs; Position collapses
      // PositionSymbols/BeaconTargets/PrimaryTargets). Each direction is
      // explicit so order is irrelevant and there is no collision.
      // CRITICAL: Tools is a SEPARATE WPF category - it must not overwrite
      // Lists. Profile PCT_Mount Vernon had Lists=75 and Tools=45; the
      // old `Tools: "Lists"` mapping was silently dimming the SSA/MCA.
      const b = p.prefSet.brightness || {};
      if (b.DCB             != null) prefSet.Brightness.DCB        = b.DCB;
      if (b.Background      != null) prefSet.Brightness.Background = b.Background;
      if (b.MapA            != null) prefSet.Brightness.VideoMapA  = b.MapA;
      if (b.MapB            != null) prefSet.Brightness.VideoMapB  = b.MapB;
      if (b.Lists           != null) prefSet.Brightness.Lists      = b.Lists;
      if (b.Tools           != null) prefSet.Brightness.Tools      = b.Tools;
      if (b.History         != null) prefSet.Brightness.History    = b.History;
      if (b.RangeRings      != null) prefSet.Brightness.RangeRings = b.RangeRings;
      if (b.Compass         != null) prefSet.Brightness.Compass    = b.Compass;
      if (b.Weather         != null) prefSet.Brightness.Weather         = b.Weather;
      if (b.WeatherContrast != null) prefSet.Brightness.WeatherContrast = b.WeatherContrast;
      // Per PrefSet.cs:92,107,112 these are 3 distinct fields — load each
      // into its own slot. The BRITE FDB/LDB/OTH buttons drive them
      // independently. Collapsed Brightness.DataBlock alias is mirrored
      // last-write-wins for renderers that haven't been split yet.
      if (b.FullDataBlocks    != null) prefSet.Brightness.FullDataBlocks    = b.FullDataBlocks;
      if (b.LimitedDataBlocks != null) prefSet.Brightness.LimitedDataBlocks = b.LimitedDataBlocks;
      if (b.OtherFDBs         != null) prefSet.Brightness.OtherFDBs         = b.OtherFDBs;
      prefSet.Brightness.DataBlock = prefSet.Brightness.FullDataBlocks;
      // Per PrefSet.cs:102-110 these are 3 distinct fields.
      if (b.PositionSymbols != null) prefSet.Brightness.PositionSymbols = b.PositionSymbols;
      if (b.BeaconTargets   != null) prefSet.Brightness.BeaconTargets   = b.BeaconTargets;
      if (b.PrimaryTargets  != null) prefSet.Brightness.PrimaryTargets  = b.PrimaryTargets;
      prefSet.Brightness.Position = prefSet.Brightness.PositionSymbols;
    }
    if (p.screenCenterPoint) {
      prefSet.ScreenCenterPoint = {
        Latitude: p.screenCenterPoint.latitude,
        Longitude: p.screenCenterPoint.longitude,
      };
      prefSet.RangeRingLocation = { ...prefSet.ScreenCenterPoint };
    }
    if (Array.isArray(p.tcp?.dcbMapList)) mapButtonAssignments = p.tcp.dcbMapList;
    if (Array.isArray(p.displayedMaps)) {
      const set = new Set(p.displayedMaps);
      for (const m of videoMaps) m.visible = set.has(m.starsId);
    }
    recomputeScale();
    if (dcb) dcb.render();
    console.log(`[STARS] profile ${profileName} applied: range=${prefSet.Range} maps=${mapButtonAssignments.length}`);
  } catch (e) { console.error("[STARS] profile load failed:", e); }
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
const claimedTracks = new Set(); // Guids of tracks middle-clicked by user (light blue)
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
    case 4: handleCA(u); return;   // server-side Conflict Alert (DGScope's engine)
  }
}

// Server-side Conflict Alert (STCA). SwimReader.Server runs DGScope's actual
// ConflictAlertSystem over the live feed and sends the current set of conflicting track
// guids as UpdateType 4. We drive t._stca from it — the authoritative DGScope computation
// replacing the local scanSTCA reimplementation. Real DGScope clients ignore UT=4.
function handleCA(u) {
  _lastServerCA = Date.now();
  const set = new Set((u.Guids || []).map(String));
  for (const [guid, t] of tracks) {
    const on = set.has(String(guid));
    if (t._stca && !on) t._caAcked = false;   // conflict cleared → reset the ack
    t._stca = on;
  }
}

// Track: per scope/DGScope.Receivers.ScopeServer/Track.cs — partial-update
// semantics. Any field present overwrites; absent fields preserved.
function handleTrackUpdate(u) {
  let t = tracks.get(u.Guid);
  const fresh = !t;
  if (!t) { t = { Guid: u.Guid, lastUpdate: 0 }; tracks.set(u.Guid, t); }
  t.lastUpdate = Date.now();
  if (u.Location) {
    // Track position-fix time (lastPosUpdate) and last *movement* time
    // (lastMoveT) separately from message time. Our feed re-sends the same
    // frozen position for landed/parked tracks, so message-time alone never
    // ages them out. DGScope hides on LastMessageTime (RadarWindow.cs:6162),
    // but it also keeps ExtrapolatePosition ghosting the target forward
    // (Aircraft.cs:882) — for our feed, movement is the faithful liveness
    // signal: no positional change in LostTargetSeconds → coast → drop.
    const prev = t.Location;
    const moved = !prev || prev.Latitude !== u.Location.Latitude
                        || prev.Longitude !== u.Location.Longitude;
    t.Location = u.Location;
    t.lastPosUpdate = t.lastUpdate;
    if (fresh || moved) t.lastMoveT = t.lastUpdate;
  }
  if (u.Altitude)      t.Altitude = u.Altitude;
  if (u.GroundSpeed != null)  t.GroundSpeed = u.GroundSpeed;
  if (u.GroundTrack != null)  t.GroundTrack = u.GroundTrack;
  if (u.VerticalRate != null) t.VerticalRate = u.VerticalRate;
  if (u.Squawk != null)       t.Squawk = u.Squawk;
  if (u.Callsign != null)     t.Callsign = u.Callsign;
  if (u.ModeSCode != null)    t.ModeSCode = u.ModeSCode;
  if (u.IsOnGround != null)   t.IsOnGround = u.IsOnGround;
  if (u.Ident != null)        t.Ident = u.Ident;
  // Snapshot-seeded history (server-side cache) — only present on connect.
  // Newest-first {Latitude,Longitude} list; seed so the trail shows instantly
  // instead of taking HistoryRate×N seconds to build. radarSweep continues it.
  if (Array.isArray(u.History) && u.History.length) {
    t._history = u.History.map(p => ({ Latitude: p.Latitude, Longitude: p.Longitude }));
    t._lastHistoryT = Date.now();   // don't immediately re-add the latest point
  }
}

function handleFlightPlanUpdate(u) {
  let fp = flightPlans.get(u.Guid);
  if (!fp) { fp = { Guid: u.Guid }; flightPlans.set(u.Guid, fp); }
  // Stamp every update for mergedFp's per-field freshness comparison.
  fp._updatedAt = Date.now();
  // Capture previous Owner so we can detect a cps transition matching the
  // DGScope Aircraft.Transferred event (Aircraft.cs:46-55, RadarWindow.cs
  // Aircraft_Transferred) — fires when ownership moves AWAY from us, i.e.
  // a receiver just accepted our outbound handoff. CRC STARS spec: data
  // block blinks white for 5 seconds, then stays white until clicked.
  const prevOwner = fp.Owner;
  for (const k of ["Callsign","AircraftType","WakeCategory","FlightRules",
       "Origin","Destination","EntryFix","ExitFix","Route","RequestedAltitude",
       "Scratchpad1","Scratchpad2","Runway","Owner","PendingHandoff",
       "AssignedSquawk","EquipmentSuffix","LDRDirection","AssociatedTrackGuid",
       "HandoffOcr","IsHandoffInProgress"]) {
    if (u[k] !== undefined) fp[k] = u[k];
  }
  // cps transition detection: stamp _justTransferredAt ONLY when the
  // ownership moved AWAY from us. Mirrors DGScope's PositionInd setter
  // firing Transferred with PositionFrom=prevOwner, and the handler at
  // RadarWindow.cs Aircraft_Transferred which checks PositionFrom == me.
  // Inbound acceptance (we became owner) is OUR action — no flash needed.
  // Inbound PENDING flash is covered separately by isInboundHandoff →
  // dbFlashing while PendingHandoff == me.
  if (u.Owner !== undefined && prevOwner && fp.Owner && prevOwner !== fp.Owner) {
    const me = (window.ownTcp && window.ownTcp() || "").trim().toUpperCase();
    if (me) {
      const prev = String(prevOwner).trim().toUpperCase();
      const next = String(fp.Owner).trim().toUpperCase();
      if (prev === me && next !== me) {
        fp._justTransferredAt = Date.now();
      }
    }
  }
  if (fp.AssociatedTrackGuid) trackToFp.set(fp.AssociatedTrackGuid, fp);
}

function handleDeletion(u) {
  // Could be a track guid or fp guid — try both.
  if (tracks.delete(u.Guid)) trackToFp.delete(u.Guid);
  flightPlans.delete(u.Guid);
}

// ── Track rendering (Phase 3a + 3b) ─────────────────────────────────────────
// Position symbol decoder per CRC docs § Track types + RadarWindow.cs.
//   ◇ associated (track has a flight plan)
//   \ correlated beacon (squawk + no FP)
//   / uncorrelated beacon (squawk + no FP, out of area; Phase 8 sectorizes)
//   + uncorrelated primary (no squawk)
//   # coast track (no position update for > 2 scan cycles)
// STARS uses the diamond at all altitudes (ERAM-specific bullet form NOT
// applied here — confirmed in CRC docs).
function symbolFor(track) {
  const hasSquawk = !!track.Squawk && track.Squawk !== "" && track.Squawk !== "0000";
  const hasFp = trackToFp.has(track.Guid);
  if (isCoasting(track)) return "#";
  if (hasFp) return "◇";
  if (hasSquawk) return "\\";
  return "+";
}
function isCoasting(t) {
  // Based on the last *position fix*, not the last message — the feed can keep
  // sending messages (or a frozen position) without the target actually moving.
  return (Date.now() - (t.lastMoveT ?? t.lastPosUpdate ?? t.lastUpdate)) > 24000; // 2 × 12s scan
}

// ── Velocity extrapolation (RadarWindow.cs:displayPosition + Aircraft.ExtrapolatePosition)
// Between scans we project the target along GroundTrack at GroundSpeed knots
// from the last reported Location. Matches the WPF ExtrapolatePosition path
// approximated for the time-delta since lastUpdate.
function extrapolatedPosition(t) {
  if (!t.Location) return null;
  // No coast-freeze: DGScope's ScanTarget extrapolates continuously every sweep
  // (Radar.cs:104) right up until the track is hidden at LostTargetSeconds — it
  // has no coast state. Freezing at 24s then snapping when a delayed fix lands
  // is exactly the intermittent "lag then jump" artifact, so we don't do it.
  if (t.GroundSpeed == null || t.GroundTrack == null) return t.Location;
  // Extrapolate from the last position fix (Aircraft.cs:884 uses the position
  // extrapolate time, not message time).
  const ageS = (Date.now() - (t.lastPosUpdate ?? t.lastUpdate)) / 1000;
  if (ageS < 0.05) return t.Location;
  // 1 NM = 1/60 degree latitude. Apply GroundTrack-bearing offset.
  const distNM = (t.GroundSpeed * ageS) / 3600;
  const θ = t.GroundTrack * Math.PI / 180;
  const dLat = (distNM * Math.cos(θ)) / 60;
  const latFactor = Math.cos(t.Location.Latitude * Math.PI / 180);
  const dLon = (distNM * Math.sin(θ)) / (60 * latFactor);
  return {
    Latitude: t.Location.Latitude + dLat,
    Longitude: t.Location.Longitude + dLon,
  };
}

// ── HistoryColors — RadarWindow.cs:235 default array ───────────────────────
// PrefSet HistoryColors palette indexed by slot age. RadarWindow.cs:5547-5566
// (when HistoryFade=false, default cs:296): newest goes to slot 0, every other
// slot shifts down one, color cycles through the palette by index (cs:5564);
// any slot index >= palette length uses the last color (cs:5562). Values
// transcribed verbatim from cs:235.
const HISTORY_COLORS = [
  [30, 120, 254], [70, 70, 170], [50, 50, 130], [40, 40, 110], [30, 30, 90],
];

function tickHistory(t, posNow) {
  // History recording — RadarWindow.cs:5540-5566: every HistoryRate seconds,
  // shift History[N-1..1] down, new TargetReturn at slot 0. We don't have
  // multi-radar SweptTimes so we gate on wall-clock instead. Capped at
  // HistoryNum (PrefSet.cs:38 default 10) so a slot >= cap is dropped — same
  // net effect as History.Length in DGScope (a fixed-size array).
  if (!posNow) return;
  if (!t._history) t._history = [];
  if (!t._lastHistoryT) t._lastHistoryT = 0;
  const nowS = Date.now() / 1000;
  if (nowS - t._lastHistoryT < prefSet.HistoryRate) return;
  t._lastHistoryT = nowS;
  t._history.unshift({ Latitude: posNow.Latitude, Longitude: posNow.Longitude });
  while (t._history.length > prefSet.HistoryNum) t._history.pop();
}

function drawHistory(t) {
  // History rendering — RadarWindow.cs:6171-6175 (RadarType.FUSED history
  // branch): small filled circle, size FMATargetSymbols.Radius * pixelScale.
  // ForeColor cycles through HistoryColors by slot (cs:5564 + 5561-5562
  // last-color clamp). Brightness.History applies (cs:6174).
  // Cull index >= HistoryNum per cs:6073.
  if (!t._history || t._history.length === 0) return;
  const max = Math.min(t._history.length, prefSet.HistoryNum);
  for (let i = 0; i < max; i++) {
    const p = geoToScreen(t._history[i]);
    if (p.x < -4 || p.x > view.W + 4 || p.y < -4 || p.y > view.H + 4) continue;
    const c = HISTORY_COLORS[Math.min(i, HISTORY_COLORS.length - 1)];
    ctx.fillStyle = adjusted(c, prefSet.Brightness.History);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawPTL(t, posNow) {
  // PTL — Aircraft.PTL.End1/End2 set in RadarWindow.cs:5591-5593, rendered
  // in cs:6323-6326.
  //   End1     = current Swept location
  //   End2     = End1 projected (Speed/60 * PTLLength) NM along SweptTrack
  //   ptldist  = (SweptSpeed / 60) * PrefSet.PTLLength    (NM)
  //   gate     = PTLLength > 0 && (ShowPTL || (Owned && PTLOwn) || (FDB && PTLAll))
  //   color    = AdjustedColor(RBLColor, Brightness.Tools)
  if (!posNow) return;
  if (!(prefSet.PTLLength > 0)) return;
  if (t.GroundSpeed == null || t.GroundSpeed < 1) return;        // no PTL on stationary
  if (t.GroundTrack == null) return;
  const fp = trackToFp.get(t.Guid);
  // Sticky Owned per cs:5454 — same flag the color tier uses; consistent
  // with how DGScope reads Aircraft.Owned at cs:6323 for the PTL gate.
  const Owned = !!t._owned;
  const FDB   = (typeof dataBlockMode === "function") && dataBlockMode(t, fp) === "FDB";
  const ShowPTL = !!t._showPtl;
  if (!(ShowPTL || (Owned && prefSet.PTLOwn) || (FDB && prefSet.PTLAll))) return;
  const distNM = (t.GroundSpeed * prefSet.PTLLength) / 60;
  const θ = t.GroundTrack * Math.PI / 180;
  const dLat = (distNM * Math.cos(θ)) / 60;
  const latFactor = Math.cos(posNow.Latitude * Math.PI / 180);
  const dLon = (distNM * Math.sin(θ)) / (60 * latFactor);
  const p1 = geoToScreen(posNow);
  const p2 = geoToScreen({ Latitude: posNow.Latitude + dLat,
                           Longitude: posNow.Longitude + dLon });
  ctx.strokeStyle = adjusted(COLORS.RBL, prefSet.Brightness.Tools);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y);
  ctx.stroke();
}
// Phase 8: signed-on TCP. Set via URL ?tcp=ABC, dot command `.SO ABC`, or
// SITE submenu (Phase 4). Reads from URL on bootstrap.
let _signedOnTcp = (new URLSearchParams(location.search)).get("tcp") || null;
function ownTcp() { return _signedOnTcp; }
function setOwnTcp(v) {
  _signedOnTcp = v ? v.toUpperCase() : null;
  // RadarWindow.cs:1080-1093 — PositionChange runs whenever
  // ThisPositionIndicator changes: re-derive Owned, clear all FDB toggles,
  // remove self from QuickLookList. The Handoff module owns this logic.
  if (window.Handoff) window.Handoff.onPositionChange();
  window.pushUrlState?.();
}
window.setOwnTcp = setOwnTcp;
window.ownTcp = ownTcp;

// ── Data block content (Aircraft.RedrawDataBlock, lines 302-560) ────────────
// Single-mode FDB rendering. The WPF 3-line timeshare (DataBlock/2/3
// rotation) is deferred — see PHASE-NOTES Phase 3b. We render the most-
// information-dense variant (fdb2line2 equivalent).
//
// Format:
//   FDB (3 lines): callsign / altitude+handoff+speed+vfr+cat / scratchpad
//   PDB (2 lines): callsign / altitude+speed
//   LDB (2 lines): squawk    / altitude+speed                          (no callsign)
// ── ClockPhase (scope/STARS/ClockPhase.cs) — drives FDB 3-variant timeshare.
// Default sequence ONE_TWO_ONE_THREE: phase 0 (2.0s) -> 1 (1.5s) -> 0 (2.0s)
// -> 2 (1.5s). Phase 0 (altitude+speed) shows ~57% of the time; variants 2
// and 3 each show ~21%. Matches WPF default.
const ClockPhase = {
  phase: 0, _step: 0,
  intervals: [2.0, 1.5, 2.0, 1.5],
  _phases:   [0,   1,   0,   2],
  _timer: null,
  start() {
    if (this._timer) return;
    const advance = () => {
      this._step = (this._step + 1) % 4;
      this.phase = this._phases[this._step];
      this._timer = setTimeout(advance, this.intervals[this._step] * 1000);
    };
    this._timer = setTimeout(advance, this.intervals[0] * 1000);
  },
};
ClockPhase.start();

// buildLineZero — CRC STARS § STCA + § Special Purpose Codes. Returns the
// space-separated flag strip rendered above the callsign:
//   - Beacon SPCs from t.Squawk (HJ/RF/EM/MI/LL, Table 13)
//   - Manual SPCs from t._spc (OD/ME/MF/LN, Table 14)
//   - CA flag (t._stca), LA flag (t._msaw)
// {text} is the full strip including unacked items. {solidText} is the strip
// with only acknowledged items (rendered during the blink-OFF half so unacked
// blink while acked stay solid). {allAcked} short-circuits the blink when
// every active flag has been acknowledged.
const BEACON_SPC = { "7500": "HJ", "7600": "RF", "7700": "EM", "7777": "MI", "7400": "LL" };
function buildLineZero(t) {
  const all = [];
  const solid = [];
  // CA — Conflict Alert (line 0 per CRC § STCA). Acknowledge via track click
  // → t._caAcked. Blinks until acked.
  if (t._stca) { all.push("CA"); if (t._caAcked) solid.push("CA"); }
  // LA — Low Altitude / MSAW (line 0 per CRC § MSAW). Detector not yet
  // wired, but render path is ready.
  if (t._msaw) { all.push("LA"); if (t._laAcked) solid.push("LA"); }
  // Beacon SPC from current squawk (Table 13). Slewing the track ACKs it.
  const beacon = BEACON_SPC[t.Squawk];
  if (beacon) { all.push(beacon); if (t._spcAcked) solid.push(beacon); }
  // Manual SPCs (Table 14) — controller-assigned, stored on t._spc as an
  // array of 2-char IDs. Acked via the same slew-to-ack t._spcAcked flag.
  if (Array.isArray(t._spc)) {
    for (const s of t._spc) { all.push(s); if (t._spcAcked) solid.push(s); }
  }
  const text = all.join(" ");
  const solidText = solid.join(" ");
  const allAcked = text.length > 0 && solidText === text;
  return { text, solidText, allAcked };
}

// buildDataBlock — 1:1 port of Aircraft.RedrawDataBlock (Aircraft.cs:318-630).
// Returns the array of text lines for the active ClockPhase variant. Right-
// alignment for W/NW/SW leader directions is handled by the caller via
// ctx.textAlign (the only canvas-specific deviation — DGScope pads strings
// with PadLeft(9) instead).
function buildDataBlock(t, fp) {
  // ── Field formatters — Aircraft.cs:344-360 ──────────────────────────────
  // Altitude is rounded to flight-level hundreds; "RDR" when AltitudeType
  // is Unknown (enum value 2) or null.
  let dbAlt = t.Altitude?.Value;
  const altstring = (dbAlt != null && t.Altitude.AltitudeType !== 2)
    ? (() => { if (dbAlt % 100 > 50) dbAlt = ((dbAlt / 100) | 0) * 100 + 100;
               return String((dbAlt / 100) | 0).padStart(3, "0"); })()
    : "RDR";
  const dbSpeed = t.GroundSpeed ?? 0;

  // ── vfrchar / catchar — Aircraft.cs:360-386 ─────────────────────────────
  let vfrchar = " ";
  let catchar = " ";
  if (fp?.FlightRules && fp.FlightRules[0] !== "I") vfrchar = fp.FlightRules[0];
  // Aircraft.cs:378-381 — Ident overrides vfrchar to "I", catchar to "D".
  if (t.Ident) { vfrchar = "I"; catchar = "D"; }
  else if (fp?.Category) catchar = fp.Category;

  // ── handoffchar — Aircraft.cs:362-364 ───────────────────────────────────
  // Last char of PendingHandoff (or " " when none).
  let handoffchar = " ";
  if (fp?.PendingHandoff) handoffchar = fp.PendingHandoff.slice(-1);

  // ── destination — Aircraft.cs:387-406 ───────────────────────────────────
  let destination;
  if (!fp?.Destination) destination = altstring;
  else if (fp.Destination.trim() !== "" && fp.Destination !== "unassigned")
    destination = fp.Destination.padEnd(3);
  else destination = String((dbAlt / 100) | 0).padStart(3, "0");

  // ── yscratch / yscratch2 — Aircraft.cs:407-428 ──────────────────────────
  const yscratch = fp?.Scratchpad1 ? fp.Scratchpad1.padEnd(3) : destination;
  let yscratch2;
  if (fp?.Scratchpad2) yscratch2 = fp.Scratchpad2.padEnd(3) + "+";
  else if (fp?.Scratchpad1) yscratch2 = fp.Scratchpad1.padEnd(3);
  else yscratch2 = destination;

  // ── type / reqalt — Aircraft.cs:430-450 ─────────────────────────────────
  let type;
  if (!fp?.AircraftType) type = `${String((dbSpeed / 10) | 0).padStart(2, "0")}${vfrchar}${catchar}`;
  else if (fp.AircraftType.trim() !== "") type = fp.AircraftType.padEnd(4);
  else type = `${String((dbSpeed / 10) | 0).padStart(2, "0")}${vfrchar}${catchar}`;
  const reqalt = (fp?.RequestedAltitude > 0)
    ? "R" + String((fp.RequestedAltitude / 100) | 0).padStart(3, "0")
    : type;

  // ── FDB line-2 variants — Aircraft.cs:452-460 ───────────────────────────
  // EXACT DGScope composition. Variant 3 deliberately drops handoffchar in
  // the yscratch2.Length===4 branch (cs:458 `yscratch2 + type`); previous
  // port had a deviation here, removed.
  const speed10 = String((dbSpeed / 10) | 0).padStart(2, "0");
  const fdb1line2 = `${altstring}${handoffchar}${speed10}${vfrchar}${catchar} `;
  const fdb2line2 = `${yscratch}${handoffchar}${reqalt} `;
  let fdb3line2;
  if (!yscratch2)                  fdb3line2 = `${yscratch}${handoffchar}${type} `;
  else if (yscratch2.length === 4) fdb3line2 = `${yscratch2}${type}`;            // cs:458 — no handoffchar
  else                              fdb3line2 = `${yscratch2}${handoffchar}${type} `;

  // ── Mode (FDB / LDB) — Aircraft.cs:464 ─────────────────────────────────
  // DGScope: `if (FDB || ShowCallsignWithNoSquawk)` else LDB. We compute
  // FDB via dataBlockMode (handles Owned / QuickLook / per-aircraft toggle).
  const isFdb = dataBlockMode(t, fp) === "FDB" || t.ShowCallsignWithNoSquawk;
  const lines = [];

  if (isFdb) {
    // ── FDB line 1 — Aircraft.cs:466-505 ─────────────────────────────────
    //   FlightPlanCallsign && !ShowCallsignWithNoSquawk → callsign
    //   else Squawk → squawk
    //   else ""
    let line1 = "";
    if (fp?.Callsign && !t.ShowCallsignWithNoSquawk) line1 = fp.Callsign;
    else if (t.Squawk) line1 = t.Squawk;
    lines.push(line1);

    // ── FDB line 2 — Aircraft.cs:511-515 (when FDB), else cs:541-554 ─────
    if (dataBlockMode(t, fp) === "FDB") {
      const variants = [fdb1line2, fdb2line2, fdb3line2];
      lines.push(variants[ClockPhase.phase] ?? fdb1line2);

      // ── FDB line 3 — Aircraft.cs:516-537 ─────────────────────────────
      //   AssignedSquawk mismatch → "{squawk} {assigned}"
      //   else if ATPAMileageNow → mileage.toFixed(2)
      //   else                   → " "
      const assigned = fp?.AssignedSquawk ? String(fp.AssignedSquawk).padStart(4, "0") : "";
      if (assigned && t.Squawk !== assigned) lines.push(`${t.Squawk ?? ""} ${assigned}`);
      else if (t.ATPAMileageNow != null)     lines.push(Number(t.ATPAMileageNow).toFixed(2));
      else                                    lines.push(" ");
    } else {
      // ShowCallsignWithNoSquawk but not FDB — Aircraft.cs:541-554.
      // Line 2 is the altstring + handoff + vfr + cat triplet (no time-share).
      lines.push(`${altstring}${handoffchar}${vfrchar}${catchar}`);
      // ── Line 3 — Aircraft.cs:556-579 ──────────────────────────────────
      // ShowCallsignWithNoSquawk && Callsign && !Associated → callsign
      // else (length<3) → " " padding
      if (t.ShowCallsignWithNoSquawk && t.Callsign && !fp?.Owner) lines.push(t.Callsign);
      else                                                          lines.push(" ");
    }
  } else {
    // ── LDB — Aircraft.cs:581-630 ───────────────────────────────────────
    if (prefSet.LdbBeaconCodesInhibited && !t.ShowCallsignWithNoSquawk) {
      // BCB inhibited (cs:584-589): altitude line + 2 padding lines.
      lines.push(`${altstring}${handoffchar}${vfrchar}${catchar}`);
      lines.push("     ");
      lines.push("     ");
    } else if (t.ShowCallsignWithNoSquawk) {
      // F1 beacon readout (cs:591-609): squawk + altitude + callsign.
      lines.push(t.Squawk ?? "");
      lines.push(`${altstring}${handoffchar}${vfrchar}${catchar}`);
      lines.push(t.Callsign ?? "");
    } else {
      // Normal LDB (cs:611-628): squawk + altitude + blank.
      lines.push(t.Squawk ?? "");
      lines.push(`${altstring}${handoffchar}${vfrchar}${catchar}`);
      lines.push("     ");
    }
  }
  return lines;
}

// dataBlockMode — 1:1 port of Aircraft.FDB getter (Aircraft.cs:119-136).
// Returns "FDB" or "LDB". DGScope has no PDB tier — non-owned associated
// tracks render as LDB (squawk + altitude). The previous PDB invention was
// removed; if you want callsigns on associated tracks, click them to toggle
// FDB (ProcessCommand fall-through at cs:1438-1450 — `plane.FDB = !plane.FDB`).
//   Aircraft.cs:119-136 FDB getter:
//     if (Owned && !QuickLook) _fdb = true   (owned tracks auto-promote)
//     else if (QuickLook)      return true   (QL list always FDB)
//     else if (ForceQuickLook) return true   (**<pos> always FDB)
//     return _fdb                            (manual toggle persisted)
//   Aircraft.cs:156-166 fdb() helper used by colour tier:
//     if (Emergency || QuickLook) return true
//     return _fdb
//   RadarWindow.cs:1085 Owned bool: PositionInd==me OR PendingHandoff==me
//     (so inbound handoff promotes to Owned → FDB).
//
// CRC STARS docs distinguish:
//   LDB: unassociated tracks → beacon code + altitude
//   PDB: associated but owned by ANOTHER position → callsign on line 1,
//        altitude+speed on line 2
//   FDB: associated + owned-or-receiving → full 3-line block
// DGScope conflates LDB+PDB into a single beacon-code-on-line-1 render
// (Aircraft.cs:595-613); we split them so tracked tracks show the
// callsign instead of the raw squawk, per user-visible STARS behaviour.
function dataBlockMode(t, fp) {
  // Explicit per-track toggle (Aircraft._fdb when user clicks). This is the
  // "store" the FDB getter writes to; takes priority over the auto-derive.
  if (t._forcedMode) return t._forcedMode;
  // Emergency / SPC always promote (Aircraft.cs:158 fdb()).
  if (t.Emergency || ["7500", "7600", "7700"].includes(t.Squawk)) return "FDB";
  // ForceQuickLook auto-FDB regardless of association (set by **<pos>).
  if (t._forceQuickLook) return "FDB";
  // Owned (sticky bool) auto-promotes to FDB per Aircraft.cs:119-136 FDB
  // getter — Owned && !QuickLook → _fdb = true. The sticky bool is set in
  // drawTracks pre-pass (cs:6172-6173) when PositionInd or PendingHandoff
  // matches me, and cleared only by sign-on (cs:1648-1651) or click-to-
  // release (cs:2775-2778). This is what keeps a track FDB after an
  // outbound handoff completes — Owned remains true from the prior frame.
  if (t._owned) return "FDB";
  // QuickLookList promotion — RadarWindow.cs:5685-5711. An aircraft is
  // QuickLook=true if any of:
  //   • QuickLookedTCPs contains its controlling position (or ALL/ALL+)
  //   • QuickLookedTCPs contains "<pos>+" (QuickLookPlus form)
  //   • global RadarWindow.QuickLook is true AND track is in altitude filter
  // Associated-only check is done via fp.Owner presence; ALL/ALL+ only apply
  // when the track is associated (cs:5689-5690).
  const associated = !!fp?.Owner;
  const ql = prefSet.QuickLookedTCPs || [];
  if (associated && (ql.includes("ALL") || ql.includes("ALL+"))) return "FDB";
  if (fp?.Owner && (ql.includes(fp.Owner) || ql.includes(fp.Owner + "+"))) return "FDB";
  if (prefSet.QuickLookAll) return "FDB";   // bare Key.Q toggle (cs:3308-3310)
  // Everything else → LDB. DGScope's FDB getter (Aircraft.cs:119-136) only
  // returns true for Owned / QuickLook / ForceQuickLook / stored _fdb. The
  // per-aircraft _fdb is toggled by clicking a non-owned track (cs:1438-1450
  // ProcessCommand fall-through); we model that with t._forcedMode above.
  return "LDB";
}

// Leader-direction offset (RadarWindow.cs OffsetDatablockLocation, ~5750+).
// Returns the pixel offset from target center to the data block top-left/right
// corner. dataBlockOffset = (0.5 + LeaderLength) × charHeight.
function leaderDirToVector(dir) {
  switch (dir) {
    case 1: return { x: -1, y: -1 }; // NW
    case 2: return { x:  0, y: -1 }; // N
    case 3: return { x:  1, y: -1 }; // NE
    case 4: return { x: -1, y:  0 }; // W
    case 6: return { x:  1, y:  0 }; // E
    case 7: return { x: -1, y:  1 }; // SW
    case 8: return { x:  0, y:  1 }; // S
    case 9: return { x:  1, y:  1 }; // SE
    default: return { x:  0, y: -1 }; // N fallback
  }
}
function effectiveLeaderDir(t, fp) {
  // RadarWindow.cs:5919-5951 OffsetDatablockLocation(thisAircraft) priority:
  //   1. Aircraft.LDRDirection (per-track override) — cs:5923-5927
  //   2. PositionInd==me && OwnerLeaderDirection != null — cs:5932-5936
  //      (OwnerLeaderDirection is declared at Aircraft.cs:132 but never set
  //       in the source tree — effectively dead, so we skip.)
  //   3. PositionInd==me → PrefSet.OwnedDataBlockPosition — cs:5937-5941
  //   4. OtherOwnersLeaderDirections[PositionInd] hit — cs:5942-5946
  //      (per-TCP map; A4 in AUDIT_FINDINGS, deferred.)
  //   5. Associated → PrefSet.UnownedDataBlockPosition — cs:5947-5950
  //   6. default → PrefSet.UnassociatedDataBlockPosition — cs:5921
  // LDRDirection split in our port: fp.LDRDirection (server-published from
  // the FP feed) AND t._leaderOverride (set by single-digit + click in
  // preview.js, mirrors cs:1524-1612 which sets aircraft.LDRDirection).
  // Both map to the same DGScope field; we keep them separate so the user
  // click doesn't mutate the FP object.
  if (t._leaderOverride) return ldrEnum(t._leaderOverride);
  if (fp?.LDRDirection)  return ldrEnum(fp.LDRDirection);
  const me = ownTcp();
  if (me && fp?.Owner === me) return ldrEnum(prefSet.OwnedDataBlockPosition);
  if (fp?.Owner)              return ldrEnum(prefSet.UnownedDataBlockPosition);
  return ldrEnum(prefSet.UnassociatedDataBlockPosition);
}
const LDR_NAME_TO_ENUM = { NW: 1, N: 2, NE: 3, W: 4, E: 6, SW: 7, S: 8, SE: 9 };
function ldrEnum(v) {
  // PrefSet stores LeaderDirection as ints 1-9 (per STARS/LeaderDirection.cs).
  // Also accept compass-name strings (e.g. "NW") so MCA leader-reposition
  // commands work regardless of which representation set the value.
  if (typeof v === "number" && v >= 1) return v;
  if (typeof v === "string" && LDR_NAME_TO_ENUM[v] != null) return LDR_NAME_TO_ENUM[v];
  return 2; // 0/undefined/unknown → N
}

function drawDataBlockAndLeader(t, fp, posNow) {
  const dir = effectiveLeaderDir(t, fp);
  const lines = buildDataBlock(t, fp);
  if (lines.length === 0) return;

  const fontSize = prefSet.CharSize.DataBlock;
  ctx.font = `${fontSize}px FixedDemiBold, ui-monospace, "Cascadia Mono", monospace`;
  const charHeight = fontSize + 2;
  const charWidth  = fontSize * 0.55;

  // ── OffsetDatablockLocation — RadarWindow.cs:4044-4046 + 5765-5828 ─────
  // dataBlockOffsetScale = Font.Height * pixelScale     (cs:4044)
  // dataBlockOffset      = (0.5 + LeaderLength) * scale (cs:4045)
  // dataBlockDiagonalOffset = dataBlockOffset * √2/2    (cs:4046)
  //
  // PLATFORM NOTE: DGScope renders in OpenGL Y-UP (geoToScreen at cs:4037-
  // 4040 has positive Y scale; higher lat = north = higher Y). RectangleF
  // .Bottom is therefore the NORTH edge (higher Y) and adding offset moves
  // FURTHER NORTH. Canvas is Y-DOWN, so a literal "Bottom + offset"
  // translation goes SOUTH. We translate by direction-vector semantics:
  // the visual placement is identical to DGScope per LeaderDirection name.
  const dataBlockOffsetScale    = charHeight;
  const dataBlockOffset         = (0.5 + prefSet.LeaderLength) * dataBlockOffsetScale;
  const dataBlockDiagonalOffset = dataBlockOffset * Math.SQRT2 / 2;
  const symbolRadius = prefSet.CharSize.Position * 0.5;
  const screen = geoToScreen(posNow);
  const posLeft   = screen.x - symbolRadius;
  const posRight  = screen.x + symbolRadius;
  const posTop    = screen.y - symbolRadius;     // canvas: top = lower Y = north visually
  const posBottom = screen.y + symbolRadius;     // canvas: bottom = higher Y = south

  const blockWidth  = Math.max(...lines.map(l => l.length)) * charWidth;
  const blockHeight = lines.length * charHeight;

  // Block top-left + leader start/end per direction.
  //
  // DGScope translation: TransparentLabel.LocationF is the label's BOTTOM-
  // LEFT in OpenGL Y-up (verified at cs:6449-6459 where the quad vertices
  // are (x, y) → (x, y+height) with y+height being visually higher).
  // RadarWindow.cs:5773-5828 sets blockLocation.Y per direction, then
  // cs:5862 unconditionally subtracts 2.5*dataBlockOffsetScale from it.
  // In Y-up "Y -= 2.5*scale" means the label shifts visually DOWN — in
  // canvas Y-down (where label coord is top-left, not bottom-left), the
  // equivalent shift is "blockY += 2.5*scale" applied AFTER converting
  // label-bottom-Y to label-top-Y via "- blockHeight".
  //
  // Net for canvas:  blockY = canvasLabelBottom - blockHeight
  //                  canvasLabelBottom = (visual position of DGScope label
  //                                       bottom translated to canvas Y)
  //
  // For N direction: DGScope label bottom (Y-up) = posBottom_yup + offset
  //                  − 2.5*scale = symbol_visual_top + 1.5*scale − 2.5*scale
  //                  = symbol_visual_top − 1*scale (visually 1 scale below
  //                  symbol top, i.e. INSIDE the symbol vertically by 1
  //                  char-height — DGScope's actual block placement OVERLAPS
  //                  the symbol slightly for the N-family).
  //                  Canvas equivalent: posTop + 1*scale.
  //                  blockY = posTop + 1*scale − blockHeight  (= posTop −
  //                  (lines−1)*scale for 3-line FDB).
  //
  // For E/W (cardinal horizontal): DGScope leaves blockLocation.Y at
  // LocationF.Y (target Y in Y-up) then -=2.5*scale → label bottom
  // visually 2.5 scale below target. Canvas: blockLabelBottom = screen.y
  // + 2.5*scale → blockY = screen.y + 2.5*scale − blockHeight.
  // SHIFT — DGScope RadarWindow.cs:5862 unconditional `-=2.5*scale`.
  // Per the commented guard at cs:5860, the author noted this shift makes
  // N-family directions overlap the symbol; the canvas equivalent reduces
  // the visible gap below what's comfortable. Apply SHIFT to S/SE/SW + E/W
  // (where it pulls the label visually toward the symbol nicely), and the
  // smaller SHIFT/2 to N-family so the gap stays reasonable.
  const SHIFT_FULL = dataBlockOffsetScale * 2.5;
  const SHIFT_N    = dataBlockOffsetScale * 1.25;
  let blockX, blockY;
  let leaderStartX, leaderStartY;
  let leaderEndX,   leaderEndY;
  switch (dir) {
    case 2: /* N  — block above target */
      blockX = screen.x - blockWidth / 2;
      blockY = posTop - dataBlockOffset + SHIFT_N - blockHeight;
      leaderStartX = screen.x;    leaderStartY = posTop;
      leaderEndX   = screen.x;    leaderEndY   = posTop - dataBlockOffset;
      break;
    case 8: /* S  — block below */
      blockX = screen.x - blockWidth / 2;
      blockY = posBottom + dataBlockOffset + SHIFT_FULL - blockHeight;
      leaderStartX = screen.x;    leaderStartY = posBottom;
      leaderEndX   = screen.x;    leaderEndY   = posBottom + dataBlockOffset;
      break;
    case 6: /* E  — block right */
      blockX = posRight + dataBlockOffset;
      blockY = screen.y + SHIFT_FULL - blockHeight;
      leaderStartX = posRight;    leaderStartY = screen.y;
      leaderEndX   = blockX;      leaderEndY   = screen.y;
      break;
    case 4: /* W  — block left */
      blockX = posLeft - dataBlockOffset - blockWidth;
      blockY = screen.y + SHIFT_FULL - blockHeight;
      leaderStartX = posLeft;     leaderStartY = screen.y;
      leaderEndX   = blockX + blockWidth; leaderEndY = screen.y;
      break;
    case 3: /* NE — block upper-right */
      blockX = posRight + dataBlockDiagonalOffset;
      blockY = posTop   - dataBlockDiagonalOffset + SHIFT_N - blockHeight;
      leaderStartX = posRight;    leaderStartY = posTop;
      leaderEndX   = blockX;      leaderEndY   = posTop - dataBlockDiagonalOffset;
      break;
    case 9: /* SE — block lower-right */
      blockX = posRight  + dataBlockDiagonalOffset;
      blockY = posBottom + dataBlockDiagonalOffset + SHIFT_FULL - blockHeight;
      leaderStartX = posRight;    leaderStartY = posBottom;
      leaderEndX   = blockX;      leaderEndY   = posBottom + dataBlockDiagonalOffset;
      break;
    case 1: /* NW — block upper-left */
      blockX = posLeft - dataBlockDiagonalOffset - blockWidth;
      blockY = posTop  - dataBlockDiagonalOffset + SHIFT_N - blockHeight;
      leaderStartX = posLeft;     leaderStartY = posTop;
      leaderEndX   = blockX + blockWidth; leaderEndY = posTop - dataBlockDiagonalOffset;
      break;
    case 7: /* SW — block lower-left */
      blockX = posLeft   - dataBlockDiagonalOffset - blockWidth;
      blockY = posBottom + dataBlockDiagonalOffset + SHIFT_FULL - blockHeight;
      leaderStartX = posLeft;     leaderStartY = posBottom;
      leaderEndX   = blockX + blockWidth; leaderEndY = posBottom + dataBlockDiagonalOffset;
      break;
    default:
      blockX = posRight + dataBlockOffset;
      blockY = screen.y + SHIFT_FULL - blockHeight;
      leaderStartX = posRight;    leaderStartY = screen.y;
      leaderEndX   = blockX;      leaderEndY   = screen.y;
  }
  // padLeft = block extends to the left of the target (text right-aligned
  // so it hugs the leader-side edge — matches DGScope's PadLeft(9) in
  // Aircraft.cs:485-498 for the W/NW/SW direction cases).
  const padLeft = blockX + blockWidth <= screen.x;

  // Data-block colour priority — verbatim from RadarWindow.cs:5436-5468:
  //   5436  if (Emergency)                  → DataBlockEmergencyColor (red)
  //   5442  else if (Marked)                → SelectedColor          (cyan)
  //   5448  else if (ForceQuickLook)        → PointoutColor          (yellow)
  //   5454  else if (Owned || QuickLookPlus)→ OwnedColor             (white)
  //   5459  else if (FDB)                   → DataBlockColor         (green)
  //   5464  else                            → LDBColor               (green; tunable)
  //
  // Owned (Aircraft.Owned, RadarWindow.cs:1085) = PositionInd==me OR
  // PendingHandoff==me — so an inbound handoff is already covered by the
  // Owned branch. The visual difference for inbound is the DataBlock.Flashing
  // bit set at RadarWindow.cs:1086-1087.
  //
  // Pointout (Aircraft.cs:20) is a SEPARATE flag in DGScope, only read at
  // RadarWindow.cs:2692/2724 (clear-on-click) — it does NOT drive colour.
  // The previous port used an invented `_pointoutTarget` here; replaced
  // with `_forceQuickLook` to match the source priority.
  // Source-of-truth predicates from handoff.js. DGScope flash sites:
  //   - RadarWindow.cs:1086 inbound (PendingHandoff == me)
  //   - Aircraft_Transferred → 5s outbound-complete blink (CRC STARS spec)
  // We do NOT flash for in-progress outbound (PositionInd==me, ocr=pending)
  // — DGScope doesn't, and faking it as a "your handoff is in progress"
  // indicator was an invention that confused real STARS users.
  const inboundHandoff   = window.Handoff && window.Handoff.isInboundHandoff(t, fp);
  const justTransferred  = window.Handoff && window.Handoff.justTransferred(t, fp);
  const dbFlashing       = inboundHandoff || justTransferred;
  // STICKY Owned per RadarWindow.cs:5454 — uses Aircraft.Owned bool (stored,
  // not live-computed). Set per-frame to TRUE in drawTracks pre-pass when
  // PositionInd==me OR PendingHandoff==me (cs:6172-6173 + 6178-6185);
  // cleared only by F12 sign-on (cs:1648-1651) or click-to-release
  // (cs:2775-2778 / processImplied step 5). This is what keeps an outbound
  // data block WHITE after TAIS flips cps to the receiver and through the
  // 5s post-accept blink, until the user clicks to acknowledge.
  const ownedSticky = !!t._owned;
  let baseColor = COLORS.DataBlock;
  // Conflict Alert is NOT a whole-block colour change — CA annotation only
  // (CRC STARS § STCA; handled below).
  if (t.Emergency || t.Squawk === "7700" || t.Squawk === "7600" || t.Squawk === "7500") {
    baseColor = COLORS.Emerg;
  } else if (t._marked) {
    baseColor = COLORS.Selected;            // cyan
  } else if (t._forceQuickLook) {
    baseColor = COLORS.Pointout;            // yellow (cs:5448-5452)
  } else if (claimedTracks.has(t.Guid)) {
    baseColor = COLORS.Claimed;             // light blue (middle-clicked)
  } else if (ownedSticky || t._quickLookPlus) {
    baseColor = COLORS.Owned;               // white (cs:5454-5458)
  }
  // Flash visual handled via dbBright above — TransparentLabel dims to
  // half-intensity on the OFF phase rather than hiding (cs:74-87). The
  // 750ms cadence comes from FlashTimer (TransparentLabel.cs:38).
  ctx.textBaseline = "top";
  ctx.textAlign = padLeft ? "right" : "left";
  // textX = side of the block closest to the target = block's leader-side edge.
  const textX = padLeft ? (blockX + blockWidth) : blockX;
  // Pad callsign when right-aligned (DGScope's PadLeft(9) — keeps short callsigns
  // aligned with the rest of the block when text-align=right).
  if (padLeft && lines.length > 0) {
    lines[0] = lines[0].padStart(9);
  }
  // Brightness category per RadarWindow.cs:6391-6399 — Owned → FullDataBlocks,
  // other FDB → OtherFDBs, LDB → LimitedDataBlocks. The collapsed
  // Brightness.DataBlock alias is only kept for renderers that haven't been
  // split yet.
  const dbMode = dataBlockMode(t, fp);
  const dbBrightBase = ownedSticky
    ? prefSet.Brightness.FullDataBlocks
    : (dbMode === "FDB" ? prefSet.Brightness.OtherFDBs
                        : prefSet.Brightness.LimitedDataBlocks);
  // TransparentLabel.DrawColor (cs:74-87) — during the OFF half of the
  // FlashTimer cycle, color is rendered at half intensity (gray). NOT a
  // hide. Apply by halving the brightness multiplier; adjusted() does the
  // RGB scaling.
  const flashDim = dbFlashing && window.Handoff && window.Handoff.flashPhaseDim();
  const dbBright = flashDim ? dbBrightBase * 0.5 : dbBrightBase;
  const normColor = adjusted(baseColor, dbBright);
  // Line 0 — flags strip ABOVE the callsign for CA / LA (MSAW) and Special
  // Purpose Codes per CRC STARS § STCA + § Special Purpose Codes:
  //   Beacon SPCs  (auto from t.Squawk): HJ 7500 / RF 7600 / EM 7700 /
  //                                       MI 7777 / LL 7400
  //   Manual SPCs  (controller-assigned via t._spc): OD / ME / MF / LN
  //   CA (t._stca)  — Conflict Alert, blinks until t._caAcked
  //   LA (t._msaw)  — Low Altitude (MSAW), blinks until t._laAcked
  // CRC says CA/SPC text appears on the "top line of the data block"; we
  // render it on its own line so the callsign + altitude lines never shift
  // horizontally when an annotation appears/blinks (the previous inline-
  // prefix approach jiggled the callsign as CA blinked).
  ctx.textAlign = padLeft ? "right" : "left";
  const line0 = buildLineZero(t);
  if (line0.text) {
    const y = blockY - charHeight;
    // Blink — CRC: "blinking red until acknowledged then solid red". Items
    // with their own acked flag survive the blink test.
    const blinkPhase = (Date.now() % 1000) < 500;
    const showAll = line0.allAcked || blinkPhase;
    if (showAll) {
      ctx.fillStyle = adjusted(COLORS.Emerg, dbBright);
      ctx.fillText(line0.text, textX, y);
    } else if (line0.solidText) {
      // Mixed: acked items stay solid, unacked blink (currently OFF).
      ctx.fillStyle = adjusted(COLORS.Emerg, dbBright);
      ctx.fillText(line0.solidText, textX, y);
    }
  }
  for (let i = 0; i < lines.length; i++) {
    const y = blockY + i * charHeight;
    ctx.fillStyle = normColor;
    ctx.fillText(lines[i], textX, y);
  }

  // Leader line — Aircraft.ConnectingLine (RadarWindow.cs:5913).
  // Start = position-symbol edge (per direction, set above); End = data-
  // block corner nearest the target. cs:4045 — LeaderLength=0 means
  // dataBlockOffset shrinks to 0.5*scale so the gap closes; the line is
  // still drawn (a 1-pixel adornment), matching DGScope.
  ctx.strokeStyle = ctx.fillStyle;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(leaderStartX, leaderStartY);
  ctx.lineTo(leaderEndX, leaderEndY);
  ctx.stroke();
}

// ── Position symbol render ──────────────────────────────────────────────────
// WPF (RadarWindow.cs:6018+ DrawTarget for RadarType.FUSED + Aircraft.cs:265
// TargetReturn + Aircraft.cs:286-291 PositionIndicator + Aircraft.cs:617-623
// PositionIndicator.Text):
//   1. Filled circle for beacon target (Return color, Brightness.PrimaryTargets)
//   2. PositionIndicator TransparentLabel with text:
//        - PositionInd.Substring(-1)  (last char of controller sector / Owner)
//        - else selectedSquawkChar    (SelectedBeaconCodes prefix match)
//        - else "◇" if PrimaryOnly
//        - else "*"
function positionSymbolText(t, fp) {
  // Aircraft.cs:632-639 verbatim:
  //   if (!IsNullOrEmpty(PositionInd))  → PositionInd.Last().ToString()
  //   else if (isSquawkSelected())      → selectedSquawkChar
  //   else if (PrimaryOnly)             → "◇"
  //   else                              → "*"
  // Our data split: PositionInd source = fp.Owner (FP-published cps) ||
  // t.PositionInd (TAIS track-side).
  const PositionInd = fp?.Owner || t.PositionInd;
  if (PositionInd && PositionInd.length > 0) return PositionInd.slice(-1);
  // isSquawkSelected — Aircraft.cs:649-659. selectedSquawks list is set
  // via F B <squawk>; selectedSquawkChar from PrefSet.SelectedBeaconCodeChar
  // (defaults to ◽ U+25FD).
  const sel = window.SSA?.selectedBeaconCodes;
  if (sel && t.Squawk) {
    for (const s of sel) {
      if (t.Squawk.startsWith(s)) {
        const code = prefSet.SelectedBeaconCodeChar;
        return Number.isFinite(code) ? String.fromCharCode(code) : "□";
      }
    }
  }
  // PrimaryOnly — Aircraft.cs:145-151:
  //   IsNullOrEmpty(Squawk) && ModeSCode == 0 &&
  //   (Altitude == null || Altitude.AltitudeType == AltitudeType.Unknown)
  const noBeacon   = !t.Squawk || t.Squawk === "0000";
  const noModeS    = !t.ModeSCode;
  const altUnknown = (t.Altitude == null) || (t.Altitude.AltitudeType === 2);
  if (noBeacon && noModeS && altUnknown) return "◇";
  return "*";
}

function drawPosition(t, posNow) {
  const fp = trackToFp.get(t.Guid);
  const p = geoToScreen(posNow);
  const px = p.x | 0, py = p.y | 0;

  // ── Primary target return — RadarWindow.cs:6134-6175 (RadarType.FUSED) ──
  // Non-PrimaryOnly: filled circle, primarycolor (ReturnColor blue), radius
  // = TargetExtentSymbols.TargetWidth/2 ≈ 3px at default scale (cs:6138-6140).
  // PrimaryTargets brightness per cs:6076. PrimaryOnly + history variants
  // not yet ported (square shape via GL polygon at cs:6155-6164).
  ctx.fillStyle = adjusted(COLORS.Return, prefSet.Brightness.PrimaryTargets);
  ctx.beginPath();
  ctx.arc(px, py, 3, 0, Math.PI * 2);
  ctx.fill();

  // ── PositionIndicator label — DGScope draws for ALL tracks via TWO loops:
  //   cs:6277-6285 (!FDB && acSet.Contains)  → drawn BEFORE data blocks
  //   cs:6337-6342 ( FDB && acSet.Contains)  → drawn AFTER data blocks
  // On flat canvas the layer order doesn't matter; combine into one path.
  // Color tier (cs:5610-5615): Marked → SelectedColor, Owned → OwnedColor,
  // else → DataBlockColor. Brightness (cs:6387-6399): PositionSymbols
  // when Owned+IsPositionIndicator (only happens when Owned ⇒ FDB), else
  // OtherFDBs for FDB tracks and LimitedDataBlocks for LDB tracks.
  // Sticky Owned per cs:5612 — same flag the data-block color tier uses,
  // mirroring DGScope's Aircraft.Owned property read at PositionIndicator
  // color computation.
  // Position indicator circle uses the same color as history trail (newest slot)
  // with History brightness, not the data block colors.
  const circleColor = HISTORY_COLORS[0];  // [30, 80, 200] — blue
  ctx.fillStyle = adjusted(circleColor, prefSet.Brightness.History);
  
  // Draw position indicator circle (filled circle around the letter)
  // Radius scaled to fit the character size with padding
  const circleRadius = (prefSet.CharSize.Position * 0.5) | 0;
  ctx.beginPath();
  ctx.arc(px, py, circleRadius, 0, Math.PI * 2);
  ctx.fill();
  
  // Draw position letter text on top of the circle (white text with border, scaled down)
  ctx.font = `${prefSet.CharSize.Position * 0.75}px FixedDemiBold, ui-monospace, monospace`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  
  // Draw text border/stroke in black
  ctx.strokeStyle = adjusted([0, 0, 0], prefSet.Brightness.PositionSymbols);
  ctx.lineWidth = 1.5;
  ctx.strokeText(positionSymbolText(t, fp), px, py);
  
  // Draw text fill in #CCCCCC (light grey)
  ctx.fillStyle = adjusted([204, 204, 204], prefSet.Brightness.PositionSymbols);
  ctx.fillText(positionSymbolText(t, fp), px, py);
}

// ── Phase 9: J-Ring + MinSep + STCA ─────────────────────────────────────────
// Sources: scope/TPARing.cs (J-ring), scope/MinSep.cs, scope/ATPA.cs.
// Most of the WPF logic is around configurable volumes and tables; Phase 9
// implements the operational subset (J-rings, MinSep tool, STCA pair scan).
// CRDA + ATPA volume editor deferred to Phase 11 per G19.

const STCA = { lateralNM: 3.0, verticalFt: 1000 };  // STARS standard defaults
let minSepPair = null;                              // {p1, p2, dist, t}

function drawJRings() {
  for (const t of tracks.values()) {
    if (!t._jRing) continue;
    if (!t.Location) continue;
    const pos = displayPos(t);
    if (!pos) continue;
    const center = geoToScreen(pos);
    // NM → px: 1 NM = (1/60) deg lat = (1/60)/view.scale px
    const px = (t._jRing / view.scale);
    // J-Ring is a TPA tool — Tools brightness (RadarWindow.cs:5319, 4934-39).
    ctx.strokeStyle = adjusted(COLORS.TPA, prefSet.Brightness.Tools);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(center.x, center.y, px, 0, Math.PI * 2);
    ctx.stroke();
    // Radius label — DGScope DrawJRing (RadarWindow.cs:5169-5233): the bare
    // mileage (NO 'J'; decimal if <10, else integer), drawn ONLY when ShowSize
    // (the *D+ / TPASize toggle) is on, positioned at the ring edge toward the
    // track's leader direction. Default TPASize is off → ring only, no text.
    if (window.starsState?.TPASize) {
      const txt = t._jRing < 10 ? String(t._jRing) : String(Math.trunc(t._jRing));
      const v = leaderDirToVector(effectiveLeaderDir(t, trackToFp.get(t.Guid)));
      const len = Math.hypot(v.x, v.y) || 1;
      ctx.fillStyle = ctx.strokeStyle;
      ctx.font = "10px FixedDemiBold, ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(txt, center.x + (v.x / len) * (px - 8), center.y + (v.y / len) * (px - 8));
    }
  }
}

// ── Range/Bearing Lines (*T) — RadarWindow.cs DrawLine(rbl) ──────────────────
function _rblGeo(s) {
  if (!s) return null;
  if (s.Latitude != null) return { Latitude: s.Latitude, Longitude: s.Longitude };
  if (s.lat != null) return { Latitude: s.lat, Longitude: s.lon };
  return null;
}
function _rblPlaneGeo(p) {
  const loc = displayPos(p);
  return loc ? { Latitude: loc.Latitude, Longitude: loc.Longitude } : null;
}
function rblBearing(a, b) {
  const φ1 = a.Latitude * Math.PI / 180, φ2 = b.Latitude * Math.PI / 180;
  const dλ = (b.Longitude - a.Longitude) * Math.PI / 180;
  const y = Math.sin(dλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
function drawRBLs() {
  const lines = window.starsState?.rangeBearingLines;
  if (!lines || !lines.length) return;
  ctx.strokeStyle = adjusted(COLORS.RBL, prefSet.Brightness.Tools);
  ctx.fillStyle = ctx.strokeStyle;
  ctx.lineWidth = 1;
  ctx.font = `${prefSet.CharSize.Tools}px FixedDemiBold, ui-monospace, monospace`;
  ctx.textAlign = "left";
  for (const l of lines) {
    const a = l.startPlane ? _rblPlaneGeo(l.startPlane) : _rblGeo(l.startGeo);
    const isTemp = (l === window.starsState.tempLine && !l.endPlane);
    const b = l.endPlane ? _rblPlaneGeo(l.endPlane) : (isTemp ? window.mouseGeo() : _rblGeo(l.end));
    if (!a || !b) continue;
    const pa = geoToScreen(a), pb = geoToScreen(b);
    ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
    const distNM = distanceNM(a, b);
    const brg = rblBearing(a, b);
    ctx.fillText(`${distNM.toFixed(1)}/${String(Math.round(brg) % 360).padStart(3, "0")}`,
      (pa.x + pb.x) / 2 + 5, (pa.y + pb.y) / 2 - 3);
  }
}

// STCA pair scan — N² over owned tracks. Cheap for typical TRACON load.
const stcaPairs = new Set();   // "guid1|guid2"
function scanSTCA() {
  stcaPairs.clear();
  const owned = [];
  for (const t of tracks.values()) {
    if (!t.Location || t.IsOnGround) continue;
    const fp = trackToFp.get(t.Guid);
    if (fp?.Owner !== ownTcp()) continue;
    owned.push(t);
  }
  for (let i = 0; i < owned.length; i++) {
    for (let j = i + 1; j < owned.length; j++) {
      const a = owned[i], b = owned[j];
      const dnm = distanceNMGeo(a.Location, b.Location);
      const altA = a.Altitude?.Value || 0;
      const altB = b.Altitude?.Value || 0;
      // CRC STARS: 3 NM horizontal AND 1000 ft vertical AND NON-INCREASING
      // separation. A passing/diverging pair must NOT alert.
      if (dnm < STCA.lateralNM && Math.abs(altA - altB) < STCA.verticalFt && stcaClosing(a, b)) {
        stcaPairs.add(a.Guid + "|" + b.Guid);
        a._stca = true; b._stca = true;
      }
    }
  }
  // Clear flag (and ack state) on tracks no longer in any conflict pair.
  for (const t of tracks.values()) {
    if (stcaPairs.size && [...stcaPairs].some(k => k.includes(t.Guid))) continue;
    t._stca = false; t._caAcked = false;
  }
}

// Non-increasing horizontal separation test: closing or constant ⇒ r·vrel ≤ 0,
// where r = posB − posA (NM, E/N) and vrel = velB − velA (kt). Diverging pairs
// (r·v > 0) are excluded. Missing velocity ⇒ treat as closing (conservative).
function stcaClosing(a, b) {
  if (a.GroundSpeed == null || a.GroundTrack == null ||
      b.GroundSpeed == null || b.GroundTrack == null) return true;
  const latF = Math.cos(((a.Location.Latitude + b.Location.Latitude) / 2) * Math.PI / 180);
  const rE = (b.Location.Longitude - a.Location.Longitude) * 60 * latF;
  const rN = (b.Location.Latitude  - a.Location.Latitude)  * 60;
  const rad = Math.PI / 180;
  const vE = b.GroundSpeed * Math.sin(b.GroundTrack * rad) - a.GroundSpeed * Math.sin(a.GroundTrack * rad);
  const vN = b.GroundSpeed * Math.cos(b.GroundTrack * rad) - a.GroundSpeed * Math.cos(a.GroundTrack * rad);
  return (rE * vE + rN * vN) <= 0;
}

// Acknowledge a CA by clicking either track (CRC STARS): silences (we have no
// tone) and turns the CA text solid. Acks both tracks in every pair it's in.
window.starsAckCA = (track) => {
  if (!track || !track._stca) return false;
  for (const key of stcaPairs) {
    const [g1, g2] = key.split("|");
    if (g1 !== track.Guid && g2 !== track.Guid) continue;
    const t1 = tracks.get(g1), t2 = tracks.get(g2);
    if (t1) t1._caAcked = true;
    if (t2) t2._caAcked = true;
  }
  return true;
};
// CA is now computed server-side by DGScope's ConflictAlertSystem (see handleCA / UT=4).
// The local scan is kept only as a fallback if no server CA arrives within a few seconds.
let _lastServerCA = 0;
setInterval(() => { if (Date.now() - _lastServerCA > 4000) scanSTCA(); }, 1000);

// ── Radar sweep model (DGScope Radar.cs) — match it exactly, don't invent ────
// UpdateRate = 1: the sweep rotates once per SECOND, so each target's DISPLAYED
// position is updated ~1 Hz to its ExtrapolatePosition(now) (Radar.cs:95-110) —
// a discrete 1 Hz step, NOT continuous 60 fps. A history dot is shifted in every
// HistoryRate seconds at the swept position (RadarWindow.cs:5509-5542). A target
// not updated within LostTargetSeconds is dropped/hidden (RadarWindow.cs:241).
const LOST_TARGET_MS = 30000;   // LostTargetSeconds = 30
function radarSweep() {
  const now = Date.now();
  for (const t of tracks.values()) {
    if (!t.Location) continue;
    // Stop sweeping a track whose position has gone stale (no movement within
    // LostTargetSeconds) — it's coasting / has landed and will be hidden.
    if (now - (t.lastMoveT ?? t.lastPosUpdate ?? t.lastUpdate) > LOST_TARGET_MS) continue;
    const pos = extrapolatedPosition(t);
    if (!pos) continue;
    t._sweptPos = pos;                                   // 1 Hz displayed position
    if (!t._lastHistoryT) t._lastHistoryT = now;
    if (now - t._lastHistoryT >= prefSet.HistoryRate * 1000) {
      // Only deposit a history dot if the target actually moved since the last
      // one — otherwise a frozen track stacks dots into a blob at one spot.
      const last = t._history && t._history[0];
      const moved = !last || Math.abs(pos.Latitude - last.Latitude) > 1e-5
                          || Math.abs(pos.Longitude - last.Longitude) > 1e-5;
      if (moved) {
        (t._history ||= []).unshift({ Latitude: pos.Latitude, Longitude: pos.Longitude });
        while (t._history.length > prefSet.HistoryNum) t._history.pop();
      }
      t._lastHistoryT = now;
    }
  }
}
setInterval(radarSweep, 1000);   // UpdateRate = 1 s
// The DISPLAYED position the renderer should use (the 1 Hz swept value).
function displayPos(t) { return t._sweptPos || t.Location || null; }

// Memory backstop: fully drop tracks not updated for a long time (the upstream
// deletes after ~5 min). Visual hiding happens in drawTracks at LOST_TARGET_MS.
setInterval(() => {
  const now = Date.now();
  for (const [guid, t] of tracks) {
    if (now - t.lastUpdate > 120000) { tracks.delete(guid); trackToFp.delete(guid); }
  }
}, 10000);

function distanceNMGeo(a, b) {
  const R = 3443.92;
  const φ1 = a.Latitude * Math.PI / 180;
  const φ2 = b.Latitude * Math.PI / 180;
  const dφ = (b.Latitude - a.Latitude) * Math.PI / 180;
  const dλ = (b.Longitude - a.Longitude) * Math.PI / 180;
  const h = Math.sin(dφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(dλ/2)**2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function drawMinSep() {
  // MinSep / RBL — Tools brightness (RadarWindow.cs:4998-4999).
  const stroke = adjusted(COLORS.RBL, prefSet.Brightness.Tools);
  const drawPair = (a, b) => {
    const p1 = displayPos(a), p2 = displayPos(b);
    if (!p1 || !p2) return;
    const s1 = geoToScreen(p1), s2 = geoToScreen(p2);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(s1.x, s1.y); ctx.lineTo(s2.x, s2.y);
    ctx.stroke();
    ctx.setLineDash([]);
    const mx = (s1.x + s2.x) / 2, my = (s1.y + s2.y) / 2;
    const dist = distanceNMGeo(p1, p2);
    ctx.fillStyle = stroke;
    ctx.font = "11px FixedDemiBold, ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.fillText(`${dist.toFixed(2)} NM`, mx, my - 6);
  };
  // Per-pair entries from the End-key tool (preview.js:110-130, mirrors
  // RadarWindow.cs:2579-2605 minSeps list). Draw each pair.
  const ms = window.starsState && window.starsState.minSeps;
  if (Array.isArray(ms)) {
    for (const pair of ms) {
      if (pair.plane1 && pair.plane2) drawPair(pair.plane1, pair.plane2);
    }
  }
  // Legacy single-pair from MCA `LL` shortcut (window.starsMinSep).
  if (minSepPair) drawPair(minSepPair.p1, minSepPair.p2);
}

window.starsJRing = (flid, radius) => {
  const plane = (() => {
    if (!flid) return null;
    for (const t of tracks.values()) {
      const fp = trackToFp.get(t.Guid);
      const cs = fp?.Callsign || t.Callsign;
      if (cs && cs.toUpperCase() === flid.toUpperCase()) return t;
      if (t.Squawk === flid) return t;
    }
    return null;
  })();
  if (!plane) return false;
  plane._jRing = plane._jRing === radius ? 0 : radius;
  return true;
};

window.starsMinSep = (flid1, flid2) => {
  const find = (id) => {
    for (const t of tracks.values()) {
      const fp = trackToFp.get(t.Guid);
      if ((fp?.Callsign || t.Callsign)?.toUpperCase() === id.toUpperCase()) return t;
      if (t.Squawk === id) return t;
    }
  };
  const p1 = find(flid1), p2 = find(flid2);
  if (!p1 || !p2 || !p1.Location || !p2.Location) {
    minSepPair = null;
    return null;
  }
  const dist = distanceNMGeo(p1.Location, p2.Location);
  minSepPair = { p1, p2, dist, t: Date.now() };
  return dist;
};
window.starsMinSepClear = () => { minSepPair = null; };

// ── PORT-ONLY: dedupByCallsign + mergedFp ────────────────────────────────
// DGScope: one Aircraft per physical plane. The server-side dStars adapter
// in this project (DgScopeAdapter.cs) is wire-faithful to the dstars
// protocol but its UPSTREAM (TAIS) can emit MULTIPLE GUIDs for the same
// aircraft (different track-numbers per radar source, plus optional ADS-B
// Mode-S injection). DGScope would never see that — its single dstars
// stream merges upstream.
//
// dedupByCallsign picks one primary GUID per (callsign or discrete squawk)
// key and routes the rest to mergedFp so renderers see the most complete
// view of an aircraft. STATE fields (Owner / PendingHandoff / etc.) use
// freshness-wins to prevent oscillation; ENRICH fields use primary-if-
// has-value with sibling fallback. Without these helpers, the same plane
// would render as two ghost tracks with split data.
let _siblingsByPrimary = new Map();   // primary guid -> [sibling guids]

function dedupByCallsign(now) {
  const byKey = new Map();         // dedup key → { primaryGuid, fresh, siblings: [] }
  const suppressed = new Set();
  for (const t of tracks.values()) {
    if (!t.Location) continue;
    if (now - (t.lastMoveT ?? t.lastPosUpdate ?? t.lastUpdate) > LOST_TARGET_MS) continue;
    // Dedup by callsign; for callsign-less tracks fall back to the discrete
    // beacon code (unique to one aircraft). VFR 1200 (and 0000) are shared by
    // many aircraft, so never dedup those.
    let key = (trackToFp.get(t.Guid)?.Callsign || t.Callsign || "").toUpperCase();
    if (!key) {
      const sq = t.Squawk;
      if (sq && sq !== "1200" && sq !== "0000") key = "SQ:" + sq;
    }
    if (!key) continue;
    const fresh = t.lastPosUpdate ?? t.lastUpdate ?? 0;
    const cur = byKey.get(key);
    if (!cur) { byKey.set(key, { primaryGuid: t.Guid, fresh, siblings: [] }); continue; }
    // Tight-race stability: keep the INCUMBENT primary unless the challenger
    // is more than 3s newer. The "loser" GUID is added to siblings[] so its
    // fp/track data can fill in any fields missing on the primary (see
    // mergedFp). This replaces the previous suppress-and-discard behaviour
    // that lost real data (Owner, PendingHandoff, scratchpads) whenever
    // TAIS briefly published the same callsign on a transient new trackNum.
    const gap = fresh - cur.fresh;
    if (gap > 3000) {
      // Demote the old primary, keep its history as a sibling.
      suppressed.add(cur.primaryGuid);
      cur.siblings.push(cur.primaryGuid);
      cur.primaryGuid = t.Guid;
      cur.fresh = fresh;
    } else {
      suppressed.add(t.Guid);
      cur.siblings.push(t.Guid);
    }
  }
  // Build the primary->siblings map for mergedFp() lookups.
  _siblingsByPrimary = new Map();
  for (const v of byKey.values()) {
    if (v.siblings.length) _siblingsByPrimary.set(v.primaryGuid, v.siblings);
  }
  return suppressed;
}

// mergedFp(primaryGuid) — split-rule merge.
//
// STATE fields (Owner / PendingHandoff / IsHandoffInProgress / HandoffOcr):
//   Pure freshness: whichever fp has the newest _updatedAt wins, INCLUDING
//   when its value is the empty string "". Treating "" as "missing" let a
//   stale sibling re-introduce a cleared handoff — the bug behind both
//   "handoffs not clearing" and the split-second C flash.
//
// ENRICHMENT fields (callsign, type, scratchpad, route, etc.):
//   Primary if it has a value; sibling fallback if primary is null/empty.
//   Static data, no oscillation risk; the "fall back to anything that has
//   it" rule is what makes thin TAIS FPs still render with full info.
function mergedFp(primaryGuid) {
  const primary = trackToFp.get(primaryGuid);
  const siblings = _siblingsByPrimary.get(primaryGuid);
  if (!siblings || !siblings.length) return primary;
  const out = primary ? { ...primary } : {};
  const STATE = ["Owner","PendingHandoff","IsHandoffInProgress","HandoffOcr"];
  const ENRICH = [
    "Callsign","AircraftType","WakeCategory","FlightRules",
    "Origin","Destination","EntryFix","ExitFix","Route","RequestedAltitude",
    "Scratchpad1","Scratchpad2","Runway",
    "AssignedSquawk","EquipmentSuffix","LDRDirection",
  ];
  const primaryAt = primary?._updatedAt || 0;
  // Pick the single FRESHEST source per STATE field. Sibling wins only when
  // its update is strictly newer than the primary's; primary's "" wins over
  // a sibling's "C" if primary updated more recently.
  let stateWinner = primary;
  let stateWinAt = primaryAt;
  for (const sg of siblings) {
    const sib = trackToFp.get(sg);
    if (!sib) continue;
    const sibAt = sib._updatedAt || 0;
    if (sibAt > stateWinAt) { stateWinner = sib; stateWinAt = sibAt; }
  }
  if (stateWinner && stateWinner !== primary) {
    for (const k of STATE) out[k] = stateWinner[k];
  }
  // ENRICHMENT — primary already in out; fall back to siblings when missing.
  for (const sg of siblings) {
    const sib = trackToFp.get(sg);
    if (!sib) continue;
    for (const k of ENRICH) {
      if ((out[k] == null || out[k] === "") && sib[k] != null && sib[k] !== "") {
        out[k] = sib[k];
      }
    }
  }
  return out;
}

// ── Main per-track draw ─────────────────────────────────────────────────────
function drawTracks() {
  // Main per-frame aircraft draw — equivalent to DGScope's RadarWindow
  // DrawTargets + ProcessDataBlocks (cs:6184-6342). DGScope iterates
  // Aircraft, drops those past LostTargetSeconds (cs:5588 / 6187), and
  // calls RedrawTarget + GenerateDataBlock per cs:5590-5597.
  const now = Date.now();
  const suppressed = dedupByCallsign(now);
  // ── Pre-pass: per-aircraft state sync (mirrors DGScope cs:5719-5742 +
  //    6239-6241). Both loops are inside DrawTargets; we split for clarity.
  const showAllCallsigns = !!window.showAllCallsigns;
  const QuickLookList = (window.prefSet && window.prefSet.QuickLookedTCPs) || [];
  const meTcp = ((window.ownTcp && window.ownTcp()) || "").trim().toUpperCase();
  for (const t of tracks.values()) {
    // cs:6239-6241 — sync ShowCallsignWithNoSquawk from global F1-hold flag.
    t.ShowCallsignWithNoSquawk = showAllCallsigns;
    // cs:5719-5742 — per-aircraft QuickLook / QuickLookPlus derivation
    // from PositionInd against QuickLookList ("ALL" / "ALL+" handled too).
    const fp = window.trackToFp ? window.trackToFp.get(t.Guid) : null;
    const PositionInd = (fp && fp.Owner) || t.PositionInd || "";
    // cs:6172-6173 — `if (x.PositionInd == ThisPositionIndicator) x.Owned = true`
    // Sticky Owned bool: SET when PositionInd == me, never auto-cleared (only
    // via F12 sign-on or click-to-release at cs:2775-2778 / processImplied
    // step 5). This is what keeps an outbound-handoff data block WHITE after
    // TAIS flips cps to the receiver — Owned remains true from the prior
    // frame's set, until the user clicks to acknowledge.
    if (meTcp) {
      const pi = PositionInd ? String(PositionInd).trim().toUpperCase() : "";
      const ph = fp?.PendingHandoff ? String(fp.PendingHandoff).trim().toUpperCase() : "";
      if (pi === meTcp || ph === meTcp) t._owned = true;
    }
    const associated  = !!(PositionInd && PositionInd !== "*");
    const qlall       = associated && QuickLookList.includes("ALL");
    const qlallplus   = associated && QuickLookList.includes("ALL+");
    if (QuickLookList.includes(PositionInd) || qlall) {
      t._quickLookPlus = false;
      t._quickLook     = true;
    } else if (QuickLookList.includes(PositionInd + "+") || qlallplus) {
      t._quickLook     = true;
      t._quickLookPlus = true;
    } else {
      t._quickLookPlus = false;
      t._quickLook     = false;
    }
  }
  // ── Draw pass — cs:6184-6342 ────────────────────────────────────────────
  for (const t of tracks.values()) {
    if (!t.Location) continue;                       // no position fix yet
    if (suppressed.has(t.Guid)) continue;            // sibling of another GUID (port-only)
    if (t.IsOnGround) continue;                      // Radar.cs Scan skips ground
    // cs:5588 — LastMessageTime > CurrentTime - LostTargetSeconds gate.
    if (now - (t.lastMoveT ?? t.lastPosUpdate ?? t.lastUpdate) > LOST_TARGET_MS) continue;
    // mergedFp — see PORT-ONLY block above. DGScope reads fp fields off the
    // single Aircraft instance; we merge across sibling GUIDs.
    const fp = mergedFp(t.Guid);
    // PrefSet AltitudeFilterAssociated{Min,Max} / UnAssociated{Min,Max}
    // gate — RadarWindow.cs InFilter (called from cs:5595). DGScope's
    // InFilter also checks SelectedBeaconCodes / overrides; we apply the
    // pure altitude bracket here, the rest falls out of dataBlockMode.
    const altFt = t.Altitude?.Value;
    if (altFt != null) {
      if (fp) {
        if (altFt < prefSet.AltitudeFilterAssociatedMin) continue;
        if (altFt > prefSet.AltitudeFilterAssociatedMax) continue;
      } else {
        if (altFt < prefSet.AltitudeFilterUnAssociatedMin) continue;
        if (altFt > prefSet.AltitudeFilterUnAssociatedMax) continue;
      }
    }
    // displayPos = SweptLocation equivalent — extrapolated to "now" so the
    // target paints between feed updates. Off-screen cull (cs has no
    // equivalent — canvas is the screen, DGScope's OpenGL viewport culls).
    const posNow = displayPos(t);
    if (!posNow) continue;
    const sp = geoToScreen(posNow);
    if (sp.x < -50 || sp.x > view.W + 50 || sp.y < -50 || sp.y > view.H + 50) continue;
    drawHistory(t);
    drawPTL(t, posNow);
    drawPosition(t, posNow);
    drawDataBlockAndLeader(t, fp, posNow);
  }
}

// ── Main render loop ────────────────────────────────────────────────────────
function frame() {
  clear();
  // NEXRAD sits below the video map so map lines / range rings / tracks all
  // remain legible over weather. nexrad.js is a no-op until the user
  // enables it via the MCA `WX A` / DCB BRITE WX path.
  if (window.Nexrad?.draw) window.Nexrad.draw(ctx);
  drawVideoMapLines();
  drawRangeRings();
  drawCompass();
  drawJRings();
  drawRBLs();
  drawTracks();
  drawMinSep();
  updateTopbar();
  requestAnimationFrame(frame);
}

// Phase 7 retired the temp topbar; only the connection-state corner indicator remains.
function updateTopbar() {
  const el = document.getElementById("dstars-state");
  if (el)
    el.textContent = `DSTARS ${dstarsFacility()} · ${tracks.size}T/${flightPlans.size}FP · ` +
      (dstarsState.connected ? "LIVE" : (dstarsState.lastError || "off"));
}

// Background history ticker — runs even when tab is inactive so history trail
// doesn't have gaps when the page is in the background. Complements the render-
// loop ticker (drawTracks → tickHistory) to fill gaps during tab inactivity.
setInterval(() => {
  for (const t of tracks.values()) {
    const posNow = displayPos(t);
    if (posNow) tickHistory(t, posNow);
  }
}, 1000);  // Tick every second, independent of render loop

// ── Input: pan / zoom / right-click set RR center ───────────────────────────
// Mouse handlers mirror RadarWindow.cs ~lines 1300-1320 + 4636-4650 for zoom.
// Pan via middle-button drag OR right-button drag (button 2). Drag distance
// must exceed a small threshold before we treat the right-click as a pan
// vs a context-menu / STARS-command attempt.
let panning = false;
let lastPan = null;
let panButton = -1;
const PAN_THRESHOLD = 3;
let downAt = null;
cv.addEventListener("mousedown", (e) => {
  if (e.button === 1) {
    // Middle-click: toggle claimed status (light blue tag)
    const hit = pickAircraft(e.clientX, e.clientY);
    if (hit) {
      if (claimedTracks.has(hit.Guid)) {
        claimedTracks.delete(hit.Guid);
      } else {
        claimedTracks.add(hit.Guid);
      }
      e.preventDefault();
      return;
    }
  }
  if (e.button === 1 || e.button === 2) {
    panning = true;
    panButton = e.button;
    lastPan = { x: e.clientX, y: e.clientY };
    downAt  = { x: e.clientX, y: e.clientY };
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
window.addEventListener("mouseup", () => { panning = false; panButton = -1; downAt = null; });

// Mouse-position helpers used by MCA commands (F D *, F P, F S, *T).
// Updated on every mousemove over the canvas.
let _lastMouseScreen = null;
let _lastMouseGeo = null;
cv.addEventListener("mousemove", (e) => {
  _lastMouseScreen = { x: e.clientX, y: e.clientY };
  _lastMouseGeo = screenToGeo(e.clientX, e.clientY);
});
window.mouseScreen = () => _lastMouseScreen;
window.mouseGeo    = () => _lastMouseGeo;

// State container for MCA commands. Mirrors WPF RadarWindow scope-state
// fields: ATPA, TPASize, DrawATPAMonitorCones, AutoOffset, rangeBearingLines,
// minSeps, tempLine, tempMinSep, Nexrad.LevelsEnabled.
window.starsState ||= {
  ATPA: { Active: false, Volumes: [] },
  TPASize: false,
  DrawATPAMonitorCones: false,
  AutoOffset: false,
  rangeBearingLines: [],
  minSeps: [],
  tempLine: null,
  tempMinSep: null,
  Nexrad: { LevelsEnabled: [false, false, false, false, false, false] },
};
window.starsWaypoints ||= [];
window.starsAirports  ||= [];

// recenterScope(lat, lon) - move scope to lat/lon (or RECENTER home if none).
// RadarWindow.cs:2558-2577 sets HomeLocation, RangeRingLocation, ScreenRotation
// when an airport ID is supplied. With no args (Ctrl+F1), simply re-center to
// the current ScreenCenterPoint - the "ScopeCentered" mode the WPF toggles.
window.recenterScope = (lat, lon) => {
  if (lat != null && lon != null) {
    prefSet.ScreenCenterPoint = { Latitude: lat, Longitude: lon };
    prefSet.RangeRingLocation = { Latitude: lat, Longitude: lon };
  }
  prefSet.ScopeCentered = true;
};

cv.addEventListener("wheel", (e) => {
  e.preventDefault();
  // RadarWindow.cs cycles Range via DCB buttons; mouse-wheel here is a web-only
  // convenience (G7). Doubles/halves rounded to nearest integer NM.
  const step = e.deltaY < 0 ? 0.85 : 1.18;
  prefSet.Range = Math.max(1, Math.min(400, Math.round(prefSet.Range * step)));
  recomputeScale();
  _afterPrefChange();
}, { passive: false });

cv.addEventListener("contextmenu", (e) => {
  e.preventDefault();  // G6 suppress browser menu only - no STARS action
});

// ── Bootstrap: load facility, set HomeLocation, kick off render ─────────────
async function bootstrap() {
  document.title = `STARS ${ARTCC}/${FACILITY}`;
  resize();
  try {
    const fac = await fetch(`/api/stars/facility/${encodeURIComponent(ARTCC)}/${encodeURIComponent(FACILITY)}`).then(r => r.json());
    // A STARS facility has one or more AREAS; each area carries its own
    // visibilityCenter (display center), surveillanceRange, maps and altimeter.
    // Center on the selected area's visibilityCenter — NOT the ARTCC center.
    const sc = fac && fac.starsConfiguration;
    const areas = (sc && Array.isArray(sc.areas)) ? sc.areas : [];
    const areaSel = new URLSearchParams(location.search).get("area");
    let area = areas[0] || null;
    if (areaSel && areas.length) {
      const m = areas.find(a => a.id === areaSel ||
        (a.name || "").toUpperCase() === areaSel.toUpperCase());
      if (m) area = m;
    }
    starsState.area = area;

    // Center priority: area.visibilityCenter → facility location → ARTCC center.
    let loc = null;
    if (area && area.visibilityCenter) loc = area.visibilityCenter;
    else if (fac && fac.location) loc = fac.location;
    else if (fac && Array.isArray(fac.visibilityCenters) && fac.visibilityCenters[0])
      loc = fac.visibilityCenters[0];

    if (loc) {
      prefSet.ScreenCenterPoint = { Latitude: loc.lat, Longitude: loc.lon };
      prefSet.RangeRingLocation = { Latitude: loc.lat, Longitude: loc.lon };
      starsState.facilityLocation = { Latitude: loc.lat, Longitude: loc.lon };
    } else {
      console.warn("[STARS] No area/location available; centering on 0,0.");
    }
    // Default range from the area's surveillance range (e.g. RDU = 80).
    if (area && area.surveillanceRange) prefSet.Range = area.surveillanceRange;
    else if (area && area.defaultRange) prefSet.Range = area.defaultRange;
    if (fac && fac.name) document.title = `STARS ${ARTCC}/${FACILITY} — ${fac.name}`;
    recomputeScale();

    // Phase 2: load video map catalog
    if (fac) {
      await loadVideoMapsCatalog(fac.starsConfiguration, fac.videoMaps);
      warmAllMaps();   // background prefetch so MAP toggles render instantly
    }
    // Phase 4: ASR sites for SITE submenu (vNAS starsConfiguration → areas → asrSites if present)
    starsState.asrSites = fac?.starsConfiguration?.areas?.flatMap(a => a.asrSites || []) || [];

    // Optional vNAS profile from URL ?profile=NAME (web-only artifact).
    const profileName = (new URLSearchParams(location.search)).get("profile");
    if (profileName) await applyProfile(profileName);

    // DGScope XML profile — the same file the WPF Profile Manager writes.
    // Auto-load `<ARTCC>/<FACILITY>_TRACON.xml` from the server's
    // stars-profiles/ root, then any `?dgprofile=NAME` override. This applies
    // top-level COLORS, ScreenRotation, NEXRAD ColorTable, and
    // CurrentPrefSet/Brightness so the scope matches the user's WPF setup.
    if (window.StarsProfile) {
      const dgOverride = (new URLSearchParams(location.search)).get("dgprofile");
      const name = dgOverride || `${FACILITY}_TRACON`;
      await window.StarsProfile.load(ARTCC, name);
    }
  } catch (e) {
    console.error("[STARS] Failed to load facility:", e);
  }

  // Restore the user's DCB-driven preference overrides AFTER profile load
  // (so the user's customizations win over a fresh profile reload) but
  // BEFORE applyUrlState (URL params still get the final word for things
  // like deep-link ?r=20).
  loadPrefsFromLocalStorage();
  applyUrlState();
  recomputeScale();  // Recalculate canvas scale after Range is loaded/applied
  loadDCBVisibilityFromSession();  // Load DCB visibility for this session (defaults to true)

  // Phase 4: mount the Display Control Bar.
  mountDcb();
  // Phase 5: mount MCA / preview area.
  if (window.mountPreview) window.mountPreview();
  // Phase 7: mount SSA / status area.
  if (window.mountSsa) window.mountSsa();
  // Phase 3a: DSTARS streaming connection. Runs independent of facility load.
  startDstars();

  // NEXRAD overlay (off by default — user enables via MCA `WX A` / DCB).
  // Run after the screen-centre is known so the nearest-station lookup
  // resolves to the right radar.
  if (window.Nexrad?.init) window.Nexrad.init();

  // G1 workaround: wait for the STARS font (FixedDemiBold) before the first
  // paint so a cold load never renders the scope in fallback monospace.
  try {
    if (document.fonts) {
      await Promise.all([
        document.fonts.load(`${prefSet.CharSize.DataBlock}px FixedDemiBold`),
        document.fonts.load(`${prefSet.CharSize.Position}px FixedDemiBold`),
        document.fonts.load(`${prefSet.CharSize.Lists}px FixedDemiBold`),
      ]);
      await document.fonts.ready;
    }
  } catch { /* fall through — render anyway */ }

  requestAnimationFrame(frame);
}

// Phase 4: DCB state container exposed to dcb.js.
const starsState = {
  prefSet,
  videoMaps,
  asrSites: [],
  wxLevels: [false, false, false, false, false, false],
  dcbMapAt,
  dcbSubmenuMapAt,
  mapGroups: [],
  activeMapGroup: null,
};

let dcb;
function mountDcb() {
  const root = document.getElementById("dcb");
  if (!root) return;
  dcb = new DCB(root, starsState);
  // Debug: ?menu=MAPS|BRITE|AUX|SITE pre-opens submenu so headless tests can
  // screenshot each one without scripted clicks.
  const qMenu = new URLSearchParams(location.search).get("menu");
  if (qMenu && ["MAIN","MAPS","BRITE","AUX","SITE"].includes(qMenu.toUpperCase()))
    dcb.active = qMenu.toUpperCase();
  dcb.on("numAdjust", (id, dir) => handleNumAdjust(id, dir));
  dcb.on("rangeAdjust", (id, dir) => handleNumAdjust(id, dir));
  dcb.on("briteAdjust", (which, d) => handleBriteAdjust(which, d));
  dcb.on("cszAdjust", (which, d) => handleCszAdjust(which, d));
  dcb.on("mapToggle", (idx) => handleMapToggle(idx));
  dcb.on("placeMode", (btnId) => {
    // Enter place mode - map click will handle the actual placement
    // Button stays selected until exitPlaceMode() is called
  });
  // WX1-WX6: per RadarWindow.cs:3886-3896, each click toggles that
  // intensity layer (Nexrad.LevelsEnabled[i] flip). Buttons live on the
  // main DCB itself (cs:3568-3573), not in a submenu. We mirror that —
  // wxLevels[] drives the button's active state; Nexrad.draw() reads it
  // via prefSet.Nexrad.levels.
  dcb.on("wxToggle", (n) => handleWxToggle(n));
  dcb.on("click", ({ id }) => handleDcbClick(id));
  dcb.render();
  // Re-render DCB with debouncing (ERAM pattern: natural interval + force-immediate on state changes).
  // Instead of rendering every 1000ms regardless, check elapsed time and only render if needed.
  let dcbLastRenderTime = Date.now();
  const DCB_RENDER_INTERVAL = 1000;
  setInterval(() => {
    const now = Date.now();
    if (now - dcbLastRenderTime >= DCB_RENDER_INTERVAL) {
      dcb.render();
      dcbLastRenderTime = now;
    }
  }, 100);  // Check frequently, but only render if interval elapsed
  // Export function so DCB click handlers can force immediate render
  window.forceDcbRender = () => { dcbLastRenderTime = 0; };
}

// DcbWxButtonClick (RadarWindow.cs:3886-3896) — toggles Nexrad.LevelsEnabled[i].
// Click any WX# button to flip that layer; turning on a layer when the
// overlay is off also turns the master enable on (so users don't have to
// chase a separate switch). Also kicks off the radar-image fetch on the
// first toggle — init() may have been delayed waiting for ScreenCenterPoint.
function handleWxToggle(n) {
  const idx = n - 1;
  if (idx < 0 || idx > 5) return;
  starsState.wxLevels[idx] = !starsState.wxLevels[idx];
  // Nexrad.enable(true) ensures prefSet.Nexrad exists (it loads BEFORE
  // scope.js, so its module-time init may have skipped that block) AND
  // kicks off station pick + image fetch on first call.
  if (starsState.wxLevels.some(Boolean) && window.Nexrad) {
    window.Nexrad.enable(true);                  // master on + lazy init
  }
  if (prefSet.Nexrad) {
    if (starsState.wxLevels[idx]) prefSet.Nexrad.levels |= (1 << idx);
    else                          prefSet.Nexrad.levels &= ~(1 << idx);
  }
  if (dcb) dcb.render();
  _afterPrefChange();
}

function _afterPrefChange() {
  if (window.pushUrlState) window.pushUrlState();
  savePrefsToLocalStorage();
}

// ── PORT-ONLY: DCB pref persistence ───────────────────────────────────────
// DGScope has no equivalent: WPF Settings.SaveCurrent() writes the prefSet
// to a .stars settings file on disk on Exit (cs Run/window.Closed handler).
// In a browser tab there's no on-disk write path AND no reliable Exit
// callback (closing a tab can run a quick beforeunload but not always
// reliable), so we save eagerly to localStorage from _afterPrefChange.
// loadPrefsFromLocalStorage runs in bootstrap AFTER profile.js so the
// user's customizations beat a re-applied profile; URL params still apply
// last for deep-link semantics. Excludes transient SSA / per-track state
// (which DGScope also doesn't persist beyond the session).
const STARS_PREFS_KEY = "stars.prefs.v1";
function savePrefsToLocalStorage() {
  try {
    const snap = {
      Range: prefSet.Range,
      RangeRingSpacing: prefSet.RangeRingSpacing,
      LeaderLength: prefSet.LeaderLength,
      HistoryNum: prefSet.HistoryNum,
      HistoryRate: prefSet.HistoryRate,
      PTLLength: prefSet.PTLLength,
      PTLOwn: prefSet.PTLOwn,
      PTLAll: prefSet.PTLAll,
      DCBLocation: prefSet.DCBLocation,
      OwnedDataBlockPosition: prefSet.OwnedDataBlockPosition,
      UnownedDataBlockPosition: prefSet.UnownedDataBlockPosition,
      UnassociatedDataBlockPosition: prefSet.UnassociatedDataBlockPosition,
      AltitudeFilterAssociatedMin: prefSet.AltitudeFilterAssociatedMin,
      AltitudeFilterAssociatedMax: prefSet.AltitudeFilterAssociatedMax,
      AltitudeFilterUnAssociatedMin: prefSet.AltitudeFilterUnAssociatedMin,
      AltitudeFilterUnAssociatedMax: prefSet.AltitudeFilterUnAssociatedMax,
      LdbBeaconCodesInhibited: prefSet.LdbBeaconCodesInhibited,
      Brightness: { ...prefSet.Brightness },
      CharSize: { ...prefSet.CharSize },
      // NOT persisted: ScreenCenterPoint, RangeRingLocation — these are
      // FACILITY-specific (each TRACON/RAPCON has its own visibilityCenter
      // from the vNAS API per area). Saving them globally meant opening
      // ILM after RDU centered the scope on RDU.
      InvertKeyboard: prefSet.InvertKeyboard,
      Nexrad: prefSet.Nexrad ? { ...prefSet.Nexrad } : undefined,
      wxLevels: starsState && starsState.wxLevels ? [...starsState.wxLevels] : undefined,
    };
    localStorage.setItem(STARS_PREFS_KEY, JSON.stringify(snap));
  } catch (e) { /* quota or disabled — silently skip */ }
}
function loadPrefsFromLocalStorage() {
  try {
    const raw = localStorage.getItem(STARS_PREFS_KEY);
    if (!raw) return;
    const snap = JSON.parse(raw);
    // Ignore facility-specific fields that an older save (pre-stale-data
    // cleanup) might still have — these come from the per-area
    // visibilityCenter at facility load and should never be cross-facility
    // sticky.
    // Also ignore DCBVisible — it's session-only, not persisted across page reloads.
    const ignore = new Set(["ScreenCenterPoint", "RangeRingLocation", "wxLevels", "DCBVisible"]);
    // Shallow-merge scalars; deep-merge sub-objects so a new default field
    // added later isn't wiped by the saved snapshot.
    for (const k of Object.keys(snap)) {
      if (ignore.has(k)) continue;
      if (snap[k] == null) continue;
      if (typeof snap[k] === "object" && !Array.isArray(snap[k])) {
        prefSet[k] = { ...prefSet[k], ...snap[k] };
      } else {
        prefSet[k] = snap[k];
      }
    }
    // Restore wxLevels (stored separately in starsState, not prefSet)
    if (snap.wxLevels && Array.isArray(snap.wxLevels)) {
      starsState.wxLevels = snap.wxLevels;
    }
  } catch (e) { /* corrupt JSON — silently skip */ }
}

// DCBVisible session storage — preserved only for the current session/tab, resets on page reload
function saveDCBVisibilityToSession() {
  try {
    sessionStorage.setItem("stars.dcb-visible", String(prefSet.DCBVisible));
  } catch (e) { /* quota or disabled — silently skip */ }
}
function loadDCBVisibilityFromSession() {
  try {
    const raw = sessionStorage.getItem("stars.dcb-visible");
    if (raw === "false") prefSet.DCBVisible = false;
    // Otherwise stay at default (true), or true if raw is null/true
  } catch (e) { /* quota or disabled — silently skip */ }
}

function handleNumAdjust(id, dir) {
  switch (id) {
    case "RANGE":
      // RadarWindow.cs:4224-4246 dcbRangeButton — ±1 step, clamp 6..512.
      prefSet.Range = clamp(prefSet.Range + dir, 6, 512);
      recomputeScale();
      break;
    case "RR_NUM":
      // RadarWindow.cs:4670-4694 — cycle 2 → 5 → 10 → 20 (and reverse).
      switch (prefSet.RangeRingSpacing) {
        case 2:  if (dir > 0) prefSet.RangeRingSpacing = 5;  break;
        case 5:  prefSet.RangeRingSpacing = dir > 0 ? 10 : 2; break;
        case 10: prefSet.RangeRingSpacing = dir > 0 ? 20 : 5; break;
        case 20: if (dir < 0) prefSet.RangeRingSpacing = 10;  break;
        default: prefSet.RangeRingSpacing = 2;
      }
      break;
    case "LDR_LEN":
      // RadarWindow.cs:4178-4199 dcbLdrLenButton — ±1 step, clamp 0..8.
      prefSet.LeaderLength = clamp(prefSet.LeaderLength + dir, 0, 8);
      break;
    case "LDR_DIR": {
      // RadarWindow.cs:3694-3722 (DcbLdrDirButton_Down) + 3725-3753 (_Up).
      // Down cycles counterclockwise: N→NW→W→SW→S→SE→E→NE→N (cs:3699-3721).
      // Our prefSet stores LeaderDirection as the keypad enum 1-9; the cycle
      // order here is N,NW,W,SW,S,SE,E,NE matching cs:3694-3722 explicitly.
      const ccw = [2, 1, 4, 7, 8, 9, 6, 3];   // N → NW → W → SW → S → SE → E → NE
      const cur = ccw.indexOf(prefSet.OwnedDataBlockPosition);
      const next = (cur < 0)
        ? ccw[0]
        : ccw[(cur + (dir > 0 ? ccw.length - 1 : 1)) % ccw.length];
      prefSet.OwnedDataBlockPosition = next;
      break;
    }
    case "HIST_NUM":
      // RadarWindow.cs:4133-4153 dcbHistoryNumButton — ±1 step, clamp 0..10.
      prefSet.HistoryNum = clamp(prefSet.HistoryNum + dir, 0, 10);
      break;
    case "HIST_RATE":
      // RadarWindow.cs:4155-4177 dcbHistoryRateButton — ±0.5 step, clamp 0..4.5.
      prefSet.HistoryRate = clamp(prefSet.HistoryRate + dir * 0.5, 0, 4.5);
      break;
    case "PTL_LEN":
      // RadarWindow.cs:4201-4223 dcbPtlLengthButton — ±0.5 step, clamp 0..5.
      prefSet.PTLLength = clamp(prefSet.PTLLength + dir * 0.5, 0, 5);
      break;
    case "PTL_OWN":
      // RadarWindow.cs:3848-3853 — toggling PTL OWN clears PTL ALL (mutually
      // exclusive — only one mode can be on at a time).
      prefSet.PTLOwn = !prefSet.PTLOwn;
      if (prefSet.PTLOwn) prefSet.PTLAll = false;
      break;
    case "PTL_ALL":
      // RadarWindow.cs:3854-3857 — toggling PTL ALL clears PTL OWN.
      prefSet.PTLAll = !prefSet.PTLAll;
      if (prefSet.PTLAll) prefSet.PTLOwn = false;
      break;
    case "RR_CNTR":
      prefSet.RangeRingsCentered = !prefSet.RangeRingsCentered;
      if (prefSet.RangeRingsCentered) prefSet.RangeRingLocation = { ...prefSet.ScreenCenterPoint };
      break;
  }
  dcb.render();
  _afterPrefChange();
}

function handleCszAdjust(which, d) {
  const c = prefSet.CharSize;
  if (c[which] != null) c[which] = clamp(c[which] + d, 6, 32);
  if (dcb) dcb.render();
  _afterPrefChange();
}

function handleBriteAdjust(which, d) {
  const b = prefSet.Brightness;
  // Per-button [field, min] tuples — RadarWindow.cs:4247-4659 (each
  // `else if (button == briteXXXbutton)` block has its own min; all share
  // step=5, max=100). DCB / LST default min 25 (cs:4256, 4376); MPA / MPB
  // / WX / WXC use min 5 (cs:4304, 4328, 4616, 4640); the rest 0.
  const map = {
    DCB: ["DCB",               25],
    BKC: ["Background",         0],
    MPA: ["MapA",               5],
    MPB: ["MapB",               5],
    FDB: ["FullDataBlocks",     0],
    LST: ["Lists",             25],
    POS: ["PositionSymbols",    0],
    LDB: ["LimitedDataBlocks",  0],
    OTH: ["OtherFDBs",          0],
    TLS: ["Tools",              0],
    RR:  ["RangeRings",         0],
    CMP: ["Compass",            0],
    BCN: ["BeaconTargets",      0],
    PRI: ["PrimaryTargets",     0],
    HST: ["History",            0],
    WX:  ["Weather",            5],
    WXC: ["WeatherContrast",    5],
  };
  const entry = map[which]; if (!entry) return;
  const [k, min] = entry;
  const cur = b[k] ?? 100;
  b[k] = clamp(cur + d, min, 100);
  // Legacy aliases — see prefSet.Brightness declaration. Renderers that
  // haven't been split yet read the alias; mirror last-write-wins.
  if (k === "FullDataBlocks")  b.DataBlock = b[k];
  if (k === "PositionSymbols") b.Position  = b[k];
  if (k === "MapA")            b.VideoMapA = b[k];
  if (k === "MapB")            b.VideoMapB = b[k];
  dcb.render();
  _afterPrefChange();
}

function handleMapToggle(starsId) {
  // DCB MAP buttons (inline + MAPS submenu) emit the STARS map number.
  // Mirrors DGScope DcbMapButtonClick (RadarWindow.cs:3903-3915): look up
  // the bound map and flip its Visible flag.
  const m = videoMaps.find(x => x.starsId === starsId);
  if (!m) return;
  m.visible = !m.visible;
  if (m.visible && m.lines === null) ensureMapLoaded(m);
  if (window.pushUrlState) window.pushUrlState();
}

function handleDcbClick(id) {
  switch (id) {
    case "MAPS_CLEAR":
      videoMaps.forEach(m => m.visible = false);
      if (window.pushUrlState) window.pushUrlState();
      break;
    case "DCB_TOP":    prefSet.DCBLocation = "Top"; break;
    case "DCB_LEFT":   prefSet.DCBLocation = "Left"; break;
    case "DCB_RIGHT":  prefSet.DCBLocation = "Right"; break;
    case "DCB_BOTTOM": prefSet.DCBLocation = "Bottom"; break;
    case "PLACE_CNTR":
      // RadarWindow.cs PLACE CNTR: next map click sets ScreenCenterPoint.
      pendingMapAction = "PLACE_CNTR";
      break;
    case "OFF_CNTR":
      // Toggle off-center: restore screen center to facility location.
      prefSet.ScreenCenterPoint = { ...starsState.facilityLocation } || prefSet.ScreenCenterPoint;
      break;
    case "PLACE_RR":
      pendingMapAction = "PLACE_RR";
      break;
  }
  if (dcb) dcb.render();
}

// PLACE CNTR / PLACE RR: next click on map sets the corresponding location.
// Aircraft hit detection: find the closest track within 12 px and pass to MCA.
// Middle-click (button 1) toggles claimed status (light blue tag).
let pendingMapAction = null;
cv.addEventListener("click", (e) => {
  if (pendingMapAction) {
    const g = screenToGeo(e.clientX, e.clientY);
    if (pendingMapAction === "PLACE_CNTR") prefSet.ScreenCenterPoint = g;
    else if (pendingMapAction === "PLACE_RR") {
      prefSet.RangeRingLocation = g;
      prefSet.RangeRingsCentered = false;
    }
    pendingMapAction = null;
    dcb.exitPlaceMode();
    return;
  }
  // Aircraft hit-test
  const hit = pickAircraft(e.clientX, e.clientY);
  if (e.button === 1) {
    // Middle-click: toggle claimed status
    if (hit) {
      if (claimedTracks.has(hit.Guid)) {
        claimedTracks.delete(hit.Guid);
      } else {
        claimedTracks.add(hit.Guid);
      }
    }
  } else if (hit && window.previewSetClickedPlane) {
    window.previewSetClickedPlane(hit);
  }
});
function pickAircraft(px, py) {
  let best = null, bestD = Infinity;
  for (const t of tracks.values()) {
    if (!t.Location) continue;
    const p = geoToScreen(displayPos(t));
    const d = Math.hypot(p.x - px, p.y - py);
    if (d < bestD && d < 12) { best = t; bestD = d; }
  }
  return best;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Expose DCB / state for in-page debugging and headless test scripts.
window.handleNumAdjust  = handleNumAdjust;
window.handleBriteAdjust = handleBriteAdjust;
window.handleMapToggle  = handleMapToggle;
window.handleDcbClick   = handleDcbClick;
window.prefSet          = prefSet;
window.tracks           = tracks;
window.claimedTracks    = claimedTracks;
window.flightPlans      = flightPlans;
window.trackToFp        = trackToFp;
window.videoMaps        = videoMaps;
window.mapButtonAssignments = mapButtonAssignments;
window.ClockPhase       = ClockPhase;
// Exposed for the NEXRAD overlay (nexrad.js) which needs to project image
// corners from radar-centred lat/lon into the current scope view.
window.geoToScreen      = geoToScreen;
// Exposed so mca.js's KeyCode.WX path can route through the same DCB
// toggle the WX1-6 buttons use (RadarWindow.cs:3886).
window.handleWxToggle   = handleWxToggle;

// ── PORT-ONLY: URL state persistence ────────────────────────────────────
// DGScope has no equivalent (WPF takes its config from the .stars file +
// command-line args). In a browser we want deep links to work
// (bookmark / share a particular scope) AND want a reload to preserve
// the most-recently-set range / brightness etc. Format keeps params
// short:
//   ?p=PROFILE   profile name (already supported on load)
//   ?r=50        range
//   ?rr=5        range ring spacing
//   ?ll=2        leader length
//   ?ptl=1.0     ptl length
//   ?tcp=ABC     signed-on TCP
//   ?dstars=PCT  override dstars facility (already supported)
//   ?menu=MAIN   debug submenu (already supported)
//   ?b=DCB50,RR20,MPA75   brightness overrides (cat:val list, no spaces)
let _urlMapIds = null;   // map starsIds requested via ?maps=, applied once maps load
function applyUrlState() {
  const q = new URLSearchParams(location.search);
  const n = (k) => { const v = q.get(k); return v != null ? +v : null; };
  if (n("r")  != null) prefSet.Range = n("r");
  if (n("rr") != null) prefSet.RangeRingSpacing = n("rr");
  if (n("ll") != null) prefSet.LeaderLength = n("ll");
  if (n("ptl") != null) prefSet.PTLLength = n("ptl");
  const maps = q.get("maps");
  if (maps != null) _urlMapIds = maps === "" ? [] : maps.split(",").map(Number).filter(Number.isFinite);
  const b = q.get("b");
  if (b) {
    for (const part of b.split(",")) {
      const m = part.match(/^([A-Za-z]+)(\d+)$/);
      if (!m) continue;
      const cat = catKeyForUrl(m[1].toUpperCase());
      if (cat) prefSet.Brightness[cat] = clamp(+m[2], 0, 100);
    }
  }
}
function catKeyForUrl(short) {
  // Compact key → full Brightness category name
  return ({
    DCB: "DCB", BKC: "Background", BG: "Background",
    MPA: "VideoMapA", MPB: "VideoMapB",
    FDB: "DataBlock", LDB: "DataBlock", DB: "DataBlock",
    LST: "Lists", TLS: "Lists",
    POS: "Position", BCN: "Position", PRI: "Position",
    HST: "History", HIST: "History",
    RR: "RangeRings", CMP: "Compass", CM: "Compass",
    WX: "Weather", WXC: "Weather",
  })[short] || null;
}
function _internalPushUrlState() {
  const q = new URLSearchParams(location.search);
  const setOrDel = (k, val, defaultV) => {
    if (val == null || val === defaultV) q.delete(k);
    else q.set(k, String(val));
  };
  setOrDel("r",  prefSet.Range, 50);
  setOrDel("rr", prefSet.RangeRingSpacing, 5);
  setOrDel("ll", prefSet.LeaderLength, 1);
  setOrDel("ptl", prefSet.PTLLength, 1);
  // Brightness overrides: list only categories that differ from internal default
  const defaults = { DCB:50, Background:100, RangeRings:20, Compass:30,
    VideoMapA:75, VideoMapB:25, DataBlock:100, Lists:75, Position:100,
    History:60, Weather:70 };
  const shortFor = { Background:"BKC", VideoMapA:"MPA", VideoMapB:"MPB",
    RangeRings:"RR", Compass:"CMP", DataBlock:"FDB", Lists:"LST",
    Position:"POS", History:"HST", Weather:"WX", DCB:"DCB" };
  const parts = [];
  for (const [k, v] of Object.entries(prefSet.Brightness)) {
    if (v !== defaults[k] && shortFor[k]) parts.push(`${shortFor[k]}${v}`);
  }
  if (parts.length) q.set("b", parts.join(",")); else q.delete("b");
  // Visible video maps (persisted selection).
  const visMaps = videoMaps.filter(m => m.visible && m.starsId != null).map(m => m.starsId);
  if (visMaps.length) q.set("maps", visMaps.join(",")); else q.delete("maps");
  // Signed-on TCP (so a reload stays signed on at the same position).
  setOrDel("tcp", _signedOnTcp, null);
  const search = q.toString();
  const newUrl = location.pathname + (search ? "?" + search : "");
  history.replaceState(null, "", newUrl);
}
// Apply on load (after profile so URL params override profile)
applyUrlState();
// Push state when prefs change. Triggered from DCB handlers.
window.pushUrlState = _internalPushUrlState;
window.saveDCBVisibilityToSession = saveDCBVisibilityToSession;

bootstrap();
