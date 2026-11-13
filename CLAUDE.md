# SwimReader

Real-time FAA SWIM (System Wide Information Management) data platform. Ingests live data from **five**
FAA SCDS feeds over Solace messaging — **SFDPS** (en-route flight data), **STDDS** (terminal: TAIS/STARS,
TDES/TDLS, SMES/ASDE-X), **TFMS** (traffic flow), **ITWS** (terminal weather), and **TFDM** (terminal
surface / departure management) — parses/normalizes them, and serves the result through a suite of
ATC-style displays, data explorers, a route/dispatch finder, a cross-source "track a flight" aggregator,
and a Telegram bot.

**Deployment note:** the public deployment is intentionally minimal and **login-gated** (personal use, not
public redistribution — see the FAA LADD/TOS discussion in memory). Env-driven host-scoped HTTP Basic Auth
(`SWIM_GATE_HOST`/`USER`/`PASS` in Program.cs) gates one public hostname; unset = open (local use). All
frontends share the ERAM-yellow dark theme; the home page carries a cover title, not "FAA SWIM".

## IMPORTANT: Reference Documentation

**Before implementing any ERAM display feature, command, or behavior, ALWAYS read `docs/crc-eram-reference.md` first.** This is the authoritative CRC/vNAS ERAM specification with screenshots. It covers targets, tracks, data blocks, commands, toolbars, NEXRAD, GeoMaps, and all display elements. Images are saved locally in `docs/img/eram/`. This reference should be consulted even after context resets or memory loss — the file is always available in the repository.

**Before implementing any ASDE-X display feature, command, or behavior, ALWAYS read `docs/crc-asdex-reference.md` first.** This is the authoritative CRC/vNAS ASDE-X specification with screenshots. It covers targets, data blocks, safety logic, display control bar, commands, and all ASDE-X display elements. Images are saved locally in `docs/img/asdex/`.

**Before implementing any STARS display feature, command, color, or behavior, ALWAYS read `docs/crc-stars-reference.md` first.** This is a curated local capture of the authoritative CRC/vNAS STARS docs (https://docs.virtualnas.net/crc/stars/) — covers target/position symbols, data blocks (LDB/PDB/FDB), ownership colors, STCA/CA logic, special purpose codes, handoffs, and point outs. Match it exactly; if a detail is missing, fetch the live page and add it. This complements the DGScope WPF source in `../scope/` — use the source for rendering/algorithm details, the docs for user-facing behavior and appearance.

**Supplementary ERAM command reference: `docs/eats-computer-commands.md`** (text extraction of `docs/eats-computer-commands.pdf`, the eATS simulator manual). Less authoritative than the CRC reference — CRC governs when they disagree — but very good coverage of classic NAS/ERAM CRD command formats (FP, AM field amendments, QF/QU/QL/QQ/QZ/QP/QD/CO/SR, quick-action keys, field-10 route amendments). Ignore its eATS-only simulation commands (`XX …`). Useful for command forms CRC doesn't document, e.g. `QL <airport>` (Quick Look by destination, additive up to 5) and `QD dddBddd` altitude limits.

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
              │  SwimReader     │    │  SwimServer               │
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
- **SFDPS** — En route flight data (FIXM XML) — parsed inline in `SwimServer/Program.cs`
- **STDDS** — Terminal automation data (TAIS, TDES, SMES, APDS, ISMC) — `SwimReader.Parsers` (DGScope path) and inline bridges (`AsdexBridge`/`TdlsBridge`/`TaisBridge`) in SwimServer
- **TFMS** — Traffic Flow Management data (flights, TMIs, FCAs, airport configs) — `TfmsBridge`
- **ITWS** — Integrated Terminal Weather System (winds, microbursts, storms, lightning) — `ItwsBridge`
- **TFDM** — Terminal Flight Data Manager (**ems3** / VPN `TFDM`): surface/departure management — per-flight
  off-block/TOBT, TSAT, runway, ramp spot, taxi estimates, dep sequence, APREQ, reportable delay; airport
  info (queues, demand, active runway config, AAR/ADR rates, closures); terminal TMRs — `TfdmBridge`.
  Surface-only (no route/type — links to SFDPS by callsign). SMP/Operational-Metrics services exist but
  aren't subscribed on the current queue.

### Frontends / API Services
- **NAS Map** (`/nas`) — the whole country as one fused picture: SFDPS + STARS + ASDE-X, one entity
  per airframe, viewport-bounded delta stream, per-class symbols, color by class/altitude/energy,
  ARTCC and ERAM sector boundaries, NEXRAD, and TBFM/TFDM flow restrictions
- **ERAM Scope** (`eram.html`) — Leaflet + Canvas radar display with ERAM-style data blocks
- **Flight Table** (`/flight-table`) — Tabular real-time flight explorer with filtering, pinning, detail panel; the panel carries ICAO FPL, SimBrief (with an airframe/type/variant picker), VATSIM prefile, FlightAware and TDLS history
- **DGScope Server** (`/dstars/{facility}/updates`) — HTTP streaming + WebSocket for DGScope radar clients
- **ASDE-X Directory** (`/asdex`) — Airport grid with live track counts, click-through to scope
- **ASDE-X Scope** (`/asdex/{airport}`) — Leaflet map with live surface targets, data blocks, 1s updates; `OFFSET` in the status bar auto-places data blocks so they stop overlapping (see Auto Offset below)
- **TDLS Directory** (`/tdls`) — Airport grid with CPDLC clearance/departure message counts
- **TDLS Detail** (`/tdls/{airport}`) — Aircraft list + CPDLC message history with timestamps
- **FDIO** (`/fdio`) — Two-panel flight plan viewer: left table + right detail panel with Flight Plan and Events tabs, raw XML viewing
- **TAIS Directory** (`/tais`) — Facility grid with live track counts, click-through to detail
- **TAIS Detail** (`/tais/{facility}`) — Terminal radar track table with search, sort, frozen filter, expandable detail
- **Track a Flight** (`/track`, `/track/{callsign}`) — Mobile-first single-callsign aggregator across every source (SFDPS, TFMS, EDCT, TDLS, TAIS/STARS, ASDE-X); polls `/api/track/{callsign}`
- **TFDM Boards** (`/tfdm`, `/tfdm/{airport}`) — Terminal surface/departure boards: per-airport live board (WS) with off-block/TSAT/runway/spot/taxi/sequence/delay, proposed-vs-active state, sortable columns + wildcard filter, and an info strip (config/AAR-ADR/closures/queues/gridlock/demand/TMRs). Directory sorted alphabetically.
- **TBFM Boards** (`/tbfm`, `/tbfm/{airport}`, `/tbfm/center/{ctr}`) — time-based metering: a
  directory of metered airports and the 20 center TBFM systems, one airport's arrival board (hold
  assigned, runway/point STA vs ETA, the per-center metering chain behind each flight, AAR), and one
  center's meter points with its adaptation drawn on a map (meter fixes as points, MFA/OMA/OOA arcs
  as real arc segments).
- **Airport Operations** (`/airport`, `/airport/{id}`) — Tower-style field board: wind on a compass rose with NASR runways to scale, head/crosswind per runway end, altimeter/density altitude/RH/ceiling/visibility, 6-hour trend, raw METAR
- **Route Finder / Dispatch** (`/dispatch`) — Search persisted flight history by route/airline/aircraft type → real callsign, filed route, cruise, airframe, gate; deep-links each into **SimBrief** (airframe/type/variant picker), **VATSIM prefile** and **FlightAware**. `/api/dispatch/search`.
- **Telegram bot** (`TelegramBridge`, `@swimffbot`) — Follow a flight over inflight "free-messaging" wifi: send a callsign for the same cross-source status the Track page shows; `/sub` pushes updates on meaningful state change. Enabled when `TELEGRAM_BOT_TOKEN` is set. Its TFMS lines (route fallback, status/ETD/ETA, NAS entry fix, centers ahead) are what an inbound international leg shows before SFDPS has it at all — see the Track a Flight section. `GET /api/debug/telegram/{callsign}` returns the exact text the bot would send, so it can be checked without a token.
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
  SwimServer/                          Standalone web server — SFDPS+STDDS → WebSocket → ERAM/ASDE-X
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
  SwimServer.Tests/                   xUnit tests for SwimServer (TBFM parser so far); InternalsVisibleTo
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
cd tools/SwimServer
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

### SFDPS (SwimServer)
| Variable | Description | Default |
|----------|-------------|---------|
| `SFDPS_HOST` | Solace broker URL | `tcps://ems2.swim.faa.gov:55443` |
| `SFDPS_VPN` | Solace VPN name | `FDPS` |
| `SFDPS_USER` | SWIM subscription username | (required) |
| `SFDPS_PASS` | SWIM subscription password | (required) |
| `SFDPS_QUEUE` | Solace queue name | (required) |
| `SWIM_FEED_HOST` | Host that may consume the live SWIM queues (see below) | (unset = no guard) |
| `SWIM_ALLOW_SHARED_QUEUE` | `1` overrides the guard for a deliberate local live session | (unset) |

### STDDS (SwimReader.Server AND SwimServer)
Both services read these variables. SwimReader.Server also accepts them via `appsettings.json` section `ScdsConnection`.
| Variable | Description | Default |
|----------|-------------|---------|
| `SCDSCONNECTION__HOST` | Solace broker URL | `tcps://ems2.swim.faa.gov:55443` |
| `SCDSCONNECTION__MESSAGEVPN` | Solace VPN | `STDDS` |
| `SCDSCONNECTION__USERNAME` | SWIM username | (required) |
| `SCDSCONNECTION__PASSWORD` | SWIM password | (required) |
| `SCDSCONNECTION__QUEUENAME` | Solace queue | (required) |

**Note:** SwimServer uses `SCDSCONNECTION__*` vars for its `AsdexBridge` STDDS connection (separate Solace session from the FDPS session). If `SCDSCONNECTION__USERNAME` is empty, ASDE-X is silently disabled.

All services search upward for a `.env` file, so a single `.env` at the repo root covers everything. See `.env.example`.

## Only One Instance May Consume The Feed (`SWIM_FEED_HOST`)

**SCDS delivers over Solace queues, which are point-to-point: each message goes to exactly ONE
consumer.** Two instances bound to the same queue therefore *split* the stream rather than each
receiving all of it, and nothing reports an error — the deployed site just looks starved while the
laptop looks perfect. This bit us: a dev instance left running on a laptop halved the Pi's feed.

Measured on the Pi, 90-second windows, with and without a laptop instance on the same queue:

| | laptop off | laptop on | off again |
|---|---|---|---|
| position updates | 255.6/s | **146.8/s** | 247.5/s |
| refresh per flight | 9.6s | **16.1s** | 9.5s |
| median position age | 5s | **12s** | 7s |
| tracks past the scope's 26s coast threshold | 13.4% | **31.0%** | 14.2% |

At 16.1s the refresh is past the 12s radar cycle, so scans get missed: history dots go sparse and
tracks flip to coast. (The 13–14% baseline is not real coasting — those are flights still flagged
ACTIVE inside the 60-minute retention window, median age 33 min. Genuinely-just-quiet tracks are
~0.4%.)

**The guard:** `SWIM_FEED_HOST` names the host that owns the feed. Anywhere else the Solace
consumers don't start — pages, APIs, the flight cache and replay all still work, which is what local
UI work needs. It is fail-safe: unset means no guard, so a deployment that never sets it behaves
exactly as before. `SWIM_ALLOW_SHARED_QUEUE=1` overrides for a deliberate live session.

- `tools/SwimServer/Services/FeedGuard.cs` — canonical implementation and rationale; gates the SFDPS
  thread plus the ASDE-X/TFMS/TFDM/ITWS bridges. `stars.Start()` stays outside it: vNAS adaptation is
  an HTTPS poll, not a queue.
- `src/SwimReader.Scds/ScdsHostedService.cs` — same rule and env vars for the STDDS queue, so the
  DGScope/STARS service can't do it either.
- Visible in `GET /api/stats` as `liveFeed` / `feedBlocked`, and the home page shows **FEED OFF**
  (with the reason on hover) instead of a misleading "OFFLINE".

## One session can't drain SFDPS — run several (`SFDPS_FLOWS`)

**Symptom:** sparse history trails and tracks dropping to coast on the scope, while the server
logged nothing wrong. The SCDS portal told the real story: SFDPS **ingress ~85 msg/s (2.4 MB/s)
against egress ~35 msg/s (1.1 MB/s)**, the queue pinned at its 5-6k limit all day, and
**120-170k messages expiring per sample bucket** — continuous, permanent loss. Overnight, when
ingress fell below ~45/s, egress matched it exactly, the queue drained to zero and expiry stopped.

**It was never our processing.** The handler takes 1.4 ms and the dispatch thread was 95% idle
while this happened; CPU was 55% idle; each feed already had its own context and dispatch thread;
there were no reconnects; sampling the counter every 250 ms showed no stalls (longest gap 0.25 s).
Ack tuning (timer 1000 ms -> 50 ms, threshold 60% -> 10%) changed nothing. The ceiling sat below
the application, in **one session's transport** — which, with SCDS-mandated compression, is a
single serial stream.

**Fix: bind several flows to the same queue.** A Solace queue is competing-consumers — each
message is delivered to exactly **one** bound flow — so N flows drain N× faster with no
duplication and no loss. Each needs its own context (a context has one dispatch thread), so it is
N × (context + session + flow). `SFDPS_FLOWS` sets N, default **3**.

| | before | after (3 receivers) |
|---|---|---|
| throughput | 29 msg/s, 1.0 MB/s | **~95 msg/s, 2.4-3.0 MB/s** |
| lag behind publisher | 63 s, pinned | **3-5 s** |
| queue | pinned at 5-6k, 150k expiring/bucket | drains |

**Processing stays single-threaded** behind one lock (`sfdpsProcessGate`). The handler sustains
~700 msg/s alone, far above the ~95/s needed, and `FlightState` keeps the serialization its
mutation logic was written against. Only the transport is parallel, because only the transport was
the bottleneck. Each receiver also runs its own silence watchdog, so one dead flow is detected and
reconnected while its siblings are busy.

All five bridges take the same shape now — `SolaceTuning.Receivers(env, default)` and a
`_processGate` lock per bridge. Defaults: **SFDPS 3, TBFM 6, TFMS 2**, the rest 1, via `SFDPS_FLOWS` /
`TFMS_FLOWS` / `STDDS_FLOWS` / `TFDM_FLOWS` / `ITWS_FLOWS`. TFMS went from 10-12 s of lag to
**1.1 s** on two receivers; TFDM and ITWS sit at 0.0-0.1 s on one and need nothing.

### TBFM hit the same ceiling at 3 flows (2026-11-03)
The lesson above is not hypothetical and it recurred. TBFM shipped with `TBFM_FLOWS` default 3,
which was enough when it was measured. At full daytime volume it was not:

| | 3 receivers | 6 receivers |
|---|---|---|
| throughput | 241 msg/s | **371 msg/s** |
| lag | **11-13 s, flat** across ten minutes and three restarts | **sawtooth 0.4-12.9 s**, mean 7.5 |
| busyPct | 2.9% | 13.3% |
| discards | 0 | 0 |

Everything pointed the same way as SFDPS: flat non-zero lag, trivial parse load, no discards — so
the ceiling was the single session's transport, not our processing. **A flat lag and genuine
upstream latency are indistinguishable until you lift the ceiling and watch**, which is the whole
reason the number is worth sampling rather than glancing at. It drained instantly. Default is now
6; the same check applies to any feed whose lag sits flat and non-zero while `busyPct` is low.

**What "fixed" looks like here is a sawtooth, not a flat low number — don't spot-check it.**
Measured over 10 minutes at midday volume, 1 h 40 m after a restart, 6 receivers: lag cycles
**0.4 s to 12.9 s**, mean 7.5, dropping under 2 s six separate times. A single sample is therefore
worth nothing — glance at the peak and the feed looks exactly as broken as it was at 3 flows
(this happened: a 12.2 s reading was briefly taken for a regression). What distinguishes the two
is that **3 flows never came down at all** while 6 reaches ~0 repeatedly, which means capacity now
exceeds publisher rate.

The residual peaks are **upstream, not our ceiling**: throughput during them (351-518 msg/s) is no
higher than during the troughs (384-392), so we are not drain-limited — if we were, the peaks would
coincide with maximum throughput. `busyPct` stays 4-14% and discards stay 0 throughout. CPU is not
it either; peaks appeared with the box 65-83% idle, and the deepest troughs happened to fall while
load was 10-13 from an unrelated job. Raising flows further would not move this.

### SFDPS outgrew 3 flows too (2026-11-04) — and 60 s of it looked exactly like upstream latency
Third time for this shape, and the first where the wrong answer was actively argued for by the
dashboard. Reported as "why is everything behind". Settled 10-minute window, 3 flows:

| | |
|---|---|
| throughput | 97.8 msg/s, **2.70 MB/s** — sitting on the documented 3-flow ceiling |
| lag | 61.3 s, **floor 60.1 s**, flat for hours at 5 h uptime |
| discards | **0** |
| parse | gate held ~12% of wall time — about 8x headroom |
| gate contention | **0.0%** |
| CPU | ~idle; clock +0.7 s, NTP synced |

Everything after the socket was nearly idle, so the ceiling was the session transport again.
`SFDPS_FLOWS` **3 → 6** and the backlog drained in under two minutes:

| t | rate | MB/s | lag | floor |
|---|---|---|---|---|
| +1 min | **131.6/s** | **3.71** | 22.3 s | 22.3 s |
| +2 min | 86.8/s | 2.35 | 2.4 s | 2.3 s |
| +16 min | 94.3/s | 2.30 | 2.7 s | **2.1 s** |

**The t+1 min spike is the whole proof.** 131.6 msg/s and 3.71 MB/s is far above the ~85 msg/s
the publisher sustains, which is what draining a backlog looks like; at 3 flows we matched
publisher rate exactly and therefore never drained, which is *why* the lag was so perfectly
flat. A standing backlog and genuine upstream latency are the same picture until capacity
exceeds publisher rate — so the only way to tell is to lift the ceiling and watch. Floor
**60.1 s → 2.1 s**.

Same round: **TBFM 6 → 8** (volume had grown 371 → 477 msg/s since 6 was set), floor
**5.2 s → 0.4 s**, which restores the sawtooth that this file notes is what "fixed" looks like
here. **STDDS 1 → 3** on the SwimServer side, floor 6.9 s → 3.7 s and its share of the shared
queue 74 → 183 msg/s.

**Flow counts are not set-and-forget.** Each of SFDPS, TBFM and STDDS was sized against a
measurement and then quietly outgrown. The signature is always the same — a lag floor that
never reaches zero while `busyPct` and `waitPct` are both low — and it is worth re-checking
after any period of publisher growth rather than waiting for someone to notice.

### Lag is the metric — `PosAge` cannot show this
`FeedHealth` reports `lagSec`/`lagPeakSec` per feed (publisher's own timestamp vs our receipt,
averaged over the 10 s window then reset), plus `kbPerSec` and `avgMsgBytes`. **Watch lagSec.**

`PosAge` counts from **receipt**, so a consumer draining an hours-old backlog still stamps every
record "fresh" and every dashboard looks healthy — which is how a halved feed hid for months, and
why "position ages look fine" is not evidence of anything. `FlightState.PositionFixTime` now keeps
the radar fix time from `<position positionTime="...">`, reported as `FixAge` beside `PosAge`;
`PosAge - FixAge` is the lag. Display logic still runs off `PosAge`, so coast and extrapolation are
unchanged.

A trap worth remembering: a **constant** lag reads like fixed upstream latency, and was initially
misread that way here. It was the backlog — constant precisely *because* delivery was pinned at the
ceiling. A real pipeline delay and a saturated queue look identical until you lift the ceiling and
watch whether the number drains.

### Restarts expire messages — keep shutdown short
TFDM's queue holds ~150 messages, under a second at 190 msg/s, so **every second of shutdown is
thousands of messages expired at the broker**, visible as spikes on the portal's Expired Message
Count that line up with `Started sfdps-eram` to the minute. Shutdown used to run everything
unconditionally, overrun systemd's `TimeoutStopSec=10`, and get SIGKILLed — paying for the
expensive work and then throwing it away. (It did *not* corrupt the flight cache: that write is
tmp+rename.)

`GracefulShutdown.Run` now takes a **5 s budget and a per-step deadline**, because a budget checked
only between steps cannot stop one slow step. Each step runs on a thread and is abandoned if it
overruns; that is safe here because the cache write is atomic and the replay streams are flushed as
written. Measured per step, which is the point of logging them:

| step | cost |
|---|---|
| stop timers | 0 ms |
| ITWS history | ~100 ms |
| sector/airspace | ~110 ms |
| replay recorders | **2.1-2.9 s** |
| flight cache (no backfill) | >2.6 s — usually abandoned |
| aircraft DB | **5.0 s** when dirty — moved last |

The aircraft DB saves on its own 2-minute timer and no-ops when clean, so the shutdown copy is
worth at most two minutes of last-seen timestamps against ~1000 expiring messages. The flight cache
skips `BackfillFromEvents` on this path (re-parsing stored XML per flight dominated it) and its
periodic save moved 15 min -> **5 min**, since the periodic save is what the cache actually is.

**Result: the queue is unbound ~18 s per restart, down from 29-42 s.** Still worth batching `.cs`
deploys — the auto-deploy timer restarts on every backend push.

### Memory: what grew, and why the working set never came back
A `gcdump` (safe to take right after a restart, when the heap is ~1.3 GB — not at 5 GB on an 8 GB
box) found **4.87M of 7.3M objects were strings** on a process holding only 12,500 flights. That is
a cache, not live traffic.

`FlightHistoryIndex` kept a `List<IndexEntry>` per date in a static dictionary and **never
evicted**. Six strings per entry, ~50k entries a day, so ~8 MB of permanently retained heap per day
searched — and the flight table queries the 7 most recent days as you type, against 48 days on
disk. Measured: searching 9 days grew the heap **462 MB**. `MaxCachedDates` now bounds it, LRU,
never evicting today (it is appended to on every flight purge). A dropped day re-reads its `.idx`.

**That bound was first set to 3, which was below every caller's window and made the cache do
negative work.** Both callers scan **7** days — the flight table (`HIST_MAX_DATES`) as you type,
and `/api/dispatch/search` at `days=7` — so each request walked days 1..7, evicted the early ones
before finishing, and re-read all seven `.idx` files from the SD card next time, under
`FlightHistoryIndex`'s single global lock. Measured on the route finder: a city pair took
**0.008 s at `days=1` and 2.5-3.3 s at `days=7`, with no improvement on repeat** (a 100% miss
rate), and the log carried 98 eviction lines in 30 minutes. An *airline* search stayed at 0.10 s
only because it fills its result cap on the first day-file and breaks out before touching the
rest — which is what made this look like "airport pairs are slow" rather than a cache bug.

It is **8** now: the 7-day window plus today, which is never a victim and so occupies a slot.
Still bounded (~80 MB, not the 400 MB+ of 48 days) — bounding was the point, 3 was not. **A cache
smaller than the working set is worse than no cache**: it pays the eviction bookkeeping and the
re-read both. If a caller ever widens its window, raise this with it.

The other half was `ReadMatching` returning a `List`: callers filter what comes back and stop at
their own cap, so the dispatch search read up to **1,000 records per day-file across 7 days to
produce at most 200 results**, each a seek+read in a ~300 MB `.jsonl` on the SD card. It yields
now, so the caller's `break` stops the I/O. Every caller enumerates once with `foreach`; add one
that takes `.Count` or re-enumerates and it must materialise at that call site.

Measured end to end on city pairs at `days=7`: **2.5-3.3 s every time → 0.08-0.31 s warm**, with
the worst outliers (KSAN-KOAK 12.6 s, KSTL-KTPA 8.9 s) now 0.31 s and 0.12 s. The **first** query
after a restart is still seconds — seven index files and a cold page cache — which is inherent,
and worth knowing before reading a post-deploy measurement as a regression.

The second half: the working set grew 465 MB in that test and **never came back**, because
`RetainVM` kept freed segments reserved. That was justified when RAM was ample; at 5.0 GB RSS /
53% fragmentation on a box that had started swapping to the SD card (16-24% iowait, flush worker
permanently in D state) it was not. It is off now. **Working set 5.0 GB -> 2.4 GB.**

### The biggest writer on the box was not SwimServer
An I/O audit (per-process `write_bytes` deltas + per-directory growth over 60 s) found the top
writer was **swimreader-stdds at 70 MB/min**, against SwimServer's 25 and the unrelated vncrcc
app's 43 — and it held no data file open, which is the signature of short-lived writes.

It was `dstars-cache/state.json`: **69 MB, rewritten whole every 60 s, ~100 GB/day onto the SD
card.** Two causes, both fixed without changing what the cache does:
- `Save` exported *every* target the adapter had cached plus its per-target track/flight-plan JSON
  and history, and `Load` then discarded anything older than `TargetTimeout` (45 s) — most of each
  write existed to be thrown away on the way back in. `ExportCaches` now takes the set being
  persisted; targets are filtered to a 3-minute window on the way out.
- The periodic save ran every 60 s, but a snapshot is only useful if it is younger than 45 s when
  loaded, so the periodic copy was already stale on most restarts. What seeds a normal restart is
  the `StopAsync` save on SIGTERM. Now every 10 minutes.

**69 MB/min -> 3.1 MB/min (95% less); load average 11.8 -> 3.7, iowait mostly 0-1%.**

### A working-set sample is as useless as a lag sample — I got this wrong first
Worth recording as a mistake, because it is the *same* mistake this file already warns about for
lag, made on a different metric an hour later.

Two readings after the 6-flow restart — 5,796 MB at 18 min and 6,198 MB at 20 min, with host free
memory down to 335 MB — were read as a linear ~200 MB/min climb toward swapping, and written up
here as "memory is now the binding constraint, do not raise any more flow counts". Sampling it
properly over nine minutes says otherwise:

| t (uptime) | 20:47 | 21:48 | 22:48 | 23:48 | 24:48 | 26:57 | 27:57 | 28:57 |
|---|---|---|---|---|---|---|---|---|
| working set MB | 5557 | 5794 | 5516 | 5771 | 5186 | 5511 | 5088 | **4600** |

It **sawtooths with the GC cycle and trended down**, host free memory recovered 335 MB -> 1,543 MB,
and **no swap was used at any point**. 6,198 MB was a peak, not a trajectory. The comparison that
made it look like a regression — "5.8 GB in 18 min where 3 flows took 70 min to reach 4.9 GB" — was
a peak against a single historical sample of unknown phase, which is not a comparison at all.

