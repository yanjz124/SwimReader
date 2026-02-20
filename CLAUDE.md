# SwimReader

Real-time FAA SWIM (System Wide Information Management) data platform. Ingests live flight data from multiple FAA data sources via Solace messaging, parses/normalizes it, and serves it through multiple frontends and API services.

## IMPORTANT: Reference Documentation

**Before implementing any ERAM display feature, command, or behavior, ALWAYS read `docs/crc-eram-reference.md` first.** This is the authoritative CRC/vNAS ERAM specification with screenshots. It covers targets, tracks, data blocks, commands, toolbars, NEXRAD, GeoMaps, and all display elements. Images are saved locally in `docs/img/eram/`. This reference should be consulted even after context resets or memory loss — the file is always available in the repository.

**Before implementing any ASDE-X display feature, command, or behavior, ALWAYS read `docs/crc-asdex-reference.md` first.** This is the authoritative CRC/vNAS ASDE-X specification with screenshots. It covers targets, data blocks, safety logic, display control bar, commands, and all ASDE-X display elements. Images are saved locally in `docs/img/asdex/`.

## Architecture Overview

```
                    ┌─────────────────────────────────┐
                    │     FAA SWIM (Solace Broker)     │
                    │  STDDS VPN        FDPS VPN       │
                    │  (TAIS,TDES,      (SFDPS FIXM    │
                    │   SMES,APDS,       en route       │
                    │   ISMC)            flight data)   │
                    └───────┬───────────────┬───────────┘
                            │               │
              ┌─────────────▼──┐    ┌───────▼──────────────────┐
              │  SwimReader     │    │  SfdpsERAM               │
              │  Server         │    │  (standalone, self-      │
              │  (STDDS pipe)   │    │   contained Solace →     │
              │                 │    │   WebSocket bridge)      │
              │  SCDS → Parse → │    │                          │
              │  EventBus →     │    │  Parses FIXM XML inline  │
              │  Adapters →     │    │  FlightState management  │
              │  WebSocket      │    │  WebSocket broadcast     │
              └──┬──────────┬──┘    └──┬────────────────┬──────┘
                 │          │          │                │
           ┌─────▼───┐  ┌──▼────┐  ┌──▼─────┐   ┌─────▼──────┐
           │ DGScope  │  │ Future│  │ ERAM   │   │ Flight     │
           │ /dstars  │  │ FIDO  │  │ Scope  │   │ Table      │
           │ clients  │  │ Strips│  │eram.html   │index.html  │
           │ :5000    │  │       │  │ :5001  │   │ :5001      │
           └──────────┘  └───────┘  ├────────┤   └────────────┘
                                    │ ASDE-X │
                                    │ TDLS   │
                                    │ :5001  │
                                    └────────┘
```

### Data Sources (Parsers)
- **STDDS** — Terminal automation data (TAIS, TDES, SMES, APDS, ISMC) — parsed via `SwimReader.Parsers`
- **SFDPS** — En route flight data (FIXM XML) — parsed inline in `SfdpsERAM/Program.cs`
- Future: additional SWIM data sources as needed

### Frontends / API Services
- **ERAM Scope** (`eram.html`) — Leaflet + Canvas radar display with ERAM-style data blocks
- **Flight Table** (`index.html`) — Tabular real-time flight explorer with filtering, pinning, detail panel
- **DGScope Server** (`/dstars/{facility}/updates`) — HTTP streaming + WebSocket for DGScope radar clients
- **ASDE-X Directory** (`/asdex`) — Airport grid with live track counts, click-through to scope
- **ASDE-X Scope** (`/asdex/{airport}`) — Leaflet map with live surface targets, data blocks, 1s updates
- **TDLS Directory** (`/tdls`) — Airport grid with CPDLC clearance/departure message counts
- **TDLS Detail** (`/tdls/{airport}`) — Aircraft list + CPDLC message history with timestamps
- **FDIO** (`/fdio`) — Flight plan viewer with searchable accordion rows, expandable detail + ATC revision history
- Future: strips, etc.

## Project Structure

```
src/
  SwimReader.Core/            Domain models, events, IEventBus (channel-based fan-out)
  SwimReader.Parsers/         STDDS XML parsers (TAIS, TDES, SMES, APDS, ISMC)
  SwimReader.Scds/            Solace SWIM SCDS connection manager (hosted service)
  SwimReader.Server/          ASP.NET Core server — DGScope adapter, adsb.fi enrichment
    Adapters/                   DgScopeAdapter, TrackStateManager, Dstars JSON models
    AdsbFi/                     adsb.fi integration (callsign enrichment, military injection)
    Controllers/                DstarsController (HTTP stream + WebSocket)
    Streaming/                  ClientConnectionManager (facility-scoped broadcast)
tools/
  SwimReader.SfdpsExplorer/           Console tool — raw SFDPS FIXM message inspection
  SfdpsERAM/                          Standalone web server — SFDPS+STDDS → WebSocket → ERAM/ASDE-X
    Program.cs                          All server logic: Solace (FDPS+STDDS), FIXM parsing, WebSocket, REST
    AsdexBridge.cs                      STDDS/SMES ingestion, AsdexTrack state, WS broadcast (ASDE-X)
    TdlsBridge.cs                       STDDS/TDES ingestion, CPDLC + departure state, WS broadcast (TDLS)
    wwwroot/
      eram.html                         ERAM radar scope (single-file: HTML + CSS + JS)
      index.html                        Flight data table (single-file: HTML + CSS + JS)
      asdex.html                        ASDE-X airport directory (single-file: HTML + CSS + JS)
      asdex-airport.html                ASDE-X airport scope / Leaflet map (single-file: HTML + CSS + JS)
      tdls.html                         TDLS clearance directory (single-file: HTML + CSS + JS)
      tdls-airport.html                 TDLS airport detail — aircraft list + CPDLC messages
      fdio.html                          FDIO flight plan viewer — accordion rows + revision history
      handoff-codes.json                Facility handoff display code mappings (H/O/K suffixes)
      destination-codes.json            Per-ARTCC single-letter destination airport codes
      ERAMv110.ttf                      ERAM font for authentic ATC display
  SwimReader.MessageCapture/          Console tool — captures raw STDDS XML to files
deploy/
  deploy.sh                           Smart deploy — only restarts on backend changes
  check-deploy.sh                     Git polling script for auto-deploy timer
tests/
  SwimReader.Core.Tests/              xUnit tests for core domain
```

## Tech Stack

- .NET 8.0, ASP.NET Core
- Solace messaging (`SolaceSystems.Solclient.Messaging` 10.28.3) — connects to FAA SWIM broker
- Leaflet.js + HTML5 Canvas — radar map display
- ERAM font (`ERAMv110.ttf`) — authentic ATC typography
- WebSocket — real-time browser streaming
- System.Threading.Channels — async backpressure (bounded, drop-oldest)
- System.Xml.Linq — STDDS/FIXM XML parsing
- System.Text.Json — JSON serialization

## Running

### Setup credentials (one-time)
```bash
# Copy .env.example to .env at repo root and fill in your credentials
cp .env.example .env
# Edit .env with your SFDPS, STDDS, and optional ADS-B API keys
```

### SFDPS ERAM (radar display + flight table)
```bash
cd tools/SfdpsERAM
dotnet run
# ERAM scope:   http://localhost:5001/eram.html
# Flight table: http://localhost:5001/index.html
```

### SwimReader Server (STDDS mode, for DGScope)
```bash
cd src/SwimReader.Server
dotnet run
# DGScope connects to http://localhost:5000/dstars/{facility}/updates
```

## Environment Variables

