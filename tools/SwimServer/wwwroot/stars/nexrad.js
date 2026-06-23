// ─────────────────────────────────────────────────────────────────────────
// STARS NEXRAD overlay — direct line-by-line port of DGScope.
//
// Reference (every line below cites a source file):
//   .stars-reference/scope/NexradDisplay.cs:60-95     GetRadarData
//   .stars-reference/scope/NexradDisplay.cs:125-193   RecomputeVertices
//   .stars-reference/scope/NexradDisplay.cs:127-138   Default ColorTable
//   .stars-reference/NexradDecoder/WXColorTable.cs    Stipple bitmaps
//
// Pipeline:
//   1. Pick nearest NEXRAD station (.cs equiv: NexradDisplay.SensorID).
//   2. Backend decodes the tgftp NIDS file and returns radials JSON
//      (server-side mirror of GetRadarData; see NexradStarsRoutes.cs).
//   3. We mirror RecomputeVertices polygon loop on canvas — one polygon
//      per radial × bin where dBZ > 0, using WXColor.MinColor +
//      stipple per the active level mask.
//
// No HSV, no pixel guessing — we get true dBZ from the decoder.
// ─────────────────────────────────────────────────────────────────────────

(function () {
  // Default ColorTable (NexradDisplay.cs:127-138). The profile may override
  // via PrefSet but we use the documented defaults until profile carries
  // the WXColor list (current vNAS feed does not).
  //   new WXColor(20, Color.FromArgb(38, 77, 77))
  //   new WXColor(30, Color.FromArgb(38, 77, 77), White, LIGHT)
  //   new WXColor(40, Color.FromArgb(38, 77, 77), White, DENSE)
  //   new WXColor(45, Color.FromArgb(100, 100, 51))
  //   new WXColor(50, Color.FromArgb(100, 100, 51), White, LIGHT)
  //   new WXColor(55, Color.FromArgb(100, 100, 51), White, DENSE)
  // Defaults from NexradDisplay.cs:127-138; profile.js overwrites the full
  // array when the loaded XML carries <Nexrad><ColorTable> entries.
  let WX_COLORS = [
    { minValue: 20, color: [ 38,  77,  77], stipple: "none"  },
    { minValue: 30, color: [ 38,  77,  77], stipple: "light" },
    { minValue: 40, color: [ 38,  77,  77], stipple: "dense" },
    { minValue: 45, color: [100, 100,  51], stipple: "none"  },
    { minValue: 50, color: [100, 100,  51], stipple: "light" },
    { minValue: 55, color: [100, 100,  51], stipple: "dense" },
  ];
  function setColorTable(table) {
    if (Array.isArray(table) && table.length > 0) WX_COLORS = table;
  }

  // WXColorTable.GetWXColor (WXColorTable.cs:15-38): walk highest→lowest,
  // return the highest WXColor whose MinValue is exceeded AND whose level
  // is enabled. Returns null when below the lowest threshold or all
  // levels for that value are disabled.
  function pickColor(dBZ, enabledMask) {
    if (dBZ <= WX_COLORS[0].minValue) return null;
    for (let i = WX_COLORS.length - 1; i >= 0; i--) {
      if (dBZ > WX_COLORS[i].minValue) {
        if ((enabledMask >> i) & 1) return WX_COLORS[i];
        // Level disabled — continue to lower threshold.
      }
    }
    return null;
  }

  function ensureNexradPrefs() {
    if (!window.prefSet) return false;
    prefSet.Nexrad = prefSet.Nexrad || {};
    if (prefSet.Nexrad.enabled    === undefined) prefSet.Nexrad.enabled    = false;
    if (prefSet.Nexrad.levels     === undefined) prefSet.Nexrad.levels     = 0x3F;   // all 6 on by default
    if (prefSet.Nexrad.brightness === undefined) prefSet.Nexrad.brightness = 80;
    return true;
  }

  const FETCH_INTERVAL_MS = 4 * 60 * 1000;   // matches NWS publish cadence
  let _refreshTimer = null;
  let _station = null;      // { icao, lat, lon, name, state }
  let _product = "p94r0";   // base reflectivity (NexradDisplay.URL default)
  let _radials = null;      // decoded radials payload from /api/stars/nexrad/radials

  async function pickStation() {
    if (!window.prefSet?.ScreenCenterPoint) return null;
    const ctr = prefSet.ScreenCenterPoint;
    if (!Number.isFinite(ctr.Latitude) || !Number.isFinite(ctr.Longitude)) return null;
    if (Math.abs(ctr.Latitude) < 0.01 && Math.abs(ctr.Longitude) < 0.01) return null;
    try {
      const r = await fetch(`/api/stars/nexrad/nearest?lat=${ctr.Latitude}&lon=${ctr.Longitude}`);
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }

  async function fetchRadials() {
    if (!_station) return false;
    try {
      const url = `/api/stars/nexrad/radials/${_station.icao}/${_product}`;
      const r = await fetch(url);
      if (!r.ok) { console.warn("[STARS NEXRAD] radials fetch", r.status); return false; }
      _radials = await r.json();
      return true;
    } catch (e) {
      console.warn("[STARS NEXRAD] radials fetch failed:", e);
      return false;
    }
  }

  // GeoPoint.FromPoint equivalent — bearing in degrees true, distance NM.
  // Mirrors GeoPoint.FromPoint(distance, bearing) used by NexradDisplay
  // (cs:173-176). Simple equirectangular over short ranges.
  function offsetGeo(lat, lon, distanceNm, bearingDeg) {
    const θ      = bearingDeg * Math.PI / 180;
    const dN     = distanceNm * Math.cos(θ);
    const dE     = distanceNm * Math.sin(θ);
    const latOut = lat + dN / 60;
    const cosLat = Math.cos(lat * Math.PI / 180);
    const lonOut = lon + dE / (60 * cosLat);
    return { Latitude: latOut, Longitude: lonOut };
  }

  // 8×8 stipple patterns approximating WXColorTable.cs:83-120 (LIGHT ≈ 2
  // dots / cell, DENSE ≈ 6 dots / cell). Built once per ctx.
  let _patternCtx = null, _patterns = null;
  function getPatterns(ctx) {
    if (_patterns && _patternCtx === ctx) return _patterns;
    const make = (dots) => {
      const c = document.createElement("canvas");
      c.width = 8; c.height = 8;
      const cx = c.getContext("2d");
      cx.fillStyle = "rgba(255,255,255,0.9)";
      for (const [x, y] of dots) cx.fillRect(x, y, 1, 1);
      return ctx.createPattern(c, "repeat");
    };
    _patterns = {
      light: make([[1, 1], [5, 5]]),
      dense: make([[1, 1], [5, 1], [3, 3], [1, 5], [5, 5], [3, 7]]),
    };
    _patternCtx = ctx;
    return _patterns;
  }

  // Port of NexradDisplay.RecomputeVertices NWSNexrad branch (cs:150-192).
  // Original generates Polygon[] with 4 GeoPoints each and feeds them to
  // an OpenGL draw. We translate each polygon directly to a canvas path
  // and fill with WXColor.MinColor, then overlay stipple via source-atop.
  function draw(ctx) {
    if (!_radials || !prefSet?.Nexrad?.enabled) return;
    if (!window.geoToScreen) return;
    const enabledMask = prefSet.Nexrad.levels | 0;
    if (!enabledMask) return;

    const radarLat   = _radials.radarLat;
    const radarLon   = _radials.radarLon;
    const resolution = _radials.resolution;        // NM per bin (cs:165)
    const brightness = Math.max(0, Math.min(100, prefSet.Nexrad.brightness ?? 80)) / 100;
    const patterns   = getPatterns(ctx);

    // First pass: fill MinColor polygons grouped by colour string so we
    // can batch path operations per colour. Stipple in second pass.
    // Map colour -> Path2D + stipple kind for that colour.
    const buckets = new Map();   // key: "r,g,b|stipple" → { path, color, stipple }
    for (let i = 0; i < _radials.numRadials; i++) {
      const r = _radials.radials[i];
      const a0 = r.startAngle;
      const a1 = r.startAngle + r.angleDelta;
      const sinA0 = Math.sin(a0 * Math.PI / 180), cosA0 = Math.cos(a0 * Math.PI / 180);
      const sinA1 = Math.sin(a1 * Math.PI / 180), cosA1 = Math.cos(a1 * Math.PI / 180);
      // Walk only non-zero bins (server stripped zeros).
      for (let k = 0; k < r.bins.length; k++) {
        const j     = r.bins[k];
        const value = r.values[k];
        const wx    = pickColor(value, enabledMask);
        if (wx === null) continue;
        // 4 corners of the bin wedge — cs:173-176 GeoPoint.FromPoint:
        //   (resolution*j,     startAngle)
        //   (resolution*j,     startAngle + angleDelta)
        //   (resolution*(j+1), startAngle + angleDelta)
        //   (resolution*(j+1), startAngle)
        const r0 = resolution * j;
        const r1 = resolution * (j + 1);
        // Inline offsetGeo for speed (hot path: ~hundreds of bins/radial).
        const cosLat = Math.cos(radarLat * Math.PI / 180);
        const p00 = geoToScreen({ Latitude: radarLat + (r0 * cosA0) / 60, Longitude: radarLon + (r0 * sinA0) / (60 * cosLat) });
        const p01 = geoToScreen({ Latitude: radarLat + (r0 * cosA1) / 60, Longitude: radarLon + (r0 * sinA1) / (60 * cosLat) });
        const p11 = geoToScreen({ Latitude: radarLat + (r1 * cosA1) / 60, Longitude: radarLon + (r1 * sinA1) / (60 * cosLat) });
        const p10 = geoToScreen({ Latitude: radarLat + (r1 * cosA0) / 60, Longitude: radarLon + (r1 * sinA0) / (60 * cosLat) });
        // Cull polygons entirely off-screen (cheap bbox).
        const minX = Math.min(p00.x, p01.x, p10.x, p11.x);
        const maxX = Math.max(p00.x, p01.x, p10.x, p11.x);
        const minY = Math.min(p00.y, p01.y, p10.y, p11.y);
        const maxY = Math.max(p00.y, p01.y, p10.y, p11.y);
        if (maxX < 0 || minX > ctx.canvas.width)  continue;
        if (maxY < 0 || minY > ctx.canvas.height) continue;

        const key = `${wx.color[0]},${wx.color[1]},${wx.color[2]}|${wx.stipple}`;
        let b = buckets.get(key);
        if (!b) {
          b = { path: new Path2D(), color: wx.color, stipple: wx.stipple };
          buckets.set(key, b);
        }
        b.path.moveTo(p00.x, p00.y);
        b.path.lineTo(p01.x, p01.y);
        b.path.lineTo(p11.x, p11.y);
        b.path.lineTo(p10.x, p10.y);
        b.path.closePath();
      }
    }

    ctx.save();
    ctx.globalAlpha = brightness;
    // Pass 1 — solid MinColor fills.
    for (const b of buckets.values()) {
      ctx.fillStyle = `rgb(${b.color[0]},${b.color[1]},${b.color[2]})`;
      ctx.fill(b.path);
    }
    // Pass 2 — stipple OVER the existing fill (source-atop = only inside).
    ctx.globalCompositeOperation = "source-atop";
    for (const b of buckets.values()) {
      if (b.stipple === "none") continue;
      ctx.fillStyle = patterns[b.stipple];
      ctx.fill(b.path);
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.restore();
  }

  async function init() {
    ensureNexradPrefs();
    // Wait for facility load to populate ScreenCenterPoint.
    for (let i = 0; i < 30; i++) {
      _station = await pickStation();
      if (_station) break;
      await new Promise(r => setTimeout(r, 2000));
    }
    if (!_station) {
      console.warn("[STARS NEXRAD] no station found near scope centre after 60s");
      return;
    }
    console.log(`[STARS NEXRAD] using ${_station.icao} ${_station.name}, ${_station.state}`);
    await fetchRadials();
    if (_refreshTimer) clearInterval(_refreshTimer);
    _refreshTimer = setInterval(fetchRadials, FETCH_INTERVAL_MS);
  }

  window.Nexrad = {
    init,
    fetchRadials,
    setProduct(p) { _product = p; fetchRadials(); },
    getStation()  { return _station; },
    draw,
    enable(v) {
      if (!ensureNexradPrefs()) return;
      prefSet.Nexrad.enabled = !!v;
      if (v && !_radials) {
        if (!_station) init();
        else fetchRadials();
      }
    },
    toggleLevel(n) {
      if (!ensureNexradPrefs()) return;
      prefSet.Nexrad.levels ^= (1 << (n - 1));
    },
    setColorTable,
  };
})();
