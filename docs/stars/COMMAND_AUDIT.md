# STARS port command audit — vs DGScope `scope/RadarWindow.cs`

Goal: every line of STARS command logic in `preview.js` cites the DGScope
source that implements the same behavior. Anything that can't be cited is
removed.

Last audited: 2026-06-22 against `.stars-reference/scope/` head.

Symbol legend:
- ✅  matches DGScope, line numbers cited inline
- ⚠️  partial / needs verification (cite line + describe gap)
- ❌  invented / not in DGScope — REMOVE
- 🟦  in DGScope but not yet implemented — TODO with cite

## Top-level dispatcher (`executeCommand`)

| Branch in `preview.js` | Maps to | Status |
| --- | --- | --- |
| `!line && clickedplane` → `processImplied(clicked)` | `ProcessCommand` cs:1421-1424 → `ProcessImpliedCommand` cs:2688-2769 | ✅ |
| Single digit 1-9 + clicked → leader direction | cs:1505-1593 (case '1'..'9') | ✅ via `leaderDirFromDigit` honoring `InvertKeyboard` |
| `IC`/`HO`/`VP`/`FD` (preview prefixes from F3/F5/F6/F9) → no-op | cs:1595-1603 (F3 body commented out); F5/F6/F9 have no case → default with single enum token is no-op | ✅ |
| `TC` + clicked → drop FP | cs:1604-1622 (case Key.F4 → `plane.DeleteFP()`) | ✅ |
| `SIGN ON <tcp>` → `setOwnTcp(tcp)` | cs:1623-1635 (case Key.F12) | ✅ (`.SO` shorthand removed) |
| `*` + sub → `processSplat` | cs:1636-1893 | ✅ |
| `.` (alone) + clicked → clear Scratchpad1 | cs:1894-1909 | ✅ |
| `+` (alone) + clicked → clear Scratchpad2 | cs:1910-1925 | ✅ |
| `F <sub>` + ... → `processMultifunction` | cs:1926-2577 (F7 KeyCode.MultiFunc) | ✅ |
| `RR <n>` → set RangeRingSpacing | cs:2528-2541 (KeyCode.RngRing) | ✅ |
| `WX <n>` → toggle `Nexrad.LevelsEnabled[n-1]` | cs:2542-2557 (KeyCode.WX) | ✅ — forwards to DCB `handleWxToggle` so buttons + Preview text stay in sync (cs:3886-3896) |
| `RECENTER <icao>` → recenter on airport | cs:2558-2577 (KeyCode.RecenterEverything) | ✅ |
| 2-4 char text + clicked → default catchall | cs:2606-2683 | ✅ → 3=scratch1, 4+`+`=scratch2, 4=aircraft type, 2=PendingHandoff |

## ProcessImpliedCommand (8-step priority chain)

`processImplied(plane)` in `preview.js:830-895` mirrors `RadarWindow.cs:2708-2768`:

1. `PendingHandoff == us` → ACCEPT (cs:2712-2717) ✅
2. `Owner == us && pending` → RECALL (cs:2718-2722) ✅
3. `Pointout` → clear (cs:2724-2727) ✅
4. `ForceQuickLook` → clear (cs:2728-2731) ✅
5. `Owned && Owner != us` → RELEASE (cs:2744-2747) ✅ (was missing — added 95f5500)
6. `Owned && callsign` → beacon readout in preview (cs:2752-2755) ✅ "{callsign} {squawk} {assigned}"
7. `!Owned && callsign` → toggle FDB (cs:2757-2760) ✅
8. unassociated → toggle FDB (cs:2764-2767) ✅

## `*` splat commands (`processSplat`)

| Sub | Form | Maps to | Status |
| --- | --- | --- | --- |
| `*B` | `*B [E\|I]` ATPA monitor cones toggle/E/I | cs:1641-1651 | ✅ |
| `*D+` | `*D+ [E\|I]` TPA size toggle/E/I (per-plane or system) | cs:1652-1717 | ✅ |
| `*T` | RBL — clicked plane + `*T`, `*T<idx>` enter (delete), `*T<wp>` enter (start from waypoint), `*T` enter (clear all), click empty + `*T` | cs:1718-1801 | ⚠️ wired but RBL rendering on canvas not yet implemented |
| `*J<miles>` | J-Ring of N miles on clicked plane (0 < N ≤ 30) | cs:1802-1828 | ⚠️ state captured; canvas render TODO |
| `*P<miles>` | P-Cone of N miles on clicked plane | cs:1829-1858 | ⚠️ state captured; canvas render TODO |
| `**J` | clear all J-Rings | cs:1865-1869 | ✅ |
| `**P` | clear all P-Cones | cs:1870-1874 | ✅ |
| `**<pos>` | ForceQuickLook when pos == ThisPositionIndicator | cs:1875-1887 | ✅ |