### SFDPS (SfdpsERAM)
| Variable | Description | Default |
|----------|-------------|---------|
| `SFDPS_HOST` | Solace broker URL | `tcps://ems2.swim.faa.gov:55443` |
| `SFDPS_VPN` | Solace VPN name | `FDPS` |
| `SFDPS_USER` | SWIM subscription username | (required) |
| `SFDPS_PASS` | SWIM subscription password | (required) |
| `SFDPS_QUEUE` | Solace queue name | (required) |

### STDDS (SwimReader.Server AND SfdpsERAM)
Both services read these variables. SwimReader.Server also accepts them via `appsettings.json` section `ScdsConnection`.
| Variable | Description | Default |
|----------|-------------|---------|
| `SCDSCONNECTION__HOST` | Solace broker URL | `tcps://ems2.swim.faa.gov:55443` |
| `SCDSCONNECTION__MESSAGEVPN` | Solace VPN | `STDDS` |
| `SCDSCONNECTION__USERNAME` | SWIM username | (required) |
| `SCDSCONNECTION__PASSWORD` | SWIM password | (required) |
| `SCDSCONNECTION__QUEUENAME` | Solace queue | (required) |

**Note:** SfdpsERAM uses `SCDSCONNECTION__*` vars for its `AsdexBridge` STDDS connection (separate Solace session from the FDPS session). If `SCDSCONNECTION__USERNAME` is empty, ASDE-X is silently disabled.

All services search upward for a `.env` file, so a single `.env` at the repo root covers everything. See `.env.example`.

## SFDPS Data Pipeline (SfdpsERAM)

### Message Flow
```
Solace FDPS queue → Raw XML → ProcessFlight() → FlightState (ConcurrentDictionary)
                                                      ↓
                                              BroadcastUpdate() → WebSocket clients
                                                      ↓
                                              eram.html / index.html (browser)
```

### SFDPS Message Types (source attribute)
Discovered from raw NAS FIXM data analysis (500 messages, ~11 seconds, Feb 2026).

**Implemented:**
| Source | Frequency | Description | Key Data |
|--------|-----------|-------------|----------|
| `TH` | ~3247/500 | Track history (batched position updates) | Position, altitude, speed, velocity |
| `OH` | ~97/500 | Ownership/handoff update | Handoff event (INITIATION/ACCEPTANCE/RETRACTION), receiving/transferring units |
| `HZ` | ~63/500 | Heartbeat/position update | Position only (`assignedAltitude` = Mode C, **skipped**) |
| `HP` | ~61/500 | Handoff proposal | Initiates handoff to receiving sector |
| `HX` | ~58/500 | Handoff execution (route transfer) | Route transfer between facilities |
| `AH` | ~40/500 | Assumed/amended handoff (/OK forced) | Forced handoff acceptance, sets HandoffForced flag |
| `LH` | ~18/500 | Local handoff / interim altitude event | Sets/clears interim altitude (`@nil="true"` = clear) |
| `FH` | ~15/500 | Full flight plan update | Canonical state snapshot: aircraft desc, route, altitude |
| `CL` | ~10/500 | Flight plan cancellation/clearance | Flight removal/cleanup |
| `HU` | ~7/500 | Handoff update | Updates handoff state during transition |
| `PT` | ~3/500 | **Point-out** | `<pointout>` with `originatingUnit` + `receivingUnit` (inter-facility) |
| `HT` | ~4/500 | **Handoff transfer with point-out** | `<pointout>` element (intra-facility point-outs) |
| `NP` | rare | New flight plan | New flight entry |
| `BA` | ~1/500 | Beacon code assignment | `<beaconCodeAssignment>` with assigned beacon code |
| `RE` | ~1/500 | Beacon code reassignment | `<beaconCodeAssignment>` with assigned + previous beacon code |

**Discovered but not yet implemented:**
| Source | Frequency | Description | Key Data |
|--------|-----------|-------------|----------|
| `HF` | ~13/500 | Handoff failure | Minimal — callsign, airports, status only |
| `RH` | ~3/500 | Radar handoff (drop) | Flight status = DROPPED |
| `HV` | ~3/500 | Handoff void/complete | Flight status = COMPLETED, actual arrival time |
| `DH` | ~3/500 | Departure handoff | `<coordination>` element with coordinationTime, coordinationTimeHandling |

**Handoff event attribute values (on `<handoff>` element):**
- `INITIATION` — handoff proposed
- `ACCEPTANCE` — handoff accepted
- `RETRACTION` — handoff retracted
- `UPDATE` — handoff state update
- `FAILURE` — handoff failed
- `EXECUTION` — route transfer execution (used with AH for /OK)

**Point-out XML structure (PT/HT messages):**
```xml
<enRoute>
    <pointout>
        <originatingUnit unitIdentifier="ZDV" sectorIdentifier="32"/>
        <receivingUnit unitIdentifier="ZLC" sectorIdentifier="05"/>
    </pointout>
</enRoute>
```

**Clearance (cleared element) XML structure:**
```xml
<enRoute>
    <cleared clearanceHeading="15R" clearanceSpeed="M75" clearanceText="MEDEVAC"/>
</enRoute>
```
- `NasClearedFlightInformationType` — controller-entered heading, speed, and free text
- Heading values: numeric (255, 160), runway (15R, 10R, 20L), PH (published), VK, BL, BR, OR, SLO, CTRL, 4-digit (0348, 0405)
- Speed values: knots (250, 280), Mach (M79, M75), S-prefix (S270, S290), +/- modifiers (280+, M74-)
- Free text: frequencies (128.35), MEDEVAC, NORDO, route mods (D/SYRAH, STYONRTE, RNV1/54, DR/DPR)
- SFDPS clears clearance data by sending a `<cleared>` element with empty/absent attributes. `ProcessFlight()` treats the presence of `<cleared>` as authoritative — any attribute not present is cleared to null
- ~2-3% of flights carry clearance data at any time

**Beacon code assignment (BA/RE messages) XML structure:**
```xml
<enRoute>
    <beaconCodeAssignment>
        <currentBeaconCode>4523</currentBeaconCode>
        <!-- RE messages also include: -->
        <previousBeaconCode>1200</previousBeaconCode>
    </beaconCodeAssignment>
</enRoute>
```
- BA/RE messages set `assignedSquawk` (controller-assigned code) and `squawk` (current code)
- Other messages that carry `<currentBeaconCode>` outside `<beaconCodeAssignment>` only update `squawk` (received/current)
- Field E shows `####` (received code) when squawk differs from assignedSquawk, `NONE` when no squawk received

### Primary Targets / Uncorrelated Tracks
SFDPS does **not** contain true primary-only radar returns. Every SFDPS message requires a GUFI and carries an `aircraftIdentification` (callsign). Uncorrelated radar blips that ERAM cannot associate with a flight record are never published to SFDPS — the correlation happens inside ERAM's sensor processing before SFDPS sees the data.

However, SFDPS does contain **~136 "pseudo-primary" controller-created tracks** with position and callsign but no flight plan (no origin/destination/aircraft type):

| Callsign | Description |
|----------|-------------|
| `TFC` | Controller-tagged uncorrelated traffic — radar target manually associated with callsign "TFC" |
| `BLOCK`/`BLK030`/`BLK050` | Airspace block reservations or training scenarios |
| `JUMP` | Skydiving operations (low altitude, VFR) |
| `BALLOON` | Weather/science balloons (very low ground speed, squawk assigned) |
| `AAA`, `DUKKY`, etc. | Generic placeholders or fix-named reference markers |
| N-numbers (no FP) | VFR aircraft correlated by controller via beacon code, no flight plan filed |
| Military patterns | Gov/mil tracks without civilian flight plan (e.g., `P1460`, `MCI4413`) |

**Data completeness (typical snapshot, ~42K flights):**
- 86% have position (radar track); 14% are flight-plan-only (PROPOSED, not yet departed)
- 5% of positioned flights have no aircraft type (only received TH messages, never FH)
- 11% of positioned flights have no squawk (beacon code comes from FH/BA messages)
- 0% have position without callsign — SFDPS never publishes without `aircraftIdentification`

