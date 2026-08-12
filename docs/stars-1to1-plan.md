# STARS scope → DGScope 1:1 plan

Goal: make the browser STARS scope (`tools/SwimServer/wwwroot/stars/`) behave 1:1 with DGScope
(`../scope`, WinForms/OpenGL, `net472`). Guiding constraint from the owner: **minimize code change;
when we must change code, stay as close to the original DGScope C# as possible** — i.e. prefer running
DGScope's real engines server-side (the "bridge" pattern) over hand-porting logic to JS.

This doc is the durable synthesis of a 5-agent survey of both codebases (2026-08). Keep it current.

## Architecture decision

There is **no DGScope ScopeServer to run** — the repo ships only a *client* receiver
(`DGScope.Receivers.ScopeServer/ScopeServerClient.cs`); the authoritative server (`dstars.graiani.com`)
is external and closed. **`SwimReader.Server` (`src/SwimReader.Server`, port 5000, the `/dstars` feed) is
therefore our authoritative Dstars server.** It already emits the server→client stream that both the JS
scope and real DGScope clients consume:

- `GET /dstars/{facility}/updates` — newline-delimited JSON (also WebSocket). UpdateType `0`=Track,
  `1`=Flightplan, `2`=Deletion, `3`=WeatherRadar, **`4`=ConflictAlert (our extension; real DGScope
  ignores unknown fields / has no `default` in its switch, so it's safe).**

The DGScope→server command channel is thin and already discovered: the client `POST`s a *partial*
`FlightPlanUpdate` JSON (or `DeletionUpdate`) to **`{baseUrl}update`** i.e. `POST /dstars/{facility}/update`.
Only **five** commands ever touch the wire — everything else is local display state:

| Command | Wire message | Fields |
|---|---|---|
| Initiate handoff | FlightPlanUpdate | `PendingHandoff` |
| Accept / recall handoff | FlightPlanUpdate | `Owner`, `PendingHandoff` |
| Take/return ownership | FlightPlanUpdate | `Owner` |
| Set scratchpad 1/2 | FlightPlanUpdate | `Scratchpad1`, `Scratchpad2` |
| Set aircraft type | FlightPlanUpdate | `AircraftType` |
| Terminate control / drop FP | DeletionUpdate | (guid) |

So "most commands not working" = (a) these 5 need a **server write-path + shared override store +
rebroadcast** (currently the JS mutates local state only), plus (b) missing **alert engines** (MSAW, ATPA)
and a few **render stubs** (PCone, feed-weather, manual SPC, auto-offset, RBL waypoint anchoring).

## Profile / adaptation format (the shared contract)

DGScope facility adaptation is a single XML file deserialized straight into the `RadarWindow` object
(`XmlSerializer`). The owner's `DGScope-profile-manager` generates this exact XML, and it will be produced
server-side eventually — **both sides must use this format.** Example in-repo:
`stars-profiles/ZDC/RDU_TRACON.xml` (an older profile: no CA/MSAW elements, uses `<VideoMapFiles>` refs).

Key elements (element name → meaning; colors are signed ARGB int32):

- **CA suppression** — top-level `<ConflictAlertSuppressionVolumes><CASuppressionVolume>`: `Name`,
  `Active`, `Draw`, `RunwayThreshold{Latitude,Longitude}`, `TrueHeading` (landing dir; corridor runs along
  `TrueHeading+180`), `Length` NM (def 30), `HalfWidth` NM (def 2 → 4 NM total), `FieldElevation` ft,
  `GlideslopeAngle` deg (def 3), `HeightAboveGlideslope` ft (def 1500). Plus tunables
  `<ConflictAlertActive/LookAheadSeconds/HorizontalSeparation/VerticalSeparation/Sound>`,
  `<DrawAllCASuppressionVolumes>`. **This is NOT a polygon — derive the corridor geometrically.**
- **MSAW** — `<MSAWVolumes>` / `<MSAWSuppressionVolumes>` of `<MSAWVolume>`: `Name`,`Active`,`Draw`,
  `Floor`,`Ceiling` (ft MSL; Ceiling = min-safe-alt), `Points` (`GeoPoint` polygon, ray-cast) OR
  `Center`+`Radius` (NM, >0 = circle). Tunables `<MSAWActive/LookAheadSeconds/Sound>`,`<DrawAllMSAWVolumes>`.
- **ATPA** — `<ATPAVolumes><ATPAVolume>`: `RunwayThreshold`,`TrueHeading`,`MaxHeadingDeviation`,`Length` NM,
  `WidthLeft`/`WidthRight` ft, `Floor`/`Ceiling` ft, filters. `<ATPASeparationTable>` overrides the default
  7110.126B CWT table (leader-cat → follower-cat → miles). `<ATPAActive>`, `<DrawATPAMonitorCones>`.
- **Video maps** — `<VideoMapFiles><VideoMapFile>`: `Filepath` (→ external `.geojson`), `MapNumber`,
  `ShortName`, `FullName`, `BrightnessGroup` (A/B), `DCBButton`. Geometry lives in the `.geojson`
  (FeatureCollection; per-map Feature = GeometryCollection of LineStrings; coords `[lon,lat]`; properties
  `name/number/category/mnemonic`). Line colors: `<VideoMapLineColor>` (A), `<VideoMapLineColorB>` (B).
- **Colors** (ARGB int): `BackColor,RangeRingColor,ReturnColor,BeaconColor,DataBlockColor,PointoutColor,
  LDBColor,SelectedColor,OwnedColor,DataBlockEmergencyColor,RBLColor,TPAColor,HistoryColors[]`.
- **Prefs** `<CurrentPrefSet>` (`STARS.PrefSet`): `ScreenCenterPoint`,`Range`,`RangeRingSpacing`,
  altitude filters, `PTL*`,`LeaderLength`,`HistoryNum/Rate`,`Brightness` (17 channels),`DisplayedMaps`.
- `<TCP>`: `Symbol`,`Name`,`HomeLocation`,`DCBMapList` (int[36], -1 = empty; maps DCB buttons → map #s).
- `<HomeLocation>` facility reference point; `<Receivers>` polymorphic receiver list.

Server-side plan: deserialize the **subset we need** into lightweight `[XmlRoot("RadarWindow")]` POCOs
(XmlSerializer maps by element name and ignores the rest — no need to drag DGScope's GL/WinForms deps in).
Video-map geometry is NOT in the XML; load each `VideoMapFile.Filepath` `.geojson` separately.

## Engine specs (faithful ports; all depend on `SweptLocation`/`ExtrapolateTrack`, which our shims cover)

- **CA** (`ConflictAlertSystem.cs`) — DONE server-side (`src/SwimReader.Server/Ca/`). 3 NM / 1000 ft /
  5 s look-ahead, "not increasing" test. Over-triggers because **suppression volumes are empty.**
- **`CASuppressionVolume.Contains(loc, alt)`** — project point to along/cross-track vs reciprocal of
  `TrueHeading`; inside if `0<=along<=Length`, `|cross|<=HalfWidth`, and
  `FieldElevation <= alt <= FieldElevation + tan(GlideslopeAngle)*6076.12*along + HeightAboveGlideslope`.
- **MSAW** (`MSAW.cs`,`MSAWVolume.cs`) — per assoc, non-ground, non-primary, Mode-C, non-inhibited track:
  alert if current OR 30 s-projected point is inside any active MSAW volume and NOT inside a suppression
  volume. Sets `Aircraft.LowAltitude` → JS line-0 "LA".
- **ATPA** (`ATPAVolume.cs`) — order inside-volume aircraft by distance to threshold; per follower compute
  `ATPAMileageNow/24/45` and `ATPARequiredMileage` (CWT table or 3/2.5 NM) → `ATPAStatus`
  Monitor/Caution/Alert. `ATPAMileageNow` on FDB line 3; cones via `DrawATPAMonitorCones`.

## Runway data (for CA suppression fallback + ATPA/MSAW when un-profiled)

CA suppression corridors need runway threshold lat/lon + true heading + field elevation. Most watched
facilities have **no profile yet**, so a profile-only fix won't help them. Plan: load a bundled runway DB
(OurAirports `runways.csv`, public domain: `le_/he_ latitude/longitude/heading_degT/elevation_ft`), and for
each facility auto-generate `CASuppressionVolume`s for runway ends near the facility's live-track bounding
box. Profile `<ConflictAlertSuppressionVolumes>` overrides the fallback when present.

## Execution order (deploy + verify after each)

1. **CA suppression fix** (visible win, no profile authoring needed): port `CASuppressionVolume`, add runway
   DB + per-facility volume generation, wire into `_ca`. Also parse profile CA volumes when present.
2. **Profile XML loader** — POCO subset in `SwimReader.Server`; load `stars-profiles/{facility}.xml`.
3. **MSAW engine** server-side → new UpdateType (or reuse UT=4-style) → JS `_msaw`.
4. **Command write-path** — `POST /dstars/{facility}/update`; controller-override store merged into the
   FP broadcast; rebroadcast UT=1/UT=2 to all facility clients (shared handoff/scratchpad/type/owner/drop).
   JS: swap local-only mutations for POST.
5. **ATPA engine** server-side → mileage/status/cones fields on the FP/track feed → JS render.
6. **Video maps** — server exposes profile geojson refs; JS fetches + renders (A/B colors, DCB buttons).
7. **JS render stubs** — PCone, feed-weather (UT=3) draw, manual SPC entry command, auto-offset render,
   RBL waypoint anchoring (server supplies waypoints/airports).

## File map

- Server engines: `src/SwimReader.Server/Ca/` (CA done; add `CASuppressionVolume`, `Msaw/`, `Atpa/`,
  `Profile/`, `Runways/`). Adapter wiring: `Adapters/DgScopeAdapter.cs` (`CaLoopAsync`, `UpdateCaTrack`).
  Broadcast: `Streaming/ClientConnectionManager.cs`. Write-path: `Controllers/DstarsController.cs`.
- JS: command parser `wwwroot/stars/preview.js`; render/state `scope.js`; handoff `handoff.js`; DCB
  `dcb.js`; SSA `ssa.js`; weather `nexrad.js`; profile `profile.js`. Bump `scope.js?v=` in `scope.html`
  on every JS edit (Cloudflare 4 h cache).
- Reference: DGScope source `../scope` (`scope/RadarWindow.cs` is the 6945-line command core);
  profile format `../DGScope-profile-manager`; STARS docs `docs/crc-stars-reference.md`.
