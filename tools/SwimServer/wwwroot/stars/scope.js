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

// ── Main render loop ────────────────────────────────────────────────────────
function frame() {
  clear();
  drawRangeRings();
  drawCompass();
  updateTopbar();
  requestAnimationFrame(frame);
}

function updateTopbar() {
  const c = prefSet.ScreenCenterPoint;
  const r = prefSet.RangeRingLocation;
  document.getElementById("rangeLbl").textContent  = `RNG ${prefSet.Range}`;
  document.getElementById("ringLbl").textContent   = `RR ${prefSet.RangeRingSpacing}${prefSet.RangeRingsCentered ? " (CTR)" : ""}`;
  document.getElementById("centerLbl").textContent = `CTR ${c.Latitude.toFixed(4)}/${c.Longitude.toFixed(4)}`;
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
  } catch (e) {
    console.error("[STARS] Failed to load facility:", e);
  }
  requestAnimationFrame(frame);
}
bootstrap();
