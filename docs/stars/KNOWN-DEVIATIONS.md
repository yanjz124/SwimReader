# Known Deviations from WPF DGScope

This file logs every place the web port can't bit-for-bit match the WPF
program. Every entry must include: WHAT differs, WHY (the platform constraint),
HOW CLOSE the workaround gets, and a TEST suggestion.

If you add a new feature and discover a new gap, append it here in the same
shape.

---

## Anticipated gaps (added before implementation; will revisit after)

### G1 — Font rendering pixel parity
- **What:** WinForms text rendering vs. browser text rendering produces
  slightly different anti-aliasing on glyph edges; ClearType behavior in
  WinForms is OS-controlled, browser is engine-controlled.
- **Why:** No browser API exposes WinForms-equivalent glyph hinting.
- **Workaround:** Ship the exact STARS font (TTF) the WPF program uses; force
  `text-rendering: geometricPrecision; -webkit-font-smoothing: none` on render
  surfaces; pixel-snap glyph positions.
- **Closeness:** ≥99% on individual glyphs; possible 1px shimmer on diagonals.
- **Test:** Side-by-side screenshot diff of a sample data block stack.

### G2 — Owned keyboard shortcuts
- **What:** Browser/OS owns `F11` (fullscreen), `F5`/`Ctrl+R` (reload),
  `Ctrl+W`/`Cmd+W` (close), `Ctrl+T` (new tab), `Ctrl+Tab`, system meta keys.
- **Why:** Browsers refuse to forward these to JavaScript.
- **Workaround:** Suppress what we can via `keydown` `preventDefault`; document
  substitute key sequences in the in-app help.
- **Closeness:** Full STARS coverage minus the listed system keys.
- **Test:** Walk the entire CRC keybinding table; mark each as native vs.
  substituted.

### G3 — Multi-monitor / secondary displays
- **What:** WPF opens additional `RadarWindow` instances; in a browser these
  become popup windows (require user gesture) or browser tabs.
- **Why:** Browser security model.
- **Workaround:** Secondary displays open via "Open Display" button (user
  gesture). Each window connects independently to the same backend.
- **Closeness:** Identical behavior inside each window; OS-level window
  management is the user's job.
- **Test:** Open two secondary displays, assign different TCPs, verify
  independence.

### G4 — Audio gating
- **What:** Browsers refuse to play audio before a user gesture.
- **Why:** Chrome/Firefox/Safari autoplay policies.
- **Workaround:** First alert beep silent; subsequent beeps play normally
  after any user click/key. Show one-time "Click to enable sound" banner.
- **Closeness:** ≥99% of session audio; first-ever sound on a fresh load is
  silent.
- **Test:** Trigger STCA at session start before any interaction.

### G5 — OpenGL → WebGL primitive parity
- **What:** WPF uses OpenTK (immediate-mode `GL.Begin`/`GL.Vertex`). Modern
  WebGL2 requires vertex buffers.
- **Why:** WebGL1/2 don't expose fixed-function pipeline.
- **Workaround:** Build a thin immediate-mode wrapper that batches the same
  primitive calls into VBOs each frame. Render order, color, line width
  preserved.
- **Closeness:** Visually identical; performance characteristics differ (web
  is typically faster on the same GPU).
- **Test:** Side-by-side render of a busy facility (>100 targets + maps).

### G6 — Right-click context menu
- **What:** WPF accepts right-click for STARS commands (`QU`, `QZ` insert,
  etc.); browsers default to OS context menu on right-click.
- **Why:** Browser default.
- **Workaround:** `contextmenu` event suppressed on the scope surface.
- **Closeness:** 100% inside scope; user's browser context menu still works
  on the title bar.
- **Test:** Right-click a target → expect MCA insertion, not browser menu.

---

### G7 — Mouse-wheel zoom (Phase 1)
- **What:** WPF cycles the `Range` value through preset steps via DCB buttons.
  Web port adds mouse-wheel zoom on the canvas (multiplies Range by 0.85/1.18 per
  scroll tick, clamped to [1, 400]) as a convenience while the DCB doesn't exist.
- **Why:** Without a DCB yet, there's no other way to change Range in the
  Phase 1 build. The DCB itself is built in Phase 4.
- **Workaround:** Mouse-wheel zoom is additive — it doesn't remove or change
  the DCB Range cycle behavior. When Phase 4 lands, DCB cycle continues to
  work identically to WPF.
- **Closeness:** Additive convenience only; no replacement of WPF behavior.
- **Test:** Phase 4 verifies DCB Range cycle still works after wheel zoom.

### G8 — RangeRingsCentered initial value (Phase 1)
- **What:** WPF PrefSet defaults `RangeRingsCentered = false`. We default it
  to `true` on first load so users see range rings centered on the facility
  immediately. Right-click anywhere resets it to `false` exactly as WPF does
  (RadarWindow.cs line 1317-1318).
- **Why:** A fresh PrefSet has no saved `RangeRingLocation`, so a
  WPF-faithful `false` default would draw zero rings on first load (rings at
  geo 0,0 are far off-screen).
- **Workaround:** Centered-on-load; right-click to opt out (matches WPF
  behavior thereafter).
- **Closeness:** After first right-click, identical to WPF.
- **Test:** Open scope → see rings. Right-click 50nm NE → rings move there.

### G9 — Temp topbar (Phase 1 only)
- **What:** A non-WPF debug topbar at the top of the scope shows facility
  name, current Range, RR spacing, ScreenCenterPoint, and a link back to
  the picker.
- **Why:** During the port, having scope state visible helps verify
  behavior without an SSA.
