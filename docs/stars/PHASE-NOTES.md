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
