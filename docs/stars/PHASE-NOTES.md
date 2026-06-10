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

---

## Phase 3a — DSTARS stream + position symbols

Sliced Phase 3 into two commits per the user's "commit per phase, allow
backtrack" instruction. Phase 3a brings the live track stream up and renders
position-only symbols. Phase 3b adds the data block rendering.

### WPF / SwimReader sources

| File | What we took |
|------|--------------|
| `DGScope.Receivers.ScopeServer/JsonUpdate.cs` (full) | The full update-shape, esp. UpdateType (0=Track, 1=Flightplan, 2=Deletion, 3=Weather). |
| `DGScope.Receivers.ScopeServer/Track.cs` (lines 1-80, ~330 more in repo) | Partial-update semantics: each update only carries the changed fields; absent fields preserved. |
| `DGScope.Receivers.ScopeServer/FlightPlan.cs` (lines 1-50) | FlightPlan fields, especially `AssociatedTrackGuid` linking it to a Track. |
| `DGScope.Receivers.ScopeServer/ScopeServerClient.cs` (the receive loop concept) | We don't port the protobuf or auth; we just use the JSON HTTP-streaming route SwimReader.Server already provides. |
| `src/SwimReader.Server/Adapters/DstarsTrackUpdate.cs` + `DstarsFlightPlanUpdate.cs` | The actual JSON shape we receive on the wire (these are authoritative — the WPF file matches them). |
| `src/SwimReader.Server/Controllers/DstarsController.cs` | The endpoint we hit (`GET /dstars/{facility}/updates`) — already proxied through SwimServer's DgScopeRoutes. |

### Resolutions

1. **HTTP-stream not WebSocket.** SwimReader.Server exposes both, but only
   HTTP-stream is currently proxied via SwimServer's DgScopeRoutes. We
   read newline-delimited JSON via fetch + ReadableStream. Identical data;
   different transport. No behavioral difference; documented as design
   choice not deviation.

2. **DSTARS facility code vs vNAS facility ID.** They're usually the same
   3- or 4-letter code (ILM, K90, PCT, ZDC). When they differ the user
   appends `?dstars=XXX` to the scope URL. Default = vNAS facility ID.

3. **Position symbols.** Per CRC docs § Track types + WPF:
   - `◇` associated (track has a flight plan)
   - `\` correlated beacon (squawk, no FP)
   - `/` uncorrelated beacon (squawk, no FP, out of area) — Phase 3a
     doesn't yet distinguish from `\` (needs sector ownership data; Phase 8)
   - `+` uncorrelated primary (no squawk)
   - `#` coast track (no position update for >24s = 2 scan cycles)
   The `•` (bullet) form for FL230 and below is ERAM, NOT STARS — STARS
   keeps the diamond throughout.

4. **Coast detection.** Time-based fallback: 24s since `lastUpdate`. Phase
   3b adds the proper Radar.cs SweptTimes tracking that mirrors WPF.

5. **Altitude filter.** Honored exactly from PrefSet defaults
   (Associated/UnAssociated × Min/Max). Range checks before draw.

### What's intentionally NOT in Phase 3a

- Data blocks (LDB/PDB/FDB) → Phase 3b
- Leader lines → Phase 3b
- History dots → Phase 3b
- PTL (predicted track line) → Phase 3b
- Velocity-based extrapolation → Phase 3b (currently target sits at last
  reported Location)
- Position symbol drawn as `/` vs `\` based on sector ownership →
  Phase 8 (needs Owner/PositionInd state)
- ATPA cones → Phase 9

### Self-test checklist

- Pick a facility whose DSTARS feed is active.
- Topbar shows `T n/m LIVE` where n = tracks, m = flight plans.
- Position symbols render at correct lat/lon, on top of video maps,
  underneath compass.
- Coast (`#`) appears after a feed gap.
- Altitude filter (changing in browser console: `prefSet.AltitudeFilterAssociatedMax = 18000`)
  hides high-altitude tracks instantly.

---

