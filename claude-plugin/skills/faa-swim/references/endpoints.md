# SwimReader API reference

Every endpoint below was verified returning 200 against a live server. Sizes are typical, to show
which responses must be filtered before reading.

All are `GET`. Prefix with `$SWIM_API_URL`.

## Tracking one flight

### `/api/track/{callsign}` — ~5 KB
The flagship. Aggregates a single callsign across every source in one response.

```
{callsign, resolvedFrom, found, ts,
 sfdps: [...],        one entry per ARTCC tracking it (same airplane, several GUFIs)
 freqs: {},           FACILITY/SECTOR -> controller frequency, for every sector mentioned anywhere
 tfms: {},            filed route, procedures, predicted fix/center/sector crossings, CDM times
 edct: {},            ground-stop / ground-delay slot time
 handoffHistory: [],  handoff and point-out events
 tdls: [],            CPDLC clearances and departure events
 tais: [],            terminal radar (STARS) view
 asdex: [],           surface position
 tfdm: {}}            off-block/TSAT/runway/spot/taxi/sequence
```

`found: false` means no source has it. An empty sub-array means *that* source has nothing — check
`tfms` before concluding a flight doesn't exist, since TFMS leads SFDPS for inbound international.

Each `sfdps` entry is a lean projection with **abbreviated** names — don't assume the long forms:

```
gufi callsign cid cids status origin dest alternate acType wake equip registration
rules flightType route originalRoute star remarks oper originator
pbn nav comm surv otherNav otherComm otherSurv otherDataLink dataLink selcal perf eet
assignedAlt assignedVfr blockFloor blockCeil interimAlt reportedAlt reqAlt reqSpeed
lat lon gs squawk assignedSquawk coast
reportingFacility controllingFacility controllingSector controllingTracon
sectorFreq handoffFreq handoffEvent handoffReceiving handoffReceivingMapped
handoffTransferring pointoutOrig pointoutRecv
clrHeading clrSpeed clrText depTime eta edct coordTime coordFix lastMsg posAgeSec lastSeen
```

`cids` is the per-ARTCC computer-ID map (`{"ZLA":"346","ZAU":"173",…}`); `cid` is the one for the
facility currently working the flight. Null fields are omitted from the JSON entirely.

### `/api/flights/{gufi}` — full per-GUFI detail plus the whole event log.
This is where `posAge` **and** `fixAge` both appear (the track projection has only `posAgeSec`),
so use it when you need to judge pipeline lag for a specific flight rather than overall feed lag.

## Airports

### `/api/airport/{id}` — ~4.5 KB
FAA LID or ICAO (`LAX` or `KLAX`). Tower-style field state:
`{id, found, airport, stationName, nasrCycle, metar, derived, runways, history}`

- `runways` — each end with TRUE alignment, threshold position, and **head/crosswind components**
- `derived` — RH, pressure altitude, density altitude, heat index or wind chill
- `history` — 6 hours of observations

METAR wind and NASR `TRUE_ALIGNMENT` are both **true**, so crosswind needs no variation applied.
A runway *number* is magnetic — don't compare the two directly.

### `/api/asdex` — ~3 KB · `/api/asdex/{airport}` — ~50 KB
Surface movement. Directory gives `[{airport, count, lat, lon}]`; per-airport gives live tracks
with position, callsign, type, speed, heading.

### `/api/tfdm` — ~1 KB · `/api/tfdm/{airport}` — **~600 KB, always filter**
Surface/departure management: off-block and TSAT times, runway, ramp spot, taxi estimates,
departure sequence, APREQ, reportable delay, plus airport config, AAR/ADR rates and closures.

### `/api/tdls` — ~4 KB · `/api/tdls/{airport}` — ~160 KB
CPDLC/PDC clearances and tower departure events per aircraft.
`/api/tdls/history/callsign?q={callsign}` answers from an index without reading history files —
returns day + airport + count. Prefer it for "has this callsign been seen?".

### `/api/tais` — ~5 KB · `/api/tais/{facility}`
Terminal radar tracks from TRACONs.

### `/api/itws/airports` — ~19 KB
ITWS sites. Note most sites carry only a few products; the alerting products (surface wind, runway
winds, runway alerts) are subscribed for very few airports, so empty cards are usually correct
rather than broken.

## Health

### `/api/feed` — ~900 B
```
{liveFeed, feedBlocked, feedHost, host,
 feeds: [{feed, msgs, msgsPerSec, busyPct, kbPerSec, avgMsgBytes,
          lagSec, lagPeakSec, discardEvents, lastDiscard}]}
```
Per feed (SFDPS/STDDS/TFMS/ITWS/TFDM). **`msgsPerSec` is the real current rate.**
`discardEvents > 0` is confirmed loss. `busyPct` is the parse thread's load — sustained high means
only broker spooling is preventing loss.

### `/api/stats` — ~120 B
`{connected, total, rate, elapsed, flights, liveFeed, feedBlocked}`.
**`rate` is a lifetime average** — see the warning in SKILL.md. `flights` is the live count.

### `/api/system` — ~350 B
CPU, memory, GC, threads, uptime, disk, `wsClients` and `wsByFeed`.

## History and research

### `/api/history/dates` · `/api/history?q=&date=`
Searches persisted flight records. Indexed fields (fast): callsign, computerId, origin,
destination, registration, aircraftType. Anything else triggers a full-day scan with a time budget,
and the response carries `truncated`. A bare token also matches aircraft type.

### `/api/dispatch/search?origin=&dest=` — ~38 KB
Real filed flights for a city pair: callsign, filed route, cruise, airframe, gate, times. This is
what to use for "what route would I file from A to B" — these are routes that were actually filed
and flown, not generated.

### `/api/airlines` — ~59 KB · `/api/airlines/{icao}` — **~460 KB, always filter**
Carrier directory and per-carrier network, fleet and utilization. Per-fleet rows carry
`activeTails` vs `parkedTails`, hours/tail/day, legs/tail/day, average leg time and distance,
destinations and top routes.

**Caveat the server already flags:** air time is only observed inside US airspace, while leg
distance is the full great-circle. For a long-haul fleet the two don't describe the same flight —
check the implied ground speed before quoting hours or utilization for widebodies.

## Supporting

| Endpoint | Purpose |
|---|---|
| `/api/airports/find?codes=A,B` | name, city, country, lat/lon for codes (ICAO, FAA, IATA) |
| `/api/airports/audit` | config identifiers that no longer resolve, with replacements |
| `/api/nasr/status` | NASR cycle date and record counts |
| `/api/replay/range` | what historical replay data exists, per feed and facility |
| `/api/stars/artccs` | ARTCCs with STARS adaptation |
| `/api/simbrief/types` | aircraft types SimBrief has an airframe for |
