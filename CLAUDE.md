# SwimReader

Real-time FAA SWIM (System Wide Information Management) data processing and ERAM-style radar visualization.

## Project Structure

```
src/
  SwimReader.Core/          Domain models, events, IEventBus (channel-based)
  SwimReader.Parsers/       STDDS message parsers (TAIS, TDES, SMES, APDS, ISMC)
  SwimReader.Scds/          Solace SWIM SCDS connection manager
  SwimReader.Server/        ASP.NET Core server — DGScope adapter, WebSocket/HTTP streaming
tools/
  SwimReader.SfdpsExplorer/         Console tool — raw SFDPS message capture/display
  SwimReader.SfdpsExplorer.Web/     Web UI — Leaflet radar display + SFDPS data table
tests/
  SwimReader.Core.Tests/
```

## Tech Stack

- .NET 8.0, ASP.NET Core
- Solace messaging (SolaceSystems.Solclient.Messaging v10.28.3)
- Leaflet.js + HTML5 Canvas for radar display
- ERAM font (ERAMv110.ttf) for authentic ATC look
- WebSocket for real-time browser streaming

## Key Files

### Radar Display (the main UI)
- `tools/SwimReader.SfdpsExplorer.Web/wwwroot/radar.html` — Single-file ERAM-style radar scope
  - Leaflet map with dark basemap
  - Canvas overlay for history symbols + velocity vectors
  - ERAM full data block (4-line format with Column 0 and Line 0)
  - WebSocket connection to `/ws` for live flight updates

### Radar Display Features
- **Position symbol**: Hollow diamond at current track position (all track types)
- **Track history**: Target symbols drawn dimmer on canvas trail:
  - `\` correlated beacon (squawk + flight plan)
  - `/` uncorrelated beacon (squawk, no flight plan)
  - `+` uncorrelated primary (no squawk)
  - `◇` flight plan aided track (flight plan, no squawk)
- **Data block** (ERAM format):
  - Line 1: Callsign
  - Line 2: Altitude — `{assigned}{status}{reported}` where status is C (conforming), P (procedural), T (interim), X (no Mode C)
  - Line 3: CID + Field E (groundspeed, handoff Hxx/Oxx, emergency)
  - Line 4: Destination ICAO
  - Column 0: R indicator for non-owned tracks
- **Sidebar controls**: Facility/sector, data blocks, history count (0-10), vector length, boundaries, font size (8-14px), altitude filter (FL low/high)
- **Render cycle**: 4s interval via requestAnimationFrame

### Server Pipeline
- `SwimReader.Scds/` — Connects to Solace SWIM, receives raw STDDS XML
- `SwimReader.Parsers/` — Parses TAIS/TDES/SMES XML into domain events
- `SwimReader.Core/Bus/ChannelEventBus.cs` — Fan-out event bus
- `SwimReader.Server/Adapters/DgScopeAdapter.cs` — Converts events to DGScope JSON format
- `SwimReader.Server/Adapters/TrackStateManager.cs` — Stable GUID mapping, stale purge (5 min)
- `SwimReader.Server/Streaming/ClientConnectionManager.cs` — Facility-scoped WebSocket broadcast

### SFDPS Explorer Web (standalone)
- `tools/SwimReader.SfdpsExplorer.Web/Program.cs` — Self-contained Solace → WebSocket bridge
  - Directly parses SFDPS FIXM XML (not STDDS)
  - Manages FlightState objects from SFDPS message types: TH, HZ, OH, FH, HP, HU, AH, HX, CL, LH, NP
  - Broadcasts to `/ws` as JSON snapshots/updates
  - Fields: gufi, callsign, assignedAltitude, interimAltitude, reportedAltitude, squawk, trackVelocity, handoff events, controlling facility/sector, etc.

## Running

### SFDPS Explorer Web (radar display)
```bash
# Set SWIM credentials as environment variables
set SFDPS_USER=your.email@example.com
set SFDPS_PASS=your-swim-password
set SFDPS_QUEUE=your.email@example.com.FDPS.uuid.OUT

cd tools/SwimReader.SfdpsExplorer.Web
dotnet run
# Open http://localhost:5001/radar.html
```

### SwimReader Server (STDDS mode, for DGScope clients)
```bash
cd src/SwimReader.Server
dotnet run
# DGScope connects to /dstars/{facility}/updates
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `SFDPS_HOST` | Solace broker URL (default: `tcps://ems2.swim.faa.gov:55443`) |
| `SFDPS_VPN` | Solace VPN name (default: `FDPS`) |
| `SFDPS_USER` | SWIM subscription username |
| `SFDPS_PASS` | SWIM subscription password |
| `SFDPS_QUEUE` | Solace queue name for your subscription |

## Data Flow

```
FAA SWIM SCDS (Solace) → FIXM/STDDS XML → Parse → Domain Events → Event Bus → Adapters → WebSocket → Browser
```

## Display Architecture Notes

- All rendering in radar.html is in a single HTML file (JS + CSS inlined)
- Leaflet markers use `L.divIcon` with custom HTML for symbols + data blocks
- Canvas overlay (separate pane, z-index 440) handles history symbols and velocity vectors
- History symbols use `ctx.fillText()` with ERAM font on the canvas
- Font size is adjustable at runtime; CHAR_W and LINE_H scale proportionally (ratio: 0.625 and 1.25 of font size)
- Leader lines are inline SVGs within the marker div
- 4-second render cycle matches SFDPS update cadence (~12s per aircraft)

## KML Sector Boundaries

Place KML files in the repo root:
- `AllSectors.kml` — loaded automatically by radar.html via `/api/kml/AllSectors.kml`
- `AllHighSectors.kml`, `AllLowSectors.kml` — available but not auto-loaded

## Important Conventions

- Altitudes in SFDPS data are in feet; displayed as flight levels (hundreds of feet, e.g., 360 = FL360 = 36,000 ft)
- Altitude filter uses FL notation: Low FL 180, High FL 360 = 18,000-36,000 ft
- ICAO airport codes are converted to FAA LIDs (KDCA → DCA) in the server adapter
- Track colors: `#cccc44` (ERAM yellow), `#ff4444` (emergency red), `#555555` (boundaries grey)