So: the working set at 6 flows runs **~4.6-6.2 GB, bounded, cycling, no swapping**, with SFDPS
steady at 94.8 msg/s / 2.5 s lag / 2.1 s floor. It is high on an 8 GB box and the unidentified
growth noted below is still real and still unsolved — but it did not become the binding constraint,
and nothing here needs dialling back.

**The rule generalizes past lag:** any metric that moves with a collection cycle, a burst, or a
flush needs a window, not a reading. For the working set that means several minutes of samples
spanning at least one gen2 collection. `GET /api/debug/memory` plus a gcdump taken shortly after a
restart (while the heap is still small enough to dump) is still the way into the growth itself.

One transient worth knowing: `/api/system` failed to answer once during that window (the sample
where host free dipped to 98 MB). Single occurrence, available memory stayed above 1.1 GB, and the
feed never faltered — but a GC pause long enough to drop a request is the first thing that would
show if this ever did become the constraint.

### Memory is still not solved
Two real leaks were found and fixed (the history-index cache, RetainVM) and the working set
dropped 5.0 -> 2.4 GB — but it climbs again, and faster now, because the feed fix means 3x the
SFDPS volume to allocate for. Measured 70 minutes after a restart: working set 4.9 GB, heap
3.2 GB, **1.2 GB fragmented**, 117 gen2 collections, with ~864k flight events (61 per flight, at
the 100 cap). Events alone cannot account for it. Whatever else accumulates has not been
identified; `GET /api/debug/memory` plus a gcdump taken shortly after a restart (when the heap is
small enough to dump safely) is the way in.

## Feed Health (`GET /api/feed`)

"Are we receiving everything SWIM sends?" is answerable rather than guessed. Per feed
(SFDPS/STDDS/TFMS/ITWS/TFDM), `FeedHealth` reports:

| field | meaning |
|---|---|
| `msgsPerSec` | throughput over the last 10s sample |
| `busyPct` | share of that feed's **single Solace callback thread** spent parsing |
| `discardEvents` | messages the broker flagged `DiscardIndication` — **confirmed data loss** |
| `lastDiscard` | when that last happened |

**`discardEvents > 0` is authoritative, not an estimate**: Solace sets that flag on the next message
it delivers after it has thrown some away. It is logged loudly the first time and every 100th after.

**`busyPct` is the early warning.** Every feed parses inline on its callback thread, which is
deliberately lossless — if parsing is slower than arrival the flow window fills and the broker
*spools* for us instead of dropping. But a queue that spools long enough hits its quota and then the
broker discards. So sustained high `busyPct` means the only thing keeping us lossless is the spool.
Do not "fix" that by putting a drop-oldest buffer in front of the parser: that converts back-pressure
(safe) into silent loss (not).

The other silent loss path is inside our own process: the STDDS service's bounded channels use
`DropOldest`, which discards when a consumer falls behind. Both now count what they drop via the
`itemDropped` callback and log it — `ChannelEventBus` per subscriber, and `ScdsHostedService`
(`InboundDropped`) for the raw inbound buffer.

### The dashboard answers it now, and three fields were added so it could

The home page's THROUGHPUT card is a row per feed: rate, kB/s, lag, **lag floor**, parse-thread
busy %, **flows**, **reconnects**, broker discards, and a 10-minute sparkline of rate and lag.
Before this it showed SFDPS's rate and nothing else; the other five feeds were invisible from the
site and "is anything being lost" was not answerable without SSH.

**`lagFloorSec` is the field worth understanding.** It is the lowest mean lag over the retained
10-minute window, and it exists because a lag *sample* cannot distinguish the two cases that
matter — and this repo has misread it in both directions:

| | lag | floor | what it is |
|---|---|---|---|
| queue pinned at the broker's ceiling | high | **high** | constant *because* delivery is capped. Reads like upstream latency. SFDPS sat here for months. |
| bursty feed that is keeping up | high | **~0** | sawtooth: climbs on a burst, drains between. TBFM does this, and one 12 s sample of it was read here as a regression in a fix that was working. |

A sawtooth touches zero; a pinned queue never does. `state` encodes the split as **`behind`**
(high lag, floor also high, busyPct < 25% → transport ceiling, raise the flow count) versus
**`lagging`** (high lag, low floor → fine). They are *identical* in a snapshot and have opposite
answers, which is the whole reason the verdict is computed server-side in `FeedHealth.Verdict`
rather than left to each reader's thresholds.

`flows` and `reconnects` are there because they complete the diagnosis: the answer to `behind` is
almost always a higher `*_FLOWS`, so the current value belongs beside the symptom; and a feed that
rebuilds its session every few minutes posts a healthy average rate with real gaps in it, which
nothing else on the page would reveal.

### `busyPct` counted lock-wait as parsing, so it pointed away from its own fix
`FeedHealth.Track` is constructed **before** the handler takes the feed's process gate, so the
original single timer charged time spent *blocked* to parse time. On SFDPS — 3 receivers against
one `sfdpsProcessGate`, so two are usually waiting — the feed reported **76.6% "busy"** while the
real parse cost was a fraction of it. Splitting them took the same feed to **9.2%**.

Two consequences, both bad:
- it read **`saturated`**, whose documented meaning is "only the broker's spool is keeping us
  lossless, do not put a buffer in front of the parser" — a diagnosis about parsing, on a feed
  whose parsing was 8x over-provisioned.
- **the metric moved against the fix.** More flows is the remedy for a transport ceiling, and
  each extra flow piles onto the same lock, pushing measured busyPct *up* — toward the reading
  that says stop adding flows.

`Scope` is a mutable struct with `Locked()`, called as the first statement inside each feed's
`lock`. Before it is `WaitTicks`, after it is `BusyTicks`; an ungated feed charges everything to
parse, which is correct for it. That makes a third verdict expressible:

| state | condition | answer |
|---|---|---|
| `saturated` | busy >= 60% | parsing is the bottleneck |
| `gated` | wait >= 25%, busy < 60% | processing is **serialized**. More flows will NOT help — shorten the critical section |
| `behind` | busy < 25%, wait < 25%, floor high | one session's transport ceiling. More flows |

All three look identical in a snapshot and two have opposite answers.

**`waitPct` measured 0.0% on all six feeds**, which disproved the hypothesis it was built for
(that `XDocument.Parse` inside `sfdpsProcessGate` was serializing the receivers — it is not; the
gate is held ~12% of wall time at 3 flows, ~29% at 6). That is the instrumentation earning its
keep: one measurement killed a plausible theory before anyone refactored the hot path on it.

**BUSY is gate utilization and is NOT divided by the flow count; WAIT is per-thread and is.**
Dividing busy was right while it included wait (TFMS once read **153.6%** on two receivers,
which is not a percentage of anything), and became a bug the moment wait moved out: only one
thread holds the gate, so `BusyTicks <= elapsed` and the quotient caps at **100/N**. SFDPS's
maximum was 33% and TBFM's, on six flows, **16.7%** — so the `saturated` threshold of 60% was
*unreachable on every multi-flow feed*. Wait stays per-thread because N receivers genuinely can
block at once.

### Two of our own services share one STDDS queue, and only one was counting

`SWIM_FEED_HOST` stops a second **host** binding a queue. It does not stop two services on the
*same* host, and we have exactly that: `sfdps-eram`'s `AsdexBridge` and `swimreader-stdds`'s
`ScdsHostedService` both bind `SCDSCONNECTION__QUEUENAME`, which is a single queue in the `.env`.
A Solace queue is competing-consumers, so **each STDDS message goes to exactly one of them** and
each sees a fraction of TAIS/TDES/SMES. Nothing errors; both report a healthy-looking rate.

Worse, `swimreader-stdds` had **no throughput instrumentation at all** — no message count, no
rate, no `DiscardIndication` check — so everything we knew about "the STDDS feed" came from the
process that only sees part of it.

`StddsFeedHealth` (in `SwimReader.Scds`) now counts per STDDS sub-service (TAIS / TDES / SMES /
APDS / ISMC, plus a `TOTAL`), with the same field names SwimServer's `FeedHealth` emits so the two
render side by side. It is served at `GET /feed` on :5000 and proxied by SwimServer as
**`GET /api/feed/stdds`** (2 s timeout, 5 s cache, `{reachable:false}` rather than a stall when the
neighbor restarts). The card shows both shares *and their sum*, which is the real queue rate.

**`ScdsHostedService` had no flow support at all** — a single hardcoded flow, while the other
five bridges had had `*_FLOWS` for months, and it is the queue's **largest** consumer (~525 msg/s
against SwimServer's ~74). So a queue needing ~600 msg/s was drained by two single-flow sessions
and both sat at a floor that never reached zero. `SCDS_FLOWS` (1-8, default 1) now binds N
receivers, each with its own context/session/manager, because a context owns one dispatch thread.
Receiver 0 keeps the DI-injected manager so disposal is unchanged, and each loop reconnects
independently so one dead flow is rebuilt while its siblings drain. Processing is untouched: every
flow writes the same bounded channel (already `SingleWriter=false`) and one loop drains it.

`ScdsConnectionManager`'s `_initialized` guard had to become **static** — `ContextFactory.Init`
configures a process-global and must run exactly once, so a per-instance guard would let every
manager call it again.

**A caveat on the "it's zero-sum" intuition**, which is wrong while the queue is backlogged:
competing consumers draining a backlog means more total flows gives faster *total* drain, so
raising either side helps both. It is only zero-sum once the floor reaches ~0 and they are
splitting a live stream.

**And then measuring it showed the queue was never the problem.** `StddsFeedHealth` had no lag
metric at all, so "STDDS is behind" rested entirely on SwimServer's floor — one consumer's view of
a queue it takes under a quarter of. With lag added to the service that takes the rest:

| | rate | lag | floor | settled |
|---|---|---|---|---|
| swimreader-stdds (76% of traffic) | 496 msg/s, 2.47 MB/s | 0.3 s | **0.1 s** | 37 windows |
| SwimServer's share | 149 msg/s, 0.77 MB/s | 4.6 s | **3.5 s** | yes |

Uniform 0.1-0.2 s floors across every sub-service, 0 discards. **A backlogged queue cannot hand
anyone messages a tenth of a second old**, so the queue is healthy and there is nothing to drain.

What is real is narrower: **SwimServer's own STDDS path sits at a 3.5 s floor** while the same
queue delivers to the neighbor at 0.1 s. Ruled out already — parse (gate held 6.3% of wall
time), gate contention (`waitPct` 0.2%), transport per flow (the neighbor pushes 2.47 MB/s over
the same 3 flows), and CPU. With competing consumers the broker holds each message for the flow
it assigned it to, so a consumer whose flows free their in-transit window more slowly sees *its
own* messages arrive older while the other's flow freely — that is the mechanism to look at next,
and it is specific to our side.

`STDDS_FLOWS=3` is still earned (floor 6.9 -> 3.5 s, share 74 -> 149 msg/s). **More flows is not:
that is now measured rather than assumed**, since the neighbor gained nothing from 1 -> 3 and
reaches a 0.1 s floor regardless. The second-queue option below is also unnecessary for
throughput — the split costs SwimServer freshness, not the queue capacity.

**A second STDDS queue would still help, but not for the reason first written here.** It was
described as "the real fix" on the assumption the queue lacked capacity; it does not. What a
second queue buys is removing the race for a share, which is what costs SwimServer its 3.5 s of
freshness — a freshness fix, not a throughput one.

## SFDPS Data Pipeline (SwimServer)

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
| `ET` | rare | ETA/time update | Estimated departure/arrival times, `<controlled time>` for CTOP/GDP slots |

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
        <!-- May have multiple receivingUnit elements (multi-sector point-out) -->
    </pointout>
</enRoute>
```

**Point-out behavior (investigated 2026-03-03, 1,467 records / 110 flights):**
- `<pointout>` has NO attributes (no event/status/acknowledgment data)
- **HT** = always published by originator's center; **PT** = always published by receiver's center
- Inter-facility POs produce both HT + PT within 0-1000ms (dual publication)
- **SFDPS has no point-out acceptance signal** — `<pointout>` appears ONLY in PT/HT messages; no other source (TH, OH, FH, etc.) ever carries point-out data
- **Mostly one-shot** (94%); 6% repeat with variable interval (38s to ~3.3 min, not a fixed timer)
- **Multi-receiver**: HT can have multiple `<receivingUnit>` elements; server stores comma-separated (e.g., `"ZDV/07,ZDV/34"`)
- Bidirectional POs observed: receiver sector can point the flight back to originator

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
- SFDPS clears individual clearance fields by sending `<cleared>` with only some attributes — absent attributes are cleared to null
- Full clearance wipe (QS *): FH arrives with `<enRoute>` but no `<cleared>` child element. `ProcessFlight()` clears all three fields when `source == "FH"` and `<cleared>` is absent. Other sources (TH/OH/AH) don't carry clearance data, so absence is not meaningful.
- HF without `<enRoute>` = clearance removal signal. Data-driven: HF-no-enRoute targets flights with active clearance at 89% rate (2x the 45% baseline), and 92% of affected flights receive no other clearing message. These lightweight HF messages (arrival/departure times, callsign, status only) indicate clearance data has been removed. `ProcessFlight()` wipes all three clearance fields when `source == "HF"` and `enRoute` is absent.
- Only HF messages carry `<cleared>` — they set values but never clear all three via empty `<cleared/>`
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
- Position: `latitude`, `longitude`, `groundSpeed`, `trackVelocityX/Y`, `targetLatitude`, `targetLongitude`, `coastIndicator`
- Altitude: `assignedAltitude`, `assignedVfr`, `blockFloor`, `blockCeiling`, `interimAltitude`, `reportedAltitude`, `targetAltitude`
- Ownership: `controllingFacility`, `controllingSector`, `reportingFacility`, `controlSince` (UTC of the last controllingUnit change — sent to clients as `controlAgeSec`)
- Handoff: `handoffEvent`, `handoffReceiving`, `handoffTransferring`, `handoffAccepting`
- Point-out: `pointoutOriginatingUnit`, `pointoutReceivingUnit` (comma-separated if multi-receiver, expire after 3 min via `PointoutTimestamp`)
- Aircraft: `registration`, `wakeCategory`, `modeSCode`, `squawk`, `assignedSquawk`, `equipmentQualifier`
- Clearance (HSF): `clearanceHeading`, `clearanceSpeed`, `clearanceText`, `fourthAdaptedField`
- TMI: `tmiIds` (traffic management initiative IDs — ground stops, slot times, etc.)
- Datalink: `dataLinkCode`, `otherDataLink`, `communicationCode`
- Status: `flightStatus` (ACTIVE, DROPPED, CANCELLED)
- Event log: last 50 state-change events with timestamps

### Unprocessed SFDPS Data (TODO)

The following FIXM XML elements are present in SFDPS messages but currently dropped or ignored. Listed by priority for future implementation.

**High priority — useful for display accuracy:**

| Element | Path | Frequency | Description | Status |
|---------|------|-----------|-------------|--------|
| Coast indicator | `position/@coastIndicator` | ~18/10K | ERAM-level coast flag on position reports | **IMPLEMENTED** — parsed into `FlightState.CoastIndicator`, used as primary coast detection in `isCoasting()` |
| Reported altitude | `position/altitude` | ~8,752/10K | Mode C / radar-reported altitude in feet | **IMPLEMENTED** — parsed into `FlightState.ReportedAltitude` (was already done) |
| Target position | `position/targetPosition` | ~8,742/10K | ERAM-predicted next position (lat/lon) | **IMPLEMENTED** — parsed into `FlightState.TargetLatitude/TargetLongitude`, used for dead-reckoning extrapolation in `displayPosition()` |
| Target altitude | `position/targetAltitude` | ~8,742/10K | ERAM-predicted altitude at target position | **IMPLEMENTED** — parsed into `FlightState.TargetAltitude`, `@invalid="true"` skipped |
| Position time | `position/@positionTime` | ~8,760/10K | Actual time of radar position fix | Not yet used — more accurate age calculation than message timestamp |

**Medium priority — enrichment data:**

| Element | Path | Frequency | Description | Use Case |
|---------|------|-----------|-------------|----------|
| altFixAlt | `assignedAltitude/altFixAlt` | ~3/10K | "Cross FIX at altitude" clearance | Controller instruction like "cross BOSCO at FL240 then climb FL360". Has `<pre>` (altitude before fix), `<point fix="BOSCO">`, `<post>` (altitude after fix). Rare but operationally significant. |
| Requested altitude | `flight/requestedAltitude` | ~19/10K | Pilot-requested (filed) altitude | Separate from controller-assigned altitude. Has same sub-types: `<simple>`, `<vfr>`, `<vfrPlus>`. Could show in FDIO/flight detail. |
| Expanded route | `agreed/route/expandedRoute` | ~182/10K | ERAM-resolved route with fix-by-fix ETAs | Pre-resolved waypoint sequence with `estimatedTime` per point. Alternative to our NASR-based route resolution — ERAM has already done the work. Only in FH/HX/AH/HU messages. |
| Estimated elapsed time | `agreed/route/estimatedElapsedTime` | ~498/10K | Time to reach each ARTCC boundary | Duration to cross each FIR (e.g., "38 min to reach KZOB"). Could show sector transit predictions. |
| Adapted arrival route | `agreed/route/nasadaptedArrivalRoute` | ~33/10K | STAR identifier from ERAM adaptation | `@nasRouteIdentifier` = STAR name (e.g., "SHFTY6"). Complements our existing STAR extraction from route text. |
| Adapted departure route | `agreed/route/adaptedDepartureRoute` | ~25/10K | SID identifier from ERAM adaptation | `@nasRouteIdentifier` = SID name. We don't currently extract SID. |
| Flight type | `flight/@flightType` | ~190/10K | SCHEDULED, GENERAL, etc. | Commercial vs GA classification. Only on FH/HU/AH/CL/HX messages. |
| Alternate aerodrome | `arrival/arrivalAerodromeAlternate` | ~63/10K | Filed alternate airport (ICAO code) | Could show in FDIO flight detail. |
| En route alternate | `enRoute/alternateAerodrome` | ~6/10K | En route alternate airport | Very rare, separate from arrival alternate. |
| Controlled time | `departure/runwayTime/controlled` | rare | CTOP/GDP slot time | TMI-assigned departure time (ground stop / ground delay program). Separate from estimated/actual. Seen in ET messages. |

**Low priority — metadata / niche:**

| Element | Path | Frequency | Description |
|---------|------|-----------|-------------|
| Report source | `position/@reportSource` | ~8,760/10K | Which radar system reported position (e.g., "SURVEILLANCE") |
| RNP accuracy | `aircraftDescription/accuracy/cmsFieldType` | ~566/10K | RNP values by phase (arrival/enroute/departure) |
| Originator | `flight/originator/aftnAddress` | ~38/10K | AFTN address of flight plan originator |
| Flight plan revision | nameValue `FLIGHT_PLAN_REV_NO` | ~737/10K | Revision number of current flight plan |
| ADS-B quality metrics | nameValue `ADSB_POS_174A`, `ADSB_ALT_175A`, `ADSB_VEL_176A`, `ADSB_TIME_177A`, `ADSB_02M_52B` | ~20-31K/10K | ADS-B position/altitude/velocity accuracy and Mode S address. Position is lat/lon, velocity is x/y knots, 02M is Mode S hex prefixed with `-`. |

**altFixAlt XML structure (3 observed):**
```xml
<assignedAltitude>
    <altFixAlt>
        <pre uom="FEET">24000.0</pre>
        <point fix="BOSCO" type="DESIGNATED_POINT"/>
        <post uom="FEET">36000.0</post>
    </altFixAlt>
</assignedAltitude>
```
Means: "cross BOSCO at FL240, then climb to FL360." The `pre` altitude applies before the fix, `post` applies after.

**requestedAltitude XML structure (19 observed):**
```xml
<requestedAltitude>
    <simple uom="FEET">35000.0</simple>
</requestedAltitude>
```
Same sub-types as `assignedAltitude`: `<simple>`, `<vfr>`, `<vfrPlus>`. Represents the pilot's filed altitude, which may differ from controller-assigned.

**Expanded route XML structure (182 observed):**
```xml
<agreed>
    <route nasRouteText="KBNA./.CVG285010..JHW.Q82.PONCT.JFUND2.KBOS/2221">
        <expandedRoute>
            <routePoint estimatedTime="2026-02-21T20:45:00Z">
                <point fix="CVG" type="DESIGNATED_POINT"/>
            </routePoint>
            <routePoint estimatedTime="2026-02-21T21:12:00Z">
                <point fix="JHW" type="DESIGNATED_POINT"/>
            </routePoint>
            <!-- ... more routePoints with ETAs ... -->
        </expandedRoute>
    </route>
</agreed>
```
ERAM pre-resolves the route string into fix-by-fix waypoints with estimated times. Some points use radial/distance from a navaid instead of a named fix.

### API Endpoints (SwimServer, port 5001)
| Endpoint | Description |
|----------|-------------|
| `WS /ws` | WebSocket — sends `snapshot`, `update`, `remove`, `stats` messages |
| `GET /api/flights/{gufi}` | Full flight detail + all events (with `index` and `hasXml` per event) |
| `GET /api/event-xml/{index}/{gufi}` | Raw FIXM XML for a specific event (lazy-loaded by FDIO) |
| `GET /api/stats` | Server stats (total messages, rate, flight count) — **public** |
| `GET /api/feed` | Per-feed throughput, parse-thread load, and broker discard counts (see Feed Health) — **operator only** |
| `GET /api/feed/stdds` | The other consumer's share of the STDDS queue (proxied from :5000) — **operator only** |
| `GET /api/storage` | Per-dataset disk use, retention span and bucket caps — **operator only** |
| `GET /api/system` | Process metrics for the home server card — CPU/mem/GC/threads/uptime/disk, plus `wsClients` and `wsByFeed` (see below) — **operator only** |
| `GET /api/airport/{id}` | Airport ops: NASR airport + runways (with TRUE/magnetic alignment and per-end wind components), current METAR, derived weather, 6 h history |
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
| `GET /api/tais` | TAIS directory — `[{facility, trackCount}]` sorted alphabetically |
| `GET /api/tais/{facility}` | Full TAIS snapshot — `{facility, tracks:[...]}` |
| `WS /tais/ws/{facility}` | WebSocket — sends `snapshot`, `batch`, `remove` messages |
| `GET /api/history?q=&date=` | Search flight history JSONL by callsign/CID/origin/dest/registration/aircraftType (indexed) or any other field (full-day scan); max 100 results |
| `GET /api/history/dates` | List available history dates with file sizes |
| `GET /fdio` | FDIO two-panel flight plan viewer (reuses `/ws` WebSocket + `/api/flights/{gufi}` + `/api/event-xml/`) |
| `GET /api/tbfm/center/{ctr}/traffic` | A center's metered flights joined to SFDPS positions, for its map |
| `GET /api/tbfm/airport/{apt}/traffic` | Same for an airport's inbounds, plus the field's NASR position |
| `GET /api/nas/stats` | Fused NAS index: entity count, per-class split, per-tier match counts, CPU/allocation per pass (`?payload=1` adds the wire size) — **operator only** |
| `WS /nas/ws` | Viewport-bounded delta stream behind the NAS map — `{cmd:"view", bbox, cap, cls, q}` in; `snapshot`/`delta` out |
| `GET /api/nas/flow` | Per-airport flow restrictions: TBFM arrival metering + TFDM field constraint, joined to a NASR position |
| `GET /api/nas/targets` | The fused targets themselves — `?cls=`, `?bbox=s,w,n,e`, `?limit=`, `?delta=1`, `?held=1` — **operator only** |
| `GET /api/track/{callsign}` | Combined single-callsign snapshot across all sources — `{callsign, found, sfdps, freqs, tfms, edct, handoffHistory, tdls, tais, asdex}` |
| `GET /t`, `GET /t/{callsign}` | **Disabled** — redirects to `/track` / `/track/{callsign}` (see Track a Flight section) |

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
- Dwell box excludes Line 0; FDB→LDB toggle is blocked persistently after any point-out (`<FLID>` → use `QP <FLID>` to unblock)
- Client-side 3-minute timeout: point-outs auto-expire if user doesn't interact
- Multi-receiver: originator menu shows each receiving sector as a separate row
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

**Interim altitude** has no sub-types in SFDPS — only `<interimAltitude uom="FEET">value</interimAltitude>`. Procedural/temp/local distinctions (QQ P, QQ L, QQ R) are local ERAM concepts not reflected in the SFDPS feed. Interim is set exclusively by LH messages. Cleared via absence in four full-state-snapshot sources:
1. **LH with `<interimAltitude xsi:nil="true"/>`** — explicit nil clear (note: `xsi:nil` is namespaced, requires XNamespace lookup)
2. **LH, FH, AH, or HU with no `<interimAltitude>` element** — these are full state snapshots (carry `assignedAltitude`, `aircraftDescription`, `route` at 100%). Absence of `interimAltitude` means interim is not active. Investigation of 19K messages confirmed: AH/HU carry 100% of the same fields as FH but NEVER carry `interimAltitude` (0/197 when interim is active). Other sources (TH/OH/HX/HP) are event-specific — absence is incidental, not authoritative.

SFDPS does not always send LH clears during inter-sector handoffs — the clearing FH/AH/HU from the new sector is often the only signal.

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
Coast detection uses two sources, primary winning:
1. **ERAM coast indicator** (primary) — `@coastIndicator` attribute on SFDPS `<position>` element. Only present when the track is coasting at the facility level (~0.2% of position messages). Parsed server-side into `FlightState.CoastIndicator`, sent to client as `CoastIndicator: true`.
2. **Time-based fallback** — no position update for >26 seconds (2 SFDPS cycles + 1s batch + jitter). Catches cases where SFDPS stops sending TH messages entirely.

When coasting:
- Position symbol changes to `#` (hash) — rendered as CSS geometry (2H + 2V lines)
- Diamond overlay is hidden (no radar return = no diamond)
- Velocity vector is hidden (stale velocity data)
- Data block stays visible (FDB/LDB as normal)
- History dots continue to decay normally (time-based)
- Recovery: any new position update immediately exits coast mode

### Track Extrapolation (Dead Reckoning)
When position age is 12-26 seconds (missed one radar scan but not yet coasting), `displayPosition(f)` extrapolates the marker position using `trackVelocityX/Y`:
- **posAge ≤ 12s**: actual position (normal)
- **12-26s, not coasting**: velocity-extrapolated position — target keeps moving along trajectory
- **Coasting**: freezes at last known position

This reduces false coast visual artifacts when SFDPS occasionally delays a TH message. Applied to marker placement, velocity vector origin, and DRI halos. History dots use their stored positions (not extrapolated).

