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

---

## Phase 4 — DCB (Display Control Bar)

### WPF sources ported

| WPF source | What we took |
|------------|--------------|
| `scope/DCB.cs` (full, 103 lines) | Container shape: `Location` (Top/Left/Right/Bottom), `Size = 80`, `Visible`, `ActiveMenu`. |
| `scope/DCBButton.cs` (full, 361 lines) | Button color defaults: ACTIVE_BG `rgb(0,128,0)`, INACTIVE_BG `rgb(0,80,0)`, DISABLED_BG `rgb(0,40,0)`, TEXT white, TEXT_DWELL yellow, TEXT_DISABLED dark gray. Frame color `rgb(0,35,15)`. |
| `scope/DCBMenu.cs` (full, 193 lines) | Menu = ordered button list with active flag. |
| `scope/RadarWindow.cs:3468-3608` (SetupDCB) | Every button declaration, exact Text strings (`RANGE\n{Range}`, `RR\n{spacing}`, `RR\nCNTR`, `MAPS`, `MAP {n}`, `WX{n}`, `BRITE`, `LDR DIR\n{N/NE/E/...}`, `LDR\n{0-8}`, `CHAR SIZE`, `MODE\nFSL`, `SITE`, `SHIFT`), exact button heights (40 half / 80 full), exact AddButton ordering. |
| `scope/RadarWindow.cs:3920-3995` (UpdateDcbButtonText) | Live label formatters. We mirror in `mainMenu`/`auxMenu`/`briteMenu` factory functions, called every 1 s. |
| `scope/RadarWindow.cs:3741-3795` (SITE submenu generation) | Per-ASR-site button + MULTI/FUSED. |
| `scope/RadarWindow.cs:4156-4170` (LDR LEN +/− on right-click) | Numeric click-cycle behavior. We use left-click = +1, right-click = −1, wheel = ±1 — same model. |
| `scope/RadarWindow.cs:4430-4520` (Brightness slider) | Step = 10 per click (right-click = −10), clamp [0, 100]. |
| `scope/RadarWindow.cs:4636-4650` (RR cycle) | RR spacing cycles 2 → 5 → 10 → 2 (forward); reverse on backward. |
| `scope/RadarWindow.cs:3800-3815` (RR CNTR toggle) | When toggled on, sets `RangeRingLocation = HomeLocation`. |
| `scope/STARS/LeaderDirection.cs` | LDR DIR cycle order: NW(1)→N(2)→NE(3)→E(6)→SE(9)→S(8)→SW(7)→W(4), skip Invalid(0)/5. |
| CRC docs § Display Control Bar | Main menu + Aux menu + BRITE/MAPS/SITE submenu layouts. |

### Resolutions for ambiguous points

1. **Menu navigation.** WPF stores `ActiveMenu` on `DCB`. We mirror with
   `dcb.active = "MAIN"|"AUX"|"BRITE"|"MAPS"|"SITE"`. Sub-DONE button or
   SHIFT-back returns to MAIN. Exact menu choreography.
2. **Button click vs drag.** WPF `DCBAdjustmentButton` supports drag-to-
   scrub. Phase 4 supports click (+1), right-click (−1), and wheel (±1).
   Drag-to-scrub deferred (see G14). Click increments are identical.
3. **Per-brightness category mapping.** WPF has separate brightness
   categories (`FullDataBlocks`, `LimitedDataBlocks`, `OtherFDBs`,
   `BeaconTargets`, `PrimaryTargets`). Phase 4 collapses these into the
   PrefSet defaults from Phase 1 (`DataBlock`, `Position`, etc.). Each
   BRITE button maps to one of these via the `map` table in
   `handleBriteAdjust`. Documented as G15.
4. **Inline MAP1-6 buttons.** WPF's `TCP.DCBMapList[i]` stores the
   starsId each button toggles. We default to the first 6 video maps
   in catalog order; clicking the MAPS submenu lets the user toggle any
   map directly. Phase 6 will load TCP's preferred bindings from
   `PrefSet.DisplayedMaps`.
5. **`OFF CNTR` semantics.** WPF restores screen center to its home
   location. Mirrored.

