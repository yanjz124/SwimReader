# Per-Phase Implementation Notes

One section per phase. Each section records: which WPF files it ports, which
classes/methods it mirrors, and any design call where the WPF source was
ambiguous and the resolution we picked.

The point is that someone (future-Claude, future-you) can come back six months
later and answer "where did this behavior come from?" by reading this file.

---

## Phase 1 — Foundation + chrome

### WPF sources ported

| WPF file | What we took from it |
|----------|----------------------|
| `scope/Radar.cs` (full, ~232 lines) | `Radar` class shape, `LatitudeOfTarget`/`LongitudeOfTarget` haversine math, `Scan` cadence (UpdateRate=1Hz default), `RadarType` enum, FUSED default. |
| `scope/STARS/PrefSet.cs` (full, ~180 lines) | The `PrefSet` shape: every field, every default value (Range=6, RangeRingSpacing=5, LeaderLength=1, HistoryNum=10, HistoryRate=4.5, AltitudeFilters, BrightnessSettings, etc.). |
| `scope/RadarWindow.cs` lines 60-250 (color + show flags), 720, 4732-4820 (`DrawCompass`), 5054-5078 (`DrawRangeRings`), 980-985 (`GL.ClearColor` with brightness adjustment), 782 (`AdjustedColor` formula). | Background `Color.Black`, range ring color `RGB(140,140,140)`, compass color identical, `AdjustedColor(c, brightness)` is `(c.R * brightness/100, …)`. `DrawRangeRings` formula `radius_nm / 60 / cos(lat)` in degrees latitude, drawn at `RangeRingCenter` (= `HomeLocation` when `RangeRingsCentered` is true, else `PrefSet.RangeRingLocation`). |
| `scope/MapImporter/CRC/CRCARTCC.cs` | The full vNAS `CRCARTCC` schema (facility tree, STARS configuration shape) — we hit the same JSON via `https://data-api.vnas.vatsim.net/api/artccs/{id}/`. |
| `scope/MapImporter/CRC/CRCMapImporter.cs` | Facility selection logic: if one facility has a STARS configuration with video maps we auto-pick it; otherwise we present a picker (CRC behavior). |

### Resolutions for ambiguous points

1. **Range-ring max radius.** WPF uses `Range * 1.414 * aspect_ratio + distance`
   (line 5063) to draw enough rings to fill the diagonal. Mirrored exactly.

2. **Compass rectangle outline.** WPF draws a `(w,h)` rectangle, then 5°-spaced
   tick marks ranging from 0° to 90° (`for i = 0; i < atan; i += 5` for the
   top/bottom edges, then `for ; i <= 90` for the side edges). Labels every
   10°. Mirrored exactly.

3. **DCB occupied area shrinks compass.** WPF shifts and shrinks the compass
   rectangle by `dcb.Size/2 * pixelScale` based on `dcb.Location`. Mirrored:
   the compass bounding box in the web port responds to the DCB box the
   same way (even though Phase 1 has no DCB yet — the layout is reserved).

4. **`pixelScale`.** WPF defines `pixelScale = scale / sizeRatio` where
   `scale = range / screenHalfDim`. Our `pixelScale` is identical so all
   font/tick sizes scale identically with zoom.

5. **vNAS facility loader UX.** WPF's `CRCFacilityPicker` is a WinForms
   modal listbox. The web version is a `<select>` modal styled identical
   (monospace, black/lime). Functionally identical: user picks ID, we load
   that facility's STARS configuration.

### Backend additions

- `tools/SwimServer/StarsBridge.cs` — holds in-memory vNAS profile cache
  (ARTCC list + per-ARTCC facilities). No Solace connection; this is a
  pure HTTP fetcher with daily refresh.
- `tools/SwimServer/Routes/StarsRoutes.cs` — REST endpoints:
  - `GET /api/stars/artccs` — list all ARTCC IDs.
  - `GET /api/stars/artcc/{id}` — facility tree for one ARTCC.
  - `GET /api/stars/facility/{artccId}/{facilityId}` — single facility's
    STARS configuration extracted for client convenience.
  - `GET /stars` — root page.
  - `GET /stars/{artcc}/{facility}` — scope page for one facility.

### Frontend additions

- `wwwroot/stars/index.html` — facility-picker landing page.
- `wwwroot/stars/scope.html` — the scope window itself.
- `wwwroot/stars/scope.css` — colors and layout.
- `wwwroot/stars/scope.js` — render loop, pan/zoom, compass, range rings,
  PrefSet defaults, vNAS profile loader.

### What's intentionally NOT in Phase 1

- DSTARS connection (Phase 3 starts target rendering)
- Video maps (Phase 2)
- DCB (Phase 4) — but layout reserves space for it
- Commands / MCA (Phase 5)
- Lists, SSA (Phases 6-7)
- Everything else through Phase 11

### Self-test checklist