- **Workaround:** Will be deleted in Phase 7 (SSA implementation).
- **Closeness:** Marked TEMP — Phase 7 removes it.
- **Test:** Phase 7 commit removes `#topbar` and CSS rules.

### G10 — vNAS doesn't serve video-map GeoJSON content publicly (Phase 2)
- **What:** `data-api.vnas.vatsim.net/api/artccs/{id}/` lists every video
  map's metadata (id, name, sourceFileName, starsBrightnessCategory) but
  no endpoint serves the actual GeoJSON geometry. Every URL pattern we
  tried returns 404. The WPF program never hit vNAS for content either —
  `CRCMapImporter.cs` reads from a local CRC export folder structure:
  `<basedir>/VideoMaps/{artccId}/{mapId}.geojson`.
- **Why:** vNAS doesn't publish the geometry, only the catalog. CRC
  desktop pulls the actual content through an authenticated channel that
  isn't documented for public access.
- **Workaround:** SwimReader.Server reads from a configurable directory
  (default: `tools/SwimServer/crc-export/`). The user copies their CRC
  export tree there (same layout DGScope expects) and the STARS port
  serves the GeoJSON via `GET /api/stars/videoMap/{artccId}/{mapId}`.
  Auto-falls-back to the upload endpoint `POST /api/stars/upload-export`
  if the user wants to push a ZIP instead.
- **Closeness:** When the export tree is present, 100% identical to
  DGScope. When the export tree is empty, maps simply don't render — same
  behavior as launching DGScope without a CRC export.
- **Test:** Drop one ARTCC's CRC export under `crc-export/ZDC/VideoMaps/`,
  pick a facility, see maps render exactly as DGScope would.

### G11 — Max-blend → additive blend (Phase 2)
- **What:** RadarWindow.cs line 5310 sets `GL.BlendEquation(Max)` before
  drawing video map lines (overlapping lines show the brighter color).
  Canvas2D has no max-blend; the closest mode is `globalCompositeOperation
  = "lighter"` which is additive.
- **Why:** Browser 2D context limitation. WebGL supports MAX but the
  Phase 1 render path is 2D; switching to WebGL is a Phase 11 cleanup.
- **Workaround:** Use additive blending. For grey lines at 100% brightness
  overlap looks brighter (additive: 280→clipped to 255 white) instead of
  identical (max: 140→140). At default brightness ≤ 50% this is
  imperceptible. Phase 11 may move to WebGL2 and restore exact MAX.
- **Closeness:** Identical at low brightness; slight brightening at
  overlap points when brightness > 70%.
- **Test:** Side-by-side comparison of crossed map lines.

### G12 — 3-line FDB timeshare not yet rotating (Phase 3b)
- **What:** WPF cycles between 3 FDB variants on a 1.5s timeshare
  (altitude+speed, scratchpad+reqalt, scratchpad2+type). Phase 3b shows
  variant 1 (altitude+speed+flight-rule+category) only.
- **Why:** The variant content + cycle-state lives in
  `Aircraft.RedrawDataBlock` between three `TransparentLabel` instances;
  porting the full state machine fits better in a Phase 3 polish pass.
- **Workaround:** Static variant 1. All other variant data still rendered
  in the data block (just not as a cycle).
- **Closeness:** ≥80% of information visible at any instant. Misses the
  scratchpad+reqalt and scratchpad2+type variants.
- **Test:** Polish commit before Phase 4 will turn the cycle on; existing
  unit test in PHASE-NOTES gets re-verified.

### G13 — Leader start point uses circle approximation (Phase 3b)
- **What:** WPF reads `PositionIndicator.BoundsF` (the rendered glyph's
  exact bounding box) to start the leader line. We approximate with a
  5-pixel radius from target center in the leader-direction vector.
- **Why:** Measuring per-glyph bounding box would require offscreen
  text measurement each frame; deferred to performance pass.
- **Workaround:** 5px radius circle approximation. Leader meets target at
  approximately the same point.
- **Closeness:** ≥99% visual match for the diamond glyph; up to 2px
  offset for `/` and `\` glyphs whose ink extends further from the
  geometric center.
- **Test:** Side-by-side diff at high zoom.

### G14 — DCB drag-to-scrub not implemented (Phase 4)
- **What:** WPF `DCBAdjustmentButton` lets the user middle-drag a button
  (RANGE, RR, LDR, brightness, etc.) for continuous scrubbing. Phase 4
  supports click (+1), right-click (−1), wheel (±1).
- **Why:** Drag math is straightforward but adds substantial pointer-
  capture complexity; deferred to Phase 11 polish.
- **Workaround:** Wheel and rapid clicks achieve the same end state.
- **Closeness:** Same final values, slower to scrub large jumps.
- **Test:** Try ranging from 6 to 200 via wheel — works, just takes ~30
  rotations.

### G15 — Brightness categories collapsed (Phase 4)
- **What:** WPF has `Brightness.FullDataBlocks`,
  `Brightness.LimitedDataBlocks`, `Brightness.OtherFDBs`,
  `Brightness.BeaconTargets`, `Brightness.PrimaryTargets` as separate
  fields. Phase 4 collapses to PrefSet-default `DataBlock`, `Position`,
  etc. FDB/LDB/OTH BRITE buttons all adjust `DataBlock`; BCN/PRI adjust
  `Position`.
- **Why:** Phase 1 PrefSet was simplified; revisiting now would dirty
  Phase 1's commit history.
- **Workaround:** All blocks/positions share one brightness value.
- **Closeness:** Identical when the user keeps all of them at one
  brightness (typical real-world usage); diverges if user sets FDB ≠
  LDB.
- **Test:** Phase 11 polish will expand PrefSet.Brightness and split
  the mapping.

(Phase implementations will append G16+ as discovered.)