### ERAM Position Enrichment
Server-side, each TH/HZ message's `<position>` element provides additional data beyond lat/lon:
- **`targetPosition`** — ERAM Kalman-filter predicted next position (lat/lon). Present in ~98% of position messages.
- **`targetAltitude`** — ERAM-predicted altitude in feet. Skipped when `@invalid="true"` (4 observed). Stored in `FlightState.TargetAltitude`.
- **`coastIndicator`** — boolean attribute, only present when coasting. Stored in `FlightState.CoastIndicator`.
- **`positionTime`** — actual radar fix time (vs message receipt time). Not yet used but documented.
- **`reportSource`** — which sensor reported position (e.g., "SURVEILLANCE"). Not yet used.

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
| `XX VCI ON\|OFF` | Auto VCI on/off (bare `XX VCI` reports state) — mirrors the sidebar checkbox |
| `XX OFFSET ON\|OFF` | Auto data block offset on/off (bare `XX OFFSET` reports state) |
| `WR R <station>` | Display METAR for station in Response Area (e.g. `WR R DCA` or `WR R KDCA`) |
| `LA <loc1> <loc2> [/<spd>\|T/<spd>\|T]` | Range/bearing between two locations; T = true bearing |
| `LB <fix>[/<spd>] <loc>` | Range/bearing from fix to location |
| `LC <fix>/<time> <track>` | Required speed to reach fix at HHMM zulu time |
| `<FLID>` | Toggle FDB/LDB for flight (blocked during active point-out) |

FLIDs can be callsign, CID, or squawk (beacon code). Per CRC spec: "Aircraft IDs, assigned beacon codes, and CIDs are all FLIDs." Resolution priority: CID (facility-matched) > callsign > squawk, preferring visible flights. When multiple flights share the same CID (e.g., recycled CIDs from dropped flights not yet purged), `findFlight` prefers visible, non-dedup-hidden flights over stale/hidden ones.

**F-key shortcuts:** F1=QF, F2=QP, F4=QX, F5=QZ, F6=QU, F7=QL, F8=QQ, F9=QB; Shift+F2=QD, Shift+F7=WR, Shift+F8=QR. Each clears MCA and inserts the command prefix.

### Aftermarket Automation (not real ERAM, opt-in)
Both live in the sidebar AUTOMATION panel, default OFF, persisted in localStorage, and toggleable from the MCA via `XX VCI ON|OFF` / `XX OFFSET ON|OFF`.

**Auto VCI** — checks a track in on frequency (VCI) `AUTO_VCI_ON_DELAY_MS` (2.5 min) after your sector takes control, and removes it `AUTO_VCI_OFF_DELAY_MS` (1 min) after control transfers away. Only VCI it set itself is auto-managed (`vciAutoManaged`), so a manual `//` toggle is never overridden.

Keyed on `iControl(f)` — whether the controlling unit is one of our sectors — **not** on the `classifyTrack()` display class. `classifyTrack()` returns `'ho'` the moment any handoff involves us, including an outgoing one we've only *proposed* while still working the aircraft, which would start the removal clock at handoff initiation instead of completion. Control only moves when the receiver accepts, so keying on `iControl` drops VCI a minute after the handoff completes. It also stops an emergency (class `'emrg'`) on our own frequency from losing its VCI.

The on-clock is seeded from the server's `controlAgeSec`, **not** from when the page first saw the track — so opening a sector mid-session (or reloading) immediately checks in everything already established on that frequency instead of restarting a 2.5 min timer on each.

`controlAgeSec` comes from `FlightState.ControlSince`, stamped in `ProcessFlight()` whenever `<controllingUnit>` changes (the moment the handoff is taken). It's persisted in the flight cache and emitted by `ToSummary()` as an age in seconds, like `PosAge`.

**Auto offset** — parks full data blocks **abeam the aircraft's own direction of travel** and keeps them from overlapping each other. Runs once per render after markers exist (block sizes measured from the DOM), in `autoOffsetPass()`:
- Candidate octants are ranked by how close they are to abeam the track vector (from `trackVelocityX/Y`, so the aircraft's left/right, not the screen's) — blocks off a wingtip read much better than ones fore/aft. Right side wins ties. For a northbound track the order is `6 (E), 4 (W), 9 (NE), 3 (SE), 7 (NW), 1 (SW), 8 (N), 2 (S)`.
- **First sight**: a track with a usable vector is placed abeam immediately (first free slot in that order), so the standing arrangement is wingtip blocks rather than everything stacked at the NE default. A track with no vector yet (stationary, velocity not reported) is left at the default and placed once it's moving.
- **After that it's sticky**: a placed block only moves when its current position is actually in conflict, then it's held for `AUTO_OFF_HOLD_MS` (10s) before it may move again. It does **not** re-orient as the aircraft turns. Entries are processed in gufi order so placement is deterministic.
- Manually placed blocks (`dbPositions`) are immovable obstacles — auto blocks work around them, never the reverse. Auto choices live in a separate `autoDbPositions` map; `effDbPos()` resolves manual → auto → default NE.
- **Saturation** (zoomed out, small screen, heavy traffic — overlap physically unavoidable): `firstFree()` finds nothing, so `leastOverlap()` picks the slot with the smallest total overlap area, ties going to the more-preferred (abeam) slot. An already-placed block only relocates if the alternative is *strictly* better, so a saturated screen doesn't churn. Overlap is never fully eliminated — nothing can — but blocks don't pile onto one side.
- **Hard cap**: the whole pass is skipped above `AUTO_OFF_MAX` (250) **on-screen tracks** (FDB + LDB — the cost scales with both, since every target is an obstacle). Above that, blocks keep whatever position they last had, which may be stale from a different zoom level. This is a CPU guard, not a display policy — at that density the real answer is TMU mode, which hides data blocks entirely.

### Track Suppression
Middle-clicking a non-owned track's target symbol toggles: LDB ↔ FDB. `QX <FLID>` is a one-way drop (same as timeout). Hidden tracks (via QX) are cleared on facility change or page refresh. Per CRC spec, middle-clicking a target or map location with an MCA command pending appends the FLID/location and immediately executes (equivalent to left-click + Enter). Left-clicking a target or map location with MCA content inserts a FLID/location placeholder without executing. Locations for LA/LB/LC can be entered by clicking a target (inserts FLID), clicking the map (inserts lat/lon), or typing a callsign/CID/fix/navaid/airport.

### HSF (Heading/Speed/Free text) — Line 4
Line 4 shows controller-assigned heading, speed, and free text data. Two sources merged via `getEffectiveHsf()`:
1. **Server clearance data** — from SFDPS `cleared` element (`clearanceHeading`, `clearanceSpeed`, `clearanceText`)
2. **Local QS overrides** — entered via QS commands in the MCA (local wins per-field)

Display normalization: 3-digit numeric headings get `H` prefix (255→H255), speeds get `S`/`M` prefix. Runway headings (15R), codes (PH, VK) pass through unchanged.

When clearance data exists (from either source), line 3 shows a ↴ indicator. Server clearance data always displays on line 4 without requiring manual toggle; local-only QS data requires toggling via ↴ click or `QS <FLID>`. Free text takes priority (fills line 4); otherwise heading and speed are positioned with speed aligned to the ↴ column.

### NASR Route Resolution
On startup, SwimServer downloads FAA NASR 28-Day Subscription data and parses:
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

## ASDE-X Display (SwimServer)

The ASDE-X feature adds live airport surface traffic to SwimServer. It connects a second Solace session to STDDS (SMES topics), maintains per-airport track state, and broadcasts real-time updates to browser clients via WebSocket.

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

**Key class:** `AsdexBridge` in `tools/SwimServer/AsdexBridge.cs` — fully self-contained; Program.cs creates one instance and calls `Start()` plus the two timer callbacks.

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

**Map rotation (ROT input):** `applyRotation()` rotates the whole `#map` element via CSS `transform: rotate()`. Data blocks must stay **upright** (readable) regardless of map heading, so each `.db` is counter-rotated by the inverse angle. This counter-rotation is baked into `makeIcon()` (using the current `mapRotation`), **not only** applied in `applyRotation()` — because markers rebuild via `setIcon()` on ~1s position updates, and a fresh `.db` created after a rotation would otherwise inherit the map's rotation until the next slider input. `applyRotation()` still updates already-rendered blocks so the slider feels live.

**Rotation is the one setting under which nothing else can be trusted, because at ROT 360 every
correction below is the identity** — the default case cannot reveal any of them, and each one of
these shipped and sat there.

- **The element has to be bigger than the screen.** A viewport-sized rectangle, rotated, no longer
  covers the viewport: the screen's corners fall outside it and `.leaflet-container` clips hard at
  its own edge, so those corners simply have **no map drawn in them**. `sizeMapForRotation()` sizes
  `#map` to the rectangle that still covers the screen at the current angle — a `w x h` viewport
  needs `w|cos| + h|sin|` by `w|sin| + h|cos|` — keeps it centered with negative margins, and calls
  `invalidateSize()` (whose default `pan: true` holds the geographic center at the container's
  center, which is the screen's center, so growing the box reveals the corners instead of shifting
  the view). The exact box rather than the diagonal square that would cover every angle at once,
  because every extra pixel is renderer surface and ORD/ATL run several hundred markers.
- **A screen delta is not a map delta.** `screenToMap()` rotates one into the container's frame.
  The right-drag pan fed `panBy` raw `clientX/Y` deltas, so a rotated scope slid off at an angle to
  the cursor; the data-block drag did convert, but by `-mapRotation` instead of `+mapRotation`, so
  the octant it snapped to was reflected (identical at ROT 180, which is the sort of thing that
  makes a sign error survive a spot check).
- **`getBoundingClientRect()` of a rotated icon is a bounding box, not the icon.** The marker is
  `200x18` with its anchor at `(9, 9)`, so `rect.left + 9` is the target's position only while the
  page is north-up; at ROT 090 the two are **~128 px apart**. That one expression backed the hover
  halo, both drag origins, the tap hit-test and the click hit-test — i.e. every way of picking a
  target was off by that much. `iconAnchorOnScreen()` measures from the box's center instead, which
  is always the image of the icon's own center whatever the rotation.

Measured at KJFK, ROT 330, 1584x805 viewport: `#map` goes 1584x805 -> **1775x1490**, and the
taxiways, aprons and runway ends the old build cut off along the right edge and the top
corners are drawn. ASDE-X is the only scope with a ROT control (`grep mapRotation` finds
nothing elsewhere).

**Heavy type detection (client-side, ICAO type code):**
```javascript
const HEAVY_PREFIXES = ['B74','B77','B78','A33','A34','A35','A38','A30',
                        'A22','C17','C5M','IL7','AN1','DC8','L101'];
const B757_CODES = ['B752','B753','B757'];
```

**Data block (`.db` div, NE offset from target center):**
- Line 1 (`.db-line1`, ERAM yellow): `{callsign || squawk || '????'}  {altFt/100 padded to 3 digits}`
- Line 2 (`.db-line2`, gray `#aaa`): `{acType}  {spdKts/10 padded to 2 digits}`
- Omitted for `unknown` and `vehicle` targets (only line 1 with callsign/squawk)

**Data block positions (8 compass points):** Leader lines radiate from target center (9,9) to the data block. N/S lines are vertical (lx=9), E/W are horizontal (ly=9), diagonals go to corners. Data block wrap position (`wl`, `wt`) places the text div relative to icon anchor. Default position is NE. Left-click target symbol toggles data block visibility; drag data block to snap to nearest octant.

**Leader line:** SVG line from target center to data block position, `#00cc00` at 60% opacity. Hidden for unknown targets.

**Font size:** Adjustable via FONT input in status bar (8-20px, default 13). Changes invalidate all track hashes so icons rebuild on next batch.

**Change detection:** `trackHash(t)` hashes `lat, lon, callsign, altFt, spdKts, hdg, tgtType, acType, wake`. Only calls `setIcon()` (expensive) when hash changes; otherwise just `setLatLng()`.

**Auto-center:** On first snapshot, map centers on centroid of all tracks. Subsequent updates do not reposition the map.

### Auto Offset (`OFFSET` button, optional, OFF by default)

Not an ASDE-X feature — real controllers place blocks by hand. Same idea as the ERAM scope's auto
offset, in `autoOffsetPass()` in `asdex/scope.js`, toggled by `#ao-toggle` in the status bar and
persisted in `localStorage['asdex-auto-offset']`.

- Candidate compass points are ranked by how close they are to **abeam the target's own heading**
  (from `t.hdg`, so its left/right, not the screen's), ties going right. Headings are map-relative and
  the icon rotates with the map, so map rotation needs no correction.
- **Unlike ERAM, stationary targets are placed too**, using a fixed fallback order
  (`AUTO_OFF_NO_HDG`). ERAM leaves vectorless tracks alone, but on the surface most traffic is parked
  and a gate apron is exactly where blocks pile up worst — skipping them would miss the point.
- **Sticky**: a placed block only moves when its current position is actually in conflict, then it is
  held for `AUTO_OFF_HOLD_MS` (10s). It does not re-orient as the aircraft turns.
- Hand-placed blocks (`dbPositions`, set by drag/touch/numpad) are immovable obstacles; auto choices
  live in `autoDbPositions` and `effDbPos()` resolves manual → auto → NE default.
- Every **target symbol** is an obstacle, tagged or not, so a block is never parked on another return.
- **Saturation**: when no slot is free, `leastOverlap()` picks the smallest total overlap, and an
  already-placed block only relocates if that is *strictly* better — otherwise it stays, since
  swapping one bad slot for an equally bad one is pure churn.
- Runs on a rAF-coalesced `scheduleAutoOffset()` after each WS batch/snapshot and on map
  `moveend`/`zoomend` (a pan or zoom changes which blocks collide with no track having moved).
  Skipped above `AUTO_OFF_MAX` (300) targets — a CPU guard, not a display policy.
- Moves are written straight to the DOM by `applyDbPos()` rather than through `setIcon()`, which would
  drop the hover halo and cost a full icon rebuild.

Measured at KORD with live traffic: overlapping block pairs 17 → 3, blocks sitting on a target 17 → 9.

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

## TDLS Display (SwimServer)

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

### Key Class: `TdlsBridge` (`tools/SwimServer/TdlsBridge.cs`)

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

## NEXRAD in replay — two scopes, two sources, no stored weather

A replay showing *this minute's* weather over archived traffic is worse than showing none. Both
scopes now ask for the volume that was on the scope then, and neither stores anything of ours.

**ERAM** (`eram.js`) — fixed, after this section spent a while claiming the opposite in both
directions. The original text said replay weather was time-addressed; it wasn't. The replacement
text said it was broken; it is not, since `fb13a6f`/`8f7c8a7`/`f8c1e3c`. What was actually wrong,
and why it took measuring to see:

IEM's WMS, `mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0q.cgi`, **has no absolute time
addressing**, so `&time=` was ignored and ERAM replay drew LIVE weather. Measured: five GetMap
requests spanning nine days (no time, and four explicit `&time=` values) returned **byte-identical
PNGs**, same MD5 every time. Not a parameter-format problem — the layer asked for, `nexrad-n0q`,
is not in GetCapabilities at all (the real name is `nexrad-n0q-900913`), and correcting it changed
nothing; no layer declares a `<Dimension name="time">`. IEM offers *relative* layers (`-m05m`,
`-m10m`) instead: you can step back from **now**, never to an instant.

**What replaced it**: IEM's archived CONUS composite,
`mesonet.agron.iastate.edu/archive/data/{yyyy}/{MM}/{dd}/GIS/uscomp/n0q_{yyyyMMddHHmm}.png` — one
~4 MB 12200x5400 PNG per 5-minute slot, EPSG:4326, upper-left `-126.0, 50.0` at 0.005 deg/px per
its `.wld`, so bounds are lat 23-50, lon -126 to -65. Verified distinct per timestamp. It is a
whole-CONUS image, not WMS tiles, so the slot is fetched **once** and every tile crops its own box
out of one downscaled canvas (4x — the native RGBA buffer is ~263 MB); nearest-neighbor
throughout, because smoothing blends palette colors into hues the level classifier has no
category for. The slot cache is bounded at 3.

**A second bug sat behind it.** Even reading the archive, opening a replay still pulled **63 live
tiles first**, because the layer is built at module scope before `ReplayBar` has started — the same
race documented below for STARS. Gating on the URL (`REPLAY_PAGE`) got it to 28, not 0, because
`onStart` also runs before any clock exists. Building the layer on the **first clock tick** got it
to **0 live requests in replay, 63 in live** (control unaffected).

The STARS half of this section was always correct

**STARS** (`stars/nexrad.js`) can't use that — it decodes **single-site Level III radials**, not a
CONUS raster. It uses **Unidata's public S3 mirror of the NIDS feed**, `unidata-nexrad-level3`,
keyed `{SITE}_{PROD}_{yyyy}_{MM}_{dd}_{HH}_{mm}_{ss}` with SITE the **3-letter** id (KDMX→DMX,
PAHG→AHG, TJUA→JUA). It goes back to **2015** and is current to the minute. Those files are
byte-for-byte what tgftp serves live — same 30-byte WMO header (`SDUS53 KDMX …`), same
message/description/symbology blocks — so `RadialPacketDecoder` reads them unchanged.

**The product names differ.** The archive carries the super-res set that replaced what tgftp still
publishes under the old names. Per site it has N0B/NCR/N0S/N0G/DAA/DPR/EET/NVL/NST/NMD/N0C/N0X and
**no N0Q, N0R or NCZ**:

| ours | live (tgftp) | archive | code | range |
|---|---|---|---|---|
| `p94r0` | N0Q, code 94 | **N0B** | 153 | 248 nm |
| `p38cr` | NCZ, code 38 | **NCR** | 37 | 124 nm |

`?time=` on `/api/stars/nexrad/radials/{station}/{product}` picks the newest volume at or before
that instant. Keys sort lexicographically in time order, so that's a prefix list plus a scan, over
t's hour **and the one before** — at 15:01 the answer is often a 14:58 volume, and in clear-air mode
(one volume per ~10 min) that gap is routine. A resolved volume is immutable so it's cached without
a TTL, but replay invents a key per volume scrubbed past and a decoded super-res volume is 720
radials × ~1840 bins, so the cache is **bounded at 12**; re-resolving costs one S3 GET.

### Gate live requests on the URL, not on ReplayBar
`ReplayBar.isActive()` only turns true once the replay socket is up, which **races** with the
NEXRAD module's own station lookup — so whichever won decided whether the first fetch went live.
`REPLAY_PAGE` reads `?replay=` / `?incident=` instead (what `scope.js` calls `REPLAY_MODE` /
`INCIDENT_ID`): true from the first line, never changes. The guard sits in `fetchRadials()`, the one
chokepoint `init`, `tick`, `setProduct` and `enable` all pass through.

One timer serves both modes: live refetches on the NWS publish cadence, a replay refetches when its
own clock crosses a 2-minute slot — so at 10× the weather keeps step with the traffic. Measured over
a 12:03→13:44 replay: **19 distinct archived volumes, each 1-5 min behind its clock, 0 of 45
requests live.**

### The half-degree bug — why this drew *nothing* at first
Archived volumes arrived, decoded, and filled **zero pixels**: 36,649 bins above 20 dBZ, 146,596
`geoToScreen` calls, every coordinate finite, no exception.

`StartAngle`, `AngleDelta` and `ScaleFactor` are `double` fields in `RadialPacketDecoder`, but were
assigned from `readHalfWord() / 10` — **int / int**, so every angle truncated to a whole degree.
Product 94's radials are 1.0° wide and survived by luck, which is why live weather always looked
fine. A super-res product's are **0.5°**, so `angleDelta` became 0, `p00 == p01` and `p10 == p11`,
every bin wedge was a zero-area line, and `fill()` had nothing to shade. Pre-existing — nothing had
ever fed this decoder a half-degree product.

Worth remembering as a shape: a decode that produces *plausible* numbers and draws nothing usually
means degenerate geometry, not missing data. Counting `geoToScreen` calls from inside `draw()` is
what separated "the loop never ran" from "the loop ran and produced zero-area polygons".

### NIDS timestamps are UTC
`readTimeStamp()` used to run the value through a helper that called `ToLocalTime()`, shifting every
volume time by the server's UTC offset (−5 h on the Pi). Harmless while nothing read the field; not
harmless once replay reports which volume it is showing, since that is the number you check to tell
whether replay honours its own clock. The date is days since 1970-01-01 **counting that day as day
1**, the time is seconds since midnight GMT.

### Known-dormant: the composite product
`p38cr` decodes to `numRadials = 0` **both live and archived** — composite reflectivity is a raster
product (there is a `RasterPacketDecoder`), and it's being fed to the radial one. Nothing calls
`Nexrad.setProduct()`, so the path is unreachable from the UI and inert. Wiring it up means using
the raster decoder, not changing the range table.

### Checking this after a change
`GET /api/stars/nexrad/radials/{stn}/p94r0` with and without `?time=` and compare the echo
footprint — dBZ-weighted mean range, p99 range and centroid bearing must agree between live and
archive (measured at KMLB: 42.0 vs 41.6 nm, 174.9 vs 175.4 nm, 232.6° vs 233.1°). That is the only
check that catches a wrong `range` for a product code, since nothing errors — the echoes just get
drawn at the wrong distance. The payload carries `code`, `volumeTime` and `archived` for this.

## vNAS adaptation: video maps, and surviving a rename

### Video maps come from vNAS, on demand
`KNOWN-DEVIATIONS G10` used to say vNAS published the video-map *catalog* but never the geometry,
so an operator had to seed a CRC export tree by hand. That was wrong, and the mistake is worth
remembering: `/api/artccs/{id}/video-maps/{mapId}` returns **401**, which reads as "not public".
It is the **admin** API. CRC never touches it.

**CRC hardcodes no endpoints.** It asks `https://configuration.vnas.vatsim.net/` where everything
lives and uses what comes back:

| key | value |
|---|---|
| `dataApiBaseUrl` | `https://data-api.vnas.vatsim.net/api` |
| **`videoMapBaseUrl`** | **`https://data-api.vnas.vatsim.net/Files/VideoMaps`** |
| `artccBoundariesUrl`, `nexradBoundingBoxesUrl`, `navDataUrl`, `aircraftCwtUrl`, `aliasesBaseUrl` | all under `/Files/`, all public |

```
{videoMapBaseUrl}/{ARTCC}/{mapId}.geojson      → 200, no auth
```

Verified byte-identical to a local CRC copy (ZJX `01KTWZMWDCE96H2S8XMBGT8XH0`, 132,419 B both
sides). `StarsBridge` **resolves** that base URL on its daily refresh rather than hardcoding it —
same reason CRC does — and fetches maps on demand.

### crc-export is a cache now, and presence is not freshness
The on-disk tree is still written, but a cached file is served only when its mtime is **at least as
new as the catalog's `lastUpdatedAt`** for that map. That is the rule CRC applies and the one this
lacked: the Pi's seeded **2.8 GB** tree had silently drifted from the published set (ZBW 273 vs 293,
ZID 954 vs 968, ZMP 1359 vs 1336).

Fetch-on-demand alone isn't enough — a map nobody opens stays stale until they do — so after each
daily catalog refresh `SweepStaleMapsAsync()` re-pulls what changed, paced 100 ms and capped at
**500 downloads per sweep** (a capped sweep continues next tick). First run on the Pi: *15,350
checked, 514 stale, 500 updated*; second: *14 stale, 14 updated*; now zero. `GET
/api/stars/videoMaps-sync` reports it.

**The local copy is defended, because it's what's left if vNAS is unreachable or wrong:**
- a replacement must parse as GeoJSON and must not take a map that had features down to **zero**.
  Nothing is signed so authenticity can't be checked, but refusing to overwrite good geometry with
  something that isn't geometry catches the realistic failures — a truncated download, an error
  page served with a 200.
- the replaced version is kept one generation under `crc-export/_backup/`, and is served if both
  the download and the current file are unusable.
- **nothing is ever deleted because the catalog stopped listing it.** A map we hold and vNAS forgot
  is exactly the copy worth keeping.

### PBI became DJT — and how the next one handles itself
NASR, ITWS and TDLS have all moved: `PBI`/`KPBI` resolve to **nothing** in NASR, `KDJT` is
*PRESIDENT DONALD J TRUMP INTL, WEST PALM BEACH FL, ZMA*. Even the oldest archived day (2026-09-17)
is 370 × `KDJT` and 0 × `PBI`, so the rename predates our whole history. vNAS's own adaptation still
says PBI; that is their data.

Two different problems, two mechanisms:

**Display names** — the directory pages keep their curated short labels (they read better in a card
than a full legal name), but anything the table doesn't cover is filled from `/api/airports/find`
**after render**, so a slow lookup can't hold up the page. That directory is OurAirports (monthly)
plus NASR (28-day) and it resolves the **retired** identifier as well as the new one, so a future
rename fills itself in from either direction with nobody editing a table. `shared/airport-names.js`.

**Identifiers in hand-maintained config** can't be guessed, so they're made visible:
`GET /api/airports/audit` checks every id in `destination-codes.json` / `handoff-codes.json`.
Two traps are already baked in:
- **Check NASR, not OurAirports.** The first version checked OurAirports and reported 0 problems
  out of 51 — sailing past the very rename that prompted it, because a retired code lives on as the
  airport's **IATA** code. These files hold FAA LIDs; NASR is the FAA's own list and has dropped PBI.
- **Follow position, not identifier,** when naming the replacement. Asking OurAirports what PBI "is
  now" answers `KPBI` — it renamed the airport and kept the ident. The NASR record at the same
  **coordinates** (1.5 nm tolerance) is the current id whatever it has become, which needs to know
  nothing about this particular rename. Output: `PBI → DJT, retired — the field at these
  coordinates is now DJT`.

### A facility with no STARS config is the common case, not an error

`/stars/{artcc}/{facility}` used to serve the scope shell for **any** two strings. A facility with
no `starsConfiguration` therefore drew a blank screen and explained nothing — no maps, no ASR
sites, centered on whatever `visibilityCenters[0]` happened to be. That is not an edge case:
measured across 10 ARTCCs, **306** facilities have no STARS config and only 6 in ZMA do.

DJT is why it looked like a video-map bug. vNAS splits Palm Beach into the **ATCT (DJT**, no
config, 0 maps**)** and the **TRACON (PBI**, 160 maps**)**, and names *both* "Palm Beach ATCT".
After the airport's PBI→DJT rename, DJT is the identifier you reach for and the one that shows
nothing — while PBI, which looks stale, is the one that works. vNAS's facility id stays PBI; that
is their data, not ours to rename.

`StarsBridge.Resolve` (pure, over the facility tree) now classifies the request:

| status | when | what the route does |
|---|---|---|
| `Ok` | has a `starsConfiguration` | serve the scope, redirecting to canonical case |
| `Aliased` | no config, but **exactly one** STARS facility in the ARTCC shares its name | 302 to that facility, query string preserved |
| `NoStarsConfig` | no config, no unique name match | 302 to the picker with `?notice=` |
| `NotFound` | no such id in this ARTCC | 302 to the picker with `?notice=` |
| `Unknown` | vNAS unreachable | **serve the scope anyway** — fail open |

