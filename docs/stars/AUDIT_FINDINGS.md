# STARS port deep audit (vs DGScope)

Generated: 2026-06-23. Source of truth: `.stars-reference/scope/`.
Sibling: `COMMAND_AUDIT.md` (dispatcher-level command branches with cites).

This doc is the broader, file-level audit covering scope.js, preview.js,
dcb.js, ssa.js, nexrad.js. Each finding has a DGScope cite. Items marked
`[shipped <commit>]` have been addressed since the audit; everything else
is open.

---

## A. Invented code in our port — REMOVE

Most of the port stays close to DGScope. Concrete inventions still in tree:

1. [shipped cac9cf9] **scope.js `Brightness.Weather` collapse** —
   PrefSet.cs:148+152 `Weather` + `WeatherContrast` now load into separate
   slots; the WXC button still needs to be wired to the WeatherContrast
   slot (the NEXRAD draw alpha can consume it independently).

2. [shipped cac9cf9] **scope.js `Brightness.DataBlock` 3→1 collapse** —
   FullDataBlocks / LimitedDataBlocks / OtherFDBs now load into their own
   slots; data-block renderer picks the right one per Owned/FDB/LDB.

3. [shipped cac9cf9] **scope.js `Brightness.Position` 3→1 collapse** —
   PositionSymbols / BeaconTargets / PrimaryTargets now load into their
   own slots; position-symbol renderer uses PositionSymbols when owned
   else BeaconTargets, primary return uses PrimaryTargets.

4. **scope.js `OtherOwnersLeaderDirections`** — PrefSet.cs:31 maps each
   other-controller TCP → leader direction. We only have
   `OwnedDataBlockPosition` + `UnownedDataBlockPosition` so a facility
   that configures per-TCP leader directions has them silently ignored.

5. [shipped cac9cf9] **PrefSet defaults differ** — scope.js now matches
   PrefSet.cs: HistoryNum=10, Range=6.

6. **CA blink phase** — scope.js:1077 blinks on `Date.now() % 1000 < 500`.
   WPF (RadarWindow.cs:5454-5468) keys blink off the radar sweep counter
   so the alert pulses in sync with the scan, not wall-clock. Very minor
   visual difference.

(Other inventions previously removed: `_jRing`, `_pointoutTarget`,
"NO TRK" on `*J`, `.SO` shorthand, "SIGN ON"/"ACCEPT"/"RECALL" echo, WX
A/OFF/ON/<prod> command soup, hasBeacon glyph gate, hardcoded TPA green.
See git log + `COMMAND_AUDIT.md`.)

---

## B. Behaviour gaps — in DGScope, missing from port

Ordered by impact. Each cite is `<file>:<line>`.

### B1. Core aircraft state

- **B1.1 — `Aircraft.FDB` per-aircraft toggle** — Aircraft.cs:119-136.
  Real STARS lets the user click a track to force FDB on a non-owned
  flight (or LDB on an owned). Our `dataBlockMode()` is purely
  derived; no persistent override beyond `_forcedMode` in preview.js
  which is the same shape, just under-tested.
  ProcessCommand fall-through (cs:1438-1450) is the click-no-keys
  handler that flips `plane.FDB`.