After commit:
- Visit `/stars` → see ARTCC list.
- Pick an ARTCC → see facility list (only those with STARS configurations).
- Pick a facility → scope opens, background black, compass rectangle + 36
  tick marks visible, range rings centered on facility location at the
  PrefSet default spacing of 5nm.
- Mouse wheel zooms (changes `Range`); middle-drag pans (moves
  `ScreenCenterPoint`); right-click sets RangeRingLocation (mirrors WPF
  `e.Position` → `ScreenToGeoPoint` at line 1317).

---

## Phase 2 — Video maps

### WPF sources ported

| WPF file | What we took |
|----------|--------------|
| `scope/VideoMap.cs` (full) | `VideoMap` model: Number, Name, Mnemonic, Visible, Category (A/B), Lines. `MapCategory` enum (A, B). |
| `scope/Line.cs` (full) | `Line` model — pair of `GeoPoint`s. |
| `scope/MapGeoJSON.cs` (recursion shape, lines ~578-700 — `GeometryToLines`, `LineStringToLines`, `PolygonToLines`, `LinearRingToLines`, `MultiLineStringToLines`, `MultiPolygonToLines`) | The dispatch logic for turning GeoJSON geometry into a flat `Line[]`. Each polygon ring becomes connected line segments; the final closure relies on GeoJSON's "first == last" ring convention, same as WPF. |
| `scope/RadarWindow.cs` line 5302-5332 (`DrawVideoMapLines`) | Two-pass render: category A then B. Each pass collects visible-and-displayed maps, builds a single Lines list, draws with `AdjustedColor(VideoMapColor, Brightness.MapA-or-B)`. Pre/post: `BlendEquation(Max)` then restore to `FuncAdd`. |
| `scope/MapImporter/CRC/CRCMapImporter.cs` lines 19-30 | The export-tree path layout: `<basedir>/VideoMaps/{artccId}/{mapId}.geojson`. We mirror exactly under `tools/SwimServer/crc-export/{artccId}/VideoMaps/`. |

### Resolutions for ambiguous points

1. **GeoJSON content source.** vNAS has no public endpoint for map content
   (only catalog). We default to reading from a CRC export tree on disk —
   the same source DGScope reads. See G10 in KNOWN-DEVIATIONS. Optional
   `POST /api/stars/upload-export` accepts a ZIP for non-disk users.

2. **`starsAlwaysVisible` → initial `Visible` state.** vNAS marks some maps
   as always-visible (towers, runways). On load we set those `Visible =
   true` and seed `PrefSet.DisplayedMaps` from the matching `starsId`s.
   This mirrors the WPF startup that reads `PrefSet.DisplayedMaps` and
   sets each VideoMap.Visible accordingly (RadarWindow.cs line 710).

3. **Max-blend on canvas2d.** Canvas2D has no max-blend mode; we use
   `globalCompositeOperation = "lighter"` (additive). See G11. Pixel-exact
   match requires WebGL2; deferred to Phase 11.

4. **Off-screen culling.** Both endpoints off-screen on the same side →
   skip the line. WPF doesn't cull (relies on GPU clipping); we cull on
   CPU because we're 2D. Visually identical.

### Backend additions

- `StarsBridge.cs` — `_crcExportRoot`, `GetVideoMapGeoJsonAsync`,
  `ListAvailableVideoMapIds`.
- `Routes/StarsRoutes.cs`:
  - `GET /api/stars/videoMap/{artccId}/{mapId}` — serves the GeoJSON.
  - `GET /api/stars/videoMaps/{artccId}` — lists what's available on disk.
  - `POST /api/stars/upload-export` — accepts CRC export ZIP, extracts.

### Frontend additions (scope.js)

- `videoMaps` runtime list, populated from vNAS catalog metadata.
- `geoJsonToLines` — recursive GeoJSON decoder mirroring the WPF dispatch.
- `ensureMapLoaded` — lazy fetch on first visible.
- `drawVideoMapLines` — two-pass A/B render with brightness × color.
- Temp side-panel (`#mapPanel`) listing every map with a visibility
  checkbox. Goes away in Phase 4 when DCB MAP buttons exist (G9-style).

### What's intentionally NOT in Phase 2

- DCB MAP/MAP TOGGLES submenus (Phase 4)
- FAA DAT importer (not used by vNAS — included in WPF but only for
  legacy/FAA STARS exports, not CRC profiles). If user needs it later we
  port `scope/FAAMapDATFileParser.cs`.

### Self-test checklist

- With `crc-export/{ARTCC}/VideoMaps/` empty: facility loads, maps panel
  shows all known map names from vNAS, but toggling any results in no
  lines drawn (HTTP 404 — `map_not_in_crc_export`). Expected behavior.
- Drop one map ID's `.geojson` into the export tree, toggle it on, see
  lines render in correct color and respond to pan/zoom.
- Toggle multiple overlapping maps, observe additive brightening on
  overlap (G11 documented).
