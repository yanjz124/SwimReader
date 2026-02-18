# SwimReader

Real-time FAA SWIM (System Wide Information Management) data platform. Ingests live flight data from multiple FAA data sources via Solace messaging, parses/normalizes it, and serves it through multiple frontends and API services.

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
           │ :5000    │  │ ASDEX │  │ :5001  │   │ :5001      │
           └──────────┘  │ TDLS  │  └────────┘   └────────────┘
                         └───────┘
```

### Data Sources (Parsers)
- **STDDS** — Terminal automation data (TAIS, TDES, SMES, APDS, ISMC) — parsed via `SwimReader.Parsers`
- **SFDPS** — En route flight data (FIXM XML) — parsed inline in `SfdpsERAM/Program.cs`
- Future: additional SWIM data sources as needed

### Frontends / API Services
- **ERAM Scope** (`eram.html`) — Leaflet + Canvas radar display with ERAM-style data blocks
- **Flight Table** (`index.html`) — Tabular real-time flight explorer with filtering, pinning, detail panel
- **DGScope Server** (`/dstars/{facility}/updates`) — HTTP streaming + WebSocket for DGScope radar clients
- Future: FIDO, strips, ASDEX, TDLS, etc.

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
  SfdpsERAM/                          Standalone web server — SFDPS → WebSocket → ERAM/table
    Program.cs                          All server logic: Solace, FIXM parsing, WebSocket, REST
    wwwroot/
      eram.html                         ERAM radar scope (single-file: HTML + CSS + JS)
      index.html                        Flight data table (single-file: HTML + CSS + JS)
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

### STDDS (SwimReader.Server)
Configured via `appsettings.json` section `ScdsConnection` or environment variables:
| Variable | Description | Default |
|----------|-------------|---------|
| `SCDSCONNECTION__HOST` | Solace broker URL | `tcps://ems2.swim.faa.gov:55443` |
| `SCDSCONNECTION__MESSAGEVPN` | Solace VPN | `STDDS` |
| `SCDSCONNECTION__USERNAME` | SWIM username | (required) |
| `SCDSCONNECTION__PASSWORD` | SWIM password | (required) |
| `SCDSCONNECTION__QUEUENAME` | Solace queue | (required) |

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
| `HZ` | ~63/500 | Heartbeat/position update | Position, assigned altitude |
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

**Discovered but not yet implemented:**
| Source | Frequency | Description | Key Data |
|--------|-----------|-------------|----------|
| `HF` | ~13/500 | Handoff failure | Minimal — callsign, airports, status only |
| `RH` | ~3/500 | Radar handoff (drop) | Flight status = DROPPED |
| `HV` | ~3/500 | Handoff void/complete | Flight status = COMPLETED, actual arrival time |
| `DH` | ~3/500 | Departure handoff | `<coordination>` element with coordinationTime, coordinationTimeHandling |
| `BA` | ~1/500 | Beacon code assignment | `<beaconCodeAssignment>` with `currentBeaconCode` |
| `RE` | ~1/500 | Beacon code reassignment | `<beaconCodeAssignment>` with `currentBeaconCode` + `previousBeaconCode` |

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
- SFDPS does **not** send explicit clear signals — values persist until flight drops/purges; values do update (CHANGED events observed)
- ~2-3% of flights carry clearance data at any time

