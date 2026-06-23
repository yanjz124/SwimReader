// ─────────────────────────────────────────────────────────────────────────
// STARS NEXRAD overlay — fetches the local NWS single-radar image and
// projects it onto the scope canvas with a palette-versatile level remap.
//
// Pipeline:
//   1. Pick nearest NEXRAD station to the facility centre via
//      /api/stars/nexrad/nearest?lat=…&lon=…  (cached once per scope load).
//   2. Fetch the GIF via /api/stars/nexrad/image/{kxxx}/{prod}; the server
//      proxies + caches so canvas can decode without CORS getting in the way.
//   3. Pull the raw RGBA pixels via an offscreen canvas. Each non-transparent
//      pixel is mapped to a WX intensity level 1-6 by HSV — this keeps us
//      indifferent to whether NWS is serving the old 16-colour palette or the
//      newer enhanced one. Magenta → 6, red → 5, orange → 4, yellow → 3,
//      green → 2, dark green → 1.
//   4. Six per-level off-screen canvases hold the masked level images;
//      enabled levels are drawn into the scope context with the STARS WX
//      colour for that level.
//
// Refresh: 4 minutes (matches NWS publish cadence). Level enable bitmask
// + brightness/contrast pulled from prefSet so the DCB BRITE WX + WX
// buttons can drive the overlay without this module knowing the toolbar.
// ─────────────────────────────────────────────────────────────────────────

