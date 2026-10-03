# SwimReader

Real-time FAA **SWIM** (System Wide Information Management) data platform. It ingests live national
airspace data over Solace messaging, normalizes it, and serves it through a set of ATC-style
displays, data explorers and APIs.

> **Not for operational use.** This is a situational-awareness and reference project built from
> publicly subscribed FAA SCDS feeds. It is not certified, not authoritative, and must not be used
> for the conduct of flight or air traffic control.

## Feeds

Five FAA SCDS feeds, each on its own Solace session:

| Feed | What it carries |
|---|---|
| **SFDPS** | En-route flight data (FIXM) — flight plans, tracks, handoffs, point-outs, clearances |
| **STDDS** | Terminal automation — TAIS (STARS tracks), TDES (CPDLC/TDLS), SMES (ASDE-X surface) |
| **TFMS** | Traffic flow — flights, routes, TMIs, FCAs, airport configurations |
| **TFDM** | Terminal surface/departure management — TOBT/TSAT, runway, spot, taxi, sequence |
| **ITWS** | Terminal weather — winds, microbursts, storm cells, lightning |

## What it serves

- **ERAM scope** — en-route radar display with ERAM-style data blocks, leader lines, history
  trails, velocity vectors, NEXRAD, sector boundaries and an MCA command line
- **STARS scope** — terminal radar display (DGScope-compatible), with video maps and a DCB
- **ASDE-X** — airport surface movement, per-airport, with data blocks and safety-logic hold bars
- **TDLS** — CPDLC clearances and tower departure events, live and searchable across history
- **TAIS / FDIO / flight table** — terminal track tables and flight-plan explorers
- **TFDM boards** — per-airport surface and departure boards
- **Track a Flight** — one callsign aggregated across every source at once
- **Aircraft & airline databases** — per-tail flight logs, fleet and route analysis
- **Dispatch / route finder** — search real filed routes, deep-link into SimBrief
- **Replay** — scrub back through recorded ERAM, ASDE-X and STARS data
- **Telegram bot** — follow a flight from a chat window

## Architecture

```
          FAA SWIM / SCDS  (Solace brokers)
   SFDPS · STDDS · TFMS · TFDM · ITWS
                    │
        ┌───────────┴────────────┐
        │                        │
  SwimReader.Server        SwimServer                 (.NET 8)
  (STDDS → DGScope)        (all feeds → web + APIs)
        │                        │
   DGScope clients        Browser scopes, REST, WebSocket
```

- `tools/SwimServer` — the main server: Solace ingest, parsing, state, REST + WebSocket, and every
  browser frontend. Deliberately self-contained, no project references.
- `src/SwimReader.*` — the STDDS pipeline that feeds DGScope clients over the Dstars protocol
  (`Core` domain/event bus, `Parsers`, `Scds` connection manager, `Server` host).

Frontends are plain HTML/CSS/JS — no build step, no framework.

## Running it

You need your own FAA SCDS subscription credentials; none are included.

```bash
cp .env.example .env     # fill in SFDPS / STDDS / TFMS / TFDM / ITWS credentials
cd tools/SwimServer
dotnet run               # http://localhost:5001
```

```bash
dotnet build SwimReader.sln
dotnet test
```

### Configuration worth knowing

| Variable | Why it matters |
|---|---|
| `SWIM_FEED_HOST` | **Set this.** A Solace queue delivers each message to exactly one consumer, so two instances on the same queue *split* the feed instead of duplicating it — silently. Name the host that owns the feed; everywhere else the consumers stay off while pages, APIs and replay keep working. |
| `SWIM_ALLOW_SHARED_QUEUE` | Overrides the above for a deliberate local session against live data. |
| `SWIM_GATE_HOST` / `_USER` / `_PASS` | Host-scoped HTTP basic auth for a public hostname. Unset = open (local use). |
| `SWIM_TRACE` | Opt-in per-message tracing (`CLR`, `INTERIM`, `HOLDBAR`, or `all`). Off by default — it is loud. |
| `TELEGRAM_BOT_TOKEN` | Enables the Telegram bot. |

`GET /api/feed` reports per-feed throughput, parse-thread load and broker discard counts, so "are we
receiving everything?" is answerable rather than assumed.

## Data handling

FAA SWIM data carries redistribution and privacy obligations. This project:

- honors **LADD** (Limiting Aircraft Data Displayed) — blocked aircraft are masked on output, and
  masking is applied *before* filtering so a search cannot surface a hidden flight by its real ID;
- is intended for personal/reference use, with the public deployment login-gated rather than open.

If you run it, those obligations are yours to meet.

## Documentation

[`CLAUDE.md`](CLAUDE.md) is the detailed engineering reference: message formats and field semantics
for each feed, display behavior and command sets, data pipelines, persistence and budgets, the
deployment setup, and the reasoning behind the non-obvious decisions. `docs/` holds the CRC/vNAS
ERAM, STARS and ASDE-X specifications the displays are built against.
