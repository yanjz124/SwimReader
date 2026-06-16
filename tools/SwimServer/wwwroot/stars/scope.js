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
  HistoryNum: 5,
  HistoryRate: 4.5,
  LeaderLength: 1,
  Range: 50,
  AltitudeFilterAssociatedMax: 99900,
  AltitudeFilterAssociatedMin: -9900,
  AltitudeFilterUnAssociatedMax: 99900,
  AltitudeFilterUnAssociatedMin: -9900,
  LdbBeaconCodesInhibited: false,
  // PrefSet.cs:55-63 — every Brightness category defaults to 100. Profiles
  // override via applyProfile; URL `?b=...` further overrides per-category.
  Brightness: {
    DCB: 100, Background: 100, RangeRings: 20, Compass: 100,
    VideoMapA: 100, VideoMapB: 100, DataBlock: 100,
    Lists: 100, Position: 100, History: 100, Weather: 100,
    Tools: 100,
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
      // DGScope offsets labels inward by the label height (cs:4809) — gives a
      // clear gap between the tick and the number.
      const lh = 14;
      labelAt(`${i}`,         x1, h1 - lh);
      labelAt(`${i + 180}`,  -x1, -h1 + lh);
      if (line > 0) {
        labelAt(`${180 - i}`,  x1, -h1 + lh);
        labelAt(`${360 - i}`, -x1,  h1 - lh);
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
    videoMaps.push({
      id: m.id,
      name: m.name || "",
      shortName: m.shortName || "",
      starsId: m.starsId ?? null,
      category: (m.starsBrightnessCategory === "B") ? "B" : "A",
      // starsAlwaysVisible maps are airport diagrams / towers / runways — per the
      // CRC ref these are Top-Down-Mode-only elements, NOT always on. They render
      // only while TDM is engaged (Ctrl+T); see drawVideoMapLines + toggleTopDown.
      alwaysVisible: !!m.starsAlwaysVisible,
      visible: false,
      lines: null,        // lazy
      _loading: false,
    });
  }
  // ?maps= overrides which maps are visible (persisted selection).
  if (_urlMapIds) {
    for (const m of videoMaps) m.visible = m.starsId != null && _urlMapIds.includes(m.starsId);
    for (const m of videoMaps) if (m.visible && m.lines === null) ensureMapLoaded(m);
  }
  prefSet.DisplayedMaps = videoMaps.filter(m => m.visible && m.starsId != null).map(m => m.starsId);
  // Default DCB MAP1-6 bindings = first 6 catalog entries with a starsId.
  // Profile XML (when loaded) overrides this.
  if (mapButtonAssignments.length === 0) {
    mapButtonAssignments = videoMaps.filter(m => m.starsId != null).slice(0, 6).map(m => m.starsId);
  }
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
    const tdm = !!starsState.topDownMode;
    for (const m of videoMaps) {
      if (m.category !== cat) continue;
      // Always-visible maps are TDM-only (shown only in Top-Down mode); all
      // others follow their normal toggle state.
      if (!(m.alwaysVisible ? tdm : m.visible)) continue;
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

// DCB state — first 6 inline MAP buttons each bind to a specific video-map
// starsId. WPF: TCP.DCBMapList[i] = starsId (RadarWindow.cs:817-820). When
// a DGScope profile is loaded, this array is overwritten from
// TCP.DCBMapList; otherwise defaults to first 6 catalog entries' starsIds.
let mapButtonAssignments = [];  // populated by loadVideoMapsCatalog and overridden by profile
function dcbMapAt(i) {
  const starsId = mapButtonAssignments[i];
  if (starsId == null) return null;
  return videoMaps.find(m => m.starsId === starsId) || null;
}

// Apply a DGScope profile XML: prefSet overrides + DCBMapList + DisplayedMaps.
// Backend serializes with camelCase per ServerContext JsonSerializer settings.
async function applyProfile(profileName) {
  try {
    const p = await fetch(`/api/stars/profile/${encodeURIComponent(ARTCC)}/${encodeURIComponent(profileName)}`)
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
      if (b.Weather         != null) prefSet.Brightness.Weather    = b.Weather;
      if (b.WeatherContrast != null) prefSet.Brightness.Weather    = b.WeatherContrast;
      // DataBlock collapses 3 WPF categories — last-write-wins is fine
      // since they're usually equal in practice.
      if (b.FullDataBlocks    != null) prefSet.Brightness.DataBlock = b.FullDataBlocks;
      if (b.LimitedDataBlocks != null) prefSet.Brightness.DataBlock = b.LimitedDataBlocks;
      if (b.OtherFDBs         != null) prefSet.Brightness.DataBlock = b.OtherFDBs;
      // Position collapses 3 WPF categories.
      if (b.PositionSymbols != null) prefSet.Brightness.Position = b.PositionSymbols;
      if (b.BeaconTargets   != null) prefSet.Brightness.Position = b.BeaconTargets;
      if (b.PrimaryTargets  != null) prefSet.Brightness.Position = b.PrimaryTargets;
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
  if (isCoasting(t)) return t.Location;      // freeze at last known
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

// ── History (Phase 3b) ──────────────────────────────────────────────────────
// RadarWindow.cs:5512 — every HistoryRate seconds (default 4.5s), push the
// current position to history[0], shift older entries; cap at HistoryNum
// (default 10). Dots use the fixed 5-step HistoryColors palette indexed by age,
// oldest clamped to the last entry (RadarWindow.cs:235,5530-5533; HistoryFade
// default false → discrete steps, no continuous fade).
const HISTORY_COLORS = [
  [30, 80, 200], [70, 70, 170], [50, 50, 130], [40, 40, 110], [30, 30, 90],
];

function tickHistory(t, posNow) {
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
  if (!t._history || t._history.length === 0) return;
  const max = Math.min(t._history.length, prefSet.HistoryNum);
  for (let i = 0; i < max; i++) {
    const c = HISTORY_COLORS[Math.min(i, HISTORY_COLORS.length - 1)];
    ctx.fillStyle = adjusted(c, prefSet.Brightness.History);
    const p = geoToScreen(t._history[i]);
    if (p.x < -4 || p.x > view.W + 4 || p.y < -4 || p.y > view.H + 4) continue;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);   // filled circle, FMATargetSymbols.Radius=3 (cs:616,6141-6143)
    ctx.fill();
  }
}

// ── PTL (RadarWindow.cs:PTL.End1/End2) ──────────────────────────────────────
// Predicted Track Line: from current pos, project along GroundTrack for
// PrefSet.PTLLength minutes at GroundSpeed knots. Only drawn when:
//   - PTLAll is on (all tracks), OR
//   - PTLOwn is on AND this track's Owner matches us (Phase 8 will wire this),
//     OR per-track ShowPTL flag.
function drawPTL(t, posNow) {
  if (!posNow || t.GroundSpeed == null || t.GroundTrack == null) return;
  const enable = prefSet.PTLAll || t.ShowPTL ||
    (prefSet.PTLOwn && trackToFp.get(t.Guid)?.Owner === ownTcp());
  if (!enable) return;
  const distNM = (t.GroundSpeed * prefSet.PTLLength) / 60;
  const θ = t.GroundTrack * Math.PI / 180;
  const dLat = (distNM * Math.cos(θ)) / 60;
  const latFactor = Math.cos(posNow.Latitude * Math.PI / 180);
  const dLon = (distNM * Math.sin(θ)) / (60 * latFactor);
  const end = { Latitude: posNow.Latitude + dLat, Longitude: posNow.Longitude + dLon };
  const p1 = geoToScreen(posNow), p2 = geoToScreen(end);
  // WPF: PTL drawn in RBLColor (white) at Brightness.Tools (RadarWindow.cs:6293).
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
function setOwnTcp(v) { _signedOnTcp = v ? v.toUpperCase() : null; }
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

function buildDataBlock(t, fp) {
  const mode = dataBlockMode(t, fp);
  const lines = [];
  // ── Field formatters — Aircraft.RedrawDataBlock lines 328-440 ──────────
  const dbAlt = t.Altitude?.Value ?? null;
  const altstring = dbAlt != null && t.Altitude.AltitudeType !== 2  // 2 = Unknown
    ? String(Math.round((dbAlt + 50) / 100)).padStart(3, "0")
    : "RDR";
  const dbSpeed = t.GroundSpeed ?? 0;
  const speed10 = String(Math.floor(dbSpeed / 10)).padStart(2, "0");

  // vfrchar — FlightRules[0] when not 'I' (Aircraft.cs:355-365)
  let vfrChar = " ", catChar = " ";
  if (fp?.FlightRules && fp.FlightRules[0] !== "I") vfrChar = fp.FlightRules[0];
  if (t.Ident) { vfrChar = "I"; catChar = "D"; }
  else if (fp?.Category) catChar = fp.Category;

  const handoffChar = fp?.PendingHandoff ? fp.PendingHandoff.slice(-1) : " ";

  // destination — falls back to altstring when null/unassigned (Aircraft.cs:373-393)
  let destination = altstring;
  if (fp?.Destination?.trim() && fp.Destination.trim() !== "unassigned")
    destination = fp.Destination.trim().padEnd(3);

  // yscratch — scratchpad else destination (Aircraft.cs:395-404)
  const yscratch = (fp?.Scratchpad1?.trim() || destination).padEnd(3);
  // yscratch2 — scratchpad2 + "+" (4ch) else scratchpad else destination (:406-417)
  let yscratch2;
  if (fp?.Scratchpad2?.trim()) yscratch2 = (fp.Scratchpad2.trim() + "+").padEnd(4);
  else if (fp?.Scratchpad1?.trim()) yscratch2 = fp.Scratchpad1.trim().padEnd(3);
  else yscratch2 = destination;

  // type — AircraftType else speed10+vfr+cat (Aircraft.cs:419-430)
  const type = (fp?.AircraftType?.trim()) ? fp.AircraftType.trim().padEnd(4)
             : `${speed10}${vfrChar}${catChar}`;
  // reqalt — "R{flight level}" else type (Aircraft.cs:432-440)
  const reqalt = (fp?.RequestedAltitude > 0)
    ? "R" + String(Math.floor(fp.RequestedAltitude / 100)).padStart(3, "0")
    : type;

  // ── Build all 3 FDB variants ───────────────────────────────────────────
  // Per CRC docs § Data Blocks, line 2 rotates three variants:
  //   Variant 1: altitude + handoff + ground speed + flight rules + category
  //   Variant 2: scratchpad #1 + handoff + AIRCRAFT TYPE
  //   Variant 3: scratchpad #2 + handoff + REQUESTED ALTITUDE (R-prefix)
  // The WPF Aircraft.RedrawDataBlock has variants 2/3 swapped relative to
  // CRC docs (reqalt on variant 2, type on variant 3); we follow CRC for
  // clearer info display since each variant shows visibly different data
  // even when fields fall back. Identical-content collapse still respected
  // (yscratch2 length=4 collapse from Aircraft.cs:443-449).
  // Format (per CRC visual reference): "LLL H RR C" or "LLL H TTTT"
  // where LLL=3-char left, H=handoff or space, RR=2-char speed, C=1-char
  // wake/IFR cat. For aircraft type / requested altitude variants, the
  // right side is 4 chars (no extra space). All variants pad to 8 chars
  // so the data block doesn't visually resize as ClockPhase rotates.
  // FDB line-2 variants — exact WPF composition (Aircraft.cs:436-444):
  //   phase0: altstring + handoff + speed/10 + vfr + cat
  //   phase1: yscratch  + handoff + reqalt
  //   phase2: yscratch2 (+type, with the scratchpad2 "+" 4-char collapse)
  const speedField = `${speed10}${vfrChar}${catChar}`;
  const fdb1line2 = `${altstring}${handoffChar}${speedField} `;
  const fdb2line2 = `${yscratch}${handoffChar}${reqalt} `;
  let fdb3line2;
  if (!yscratch2 || !yscratch2.trim()) fdb3line2 = `${yscratch}${handoffChar}${type} `;
  else if (yscratch2.length === 4)     fdb3line2 = `${yscratch2}${type}`;       // scratchpad2 "+" form
  else                                  fdb3line2 = `${yscratch2}${handoffChar}${type} `;

  if (mode === "FDB") {
    // Line 1: callsign or squawk (Aircraft.cs:449-489)
    let line1 = "";
    if (fp?.Callsign) line1 = fp.Callsign;
    else if (t.Squawk) line1 = t.Squawk;
    lines.push(line1);
    // Line 2: pick variant by ClockPhase.
    const variants = [fdb1line2, fdb2line2, fdb3line2];
    lines.push(variants[ClockPhase.phase] || fdb1line2);
    // Line 3: AssignedSquawk mismatch OR ATPA mileage OR blank
    if (fp?.AssignedSquawk && t.Squawk && t.Squawk !== String(fp.AssignedSquawk).padStart(4, "0"))
      lines.push(`${t.Squawk} ${String(fp.AssignedSquawk).padStart(4, "0")}`);
    else lines.push(" ");
  } else if (mode === "PDB") {
    lines.push(fp?.Callsign || t.Callsign || t.Squawk || "");
    lines.push(`${altstring}${handoffChar}${vfrChar}${catChar}`);
  } else { // LDB — WPF Aircraft.cs:565-613 (always 3 lines)
    if (prefSet.LdbBeaconCodesInhibited) {
      // BCB inhibited: altitude on line 1, two blank lines (Aircraft.cs:571-573)
      lines.push(`${altstring}${handoffChar}${vfrChar}${catChar}`);
      lines.push("     ");
      lines.push("     ");
    } else {
      lines.push(t.Squawk || "");                                    // line 1 squawk
      lines.push(`${altstring}${handoffChar}${vfrChar}${catChar}`);  // line 2 altitude
      lines.push("     ");                                           // line 3 blank
    }
  }
  return lines;
}

// dataBlockMode — CRC docs § Data Blocks. Owned/quick-look tracks default
// to FDB; non-owned associated default to PDB; non-associated default to LDB.
// Phase 4 (DCB) and Phase 5 (commands) let the user toggle individual blocks.
function dataBlockMode(t, fp) {
  // WPF Aircraft.FDB (Aircraft.cs:119-136): FDB iff Owned, QuickLook,
  // ForceQuickLook, Emergency, or manually toggled — otherwise LDB. There is
  // no separate "PDB" mode.
  if (t._forcedMode) return t._forcedMode;                            // manual toggle
  if (t.Emergency || ["7500", "7600", "7700"].includes(t.Squawk)) return "FDB";
  if (!fp) return "LDB";                                              // unassociated
  if (fp.Owner && fp.Owner === ownTcp()) return "FDB";               // owned
  if (t._quickLook) return "FDB";                                    // quick-looked
  // Observer convenience (documented deviation): with no position signed on,
  // show full blocks for every associated track so the scope is readable.
  if (!ownTcp()) return "FDB";
  return "LDB";                                                       // non-owned associated → LDB
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
  // RedrawDataBlock priority: explicit override > LDRDirection (FP) > owner default.
  if (t._leaderOverride) return ldrEnum(t._leaderOverride);
  if (fp?.LDRDirection) return ldrEnum(fp.LDRDirection);
  if (fp?.Owner === ownTcp()) return ldrEnum(prefSet.OwnedDataBlockPosition);
  if (fp) return ldrEnum(prefSet.UnownedDataBlockPosition);
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
  const v = leaderDirToVector(dir);
  const lines = buildDataBlock(t, fp);
  if (lines.length === 0) return;

  const fontSize = prefSet.CharSize.DataBlock;
  ctx.font = `${fontSize}px FixedDemiBold, ui-monospace, "Cascadia Mono", monospace`;
  const charHeight = fontSize + 2;
  const charWidth  = fontSize * 0.55;

  // Leader-line model: target is the clock center, leader points in `dir` for
  // `LeaderLength + 0.5` char-heights, data block hangs off the leader's
  // endpoint. Cardinal directions => block centered perpendicular to leader.
  // Diagonals => block's near corner sits at leader end.
  // WPF (OffsetDatablockLocation): the block hangs (0.5+LeaderLength) char-heights
  // off the EDGE of the position symbol (PositionIndicator.BoundsF), so add the
  // symbol's half-size to the offset — gives the proper gap instead of a cramped one.
  const offsetPx = (0.5 + prefSet.LeaderLength) * charHeight;
  const symbolRadius = prefSet.CharSize.Position * 0.5;
  const screen = geoToScreen(posNow);
  const isDiag = (v.x !== 0 && v.y !== 0);
  const k = isDiag ? Math.SQRT1_2 : 1;
  const leaderEndX = screen.x + v.x * (symbolRadius + offsetPx) * k;
  const leaderEndY = screen.y + v.y * (symbolRadius + offsetPx) * k;

  const blockWidth = Math.max(...lines.map(l => l.length)) * charWidth;
  const blockHeight = lines.length * charHeight;

  // Block position derived from leader endpoint + direction vector:
  //   v.x < 0  -> block extends LEFT  (right edge at leaderEnd)
  //   v.x > 0  -> block extends RIGHT (left  edge at leaderEnd)
  //   v.x = 0  -> block CENTERED horizontally on leaderEnd
  //   v.y < 0  -> block extends UP    (bottom at leaderEnd)
  //   v.y > 0  -> block extends DOWN  (top    at leaderEnd)
  //   v.y = 0  -> block CENTERED vertically on leaderEnd
  let blockX, blockY;
  if (v.x < 0)      blockX = leaderEndX - blockWidth;
  else if (v.x > 0) blockX = leaderEndX;
  else              blockX = leaderEndX - blockWidth / 2;
  if (v.y < 0)      blockY = leaderEndY - blockHeight;
  else if (v.y > 0) blockY = leaderEndY;
  else              blockY = leaderEndY - blockHeight / 2;

  // Text alignment: pad-right when block extends left so text hugs the
  // right edge (closest to target); pad-left otherwise.
  const padLeft = (v.x < 0);

  // Data-block colour priority — RadarWindow.cs:5436-5468:
  //   Emergency→red > Marked→Selected(cyan) > ForceQuickLook→Pointout(yellow)
  //   > Owned||QuickLookPlus→Owned(white) > FDB/LDB→DataBlock(green).
  // An inbound handoff (PendingHandoff == my position) is treated as Owned and
  // FLASHES (DataBlock.Flashing, cs:1067-1070) — NOT a yellow tier.
  const inboundHandoff = fp?.PendingHandoff && fp.PendingHandoff === ownTcp();
  const owned = (fp?.Owner === ownTcp()) || inboundHandoff;
  let baseColor = COLORS.DataBlock;
  if (t._stca) {
    baseColor = (Date.now() % 1000 < 500) ? COLORS.Emerg : COLORS.Pointout;
  } else if (t.Emergency || t.Squawk === "7700" || t.Squawk === "7600" || t.Squawk === "7500") {
    baseColor = COLORS.Emerg;
  } else if (t._marked) {
    baseColor = COLORS.Selected;            // cyan
  } else if (fp?._pointoutTarget && (fp._pointoutTarget === ownTcp() || fp._pointoutTarget === "ANY")) {
    baseColor = COLORS.Pointout;            // ForceQuickLook → yellow
  } else if (owned) {
    baseColor = COLORS.Owned;               // white
  }
  // Inbound handoff flashes ~1 Hz — hide the block on the off phase (cs:1068).
  if (inboundHandoff && (Date.now() % 1000) >= 500) return;
  ctx.fillStyle = adjusted(baseColor, prefSet.Brightness.DataBlock);
  ctx.textBaseline = "top";
  ctx.textAlign = padLeft ? "right" : "left";
  // textX = side of the block closest to the target = block's leader-side edge.
  const textX = padLeft ? (blockX + blockWidth) : blockX;
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], textX, blockY + i * charHeight);
  }

  // Leader line — straight line from target edge to leader endpoint (where
  // the block hangs). The block's own bounding box already aligns to the
  // leader endpoint via the cases above; we don't need to compute a
  // separate "block edge" point.
  if (prefSet.LeaderLength > 0) {
    ctx.strokeStyle = ctx.fillStyle;
    ctx.lineWidth = 1;
    const leaderStartX = screen.x + v.x * k * symbolRadius;
    const leaderStartY = screen.y + v.y * k * symbolRadius;
    ctx.beginPath();
    ctx.moveTo(leaderStartX, leaderStartY);
    ctx.lineTo(leaderEndX, leaderEndY);
    ctx.stroke();
  }
}

// ── Position symbol render ──────────────────────────────────────────────────
// WPF (RadarWindow.cs:6018+ DrawTarget for RadarType.FUSED + Aircraft.cs:265
// TargetReturn + Aircraft.cs:286-291 PositionIndicator + Aircraft.cs:617-623
// PositionIndicator.Text):
//   1. Filled circle for beacon target (Return color, Brightness.PrimaryTargets)
//   2. PositionIndicator TransparentLabel with text:
//        - PositionInd.Substring(-1)  (last char of controller sector / Owner)
//        - else selectedSquawkChar    (when squawk is in selected list — TODO)
//        - else "◇" if PrimaryOnly
//        - else "*"
function positionSymbolText(t, fp) {
  // STARS position symbol (WPF Aircraft.cs:616-623): the controlling position's
  // sector char if owned/handed-off; ◇ for primary-only (no beacon); else "*".
  // STARS has NO ERAM-style coast "#" / "\" / "+" glyphs.
  const owner = fp?.Owner || t.PositionInd;
  if (owner && owner.length > 0) return owner.slice(-1);
  if (!t.Squawk || t.Squawk === "0000") return "◇";  // PrimaryOnly
  return "*";
}

function drawPosition(t, posNow) {
  const fp = trackToFp.get(t.Guid);
  // Position-symbol colour follows the data-block priority (RadarWindow.cs:5469,
  // 5580-5584): emergency red > marked cyan > owned/inbound-handoff white > green.
  const inbound = fp?.PendingHandoff && fp.PendingHandoff === ownTcp();
  let baseColor = COLORS.Return;
  if (t.Emergency || ["7500", "7600", "7700"].includes(t.Squawk)) baseColor = COLORS.Emerg;
  else if (t._marked) baseColor = COLORS.Selected;
  else if (fp?.Owner === ownTcp() || inbound) baseColor = COLORS.Owned;

  const p = geoToScreen(posNow);
  const px = p.x | 0, py = p.y | 0;

  // Primary return — filled circle, FMATargetSymbols.Radius=3 (cs:616,6141-6143).
  ctx.fillStyle = adjusted(baseColor, prefSet.Brightness.Position);
  ctx.beginPath();
  ctx.arc(px, py, 3, 0, Math.PI * 2);
  ctx.fill();

  // Position glyph colour follows the target's state: red on emergency, white
  // when owned, else the standard green beacon/track colour (not always lime).
  const glyphColor = (baseColor === COLORS.Return) ? COLORS.BeaconTarget : baseColor;
  ctx.fillStyle = adjusted(glyphColor, prefSet.Brightness.Position);
  ctx.font = `${prefSet.CharSize.Position}px FixedDemiBold, ui-monospace, monospace`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
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
    ctx.strokeStyle = adjusted(COLORS.TPA, prefSet.Brightness.DataBlock);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(center.x, center.y, px, 0, Math.PI * 2);
    ctx.stroke();
    // Radius label
    ctx.fillStyle = ctx.strokeStyle;
    ctx.font = "10px FixedDemiBold, ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.fillText(`J${t._jRing}`, center.x, center.y - px - 4);
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
      if (dnm < STCA.lateralNM && Math.abs(altA - altB) < STCA.verticalFt) {
        stcaPairs.add(a.Guid + "|" + b.Guid);
        a._stca = true; b._stca = true;
      }
    }
  }
  // Clear flag on tracks not in any pair
  for (const t of tracks.values()) {
    if (!stcaPairs.size) { t._stca = false; continue; }
    if (![...stcaPairs].some(k => k.includes(t.Guid))) t._stca = false;
  }
}
setInterval(scanSTCA, 1000);

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
  if (!minSepPair) return;
  const p1 = displayPos(minSepPair.p1);
  const p2 = displayPos(minSepPair.p2);
  if (!p1 || !p2) return;
  const s1 = geoToScreen(p1), s2 = geoToScreen(p2);
  ctx.strokeStyle = adjusted(COLORS.RBL, prefSet.Brightness.DataBlock);
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(s1.x, s1.y); ctx.lineTo(s2.x, s2.y);
  ctx.stroke();
  ctx.setLineDash([]);
  const mx = (s1.x + s2.x) / 2, my = (s1.y + s2.y) / 2;
  ctx.fillStyle = ctx.strokeStyle;
  ctx.font = "11px FixedDemiBold, ui-monospace, monospace";
  ctx.textAlign = "center";
  ctx.fillText(`${minSepPair.dist.toFixed(2)} NM`, mx, my - 6);
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