**Where true primary targets exist** (not in SFDPS):
- **STDDS/STARS** — terminal radar data from TRACONs carries track-level data including uncorrelated targets
- **ASDE-X** — surface movement radar captures all targets regardless of transponder status
- **Raw radar feeds** — internal to STARS/ERAM facilities, not published through SWIM

### FlightState Fields
Core fields tracked per flight (by GUFI):
- Identity: `gufi`, `fdpsGufi`, `callsign`, `computerId`, `computerIds` (per-facility CID map)
- Flight plan: `origin`, `destination`, `aircraftType`, `route`, `star`, `remarks`, `flightRules`
- Position: `latitude`, `longitude`, `groundSpeed`, `trackVelocityX/Y`
- Altitude: `assignedAltitude`, `assignedVfr`, `blockFloor`, `blockCeiling`, `interimAltitude`, `reportedAltitude`
- Ownership: `controllingFacility`, `controllingSector`, `reportingFacility`
- Handoff: `handoffEvent`, `handoffReceiving`, `handoffTransferring`, `handoffAccepting`
- Point-out: `pointoutOriginatingUnit`, `pointoutReceivingUnit` (expire after 3 min via `PointoutTimestamp`)
- Aircraft: `registration`, `wakeCategory`, `modeSCode`, `squawk`, `assignedSquawk`, `equipmentQualifier`
- Clearance (HSF): `clearanceHeading`, `clearanceSpeed`, `clearanceText`, `fourthAdaptedField`
- TMI: `tmiIds` (traffic management initiative IDs — ground stops, slot times, etc.)
- Datalink: `dataLinkCode`, `otherDataLink`, `communicationCode`
- Status: `flightStatus` (ACTIVE, DROPPED, CANCELLED)
- Event log: last 50 state-change events with timestamps

### API Endpoints (SfdpsERAM, port 5001)
| Endpoint | Description |
|----------|-------------|
| `WS /ws` | WebSocket — sends `snapshot`, `update`, `remove`, `stats` messages |
| `GET /api/flights/{gufi}` | Full flight detail + event log |
| `GET /api/stats` | Server stats (total messages, rate, flight count) |
| `GET /api/kml` | List available KML boundary files |
| `GET /api/kml/{name}` | Serve a specific KML file from repo root |
| `GET /api/route/{gufi}` | Resolved route waypoints (lat/lon) from NASR data |
| `GET /api/nasr/status` | NASR data load status, counts, effective date |
| `GET /api/debug/elements` | XML element discovery — all unique FIXM element paths (filter with `?filter=`) |
| `GET /api/debug/raw/{source}` | Raw XML sample for a message source type (e.g., TH, FH, OH) |
| `GET /api/debug/xml-search?q=` | Search raw XML samples for a keyword |
| `GET /api/debug/namevalue-keys` | All unique `nameValue` keys seen in supplementalData |
| `GET /api/debug/cpdlc` | CPDLC-capable flights (datalink code contains "J") |
| `GET /api/debug/clearance` | Flights with clearance data (heading/speed/text) |
| `GET /api/asdex` | Airport directory — `[{airport, count, lat, lon}]` sorted by track count |
| `GET /api/asdex/{airport}` | Full snapshot for one airport — `{airport, tracks:[...]}` |
| `WS /asdex/ws/{airport}` | WebSocket — sends `snapshot`, `batch`, `remove` messages (see ASDE-X section) |
| `GET /api/tdls` | TDLS directory — `[{airport, aircraftCount, messageCount}]` sorted by message count |
| `GET /api/tdls/{airport}` | Full TDLS snapshot — `{airport, aircraft:[...with messages]}` |
| `GET /api/tdls/{airport}/{id}` | Single aircraft message history |
| `WS /tdls/ws/{airport}` | WebSocket — sends `snapshot`, `new` messages (see TDLS section) |
| `GET /fdio` | FDIO flight plan viewer page (reuses `/ws` WebSocket + `/api/flights/{gufi}` for detail) |

### Handoff Detection Logic
Server-side in `Program.cs` ProcessFlight():
1. Handoff events (HP, HU, AH, etc.) set `HandoffEvent`, `HandoffReceiving`, `HandoffTransferring`
2. On every message, checks if `ControllingFacility/Sector` matches `HandoffReceiving`
3. When matched → handoff complete → clears all handoff fields
4. Client-side (eram.html) tracks completed handoffs for 60-second O-indicator rotation

## ERAM Scope Display (`eram.html`)

### Data Block Format (ERAM 5-line with Line 0)
```
  P                    ← Line 0: Point-out indicator (P=pending, A=accepted, between chars 2-3)
 R  AAL123            ← Line 1: Callsign (Column 0: R = non-owned track)
    360C357            ← Line 2: {assigned FL}{status}{reported FL}
    1234 H33           ← Line 3: CID + Field E (groundspeed OR handoff)
    DCA                ← Line 4: Destination (FAA LID)
```
Line 0 only appears when the flight has an active point-out to/from the selected facility. Point-out data from SFDPS expires after 3 minutes (server-side) since SFDPS sends no explicit clear/acceptance signals.

**Point-out indicator behavior (per ERAM spec):**
- `P` (yellow) = pending point-out for both originator and receiver
- `A` (white) = acknowledged point-out (originator side)
- Point-out indicator requires sector-level match (selected sector must be orig or recv sector)
- No sector selected = no point-outs shown
- Dwell box excludes Line 0; FDB→LDB toggle is blocked during active point-out (`<FLID>` → use `QP <FLID>`)
- Client-side 3-minute timeout: point-outs auto-expire if user doesn't interact
- **Click P on line 0** → opens pop-up menu showing sector(s); **Click A on line 0** → removes A indicator from FDB
- **Pop-up menu**: shows `P [sector]`, draggable by title bar
  - Closed by left/middle clicking title bar or X; also closed on map pan/zoom
  - **Originator menu**: receiving sector in yellow with yellow box (pending) → white unboxed (acked)
    - Click pending sector → simulate remote ack (P→A on line 0, menu stays open showing white)
    - Click acked sector → clear point-out, close menu
  - **Receiver menu**: initiating sector in cyan with cyan box (pending) → white unboxed (acked)
    - Click sector → acknowledge PO (MCA: "ACCEPT — ACKNOWLEDGE PO"), P removed from line 0, menu closes

**Line 2 altitude display formats:**
- `{afl}C` = conforming (reported within ±200ft of assigned)
- `{ifl}T{rfl}` = interim altitude assigned (from SFDPS interimAltitude)
- `{afl}↑{rfl}` = climbing to assigned altitude (reported below assigned)
- `{afl}↓{rfl}` = descending to assigned altitude (reported above assigned)
- `{ifl}P{rfl}` = procedure altitude assigned (via QQ P command, local only)
- `{afl}XXXX` = no Mode C data at all
- `VFR` or `VFR/{rfl}` = VFR assigned altitude (from SFDPS `<vfr/>`)
- `VFR/{afl}` = VFR-on-top with altitude (from SFDPS `<vfrPlus>`)
- `{floor}B{ceil}` = block altitude (from SFDPS `<block>`, e.g. `180B240`)

**SFDPS `assignedAltitude` sub-types:**
- `<simple>` (98.5%) — numeric altitude in feet
- `<vfr/>` (0.3%) — VFR flag, no altitude value
- `<vfrPlus>` (1.2%) — VFR-on-top with altitude
- `<block><above>/<below>` (0.04%) — block altitude range; `above` = floor, `below` = ceiling

