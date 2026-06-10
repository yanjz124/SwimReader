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
  Range: 50,
  AltitudeFilterAssociatedMax: 99900,
  AltitudeFilterAssociatedMin: -9900,
  AltitudeFilterUnAssociatedMax: 99900,
  AltitudeFilterUnAssociatedMin: -9900,
  LdbBeaconCodesInhibited: false,
  // Defaults match typical DGScope profile values rather than 100. Profiles
  // override these via applyProfile; URL `?b=...` further overrides per-category.
  Brightness: {
    DCB: 50, Background: 100, RangeRings: 20, Compass: 30,
    VideoMapA: 75, VideoMapB: 25, DataBlock: 100,
    Lists: 75, Position: 100, History: 60, Weather: 70,
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
      // Brightness keys (DCB/Background/MapA/MapB/...) - WPF uses different
      // category names than our PrefSet. Best-effort merge into our scheme.
      const b = p.prefSet.brightness || {};
      const brMap = {
        DCB: "DCB", Background: "Background", MapA: "VideoMapA", MapB: "VideoMapB",
        FullDataBlocks: "DataBlock", LimitedDataBlocks: "DataBlock",
        OtherFDBs: "DataBlock", Lists: "Lists",
        PositionSymbols: "Position", BeaconTargets: "Position",
        PrimaryTargets: "Position", History: "History",
        RangeRings: "RangeRings", Compass: "Compass",
        WeatherContrast: "Weather", Weather: "Weather", Tools: "Lists",
      };
      for (const [src, dst] of Object.entries(brMap)) {
        if (b[src] != null) prefSet.Brightness[dst] = b[src];
      }
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
  return (Date.now() - t.lastUpdate) > 24000;     // 2 × 12s scan
}

