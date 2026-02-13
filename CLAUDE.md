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
      handoff-codes.json                Facility handoff display code mappings (H/O suffixes)
      ERAMv110.ttf                      ERAM font for authentic ATC display
  SwimReader.MessageCapture/          Console tool — captures raw STDDS XML to files
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

### SFDPS Message Types Handled
| Source | Description |
|--------|-------------|
| `TH` | Track history (position update) |
| `HZ` | Heartbeat/position update |
| `OH` | Ownership/handoff update |
| `FH` | Full flight plan update |
| `HP` | Handoff proposal |
| `HU` | Handoff update |
| `AH` | Assignment handoff |
| `HX` | Handoff cancel |
| `CL` | Flight close/cancel |
| `LH` | Late handoff |
| `NP` | New position |

### FlightState Fields
Core fields tracked per flight (by GUFI):
- Identity: `gufi`, `fdpsGufi`, `callsign`, `computerId`, `computerIds` (per-facility CID map)
- Flight plan: `origin`, `destination`, `aircraftType`, `route`, `star`, `remarks`, `flightRules`
- Position: `latitude`, `longitude`, `groundSpeed`, `trackVelocityX/Y`
- Altitude: `assignedAltitude`, `interimAltitude`, `reportedAltitude`
- Ownership: `controllingFacility`, `controllingSector`, `reportingFacility`
- Handoff: `handoffEvent`, `handoffReceiving`, `handoffTransferring`, `handoffAccepting`
- Aircraft: `registration`, `wakeCategory`, `modeSCode`, `squawk`, `equipmentQualifier`
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

### Handoff Detection Logic
Server-side in `Program.cs` ProcessFlight():
1. Handoff events (HP, HU, AH, etc.) set `HandoffEvent`, `HandoffReceiving`, `HandoffTransferring`
2. On every message, checks if `ControllingFacility/Sector` matches `HandoffReceiving`
3. When matched → handoff complete → clears all handoff fields
4. Client-side (eram.html) tracks completed handoffs for 60-second O-indicator rotation

## ERAM Scope Display (`eram.html`)

### Data Block Format (ERAM 4-line)
```
 R  AAL123            ← Line 1: Callsign (Column 0: R = non-owned track)
    360C357            ← Line 2: {assigned FL}{status}{reported FL}
    1234 H33           ← Line 3: CID + Field E (groundspeed OR handoff)
    DCA                ← Line 4: Destination (FAA LID)
```

**Line 2 altitude status codes:**
- `C` = conforming (reported within ±200ft of assigned)
- `T` = interim altitude assigned (from SFDPS interimAltitude)
- `↑` = climbing to assigned altitude (reported below assigned)
- `↓` = descending to assigned altitude (reported above assigned)
- `P` = procedure altitude assigned (not yet available from SFDPS data)
- `X` = no Mode C data at all

**Line 3 Field E (right side after CID):**
- Normal: groundspeed as 3 digits (e.g., `420`)
- Handoff proposed: `Hxx` where xx = receiving facility code (flashing)
- Handoff accepted: `Hxx` (steady)
- Handoff completed: Rotates between `Oxx` and groundspeed for 60s (5 cycles of 12s)
- Emergency: `E/sq` where sq = squawk (7500/7600/7700)

### Handoff Facility Codes
Defined in `handoff-codes.json`. Default mappings (e.g., ZDC=W, ZNY=N, ZOB=C) with per-facility overrides (e.g., when viewed from ZDC, PCT shows as "E").

### Track Symbols
- `◇` hollow diamond — current position (all track types)
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
- Font size (8-14px)
- Altitude filter (FL low/high)
- Colors: `#cccc44` (ERAM yellow), `#ff4444` (emergency red)
- 4-second render cycle matching SFDPS ~12s update cadence

### Callsign Deduplication
When a facility is selected, the same physical aircraft may exist as multiple GUFIs (one per ARTCC tracking it). The render loop deduplicates by callsign — for each callsign, only the GUFI whose controlling/reporting facility matches the selected facility is shown. This prevents stacked duplicate targets. Dedup applies to markers, history symbols, and velocity vectors. When "All" is selected (no facility), no dedup is applied.

### Rendering Architecture
- Leaflet markers use `L.divIcon` with custom HTML for position symbol + data block
- Canvas overlay (separate pane, z-index 440) draws history symbols + velocity vectors
- History symbols rendered via `ctx.fillText()` using ERAM font on canvas
- Font size adjustable at runtime; CHAR_W and LINE_H scale proportionally (0.625 and 1.25 of font size)
- Leader lines are inline SVGs within the marker div
- URL parameters persist sidebar state (facility, font size, history count, etc.)

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
- **Pi**: `JY@JY1` (Debian 12 bookworm, ARM64, 4 cores, 3.7GB RAM)
- **SSH**: `ssh JY@JY1` (no password needed)
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

### Auto-Deploy
- **Timer**: `swimreader-deploy.timer` polls `origin/master` every 60 seconds
- **Script**: `/home/JY/SwimReader/check-deploy.sh` — compares local HEAD vs remote, runs `deploy.sh` if different
- **Deploy script**: `/home/JY/SwimReader/deploy.sh` — `git pull` → build both projects → restart both services
- **CI**: GitHub Actions workflow (`.github/workflows/ci.yml`) runs build + test on push/PR to master

```bash
# Check deploy timer
systemctl list-timers swimreader-deploy.timer

# View deploy logs
journalctl -u swimreader-deploy.service --no-pager -n 30

# Manual deploy
/home/JY/SwimReader/deploy.sh
```

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