**HZ `assignedAltitude` = Mode C (radar-reported altitude), NOT controller-assigned.**
HZ heartbeat messages carry the current Mode C reading in the `assignedAltitude` XML field. This causes altitude oscillation if not skipped (e.g., FL240 assigned → 13300 Mode C → FL240 restored by TH). `ProcessFlight()` skips `assignedAltitude` from HZ messages to prevent this.

**Interim altitude** has no sub-types in SFDPS — only `<interimAltitude uom="FEET">value</interimAltitude>`. Procedural/temp/local distinctions (QQ P, QQ L, QQ R) are local ERAM concepts not reflected in the SFDPS feed. Interim is set exclusively by LH messages, cleared by OH (~92%) and FH (~8%) when the element is absent. The `@nil="true"` clear path exists in code but is never observed in practice.

**Line 3 Field E (right side after CID, in priority order):**
- `HIJK` = squawk 7500 (hijack)
- `RDOF` = squawk 7600 (radio failure)
- `EMRG` = squawk 7700 (emergency)
- `ADIZ` = squawk 1276 (ADIZ penetration)
- `LLNK` = squawk 7400 (lost link / UAV)
- `AFIO` = squawk 7777 (military intercept)
- `Hxxx` = handoff proposed to sector xxx (flashing H + sector, alternates with GS)
- `HUNK` = handoff proposed, unknown sector
- `Oxxx` = handoff accepted by sector xxx (steady O + sector, alternates with GS)
- `OUNK` = handoff accepted, unknown sector
- `Kxxx` = handoff forced via /OK to sector xxx (from SFDPS AH message)
- Completed handoff: rotates O/K indicator with groundspeed for 60s
- `CST` = coast track (no position update for >24s)
- `####` = received beacon code differs from assigned (shows actual received code)
- `NONE` = no beacon code received but track has an assigned code
- Normal: `{dest_letter}{groundspeed}` (e.g., `W420` where W=DCA destination code)

### Handoff Facility Codes
Defined in `handoff-codes.json`. Default mappings (e.g., ZDC=W, ZNY=N, ZOB=C) with per-facility overrides (e.g., when viewed from ZDC, PCT shows as "E").

### FDB vs LDB Display
- **FDB (Full Data Block)**: diamond overlay + 4-line data block + leader line + velocity vector
- **LDB (Limited Data Block)**: symbol character only (no diamond) + 2-line callsign/altitude, no leader or vector
- **Dwell emphasis**: FDB gets a yellow box border starting after column 0 (`::before` at 1.5ch); LDB gets a full `outline` around the entire block
- `.ac-db` div carries `fdb` or `ldb` CSS class for targeted styling

### Track Symbols
- `◇` hollow diamond — current position (FDB tracks only, not shown for coast tracks)
- `\` — correlated beacon (squawk + flight plan)
- `/` — uncorrelated beacon (squawk, no flight plan)
- `+` — uncorrelated primary (no squawk)
- `◇` — flight plan aided (flight plan, no squawk)
- `#` — coast track (no position update for >2 scan cycles / 24s)
- `•` — reduced separation (at or below FL230)

### Coast Track Behavior
When a flight misses at least one radar refresh (no position update for >24 seconds), it enters coast mode:
- Position symbol changes to `#` (hash) — rendered as CSS geometry (2H + 2V lines)
- Diamond overlay is hidden (no radar return = no diamond)
- Velocity vector is hidden (stale velocity data)
- Data block stays visible (FDB/LDB as normal)
- History dots continue to decay normally (time-based)
- Recovery: any new position update immediately exits coast mode

### Time-Based History Decay
History symbols age out based on wall-clock time, like real radar:
- Each history point carries a timestamp (`performance.now()` when recorded)
- Render cutoff: `MAX_HISTORY × SCAN_INTERVAL` (e.g., history count 5 × 12s = 60s window)
- Points older than the cutoff are not drawn, regardless of count
- Server snapshots include `Age` (seconds since position) so history reconstructs properly on refresh

### DROPPED Flight Grace Period
DROPPED flights remain visible for 1 minute after the last update, then disappear from the scope. This handles handoff transitions where the old center drops the track before the new center sends position. Server retains flight data for 60 minutes for API queries and event logs.

### Sidebar Controls
- Facility/sector selector (sets scope ownership for handoff display)
- "Facility only" checkbox — strict filter: only show aircraft reported by selected ARTCC
- Data block toggle (full/partial/off)
- History count (0-10 symbols)
- Velocity vector length (0-10 min)
- Boundary layers: UHI, HI, LO, APP with per-category brightness sliders (UHI/HI/LO = long dashes `24 4`, APP = shorter dashes `12 4`)
- NASR overlays: HI Awy, LO Awy, VORs (checkboxes)
- NEXRAD weather radar: NX LVL selector (OFF/3/23/123) + brightness slider (0-100%)
- Font size (8-14px)
- Altitude filter (FL low/high)
- Colors: `#cccc44` (ERAM yellow), `#ff4444` (emergency red)
- 4-second render cycle matching SFDPS ~12s update cadence

### Callsign Deduplication
When a facility is selected, the same physical aircraft may exist as multiple GUFIs (one per ARTCC tracking it). The render loop deduplicates by callsign — for each callsign, only the GUFI whose controlling/reporting facility matches the selected facility is shown. This prevents stacked duplicate targets. Dedup applies to markers, history symbols, and velocity vectors. When "All" is selected (no facility), no dedup is applied.

### Rendering Architecture
- Leaflet markers use `L.divIcon` with custom HTML for position symbol + data block
- Canvas overlay (separate pane, z-index 440) draws history symbols + velocity vectors (vectors FDB only)
- History symbols rendered via `drawSymbolGeometry()` on canvas (CSS geometry, not font)
- Font size adjustable at runtime; CHAR_W and LINE_H scale proportionally (0.625 and 1.25 of font size)
- Leader lines are inline SVGs within the marker div
- URL parameters persist sidebar state (facility, font size, history count, etc.)

### NEXRAD Weather Radar
- Data source: Iowa State Mesonet WMS (n0q composite, 5-min updates)
- Tiles fetched as canvas, pixel colors remapped from NWS palette to ERAM-style:
  - Moderate (greens/yellows in NWS → solid blue `#0044ff`)
  - Heavy (oranges/reds → checkered cyan `#00ccff` and black, alternating pixels)
  - Extreme (dark reds/magentas/purples → solid cyan `#00ccff`)
- NX LVL: OFF (hidden), 3 (extreme only), 23 (heavy+extreme), 123 (all levels)
- Brightness slider controls tile layer opacity (0-100%)
- Custom Leaflet GridLayer in 'nexrad' pane (z-index 250, below boundaries)
- Auto-refreshes every 5 minutes; CORS-enabled canvas pixel manipulation