**The alias rule is name-based on purpose.** Over those 306 non-STARS facilities it fires exactly
once (DJT → PBI) and is **never ambiguous**, so it needs no table and handles the next ATCT/TRACON
split by itself. Requiring *exactly one* match is what makes that safe — two matches means say
nothing. `Unknown` fails open deliberately: an upstream blip must not turn a facility that normally
works into an error page.

Two smaller bugs in the same path: `FindFacility` compared ids with `==`, so `/stars/zma/pbi` —
a URL people type — 404'd and fed the scope a 404 body where it expected a facility; it is
case-insensitive now, and `Ok` canonicalises the URL so one spelling reaches everything
downstream. `/api/stars/facility/...` also returns `hasStars` so no caller has to infer
"displayable" from a null config.

**The `?notice=` banner is rendered with `textContent`, never `innerHTML`** — it comes straight off
the query string, so innerHTML would be a reflected-XSS hole on a page anyone can link to.

### The STARS picker keyed live traffic on the wrong id (Palm Beach read as dead)

`/stars` showed PBI with no track count, no position chips, and — in REPLAY — grayed out as having
no recording, while the TRACON was working 170 tracks with 7 positions staffed. The facility was
fine. **vNAS calls Palm Beach TRACON `PBI` while TAIS publishes it as `DJT`** (the airport was
renamed), so all three of the picker's live lookups missed: `taisCounts["PBI"]`, `tcpByFac["PBI"]`,
`taisRanges["PBI"]`.

`ResolveFeedId` already solves this and the **scope** has always used it (`scope.js feedId()`), so
opening PBI's scope worked — only the directory didn't, which is why it read as a facility going
offline rather than a key mismatch. The resolver is now threaded through
`GetStarsFacilitiesAsync` so every summary row carries **`feedFacilityId`**, and the picker keys on
that. The id shown in the row and used in the launch URL stays vNAS's; the scope resolves the feed
id itself.

**Audited across all 24 ARTCCs: PBI is the only mismatch in 213 STARS facilities.** 71 others have
no feed under their own id at all, and those are legitimate — military RAPCON/RATCFs (CVS, HMN,
LUF, GUS, NQI …) and Hawaii/Guam/PR, none of which are on our STDDS subscription.

### An SPC colors its own two characters, not the whole data block

CRC gives **no** data-block color for a special purpose code: "the associated two-character
identifier will be displayed in the first line of the data block", plus an SSA entry and a tone.
Its one red data-block item is **CA** ("blinking red in the top line"), and its target-color
descriptions are white = owned, green = another controller's, cyan = highlighted, yellow = incoming
point out, red = CA. There is no emergency block color.

