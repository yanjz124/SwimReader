---
name: faa-swim
description: Query live FAA SWIM air-traffic data through a SwimReader server — where a flight is right now across every data source, airport weather and runway winds, airport surface and departure boards, terminal CPDLC clearances, feed health, historical flight records, real filed routes for a city pair, and airline fleet/utilization research. Use whenever someone asks where a flight is, what conditions or the departure situation are at an airport, what route aircraft actually file somewhere, or to check whether the SWIM feed itself is healthy.
---

# FAA SWIM data via SwimReader

SwimReader ingests five live FAA SCDS feeds (SFDPS en-route flight data, STDDS terminal, TFMS
traffic flow, ITWS terminal weather, TFDM surface/departure) and serves them over a JSON API.
This skill is how to ask it questions and read the answers correctly.

## Configuration

```bash
SWIM_API_URL      # e.g. https://swim.vncrcc.org  — required
SWIM_API_USER     # optional: only if that host has HTTP Basic enabled
SWIM_API_PASS
```

Call it with curl. Add `-u "$SWIM_API_USER:$SWIM_API_PASS"` **only when those are set** — the
deployment may or may not be gated, and sending empty credentials is worse than sending none:

```bash
swim() {                      # swim /api/track/UAL123
  if [ -n "$SWIM_API_USER" ]; then
    curl -sS -u "$SWIM_API_USER:$SWIM_API_PASS" --max-time 90 "$SWIM_API_URL$1"
  else
    curl -sS --max-time 90 "$SWIM_API_URL$1"
  fi
}
```

If `SWIM_API_URL` is unset, say so and stop — do not guess a hostname.

## Responses are big. Filter before reading.

`/api/tfdm/{airport}` is ~600 KB and `/api/airlines/{icao}` ~450 KB. Never dump one into context.
Pipe through `jq` (or `python3 -c`) and extract only what the question needs:

```bash
swim /api/track/UAL123 | jq '{found,
  sfdps: [.sfdps[] | {callsign, origin, dest, acType,
                      controllingFacility, controllingSector, sectorFreq,
                      assignedAlt, reportedAlt, gs, squawk, coast, posAgeSec}]}'
```

Field names in the `/api/track` projection are abbreviated — `assignedAlt` not
`assignedAltitude`, `posAgeSec` not `posAge`, `gs` for ground speed, `dest` not `destination`.
Dump one object's keys before writing a filter against a section you haven't used.

## Which endpoint answers which question

| The question | Endpoint |
|---|---|
| **Where is flight X?** (the flagship — aggregates every source) | `/api/track/{callsign}` |
| Conditions, runway winds, density altitude at an airport | `/api/airport/{id}` (FAA LID or ICAO) |
| Who's on the surface at an airport | `/api/asdex/{airport}`, directory `/api/asdex` |
| Departure/surface management: TSAT, runway, spot, sequence | `/api/tfdm/{airport}`, directory `/api/tfdm` |
| CPDLC/PDC clearances issued | `/api/tdls/{airport}`, directory `/api/tdls` |
| Terminal radar tracks at a TRACON | `/api/tais/{facility}`, directory `/api/tais` |
| **Is the feed healthy?** | `/api/feed` — see the warning below |
| Server load, clients, memory | `/api/system` |
| Past flights (callsign, route, type, registration…) | `/api/history?q=&date=`, dates via `/api/history/dates` |
| What do aircraft actually file between two airports? | `/api/dispatch/search?origin=&dest=` |
| Airline fleets, utilization, destinations, routes | `/api/airlines`, `/api/airlines/{icao}` |
| Resolve an airport code to name/coords | `/api/airports/find?codes=KJFK,KLAX` |
| NASR load status and cycle date | `/api/nasr/status` |

Full parameter detail: `references/endpoints.md`. Domain vocabulary (GUFI, CID, FDB, coast,
handoff, squawk codes): `references/domain.md`.

## Reading it correctly

These are the things that produce confidently wrong answers if you don't know them.

**`/api/stats.rate` is a lifetime average, not the current rate.** It is
`total / elapsed-since-process-start`. SFDPS volume roughly halves overnight, so on a long-running
server it reads far below the live rate and looks like half the feed is missing. **For "how fast is
the feed right now", use `/api/feed` → `msgsPerSec`** (last 10 s sample).

**Feed health is `lagSec` and `discardEvents`, not throughput.** `discardEvents > 0` is confirmed
data loss — the broker flags it when it has actually thrown messages away. `lagSec` is the
publisher's own timestamp versus our receipt. A low message rate with low lag and zero discards is
a quiet feed, not a broken one.

**Position age counts from receipt, not from the radar fix.** On `/api/track` the field is
`posAgeSec` — seconds since *we received* the position. The radar-fix age (`fixAge`, alongside
`posAge`) is on `/api/flights/{gufi}` and the WebSocket feed, and `posAge − fixAge` is the
pipeline lag. A consumer draining a backlog stamps everything "freshly received", so an age
measured from receipt cannot on its own prove the data is current.

**One callsign is often several records.** Each ARTCC tracking a flight publishes its own GUFI, so
`/api/track` returns an `sfdps` array — not a single object. They are the same airplane.

**CID is per-facility.** Each ARTCC assigns its own computer ID; a CID means nothing without
knowing which facility issued it, and CIDs are recycled.

**TFMS often knows a flight before SFDPS does.** For an inbound international leg, the `tfms`
section may carry the filed route and estimates hours before the flight appears in `sfdps` at all.
If `sfdps` is empty, check `tfms` before saying the flight is unknown.

**Altitudes are in feet.** Flight level is feet/100 (FL360 = 36,000 ft).

**`found: false` means not found; an empty array means that source has nothing.** They are
different answers — one flight can be live in ASDE-X and absent from SFDPS.

## What this data is, and isn't

It is live operational data from public FAA SCDS feeds, useful for following flights, understanding
airport operations, and research. It is **not** a navigation, separation or dispatch source, and
nothing here should be presented as authoritative for operational use.

**LADD-blocked aircraft are masked by the server.** That masking is deliberate and happens
server-side. Go through the API — never try to reconstruct a blocked aircraft's identity or
movements by combining endpoints, inferring from history, or reaching around it to another source.
If a record is masked, report it as masked.

Respect the deployment's access rules: it is a personal server, and the data is not for
redistribution. Don't scrape it wholesale, and don't publish bulk extracts.