### MCA Commands (Message Composition Area)
| Command | Action |
|---------|--------|
| `<1-9> <FLID>` | Position data block (numpad layout) |
| `<1-9>/<0-3> <FLID>` | Position data block AND set leader length in one command |
| `// <FLID>` | Toggle VCI (Visual Communications Indicator) |
| `/<0-3> <FLID>` | Set leader line length |
| `QU [min] <FLID...>` | Route display (default 20 min, `/M` = full route) |
| `QU <FLID>` | Clear route for flight (toggle) |
| `QU` | Clear all route displays |
| `QF <FLID>` | Query flight plan → show in Response Area |
| `QD` | Clear Response Area |
| `QL [sector...]` | Quick Look sectors (force FDB); `QL` alone clears |
| `QZ <alt> <FLID>` | Set assigned altitude (e.g. `QZ 350 UAL123`) |
| `QZ VFR[/<alt>] <FLID>` | Set VFR or VFR-with-altitude; `QZ OTP <FLID>` for on-top |
| `QZ <floor>B<ceil> <FLID>` | Set block altitude (e.g. `QZ 180B240 UAL123`) |
| `QQ <alt> <FLID...>` | Set interim altitude; multiple FLIDs: `QQ 110 JBU123/429` |
| `QQ P<alt> <FLID>` | Set procedure altitude |
| `QQ L<alt> <FLID>` | Set local interim altitude |
| `QQ R<alt> <FLID>` | Set interim + reported altitude |
| `QQ <FLID>` | Clear interim/procedure altitude |
| `QR <alt> <FLID>` | Set controller-entered reported altitude |
| `QS <heading> <FLID>` | Set heading (3-digit, 001-360) |
| `QS /<speed> <FLID>` | Set speed |
| `QS \`<text> <FLID>` | Set free text (backtick prefix) |
| `QS * <FLID>` | Clear all HSF data; `*/` = heading only, `/*` = speed only |
| `QS <FLID>` | Toggle HSF display on line 4 |
| `QP A [sector] <FLID>` | Acknowledge point-out (receiver: removes P; originator: P→A) |
| `QP <FLID>` | Clear point-out indicator + FDB→LDB |
| `QX <FLID>` | Drop a track from display (instant timeout — one-way, no restore) |
| `WR R <station>` | Display METAR for station in Response Area (e.g. `WR R DCA` or `WR R KDCA`) |
| `LA <loc1> <loc2> [/<spd>\|T/<spd>\|T]` | Range/bearing between two locations; T = true bearing |
| `LB <fix>[/<spd>] <loc>` | Range/bearing from fix to location |
| `LC <fix>/<time> <track>` | Required speed to reach fix at HHMM zulu time |
| `<FLID>` | Toggle FDB/LDB for flight (blocked during active point-out) |

FLIDs can be callsign, CID, or squawk (beacon code). Per CRC spec: "Aircraft IDs, assigned beacon codes, and CIDs are all FLIDs." Resolution priority: CID (facility-matched) > callsign > squawk, preferring visible flights. When multiple flights share the same CID (e.g., recycled CIDs from dropped flights not yet purged), `findFlight` prefers visible, non-dedup-hidden flights over stale/hidden ones.

**F-key shortcuts:** F1=QF, F2=QP, F4=QX, F5=QZ, F6=QU, F7=QL, F8=QQ, F9=QB; Shift+F2=QD, Shift+F7=WR, Shift+F8=QR. Each clears MCA and inserts the command prefix.

### Track Suppression
Middle-clicking a non-owned track's target symbol toggles: LDB ↔ FDB. `QX <FLID>` is a one-way drop (same as timeout). Hidden tracks (via QX) are cleared on facility change or page refresh. Per CRC spec, middle-clicking a target or map location with an MCA command pending appends the FLID/location and immediately executes (equivalent to left-click + Enter). Left-clicking a target or map location with MCA content inserts a FLID/location placeholder without executing. Locations for LA/LB/LC can be entered by clicking a target (inserts FLID), clicking the map (inserts lat/lon), or typing a callsign/CID/fix/navaid/airport.

### HSF (Heading/Speed/Free text) — Line 4
Line 4 shows controller-assigned heading, speed, and free text data. Two sources merged via `getEffectiveHsf()`:
1. **Server clearance data** — from SFDPS `cleared` element (`clearanceHeading`, `clearanceSpeed`, `clearanceText`)
2. **Local QS overrides** — entered via QS commands in the MCA (local wins per-field)

Display normalization: 3-digit numeric headings get `H` prefix (255→H255), speeds get `S`/`M` prefix. Runway headings (15R), codes (PH, VK) pass through unchanged.

When clearance data exists (from either source), line 3 shows a ↴ indicator. Server clearance data always displays on line 4 without requiring manual toggle; local-only QS data requires toggling via ↴ click or `QS <FLID>`. Free text takes priority (fills line 4); otherwise heading and speed are positioned with speed aligned to the ↴ column.

### NASR Route Resolution
On startup, SfdpsERAM downloads FAA NASR 28-Day Subscription data and parses:
- **NAV_BASE.csv** — VOR/VORTAC/NDB navaids (lat/lon by identifier)
- **FIX_BASE.csv** — Named waypoints/fixes
- **APT_BASE.csv** — Airports (FAA LID + ICAO)
- **AWY_BASE.csv** — Airways with ordered fix sequences (AIRWAY_STRING)
- **STAR_\*.csv / DP_\*.csv** — SID/STAR procedures with fix sequences

Route strings from SFDPS `nasRouteText` are tokenized and resolved:
- `DCT` tokens skipped (direct-to)
- Airways (J/V/Q/T + digits) expanded via AIRWAY_STRING fix traversal
- SID/STAR names matched against procedure database, fix sequences expanded
- All other tokens looked up as navaid → fix → airport (disambiguated by proximity)
- Origin/destination airports added from flight plan fields

Data cached in `nasr-data/{AIRAC-date}/`, auto-refreshed every 24 hours.

### Destination Airport Codes
Per-ARTCC single-letter destination codes in `destination-codes.json`. When a facility is selected, normal Field E shows `{letter}{groundspeed}` (e.g., `W420` where W=DCA). Add more ARTCCs by adding entries to the JSON file.

## ASDE-X Display (SfdpsERAM)

The ASDE-X feature adds live airport surface traffic to SfdpsERAM. It connects a second Solace session to STDDS (SMES topics), maintains per-airport track state, and broadcasts real-time updates to browser clients via WebSocket.

### Architecture

```
STDDS Solace queue → topic filter (SMES/*) → ProcessSmes() → AsdexTrack.MergeFrom()
                                                                     ↓
                                                         _dirty set (per airport)
                                                                     ↓
                          ┌──────────┐         AsdexBridge.FlushDirty() (1s timer)
                          │ /asdex   │◀────────── batch WS message → WsClient queue
                          │ /asdex/  │
                          │ {airport}│         AsdexBridge.PurgeStaleTracks() (10s timer)
                          └──────────┘◀────────── remove WS message → WsClient queue
```

**Key class:** `AsdexBridge` in `tools/SfdpsERAM/AsdexBridge.cs` — fully self-contained; Program.cs creates one instance and calls `Start()` plus the two timer callbacks.

### AsdexBridge Internals

```csharp
class AsdexBridge {
    // airport → trackId → AsdexTrack
    ConcurrentDictionary<string, ConcurrentDictionary<string, AsdexTrack>> _state;
    // airport → clientId → WsClient
    ConcurrentDictionary<string, ConcurrentDictionary<string, WsClient>> _clients;
    // airports modified since last FlushDirty()
    ConcurrentDictionary<string, byte> _dirty;
}
```

- `Start()` — launches background `StddsReceiver` thread with 90s silence watchdog + auto-reconnect
- `FlushDirty()` — called every 1s; sends `{type:"batch", data:[...tracks]}` to all clients of dirty airports
- `PurgeStaleTracks()` — called every 10s; removes tracks not seen in 45s, sends `{type:"remove", data:{airport,trackId}}` to clients
- `AddClient(airport, wsClient)` — registers client, sends immediate full `snapshot`, returns clientId
- `RemoveClient(airport, clientId)` — unregisters client
- `GetDirectory()` — returns `[{airport, count, lat, lon}]` sorted by track count
- `GetSnapshot(airport)` — returns `{airport, tracks:[...]}`

### AsdexTrack

```csharp
class AsdexTrack {
    string Airport, TrackId;
    string? Callsign, Squawk, AircraftType, TargetType;  // "aircraft"/"vehicle"/"unknown"
    double Latitude, Longitude;
    double? AltitudeFeet, HeadingDegrees;
    int? SpeedKts;
    string? EramGufi;
    DateTime LastSeen;
    void MergeFrom(double lat, double lon, string? callsign, string? squawk,
                   string? acType, string? tgtType, double? alt, int? speed,
                   double? heading, string? eramGufi);  // only overwrites non-null
    object ToJson();  // trackId, callsign, squawk, acType, tgtType, lat, lon,
                      // altFt, spdKts, hdg, eramGufi, ageSec
}
```