DGScope has one (`RadarWindow.cs:5436 if (Emergency) → DataBlockEmergencyColor`) and this port
copied it for 7700/7600/7500. The cost was not cosmetic: **white-vs-green is whose aircraft it is**,
and reddening the block threw that away exactly when it matters most — an emergency on your own
frequency rendered identically to one three sectors away. Dropped. The `EM`/`RF`/`HJ`/`MI`/`LL`
identifier is still red on its own line (matching CRC's red `RF EM` SSA line) and still blinks
until the track is slewed. FDB promotion on an emergency is untouched — that is behavior, not
color.

The pattern to remember: **appearance follows the CRC docs, algorithms follow the DGScope source.**
`docs/crc-stars-reference.md` already warned that matching DGScope where CRC is silent moves us
*away* from the standard; this is that warning coming true.

### DCB map buttons belong to the POSITION, and vNAS is the source

A facility publishes one `mapGroup` per group of TCPs — vNAS says so, every group carries a
`tcps` array. Two things were wrong:

- The binding was computed **once at bootstrap** from `?tcp=` off the URL. Open a facility cold and
  you got `mapGroups[0]`, whichever vNAS happened to list first. Measured over all 24 ARTCCs:
  **97 of 213 facilities publish more than one map group, and 92 of those have groups whose DCB
  slots 1-6 differ.** PCT publishes 15 groups, SCT 33, NCT 39. PCT group 0 is `[1,2,3,4,5,6]` and
  group 2 is `[37,38,39,40,4,3]` — no overlap worth speaking of. Signing on afterwards with `.SO`
  re-derived ownership but never revisited the maps.
- `loadProfileMaps()` replaced the vNAS catalogue **unconditionally** whenever a DGScope
  ScopeServer profile existed ("profile maps supersede vNAS maps on v2"). That inverts the
  precedence: vNAS adaptation is authoritative and covers all 213 facilities; a ScopeServer profile
  is a legacy/reference artifact for a handful. PCT has one and was discarding its own 237 vNAS
  maps and 15 position groups in favor of the profile's 6-slot binding.

`selectMapGroup()` is now keyed on `ownTcp()` and called from bootstrap **and** `setOwnTcp`, and
the profile path runs only when vNAS gave us nothing (`?dgmaps=1` forces it for comparison).
The picker's live position chips launch with `?tcp=`, since you can't type `.SO` before the scope
exists. Verified: PCT no-tcp → `[1,2,3,4,5,6]` (flagged `activeMapGroupIsDefault`), `?tcp=3M` →
`[22,23,24,25,3,26]`, `?tcp=1K` → `[37,38,39,40,4,3]`, all matching vNAS exactly.

**A dead alias sat behind this.** `mapButtonAssignments` was bound once at module load, but both
`selectMapGroup` and `loadProfileMaps` **reassign** `activeMapIds` rather than mutating it — so
the alias pointed at a dead array from the first rebind. `applyProfile()` wrote a vNAS JSON
profile's `tcp.dcbMapList` into it, which nothing reads, so **`?profile=NAME` never applied its
map buttons at all.** The variable is gone; `window.mapButtonAssignments` is a live getter.

### `window.starsState` and `starsState` were different objects — one missing `window.`

The six **WX buttons did nothing** and NEXRAD painted **every intensity level**. One cause.

There were two objects both named `starsState`: the MCA container assigned to `window.starsState`,
and the DCB container declared as a module-scope `const`. **A `const` in a classic script is not a
property of `window`**, so which one you got depended on how you spelled the read — unqualified
`starsState.foo` hit the const (it shadows the global), `window.starsState?.foo` hit the other.
Both spellings are used throughout `scope.js`, `dcb.js`, `nexrad.js` and `preview.js`.

`wxLevels` lived on the const, the WX buttons wrote to the const, and `nexrad.js draw()` read
`window.starsState?.wxLevels` — `undefined`, every frame. It then took its documented fallback,
`prefSet.Nexrad.enabled ? prefSet.Nexrad.levels : 0`, whose `levels` defaulted to **`0x3F`** (all
six). Hence every level drawn and a WX press that moved the highlight and nothing else.

Fixed with `Object.assign(window.starsState, {...})`, so the const and the global are one object
and the spellings cannot disagree again — not about `wxLevels`, and not about `TPASize`,
`MSAWActive`, `AutoOffset`, `rangeBearingLines`, `minSeps` or `tempLine`, each of which is likewise
read through `window.` in one place and written unqualified in another. `prefSet.Nexrad.levels`
now defaults to **0**: it is only a fallback for a case that can't happen, and "draw nothing" is
the right answer there.

### Cache-busting silently did nothing, so shipped scope.js fixes never arrived

`/stars` and `/starsv2` compute a version from the newest asset mtime and stamp it into the HTML.
The pattern was:

```
(src|href)="([\w.-]+\.(?:js|css))"
```

which needs the closing quote **immediately** after `.js`/`.css`. Every tag in `scope.html`
already carried a hand-maintained version — `scope.js?v=68`, `dcb.js?v=7` — so the pattern matched
nothing, the rewrite was a no-op, and the page kept emitting the literal `?v=68`. That URL had
been frozen since **2026-09-28**, so every change to scope.js after that date was invisible to any
browser that had loaded the page once. The character class also has no `/`, so `/shared/*.js|css`
was never stamped at all.

**This defeats browser-based verification, which is the part to remember.** A fresh headless
Chromium has an empty cache, so it fetches whatever the HTML names and shows the new behavior —
every check passes, and would pass no matter how broken the stamping is. Confirming a change in a
clean browser says nothing about whether a returning user will see it. **Check the emitted tag.**
`AssetVersion.Stamp` + `AssetVersionTests` (which asserts against the real `scope.html`) exist
because a unit test is the only thing that can see this.

The numbers written into the HTML are inert now — the server always overrides them — so forgetting
to bump one can no longer serve stale code.

### PTL "always on" is a persisted preference, not a stuck flag
`savePrefsToLocalStorage` persists `PTLOwn` and `PTLAll`, so once either is toggled it restores on
every load, forever. The gate itself (`ShowPTL || (Owned && PTLOwn) || (FDB && PTLAll)`) is
correct and dates from June. The DCB AUX buttons render lit when active, which is how to tell.
Worth knowing before hunting a rendering bug: a clean browser profile shows the defaults (both
off) and will never reproduce it.

### ADS-B callsign enrichment: the regions, not the matching

Ported from the `ADSBBeaconReader` receiver in the DGScope branch (`yanjz124/scope`). Four tiers,
in `CallsignEnrichmentService`:

| tier | gate | serves |
|---|---|---|
| Mode S hex | exact | anything TAIS gives a Mode S code |
| discrete beacon code | 5 NM / 1,000 ft | correlated tracks |
| — | — | *(the DGScope receiver's squawk+position tier; not ported, the index already de-duplicates)* |
| position only | **1.5 NM / 500 ft, and rejected if a second candidate is inside the gate** | **uncorrelated targets** — TAIS publishes no Mode S for them |

**Non-discrete codes are never correlated on** (`BeaconCodes`): the 64 block-boundary codes
(anything ending in 00), the conspicuity/special-purpose set, and the DC SFRA/FRZ allocations, per
FAA JO 7110.66 and 7110.65 Ch.5 S.2. Matching on them was a *wrong-answer* bug — several `1200`
targets sit inside a 5 NM box in busy VFR airspace, so "nearest wins" handed a track somebody
else's callsign, and 7700/7600/7500 are non-discrete too.

The position tier **declines an ambiguous match on purpose**. With no identifier, two candidates in
the gate means no tiebreaker, and picking the closer one is a coin flip that produces a
confidently wrong callsign. Untagged is the honest answer and the one a controller can see.

For an uncorrelated target the ADS-B callsign goes to **`Scratchpad1`**, with the squawk staying on
line 1 (`PublishEnrichmentAsync`); for a Mode S target it goes to the callsign field.

#### What was actually broken: coverage, and only measurement found it
"The beacon reader isn't working" could not be investigated — the matching logs at Debug, on a box
whose journal is capped, and silence from the service is indistinguishable from "nothing matched".
`GET /diag` now carries per-tier counters, and they named the cause immediately:

| | |
|---|---|
| `matchedByPosition` | 651 |
| **`positionNoCoverage`** | **1397** — no ADS-B target within ~90 NM of the track *at all* |
| `positionNoCandidate` | 1094 — targets nearby, none inside the gate |
| `positionAmbiguous` | 87 |

**Splitting no-coverage from no-match is what made it findable.** A single "no candidate" count
points at the gate, and loosening the gate would have changed nothing. The region list was five
hand-placed 250 NM circles, and **15 of the 28 busiest TRACONs fell outside every one** — Seattle
by 386 NM, Portland 279, Phoenix 196, Salt Lake 188, Denver 167, Boston 129, plus Houston, Miami,
Detroit, Cleveland, Minneapolis, Cincinnati, Nashville, Albuquerque and **Palm Beach**. Those
facilities could never be enriched by position however good the matching was.

Now 20 circles, generated to cover every facility we serve and pruned to the minimum that still
does (verified zero uncovered). **Regenerate it that way when the facility list grows** — nudging
circles by hand is how the gaps survived. And because the rate limiters are per-source while
`GetByLocationAsync` always tried adsb.fi first, all 20 would have queued behind one 1.1 s gate;
it rotates the lead source now and fetches three regions at a time, so 20 cost about what 7 did.

Matching now runs every 10 s (`EnrichmentRegionRefresh`/6, floor 5 s) while the 20 region fetches
stay on the 60 s refresh — matching is pure in-memory work against an index already held, and a
minute was long enough for an uncorrelated VFR target to come and go unmatched. The queued entry is
overwritten by each TAIS update, so the *position* used is current — it is latency, not staleness.

#### Third half: ADS-B was never the only source we had

Reported as "only a few targets get an F1 callsign". True, and the reason was that the service
had exactly one source of truth — public ADS-B APIs — so a target they did not cover stayed
untagged forever. We already hold two sets of positively identified aircraft and were using
neither: every en-route **SFDPS** flight, and every TRACON track that **another facility** has
already correlated.

Measured first, across 142 facilities and 14,148 untagged targets:

| candidate source | names |
|---|---|
| discrete beacon + 5 NM/1,000 ft gate vs SFDPS | **31.0%** |
| same, vs another facility's tagged tracks | **24.6%** |
| Mode S vs another facility's tagged tracks | 10.9% |
| ambiguous, correctly declined | 3.1% |
| **union** | **38.6%** |

**SFDPS had no Mode S at all, and nothing said so.** FIXM documents
`aircraftDescription/@aircraftAddress`; that is what this parser read for its whole life, and on
the live NAS feed it is **never populated** — 0 of 8,863 positioned flights carried a `ModeSCode`,
while the supplementalData nameValue **`ADSB_02M_52B`** (the hex prefixed with a hyphen,
`-AD9003`) was the **single most common key in the entire feed at 399,198 occurrences**. The field
existed in the model, in the WS payload and in the LADD masking call; it was simply always null,
which reads exactly like "this aircraft has no Mode S code". Parsing it took SFDPS from 0% to
**88%** Mode S coverage, and that is the tier that matters most: an exact Mode S match needs no
distance gate and cannot be ambiguous, and **21.7%** of untagged targets carry a Mode S code with
a *non-discrete* squawk, so nothing else can reach them. `ModeSSourceTests` pins it.

**The candidates are shaped as `AdsbFiAircraft` and merged into the one existing index**, not
matched by a parallel path, so they inherit every tier, every gate, the non-discrete beacon rule
and the decline-on-ambiguity rule unchanged. The ambiguity rule in particular *only works if all
candidates share a bucket* — two sources each finding one "unique" match is precisely the coin
flip it exists to refuse.

**SFDPS arrives over HTTP** (`GET /api/enrich/aircraft` on SwimServer, operator-gated, which for
the real consumer is the unproxied-loopback case). It cannot be subscribed to here: a Solace queue
is competing-consumers, so a second subscriber would *split* the feed, not duplicate it. LADD
aircraft are omitted entirely rather than masked — a masked row still pairs a position with a
beacon code, and turning exactly that pair into an identity is what the list is for.

Two bugs that only measurement found, both of which looked like success:

- **The cross-facility source held one entry in the whole NAS.** It read
  `TrackPositionEvent.Callsign`, which is the obvious place for a correlated callsign and is almost
  always null — TAIS puts the callsign on the **flight plan** (a live capture: 14 of 1,237 track
  records carried one). Position and identity are now joined on `(facility, track number)`, and
  only an entry that is both identified *and* located is evidence. `/diag` reports held and named
  counts separately, because the gap between them is the only thing that shows this.
- **The SWIM refresh ran once every two minutes**, not every ten seconds. The matching cycle is
  self-limiting: a pass is "slow" if 60 s have elapsed since the last region refresh, and a slow
  pass spends ~20 rate-limited region fetches plus up to 50 hex lookups at ~1.1 s. Once one pass
  exceeds 60 s, *every* pass qualifies and it never recovers. That defeated the source's own rule
  of stripping positions older than 60 s so a 5 NM gate could trust them. It has its own loop now;
  `pending` fell from ~11,000 to ~2,600.

**Two rules worth keeping.** A tagged track from the *same* facility is never a candidate — that
is the facility's own picture, so a hit is a duplicate, not a correlation. And an `ADSB_ENRICH`
event is explicitly refused as evidence: it carries a callsign this service guessed, and letting
one guess justify the next would spread a wrong answer across facilities with no way back.

Result after 22 minutes live: 30,303 matches, **adsb 15,648 / sfdps 7,191 / tais 7,464** — the two
new sources are **48%** of all matches. `/diag` now splits by **source** as well as tier, because
a rising match count otherwise cannot distinguish "ADS-B coverage improved" from "we started
reading our own feed", and those have completely different follow-ups.

#### The second half: it matched, published, and still showed nothing
Coverage was only half of "the beacon reader isn't working". With it fixed the service reported
**435,400 published** enrichments and F1 still revealed nothing, because the callsign was arriving
in fields the display does not read.

**STARS' F1 hold-to-reveal readout renders the TRACK's callsign** — `ShowCallsignWithNoSquawk` →
`t.Callsign` in `scope.js`, mirroring `Aircraft.cs:591-609`, because in DGScope `ADSBBeaconReader`
is a *receiver* that sets it on the Aircraft itself. An uncorrelated target has no flight plan, so
the callsign is a property of the **target**. Our enrichment instead fabricated a
`FlightPlanDataEvent`, and `DstarsTrackUpdate.Callsign` only ever carried `track.Callsign` — which
TAIS leaves null for exactly these targets. Measured on a live PCT capture: **1,237 track records,
14 with a callsign, and all 14 were military-injection pseudo tracks.** Not one enrichment.

The two fields it *did* fill were both wrong, and each had its own visible consequence:

| was | became | why it was wrong |
|---|---|---|
| `Callsign = track.Squawk` | `null` | It made the beacon code the client's dedup key. `dedupByCallsign` grants its "many aircraft share 1200" co-location escape only to keys **it** built (prefix `SQ:`), so a literal `"1200"` arriving as a callsign read as a unique aircraft id and **every VFR 1200 target in the facility collapsed onto one**. Null lets the client derive `SQ:1200` and refuse to merge. Line 1 falls through to the track's own squawk, so nothing is lost. |
| `AssignedSquawk = callsign` | `null` | A callsign in a beacon-code field. FDB line 3's assigned-vs-received mismatch test rendered **`1200 N98RR`**. An uncorrelated target has no assigned code. |

`Scratchpad1` keeps the callsign — that is what you see on an FDB, and it is the one place it was
always legitimately visible.

**It travels as an explicit `AdsbCallsign` field** on the event, and `DgScopeAdapter` moves it to
`_adsbTrackCallsigns` (keyed by **track** guid, not FP guid) for `ConvertTrack` to apply.
**Deliberately not published as a `TrackPositionEvent`**: a synthetic position event would restamp
`LastPositionTime` with a fix that is already seconds old, which is precisely the
"position-frozen, callsign-shedding ghost" the purge rule in `TrackStateManager.GetTrackGuid`
exists to prevent. Riding the next real radar update costs one scan and invents nothing.

`AdsbBeaconReaderTests` pins all three fields, and `ConvertTrack`/`ConvertFlightPlan` are `internal`
so it can assert on the emitted JSON. **That is the only check that can see this class of bug** —
the same lesson as the cache-busting no-op above. Nothing threw, nothing logged, every counter read
healthy, and the scope was correct to show nothing: it was told nothing. The diagnostic that
settled it in one step was dumping `/dstars/{fac}/updates` and counting **track** records carrying a
callsign — not flight-plan records, which looked fine.

### The empty SITE submenu is intentional — don't wire it up
`starsState.asrSites` reads `fac.starsConfiguration.areas.flatMap(a => a.asrSites)` and always
comes back **empty**, because STARS areas carry no `asrSites` key at all. The ASR list lives at
`facility/eramConfiguration/asrSites` on the **ARTCC root** (ZMA: VRB, FLL, MYN, QYY, RSW, ZQA,
each with lat/lon, range and ceiling), which is ERAM adaptation, not a TRACON's sensor list.

So the menu only ever offers MULTI (disabled, as in DGScope) and FUSED — and **that is the
intended state**: this scope always runs fused/multi-sensor, which is also what a real STARS sits
in for normal operations. FUSED is active by default (`state.radar == null` selects it), so the
menu already reflects reality.

Populating it from the ARTCC's ERAM ASR list would be the wrong data in the right-looking place:
it would offer single-site selections for radars that may be nowhere near the TRACON, backing a
mode nothing here implements. Leave it. Noted because the empty menu reads like an unfinished
feature and invites exactly that fix.

### The SFDPS watchdog was killing local instances every four minutes

`SWIM_FEED_HOST` is documented as leaving "pages, APIs, the flight cache and replay" working for
local UI work. They did not: `FeedGuard` blocks the SFDPS thread, so `lastMessageTicks` never
advances, so the 240 s health escalation fired and stopped the process — on a loop. The watchdog
now returns early when SFDPS was never started (no `SFDPS_USER`, or `FeedGuard.LiveFeed` false).
A no-op in production, where both are true, and it is what makes verifying a change locally
possible at all.

## The fused NAS index — one airplane once, across SFDPS + STARS + ASDE-X

`NasFusion` (`tools/SwimServer/Services/NasFusion.cs`) + `GET /api/nas/stats` and
`GET /api/nas/targets`, both operator-gated. **Step one of a whole-NAS map, deliberately
headless**: an entity index and the numbers to judge it, so "can this box carry it" is answered by
measurement rather than argument before any pixel is drawn.

### Fusion here is an identity problem, not a de-duplication one
Measured before writing it (overnight trough, then midday):

| | overnight | midday |
|---|---|---|
| SFDPS fresh positions | 739 | 4,675 (of 10,732 records; 2,761 stale, 3,273 no position) |
| TAIS tracks | 3,808, **3,483 with no callsign** | 15,565 |
| ASDE-X tracks | 1,499, 1,240 unknown | 2,669 |
| **fused drawable entities** | **~5,710** | **17,000-18,000** (+ ~3,960 held unpositioned) |

The population a NAS map has to draw is dominated by targets **only one source has**, not by
airliners three sources all publish — duplication measured **1.05x** overnight and 1.7x at
midday. So the hard part was never collapsing duplicates; it is giving every target a *stable*
identity and classifying the uncorrelated majority honestly.

### Identity is a key ladder, and the two kinds of key have different lifetimes
Each record contributes the keys it can prove — Mode S hex, callsign, GUFI, its own
facility/track-number — and an entity is whatever any of them already resolves to. **Lowest
(oldest) id wins and every key is re-pointed at it**, which is what makes an id survive a target
going untagged → tagged → untagged again (a facility drops correlation routinely) even though no
single key is present throughout.

**A track number is not an identity.** It is a slot a facility assigns and then *recycles*, so
`T:`/`A:` keys live **60 s** and `H:`/`C:`/`G:` keys live **600 s**. Found by measuring the key
map, not by reading code: at a uniform ten minutes it settled at ~110,000 keys against ~19,000
live entities, because terminal churn mints ~130 new entities per pass (~65 targets a second,
average track life ~3 min). The memory was affordable; the *correctness* was not — ten minutes is
long enough for a busy TRACON to reissue a number still held, and the next aircraft to get it
inherits the previous one's entity id, so the client draws one history trail leaping between two
airplanes. Nothing errors. With per-kind TTLs the map plateaus at **64-68k keys**.

Timestamps are refreshed only past a third of their own lifetime — `ConcurrentDictionary` cannot
write a 16-byte value atomically, so it **allocates a node per update**, and that was ~68,000
allocations a pass for stamps that had barely moved. ~60,000 writes are skipped per pass now.

### Position precedence is by source; identity comes from the current leg
ASDE-X reports every second, TAIS every ~5, SFDPS every ~12, so position rank is
**ASDE-X > TAIS > SFDPS** regardless of write order, and within SFDPS an un-ended leg beats an
ended one before freshness is weighed. Flight-plan fields go the other way: SFDPS is written first
and the others only fill nulls. **SFDPS positions over 120 s are refused** — the TBFM map drew
SKW3759 from a 55-minute-old fix before that rule existed — and counted apart from "no position
at all", because the two look identical on a map and are unrelated.

**`CurrentLegFirst` (in `TrackRoutes`) is the one ordering, shared.** It had two gaps, both found
by asking the index about every named SFDPS flight it did *not* contain:

- **115 missing, 112 of them present under the other leg's callsign** — SWA519/SWA3872,
  JBU203/JBU204, ACA1322/ACA1323, CNS333/N702NF. Consecutive leg numbers, identical hex, squawk
  and position: one airframe with two legs live inside SFDPS's 60-minute retention. Merging them
  is right; `Fill` keeping whichever the `ConcurrentDictionary` enumerated first was not.
- **The remaining 20 were all the next rotation's flight plan.** An airframe files its next leg
  while still airborne, so SFDPS holds a PROPOSED record with the same Mode S and no position —
  not "ended", and *fresher*, because plan amendments arrive constantly while a radar position
  arrives every twelve seconds. SWA1306 at 31,000 ft was labeled SWA1410. A positioned record
  now outranks an unpositioned one **before** ended-ness: identity and position should come from
  the same record. Coverage went **115 → 31 → 2** (of 4,751; 0.04%, arrivals between reads).

`LegEnded` also covers COMPLETED and CANCELLED, not just DROPPED — a COMPLETED leg fresher than
the live one's last fix used to sort first, in `/track` and the bot as well.

### Correlating the uncorrelated: tier 4 is measured and never applied
Mode S and callsign are exact. **Discrete beacon + 5 NM/1,000 ft merges** (the rule
`CallsignEnrichmentService` already runs; `BeaconCodes` is *compiled in* from it via a `<Compile
Include>` rather than copied, because this repo has paid three times for two copies of one rule).
**Position-only is counted, never acted on** — with no identifier there is no tiebreaker, so
nearest-wins yields a confidently wrong callsign.

It was built to be counted so the numbers could decide, and they did: of 10,655 unidentified
targets it would have named **106 — 1%** — while 9,650 had no candidate within 1.5 NM at all,
because an uncorrelated primary return is overwhelmingly not an aircraft SFDPS also tracks. It
stays as a **1-in-8 sampled** counter so the answer can be re-checked; the counts are a *rate over
`positionSampled`*, not totals. Tier 3 deliberately does **not** inherit that sampling — putting
the sample check one line earlier would cut real beacon correlation to an eighth, and the only
symptom would be a lower match count, which reads like a quiet day.

Beacon matching names ~890 targets on a cold pass and ~1-25/pass warm: the merge is remembered in
the key map, so the cost is one-off and the effect accumulates.

**A Mode S shared by two *fresh positioned* records is always one airplane in one place** — 18
such codes, none over 10 NM apart — so the merge needs no distance guard. (The alarming ">100 NM
apart" pairs in the first pass were a missing age filter in the measuring script: every one paired
a 25-60 minute stale record with a fresh one, usually under the same callsign.)

### Classification, because half the uncorrelated population is not aircraft
`enroute / terminal / surface / vehicle / untagged / primary`. **1,725 of 3,483 untagged TAIS
tracks report altitude 0 AND under 100 kt**, clustered at plains TRACONs (DSM/SUX/ACT/FSD/ICT) at
local midnight in November — live radar, p50 age 15-30 s, just not airplanes. Drawing them
unlabeled makes the NAS view ~30% clutter; dropping them silently misrepresents the sensor. They
get their own class so the map can filter and say so.

Two output bugs here, both found by cross-checking the fused output against its sources rather
than by measuring cost, and both rendering as something entirely plausible:

- **`surface` meant "ASDE-X positioned it".** ASDE-X covers the approach and departure corridors,
  so UCA4347 at 3,387 ft and 221 kt was a surface target, with ~200 others — taxiing symbols
  several thousand feet up. The gate is now ground speed under **40 kt**, the same threshold
  `/track` uses to separate taxiing from a rollout.
- **4,008 of 20,241 entities sat at exactly (0, 0)** — a fifth of everything, in a tight cluster
  in the Gulf of Guinea. 14% of SFDPS is PROPOSED with no position. Those records *belong* in the
  index (they carry identity, so a flight keeps its id when radar picks it up) but cannot be
  placed. `NasEntity.Positioned` gates every emission; `entitiesHeld` counts them.

An unidentified return **on** the surface is `primary` whatever its Mode C says — Denver's field
elevation is 5,430 ft, so the airborne noise-floor test would call every stationary unknown there
a plausible aircraft.

### What it costs (and how to measure that at all)
Steady state at midday, ~17,500 entities, **demand-gated so it costs nothing until something
asks** (the pass no-ops unless a snapshot was requested in the last 60 s):

| | |
|---|---|
| CPU | **150 ms/pass = 7.5% of ONE core** at the 2 s cadence |
| allocation | **10.6-12 MB/pass = ~19 GB/h**, against the process's own ~273 GB/h — **+6%** |
| wire form | 690 kB raw, **~96 kB deflated**, 40 B/target |
| key map | 64-68k, plateaued |

**`passMs` is not a cost.** This is the fourth time this repo has read a wall-clock-shaped number
as work — after `busyPct` charging lock-wait to parsing, `ps %CPU` being a lifetime average, and
the 250 ms pass that was mostly scheduler delay. On a box at load 5-10 the wall/CPU ratio runs
1.3-3.9x. **`ThreadCpu`** (`/proc/thread-self/stat`, read either side of the work) is the
instrument: no baseline, no second window, no assumption the box is quiet.

**And differencing two process-wide windows is also wrong here.** Two such measurements of the
same code gave **3.7%** and **21.7%** of a core, because the idle baseline itself moved 17% of a
core between runs. A difference of two noisy numbers is noise. `GC.GetAllocatedBytesForCurrentThread()`
is the exact per-thread analogue for allocation, and `/api/debug/memory` now carries
`totalAllocatedGB` as the denominator — without which "19 GB/hour" is unjudgeable.

Both are reported **per phase**, because a total is not actionable and the guess about which phase
dominates was wrong by 4x. The keys were the answer: built as `"H:" + hex` strings they were
**94% of the garbage — 1,053 B per SFDPS record and 590 per TAIS record**. A `NasKey` struct
(kind + the one or two strings the record already holds, ordinal-ignore-case) took the pass from
22 MB to 10.6 and 230 ms to 150. `LaddService.Normalize` also returns its argument now when there
is no punctuation to strip (the uppercasing was redundant — every set it is looked up in uses
`OrdinalIgnoreCase`), which helps every other caller too.

### The wire form
A positional array, **five decimal places** (1.1 m): one rounding has to serve a continental view
and a single airport, and 4 dp is 11 m — a thousandth of a pixel at CONUS zoom, a visible
quantisation on the surface. `[id, lat, lon, altFt, trk, gs, cls]`; **a new field goes on the
END**, since clients decode by index.

### LADD and gating
Blocked aircraft are **omitted entirely, not masked** — fusion's whole product is a position
paired with an identity, which is what the list exists to prevent. ~900 omitted per pass. Both
endpoints are `LaddService.OperatorView`-gated as well: they are bulk dumps of every target in the
country with its identity attached.

### What the tests are for, and what the mutation run kept finding
Every rule above renders as a plausible airplane in the right part of the country when it is
wrong, so **neither a browser nor a live `curl` can see any of it**. `NasFusionTests`,
`NasKeyTests`, `ThreadCpuTests` and `LaddNormalizeTests` exist for that, and the mutation run is
what made them real rather than decorative — **five tests were rewritten because a mutation proved
they could not fail**:

- the position-precedence test passed with the rank comparison deleted (ASDE-X is written last, so
  it wins on order alone) — it tests `TakePosition` directly now;
- the convergence test passed with both "highest id wins" *and* "keys never re-pointed", and the
  case re-pointing actually protects is a facility *losing* correlation;
- deleting `Kind` from `NasKey`'s equality, and deleting its second component, both left 194 tests
  green. The second was masked because `GetHashCode` still included it, so the mutated keys landed
  in different buckets and were never compared — **equality and hashing must be broken together to
  be visible through the index**, which is why the key type is tested directly;
- nothing asserted that a target which simply *keeps reporting* keeps its id, so "never refresh a
  timestamp" passed — with no refresh every track in the country is reborn on a 60 s cycle while
  sitting plainly on the scope;
- swapping the two leg-ordering terms passed, and they differ at every arrival.

One test-data note worth keeping: **beacon codes are octal and `4000` is non-discrete**, so a
naive `4000 + i` range yields 19 correlatable targets of 20 and fails for the wrong reason.

### Open, for the map itself
- **Viewport-bounded streaming is mandatory, not an optimization**: 690 kB per update to every
  client is not a stream. `?bbox=` on `/api/nas/targets` is the shape.
- The remaining allocation is dominated by rebuilding ~17,500 `NasEntity` objects per pass.
  Recycling them across passes is the known next lever (it would cost snapshot isolation, which
  currently comes free); the cadence is the cheaper dial — 4 s halves everything.
- Tier 4 stays measured. If `wouldMatchByPosition` ever rises well above 1% of `positionSampled`,
  it is worth revisiting; it has not.

## The NAS map (`/nas`)

The overview browser over the fused index above: `wwwroot/nas/` + `NasStream`/`NasView`
(`GET /nas`, `WS /nas/ws`, `GET /api/nas/flow`). Ungated, like `/ws` and `/api/asdex` — it is air
traffic. Only `/api/nas/stats` stays operator-gated, because what *it* reports is CPU, allocation
and key-map size, which is deployment state.

### The stream is viewport-bounded, and identity rides the add
The whole fused picture is **690 kB raw, ~96 kB deflated** at ~17,500 targets — ~48 kB/s per
client at a 2 s cadence, of which almost nothing changed. Each client declares a viewport and
gets only what is inside it, and of that only what moved.

- **Identity (callsign, type, origin, dest, owner) travels on the ADD, 12 fields; movement is a
  7-field UPD.** Identity is what hover, labels and highlighting need and also what almost never
  changes. A target whose identity *does* change — an untagged return a facility correlates, which
  happens constantly — is re-sent as an add and the client upserts it.
- **The volatile hash is over the ROUNDED position.** Hashing the raw double marks every target
  changed every tick from movement below the five decimal places actually transmitted: a delta
  stream that sends everything, every time, while every counter says it works.
- **Truncation above the cap is deterministic** — class priority, then entity id. An arbitrary
  subset makes a third of the screen blink at the tick rate, which reads as a broken renderer
  rather than a limit. The client is told `shown`/`matched`/`total`.
- **Longitude ranges wrap.** Leaflet reports a Pacific viewport as west > east (170 → −170), and
  `lon >= w && lon <= e` then matches *nothing* — over the one stretch where a NAS view
  legitimately spans the date line, which is where Anchorage and Honolulu traffic is. An empty
  Pacific looks exactly like a quiet one.

`NasView` holds all of this, separate from the socket, because every rule in it fails silently.
Eight mutations, all caught.

### The canvas rides the map pane
`NasCanvas` does what `L.Renderer` does for Leaflet's own vector layers: targets are drawn in
**layer** coordinates, so the pane's CSS transform carries them during a drag at zero cost, and a
zoom animation scales the drawn pixels with the tiles. It re-anchors and redraws only when the
view settles, or when a fling passes the 0.4-screen padding.

The first version cancelled that transform and redrew on a 110 ms throttle, which pinned stale
pixels to the **screen** while the tiles moved underneath — the targets visibly swam.

Measured over a synthesized drag: **25 distinct pane offsets, 1 canvas origin**, then exactly one
re-anchor on `moveend`. (`_getNewPixelOrigin` is Leaflet-internal and used deliberately — it is
the call `L.Renderer` makes, and reimplementing the projection maths to avoid it would be worse.)

### Symbols say what, color says where
One shape per class, so the kind of target stays legible when color is carrying altitude. Two
borrow conventions already in this repo rather than inventing any: ERAM draws an uncorrelated
primary as **`+`**, the ASDE-X scope draws a vehicle as a **square**. En route is a filled delta,
terminal the same shape hollow, surface a fuselage along the track.

**The classes with no identity are deliberately not airplanes.** A triangle asserts a nose and
therefore an aircraft, which is a claim the data does not make for a primary return — about half
of which are not aircraft at all.

Color is a **mode**: by class, by altitude, or by **energy** — specific energy height
`h + v²/2g`, a real quantity rather than a blend of two numbers, and the one that makes a fast low
aircraft and a slow high one comparable (the kinetic term is ~9,000 ft at 450 kt). The legend key
is therefore the *symbol*, not a color chip: in by-value mode a chip would be actively lying, so
the chips go neutral and a gradient scale appears.

### An untagged target's identity is who is reporting it
The add row carries **facility, airport and squawk** after the flight-plan fields (appended, since
clients decode by index). For a tagged flight they are extra; for an uncorrelated return they are
all there is, and without them it is an anonymous dot.

It matters most where the user noticed it: **a primary return near a TRACON boundary is published
by both facilities**, and with no Mode S and no callsign nothing in the index merges them — they
arrive as two entities on top of each other. Measured live: **468 co-located groups reported by
different facilities**, several three-way (`CLE/IND/SDF` on one target, all squawking 0513). The
facility is the only thing that explains the pair. A target with no callsign is now labelled with
it, with the squawk underneath instead of a flight level.

Facilities **accumulate** into a `+`-joined list rather than first-one-wins, held in **ordinal
order**. The ordering is not cosmetic: entities are rebuilt every pass from sources iterated out
of a `ConcurrentDictionary`, so an unsorted list comes out `PCT+N90` one pass and `N90+PCT` the
next — which moves the identity hash and makes the stream re-send every multi-facility target in
full, on every tick, forever, while every counter says the delta stream is working. Membership is
checked token-by-token and not with `Contains`: **`N9` is a substring of `N90`**, and a substring
test silently drops a real second facility.

Live examples of the merged case, which arrives via Mode S (TAIS publishes a Mode S code on many
tracks that have no callsign): `ST3` on `CLE+PIT+YNG`, and untagged returns on `CLE+CMH+D21+TOL`
and `CMH+CVG+HTS+LEX`.

### Airspace: three sources that are not the same data
| layer | source | altitude |
|---|---|---|
| ARTCC boundaries | vNAS `ArtccBoundaries.geojson`, 24 one-ring polygons | **none** — an ARTCC boundary has no high/low variant |
| ERAM sector volumes | vNAS FAVs | **reshapes with the altitude filter** — the slabs carry a numeric floor and ceiling |
| Legacy KML | `AllSectors` / `AllHigh` / `AllLow` | free text only |

Sector volumes load for the centers **in view** (capped at 8); nationally they are 2,641 volumes
and 75,185 points. Exclusions and the 99k sentinel volumes are left out — an exclusion is a 3-D
subtraction, not a boundary anyone works to. The KML list comes from `GET /api/kml`, so a
deployment without the files does not advertise three dead options.

**The KML parser is `shared/kml-sectors.js` and the ERAM scope delegates to it.** Its
categorization is not mechanical: most placemarks carry a `FolderPath`, the **western ARTCCs carry
none** and have to be recovered by walking up to an ancestor `<Folder>` named like `ZLA_HIGH_NEW`.
Without that fallback those centers silently vanish, which looks like missing data rather than a
parse gap.

All boundary layers are `interactive: false` in a pane below the targets, so none can take a hover
or a click from an aircraft.

### Flow restrictions (`GET /api/nas/flow`)
What is holding traffic, drawn where it is held. **Two sources answering different questions,
deliberately not added together:**

- **TBFM** — arrival metering, airborne holding into a field. The figure is the governing hold,
  which is the chain **maximum and never a sum**: TBFM distributes a hold upstream, so a center
  that has absorbed it reads ~0 one point downstream.
- **TFDM** — the field itself: runway configuration, AAR/ADR, closures, gridlock, terminal
  restrictions. Surface and departure.

An airport routinely has one without the other. The ring is sized by the metering hold; the chip
turns amber when TFDM has something in force. An airport merely reporting a runway config is not
restricted and is not drawn.

Three traps, all of which shipped and were caught live:

- **The two feeds key airports differently** — TFDM publishes ICAO (`KLAS`), TBFM the FAA LID
  (`LAS`). Joining raw matched almost nothing: LAS came back as two rows, one with metering and no
  field data and one with field data and no metering, which reads as two different airports. Both
  sides normalize with `NasRoutes.Lid`, and **only a leading K is stripped** — taking the first
  character off any four-character identifier turns PANC into ANC and PHNL into HNL.
- **TFDM's gridlock enum is usually negative.** `NO_PREDICTED_GRIDLOCK` was being captioned onto
  the map as though the absence of a problem were a problem.
- **3,600/hour is TBFM's "no restriction" default, not a rate** — 53 of 57 published AARs sat at
  exactly that. Read `aarRestricted`.

TMIs are collapsed the way the TFDM airport page already collapses them: one restriction is
published under several `tfdmTmiId`s and a reissue usually arrives under a new id without the old
being deleted, so a raw count overstates what is in force.

An airport NASR cannot place is returned **without** coordinates rather than dropped, and the
panel reports how many were unplaced — a count of restrictions should not silently lose one to an
unknown identifier.

### What cost what
Steady state at midday: index **150 ms CPU/pass = 7.5% of one core**, ~19 GB/h allocation against
the process's own ~273 GB/h. The stream adds a per-client diff bounded by that client's cap.

### Two verification traps, both of which cost a round here
- **`node --check` cannot see a temporal dead zone.** `layer.addTo(map)` runs
  `onAdd → reset → draw` *synchronously*, and `draw` touches half the module's state — so every
  `const`/`let` below that call was in its TDZ and threw in turn (`cx`, then `visList`). The throw
  escapes module evaluation, so **nothing after it runs**: the socket never connects and the page
  sits on "connecting" with an empty canvas. One bug that presents as the whole page being dead.
  The layer is constructed at the **bottom** of the file now.
- **The Pi's headless screenshots tear.** At a 1600×900 window with a busy canvas and ~1,000 SVG
  paths, `Page.captureScreenshot` hands back black rectangles, a half-drawn side panel and no
  canvas content — while the page probes perfectly (counts right, `visList` populated, canvas
  pixels present, console clean). That reads exactly like a rendering bug and is not one. Capture
  after two presented frames, and **use a smaller window** (~900×620) — the box is four cores at
  load 5-10 with `--disable-gpu`. Always probe the DOM alongside the image; the probe is the
  evidence and the image is the illustration.
- **`will-change: transform` on the canvas made that much worse** and bought nothing (Leaflet
  already transforms the pane). It promoted a 1764×902 canvas to its own compositor layer, which
  headless with `--disable-gpu` then dropped from the capture entirely: tiles and no targets,
  against a page reporting 370 targets and 1,322 painted samples. Removing it fixed the capture.
- **A numeric control read as `+el.value` returns NaN** for a blank or unrecognised option, and
  `4 * NaN` draws every symbol at radius NaN — an empty map with nothing in the console. Found by
  a probe setting size to `"1.0"` when the option value is `"1"`. `num(id, fallback)` guards them.

## The home page rate was a lifetime average

"The website shows 44 msg/s but the portal shows 93 — where is half the feed going?" Nowhere.
`/api/stats` computes `Rate = total / elapsed-since-process-start`; the SCDS portal shows an
**instantaneous** rate. Different quantities, and they diverge badly on a long-running process
because SFDPS publisher volume roughly halves overnight, dragging the lifetime average down.

**`/api/feed` is the comparable number** (last 10 s per feed) and the one to quote, alongside the
two figures that distinguish "behind" from "fine": `lagSec` and `discardEvents`. Measured during
that question: 77-89 msg/s instantaneous, 2.3-3.0 s lag, **0 discards** — discards being
authoritative, since Solace flags `DiscardIndication` when it has actually thrown messages away.
The home page now shows the live sample, with the average, lag and discard count in the tooltip.

The failure mode that *does* lose messages is a second consumer on the same queue (see
`SWIM_FEED_HOST`) — distinguishable because lag grows and the portal's egress falls below ingress.

## Handing a flight to SimBrief / VATSIM

Both `/dispatch` and the flight table's detail panel do this, through **one shared module,
`wwwroot/shared/simbrief.js`**. Anything that decides *what SimBrief receives* lives there: the
tail / fleet / variant / type lookups and their caches, the variant storage key, the airframe
label, the equipment-string assembly, the post-override tail-selection rule, and the URL builder.
Each page keeps only what is genuinely its own — row rendering, and its own route cleaning
(`cleanRoute` vs `nasToIcaoRoute`) — and normalizes its record into one flight shape.

**It was two copies, and they drifted.** The same bug had to be fixed twice on one day (a TYPE
override reloaded the VARIANT list but not the AIRFRAME list, so SimBrief could be handed a tail
whose real type contradicted the chosen type). Reading the two builders side by side then found
**four more disagreements, every one silent** — SimBrief ignores a parameter it does not recognize
and simply opens with the field blank, so none of these ever produced an error:

| | was | per [the docs](https://developers.navigraph.com/docs/simbrief/using-the-api) |
|---|---|---|
| `hexcode` | flight table sent it **top-level** → Mode-S never arrived | an **`acdata`** field |
| `extrarmk` | flight table sent `RMK/` **top-level** → remarks never arrived | an **`acdata`** field (top-level is `manualrmk`) |
| `cat`/`equip`/`transponder` | set independently, so a flight with no surveillance code silently lost its equipment string | **all three or all three are discarded** |
| `fl` | flight table sent `assignedAltitude/100`, i.e. `360` for FL360 — which reads as 360 ft | documented examples are `34000` and `FL340`; there is no bare-hundreds form. **Feet.** |

And `/dispatch` sent none of the equipment data at all, although `/api/dispatch/search` has
returned `wake`/`equip`/`nav`/`surv`/`pbn`/`datalink`/`remarks` all along — so the route finder
now prefills as completely as the flight table does.

**The lesson worth keeping:** a prefill API that ignores unknown parameters gives no feedback, so
duplicated builders drift silently and stay wrong indefinitely. Check a generated URL against the
parameter list rather than against the other page.

Verified live on both pages after the extraction — overriding TYPE reloads the operator's fleet
for the new type and moves the tail to one that is actually that type: dispatch SWA B738 192
tails → B38M 355 tails, flight table AAL1080 B738 307 tails/N902AN → B38M 105 tails/N356TX.

**SimBrief** — `dispatch.simbrief.com/options/custom?…`. Three selectors drive it:
- **AIRFRAME**: which real tail to pre-fill with — the flight's own (resolved to its aircraft-DB
  record so SELCAL and Mode-S come along), any tail from the operator's fleet of that type, or
  *generic* (no tail data). A tail not in the DB still sends its registration.
- **TYPE**: the ICAO type SimBrief should use, defaulting to what was filed. Free text, with a
  datalist of the 224 types SimBrief actually has an airframe for (`GET /api/simbrief/types` →
  `[{type, name}]`). Changing it reloads the VARIANT list for that type. The family table below can
  only ever cover the cases someone thought of, so this is the general escape hatch: a filed type
  with no SimBrief airframe at all, or flying a different variant than was filed (B738 filed, B38M
  add-on).
- **VARIANT**: SimBrief's own "Variant or Airframe", passed as `type`. **Pick it here, not in
  SimBrief** — changing it inside SimBrief wipes the registration/SELCAL/Mode-S that were
  pre-filled. The choice is remembered per aircraft type under `dispatch.sbVariant.<TYPE>`, shared
  by both pages.

Precedence for SimBrief's `type`: chosen VARIANT → chosen TYPE → the chosen tail's type → filed.

On the flight table the **SIMBRIEF** button opens this panel (with a **DISPATCH** button that
actually leaves); nothing is fetched for a flight until it's opened.

**VATSIM** — `my.vatsim.net/pilots/flightplan?raw=<ICAO FPL>`. Both pages build a real ICAO 2012
plan and hand it over; dispatch used to produce a human-readable block to retype, which was useless.
One quirk worth keeping: VATSIM's importer mishandles the ICAO `A###` below-transition level,
leaving the altitude blank and dumping field 15 into the route — so the level is rewritten `A###` →
`F###` **for the link only**, never for the displayed/copied plan.

**Type families.** Some ICAO types share one airframe in SimBrief, and `SimbriefRoutes.Families`
merges them. The E-Jet forced it: SimBrief has airframes under `E170` **and** `E175` but **none at
all** under `E75L`/`E75S`/`E75X`, so an E175 — most of the regional fleet — offered no variants and
couldn't reach the add-on it would actually fly. The family is
`{E175, E75L, E75S, E75X, E170}`, **headed by E175**: `E75L`/`E75S`/`E75X` *are* E175s, so pointing
them at `E170` (a shorter, different airplane) was wrong, even though the same add-ons model both
and the E170 entries are still worth offering. A merged list keeps the **filed type's own default**
(so "SimBrief default" never silently refiles the aircraft as a different ICAO), drops other
members' defaults, and tags borrowed entries with where they came from (`… · E170`), leaving the
type's own entries untagged and first. Each variant carries the family head as `fam`, which both
pickers use as the localStorage key so one choice covers the whole family.

**FlightAware** — both pages, plus the hero on `/track`, link
`flightaware.com/live/flight/{ident}`. The ident is the callsign (a GA flight's callsign *is* its
tail), and the page lands on the current leg or the most recent one.

Note on engine data: SWIM can't help pick a variant. TFMS publishes only a class (JET/TURBO/PISTON),
and the variant lists are mostly "which add-on do you own" (30 A321 variants, all CFM56-5B3) rather
than engine choices, so even the FAA registry's per-tail engine model would only disambiguate a
handful of types (A20N LEAP vs PW, A320 CFM vs IAE).

## TDLS History Search (all days, by callsign)

`GET /api/tdls/history?q={callsign}` searches **every recorded day**, newest first — `date` is
optional and only narrows to one day. Searching a single day was useless in practice: you rarely know
which day a flight was on.

**There is no date filter in the TDLS history UI at all.** Both pages dropped it: having a day
selector beside an all-days search was just confusing, and a day is never what you know. The
**airport page** shows that airport's most recent traffic, and typing a callsign re-queries the
server across every day. The **directory's** history grid totals every airport across the whole
archive — `GET /api/tdls/history/airports` with no `date` answers from the callsign index without
reading a file, which is what made dropping the picker possible. `date` still works on the API.

The flight table's **TDLS HISTORY** button links to `/tdls?mode=history&q={callsign}`, which prefills
and runs the search — useful for a historical flight, where live TDLS has nothing left to show.

Landing on an airport's history from a callsign search is not a dead end: the page shows a strip of
every day/airport that callsign appears at (current one marked and scrolled into view), each a direct
link, plus a **SEARCH** link back to the results. It comes from the callsign index, so it costs
nothing and reads no history file. The `?q=` is applied **before** the first history fetch — applying
it after meant the server returned the airport's recent traffic and the flight only appeared if it
happened to be in the newest few hundred messages.

The archive makes this non-trivial: ~6.5 MB/day over 128 days (**1.5 GB, ~2.4M lines**) and growing.
A blind all-days scan is ~30 s of SD-card reads on the Pi. Four things keep it interactive:

1. **`TdlsCallsignIndex`** maps callsign → the **byte offsets of its lines**, so a lookup reads one
   line per occurrence and its cost tracks the number of matches, not the size of history. Built in
   the background on first use (never blocking a request), persisted to `tdls-history/.callsign-index`
   (binary), and kept live by `Note()` on every append. On restart only files whose size changed are
   re-scanned.

   > A first version indexed callsign → **days**, assuming a callsign occupies a day or two. True of
   > GA tails, false of what people actually search: a scheduled flight number flies daily, so
   > UAL1862 hit **110 of 128 days** and the "narrowed" search still read ~715 MB and took **4-5 s**
   > on the Pi. Offsets took the same query to **~6 ms**. Don't go back to day granularity.
2. **Raw-line pre-filter before the JSON parse.** Parsing is reserved for lines that could match,
   which is what makes scanning a whole file cheap.
3. **Streaming + bounded memory.** Files are read with `ReadLines`, never `ReadAllLines`, and only the
   newest `limit` matches are held, so memory tracks the result cap, not file size.
4. **A wall-clock budget** on anything the index can't answer (free text, or the index still warming),
   reported back as `truncated` rather than hanging.

An **empty** index hit is treated as a miss, not as "no results" — the index only knows `aircraftId`
while the search also matches gate, runway and clearance text, so an unrecognized token still gets
scanned. The deliberate converse: when the index *does* know the callsign, only its days are read, so
another day's clearance text that merely mentions it won't be returned. This is a callsign lookup;
paying a 1.5 GB scan to catch that would defeat the point.

**`GET /api/tdls/history/callsign?q=` answers from the index alone — no file reads.** It returns
day + airport + count, which is all the directory's search renders. This matters because *reading*
the messages is the expensive part: a daily flight number spans ~110 day files, and opening 110 cold
files on the Pi's contended SD card measured **54 s** (vs milliseconds once cached). Offsets fixed
the warm case; not touching files at all fixes the cold one.

Each occurrence also carries its **airport**, so the airport page's search drops hits at other
airports *before* opening anything, and a known callsign filtered to an airport it never visited
returns empty without a scan.

**LADD records are never indexed.** The `"ladd":true` flag is stamped at write time and outlives the
live list (which is why the message reader masks on it) — indexing those would let the summary
endpoint confirm a blocked aircraft's movements even after the list stopped covering it. They fall
back to a scan, which masks correctly.

Response carries `truncated`, `scannedDays`, `indexed` and `indexState` so the UI can distinguish "no
matches" from "still indexing". LADD masking still happens **before** filtering, so a callsign search
can never find a hidden flight by its real id.

## FDIO Display (SwimServer)

The FDIO (Flight Data Input/Output) page provides a two-panel flight data explorer. Left panel: sortable, filterable flight table. Right panel: detail view with two tabs (Flight Plan and Events). Reuses the existing SFDPS WebSocket and REST infrastructure.

### Architecture
- **Data source**: existing `/ws` WebSocket (snapshot + batch + remove + stats)
- **Detail/events**: on-demand `GET /api/flights/{gufi}` when flight is selected (auto-refreshes every 3s)
- **Raw XML**: on-demand `GET /api/event-xml/{eventIndex}/{gufi}` for viewing FIXM XML per event
- **No deduplication**: all GUFIs shown, even duplicate callsigns from different ARTCCs

### Page Layout (`fdio.html`)
- **Top bar**: FDIO title, connection status, flight count + message rate
- **Filter bar**: search box (callsign/CID/airport/type/squawk/route/remarks), status filter, facility dropdown, flight rules filter
- **Left panel**: sortable flight table — callsign, type, dep, arr, altitude, interim, rules, sector, squawk, DL (CPDLC), status
- **Right panel** (440px, collapsed by default): opens on flight click
  - **FLIGHT PLAN tab**: organized sections — Identity, Flight Plan, Route, Altitude, Position, Ownership, Beacon, Clearance, Datalink, Times, TMI/Navigation
  - **EVENTS tab**: all SWIM events newest-first, TH/HZ grouped into collapsed "N position updates" markers, click non-TH event to expand and view syntax-highlighted raw XML (lazy-loaded)

### Event Storage
- **FlightEvent** has `RawXml` property (`[JsonIgnore]` — excluded from cache/WS serialization)
- Raw XML stored for all non-TH/HZ events (TH = 65% of traffic; skipping saves ~175MB RAM)
- **`_allEvents`**: unbounded list per flight (all events since first seen), alongside the existing `_events` ring buffer (50 max)
- **ToDetail()** returns full `_allEvents` with `index` and `hasXml` fields

### Event Log Enhancement
`BuildEventSummary()` for FH (flight plan update) messages generates enriched summaries including aircraft type, origin-destination, altitude, and STAR — e.g., `"FP: B738 KDFW-KJFK FL360 LENDY6"`.

### Event Source Color Coding
| Source | Color | Description |
|--------|-------|-------------|
| FH | white | Flight plan update (enriched summary) |
| OH/HP/AH/HU/HX | blue | Handoff events |
| LH | orange | Interim altitude |
| PT/HT | purple | Point-out events |
| CL | red | Cancellation/clearance |
| TH/HZ | dim gray | Position updates (grouped in UI) |
| BA/RE | gray | Beacon code events |

### Flight History Persistence
When flights are purged from memory (>60 min stale), their complete state + all event summaries are saved to disk:
- **Path**: `flight-history/YYYY-MM-DD.jsonl` (one JSON line per flight)
- **Content**: gufi, callsign, origin, destination, aircraftType, all event summaries (no raw XML on disk)
- **Budget**: 14 GB max (2 GB headroom from 16 GB Pi budget), ~49 MB/day, ~320 days retention
- **Cleanup**: hourly timer deletes oldest daily files when total exceeds budget
- **APIs**: `GET /api/history?q=&date=` (search), `GET /api/history/dates` (list available dates)

## Track a Flight (SwimServer)

A mobile-first page that follows one callsign across **every** source at once, for pilots/enthusiasts who just want "where is this flight and what frequency is it on." A callsign can appear as several SFDPS GUFIs (one per ARTCC tracking it) plus TFMS/EDCT/TDLS/TAIS/ASDE-X records — the page aggregates them all.

### Files & routes
- **`wwwroot/track/index.html` + `track/track.js`** — the page at `/track` and `/track/{callsign}`. Polls `GET /api/track/{callsign}` every 4s, backing off to 15s after 3 consecutive fetch failures and returning to 4s on the next success.
- **`Routes/TrackRoutes.cs`** — registers `GET /api/track/{callsign}` (combined JSON).

### `/api/track/{callsign}` response
`{callsign, found, ts, sfdps:[...], freqs:{FAC/SEC→freq}, tfms, edct, handoffHistory:[...], tdls:[...], tais:[...], asdex:[...]}`. `sfdps` is a lean per-GUFI projection (`SfdpsProjection`) with full flight plan, ownership/handoff, position, clearance (HSF), and times. `freqs` maps every sector referenced anywhere (controlling, handoff, point-out, STARS owner, and sectors named in history summaries) to its controller frequency via vNAS/TAIS data; the frontends append it wherever a `FAC/SECTOR` label appears. Sector-frequency lookup tolerates STARS TCP sub-position letters (`PCT/1J`→`PCT/1`) and leading-zero differences (`ZOB/01`↔`ZOB/1`).

### TFMS section — the earliest route
`tfms` is projected by `TfmsFlight.ToTrackJson()` (not the lean WS `ToJson`): route of flight, SID/STAR +
transitions, airways, departure/arrival/coordination/boundary fixes, the predicted **route-fix, center and
sector crossings**, filed performance, and CDM/gate/runway times. TFMS routinely has a flight — with its
filed NAS route — hours before it enters US airspace and appears in SFDPS, so for an inbound international
leg (and for a domestic prefile) this is often the only source carrying a route at all.
TFMS expresses crossings as **seconds elapsed from ETD**; `ToTrackJson` resolves them to absolute UTC
(same arithmetic as `GetSectorFlights`) and `TfmsFlight.FirstEntries` collapses runs of the same
center/sector name to the first entry (a later re-entry is real and kept). `/track` renders the crossings
as chip rows with passed entries dimmed and the next one ahead highlighted; `/t` is disabled (see below).

### What the Telegram bot shows for TFMS
`TelegramSummary` falls back to the TFMS route when SFDPS and ASDE-X have none, then adds up to three
lines of its own: `TFMS: {status} · ETD · ETA (+Nm vs original) · FL{req}`, a boundary line
(`NAS entry:` when the departure airport is outside K/P, else `Coord fix:`), and `Ahead:` — the next
four centers with the time it crosses each. A TFMS ETA within 2 min of an SFDPS ETA already printed is
skipped. `TelegramRoute` uses the same fallback so a TFMS route amendment still shows "was: …".

`TelegramChangeKey` gains only TFMS's **discrete** state — flight status and diversion indicator, plus a
presence flag — never ETD/ETA/position, which are re-estimated constantly and would push on every drift
(the same rule TFDM follows).

### Page sections
**Cards are grouped by the question they answer**, in the order someone following a flight asks it:
hero → **WHERE IT IS** (position/ownership, STARS, ASDE-X) → **WHAT IS AHEAD** (TBFM metering,
TFMS) → **PLAN AND CLEARANCES** (flight plan, EDCT, TDLS, TFDM) → **WHAT HAPPENED** (handoff and
point-out history). A group heading renders only when that group has a card. Before this the order
was the order the sources had been added — EDCT between the handoff log and the flight plan, and
TFMS last although it is often the *only* source for an inbound international leg — which read as
a pile of feeds rather than one flight.

Hero (callsign, origin▸dest·type/wake·registration, **phase** label, prominent next-frequency handoff banner, center + terminal frequencies, source presence) → Position/Ownership (per GUFI: controlling+freq, CIDs, handoff+freq, point-out, altitude, Line-4 HSF, ground speed, squawk/assigned, position+age, coast, status) → Terminal/STARS (entry▸exit, scratchpad, owner+freq, handoff+freq, alt/gs/squawk) → Handoff/point-out history → EDCT → Flight plan (full ICAO + equipment/capabilities) → TDLS (CPDLC + departure messages) → Surface/ASDE-X → Traffic flow/TFMS (route, procedures/entry fixes, predicted fix/center/sector transit, plan, times, position).

**No mock data blocks.** An earlier version rendered simplified ERAM/STARS data-block art in both the full page (`blocksCard`) and the text page (`EramText`). Both were removed as unrealistic — the same data (4th-line/HSF, handoff, STARS entry/exit/scratchpad) lives in the cards/rows below. Don't reintroduce the mock blocks. (`track.js` still contains the now-unused `blocksCard`/`eramBlockHtml`/`starsBlockHtml` helpers, dead but harmless.)

### TBFM metering on `/track` and the bot
`TbfmBridge.TrackSummary(callsign)` returns one typed `TbfmTrack` — **the same instance the page
serializes and the bot reads in C#**, so the two cannot drift apart on what TBFM says. It goes
through `GroupFlights`, which is what makes it inherit the three rules that are each easy to get
wrong alone: liveness (LANDED, LADD and past-STA records dropped), grouping by
`(callsign, destination)`, and **delay as the chain MAXIMUM, never the sum**.

That last one drives the display. The card's top figure is the governing hold (the max); the
per-center rows below show each link's own delay, which is what the sector working that point sees.
Summing them would double-count, because TBFM distributes a hold upstream and a center that has
absorbed it reads ~0 one point down.

Matching is **by callsign**, like TFDM — TBFM's `gufi` is ERAM's short form and SFDPS doesn't
publish it, so there is no id to join on. The departure filter keeps a TBFM chain whose `dep` is
unknown: an arrival chain with no departure field still belongs to the leg in the air, and dropping
it would blank the card on exactly the long inbound where metering matters most.

**The bot's change key carries only TBFM's discrete state** — scheduled point, runway, frozen,
suspended, and the hold **rounded to a whole minute**. The STAs and ETAs are re-estimated on every
update and would push on every drift; rounding the delay is what makes it discrete, so 4.6 → 5.1
min notifies and 4.61 → 4.62 does not. Same rule TFMS and TFDM already follow.

### What a flight is DOING: four bugs that all read as plausible text

Found by following five live flights across both surfaces rather than from a report. None threw,
logged, or moved a counter — an altitude renders as a plausible string whatever the unit, and a
phase is one word that reads fine until you check it against the flight. `TrackPresentationTests`
pins all of it, because a browser and a hand-read of the bot text confirm nothing here.

**Altitudes were in the wrong unit below FL180.** Everything printed `'FL' + ft/100`
unconditionally, so every arrival on approach was reported in a unit that does not apply to it —
`at FL10` for an aircraft on short final at 1,000 ft, `assigned FL90 · at FL166` for one at 9,000
descending through 16,600. **`FmtAlt` had the correct rule all along and was dead code, never
called once**, while the live path did its own thing. `Fl()` delegates to it now and `track.js`
has the matching `altFt()`. The data-block helpers keep the raw zero-padded hundreds — that is
what a data block shows, not prose.

**The phase label was wrong in both directions, and the fix needed three rounds.** SFDPS's
`flightStatus` and its ground speed are each unreliable in a specific way:

| symptom | cause |
|---|---|
| FL320, 477 kt, position 1 s old → `DROPPED` | SFDPS marks a flight DROPPED when the **losing** center drops the track mid-handoff, before the receiving center reports. It says nothing while radar is current. |
| landed at ATL → `AIRBORNE` | `COMPLETED` was never consulted, though SFDPS publishes it with an actual arrival time. |
| taxiing at 6 kt → `AIRBORNE` | **SFDPS's ground speed goes stale on touchdown.** Its last radar fix is on final or the rollout and then stops updating. |
| stopped on the field at 0 kt → `DROPPED` | same staleness, one level up: the position ages out, so `livePos` is false and the DROPPED test fired first. |

So **a surface movement radar outranks both SFDPS signals** for an aircraft that has landed —
ASDE-X reports every second — and the test has to sit above the DROPPED test as well as the
AIRBORNE one. Measured over 290 ASDE-X callsigns, 61 read low-and-fast off SFDPS: 43 were already
`COMPLETED`, **11 had ASDE-X under 40 kt while SFDPS claimed 81-147 kt** (several parked at 1-7
kt), and 7 were genuine rollouts, which ASDE-X also reports fast. It is gated on ASDE-X itself
reporting slow **and** a known low Mode C, which is what keeps the case the original ordering
guarded against — an airborne aircraft appearing briefly in surface data — and excludes those 7.
`AIRBORNE` is deliberately **not** gated on position freshness: a coasting flight is still
airborne, and that would flip the word across one missed scan.

**`sfdps[0]` was arbitrary, so the page and the bot could describe the same flight differently.**
`/api/track` built its SFDPS array by iterating a `ConcurrentDictionary`, i.e. in enumeration
order. The bot picks its record with `BestFlight` (non-DROPPED first, then freshest) but
`/track`'s hero reads `sfdps[0]` — and the page's pick was not merely different, it was arbitrary.
Measured on en-route traffic: 12 of 237 callsigns carry several GUFIs and 2 were mis-ordered. Low
frequency, bad when it lands — **NJZ196 led with a DROPPED record at 34,000 ft whose position was
495 s old, while the live ACTIVE record sat behind it at 20,500 ft and 6 s old.** That is exactly
the stale dead leg `BestFlight`'s own comment warns about, reaching the page through the one path
that never consulted it. `CurrentLegFirst` is now the single ordering both use; keeping them as
separate copies is how the two SimBrief URL builders drifted.

**A source listed as present must contribute a line.** The bot's `Surface` line carried only the
TDLS gate and runway, which an arrival never has, so a flight taxiing in at ATL listed ASDE-X in
its sources and then showed nothing from it. It leads with the airport and ground speed now, which
a surface track always has.

Two smaller ones in the same pass: a `RETRACTION` printed `Next: ZFW/22 · retracted`, but a
retraction is the controller taking the handoff back so there is no next frequency to name; and
the TFMS and ASDE-X cards formatted their own altitudes, so the page showed `Altitude 34000 ft`
directly beside `Assigned Alt FL340` for the same aircraft.

**The `/api/track` ASDE-X entries are `{airport, track:{…}}`** — the fields are nested one level
down. A checker reading `entry.spdKts` gets `undefined`, which `|| 0` then turns into a *passing*
comparison; that produced four false positives in the verification pass for this work before the
nesting was noticed. `track.js` has always read `asd.track.spdKts` correctly.

Verified after the fixes over 110 live flights across every phase: no bogus flight level below
18,000 ft, no `sfdps[0]` leading with a DROPPED record while a live one exists, no `AIRBORNE`
while ASDE-X has the aircraft slow and low, no retracted handoff advertised as next, and no source
listed without a line.

### The `/t` text page is disabled (and why)
`/t` was a ~2 KB, no-JS, `<meta http-equiv=refresh content=30>` page meant for constrained wifi. It is
**turned off**: `GET /t` and `GET /t/{callsign}` now 302 to `/track`, the TEXT link is gone from the page
header, and `track.js` no longer redirects there on Data-Saver/2g/repeated failures (it backs off instead).
`TrackRoutes.TextPage()` and its helpers are still in the file — re-register the two routes to bring it back.

It was removed because it never solved its problem, and its link sat next to the back arrow on a phone where
it was mostly hit by accident. Airline "free messaging" wifi blocks all HTTP/DNS except a whitelist of
messaging endpoints, so **no** web page — however small — will load; `/t` only helped on real-but-slow
internet. Apps like Flighty deliver inflight updates over **APNs push** (the same whitelisted pathway as
iMessage), not the web: the server pushes serialized lat/lon/alt/ETA every few minutes into a Live Activity,
working even in Airplane Mode. The answer for SwimReader is the Telegram bot (a whitelisted messaging
channel), not a lighter page. See [[track-text-wifi-limitation]].

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

## ERAM sectorization: vNAS Fixed Airspace Volumes beat the KML

`VnasAirspace.cs` + `GET /api/airspace/favs[/{artcc}]`. **This is the good sector geometry**; the
KML below is what it replaces.

**`GET {dataApiBaseUrl}/favs/{ARTCC}` is public, no auth.** It is not in any documentation — it was
found by pulling apart the SvelteKit bundle at `https://airspace.virtualnas.net/`, whose
`/[artcc_id]/airspace` page fetches exactly this. `dataApiBaseUrl` is resolved from
`configuration.vnas.vatsim.net` rather than hardcoded, same as CRC and the video maps. The site
itself also confirms `/api/artcc-summaries`, which carries **`eramDataLastUpdatedAt` per ARTCC** —
the freshness key, so a cached file is only re-pulled when vNAS's ERAM data actually changed.

**The API filters on User-Agent.** `curl` gets 200; `Python-urllib/3.x` gets **403**. The
HttpClient sets one explicitly — without it every ARTCC reads as "has no airspace", which is a
much more confusing failure than an error.

### What a FAV is
One sector's airspace, `favId` = `{sector:3}{volume:2}` (ZDC 00701 and 00702 are sector 7's two
volumes; the prefix matches `eramConfiguration.sectors[].sectorId` exactly, and all 54 published
ZDC sectors have at least one). Its **modules** are altitude slabs, each with its own polygon and
explicit `lowerAlt`/`upperAlt` in feet. ZDC's Gordonsville 32 is three stacked slabs —
21,100-23,000 / 23,100-27,000 / 27,100-33,400, each a different shape.

Measured 2026-11-03 across all 24 ARTCCs: **2,641 FAVs, 4,504 modules, 75,185 boundary points**,
~3.7 MB. 20 ARTCCs publish them; ZAN/ZHN/ZSU/ZUA return an empty array (the real answer, not an
error — and an empty response never overwrites a cached set that has geometry).

| | `AllSectors.kml` | FAVs |
|---|---|---|
| ZDC geometry | 78 placemarks | **141 volumes, 365 modules** |
| altitude | free text, 27 spellings for ZDC (`240-ABV`) | **numeric floor/ceiling per slab** |
| category | scraped from a KML folder name; 204 of 2,124 placemarks have no folder path, needing a regex fallback | n/a — real volumes |
| sector identity | the placemark name | **`favId[:3]` = the ERAM sector id** |
| dated | April 2025, not in the repo | 2026-10-22, fetched and cached |
| parsed | in the browser, every page load, 4.5 MB | server, cached to `vnas-airspace/` |

### Three things the data does that a first reading gets wrong
- **No ring is closed.** All 4,886 of them end somewhere other than where they start, so the
  converter repeats the first point; without it the polygon is invalid and renderers disagree.
  FAV points are `lat`/`lon` objects, GeoJSON wants `[lon, lat]`.
- **`99xxx` is not junk, it is "and above".** No module has a *normal* ceiling above 98,990, while
  **464** pair a normal floor with a 99,000-99,900 ceiling — ZAB 06701 runs 30,000 to 99,100, i.e.
  FL300 and above. Dropping those would delete the ceiling of every high sector in the country;
  they are reported `upperAlt: null, unlimitedCeiling: true`. Separately, **224** modules have
  *both* ends ≥ 99,000, in a ladder of 100 ft bands at 200 ft spacing ((99800,99900) alone 117
  times). What that encodes is **not known**, so they are kept, flagged `sentinel: true`, and
  hidden unless asked for — never matched by an altitude query.
- **`excludeModules` are a 3-D subtraction, not a polygon hole.** Only 38 of 382 share an altitude
  band with any parent module; ZAU 01101 subtracts just the bottom 100 ft of a 0-10,000 volume. As
  a GeoJSON interior ring that area would vanish at *every* altitude of the feature, so they travel
  as their own features with `exclude: true` and their own band.

### Bands are inclusive and tile with a 100 ft step
1,805 of ~1,830 consecutive module pairs gap by exactly +100 ft, so 23,000 and 23,100 are
**adjacent**, not 100 ft apart with a void between. An overlap test taken literally returns nothing
for an aircraft reporting 23,050 — a real hole, since Mode C is not restricted to band edges. The
query therefore treats a ceiling of C as covering C+99; the reported `upperAlt` is untouched.
`VnasAirspaceTests` pins this, and caught it.

Caching keys on **`eramDataLastUpdatedAt`**, which `/api/artcc-summaries` carries per ARTCC — but
that stamp has to survive the restart or it is useless. The first version threw it away on
`LoadCache`, so every restart re-downloaded all 20 ARTCCs (**4.3 MB**) even with a current cache,
and the auto-deploy timer restarts on every backend push. It is now kept in a `_fetched.json`
sidecar beside the cached bodies — a sidecar rather than a field inside each file, so the cached
body stays byte-identical to what vNAS served.

### The AIXM feed already says who owns which volume
`AirspaceBridge` (the AIXM position data, confusingly also `[AIRSPACE]` in the log — the FAV client
logs `[FAV]`) reports per ERAM position the **5-digit volume ids that position owns**: ZDV position
07 owns `00701, 00702, 00703, 00800, 06100, 06700`. Sampled against ZDV's FAV set, **28 of 28 were
a `favId`**. So AIXM gives ownership *now* and FAVs give the shape — join them and you have the
real combined/decombined sectorization, color-coded by the position actually working it, which no
static file can express. Nothing consumes the join yet; it is the reason to do the scope work.

`?lowFt=&highFt=` filters to the slabs overlapping that band, `?sector=` to one sector (bare or
zero-padded), `?sentinel=true` includes the 99k-only modules. **The ERAM scope still draws the KML**
— switching its boundary layer over is the open piece of work, and the interesting part is that the
sidebar's existing FL low/high filter can then reshape the boundaries, which the KML cannot do.

## KML Sector Boundaries (legacy — see FAVs above)

Place KML files in the repo root (gitignored, not committed):
- `AllSectors.kml` — auto-loaded by eram.html via `/api/kml/AllSectors.kml`
- `AllHighSectors.kml`, `AllLowSectors.kml` — available via API, toggleable in sidebar
- KML categories parsed from `<name>` tags: UHI (ultra-high), HI (high), LO (low), APP (approach)

## TBFM metering → ERAM STA / DELAY RDBs (needs its own subscription)

**None of the five feeds carry TBFM schedules.** STA and meter-fix delay come from the **TBFM
Metering Information Service (TBFM MIS)**, a separate SCDS subscription. `TbfmBridge` consumes it
with `TBFM_HOST`/`TBFM_VPN`/`TBFM_USER`/`TBFM_PASS`/`TBFM_QUEUE` (`TBFM_FLOWS` for receivers, default **6**: TBFM runs 164-550 msg/s, several times SFDPS,
and 3 flows sat at ~12 s lag that never drained), and
stays disabled while `TBFM_USER` is unset. It runs inside the `SWIM_FEED_HOST` guard like the others.

- Message shape (verified live 2026-11-02): `<env envSrce="TMA.ZOB.FAA.GOV">` → `<tma>` →
  `<air aid apt dap gufi tmaId cid airType>`, then `<sta><mfx/><sta_sfx/><sta_dfx/><sta_rwy/></sta>`
  and `<eta><eta_sfx/><eta_dfx/><eta_mfx/><eta_rwy/></eta>`, usually in **separate** messages.
  **There is no `sta_mfx`**: the meter-fix STA is `sta_sfx`/`sta_dfx` (equal in every sample), and
  `eta_mfx` can differ from `eta_sfx` by ~1 min, so delay pairs `sta_sfx` with `eta_sfx`.
  `GET /api/tbfm/debug` keeps 20 raw samples plus a count of every element name seen.
- TBFM's `gufi` is ERAM's short form (`KK756252Wv`). **SFDPS doesn't carry it** (its GUFIs are UUID
  or `us.fdps.*`), so matching to a target is by callsign + destination.