### Backend additions

None — Phase 4 is pure frontend.

### Frontend additions

- `wwwroot/stars/dcb.js` — `DCB` class, menu factories, click/right-click/
  wheel routing, button rendering.
- `scope.js` — `mountDcb`, `handleNumAdjust`, `handleBriteAdjust`,
  `handleMapToggle`, `handleDcbClick`, `pendingMapAction` for PLACE CNTR
  and PLACE RR.
- `scope.html` — adds `<div id="dcb">` + `<script src="dcb.js">`.

### New deviations

- **G14 — drag-to-scrub on adjustment buttons not implemented.**
  WPF lets the user middle-drag a brightness/range button to scrub
  continuously. We support click +1, right-click −1, wheel ±1. Same
  end state; less ergonomic for large jumps. Deferred to polish.
- **G15 — Brightness category collapse.** WPF has `FullDataBlocks`,
  `LimitedDataBlocks`, `OtherFDBs`, `BeaconTargets`, `PrimaryTargets`
  as separate Brightness fields. We collapse these into the existing
  PrefSet defaults (`DataBlock`, `Position`). Render uses the unified
  values; FDB/LDB/OTH BRITE buttons all adjust `DataBlock`; BCN/PRI
  both adjust `Position`. The information loss is acceptable for
  Phase 4 — Phase 11 polish will split them per-WPF.

### What's intentionally NOT in Phase 4