## `F` (F7 multifunction) tree (`processMultifunction`)

| Sub | Form | Maps to | Status |
| --- | --- | --- | --- |
| `F B` | toggle LDB beacon code display | cs:2092-2098 | ✅ |
| `F B E\|I` | enable/inhibit LDB beacon codes | cs:2099-2110 | ✅ |
| `F B <squawk>` | toggle SelectedBeaconCodes (1-4 digit code) | cs:2111-2119 | ✅ |
| `F B *` | clear SelectedBeaconCodes | cs:2120-2124 | ✅ |
| `F F NNNMMM[ MMMNNN]` | unassociated alt filter [+ associated] | cs:2138-2204 | ✅ |
| `F L <dir>[*\|U\|<pos>]` | leader direction (owned / unowned / unassociated / per-other-owner) | cs:2206-2314 | ✅ honours `InvertKeyboard` |
| `F P` + click | set PreviewArea location to clicked pt | cs:2316-2322 | ✅ |
| `F Q <pos>[+]` | toggle Quick Look (+ = QL plus) | cs:2323-2357 | ✅ |
| `F S` + click | set StatusArea location | cs:2358-2363 | ✅ |
| `F S <letter> [text]` | set ATIS slot 0 letter + free text | cs:2364-2398 | ✅ |
| `F O E\|I` | Auto-Offset enable/inhibit | cs:2400-2410 | ✅ |
| `F R` + click | toggle ShowPTL on clicked plane | cs:2412-2418 | ✅ |
| `F Y` (alone) + click | clear Scratchpad1 | cs:2420-2436 | ✅ |
| `F Y +` + click | clear Scratchpad2 | cs:2437-2449 | ✅ |
| `F Y <text>` + click | set Scratchpad1 | cs:2450-2462 | ✅ |
| `F Y +<text>` + click | set Scratchpad2 | cs:2463-2475 | ✅ |
| `F Y <flid> <text>` (typed) | set Scratchpad1 on typed FLID | cs:2481-2520 | ✅ |
| `F Y <flid> +<text>` (typed) | set Scratchpad2 on typed FLID | cs:2481-2520 | ✅ |
| `F D *` + click | display clicked geo as DMS | cs:2126-2137 | ✅ |
| `F 2 ATPA[ <vol>] E\|I` | ATPA enable/inhibit (system or per-volume) | cs:1932-2023 | ✅ |
| `F 2 2.5<vol>E\|I` | per-volume 2.5nm toggle | cs:2024-2086 | ✅ |

## Things in DGScope NOT yet ported

Tracked here so they don't get re-invented under a different name:

- 🟦 `Key.End` → Min Sep tool (`tempMinSep` 2-click flow) — cs:2579-2605
- 🟦 `Ctrl+Shift+O` cycle CRR RDB offset — cs:2822-2828 (ERAM equivalent in same file)
- 🟦 RBL drawing on canvas (`*T` captures state, no render yet) — cs:4929-5007
- 🟦 J-Ring / P-Cone canvas drawing — cs:6109 series + TPARing.cs / TPACone.cs

## Hardware/UI bindings (NOT command logic but used by audit)

- F-key preview prefixes (`preview.js` keydown handler) — cs:3271-3450 `Window_KeyDown`.
  Mapped: F2→RP, F3→IC, F4→TC, F5→HO, F6→FD, F7→F (multifunction), F9→VP, F11→CA.
- WX1-WX6 are DCB toggle buttons (`dcb.js:83-87` data-wx), wired in `scope.js handleWxToggle` per cs:3568-3573 + DcbWxButtonClick cs:3886-3896. ✅

## Things removed in this audit pass

- `.SO <tcp>` shorthand — invented; DGScope only has KeyCode.SignOn (F12). Removed in this commit.
- `setResponse("SIGN ON …")` / `setResponse("SIGNED OFF")` echo — invented; DGScope doesn't echo. Removed.
- `setResponse("ACCEPT …")` / `setResponse("RECALL …")` in processImplied — invented; DGScope just does `plane.SendUpdate()` with no preview text. Removed in 95f5500 (handoff audit).
- Long-form `WX A` / `WX OFF` / `WX ON` / `WX <prod>` Preview commands — invented; real STARS toggles each WX# layer via DCB buttons. KeyCode.WX path now forwards a single 1-6 digit to the DCB toggle.

## Followups

- Render layer for RBLs / J-Rings / P-Cones.
- Min Sep tool key binding + canvas overlay.
- Audit `processSplat` / `processMultifunction` inner branches at the same depth as the dispatcher (some `?` line numbers above are derived, not verified end-to-end).