- [shipped] **B1.2 — `QuickLookPlus` per-aircraft** — drawTracks now
  syncs `t._quickLook` / `t._quickLookPlus` per frame from
  prefSet.QuickLookedTCPs (mirrors RadarWindow.cs:5719-5742). The
  color tier check at scope.js ~1260 already handled QLPlus → white,
  it just had no source. (Setting prefSet.QuickLookedTCPs entries is
  still B2.1 — the Q command isn't yet wired.)

- [shipped] **B1.3 — `SelectedSquawkChar` rendering** — implemented in
  positionSymbolText (scope.js ~1353-1364); reads `window.SSA.selected-
  BeaconCodes` and returns `prefSet.SelectedBeaconCodeChar` on a startsWith
  match. The earlier TODO marker was stale.

- [shipped] **B1.4 — `ShowCallsignWithNoSquawk` mode** — the per-aircraft
  flag is consumed in buildDataBlock (scope.js ~1046) which renders the
  3-line LDB beacon-readout variant when true. Drawn from the global
  `window.showAllCallsigns` F1-hold flag, synced into each track per
  frame in drawTracks (mirrors RadarWindow.cs:6239-6241).

### B2. Preview / command dispatch holes

- **B2.1 — `Q` command (QuickLook TCP list)** — RadarWindow.cs:2323-2356.
  `QORD` toggles ORD in QuickLookList; `QORD+` toggles ORD+ (plus form).
  Missing entirely from preview.js. State field
  `prefSet.QuickLookedTCPs` exists but is never written.

- **B2.2 — `S<letter> [text…]` ATIS setter** — RadarWindow.cs:2358-2399.
  Sets ATIS slot 0 letter + optional gentext suffix. Our
  `processMultifunction` has a `sub === "S"` branch (preview.js:718)
  that handles `F S` (set StatusArea location) only — the
  letter-+-text form is incomplete.

- **B2.3 — `Y` command — scratchpad clear/set** — RadarWindow.cs:2420-2460.
  Clicked plane:
    `Y` clears Scratchpad1,
    `Y+` clears Scratchpad2,
    `Y<text>` sets Scratchpad1,
    `Y+<text>` sets Scratchpad2.
  Untyped form on the typed-FLID path. Partially in our `F Y` multifunction
  (preview.js:671) but the typed-without-`F` form is missing.

- **B2.4 — `O E|I` AutoOffset toggle** — RadarWindow.cs:2400-2410.
  Multifunction `F O E` / `F O I`. We have the multifunction branch
  (preview.js:660) but no AutoOffset state in scope.js and no rendering
  side effect that consumes it.

- **B2.5 — `R` PTL toggle on clicked plane** — RadarWindow.cs:2412-2418.
  `F R` + clicked. preview.js:666 has the branch; it sets `_showPtl` but
  the renderer doesn't read it (only the global PTLOwn / PTLAll flags).

- **B2.6 — `End` key Min Sep tool** — RadarWindow.cs:2579-2605.
  Keyboard binding (Window_KeyDown cs:3428). First End-click on plane:
  `tempMinSep = new MinSep(plane, null)`. Second End-click on a different
  plane: `minSeps.Add(new MinSep(p1, p2))`. End with no clicked plane:
  `minSeps.Clear()`. Not in preview.js; render side has `minSepPair`
  state but never gets populated.

- **B2.7 — `Ctrl+Shift+O` CRR RDB offset cycle** — RadarWindow.cs:2822-2828.
  Keyboard binding (Window_KeyDown). Cycles 0/1/2/3 offset on the
  "Coordination Required Receiver-Data-Block" display. Not in preview.js.

- **B2.8 — Numeric typed input** — RadarWindow.cs:1545-1700+.
  `340` + click sets altitude target (?), `230` + click sets speed
  target (?). The exact mappings need confirmation. preview.js has
  `cmdDefaultClickedPlane` for 2-4 char text but doesn't differentiate
  numeric.

### B3. ATPA / separation tools

- **B3.1 — ATPA mileage in FDB line 3** — Aircraft.cs:509-512.
  When `ATPAMileageNow != null`, line 3 renders the mileage instead of
  the AssignedSquawk-mismatch indicator. Our scope.js:926-928 only does
  the squawk-mismatch path.

- **B3.2 — ATPA volume polygon draw** — ATPAVolume.cs.
  2D polygons defining the approach volumes. Our state holds a list but
  the canvas renderer never draws them.

- **B3.3 — ATPA status cones (Monitor / Caution / Alert)** —
  ATPATcpDisplay.cs + RadarWindow.cs:6100-6150 (estimated).
  Aircraft in ATPA volumes render colour-coded cones (yellow / orange /
  red). Our scope.js does nothing for ATPACone.

- **B3.4 — P-Cone rendering** — TPACone.cs.
  Both J-Rings and P-Cones share the `TPA` field but draw differently —
  J-Ring = circle, P-Cone = triangular sector ahead of track. scope.js
  treats them the same; no cone shape draw.

### B4. Display Control Bar

- **B4.1 — `MODE` button (FSL/STARS cycle)** — RadarWindow.cs:3484.
  Disabled in DGScope too, so leaving disabled is faithful.

- **B4.2 — BRITE WXC slider** — see A1. Needs the field + button.

- **B4.3 — BRITE LDB / OTH slider drift** — see A2. Buttons exist on
  our DCB but they all drive Brightness.DataBlock.

- **B4.4 — Per-position leader-direction sub-buttons** — RadarWindow.cs
  in BRITE / leader menus. `F L <pos><dir>` is wired (cs:2206-2314)
  in preview.js:617 — verify it writes to OtherOwnersLeaderDirections
  and that the renderer reads it (which it doesn't today; see A4).

### B5. System Status Area

- **B5.1 — INTRAIL volume display** — RadarWindow.cs:2970-2986.
  SSA shows "INTRAIL ON: <vol> <vol>" when ATPA volumes are active +
  "INTRAIL 2.5 ON: <vol>" for 2.5nm operations.
  ssa.js:28 has the state field; render never emits.

- **B5.2 — Quick Look TCPs line** — RadarWindow.cs:2999+.
  SSA shows "QL: <tcp> <tcp>" of active quick-look positions.
  Render is in ssa.js but the source list is empty because Q command
  (B2.1) isn't wired.

### B6. Keyboard / hardware

- **B6.1 — InvertKeyboard** — RadarWindow.cs:1508-1511. Some facilities
  flip the numeric-keypad orientation (1=SW vs 1=NW). The field source
  isn't in PrefSet.cs; might be a separate config or a flag in another
  file. Our leaderDirFromDigit accepts an `invert` arg but it's
  hardcoded to `false`.

- [shipped] **B6.2 — F1 (Beacon Code Readout hold)** — drawTracks now
  syncs `t.ShowCallsignWithNoSquawk = window.showAllCallsigns` per
  frame (mirrors RadarWindow.cs:6239-6241); buildDataBlock already
  rendered the 3-line beacon-readout variant when the flag is true.

### B7. Render / visual details

- [shipped] **B7.1 — Data-block flash on inbound handoff** — wired via
  handoff.js `isInboundHandoff()` + scope.js `dbFlashing` (line ~1244) +
  `flashPhaseHidden()` (handoff.js:241). Inbound flash uses the same
  blink phase logic DGScope drives off the OpenGL frame counter.
  Outbound-complete blink also implemented (3653055) per CRC STARS spec.

- **B7.2 — ClockPhase per-update vs per-tick** — ClockPhase.cs.
  WPF increments phase on each Aircraft update arrival. We tick the
  whole map once per second (scope.js:1363 interval). Doesn't sync
  with update arrival, so a busy track may not rotate when a quiet one
  does. Probably invisible in practice.

- **B7.3 — Radar sweep extrapolation accuracy** — Radar.cs:95-110.
  WPF extrapolates Position via `(track,gs,age)` between sweeps.
  Our scope.js:1345 calls `extrapolatedPosition(t)` but the
  implementation needs review for sub-pixel correctness.

- **B7.4 — Position-Indicator click hitbox** — Aircraft.cs:768.
  WPF positions the PositionIndicator at exactly LocationF with
  CenterOnPoint. Our scope.js measures hit via Pythagorean distance
  with a small radius; works but slight pixel-level mismatch.

---

## C. Field-level divergences

| Concern | DGScope | Port | Risk |
|---|---|---|---|
| `Brightness` flat field name | 14 named brightness fields (PrefSet.cs:74-156) | 11 fields after 3→1 collapses (A1–A3) | Medium — BRITE submenu can't move them independently |
| `QuickLookedTCPs` shape | `List<string>` with "TCP" and "TCP+" entries | Field exists but never written | Medium — Q command not wired |
| `OtherOwnersLeaderDirections` | `Dictionary<string, LeaderDirection>` | absent | Low — rarely used |
| Default `Range` | 6 | 50 | Low — profile load overrides |
| Default `HistoryNum` | 10 | 5 | Low — profile overrides |
| `FDB`/`LDB`/`OTH` brightness | independent | single | Low |

---

## D. Open questions — need CRC verification

1. STCA constants: our scope.js:1195 uses 3.0 NM lateral + 1000 ft
   vertical. DGScope code doesn't explicitly define them; likely
   reasonable defaults but unverified.

2. InvertKeyboard storage: not in PrefSet.cs. Where is it set?

3. Exact J-Ring radius label position relative to ring centre +
   leader direction.

4. ATPA mileage formatting in line 3: does it replace or augment the
   squawk-mismatch field? Aircraft.cs:509-512 is ambiguous.

5. `ShowCallsignWithNoSquawk` — is this a per-facility preference, a
   per-position toggle, or a DCB toggle?

---

## E. Implementation priority

**High-value, low-effort** (target next 1-2 commits):
- B1.1 + click→FDB toggle wiring through dataBlockMode
- B2.1 Q command + B5.2 SSA QL display (single pair)
- B2.3 Y command (typed scratchpad)
- A1 split WeatherContrast from Weather
- B2.6 End key Min Sep tool (we already have minSepPair state)

**High-value, moderate-effort**:
- B3.1 ATPA mileage in FDB line 3
- B7.1 inbound-handoff data-block flash
- B2.7 Ctrl+Shift+O CRR offset
- B2.2 S command ATIS setter (already partial)

**Deferred** (specialized / require more research):
- B3.2/3.3 ATPA volume + cone rendering
- B6.1 InvertKeyboard (need to find the source field first)
- A2/A3 split brightness collapses (touches profile loader + every
  draw site that reads them)

---

When tackling an item from B, please:
1. Cite the DGScope line in the commit message.
2. Add to `COMMAND_AUDIT.md` (the dispatcher table) if it's a command.
3. Mark this doc's checkbox + add `[shipped <commit>]` next to the item.