## Phase 3b — Data blocks, leader lines, history, PTL, extrapolation

### WPF sources ported

| WPF section | What we took |
|-------------|--------------|
| `scope/Aircraft.cs:302-560` (`RedrawDataBlock`) | Data block content build: altstring/handoffChar/vfrChar/catChar logic, padLeft vs padRight choice based on leader direction, line-1 = callsign, line-2 = `altstring + handoff + speed/10 + vfr + cat` (the `fdb1line2` variant — most commonly displayed). |
| `scope/RadarWindow.cs:4014` | `dataBlockOffset = (0.5 + LeaderLength) × charHeight × pixelScale`. We use canvas pixel space directly; `charHeight = fontSize + 2`. |
| `scope/RadarWindow.cs:5800-5890` (`OffsetDatablockLocation`, leader line placement) | Leader start = target edge in the direction of the data block; leader end = data block edge facing target. |
| `scope/RadarWindow.cs:5512-5555` (history population) | History pushed every `HistoryRate` seconds, capped at `HistoryNum`, colored by `HistoryColors[i]` palette. |
| `scope/Aircraft.cs:ExtrapolatePosition` (called from `displayPosition`) | Between-update velocity extrapolation: forward from `Location` along `GroundTrack` at `GroundSpeed` for `(now - lastUpdate)` seconds. Skipped during coast (frozen at last reported). |
| `scope/STARS/LeaderDirection.cs` | Enum values 1-9 (NW/N/NE/W/E/SW/S/SE/Invalid=0); we use the same ints in `effectiveLeaderDir`. |
| CRC docs § Data Blocks (LDB/PDB/FDB) | When to use which mode: owned/quick-look → FDB; non-owned associated → PDB; non-associated → LDB. |

### Resolutions for ambiguous points

1. **Single-mode vs 3-line timeshare.** WPF maintains three TransparentLabels
   (`DataBlock`, `DataBlock2`, `DataBlock3`) and rotates which gets drawn on
   a `timeshareinterval = 1500ms` cycle (`scope/RadarWindow.cs:768`). Phase
   3b renders **one canonical variant** (fdb1line2: altitude + handoff +
   speed/10 + flight-rule + category). The 3-variant cycle adds scratchpad
   and requested-altitude variants; logged as a polish item (see
   KNOWN-DEVIATIONS G12 below).
2. **Leader start point.** WPF uses `PositionIndicator.BoundsF` (the
   rendered glyph box). We approximate with a 5-pixel radius from target
   center in the leader direction. Pixel-exact match would require
   measuring each rendered glyph's bounding box; deferred.
3. **History dot shape.** WPF uses `PrimaryReturn.Shape` (configurable
   shape + width/height). Default is a small square. We render 3×3 px
   squares. Identical visual when shape = Square (default).
4. **PTL gating.** Per CRC docs, PTL draws when `PTLAll` global is on, or
   `PTLOwn` is on and the track is owned by us, or per-track `ShowPTL`
   toggle (set by `T` command in Phase 5). `ownTcp()` returns null until
   Phase 8; until then `PTLOwn + PTLAll == false` means no PTL — same
   behavior as a freshly-started DGScope with no sign-on.
5. **Data block color.** Hierarchy: Emergency (7500/7600/7700) →
   Owned (white) → Default (lime). Pointout (yellow) deferred to Phase 8.

### Deviation added

- **G12 — 3-line FDB timeshare not yet rotating.** The WPF program shows
  three data block variants in sequence (1.5 s each: altitude+speed,
  scratchpad+reqalt, scratchpad2+type). Phase 3b shows variant 1 only.
  Documented; planned for a polish commit before Phase 4.

### Self-test checklist

- Tracks show data block alongside symbol, positioned per leader direction.
- Leader line connects target to data block.
- History dots trail behind moving aircraft, fading through 5 palette colors.
- PTL appears when you set `prefSet.PTLAll = true` in console.
- Coast (`#` symbol): no data block, no leader, position frozen.
- Pan/zoom: data blocks track with the target (no orphaning).