**Merge semantics:** Position (lat/lon) always updated. All other fields only overwrite when incoming value is non-null. This handles partial `positionReport full="false"` updates that carry only position without identity.

### WebSocket Protocol (`/asdex/ws/{airport}`)

All messages are JSON. `{airport}` in the URL is case-insensitive (normalized to uppercase).

| Message type | Direction | Shape |
|---|---|---|
| `snapshot` | server → client | `{type:"snapshot", data:{airport, tracks:[...AsdexTrack.ToJson()]}}` |
| `batch` | server → client | `{type:"batch", data:[...AsdexTrack.ToJson()]}` — all current tracks for dirty airports |
| `remove` | server → client | `{type:"remove", data:{airport, trackId}}` — track purged (45s timeout) |

- `snapshot` sent immediately on WebSocket connect (no waiting for next dirty flush)
- `batch` sent every 1s for airports with any position update; contains ALL current tracks (not just changed ones)
- Client reconnects every 5s on disconnect

**Route registration order matters:** `/asdex/ws/{airport}` must be registered in Program.cs BEFORE `/asdex/{airport}` so ASP.NET Core's literal-over-parameter preference gives "ws" to the WebSocket handler.

### Solace SDK Init (critical)

`ContextFactory.Instance.Init()` must be called exactly once before any Solace session is created. It is called at top-level in Program.cs before both the FDPS thread and AsdexBridge.Start(), so there is no race condition. The Init block was deliberately moved out of the solaceThread lambda when AsdexBridge was added.

### Target Rendering (`asdex-airport.html`)

Uses Leaflet `L.divIcon` with inline SVG. The icon size is `[200, 18]`, `iconAnchor: [9, 9]` (center of 18×18 symbol).

**Target categories (function `targetCategory(t)`):**
1. `unknown` — `tgtType === 'unknown'` OR no callsign and no squawk
2. `vehicle` — `tgtType === 'vehicle'`
3. `heavy` — has callsign, aircraft type matches heavy prefixes or B757 codes
4. `aircraft` — everything else with a callsign

**SVG paths (viewBox -9 -9 18 18, nose/top at 0,0):**
```javascript
// Aircraft (nose up = heading 0°/north)
PLANE_PATH = 'M 0 -8 L 1.3 -5 L 1.3 -1 L 8 2 L 7.5 3 L 1.8 1.5 L 1.8 5 L 4 7 L 0 6 L -4 7 ...'
// Unknown (kite — smaller than aircraft, pointy bottom)
DIAMOND_PATH = 'M 0 3.5 L 2.5 0.5 L 0 -4.5 L -2.5 0.5 Z'
// Vehicle (square)
VEHICLE_PATH = 'M -4 -4 L 4 -4 L 4 4 L -4 4 Z'
```

**Colors:**
- Aircraft: white `#ffffff`
- Heavy/B757: orange `#ff8c00`
- Unknown: cyan `#00ffff`
- Vehicle: cyan `#00cccc` at 75% opacity

**Rotation:** Aircraft SVG is rotated via `<g transform="rotate(${hdg})">` inline — not CSS, so it works across all browsers and doesn't require marker re-creation.

**Heavy type detection (client-side, ICAO type code):**
```javascript
const HEAVY_PREFIXES = ['B74','B77','B78','A33','A34','A35','A38','A30',
                        'A22','C17','C5M','IL7','AN1','DC8','L101'];
const B757_CODES = ['B752','B753','B757'];
```

**Data block (`.db` div, NE offset from target center):**
- Line 1 (`.db-line1`, ERAM yellow): `{callsign || squawk || '????'}  {altFt/100 padded to 3 digits}`
- Line 2 (`.db-line2`, grey `#aaa`): `{acType}  {spdKts/10 padded to 2 digits}`
- Omitted for `unknown` and `vehicle` targets (only line 1 with callsign/squawk)

**Data block positions (8 compass points):** Leader lines radiate from target center (9,9) to the data block. N/S lines are vertical (lx=9), E/W are horizontal (ly=9), diagonals go to corners. Data block wrap position (`wl`, `wt`) places the text div relative to icon anchor. Default position is NE. Left-click target symbol toggles data block visibility; drag data block to snap to nearest octant.

**Leader line:** SVG line from target center to data block position, `#00cc00` at 60% opacity. Hidden for unknown targets.

**Font size:** Adjustable via FONT input in status bar (8-20px, default 13). Changes invalidate all track hashes so icons rebuild on next batch.

**Change detection:** `trackHash(t)` hashes `lat, lon, callsign, altFt, spdKts, hdg, tgtType, acType, wake`. Only calls `setIcon()` (expensive) when hash changes; otherwise just `setLatLng()`.

**Auto-center:** On first snapshot, map centers on centroid of all tracks. Subsequent updates do not reposition the map.

### Directory Page (`asdex.html`)

- Polls `GET /api/asdex` every 5 seconds
- CSS grid of airport cards, sorted by track count descending
- Each card: ICAO code (22px, `#cccc44`), known airport name lookup, track count
- Click → `/asdex/{icao.toLowerCase()}`
- `AIRPORT_NAMES` dict for ~41 known airports; unknown airports show blank name
- ERAM dark style: `#111` background, `#cccc44` text, ERAM font

### Track Purge Timing

| Timer | Interval | Action |
|---|---|---|
| `FlushDirty` | 1s | Broadcast all tracks for dirty airports |
| `PurgeStaleTracks` | 10s | Remove tracks with `LastSeen > 45s ago`, notify clients |

Client-side purge: none implemented (server handles it authoritatively via `remove` messages).

## TDLS Display (SfdpsERAM)

The TDLS feature displays CPDLC (Controller-Pilot Data Link Communications) clearances and tower departure events from the TDES (Tower Departure Event Service) STDDS feed. It shares the STDDS Solace session with AsdexBridge via the `OnOtherMessage` callback — Solace queues deliver each message to one consumer, so a shared session is required.

### Architecture

```
STDDS Solace queue → AsdexBridge (SMES/* → ASDE-X processing)
                   → OnOtherMessage callback (non-SMES topics)
                         ↓
                   TdlsBridge (TDES/* → TDLS processing)
                         ↓
               ┌─ TDLSCSPMessage → CPDLC clearance (PDC/DCL)
               ├─ TowerDepartureEventMessage → gate/taxi/takeoff
               └─ DATISData → ignored (airport-level, not per-aircraft)
                         ↓
                   _pending bag (per airport)
                         ↓
               FlushDirty() (1s timer) → "new" WS message → clients
```

### Key Class: `TdlsBridge` (`tools/SfdpsERAM/TdlsBridge.cs`)

**State:** `ConcurrentDictionary<string, ConcurrentDictionary<string, TdlsAircraft>>` — airport → aircraftId → aircraft with message list.

**Data models:**
- `TdlsMessage` — one CPDLC or departure event: type, time, airport, aircraftId, beaconCode, aircraftType, CID, destination, dataHeader/dataBody (CPDLC), gate/runway/OOOI times (departure), eramGufi
- `TdlsAircraft` — per-aircraft container: aircraftId, latest acType/destination/beacon, ordered message list, lastSeen timestamp

### TDES Message Types

| Root Element | Type | Key Fields |
|---|---|---|
| `TDLSCSPMessage` | `CPDLC` | time (MMddyyyyHHmmss), airportID, aircraftID, dataHeader, dataBody (clearance text), enhancedData |
| `TowerDepartureEventMessage` | `DEPART` | eventTime (ISO), departureAirport, aircraftID, parkingGate, clearanceDeliveryTime, taxiStartTime, takeoffTime, takeoffRunway |
| `DATISData` | — | Ignored (D-ATIS is airport-level, not per-aircraft) |