// ── Velocity extrapolation (RadarWindow.cs:displayPosition + Aircraft.ExtrapolatePosition)
// Between scans we project the target along GroundTrack at GroundSpeed knots
// from the last reported Location. Matches the WPF ExtrapolatePosition path
// approximated for the time-delta since lastUpdate.
function extrapolatedPosition(t) {
  if (!t.Location) return null;
  if (isCoasting(t)) return t.Location;      // freeze at last known
  if (t.GroundSpeed == null || t.GroundTrack == null) return t.Location;
  const ageS = (Date.now() - t.lastUpdate) / 1000;
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
// (default 10). Each history dot uses HistoryColors[i] palette index.
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
    const palette = HISTORY_COLORS[Math.min(i, HISTORY_COLORS.length - 1)];
    ctx.fillStyle = adjusted(palette, prefSet.Brightness.History);
    const p = geoToScreen(t._history[i]);
    if (p.x < -4 || p.x > view.W + 4 || p.y < -4 || p.y > view.H + 4) continue;
    ctx.fillRect(p.x - 2.5, p.y - 2.5, 5, 5);
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
  ctx.strokeStyle = adjusted(COLORS.DataBlock, prefSet.Brightness.DataBlock);
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
// Default sequence ONE_TWO_ONE_THREE: phase goes 0(2.0s)→1(1.5s)→0(2.0s)→2(1.5s).
// Interval defaults pulled from ClockPhase.cs:18-23.
const ClockPhase = {
  phase: 0, _step: 0,
  intervals: [2.0, 1.5, 2.0, 1.5],
  // sequence values match ClockPhase.cs Sequence.ONE_TWO_ONE_THREE handlers
  _phases: [0, 1, 0, 2],
  _timer: null,
  start() {
    if (this._timer) return;
    const advance = () => {
      this._step = (this._step + 1) % 4;
      this.phase = this._phases[this._step];
      clearTimeout(this._timer);
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

  // ── Build all 3 FDB variants (Aircraft.cs:442-450) ──────────────────────
  const fdb1line2 = `${altstring}${handoffChar}${speed10}${vfrChar}${catChar} `;
  const fdb2line2 = `${yscratch}${handoffChar}${reqalt} `;
  let fdb3line2;
  if (!fp?.Scratchpad2?.trim()) fdb3line2 = `${yscratch}${handoffChar}${type} `;
  else if (yscratch2.length === 4) fdb3line2 = `${yscratch2}${type}`;
  else fdb3line2 = `${yscratch2}${handoffChar}${type} `;

  if (mode === "FDB") {
    // Line 1: callsign or squawk (Aircraft.cs:449-489)
    let line1 = "";
    if (fp?.Callsign) line1 = fp.Callsign;
    else if (t.Squawk) line1 = t.Squawk;
    lines.push(line1);
    // Line 2: pick variant by ClockPhase. When the chosen variant is
    // all-whitespace (no scratchpad / no AircraftType / no RequestedAlt),
    // fall back to fdb1line2 (alt+speed) so the second line is never empty.
    const variants = [fdb1line2, fdb2line2, fdb3line2];
    const chosen = variants[ClockPhase.phase];
    lines.push(chosen.trim().length > 0 ? chosen : fdb1line2);
    // Line 3: AssignedSquawk mismatch OR ATPA mileage OR blank
    if (fp?.AssignedSquawk && t.Squawk && t.Squawk !== String(fp.AssignedSquawk).padStart(4, "0"))
      lines.push(`${t.Squawk} ${String(fp.AssignedSquawk).padStart(4, "0")}`);
    else lines.push(" ");
  } else if (mode === "PDB") {
    lines.push(fp?.Callsign || t.Callsign || t.Squawk || "");
    lines.push(`${altstring}${handoffChar}${vfrChar}${catChar}`);
  } else { // LDB (Aircraft.cs:559+)
    if (!prefSet.LdbBeaconCodesInhibited) lines.push(t.Squawk || "");
    lines.push(`${altstring}${handoffChar}${vfrChar}${catChar}`);
  }
  return lines;
}

// dataBlockMode — CRC docs § Data Blocks. Owned/quick-look tracks default
// to FDB; non-owned associated default to PDB; non-associated default to LDB.
// Phase 4 (DCB) and Phase 5 (commands) let the user toggle individual blocks.
function dataBlockMode(t, fp) {
  if (t._forcedMode) return t._forcedMode;
  if (!fp) return "LDB";
  if (fp.Owner && fp.Owner === ownTcp()) return "FDB";
  return prefSet.LdbBeaconCodesInhibited ? "LDB" : "PDB";
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
  if (t._leaderOverride) return t._leaderOverride;
  if (fp?.LDRDirection) return fp.LDRDirection;
  if (fp?.Owner === ownTcp()) return ldrEnum(prefSet.OwnedDataBlockPosition);
  if (fp) return ldrEnum(prefSet.UnownedDataBlockPosition);
  return ldrEnum(prefSet.UnassociatedDataBlockPosition);
}
function ldrEnum(v) {
  // PrefSet stores LeaderDirection as ints 1-9 (per STARS/LeaderDirection.cs);
  // 0/undefined → N (2).
  return typeof v === "number" && v >= 1 ? v : 2;
}

function drawDataBlockAndLeader(t, fp, posNow) {
  const dir = effectiveLeaderDir(t, fp);
  const v = leaderDirToVector(dir);
  const lines = buildDataBlock(t, fp);
  if (lines.length === 0) return;

  const fontSize = 14;
  ctx.font = `${fontSize}px FixedDemiBold, ui-monospace, "Cascadia Mono", monospace`;
  const charHeight = fontSize + 2;
  const charWidth  = fontSize * 0.55;

  // Leader-line model: target is the clock center, leader points in `dir` for
  // `LeaderLength + 0.5` char-heights, data block hangs off the leader's
  // endpoint. Cardinal directions => block centered perpendicular to leader.
  // Diagonals => block's near corner sits at leader end.
  const offsetPx = (0.5 + prefSet.LeaderLength) * charHeight;
  const screen = geoToScreen(posNow);
  const isDiag = (v.x !== 0 && v.y !== 0);
  const k = isDiag ? Math.SQRT1_2 : 1;
  const leaderEndX = screen.x + v.x * offsetPx * k;
  const leaderEndY = screen.y + v.y * offsetPx * k;

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

  // Block color — STCA > Pointout > Emergency > Owned > DataBlock.
  // RadarWindow.cs:80 — PointoutColor = Yellow.
  let baseColor = COLORS.DataBlock;
  if (t._stca) {
    // Phase 9: STCA pair → flash red (1 Hz)
    baseColor = (Date.now() % 1000 < 500) ? COLORS.Emerg : COLORS.Pointout;
  } else if (t.Emergency || t.Squawk === "7700" || t.Squawk === "7600" || t.Squawk === "7500") {
    baseColor = COLORS.Emerg;
  } else if (fp?._pointoutTarget && (fp._pointoutTarget === ownTcp() || fp._pointoutTarget === "ANY")) {
    baseColor = COLORS.Pointout;            // Phase 8: PO directed at us
  } else if (fp?.PendingHandoff === ownTcp()) {
    baseColor = COLORS.Pointout;            // pending handoff TO us = yellow attention
  } else if (fp?.Owner === ownTcp()) {
    baseColor = COLORS.Owned;
  }
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
    const tgtRadius = 5;
    const leaderStartX = screen.x + v.x * k * tgtRadius;
    const leaderStartY = screen.y + v.y * k * tgtRadius;
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
  const owner = fp?.Owner || t.PositionInd;
  if (owner && owner.length > 0) return owner.slice(-1);
  if (!t.Squawk || t.Squawk === "0000") return "◇";    // PrimaryOnly
  return "*";
}

function drawPosition(t, posNow) {
  const fp = trackToFp.get(t.Guid);
  // Color hierarchy per RadarWindow.cs:5435+ / line 5512.
  let baseColor = COLORS.Return;
  if (t.Emergency || ["7500", "7600", "7700"].includes(t.Squawk)) baseColor = COLORS.Emerg;
  else if (fp?.Owner === ownTcp()) baseColor = COLORS.Owned;

  const p = geoToScreen(posNow);
  const px = p.x | 0, py = p.y | 0;

  // PrimaryReturn / TargetReturn filled circle.
  ctx.fillStyle = adjusted(baseColor, prefSet.Brightness.Position);
  ctx.beginPath();
  ctx.arc(px, py, 4, 0, Math.PI * 2);
  ctx.fill();

  if (!isCoasting(t)) {
    ctx.fillStyle = adjusted(COLORS.BeaconTarget, prefSet.Brightness.Position);
    ctx.font = "15px FixedDemiBold, ui-monospace, monospace";
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.fillText(positionSymbolText(t, fp), px, py);
  } else {
    // Coast = #-shape stroked lines, bigger.
    ctx.strokeStyle = adjusted(COLORS.BeaconTarget, prefSet.Brightness.Position);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px - 5, py - 1.5); ctx.lineTo(px + 5, py - 1.5);
    ctx.moveTo(px - 5, py + 1.5); ctx.lineTo(px + 5, py + 1.5);
    ctx.moveTo(px - 1.5, py - 5); ctx.lineTo(px - 1.5, py + 5);
    ctx.moveTo(px + 1.5, py - 5); ctx.lineTo(px + 1.5, py + 5);
    ctx.stroke();
  }
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
    const pos = extrapolatedPosition(t);
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
  const p1 = extrapolatedPosition(minSepPair.p1);
  const p2 = extrapolatedPosition(minSepPair.p2);
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
  for (const t of tracks.values()) {
    if (!t.Location) continue;
    if (t.IsOnGround) continue;       // Radar.cs Scan skips on-ground
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
    const posNow = extrapolatedPosition(t);
    if (!posNow) continue;
    const sp = geoToScreen(posNow);
    if (sp.x < -50 || sp.x > view.W + 50 || sp.y < -50 || sp.y > view.H + 50) {
      tickHistory(t, posNow);   // still tick offscreen so trail re-appears
      continue;
    }

    tickHistory(t, posNow);
    drawHistory(t);
    drawPTL(t, posNow);
    drawPosition(t, posNow);
    if (!isCoasting(t)) drawDataBlockAndLeader(t, fp, posNow);
  }
}

// ── Main render loop ────────────────────────────────────────────────────────
function frame() {
  clear();
  drawVideoMapLines();
  drawRangeRings();
  drawCompass();
  drawJRings();
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
    // vNAS schema: TRACONs often have location: null. Try in this order:
    //   1. fac.location
    //   2. fac.visibilityCenters[0]  (ARTCC-level, exposed by backend as fallback)
    //   3. fac.starsConfiguration.areas[0].asrSites[0].location
    let loc = null;
    if (fac && fac.location) loc = fac.location;
    else if (fac && Array.isArray(fac.visibilityCenters) && fac.visibilityCenters[0])
      loc = fac.visibilityCenters[0];
    else {
      const sc = fac && fac.starsConfiguration;
      const a0 = sc && sc.areas && sc.areas[0];
      const asr0 = a0 && Array.isArray(a0.asrSites) && a0.asrSites[0];
      if (asr0 && asr0.location) loc = asr0.location;
    }
    if (loc) {
      prefSet.ScreenCenterPoint = { Latitude: loc.lat, Longitude: loc.lon };
      prefSet.RangeRingLocation = { Latitude: loc.lat, Longitude: loc.lon };
      starsState.facilityLocation = { Latitude: loc.lat, Longitude: loc.lon };
    } else {
      console.warn("[STARS] No location available; centering on 0,0.");
    }
    // Default range from area config if present.
    const sc2 = fac && fac.starsConfiguration;
    if (sc2 && sc2.areas && sc2.areas[0] && sc2.areas[0].defaultRange) {
      prefSet.Range = sc2.areas[0].defaultRange;
    }
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
  requestAnimationFrame(frame);
}

// Phase 4: DCB state container exposed to dcb.js.
const starsState = {
  prefSet,
  videoMaps,
  asrSites: [],
  wxLevels: [false, false, false, false, false, false],
  dcbMapAt,
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
      // RadarWindow.cs:4636+ — cycles through standard preset ranges 5..400
      prefSet.Range = clamp(prefSet.Range + dir, 1, 400);
      recomputeScale();
      break;
    case "RR_NUM":
      // RadarWindow.cs:4636-4650 — cycles 2 → 5 → 10 → 2
      switch (prefSet.RangeRingSpacing) {
        case 5:  prefSet.RangeRingSpacing = dir > 0 ? 10 : 2; break;
        case 10: prefSet.RangeRingSpacing = dir > 0 ? 2 : 5;  break;
        case 2:  prefSet.RangeRingSpacing = dir > 0 ? 5 : 10; break;
        default: prefSet.RangeRingSpacing = 5;
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
      prefSet.HistoryRate = clamp(prefSet.HistoryRate + dir * 0.5, 0.5, 10);
      break;
    case "PTL_LEN":
      prefSet.PTLLength = clamp(prefSet.PTLLength + dir, 0, 10);
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
}

function handleDcbClick(id) {
  switch (id) {
    case "MAPS_CLEAR":
      videoMaps.forEach(m => m.visible = false);
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
    const p = geoToScreen(extrapolatedPosition(t) || t.Location);
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
function applyUrlState() {
  const q = new URLSearchParams(location.search);
  const n = (k) => { const v = q.get(k); return v != null ? +v : null; };
  if (n("r")  != null) prefSet.Range = n("r");
  if (n("rr") != null) prefSet.RangeRingSpacing = n("rr");
  if (n("ll") != null) prefSet.LeaderLength = n("ll");
  if (n("ptl") != null) prefSet.PTLLength = n("ptl");
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
  const search = q.toString();
  const newUrl = location.pathname + (search ? "?" + search : "");
  history.replaceState(null, "", newUrl);
}
// Apply on load (after profile so URL params override profile)
applyUrlState();
// Push state when prefs change. Triggered from DCB handlers.
window.pushUrlState = _internalPushUrlState;

bootstrap();