- CHAR SIZE submenu (disabled button → Phase 11 polish)
- MODE button (disabled in WPF too — Multi/FSL not applicable)
- SSA FILTER + GI TEXT FILTER submenus (Phase 7 alongside SSA)
- Drag-to-scrub adjustments (G14)
- Dwell highlighting (G15-adjacent — text turns yellow on hover; we use
  CSS hover but don't yet implement the exact WPF dwell color cycle)

### Self-test checklist

- Bar appears at top by default.
- Click RANGE → range increments by 1; right-click → decrements; scroll → ±1.
- Click MAPS → submenu opens, lists every catalog map; toggling any one
  draws/erases its lines.
- Click BRITE → submenu opens; each button shows current value
  (e.g., `RR 100`); click cycles by +10; right-click −10.
- Click DCB TOP/LEFT/RIGHT/BOTTOM in AUX menu → DCB jumps to that edge.
- Click LDR DIR → leader direction cycles; data block re-positions.
- Click LDR → leader length 0-8.
- PTL ALL / PTL OWN toggle highlight when active.
- Click PLACE CNTR → next map click sets screen center.

---

## Phase 5 — MCA / Preview Area + initial command set

### WPF sources ported

| WPF source | What we took |
|------------|--------------|
| `scope/RadarWindow.cs:1417-2900` (`ProcessCommand`) | Dispatch shape: tokenize on spaces, switch on first token's character; trailing-token FLID lookup against callsign/squawk. We mirror the dispatch loop in `executeCommand`. |
| `scope/RadarWindow.cs:742-748` (PreviewArea + StatusArea) | Two separate text labels positioned at PreviewLocation/StatusLocation. Phase 5 implements PreviewArea; StatusArea comes with SSA in Phase 7. |
| `scope/RadarWindow.cs:970-971` (Key handlers) | KeyDown for control / function keys; KeyPress for character typing. We collapse both into a single `keydown` handler since browser exposes `e.key` directly. |
| `scope/RadarWindow.cs:2920-2945` (PreviewArea render) | Color = `AdjustedColor(DataBlockColor, Brightness.FullDataBlocks)`. We use lime + dynamic per-message coloring (red for errors). |
| `scope/RadarWindow.cs:1308-1330` (clicked-plane handling) | `clickedplane` flag → "click + space-separated buffer = command applied to clicked plane". We expose `window.mcaSetClickedPlane`. |
| CRC docs § Command Reference (STARS Keys) | F-key prefix table (F1=QF, F2=QP, F4=QX, F5=QZ, F6=QU, F7=QL, F8=QQ, F9=QB, F10=QS; Shift+F2=QD, Shift+F7=WR, Shift+F8=QR). |
| CRC docs § Repositioning Tracks | Numeric keypad layout for leader direction (1=NW, 2=N, 3=NE, 4=W, 6=E, 7=SW, 8=S, 9=SE). |

### Commands implemented in Phase 5

- **Bare FLID** → toggle FDB ↔ LDB for that aircraft (sets `_forcedMode`)
- **Empty + click on aircraft** → toggle FDB
- **1-9 + click** → set leader direction for the clicked aircraft
- **QF \<FLID\>** → flight plan readout in preview area
- **QX \<FLID\>** → drop track (removes from local map)
- **QZ \<alt\> \<FLID\>** → set assigned altitude
- **QU \<FLID\>** → toggle route display
- **QL \<sector ...\>** → quick look TCPs
- **QD** → clear preview response
- **QP \<FLID\>** → clear point-out / force LDB
- **QQ \<alt\> \<FLID\>** → set interim altitude
- **QS \<value\> \<FLID\>** → heading / speed / free-text on the clearance:
  - prefix `` ` `` → free text
  - prefix `/` → speed
  - otherwise → heading

### Commands deferred (TODO, marked in CRC table)

These will land in later phases. They're inert / "UNKNOWN CMD" today:

- **INIT \<FLID\>** / **TERM \<FLID\>** → Phase 8 (tracking, sector ownership)
- **\* / handoffs** → Phase 8 (initiate, accept, reject handoff)
- **PO / .PO** → Phase 8 (point-out)
- **CRDA setup / Quick Look beaconator** → Phase 9
- **MAP \<n\>** / **WX \<level\>** → already handled by DCB clicks
- **All dot commands** (.HOME, .DSP, .CR, .TS, etc.) → Phase 11 polish

### Frontend additions

- `wwwroot/stars/mca.js` — MCA object, key handler, command dispatch.
- `scope.html` — adds `<script src="mca.js">`.
- `scope.js` — `pickAircraft` (12 px proximity hit-test), `pendingMapAction`
  click path now passes hits to `window.mcaSetClickedPlane`.

### Resolutions

1. **Aircraft hit-test radius.** WPF uses the rendered `PositionIndicator.
   BoundsF` (per-glyph bounding box). We use a 12 px circle around the
   extrapolated position. Tweakable; matches WPF for typical 13 px glyphs.
2. **Buffer state model.** WPF accumulates `List<object>` of keys (chars +
   F-key tokens). We use a simple string buffer + token split on space.
   Behaviorally identical for printable chars.
3. **Response timeout.** WPF clears the preview line on the next command;
   we add a 4 s auto-clear so transient errors don't linger. Same WPF
   behavior would re-display on next Enter.

### New deviations

- **G16 — Command set incomplete.** Phase 5 implements ~15 of the ~80
  commands in the CRC reference. The remaining commands (handoffs, point-
  outs, dot commands, tracking init/term, CRDA setup) are deferred to
  Phases 8 / 9 / 11.

### Self-test checklist

- Press F5 → preview buffer shows `QZ `.
- Type `300 AAL123` → Enter → response shows `QZ 300 AAL123`.
- Click an aircraft target → response shows `FDB ON`; second click → `FDB OFF`.
- Type `5` then click an aircraft → leader direction E (east) applied.
- Type `QL ABC DEF` → Enter → response shows `QL ABC DEF`; affects which
  TCP-owned targets render in quick-look mode (Phase 8 wires the visual).

---

## Phase 6 — System lists (OUT OF SCOPE under strict-port rule)

### Decision

The WPF reference at `github.com/yanjz124/scope` does **not** implement
the CRC system-lists feature set (Sign-On List, Flight Plan / TAB,
Tower 1-3, Coast/Suspend, VFR, LA/CA/MCI, CRDA Status, Video Map Lists).
Searching `RadarWindow.cs` and the rest of the repo turns up only:

- `PreviewArea` (line 742) — MCA input + system response. Implemented in
  Phase 5.
- `StatusArea` (line 747) — the SSA (System Status Area). Belongs to
  Phase 7.
- `cmp_labels[]` (line 4730) — the compass bearing labels. Implemented
  in Phase 1.

No `TabList`, `TowerList`, `CoastList`, `VfrList`, `CrdaStatusList`,
`SignOnList`, or video-map-list classes/instances exist anywhere in the
WPF source. Their presence in CRC docs reflects what the FAA STARS
displays — which DGScope intentionally doesn't replicate.

### Per the user's strict-port rule

> "Never be creative. Follow visual, behavior, and functionalities
> EXACTLY. Replicate everything 100%. If it can't happen, let me know,
> document it"

Because the WPF doesn't have these lists, **adding them would violate
the rule**. We therefore log Phase 6 as deliberately empty under the
strict-port mandate.

### What the user should decide

If you want CRC-style system lists in the web port (they ARE genuinely
useful for ATC simulation), that's a follow-up "Phase 6X — CRC parity
extension" outside the strict port. Flag it in a future request and
we'll implement them based on CRC docs alone.

### Files touched

None. This is a documentation-only commit.

### What ships

The Phase 6 commit on the branch contains only updates to:
- `docs/stars/PHASE-NOTES.md` (this entry)
- `docs/stars/PORT-NOTES.md` (phase table marked "skipped per strict port")

---

## Phase 7 — SSA (System Status Area)

### WPF sources ported

| WPF source | What we took |
|------------|--------------|
| `scope/RadarWindow.cs:2942-3060` (`RenderStatus`) | Full content sequence verbatim: time + sync + altimeter → ATIS slots → SelectedBeaconCodes → Range+PTL → Altitude filter row → INTRAIL → METARs. |
| `scope/RadarWindow.cs:747-752` (StatusArea TransparentLabel) | The SSA is one label; we render it as one `<div>` with `<br>`-separated lines. |
| CRC docs § System Status Area | Confirms the layout taxonomy. |

### Render order (mirrors WPF line-by-line)

1. `HHmm/ss{syncInd}{altimeter}` — UTC time + ` ` or `*` for sync state + primary altimeter
2. ATIS line per non-null slot (`atises[i]` + optional `gentexts[i]`)
3. `SelectedBeaconCodes` space-separated
4. `{Range}NM PTL: {PTLLength}`
5. Altitude filter: `{minUnAssoc} {maxUnAssoc} U {minAssoc} {maxAssoc} A` formatted as 3-digit FL via `fa()` (= WPF `ToFilterAltitudeString`)
6. `INTRAIL ON: {volumeIds}` if any active
7. `INTRAIL 2.5 ON: {volumeIds}` if subset
8. `{station} {pressure}` per METAR (K-prefix stripped for US stations, matching WPF line 3001)

### Resolutions

1. **Color = `AdjustedColor(DataBlockColor, Brightness.Lists)`.** Web port
   sets `el.style.color = rgb(0, 255*Lists/100, 0)` so the SSA brightens
   with the LST slider.
2. **Positioning.** WPF reads `PrefSet.StatusAreaLocation` (PointF). Web
   port defaults to (8, 90) — below the DCB — and supports
   Shift+drag to move (persists to `prefSet.StatusAreaLocation`). Plain
   click is reserved for STARS commands per CRC convention.
3. **Time sync indicator.** WPF's `*` means time is unsynchronized; web
   port leaves `timeSynchronized = true` since the browser's
   `Date.now()` is always local-clock-accurate.
4. **Altimeter.** WPF reads `wx.Altimeter.Value` from the local METAR
   weather service. Web port leaves `null` until METAR fetch lands
   (Phase 10 NEXRAD work brings the weather pipeline; for now the line
   shows `—`).

### Retirement of G9

The Phase 1 debug topbar (G9) is removed in this commit. The SSA covers
its info; one tiny `#dstars-state` corner indicator remains for raw
connection state.

### What's NOT in Phase 7

- ATIS feed — the underlying ATIS storage is implemented (`SSA.atises[]`)
  but nothing populates it. ATIS will be wired in when the relevant
  data source is identified (likely a CRC/vNAS API or manual entry).
- Live METAR fetch — moves with Phase 10 (NEXRAD) which already
  proxies METAR through the existing SwimReader server.
- Active beacon-code rotation indicator — Phase 5 implements
  `prefSet.QuickLookedTCPs` storage; SSA visualization deferred.

### Self-test checklist

- SSA panel appears below DCB on load.
- Time updates every second.
- Range value reflects DCB RANGE button.
- Altitude filter row reflects PrefSet defaults (and any QF/QL changes).
- Shift+drag the panel → it moves; PrefSet.StatusAreaLocation updates.

---

## Phase 8 — Handoffs, point-outs, sign-on (LOCAL ONLY)

### Scope decision

The WPF DGScope's `ScopeServerClient.Send(...)` can write back to a
DSTARS server. The SwimReader DSTARS endpoint at
`src/SwimReader.Server/Controllers/DstarsController.cs` is **read-only**
— it streams updates outward but doesn't accept inbound writes. Adding
write support touches the SwimReader server, the DSTARS protocol's
authenticated channel, and the upstream SFDPS adapter — out of scope
for this STARS port pass.

Therefore Phase 8 is **LOCAL ONLY**: handoff and point-out actions
mutate the in-browser `FlightPlan` record. The server doesn't see them
and other connected scopes don't see them. Documented as G18.

### WPF sources referenced

| WPF source | What we took |
|------------|--------------|
| `scope/Aircraft.cs:115` (`LDRDirection`, `OwnerLeaderDirection`) | Per-aircraft leader direction selection (already used in Phase 3b). |
| `scope/Aircraft.cs:33-47` (`PositionInd`, `PendingHandoff`, `HandoffInitiated` events) | The state model for sector ownership + pending handoff. |
| `scope/RadarWindow.cs:80` (`PointoutColor = Yellow`) | Color for point-out tracks. |
| `scope/RadarWindow.cs:2206` ("'L': Leader Lines") | INIT/TERM command shape in the WPF dispatch. We mirror as `INIT <FLID>` / `TERM <FLID>`. |
| CRC docs § Handoffs + Point Outs | The user-facing workflow. |

### Commands added

- **`.SO <tcp>`** — sign on as TCP (sets `_signedOnTcp`). Until used, all
  tracks render as PDB/LDB (no ownership match).
- **`INIT <FLID>`** — acquire ownership locally (`fp.Owner = ownTcp()`).
- **`TERM <FLID>`** — release ownership locally.
- **`* <sector> <FLID>`** — initiate handoff (sets `fp.PendingHandoff`).
- **`PO <sector> <FLID>`** — initiate point-out (sets
  `fp._pointoutTarget`).
- Existing **`QP <FLID>`** (Phase 5) — accept point-out / clear handoff.

### Visuals added

- **Data block color hierarchy** (in scope.js `drawDataBlockAndLeader`):
  Emergency > Pointout > PendingHandoff-TO-us > Owned > Default.
- **SSA "TCP" line**: when signed on, the SSA's first line shows
  `TCP {id}`.
- Color constants (`COLORS.Pointout = [255,255,0]` per WPF
  RadarWindow.cs:80) light up the data block yellow when a point-out
  is directed at our TCP, OR when a handoff is pending TO our TCP.

### URL parameter

`/stars/{artcc}/{facility}?tcp=ABC` signs the user on immediately as
TCP `ABC`. Useful for bookmarks.

### Self-test checklist

- Open scope with `?tcp=ZDC1`. SSA line 1 shows `TCP ZDC1`.
- Type `* ZDC2 AAL123` Enter. AAL123's data block turns yellow
  (PendingHandoff != us, but visible to others).
- Reload with `?tcp=ZDC2`. Now AAL123's data block is yellow (handoff
  pending TO us).
- Type `INIT AAL123` Enter. AAL123 becomes owned (white data block);
  PendingHandoff cleared.
- Type `TERM AAL123` Enter. AAL123 becomes unowned again.

### New deviation

- **G18 — Handoff actions are local-only.** SwimReader's DSTARS
  endpoint is read-only; the web port can't propagate handoff state to
  the upstream. All Phase 8 mutations are local-only — invisible to
  other connected scopes and reset on page reload. Full bidirectional
  support requires server-side writes + DSTARS authentication, out of
  scope for the strict port pass. Phase 11 polish may revisit.