### CPDLC `dataBody` Format

Each TDLSCSPMessage has its own dataBody starting with a 3-digit sequence number:
```
001 ASA1158 3607 PHNL B712/G P0540 450 210 PHNL PALAY3 LNY VECKI9 PHKO
@PBN/A1B1C1D1O1S1 NA V/Z1Z*** CLEARED PALAY3 DEPARTURE LNY TRSN TURN RIGHT HDG
155 MAINTAIN 5000FT EXP 210 10 MIN AFT DP.DPFRQ 118.3 CTC GND CONTROL 121.9
ADVISE ATIS AND BCN CODE
```
The sequence number (e.g., `001`) is only at the very beginning of each message body. 3-digit numbers mid-text (like `155` for heading, `210` for altitude, `450` for CID) are data values, not sequence delimiters. The client-side parser strips the leading sequence number and identifies pilot responses vs clearance text.

### WebSocket Protocol (`/tdls/ws/{airport}`)

| Message type | Direction | Shape |
|---|---|---|
| `snapshot` | server → client | `{type:"snapshot", data:{airport, aircraft:[...TdlsAircraft.ToJson()]}}` |
| `new` | server → client | `{type:"new", data:[...TdlsMessage.ToJson()]}` — new messages since last flush |

### Frontend Pages

**`tdls.html`** — Directory page at `/tdls`:
- Polls `GET /api/tdls` every 5s
- Airport cards with aircraft count and message count
- Click → `/tdls/{airport}`

**`tdls-airport.html`** — Airport detail at `/tdls/{airport}`:
- Two-panel layout: aircraft list (left) + message history (right)
- Aircraft sorted by most recent message (newest on top); flash animation on new messages
- Active/historical divider: aircraft not seen in 2+ hours shown below a `HISTORICAL` separator with dimmed styling
- Left panel shows callsign, message count badge, acType/destination, and most recent message timestamp (green)
- CPDLC messages: single message body with leading sequence number stripped; pilot responses (green) and clearance text (white)
- Departure events: gate, runway, OOOI timeline (CLR → TAXI → T/O)
- WebSocket real-time updates, 5s reconnect on disconnect
- Black background, white text, ERAM monospace font (embedded as base64 data URI)

### Timers

| Timer | Interval | Action |
|---|---|---|
| `FlushDirty` | 1s | Send new messages to WebSocket clients |
| `PurgeStale` | 60s | No-op — all aircraft and messages retained indefinitely |

## FDIO Display (SfdpsERAM)

The FDIO (Flight Data Input/Output) page provides a searchable, accordion-style flight plan viewer. It reuses the existing SFDPS WebSocket and REST infrastructure — no new server endpoints.

### Architecture
- **Data source**: existing `/ws` WebSocket (snapshot + batch + remove + stats)
- **Detail/events**: on-demand `GET /api/flights/{gufi}` when row is expanded
- **No deduplication**: all GUFIs shown, even duplicate callsigns from different ARTCCs

### Page Layout (`fdio.html`)
- **Top bar**: FDIO title, connection status, flight count + message rate
- **Filter bar**: search box (callsign/CID/airport/type/squawk/route), status filter (Active default), facility dropdown, flight rules filter
- **Flight list**: sortable column headers, one row per GUFI
- **Collapsed row**: callsign, type, dep, arr, altitude (FL/VFR/block), rules, sector, squawk, status dot
- **Expanded row** (click to toggle): flight plan detail grid + revision history (event log newest-first)

### Event Log Enhancement
`BuildEventSummary()` for FH (flight plan update) messages now generates enriched summaries including aircraft type, origin-destination, altitude, and STAR — e.g., `"FP: B738 KDFW-KJFK FL360 LENDY6"` instead of generic `"Flight plan update"`. Other event types (OH, LH, PT, BA, etc.) are unchanged.

### Event Source Color Coding
| Source | Color | Description |
|--------|-------|-------------|
| FH | white | Flight plan update (enriched summary) |
| OH/HP/AH/HU/HX | blue | Handoff events |
| LH | orange | Interim altitude |
| TH/HZ | dim grey | Position updates (low priority) |
| BA/RE | grey | Beacon code events |

## STDDS Data Pipeline (SwimReader.Server)

### Message Flow
```
Solace STDDS queue → RawMessageEvent → ChannelEventBus → ParserPipeline
                                                              ↓
                                              Domain events (TrackPosition, FlightPlan, etc.)
                                                              ↓
                                                     ChannelEventBus
                                                              ↓
                                                     DgScopeAdapter
                                                              ↓
                                              ClientConnectionManager → DGScope clients
```

### STDDS Parsers
| Parser | Service | Produces |
|--------|---------|----------|
| `TaisMessageParser` | TAIS | `TrackPositionEvent` + `FlightPlanDataEvent` |
| `TdesMessageParser` | TDES | `DepartureEvent` or `FlightPlanDataEvent` |
| `SmesMessageParser` | SMES | `SurfaceMovementEvent` |
| `ApdsMessageParser` | APDS | Alert/planning events |
| `IsmcMessageParser` | ISMC | Information service events |

### Domain Events
All implement `ISwimEvent` (Timestamp, Source):
- `RawMessageEvent` — pre-parsed XML from SCDS
- `TrackPositionEvent` — position, altitude, speed, squawk, Mode S, facility
- `FlightPlanDataEvent` — callsign, airports, route, scratchpads, owner, handoff
- `DepartureEvent` — gate out, taxi start, takeoff times
- `SurfaceMovementEvent` — ASDE-X surface tracking (Airport, TrackId, Callsign, Squawk, AircraftType, TargetType, Position, AltitudeFeet, GroundSpeedKnots, HeadingDegrees, EramGufi, IsFull)

### SMES Data Pipeline (ASDE-X)

SMES publishes surface movement data from ASDE-X sensors at ~35 major US airports.

**Topic structure:** `SMES/all/false/{type}/{airport}/{tracon}`
| Type | Description | Root element |
|------|-------------|--------------|
| `AT` | All-targets batch | `<asdexMsg>` with `<positionReport>` |
| `AD` | ADS-B delta update | `<asdexMsg>` with `<adsbReport>` |
| `SE` | Surface event (subset) | `<asdexMsg>` with `<positionReport>` |
| `SH` | Safety logic hold bar | `<SafetyLogicHoldBar>` (ignored) |

**`<positionReport full="true">` fields (full reports):**
```xml
<positionReport full="true">
  <seqNum>224</seqNum>
  <time>2026-02-19T23:28:58.000Z</time>
  <track>238</track>           <!-- ASDE-X track number = TrackId -->
  <stid>121633</stid>
  <flightId>
    <aircraftId>UAL521</aircraftId>   <!-- callsign -->
    <mode3ACode>3112</mode3ACode>     <!-- squawk -->
  </flightId>
  <flightInfo>
    <tgtType>aircraft</tgtType>       <!-- aircraft / vehicle / unknown -->
    <acType>B738</acType>
    <wake>F</wake>
  </flightInfo>
  <position>
    <latitude>29.97787</latitude>
    <longitude>-95.17029</longitude>
    <altitude>1943.75</altitude>      <!-- feet MSL -->
  </position>
  <movement>
    <speed>197</speed>                <!-- knots -->
    <heading>270.25</heading>         <!-- degrees true, float precision -->
  </movement>
  <enhancedData>
    <eramGufi>KH757045K8</eramGufi>   <!-- links to SFDPS flight -->
  </enhancedData>
</positionReport>
```

**`<positionReport full="false">`** — only changed fields present; identity fields absent.