### FlightState Fields
Core fields tracked per flight (by GUFI):
- Identity: `gufi`, `fdpsGufi`, `callsign`, `computerId`, `computerIds` (per-facility CID map)
- Flight plan: `origin`, `destination`, `aircraftType`, `route`, `star`, `remarks`, `flightRules`
- Position: `latitude`, `longitude`, `groundSpeed`, `trackVelocityX/Y`
- Altitude: `assignedAltitude`, `assignedVfr`, `blockFloor`, `blockCeiling`, `interimAltitude`, `reportedAltitude`
- Ownership: `controllingFacility`, `controllingSector`, `reportingFacility`
- Handoff: `handoffEvent`, `handoffReceiving`, `handoffTransferring`, `handoffAccepting`
- Point-out: `pointoutOriginatingUnit`, `pointoutReceivingUnit` (expire after 3 min via `PointoutTimestamp`)
- Aircraft: `registration`, `wakeCategory`, `modeSCode`, `squawk`, `equipmentQualifier`
- Clearance (HSF): `clearanceHeading`, `clearanceSpeed`, `clearanceText`, `fourthAdaptedField`
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
- **Pop-up menu** (click P or A on line 0): shows `P [sector]`, draggable by title bar
  - Closed by left/middle clicking title bar or X; also closed on map pan/zoom
  - **Originator menu**: receiving sector in yellow with yellow box (pending) → white unboxed (acked)
    - Click pending sector → simulate remote ack (P→A on line 0, menu stays open showing white)
    - Click acked sector → clear point-out, close menu
  - **Receiver menu**: initiating sector in cyan with cyan box (pending) → white unboxed (acked)
    - Click sector → acknowledge PO (MCA: "ACCEPT — ACKNOWLEDGE PO"), P removed from line 0, menu closes
    - Receiver `A` on line 0 (if somehow present) → click removes indicator

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
- Normal: `{dest_letter}{groundspeed}` (e.g., `W420` where W=DCA destination code)

### Handoff Facility Codes
Defined in `handoff-codes.json`. Default mappings (e.g., ZDC=W, ZNY=N, ZOB=C) with per-facility overrides (e.g., when viewed from ZDC, PCT shows as "E").

### FDB vs LDB Display
- **FDB (Full Data Block)**: diamond overlay + 4-line data block + leader line + velocity vector
- **LDB (Limited Data Block)**: symbol character only (no diamond) + 2-line callsign/altitude, no leader or vector
- **Dwell emphasis**: FDB gets a yellow box border starting after column 0 (`::before` at 1.5ch); LDB gets a full `outline` around the entire block
- `.ac-db` div carries `fdb` or `ldb` CSS class for targeted styling

### Track Symbols
- `◇` hollow diamond — current position (FDB tracks only)
- `\` — correlated beacon history (squawk + flight plan)
- `/` — uncorrelated beacon history (squawk, no flight plan)
- `+` — uncorrelated primary history (no squawk)
- `◇` — flight plan aided history (flight plan, no squawk)

### Sidebar Controls
- Facility/sector selector (sets scope ownership for handoff display)
- "Facility only" checkbox — strict filter: only show aircraft reported by selected ARTCC
- Data block toggle (full/partial/off)
- History count (0-10 symbols)
- Velocity vector length (0-10 min)
- Boundary layers: UHI, HI, LO, APP with per-category brightness sliders
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
- History symbols rendered via `ctx.fillText()` using ERAM font on canvas
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
| `QP A <FLID>` | Acknowledge point-out (receiver: removes P; originator: P→A) |
| `QP <FLID>` | Clear point-out indicator entirely |
| `<FLID>` | Toggle FDB/LDB for flight (blocked during active point-out) |

FLIDs can be callsign or CID (CID only matches selected facility). When multiple flights share the same CID (e.g., recycled CIDs from dropped flights not yet purged), `findFlight` prefers visible, non-dedup-hidden flights over stale/hidden ones.

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
- `SurfaceMovementEvent` — ASDE-X surface tracking

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
- CID (Computer ID) is per-facility — each ARTCC assigns its own; stored in `computerIds` map
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
- **Tunnel ID**: `8cab2eab-8319-42c6-9540-1aa288323b86`
- **Config**: `~/.cloudflared/config.yml`
- **Service**: `cloudflared.service`
- **Route**: `swim.vncrcc.org` → `http://127.0.0.1:5001` (SfdpsERAM)

**DNS (manual step in Cloudflare dashboard):**
- CNAME `swim` → `8cab2eab-8319-42c6-9540-1aa288323b86.cfargotunnel.com` (proxied)

**Public URLs (once DNS is configured):**
- ERAM scope: `https://swim.vncrcc.org/eram.html`
- Flight table: `https://swim.vncrcc.org/index.html`
- Stats API: `https://swim.vncrcc.org/api/stats`

**Not yet exposed externally:**
- STDDS/DGScope on port 5000 — needs either a reverse proxy or separate tunnel hostname to expose `/dstars` paths

### Sudoers
JY can restart swim services without password (`/etc/sudoers.d/swimreader`):
```
JY ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart sfdps-eram
JY ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart swimreader-stdds
```