// ── Main per-track draw ─────────────────────────────────────────────────────
function drawTracks() {
  const now = Date.now();
  for (const t of tracks.values()) {
    if (!t.Location) continue;
    if (t.IsOnGround) continue;                       // Radar.cs Scan skips on-ground
    if (now - (t.lastMoveT ?? t.lastPosUpdate ?? t.lastUpdate) > LOST_TARGET_MS) continue; // lost target → hidden (LostTargetSeconds, by position movement)
    const fp = trackToFp.get(t.Guid);
    // Altitude filter — PrefSet AltitudeFilterAssociated{Min,Max} / UnAssociated.
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
    // Use the 1 Hz swept position (radarSweep), not a per-frame extrapolation.
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
    }
    // Phase 4: ASR sites for SITE submenu (vNAS starsConfiguration → areas → asrSites if present)
    starsState.asrSites = fac?.starsConfiguration?.areas?.flatMap(a => a.asrSites || []) || [];

    // Optional profile from URL ?profile=NAME — pulls DGScope profile XML
    // from %LOCALAPPDATA%/DGScope Profile Manager/profiles/profiles/{ARTCC}/.
    const profileName = (new URLSearchParams(location.search)).get("profile");
    if (profileName) await applyProfile(profileName);
  } catch (e) {
    console.error("[STARS] Failed to load facility:", e);
  }

  // Phase 4: mount the Display Control Bar.
  mountDcb();
  // Phase 5: mount MCA / preview area.
  if (window.mountMca) window.mountMca();
  // Phase 7: mount SSA / status area.
  if (window.mountSsa) window.mountSsa();
  // Phase 3a: DSTARS streaming connection. Runs independent of facility load.
  startDstars();

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
  topDownMode: false,   // Ctrl+T — shows TDM-only (starsAlwaysVisible) maps
};