**`<adsbReport>` (AD messages)** — ADS-B updates; uses `<lat>`/`<lon>` (not `<latitude>`/`<longitude>`). `full="true"` reports carry rich identity data in `<enhancedData>` and `<descriptor>`:
```xml
<adsbReport full="true">
  <report><basicReport>
    <time>...</time>
    <track>1671</track>
    <position><lat>33.6438</lat><lon>-84.43643</lon></position>
  </basicReport>
  <mode3ACode><code>7275</code></mode3ACode>
  <acAddress>AC9ABC</acAddress></report>
  <descriptor><tot>aircraft</tot></descriptor>
  <enhancedData>
    <eramGufi>KT060616ui</eramGufi>
    <sfdpsGufi>us.fdps.2026-02-20T01:41:01Z.000/19/6ui</sfdpsGufi>
    <callsign>DAL1663</callsign>
    <departureAirport>KATL</departureAirport>
    <destinationAirport>KCHS</destinationAirport>
    <aircraftType>B739</aircraftType>
  </enhancedData>
</adsbReport>
```

AsdexBridge parses from AD messages: `eramGufi`, `callsign`, `aircraftType` (from `enhancedData`), `squawk` (from `mode3ACode/code`), and `tgtType` (from `descriptor/tot`). This enriches tracks that would otherwise appear as identity-less unknowns from partial position-only updates.

**Active ASDE-X airports (observed in SWIM):**
KATL, KBDL, KBOS, KBWI, KCLE, KCLT, KCVG, KDCA, KDEN, KDFW, KDTW, KEWR, KFLL, KHOU, KIAH, KJFK, KLAS, KLAX, KMCO, KMEM, KMIA, KMKE, KMDW, KMSP, KMSY, KORD, KPDX, KPHL, KPHX, KPIT, KPVD, KSAN, KSDF, KSEA, KSFO, KSLC, KSNA, KSTL, KTPA, PANC, PHNL

### Key Classes
- `ChannelEventBus` — bounded channels (10K) per subscriber, drop-oldest backpressure
- `TrackStateManager` — maps (ModeSCode, TrackNumber, Facility) → stable GUID; 5-min stale purge
- `ClientConnectionManager` — facility-scoped WebSocket/HTTP stream broadcast
- `DgScopeAdapter` — converts domain events to Dstars JSON (UpdateType 0/1/2)

### adsb.fi Integration (optional)
Configured in `appsettings.json` under `AdsbFi`:
- `CallsignEnrichmentService` — enriches STDDS tracks with callsigns from adsb.fi
- `MilitaryInjectionService` — polls for military aircraft in configured geofence areas
- Rate-limited with caching (hex: 5min TTL, geo: 30s TTL)

## KML Sector Boundaries

Place KML files in the repo root (gitignored, not committed):
- `AllSectors.kml` — auto-loaded by eram.html via `/api/kml/AllSectors.kml`
- `AllHighSectors.kml`, `AllLowSectors.kml` — available via API, toggleable in sidebar
- KML categories parsed from `<name>` tags: UHI (ultra-high), HI (high), LO (low), APP (approach)

## Important Conventions

- Altitudes in SFDPS/STDDS are in **feet**; displayed as flight levels (FL360 = 36,000 ft)
- Altitude filter uses FL notation: Low FL 180, High FL 360 = 18,000-36,000 ft
- ICAO airport codes converted to FAA LIDs (KDCA → DCA) in server adapter
- Track colors: `#cccc44` (ERAM yellow), `#ff4444` (emergency red), `#555555` (boundary grey)
- SFDPS data rate: ~240 msg/sec, updating ~4000-7000 active flights at any time
- Each flight updates roughly every 12 seconds
- CID (Computer ID) is per-facility — each ARTCC assigns its own; stored in `computerIds` map. `getCid()` only returns the selected facility's CID; foreign facility CIDs are never shown (matches real ERAM behavior)
- All frontend rendering is single-file HTML (JS + CSS inlined), no build step or framework

## Building

```bash
dotnet build SwimReader.sln
dotnet test
```

Individual projects:
```bash
dotnet build src/SwimReader.Server
dotnet build tools/SfdpsERAM
```

## Deployment (Raspberry Pi)

### Host
- **Pi**: `JY@JY5` (Debian 12 bookworm, ARM64, 4 cores, 3.7GB RAM)
- **SSH**: `ssh JY@JY5` (no password needed)
- **.NET 8**: installed at `/home/JY/.dotnet`
- **Repo**: `/home/JY/SwimReader`
- **Credentials**: `/home/JY/SwimReader/.env` (same format as local `.env`)

### Systemd Services
| Service | Unit | Port | Working Directory |
|---------|------|------|-------------------|
| SfdpsERAM | `sfdps-eram.service` | 5001 | `tools/SfdpsERAM` |
| SwimReader.Server (STDDS) | `swimreader-stdds.service` | 5000 | `src/SwimReader.Server` |

```bash
# Check status
sudo systemctl status sfdps-eram
sudo systemctl status swimreader-stdds

# Restart
sudo systemctl restart sfdps-eram
sudo systemctl restart swimreader-stdds

# Logs
journalctl -u sfdps-eram -f
journalctl -u swimreader-stdds -f
```

### Auto-Deploy (Smart)
- **Timer**: `swimreader-deploy.timer` polls `origin/master` every 60 seconds
- **Scripts**: `deploy/check-deploy.sh` (git poll) and `deploy/deploy.sh` (smart deploy) — in repo, auto-updated via git
- **Smart restart**: Only restarts services when `.cs`/`.csproj` files change. Frontend-only changes (`wwwroot/`) take effect immediately without restart (ASP.NET serves static files from disk).
- **CI**: GitHub Actions workflow (`.github/workflows/ci.yml`) runs build + test on push/PR to master

```bash
# Check deploy timer
systemctl list-timers swimreader-deploy.timer

# View deploy logs
journalctl -u swimreader-deploy.service --no-pager -n 30

# Manual deploy
/home/JY/SwimReader/deploy/deploy.sh
```

### Flight State Cache
On shutdown (SIGTERM) and every 5 minutes, all flight data is serialized to `flight-cache/flights.json`. On startup, the cache is loaded before Solace connects, so flights survive restarts with no data loss. Cache older than 60 minutes is discarded (matches purge timer).

### Cloudflare Tunnel
- **Tunnel ID**: `07b88be3-c0eb-423b-97d4-57bde0bb21da`
- **Config**: `~/.cloudflared/config.yml`
- **Service**: `cloudflared.service`
- **Route**: `swim.vncrcc.org` → `http://127.0.0.1:5001` (SfdpsERAM)

**DNS (manual step in Cloudflare dashboard):**
- CNAME `swim` → `07b88be3-c0eb-423b-97d4-57bde0bb21da.cfargotunnel.com` (proxied)

**Public URLs (once DNS is configured):**
- ERAM scope: `https://swim.vncrcc.org/eram.html`
- Flight table: `https://swim.vncrcc.org/index.html`
- Stats API: `https://swim.vncrcc.org/api/stats`
- ASDE-X directory: `https://swim.vncrcc.org/asdex`
- ASDE-X scope: `https://swim.vncrcc.org/asdex/{airport}` (e.g., `/asdex/kdca`)
- ASDE-X API: `https://swim.vncrcc.org/api/asdex`
- TDLS directory: `https://swim.vncrcc.org/tdls`
- TDLS airport: `https://swim.vncrcc.org/tdls/{airport}` (e.g., `/tdls/kord`)
- TDLS API: `https://swim.vncrcc.org/api/tdls`

**Not yet exposed externally:**
- STDDS/DGScope on port 5000 — needs either a reverse proxy or separate tunnel hostname to expose `/dstars` paths

### Sudoers
JY can restart swim services without password (`/etc/sudoers.d/swimreader`):
```
JY ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart sfdps-eram
JY ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart swimreader-stdds
```