(function () {
  // DGScope STARS WX palette — DEFAULT ColorTable from NexradDisplay.cs:127-138
  // (the ColorTable a profile can override; defaults are the reference).
  //   Level 1 (dBZ ≥20): teal  rgb(38,77,77)  no stipple
  //   Level 2 (dBZ ≥30): teal  rgb(38,77,77)  LIGHT white stipple
  //   Level 3 (dBZ ≥40): teal  rgb(38,77,77)  DENSE white stipple
  //   Level 4 (dBZ ≥45): olive rgb(100,100,51) no stipple
  //   Level 5 (dBZ ≥50): olive rgb(100,100,51) LIGHT white stipple
  //   Level 6 (dBZ ≥55): olive rgb(100,100,51) DENSE white stipple
  // Stipple = an 8×8 white dot pattern overlaid on the base fill.
  // WXColorTable.cs:83-120 ships two patterns (LIGHT/DENSE); we
  // approximate with regular dot grids of different spacings.
  const WX_LEVELS = [
    null,
    { color: [ 38,  77,  77], stipple: "none"  },  // 1
    { color: [ 38,  77,  77], stipple: "light" },  // 2
    { color: [ 38,  77,  77], stipple: "dense" },  // 3
    { color: [100, 100,  51], stipple: "none"  },  // 4
    { color: [100, 100,  51], stipple: "light" },  // 5
    { color: [100, 100,  51], stipple: "dense" },  // 6
  ];

  const FETCH_INTERVAL_MS = 4 * 60 * 1000;   // NWS pushes every ~4-10 min
  let _refreshTimer = null;
  let _station = null;       // { icao, lat, lon, name, state }
  let _product = "p94r0";    // base reflectivity by default
  let _levelCanvases = null; // [null, canvas1, …, canvas6] in image space
  let _imgSize = 600;        // NWS sn.last is 600×600 default
  let _imgPxPerNm = 600 / (2 * 248);  // 600 px across 2×248nm
  let _imageLoaded = false;
  let _lastEtag = null;      // cheap "did the bytes change" tag (length+head)

  // prefSet.Nexrad defaults — set LAZILY because nexrad.js loads BEFORE
  // scope.js (per scope.html script order) so window.prefSet isn't defined
  // when this module first runs. Call from any public entry point that
  // touches the namespace.
  function ensureNexradPrefs() {
    if (!window.prefSet) return false;
    prefSet.Nexrad = prefSet.Nexrad || {};
    if (prefSet.Nexrad.enabled === undefined) prefSet.Nexrad.enabled = false;
    if (prefSet.Nexrad.levels  === undefined) prefSet.Nexrad.levels  = 0;        // start all off — DCB WX1-6 toggles light them
    if (prefSet.Nexrad.brightness === undefined) prefSet.Nexrad.brightness = 80;
    if (prefSet.Nexrad.contrast   === undefined) prefSet.Nexrad.contrast   = 50;
    return true;
  }

  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    let h = 0, s = mx === 0 ? 0 : (mx - mn) / mx, v = mx;
    if (mx !== mn) {
      const d = mx - mn;
      switch (mx) {
        case r: h = ((g - b) / d) % 6; break;
        case g: h = (b - r) / d + 2; break;
        default: h = (r - g) / d + 4; break;
      }
      h *= 60; if (h < 0) h += 360;
    }
    return [h, s, v];
  }

  /** Pixel colour → WX level 1-6 (or 0 = transparent/no precip). Versatile
   *  across the old 16-colour NWS palette and the newer enhanced one.
   */
  function pixelToLevel(r, g, b, a) {
    if (a < 32) return 0;                       // transparent → none
    const [h, s, v] = rgbToHsv(r, g, b);
    if (v < 0.2) return 0;                       // very dark → background
    if (s < 0.25) return 0;                      // greyscale → land/text
    // Magenta / pink (270-340°) — extreme
    if (h >= 270 && h <= 340) return 6;
    // Red (340-15°) — extreme
    if (h >= 340 || h < 15)  return 5;
    // Orange (15-45°) — heavy
    if (h < 45)              return 4;
    // Yellow (45-75°) — heavy
    if (h < 75)              return 3;
    // Bright green (75-150°) — moderate
    if (h < 150 && v > 0.55) return 2;
    // Dark green (75-180°) — light
    if (h < 180)             return 1;
    // Cyan/blue (>180°) — typically reserved for very weak echoes; skip.
    return 0;
  }

  async function pickStation() {
    if (!window.prefSet?.ScreenCenterPoint) return null;
    const ctr = prefSet.ScreenCenterPoint;
    // ScreenCenterPoint defaults to {0,0} (mid-Atlantic) until vNAS facility
    // load populates it. Bail until we have a real centre so the nearest
    // station isn't a random WSR somewhere near the equator.
    if (!Number.isFinite(ctr.Latitude) || !Number.isFinite(ctr.Longitude)) return null;
    if (Math.abs(ctr.Latitude) < 0.01 && Math.abs(ctr.Longitude) < 0.01) return null;
    try {
      const r = await fetch(`/api/stars/nexrad/nearest?lat=${ctr.Latitude}&lon=${ctr.Longitude}`);
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }

  async function fetchImage() {
    if (!_station) return false;
    try {
      const url = `/api/stars/nexrad/image/${_station.icao}/${_product}?_=${Date.now()}`;
      const resp = await fetch(url);
      if (!resp.ok) return false;
      const blob = await resp.blob();
      const etag = `${blob.size}-${resp.headers.get("last-modified") || ""}`;
      if (etag === _lastEtag) return false;
      _lastEtag = etag;
      const bmp = await createImageBitmap(blob);
      _imgSize = Math.max(bmp.width, bmp.height);
      _imgPxPerNm = bmp.width / (2 * 248);
      // Decode into a working canvas to read pixels.
      const work = document.createElement("canvas");
      work.width = bmp.width; work.height = bmp.height;
      const wctx = work.getContext("2d", { willReadFrequently: true });
      wctx.drawImage(bmp, 0, 0);
      const img = wctx.getImageData(0, 0, bmp.width, bmp.height);
      // 6 off-screen canvases, one per level. Each stores the mask
      // (alpha) for that level; we tint them at draw time with the
      // current WX colour + brightness so colour changes don't require
      // re-decoding the image.
      _levelCanvases = [null, ...Array.from({ length: 6 }, () => {
        const c = document.createElement("canvas");
        c.width = bmp.width; c.height = bmp.height;
        return c;
      })];
      const levelData = _levelCanvases.slice(1).map(c => c.getContext("2d").createImageData(bmp.width, bmp.height));
      for (let i = 0; i < img.data.length; i += 4) {
        const lvl = pixelToLevel(img.data[i], img.data[i+1], img.data[i+2], img.data[i+3]);
        if (lvl < 1) continue;
        const ld = levelData[lvl - 1];
        ld.data[i]   = 255;
        ld.data[i+1] = 255;
        ld.data[i+2] = 255;
        ld.data[i+3] = 255;
      }
      for (let l = 0; l < 6; l++) _levelCanvases[l + 1].getContext("2d").putImageData(levelData[l], 0, 0);
      _imageLoaded = true;
      return true;
    } catch (e) {
      console.warn("[STARS NEXRAD] image fetch failed:", e);
      return false;
    }
  }

  // Draw current image into the active scope context. Called from the
  // render loop in scope.js — see drawNexrad below.
  function draw(ctx) {
    if (!_imageLoaded || !_station || !prefSet?.Nexrad?.enabled) return;
    if (!window.geoToScreen) return;

    // Map the image's geographic footprint to screen coords. The NWS
    // p94r0 image is 600×600 px covering a 248nm-radius circle centred
    // on the radar. Use the radar centre + km/px to compute the bounding
    // box on the map.
    const radar = { Latitude: _station.lat, Longitude: _station.lon };
    const halfNm = (_imgSize / 2) / _imgPxPerNm;
    const cosLat = Math.cos(_station.lat * Math.PI / 180);
    const nw = { Latitude: _station.lat + halfNm / 60, Longitude: _station.lon - halfNm / (60 * cosLat) };
    const se = { Latitude: _station.lat - halfNm / 60, Longitude: _station.lon + halfNm / (60 * cosLat) };
    const pNW = window.geoToScreen(nw);
    const pSE = window.geoToScreen(se);
    const dx = pNW.x, dy = pNW.y;
    const dw = pSE.x - pNW.x, dh = pSE.y - pNW.y;
    if (dw <= 0 || dh <= 0) return;
    if (dx + dw < 0 || dy + dh < 0) return;

    // Composite per DGScope (NexradDisplay.cs:166-191): fill each polygon
    // with WXColor.MinColor; if the level has a stipple, overlay the
    // stipple pattern in WXColor.StippleColor. Web port mirrors that —
    // mask + base-fill, then mask + stipple-fill, per enabled level.
    const enabledMask = prefSet.Nexrad.levels;
    const brightness  = Math.max(0, Math.min(100, prefSet.Nexrad.brightness ?? 80)) / 100;
    const patterns    = stipplePatterns(ctx);
    ctx.save();
    for (let l = 1; l <= 6; l++) {
      if (((enabledMask >> (l - 1)) & 1) === 0) continue;
      const lvl = WX_LEVELS[l];
      const [r, g, b] = lvl.color;
      ctx.globalAlpha = brightness;
      // 1) Mask + MinColor fill.
      ctx.globalCompositeOperation = "source-over";
      ctx.drawImage(_levelCanvases[l], dx, dy, dw, dh);
      ctx.globalCompositeOperation = "source-in";
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(dx, dy, dw, dh);
      // 2) Stipple — only inside the area we just painted.
      if (lvl.stipple !== "none") {
        ctx.globalCompositeOperation = "source-atop";
        ctx.fillStyle = patterns[lvl.stipple];
        ctx.fillRect(dx, dy, dw, dh);
      }
      ctx.globalCompositeOperation = "source-over";
    }
    ctx.restore();
  }

  // Stipple patterns — DGScope WXColorTable.cs:83-120 ships two 8×8 bitmaps
  // ("LIGHT" ≈ 2 dots / 8², "DENSE" ≈ 6 dots / 8²). We build CanvasPatterns
  // once (per ctx) and reuse them every frame.
  let _patternsCtx = null, _patterns = null;
  function stipplePatterns(ctx) {
    if (_patterns && _patternsCtx === ctx) return _patterns;
    const make = (cells) => {
      const c = document.createElement("canvas");
      c.width = 8; c.height = 8;
      const cx = c.getContext("2d");
      cx.fillStyle = "rgba(255,255,255,0.9)";
      for (const [x, y] of cells) cx.fillRect(x, y, 1, 1);
      return ctx.createPattern(c, "repeat");
    };
    _patterns = {
      light: make([[1,1], [5,5]]),
      dense: make([[1,1], [5,1], [3,3], [1,5], [5,5], [3,7]]),
    };
    _patternsCtx = ctx;
    return _patterns;
  }

  async function init() {
    ensureNexradPrefs();
    // Retry station pick every 2s until ScreenCenterPoint is populated by the
    // vNAS facility load. Without this guard, init() once at module load
    // would silently fail before the scope knows where it is and the user
    // would later toggle WX# buttons with nothing to draw.
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
    await fetchImage();
    if (_refreshTimer) clearInterval(_refreshTimer);
    _refreshTimer = setInterval(fetchImage, FETCH_INTERVAL_MS);
  }

  // Public surface:
  window.Nexrad = {
    init,
    fetchImage,
    setProduct(p) { _product = p; _lastEtag = null; fetchImage(); },
    getStation()  { return _station; },
    draw,
    enable(v) {
      if (!ensureNexradPrefs()) return;
      prefSet.Nexrad.enabled = !!v;
      // First enable triggers fetch + station pick if we haven't yet.
      if (v && !_imageLoaded) {
        if (!_station) init();
        else fetchImage();
      }
    },
    toggleLevel(n) {
      if (!ensureNexradPrefs()) return;
      prefSet.Nexrad.levels ^= (1 << (n - 1));
    },
  };
})();