- **One flight, several STAs.** Each ARTCC's TBFM (`envSrce` `TMA.ZLC.FAA.GOV`, exposed as
  `ctr: "ZLC"`) publishes its own record with its own meter point. Extended metering means a DFW
  arrival can be metered by ZLC to `D34S`, ZDV to `ABQ` and ZAB to `CME` at once; ~23% of
  callsigns had more than one record. The scope shows only the record whose `ctr` is the selected
  facility (or the controlling center when none is selected), the same rule as CIDs, and nothing
  when that center isn't metering the flight.
- Updates are partial; fields merge non-null onto a record keyed `envSrce/tmaId` (fallback `aid/apt`).
  Purged 20 min after the last update, or 10 min after the **latest** of its meter-fix and
  runway STAs has passed — not the first of the two, or the record would vanish while the
  runway STA was still ahead of the aircraft (which `EramSnapshot` is willing to show).
- **`mfx` is "the point this center schedules to", not necessarily the airport's meter fix**
  (live: ZLA schedules an MRY arrival to `BSR`). The message names no arc: arcs appear only as
  times (`sta_oma`/`ooa`/`o3a`/`o4a`), exposed as `arcs` in `/api/tbfm/eram`.
- **Scope shows the next point ahead**: `o4a → o3a → ooa → oma → mfx → rwy`, the first whose ETA
  hasn't passed. Real ERAM picks per sector from site adaptation SWIM doesn't publish, so this
  approximates what the sector working the flight would see.
- **Expiry is per time**: each STA (meter point, runway, each arc) is dropped once it is over 60 s
  past and **that STA** hasn't been re-sent since. Not per message (TBFM keeps sending route-only
  `<flt>` updates for schedules long past: GLH3, STA = ETA 40 min ago), and not per record either:
  ASA481's record stayed fresh from meter-fix and runway times while its OMA STA sat 13 min dead
  with the ETA still ahead, and the scope showed a bogus `-15:20`. `ageSec` is also
  time since the last schedule update, and the scope prefers the freshest record per center.
- `GET /api/tbfm/eram` gives the scope its compact records. **LADD callsigns are dropped there**,
  because the scope matches by callsign.