// Top-Down Mode toggle (crc-eram-reference.md:1503 — Ctrl+T). Surfaces the
// TDM-only video maps (airport diagrams / towers / runways). Bridged from the
// keyboard handler in mca.js, which lives on window.starsState (a separate
// object), so expose a function rather than sharing the flag.
window.toggleTopDown = () => {
  starsState.topDownMode = !starsState.topDownMode;
  if (starsState.topDownMode)                       // warm the lazy line cache
    for (const m of videoMaps) if (m.alwaysVisible && m.lines === null) ensureMapLoaded(m);
  return starsState.topDownMode;
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
  dcb.on("briteAdjust", (which, d) => handleBriteAdjust(which, d));
  dcb.on("cszAdjust", (which, d) => handleCszAdjust(which, d));
  dcb.on("mapToggle", (idx) => handleMapToggle(idx));
  dcb.on("click", ({ id }) => handleDcbClick(id));
  dcb.render();
  // Re-render DCB on prefSet changes (cheap; only DOM in DCB region).
  setInterval(() => dcb.render(), 1000);
}

function _afterPrefChange() {
  if (window.pushUrlState) window.pushUrlState();
}
function handleNumAdjust(id, dir) {
  switch (id) {
    case "RANGE":
      // RadarWindow.cs:4193-4214 — increment ±1, clamp 6..512 (NOT a preset cycle).
      prefSet.Range = clamp(prefSet.Range + dir, 6, 512);
      recomputeScale();
      break;
    case "RR_NUM":
      // RadarWindow.cs:4638-4660 — cycle 2 ↔ 5 ↔ 10 ↔ 20 (floor 2, ceiling 20).
      switch (prefSet.RangeRingSpacing) {
        case 2:  if (dir > 0) prefSet.RangeRingSpacing = 5;  break;
        case 5:  prefSet.RangeRingSpacing = dir > 0 ? 10 : 2; break;
        case 10: prefSet.RangeRingSpacing = dir > 0 ? 20 : 5; break;
        case 20: if (dir < 0) prefSet.RangeRingSpacing = 10;  break;
        default: prefSet.RangeRingSpacing = 2;
      }
      break;
    case "LDR_LEN":
      // 0..8 clamp (RadarWindow.cs:4159)
      prefSet.LeaderLength = clamp(prefSet.LeaderLength + dir, 0, 8);
      break;
    case "LDR_DIR":
      // cycle through 1,2,3,4,6,7,8,9 (skip 5)
      const order = [1, 2, 3, 6, 9, 8, 7, 4];
      let i = order.indexOf(prefSet.OwnedDataBlockPosition);
      i = (i + (dir > 0 ? 1 : order.length - 1)) % order.length;
      prefSet.OwnedDataBlockPosition = order[i];
      break;
    case "HIST_NUM":
      prefSet.HistoryNum = clamp(prefSet.HistoryNum + dir, 0, 10);
      break;
    case "HIST_RATE":
      // RadarWindow.cs:4128-4140 — step ±0.5, clamp 0..4.5.
      prefSet.HistoryRate = clamp(prefSet.HistoryRate + dir * 0.5, 0, 4.5);
      break;
    case "PTL_LEN":
      // RadarWindow.cs:4174-4184 — step ±0.5, clamp 0..5.
      prefSet.PTLLength = clamp(prefSet.PTLLength + dir * 0.5, 0, 5);
      break;
    case "PTL_OWN":  prefSet.PTLOwn = !prefSet.PTLOwn; break;
    case "PTL_ALL":  prefSet.PTLAll = !prefSet.PTLAll; break;
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
  const map = {
    DCB: "DCB", BKC: "Background", MPA: "VideoMapA", MPB: "VideoMapB",
    FDB: "DataBlock", LST: "Lists", POS: "Position",
    LDB: "DataBlock", OTH: "DataBlock", TLS: "Lists",
    RR: "RangeRings", CMP: "Compass", BCN: "Position", PRI: "Position",
    HST: "History", WX: "Weather", WXC: "Weather",
  };
  const k = map[which];
  if (k) b[k] = clamp(b[k] + d, 0, 100);
  dcb.render();
  _afterPrefChange();
}

function handleMapToggle(idx) {
  const m = videoMaps[idx];
  if (!m) return;
  m.visible = !m.visible;
  if (m.visible && m.lines === null) ensureMapLoaded(m);
  if (window.pushUrlState) window.pushUrlState();   // persist map selection in URL
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
    return;
  }
  // Aircraft hit-test
  const hit = pickAircraft(e.clientX, e.clientY);
  if (hit && window.mcaSetClickedPlane) window.mcaSetClickedPlane(hit);
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
window.flightPlans      = flightPlans;
window.trackToFp        = trackToFp;
window.videoMaps        = videoMaps;
window.mapButtonAssignments = mapButtonAssignments;
window.ClockPhase       = ClockPhase;

// ── URL state persistence ───────────────────────────────────────────────────
// Encodes range, leader length, ptl length, range-ring spacing, brightness
// overrides, signed-on TCP, dstars facility, profile, menu (debug) into the
// URL so a refresh / bookmark preserves the scope state. Format keeps params
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
  const search = q.toString();
  const newUrl = location.pathname + (search ? "?" + search : "");
  history.replaceState(null, "", newUrl);
}
// Apply on load (after profile so URL params override profile)
applyUrlState();
// Push state when prefs change. Triggered from DCB handlers.
window.pushUrlState = _internalPushUrlState;

bootstrap();