- Scope (`eram.js`): polls every 15 s, and only while STA RDB or DELAY RDB is on. Matching is **by
  callsign**, narrowed to the record whose `ctr` is the selected facility (or, with none selected,
  the controlling center) and to the destination when both sides know it, freshest `ageSec` winning
  a tie. **Not by GUFI** — TBFM's is ERAM's short form and SFDPS doesn't publish it, which is the
  whole reason the match is by callsign. The
  RDB shows the meter-fix STA as `HHMM` (runway STA if there's no meter fix). Delay is `STA − ETA`
  at the same point, rounded to 10 s, as `+02:30` (sign, MM:SS), drawn **white-gray** (not FDB
  yellow, not CRR magenta). Reference: `docs/img/eram/data-blocks/rdb-sta-dct.png`, an ERAM
  STA / DCT / Both slide (`0432`, `-12:20`, `0432 -12:20`, one line below the target). It agrees
  with a NASA 2019 FIM study's MACS ERAM emulation (NTRS 20190000841, Figs. 4–5), which also gives
  the 10 s rounding and "positive = must be delayed". **What DELAY FORMAT really toggles is undocumented**; here OFF (the
  default) is sign + MM:SS (`+03:20`) and ON is whole minutes (`+3`), via `delayFormatMinutes`. It shares the RDB with the CRR distance and follows the same `Ctrl+Shift+O` offset. **Live only**: TBFM isn't recorded, so
  replay and incident views show no metering rather than today's.

### TBFM message kinds and tag glossary

Four kinds arrive on the queue (inventoried from ~900 live messages, 2026-11-02). Each is parsed;
anything under `<tma>` we don't model is counted in `/api/tbfm/debug` → `unknownKinds` (empty so far).

| Kind | Root | Parsed into |
|---|---|---|
| Flight schedule | `env/tma/air` | `TbfmFlight`: times, plus raw `flt` / `mrp` / `sch` leaves |
| Adaptation | `env/tma/adp` | `TbfmCenter`: meter points, airports, gates, stream classes, TRACONs |
| Config | `env/tma/con` | `TbfmCenter.Rates`: `aar` (airport) and `tar` (TRACON) acceptance rates |
| Heartbeat | `mis/hb` (`misSrce`) | `TbfmCenter.LastHeartbeat` |

`<air>` attributes: `aid gufi cid tmaId apt dap`, and `airType` **NEW / AMD / DEL**. **DEL removes
the schedule** (5 in ~900 messages). Meanings below marked *(guess)* are inferred from values, not
from the spec (TBFM MIS JMSDD, NSRR); the raw tag is always what the API returns.

- **`flt`**: `aid` `dap` `apt`; `typ` type/equipment (`B38M/L`); `bcn` beacon; `a10` NAS route
  (field 10); `ara` requested altitude; `ina` *(guess: initial/assigned altitude)*; `spd` filed
  speed (kt or Mach); `eng` JET / TURBO_PROP / PISTON; `cfx`/`ctm` coordination fix/time; `etd`;
  `std` scheduled departure (TBFM release time); `acs` track status TRACKED / PROPOSED / ACTIVE /
  INACTIVE / LOST / **LANDED**; `fps` flight-plan status ACTIVE / PROPOSED / DEPARTED; `tds`
  *(guess: track data source: a center, TRACON, TFM)*; `tcr` fix list `FIX/0000 …` *(guess)*;
  `drw` departure airport_runway (`BUF_23`); `est` FAA; `etm`, `trw` seen empty.
- **`mrp`** (this schedule's meter points): `mfx` meter fix, `sfx` / `dfx` the points the
  `sta_sfx`/`sta_dfx` times refer to, `oma`/`ooa`/`o3a`/`o4a` **arc names** (`MOXEE/T`), `rwy`,
  `gat` gate, `scn` stream class, `tra` TRACON, `cfg` runway config, `cat` ARRIVAL /
  SATELLITE_ARRIVAL / SATELLITE_TO_EXTERNAL / OVERFLIGHT.
- **`sch`** flags YES/NO: `sfz` schedule frozen, `rfz` runway frozen *(guess)*, `sus` suspended,
  `man` manual; plus `mfx`.
- **`eta` / `sta`**: `mfx` plus `{eta,sta}_{sfx,dfx,mfx,oma,ooa,o3a,o4a,rwy}`. Kept raw in `times`.
- **`adp/mrns/mrn`** meter reference point: `nam`, `mrt` type **MFX** fix / **MFA** meter-fix arc /
  **OMA** outer arc / **OOA** outer-outer arc, `gat`, `lat`/`lon` as DDMMSS(N/S)/DDDMMSS(E/W)
  (parsed to decimal), arcs add `rad` radius nm and `lan`/`ran` left/right angles; `mfx`, `oma`,
  `alo`/`ahi` altitude band. Arc names carry a trailing `.` (`HELNS.`) beside the fix `HELNS`.
- **`adp/apns/apn`** airports with `rwns` runways and `cfns` runway configs (`S_28` → 28L/28R);
  `gans` gates; `scns` stream classes (`PDX_HELNS_JETS`); `tra`/`trn` TRACON.
- **`con/aar`** (`apt`, `tra`, `rat`, `tim`) and **`con/tar`** (`tra`, `rat`, `tim`, `tarType`).

**`mfx` is whatever point that center schedules to, arc or fix.** Live: ZLA schedules N650AL
(SAN→OAK) to `PXN`, which is an arc, labeled `<mfx>`. Only the center's adaptation (`mrn/mrt`)
says which, exposed as `pointType` (MFX / MFA / OMA / OOA; null until that center's adaptation has
arrived). Adaptation is published rarely (one center in a ~10-minute capture, none in the first
minutes after a restart), so it is saved to `flight-cache/tbfm-adaptation.json` (on change, from
the 60 s purge timer) and reloaded on startup.

**`point` is the `sfx` point when `mrp` names one, else `mfx`**: `staPoint`/`etaPoint` come
from `sta_sfx`/`eta_sfx`, and `sfx` can differ from `mfx` (live: ZAU AAL1614, mfx `MOTRR`, sfx/dfx
`FYTTEMF`, with `eta_mfx` ≠ `eta_sfx`). The meter fix is kept separately as `meterFix`.
Our JSON therefore names it neutrally: **`point` / `pointType` / `staPoint` / `etaPoint`** (it was
`mfx`/`staMfx`, which read as "meter fix" for every arc). The raw `mrp` block keeps TBFM's tags.

**Tests:** `tests/SwimServer.Tests/TbfmBridgeTests.cs` drives the parser with messages shaped
like live traffic (callsigns/times made up; captured SWIM traffic isn't committed). Run with
`dotnet test tests/SwimServer.Tests -c Release`: Release, because a running local server locks
the Debug output.

**Not persisted on purpose:** TBFM flight schedules, like TFMS/TFDM/ASDE-X/TAIS live state, are
rebuilt from the feed. A restart costs a few minutes of fewer DCTs (measured: ETA pairs back to
66% within ~26k messages) — not worth a shutdown step or SD-card writes. Adaptation, which is
rare, is the part that is saved.

APIs: `GET /api/tbfm/flight/{callsign}` (every center's full record), `GET /api/tbfm/centers`
(heartbeat, schedule count, adaptation size, rates), `GET /api/tbfm/adaptation/{center}` (points
with arc geometry, airports, gates, streams). `/api/tbfm/eram` now also carries `mrp` and `sch`,
and drops schedules whose `acs` is LANDED.

### The /tbfm dashboard — the feed is per-center, the question is per-airport

`/tbfm` (directory, two tabs), `/tbfm/{airport}` (arrival metering board), `/tbfm/center/{ctr}`
(meter points + adaptation map). Projections in `TbfmDashboard.cs` (`partial TbfmBridge`, read-only
over the same state); pages in `wwwroot/tbfm/`.

**A row is an airplane, not a schedule.** TBFM meters a flight once in *every* ARTCC it crosses on
the way in — each center schedules it across its own boundary gate, and only the last link, the one
adjacent to the arrival TRACON, carries a runway STA. Measured live (2026-11-03): **5,612 schedule
records were 2,638 distinct flights**, chains 1-8 centers long, and **PHX arrivals were being
metered by all 20 CONUS centers at once**. So everything groups by `(callsign, destination)` before
it counts anything, and the board's row expands to show the chain nearest-the-field-last.

Exactly **0 or 1** record per flight has a runway STA (verified across the whole snapshot), so "the
terminal schedule" is unambiguous. `mrp/tra` names a real TRACON only on that record; every upstream
one says `EDC` (Extended Metering), with `cat` = `OVERFLIGHT` / `SATELLITE_TO_EXTERNAL`.

#### Two delay roll-ups, both correct, don't merge them
Delay is `STA − ETA` at one point.
- **A flight's** delay is the **maximum** over its chain, never the sum. TBFM distributes a hold
  upstream, so once a center has absorbed it the next point downstream reads ~0 — live, AAL1754/PHX
  took **+5.8 min at ZDV/GUP and 0.0 at ZAB/ZDVPHXX** one point later. Summing double-counts.
- **A meter point's** delay is its own record's, because that is what the sector working that point
  sees. `CentersSnapshot` and `CenterBoard` use this; `AirportsSnapshot`/`AirportBoard` use the
  other. `TbfmDashboardTests` pins both.

#### Negative delay is real and is not clamped
~4% of records have STA before ETA, which TBFM cannot deliver. It comes out of this bridge's
merge-on-non-null semantics: when a schedule's scheduled point changes (live: DAL348/PHX, `sfx`
moved to PINNG from BRDEY) the older `sta_sfx` survives against the new `eta_sfx`. A big negative is
the *signal* that a record's two times are from different schedules, so it is displayed, not hidden.

#### 3600/hr is TBFM's "no restriction" default, not a rate
**53 of 57** published AARs sat at exactly 3600 — including DVT and SDL, fields that could not take
one an hour — with effective times days old, while the only four real ones (**ORD 100, FLL 56,
MIA 40, MDW 28**) had been set that day. Pages show 3600 as "none"; `restricted` is the flag worth
reading. `aac`/`sac`/`scc` carry **no `<rat>` at all** (their payload is stream-class and
scheduling-constraint data `ProcessConfig` doesn't model), so they are counted as
`otherConfigKinds` rather than listed as blank rates.

#### The adaptation map
`lat`/`lon` on an arc point is the arc's **center** (the TRACON reference), not a point on it — ZLA's
ACAS and AKIM share 33.933/-118.432, which is the LAX reference. An arc is drawn **clockwise from
`lan` to `ran`** at `rad` nm, wrapping through 360 (ACAS 330°→40° is a 70° span). Points with
`rad` are arcs (MFA/OMA/OOA/O3A/O4A); those without are meter fixes (MFX) and plot as dots —
118 of ZLA's 172 points have a radius, which is exactly its non-MFX count. Adaptation is published
rarely, so a center with no geometry yet is normal and the page says so instead of drawing nothing.

#### ARTCC boundaries under it come from vNAS, not the FAVs

`GET /api/airspace/artcc-boundaries` serves vNAS's own `ArtccBoundaries.geojson` verbatim — the URL
is resolved from `configuration.vnas.vatsim.net` (`artccBoundariesUrl`) like the video maps and the
FAVs, not hardcoded. **24 features, one Polygon per ARTCC keyed by `properties.id`, ~32 KB**, cached
to `vnas-airspace/_artcc-boundaries.geojson` on the daily FAV refresh and defended the same way: a
replacement must parse as a non-empty FeatureCollection or the held copy stands.

**This is the right source for "just the high altitude boundaries", and the FAVs are not.** An ARTCC
boundary has **no high/low variants** — vNAS publishes a single lateral outline per center — so
there is no altitude parameter to expose and none is accepted. The FAVs are per-sector,
per-altitude-slab volumes (2,641 nationally) and drawing them here would bury the adaptation the
page exists to show.

On `/tbfm/center/{ctr}` the overlay is fetched **once** into its own layer and its own pane
(z-index 350: above tiles at 200, below overlays at 400). Both halves matter — `layer` holding the
meter points is torn down and rebuilt on every 10 s refresh, so boundaries riding on it would be 24
polygons re-added six times a minute, and the pane pins them *under* the adaptation rather than
trusting add order to survive each rebuild. The center's own boundary draws solid and brighter, its
neighbors dashed and dim; all are `interactive: false` so they can never take a tooltip from a
meter point. The practical payoff is that extended metering becomes visible as points sitting in
somebody else's center.

`LoadCache`'s FAV scan now skips any `_`-prefixed file rather than naming the stamp sidecar
explicitly — no ARTCC id starts with one, so one rule covers anything added later instead of each
new file parsing as a FAV list until someone notices.

#### Rates are not persisted, adaptation is
`<con>` is ~1.3% of TBFM traffic, so a center's acceptance rates take up to an hour to repopulate
after a restart and the center board says so rather than showing a bare "No rates published", which
reads like a fault. Adaptation is the part that is cached to disk.

#### The maps draw traffic, and TBFM contributes none of the positions

Both the center map and the airport board's "inbound funnel" draw the metered aircraft, not just
the adaptation. **TBFM publishes no position anywhere in the feed** — not on `<air>`, not in
`flt`; the only lat/lon it carries is adaptation geometry, and for an arc that is the arc's
*center*. So every target is a TBFM schedule joined to **SFDPS by callsign**, which is the same
join `TrackSummary` and the arrival board already use and for the same reason: TBFM's `gufi` is
ERAM's short form and SFDPS doesn't publish it, so there is no id to join on.

Measured at ZLA before building it: **215 of 249 metered callsigns (86%) had an SFDPS position,
age p50 6 s / p90 9 s.** All 33 misses were oceanic or international inbounds — HNL, ZSPD, MMGL,
MMMX, PHOG, MPTO, VHHH, RCTP — which TBFM has as `TRACKED` and is already metering while they sit
outside domestic radar. **TFMS fills only 2 of those 33**, so that gap is a coverage boundary, not
something a second source closes; the count travels in the response and the legend says it out
loud rather than quietly drawing fewer targets than it reports scheduled.

`GET /api/tbfm/center/{ctr}/traffic` and `/api/tbfm/airport/{apt}/traffic`, both served by one
`TrafficResponse` helper in the route — **not** inside `TbfmDashboard`, which is documented as
read-only over the TBFM state and holds no SFDPS. They are deliberately **not** a bulk position
dump: only the callsigns being metered, which is why they need no operator gate where
`/api/enrich/aircraft` does. Both sides already drop LADD (the TBFM side via `IsLive`, the SFDPS
side via `LaddService.IsBlocked`), so the two cannot be combined to locate a blocked aircraft.

The two pages differ in exactly one thing, decided server-side: a **center** map shows that
center's own link for each flight, because that is what its controllers are scheduling; an
**airport** map shows the *next* link whichever center owns it, because for a flight six centers
out the answer belongs to a center that is not this airport's at all.

**A stale position is worse than none.** SFDPS keeps a flight 60 minutes past its last update, and
the first live run drew SKW3759 from a **55-minute-old fix** — hundreds of miles from where that
aircraft was, on a map whose entire subject is proximity to a meter fix. Capped at 120 s and
counted as `stale`, separately from `unlocated`: the two look identical on the map and have
nothing to do with each other.

#### The velocity vector was 60x too long, which is what a second copy buys you

Reported as "the leader lines are super long". They were not the leaders — they were the velocity
vectors, drawn at sixty times their length. `vx`/`vy` are **knots**, so one minute of travel is
`v/3600` degrees; the code said `v/60`, which is an **hour**. At 450 kt every target grew a 450 nm
spike and the CONUS view became a starburst of several hundred crossing lines with the adaptation
somewhere underneath. **`eram.js` has had the correct formula since forever**
(`* vectorMinutes / 3600`).

Both maps now run off **`wwwroot/tbfm/map.js`**, which holds the geometry that is easy to get
wrong — the point *on* an arc rather than its center, the clockwise span, knots-to-degrees — plus
the boundary layer, the traffic layer and the controls. `center.js` went 532 → 289 lines with no
behavior change. This is the third time this repo has paid for two copies of one rule (the
SimBrief URL builders, `CurrentLegFirst`); the vector bug is what the third copy produced.

`TbfmMap` is published as **`window.TbfmMap`** explicitly. A top-level `const` in a classic script
is not a window property, and `GlobalScopeContractTests` exists because a day was lost to two
objects of the same name being silently different values.

**Lengths are controls, not constants.** `VECTOR` (off / 1 / 2 / 4 / 8 min) and `LEADER`
(off / 20 / 40 / 80 nm / to the point) — a leader to a meter point is legitimately 1,500 nm long,
which is true and unreadable; a clipped one keeps the whole content of the line (which fix, which
direction) and drops the part that only crosses everything else. `EXPAND` and `FULL SCREEN` are
there too, and the thing that makes those more than a CSS class is that **Leaflet caches its
container size** and reuses it for tile layout *and* hit testing — so without `invalidateSize()`
an enlarged map paints its old viewport into the corner and puts every tooltip in the wrong place.
The call runs in a `requestAnimationFrame` (measuring in the same frame as the class change reads
the old height straight back), and is wired to `fullscreenchange` and `resize`, not just the
button.

**`.maplegend i` is the color-swatch rule** — an 18×2px inline-block. An `<i>` used for emphasis
inside legend prose renders as a tiny blank bar with the word floating beside it, which shipped on
both maps. Emphasis is `<em>` there.

#### What a flight is metered UNDER (`/track` and the bot)

The ARRIVAL METERING card answered "is it held and by how much" and said nothing about the
structure TBFM is sequencing the flight within. All of it was **already parsed and in the API, and
nothing rendered it**: the arrival gate, the stream class, the TRACON, the runway configuration,
the metering type (ARRIVAL / SATELLITE_ARRIVAL / OVERFLIGHT), and the airport's **meter fix** —
which is *not* always the point a center schedules to, since TBFM schedules to `sfx` and live ZAU
had AAL1614 at sfx FYTTEMF with mfx MOTRR, their ETAs differing. The arcs ahead of the fix are
there too: a flight crosses OMA / OOA / O3A / O4A on their own STAs before it reaches the fix.

The roll-up reads the **terminal link** — the one adjacent to the arrival TRACON, and so the only
one naming a real TRACON or a runway config — falling back to upstream links for the fields they
do carry, so a flight six centers out still says something.

**`RealTracon` drops "EDC".** Every upstream link reports `tra=EDC`, which is *Extended Metering*,
not a facility; rendering it raw tells a reader their flight is worked by a TRACON called EDC. The
raw per-link rows still show what TBFM said, which is where EDC belongs. Pinned by
`TbfmDashboardTests` and verified by mutation: removing the guard fails one test, pointing the
roll-up at the first link instead of the terminal one fails two. **A browser cannot see either** —
a TRACON called EDC renders as a perfectly plausible string.

Both lines live on `TbfmTrack`, the one instance `/track` serializes and the bot reads in C#, so
the page and the bot cannot drift. Verified live across six flights of different shapes (arrival
with a runway schedule, overflight, satellite-to-external, a 49.4 min hold): every structure field
the API reported appeared in the bot's `Metered under:` line, and no EDC leaked into either.

#### `oth` carries two different payloads, and a one-slot ring hid that

`KeepUnknownSample` kept **one sample per kind**, so the newest `oth` overwrote the other and
whichever arrived last looked like the whole story. There are at least two:

```xml
<oth><tmg tmgType="NEW"><tra>MCO</tra><tmss>
  <tms><apt>MCO</apt><ctr>ZJX</ctr><mas>NO</mas></tms> …
</tmss></tmg></oth>                                    <!-- metering ON/OFF per airport per center -->

<oth><int><ifn>ZLC</ifn><ift>ERAM</ift><ifs>UP</ifs><ifm>DN</ifm></int></oth>   <!-- interface status -->
```

A parser written from either one alone would have silently ignored the other. The ring is keyed by
kind **and first-child shape** now, so each payload survives to be read *before* anything is
written against it. Still unparsed — `mas` is the fact the boards most want and currently infer
from whether schedules exist.

#### Not surfaced yet
`oth` is still unparsed (both payloads above, ~10.5k seen) and the `flt` block carries more than
the pages use — `tcr` (route with per-fix crossing times), `cfx`/`ctm` (coordination fix + time),
`apreq`, `ina`, `est`, `fps`, `drw`/`trw`. They are all already captured raw in `TbfmFlight.Flt`, so
`GET /api/tbfm/flight/{callsign}` returns them today; the board shows `typ`/`acs`/`bcn`/`tds`/`ara`
and the filed route (`a10`).

## ITWS: only PHL has the alerting products (queue subscription, not a bug)

"ITWS isn't showing anything" is usually this. The feed is healthy (~11 msg/s, no discards) and the
page parses fine; what varies is **which products our SCDS queue is subscribed to per site**.

Measured from `/api/itws/topics` (topic shape `ITWS/{productMsgId}/{itwsSite}/{airport}`):

| product | id | sites delivered |
|---|---|---|
| AP Status, AP Indicated Precip, Precipitation TRACON, SM SEP TRACON, ITWS Status, Forecast Accuracy/Contour/Image, Terminal Weather Graphics, Long Range precip + SM SEP | 9847/9848/9850/9912/9897/9902/9903/9901/9843/9905/9906 | **32-34** |
| Precipitation 5nm, SM SEP 5nm | 9849/9911 | 14 |
| Terminal Weather Text Normal | 9844 | 7 |
| **Configured Alerts** | **9840** | **1 (PHL)** |
| Hazard Text TRACON, Microburst ATIS, Wind Shear ATIS, Gust Front TRACON/ETI, Wind Profile, Tornado Alert | 9858/9893/9894/9833/9834/9837 | **1 (PHL)** |

`Configured Alerts Product` alone feeds the **Surface Wind, Runway Winds, Runway Alerts and Ribbon**
cards — the top of the dashboard — so at the other 89 sites those four are empty by construction and
say so ("No Configured Alerts product (this airport may not be in the alert subscription)"). PHL
carries 20 products; the next best are SDF/OKC/IND at 10.

Widening it is a change to the **queue's subscription in the FAA SCDS portal**, not to this code:
`ItwsBridge` adds no topic subscriptions of its own, it just binds the queue and takes what arrives.

Two more reasons a site can look blank, both legitimate:
- **Calm weather.** `SM SEP` reports `cells=0` and `prcp_grid_max_precip_level` is 0 when there is
  nothing to draw, so the storm, precip and weather-map cards are correctly empty.
- **Sub-sites.** `/api/itws/airports` lists ~90 entries but only ~34 get real products; the rest
  (PRC, PDK, STT, SUS, STP, VGT, MHT, CPS, JAN, BED, PVD, PWK, …) appear only because a topic named
  them as a sub-site (`ITWS/9844/MIA/DJT`), and have 1 product each. Clicking them shows nothing much.

A real bug did hide behind this: the **home page's ITWS card** had a `.count` slot that nothing in
`home.js` ever wrote to, so it was blank regardless of feed health (as were TFDM and SECTORS). Any
new card needs its count wired there explicitly.

## Airline intel: per-fleet utilization, destinations and routes

`/airlines/{icao}` FLEET tab. With no fleet selected it compares every type side by side
(tails, legs, air h, **h/tail/day with a bar**, legs/tail/day, avg sector, turn, destinations,
routes, share); selecting one shows that fleet's utilization, top ten destinations and top ten
routes above its tails. Clicking a comparison row selects the fleet, same as the chips.

All of it is rolled up in `AirlineResearch` `typeRows` — server-side, so the numbers match
`GET /api/airlines/{icao}` and the page doesn't re-derive them from every route on each render.
The inputs (`RouteAcc.ByType`, `AptAcc.ByType`) were already being accumulated for the network
map's type filter; they just were never rolled up per fleet.

**`activeTails` vs `parkedTails` is the one to keep.** A fleet average of 8.5 h/day reads very
differently when a third of the airframes never moved, and that was invisible before.

**Sector time and sector distance are not measured over the same thing.** `avgSectorNm` is the
great-circle between the route's endpoints; `avgSectorMin` is air time we observed, which stops
at the edge of US airspace. For a domestic fleet they agree. For a long-haul one they cannot —
DAL's A359 read *2h03 · 5,031 nm*, i.e. 2,450 kt. The page derives the implied ground speed and
flags the cell above 650 kt, which also catches a narrowbody flying transatlantic; a hard-coded
widebody list (which is what I wrote first) would not. The same caveat applies to `hours`,
`hpd` and `utilPct` for those fleets: domestic portion only.

Sanity check worth repeating after changes here: **the per-fleet leg counts must sum to the
carrier's total** (they do — 46,932 for DAL over 14 days). Tails with no known type are excluded
from fleets but still counted in the carrier total, so a mismatch means double-counting.

## Flight history search — what's indexed decides what's findable

`GET /api/history?q=&date=` searches one day of `flight-history/{date}.jsonl`; the flight table
fires one request per date across the `HIST_MAX_DATES` (7) most recent days as you type, and merges
the hits in beside the live flights.

**The per-day `.idx` carries callsign, computerId, origin, destination, registration and
aircraftType** — plus the byte offset/length of the record. A clause on an indexed field filters the
index (instant) and only those records are read. Anything else is *residual*.

**Residual clauses used to be answered from the first page of the day.** The old path took the
first 500 index entries, read 200 of them and filtered those — so `type:B752` returned **1** result
on a day whose file holds **844** B752 records, and the same was true of `route:`, `rmk:`,
`op:`, and of mixed queries like `op:FDX type:B763`. It looked like a thin day, not a bug.

Now any query with a residual clause goes to `ScanDay`, which streams the whole file:
- a **literal pre-filter** — every no-wildcard pattern ≥3 chars must appear verbatim in the raw
  line before the JSON is parsed, which is what keeps a 300 MB day at ~1-2 s;
- an **8 s budget**, so a pathological query degrades to partial results instead of hanging;
- a **`SemaphoreSlim(2)` gate**, because the table fires ~7 of these at once while you type and the
  SWIM parse threads must not lose CPU to a search on a 4-core Pi;
- the newest `limit` matches are kept (records are appended as flights purge, so the tail is recent).

**A bare token matches aircraftType too**, matching `DEFAULT_FIELDS_ALL` in the live table. The
asymmetry was the original report: typing `b752` found the two live B752s and nothing historical.

**Adding a searchable field means adding it to the index**, or it silently takes the scan path. The
`.idx` is versioned with a leading `#fhidx\tv2` line; an older file is deleted and rebuilt from the
`.jsonl` rather than read with the new column missing, which would make those searches quietly
empty. Bump `IdxVersion` whenever the column layout changes.

## Airport Operations board (`/airport/{id}`)

A tower-style ASOS board: current wind on a north-up compass rose with that airport's runways drawn
**to scale and in their real relative positions**, the head/crosswind split for every runway end, and
the field's pressure/temperature state over the raw METAR. `AirportOpsRoutes` + `wwwroot/airport/`.

**Two sources, both of which were already here.**
- **NASR** gives the runways. `APT_RWY.csv` has dimensions/surface/lighting; `APT_RWY_END.csv` has
  one row per end with `TRUE_ALIGNMENT` and the threshold lat/lon — which is what makes a real
  diagram possible rather than a sketch. ~23k runways over ~19k airports. `APT_BASE` now also keeps
  field elevation, magnetic variation, name, city/state and ARTCC (`NasrData.AirportInfo`).
- **METAR** comes from `aviationweather.gov/api/data/metar?format=json&hours=6`, not the raw-text
  endpoint in `MiscRoutes`. The JSON form returns the observation already parsed (wind, temp,
  dewpoint, altimeter, cloud layers, flight category) *plus* history, which feeds the preceding-wind
  arrows and the 6-hour trend. Writing our own METAR parser would be a liability for no gain.

### Two palettes, not the site-wide yellow
`data-theme` on `<html>` selects **day** (the pale blue field / white panels / navy labels / cream
readout boxes the real ASOS boards use — color carries meaning there: blue is a heading, cream is an
instrument value) or **night**, remembered in `localStorage` and defaulting to the OS preference.
Every color on the page, including the SVG rose, runways and trend, is a CSS custom property and
the drawing code sets *classes*, never `fill`/`stroke` — so switching themes restyles what is
already on screen and redraws nothing. Note `/shared/frame.css` styles the bare `<header>` dark, so
the board overrides that while keeping its 100px left pad for the floating HOME button.

**Everything derived is computed server-side** — RH (Magnus), pressure and density altitude, heat
index (NWS Rothfusz) or wind chill, and the per-end head/crosswind — so every client reads the same
numbers and they can be checked with `curl`.

### True vs magnetic — the thing to never get backwards
A raw METAR's wind and NASR's `TRUE_ALIGNMENT` are **both TRUE**, so head/crosswind needs no
variation applied. A runway's *number* is magnetic, and `magnetic = true - declination` with
declination **east-positive** (`MAG_VARN` is unsigned with the hemisphere in its own column, stored
signed by `ParseAptBase`). The first version added it instead and IAD's runway 01C came out at 351°.

**The runway numbers are a free regression test**: each end's magnetic alignment must round to its
own painted number. Over 168 ends at 18 major airports, 22 "fail" — and all 22 are the FAA's
>3-parallels rule, where an extra pair is numbered one off from its actual heading (DEN 16s vs 17s,
LAX 06s vs 07s, ATL 08s vs 09s/10s, MCO 17s vs 18s, PHX 07s vs 08s). Zero unexplained. Re-run that
check after touching anything here.

### Deliberately missing
No lightning/thunderstorm panel like the displays this is modeled on. ITWS publishes lightning but
it is **not on our SCDS queue** (26 product types, none of them lightning), and a panel that can only
ever say "0 strikes" is worse than no panel.

### Route patterns, not regexes
`/airport/{id:length(3,4)}`. A regex constraint's own braces must be doubled in a route pattern —
`{id:regex(^[A-Za-z0-9]{3,4}$)}` throws `RoutePatternException` **while mapping endpoints at
startup**, so the process aborts and systemd restart-loops: the whole site goes down, not just the
new page. Prefer `length()`/`minlength()`/`maxlength()` where they say the same thing.

### Screenshotting a page for review
`--dump-dom` includes the `<script>` source, so a regex for card markup happily matches unevaluated
template literals and looks like success; and plain `--screenshot` can't get past the first-launch
disclaimer, which is gated on a `swimAck` cookie. Drive headless Chromium over DevTools instead:
set the cookie with `Network.setCookie`, navigate, settle, `Page.captureScreenshot`, and collect
`Runtime.exceptionThrown` / `Log.entryAdded` so console errors are visible. (`chromium` and
`websocket-client` are both already on the Pi; pass `--remote-allow-origins=*`.)

## The ERAM scope's opening snapshot (why it used to take forever)

`/ws` sends every flight with its full plan on connect: ~6,900 flights, **17.6 MB of JSON, 5.3 s
over loopback** and much worse through the Cloudflare tunnel, before the browser has parsed a byte.
Two things fixed it; both are measurements worth keeping.

**`permessage-deflate` was never enabled on any socket in this repo.** This payload deflates
**7.2x — 17.8 MB to 2.08 MB**. It is one argument on `AcceptWebSocketAsync` and needs no client
change, since browsers negotiate the extension automatically. Verify with the handshake, not by
guessing: the response must carry `Sec-WebSocket-Extensions: permessage-deflate`. Note the API is
named `DangerousEnableCompression` — that is about CRIME/BREACH, where a secret shares a
compression stream with attacker-chosen data. `/ws` carries the same public telemetry to every
client and no per-client token, so it does not apply here; **don't copy it onto a socket that
echoes caller input back beside anything sensitive.**

**`history` was 39% of the payload and half of it was undrawable.** The server stored and shipped
`MaxPosHistory` = 20 points per flight, but the scope truncates to `MAX_HISTORY` the instant a
batch lands (slider max **10**, default 5) and its render cutoff is `MAX_HISTORY x 12 s` on top of
that — so points 11-20 could not be drawn at any setting. 36,816 of 74,229 points were parsed and
discarded. `ToSummary(historyMax:)` caps it at the WS call site only; `ToDetail` (one flight on
demand) and the flight-history archive keep the full trail.

Result: 17.6 MB -> 14.7 MB raw, **~2.1 MB on the wire**. If this needs more later, the next lever
is that the scope and the flight table share `/ws` and the scope needs far fewer fields — but they
share it deliberately, so that is a real design change, not a tweak.

## The SYSTEM group is operator-only (`LaddService.OperatorView`)

The home page's **SYSTEM** group — THROUGHPUT, STORAGE & RETENTION, SERVER STATUS — and the four
endpoints behind it (`/api/feed`, `/api/feed/stdds`, `/api/system`, `/api/storage`) describe the
**deployment**, not air traffic: who is connected, what the box is called, how much disk is left,
how far behind each Solace queue we are and how many flows we bind. A visitor has no use for it and
it is the material an operator would rather not publish, so it follows the same sign-in that
reveals un-masked LADD identities. There is deliberately **one** notion of "the operator" here, not
a second password.

`LaddService.OperatorView(http)` is that predicate, and it is true in three cases:

| case | why |
|---|---|
| the `/login` sign-in cookie (`laddKey`, also accepted as `X-LADD-Key` / `?laddKey=`) | the operator, wherever they are |
| **`LADD_BYPASS_KEY` unset** | with no key, `Reveal` can never return true, so gating on it alone would hide this from the owner of a local or LAN deployment *with no way back in*. Unset = no gate, the same convention `SWIM_FEED_HOST` and `SWIM_GATE_HOST` use. `Init` logs which of the two states is live. |
| **loopback, with no proxy header** | `curl http://127.0.0.1:5001/api/feed` on the box is the documented way to check feed health, and anyone who can run it can already read `.env`. |

**The second half of that last row is the whole trap.** cloudflared dials **127.0.0.1**, and there
is no `UseForwardedHeaders` in this pipeline, so `RemoteIpAddress` is loopback for *every* public
request. A gate written as "signed in OR loopback" would let the entire internet through while
reading as a careful local-access carve-out — and nothing would look wrong from either side.
Requiring the absence of `CF-Connecting-IP` / `CF-Ray` / `CF-Visitor` / `X-Forwarded-*` /
`X-Real-IP` / `Forwarded` is what makes "local" mean local. `OperatorViewTests` pins each header
individually, because that is the half a later refactor is most likely to drop.

Verified against a local instance with the key set, all four endpoints: loopback unproxied **200**,
loopback + `CF-Connecting-IP` **403**, tunneled + the cookie **200**, tunneled + a wrong key
**403**; `/api/stats`, `/api/asdex`, `/api/tdls`, `/api/tfms/stats`, `/api/history/dates` and `/`
all still 200 for a visitor.

**The page hides it in CSS, and that is presentation only.** `frame.js` already adds `.op-signed`
to `<html>` from the non-secret `sv` cookie (the same signal behind the green build footer and the
exit chip); `home.css` carries `html:not(.op-signed) #systemGroup, html:not(.op-signed) #serverStat
{ display: none }`. Written as `:not()` rather than hide-then-restore so neither rule has to know
what display value those elements would otherwise have, and so a visitor never sees the group for a
frame while the deferred `frame.js` runs. Forging `sv=1` shows three cards that 403 — the server is
the gate. `home.js` reads the same cookie into `OPERATOR` purely to skip four requests per poll
that would only 403.

**One visible regression, accepted.** The status bar's SFDPS chip preferred `/api/feed`'s live 10 s
sample and now falls back, for visitors, to `/api/stats`'s **lifetime average** — the exact number
["The home page rate was a lifetime average"](#the-home-page-rate-was-a-lifetime-average) explains
is not comparable with the SCDS portal. The existing fallback tooltip says "average since start (no
live sample)", so it is labeled rather than misleading. Fixing it properly means putting one
instantaneous SFDPS rate into `/api/stats`; the per-feed table is what must stay private, not that
single number. The `SRV:` chip is hidden with the group rather than left reading `--`.

**Adding a card to the SYSTEM group needs nothing.** Adding an endpoint that reports deployment
state *does*: gate it with `LaddService.OperatorView` and return `LaddService.OperatorOnly()`,
which carries a one-line body so a hand `curl` reads as a gate rather than as a bug.

## Live Client Count (`/api/system`)

`wsClients` is the **sum across every feed**, with a `wsByFeed: [{feed, count}]` breakdown of the ones
that currently have someone on them (idle feeds are omitted). The home page's SERVER STATUS card shows
the total in its collapsed line and `total (SFDPS 1 · STARS 1 · …)` in the Clients row.

The counts come from each feed's own registry — `ctx.Clients` (`/ws`: ERAM scope + flight table),
`AsdexBridge/TaisBridge/TdlsBridge/TfdmBridge/TfmsBridge/ItwsBridge.ClientCount`,
`ReplayServer.ClientCount` (all replay sockets funnel through one `RunReplaySession`), and
`DgScopeRoutes.ActiveClients`. **STARS is not a WebSocket** — the scope streams newline-delimited JSON
from `/dstars/{facility}/updates`, proxied to SwimReader.Server on :5000, so it is counted around the
proxy's body copy and nowhere else. Add a feed → add its count to the array in `EramRoutes`
(`/api/system`), or it silently reads as zero, which is exactly the bug this replaced: the number was
`ctx.Clients.Count` alone, so a room full of ASDE-X/STARS/TDLS/TAIS/TFDM/ITWS viewers reported **0**.

These are connections, not people — one person with the scope and the flight table open counts as 2.
`app.UseWebSockets()` runs with the default 2-minute keepalive and the receive loops have no
application-level idle timeout, so a silently dropped connection can linger in the count for a
couple of minutes before the ping fails.

## Important Conventions

- Altitudes in SFDPS/STDDS are in **feet**; displayed as flight levels (FL360 = 36,000 ft)
- Altitude filter uses FL notation: Low FL 180, High FL 360 = 18,000-36,000 ft
- ICAO airport codes converted to FAA LIDs (KDCA → DCA) in server adapter
- Track colors: `#cccc44` (ERAM yellow), `#ff4444` (emergency red), `#555555` (boundary gray)
- SFDPS data rate: ~240 msg/sec, updating ~4000-7000 active flights at any time
- Each flight updates roughly every 12 seconds
- CID (Computer ID) is per-facility — each ARTCC assigns its own; stored in `computerIds` map, keyed
  by the publishing center (the **`centre`** attribute on `<flight>` — see below). `getCid()` only
  returns the selected facility's CID; foreign facility CIDs are never shown (matches real ERAM behavior)

### FIXM spells it `centre`, and renaming it silently deletes every CID
The attribute on the wire is literally `centre="ZID"`. FIXM is an international standard; that is
**their** contract, not our prose, and it is the one place in this repo where the house
American-spelling rule must not be applied. `AsdexBridge.cs` has the same exception for an AIXM key.

An American-spelling sweep (`6fa43a6`) renamed `flight.Attribute("centre")` to `"center"` and
rewrote the comment that warned against it, so the warning erased itself. `XElement.Attribute`
returns null for a name that isn't there, the code coalesced to `""`, and `state.ComputerIds[center]`
was never written for any flight. Measured on the live feed: **6,882 of 6,882 flights had
`computerIds: null`, and 100% of in-facility flights at every ARTCC sampled had no CID.**

**Nothing threw, and the scalar `ComputerId` kept working** — so the "All" view looked perfectly
normal and only a selected facility (the normal way to use the scope) was broken. That asymmetry is
what made it read as a display bug rather than a parse failure, and it is why the collision logic
below was the first suspect and the wrong one. `FixmContractTests` now fails in CI if either the
attribute spelling or the `ComputerIds[center]` keying changes.

The diagnostic that settled it in one step: dump a live WS snapshot and count
`computerIds` keys. All-null across every flight means the map was never populated (parse side);
a populated map with blanks means arbitration (the section below).

### CIDs collide, and presence breaks the tie
`computerIds` is a permanent per-flight **history**: an entry is kept for the life of the record
(60 min), so a flight that crossed ZDC an hour ago still carries ZDC's number long after ERAM
recycled it to someone else. At ~6K flights × up to 7 ARTCC CIDs there are **50-77 colliding CIDs per
center** at any instant — not an anomaly, the steady state.

So when two records claim one CID, `_buildCidCache()` gives it to whoever **this ARTCC is working**
(`controllingFacility`) or **still publishing** (`reportingFacility`); a record that has moved on
can't take the number off one that is here. Ties (two at-facility records, i.e. a stale sibling) fall
back to freshest `posAge`, and `_cidEligible()` keeps ghost records — cancelled, position-less, long
stale — from claiming anything at all.

**Don't arbitrate this by freshness.** `posAge` was the original rule and it cannot work: both records
are getting position updates every few seconds from their *current* centers, so the winner is
arbitrary and the loser's CID is blanked — which is exactly how live, in-facility targets ended up
with no CID (4-31 per center, ~153 total across 8 centers; 0 after the change).

A leftover entry nobody at the facility holds is left on display — it is simply this ARTCC's last CID
for that aircraft, in use by no one. The per-callsign union fallback (which rescues a CID living on a
sibling GUFI after a handoff) spans the same history, so `_cidHeldByOther()` vets it: a sibling GUFI
of the same callsign is the same airplane and still a legitimate rescue, a different aircraft is not.
- All frontend rendering is single-file HTML (JS + CSS inlined), no build step or framework

## Building

```bash
dotnet build SwimReader.sln
dotnet test
```

Individual projects:
```bash
dotnet build src/SwimReader.Server
dotnet build tools/SwimServer
```

## Deployment (Raspberry Pi)

### Host
- **Pi**: `JY@JY5` (Debian 12 bookworm, ARM64, 4 cores, 8GB RAM)
- **Co-tenant services**: the Pi also runs unrelated user services that compete for the 4 cores — `vncrcc.service` (uvicorn web app), `larperdetectorv3.service` (bot), and `vatsim2m.service` (VATSIM→JSON; disabled 2026-06-21 as it burned ~⅔ of a core). RAM is ample (8GB); **CPU is the scarce resource** — when diagnosing "high load", check per-process CPU (`ps -eo pid,pcpu,comm --sort=-pcpu`), not memory.
- **SSH**: `ssh JY@JY5` (no password needed). If SSH hangs/`Permission denied`, it's almost always a **local Tailscale problem, not the Pi** — e.g. the PIA VPN kill-switch blocking tailscaled's control-plane traffic. Disable PIA + `tailscale up --reset`. The Pi stays reachable via Cloudflare (`https://swim.vncrcc.org`) regardless.
- **.NET 8**: installed at `/home/JY/.dotnet`
- **Repo**: `/home/JY/SwimReader`
- **Credentials**: `/home/JY/SwimReader/.env` (same format as local `.env`)

### Systemd Services
| Service | Unit | Port | Working Directory |
|---------|------|------|-------------------|
| SwimServer | `sfdps-eram.service` | 5001 | `tools/SwimServer` |
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

### Replay Storage (gzip → zstd)
Replay hours (`replay/{eram,asdex/<apt>,tais/<fac>}/yyyy-MM-ddTHH[-N].jsonl.*`) are written as `.jsonl.gz`
(gzip Fastest, flushed so the live hour is readable). `ReplayCompactor` (`ReplayFiles.cs`) re-encodes each
finished hour to `.jsonl.zst` in the background — ~10× smaller for STARS/ASDE-X, ~3× for ERAM — verifying the
line count before deleting the `.gz` and keeping its mtime (the budget trims oldest-by-mtime). **Always open /
list replay files through `ReplayFiles` (`OpenRead`, `List`, `Find`, `Stem`)**, never `*.jsonl.gz` + `GZipStream`
directly, or compacted hours silently disappear from replay. ERAM uses level 3 + long-distance matching (128 MB
window — its snapshots repeat far apart); STARS/ASDE-X use plain level 9. `REPLAY_COMPACT=0` disables; `REPLAY_ZSTD_LEVEL` overrides.

### Replay seek, and why "it's slow because it's compressed" is the wrong answer

Reported from outside (chris, via Hunter): STARS replay play/pause flaky, speed changes sluggish,
and **seeking to a time inside the recorded range answering "End of data"** — all attributed to the
recordings being compressed, with a request for an uncompressed build to test against.

**Compression was not the cause and removing it would be a bad trade.** Measured on the largest
TAIS hour on the Pi: **3.95 MB compressed vs 199 MB plain, 50.5x**, and decompressing the *entire
hour* takes **0.21 s**. Storing replay uncompressed costs ~200 MB per facility-hour to save a fifth
of a second — ruinous for anyone self-hosting, which was the actual plan behind the question.

**The real bug was a destructive read used as a boolean.** The pending seek lived in one captured
local; `consumeSeek()` both returned *and cleared* it. Four nested loops used it purely as a
predicate to unwind toward `PlaybackLoop`, the only place that can act on it (it owns
`currentTime`):

```csharp
if (consumeSeek() != null) break;   // target read, cleared, and thrown away
```

So the innermost check destroyed the answer, every outer check then saw null, the `continue` that
would have handled the seek never ran, and control fell through to "move to the next hour". Seeking
near the end of a recording therefore ran out of files and emitted `replay_end`. Seeking while
paused lost it the same way. It was intermittent-looking — a seek landing exactly while the outer
loop was at its top did work — which is what "finicky" meant.

Split into `peekSeek()` (non-destructive) and `clearSeek()`, called in **exactly one** place;
`ReplaySeekContractTests` pins that. Verified live: a forward seek across 237 h of archive, from
hour 1 to within 2 h of the end, is acked and streams data; pause gives 27 -> 0 -> 33 records.

Second, smaller cause of "sluggish": pacing slept in one `Task.Delay` of up to 5 s, so a seek sat
unserved and a speed change didn't bite until the old wait expired. It now sleeps in <=100 ms
slices and **rescales the remainder when speed changes** mid-wait. At 300x: 836 records/4 s.

**All sockets now negotiate permessage-deflate** (`SwimWs.AcceptAsync`), replay included — it was
`/ws` only at first, which missed the one that matters most to a self-hoster paying for bandwidth.
Client-negotiated, so a consumer that doesn't offer it (the DGScope WPF app) is unaffected.

A note on diagnosing these: the control channel is `{cmd: "..."}`, **not** `{type: "..."}`, and the
receive loop wraps parsing in `catch { }` — so a malformed command is silently ignored and looks
exactly like a server that isn't responding to the UI. That cost a debugging round here.

### "1x" was not 1x, and only the quiet facilities showed it

Reported from outside: **STARS replay stops and every target disappears after about 30 seconds.**
Three defects in a chain, and the 30 seconds is the last link, not the first.

**The pacer skipped any inter-record gap over 5 s.** `if (scaled > 5000) accWaitMs = 0;` was there
so a recording outage wouldn't sit idle, but it tested five seconds of *scaled wait* and served
anything above it with **zero** wait. A quiet TRACON's normal reporting cadence is above that, so
most of its hour was skipped for free. Measured over one recorded hour, simulating the real pacer
against the real timestamps:

| facility | hour recorded | gaps > 5 s | effective speed at "1x" |
|---|---|---|---|
| A80 | 34 MB | 24 (173 s of 3599) | 1.1x |
| PCT | 24 MB | few | 1.1x |
| GTF | 30 KB | 179 (2929 s of 3575) | **5.5x avg, 32x locally** |
| FAI | 2.9 KB | nearly all | **123x** |

**That is why it read as a STARS bug.** ERAM is one dense recording and ASDE-X is per big airport,
but TAIS is recorded **per facility** and 140 of the 143 recorded facilities are small TRACONs. The
scopes anyone checks against were the 1.1x ones.

**Racing is what killed the session.** `PlaybackLoop` treats the end of the newest hour file as
end-of-archive, so a replay that overtakes the recorder sends `replay_end` and closes. Verified
live: GTF started 70 s behind real time ran at 4.8x, crossed the live edge at 37 s wall, and the
socket closed. **Then the client's `LOST_TARGET_MS = 30000` (scope.js) stopped rendering every
track 30 s later** — which is the reported symptom, and the bar's "End of data" is the only clue
on screen.

Fixes: the threshold is `GapSkipMs` (60 s) measured against **real recorded time**, so it means the
same at every speed and separates a restart's minutes of nothing from genuine quiet; a skip emits
`replay_gap`, which the bar already renders; the skip never advances past the live edge
(`RecorderFlushLagMs`), so a caught-up replay waits for the recorder; the per-record 5000 ms wait
cap is gone, since with real quiet time now paced it would let the accumulator grow without bound
(the <=100 ms slicing is what keeps a long wait responsive); and `GetTimeRange` no longer advertises
the **future** — the last file is the hour in progress, so `end.AddHours(1)` let the scrubber drag
into unwritten time, which also ends the session. GTF 5.5x -> 1.6x, A80/PCT -> 1.00x.

**`ReplayPacingTests` is the only thing that can see this class of bug** — same lesson as the
cache-busting no-op and the ADS-B callsign fields. Nothing threw, no counter moved, and a check on
a busy facility passes at 1.1x no matter how broken the rule is. The test paces a synthetic
sequence at several cadences and asserts wall time equals recorded span; every case above 5 s
fails against the old rule and passes against the new one.

**Still open:** a replay that legitimately reaches the end of the newest hour file ends rather than
tailing it. The clamp above stops it *racing* there, but following a live recording means resuming
reads on a gzip stream that is still being appended, which is a real change, not a threshold.

### Pausing a STARS replay blanked the scope, because ageing ran on the wrong clock

Reported as "the 30 second replay still appears and the time on top left doesn't reflect replay
time", with a screenshot of N90: bar saying **Playing**, clock frozen, **not one target on the
scope**. Two independent bugs, and the screenshot was showing both at once.

**Track ageing measured wall-clock time.** `LOST_TARGET_MS` (30 s), the 24 s coast test, the
history ticker, dead reckoning and the 120 s purge all ask "how long since this track reported",
and all asked `Date.now()`. Live that is right. **In replay it is not**: the replay clock runs at
the chosen speed and stops dead on a pause. Measured with an in-page sampler at N90, 1x, pause at
t=55 s:

| t | tracks held | drawn |
|---|---|---|
| 55 s (pause) | 141 | 141 |
| 76 s | 141 | 141 |
| **77 s** | **141** | **0** |

Exactly 30 s after the last record, with every track still in memory. That is the whole "30
second replay": pause it — or hit a quiet stretch, which the pacing fix above deliberately now
*honours* in real time instead of skipping — and the scope blanks half a minute later. At 10x it
failed the other way, holding dead targets ten times too long.

`scopeNow()` is the radar clock: **exactly `Date.now()` when live**, so live behavior is
unchanged, and `ReplayBar.clockMs()` during a replay — interpolated between server messages,
frozen while paused, scaled by speed. It is anchored near `Date.now()` rather than at the archived
timestamp, so a site that still reads `Date.now()` is wrong by the length of a pause rather than
by a week. `clockMs()` must be **re-anchored on resume** (`_timeWall`), or the first frame after a
pause jumps by the pause's whole length and flashes the scope blank — the same symptom, one step
later.

Verified after the fix on the same run — pause at t=21 s, resume at t=66 s, sampling both rules
side by side: **the page's own count never left 140-146**, through the pause and across the
resume, while the **old wall-clock rule hit 0 at t=52 s and stayed there**. The SSA clock froze at
`1200/26` and resumed at `1200/27` with no jump, which is what the `_timeWall` re-anchor buys.
That permanent wall-clock 0 is also the measurement behind the anchoring claim: after a 45 s pause
the radar clock trails `Date.now()` by 45 s **for the rest of the session**, so any site still
reading `Date.now()` is quietly wrong from then on. The test is the real guard; the anchor only
bounds the damage.

**The server was never involved**, and checking that first is what kept this from becoming another
pacing investigation: reading `/replay/tais/ws/N90` directly from Python gave **0.98x over two
minutes, 145 messages, largest inter-message gap 4.1 s**. A browser-side stall and a server-side
one look identical from the page.

**`history.replaceState` under `<base href="/stars/">` throws the path away.** replaceState
resolves a **relative** URL against the *base*, not the document — and a bare `"#…"` is relative.
So the bar parking its position rewrote `/stars/ZNY/N90?r=20&tcp=2A` to `/stars/#replay=…`:
facility and every display param gone, within one save interval. The running page carries on (it
had already read them), so nothing looks wrong until a reload lands on the picker. **That URL is
the tell** — a screenshot whose address bar reads `/stars/?r=20&b=…` is this bug, not a typo.
Fixed in both writers: the bar builds from `location.pathname`, and the scope's own
`_internalPushUrlState` keeps `location.hash` instead of dropping the replay position on the next
DCB press.

Two smaller ones from the same trace: the bar still read **"Playing" while paused**, which is what
made a blank scope look like a broken replay rather than a pause; and the SSA clock showed **live**
time on a replay page until the first record arrived (now seeded from the start time in `onStart`).

`ReplayClockContractTests` pins all of it, and all three cases fail against the previous commit.
A browser cannot see either bug — the page loads, nothing throws, and you only meet the first if
you happen to pause and then wait thirty seconds.

**ERAM already had half of this** (`histClock()` in `eram.js` is replay-aware for history), which
is why only STARS was reported. Its remaining `Date.now()` uses are legitimate: TBFM is live-only
in replay, and the point-out 3-minute client timeout is a UI timer.

### Logging volume (don't let it eat the journal)

The Pi's journal is capped at 500 MB. Left unchecked the two services were writing **~340 lines/s**
between them (`swimreader-stdds` ~400/s on its own), which rotated the journal away every **~33
minutes** — so after any incident, reboot or feed anomaly there was no history left to diagnose it,
and the SD card was taking constant writes.

Two causes, both fixed:
- `src/SwimReader.Server/appsettings.json` had `"SwimReader": "Debug"`, so production ran at debug
  level (TrackStateManager / ParserPipeline / CallsignEnrichmentService per-message lines). It is now
  `Information`, with `Debug` moved to `appsettings.Development.json` where it belongs.
- SwimServer's `[CLR]`, `[INTERIM]` and `[HOLDBAR]` per-message traces — investigation output from
  working out how SFDPS signals clearance/interim changes — now go through `Trace.Write` and are
  **opt-in**: `SWIM_TRACE=CLR,INTERIM,HOLDBAR` (or `all`).

If you need that detail back on the Pi, set `SWIM_TRACE` in the unit file briefly rather than
re-enabling it permanently.

### Flight State Cache
On shutdown (SIGTERM) and every 5 minutes, all flight data is serialized to `flight-cache/flights.json`. On startup, the cache is loaded before Solace connects, so flights survive restarts with no data loss. Cache older than 60 minutes is discarded (matches purge timer).

### Cloudflare Tunnel
- **Tunnel ID**: `07b88be3-c0eb-423b-97d4-57bde0bb21da`
- **Config**: `~/.cloudflared/config.yml`
- **Service**: `cloudflared.service`
- **Route**: `swim.vncrcc.org` → `http://127.0.0.1:5001` (SwimServer)

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
