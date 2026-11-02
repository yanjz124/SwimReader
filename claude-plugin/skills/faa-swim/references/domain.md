# Reading the data: terms and conventions

Enough air-traffic vocabulary to interpret a SwimReader response without misreading it.

## Identifiers

| Term | Meaning |
|---|---|
| **GUFI** | Globally unique flight identifier. One physical aircraft gets **one GUFI per ARTCC tracking it**, so a cross-country flight has several — they are not duplicates. |
| **CID** | Computer ID, 3 digits. Assigned **per facility**, and recycled. Meaningless without knowing which ARTCC issued it. |
| **Callsign** | What the pilot says. For a GA flight this *is* the tail number. |
| **Squawk / beacon code** | 4-digit octal transponder code. `assignedSquawk` is what the controller gave; `squawk` is what the aircraft is actually transmitting — a mismatch is meaningful. |
| **Mode S / registration** | Airframe identity, stable across flights. |

## Facilities

- **ARTCC** (ZDC, ZNY, ZLA…) — en-route centre, 20 of them covering US airspace. Source of SFDPS.
- **TRACON** (PCT, A80, N90…) — terminal radar approach control. Source of STARS/TAIS.
- **Sector** — a controller position within a facility, written `ZDC/16`. Frequencies in
  `/api/track` are keyed this way.
- **ERAM** is the en-route automation system; **STARS** the terminal one; **ASDE-X** the surface
  radar; **TFDM** the surface/departure manager.

## Altitude

Everything is in **feet**. Flight level = feet / 100 (FL360 = 36,000 ft).

| Field (`/api/track`) | Meaning |
|---|---|
| `assignedAlt` | what the controller cleared |
| `reportedAlt` | Mode C — what the aircraft reports |
| `interimAlt` | a temporary step, set and cleared by the controlling sector |
| `blockFloor`/`blockCeil` | cleared to operate in a band |
| `assignedVfr` | VFR, possibly VFR-on-top with an altitude |
| `reqAlt` | the pilot's filed request, which may differ from what was assigned |

A difference between assigned and reported means climbing or descending, not an error.

## Ownership and handoffs

- `controllingFacility` / `controllingSector` — who is working the aircraft **now**.
- `reportingFacility` — who is publishing the track.
- A **handoff** transfers control: proposed by one sector, accepted by the next. Fields
  `handoffEvent`, `handoffReceiving`, `handoffTransferring`.
- A **point-out** tells an adjacent sector about an aircraft without transferring control.
- `controlAgeSec` — how long the current sector has had it.

## Position and freshness

| Field | Where | Meaning |
|---|---|---|
| `posAgeSec` | `/api/track` | seconds since **we received** the position |
| `posAge` / `fixAge` | `/api/flights/{gufi}`, WebSocket | receipt age and **radar fix** age |
| `coast` | `/api/track` | the automation has lost radar return and is extrapolating |

`posAge − fixAge` is pipeline lag. A radar update arrives roughly every 12 s en route; no update
for ~26 s is a coast track. **`posAge` alone cannot prove the data is current** — a consumer
draining a backlog stamps stale data as freshly received.

## Special squawk codes

| Code | Meaning |
|---|---|
| 7500 | hijack |
| 7600 | radio failure |
| 7700 | emergency |
| 7777 | military interceptor |
| 7400 | lost link (UAS) |
| 1200 | VFR, no discrete code assigned |

Treat an emergency code as significant but **not** as confirmation of an emergency — codes are
mis-set, and a brief 7700 is often a finger error. Don't announce an emergency from a squawk alone.

## Flight plan fields

- `route` — the filed NAS route string: fixes, airways (J/V/Q/T + digits), `DCT` for direct,
  procedure names for SID/STAR.
- `star` / SID — arrival and departure procedures.
- `flightRules` — IFR/VFR.
- `equipmentQualifier`, `nav`, `surv`, `pbn`, `datalink` — ICAO equipment capability codes.
- `wakeCategory` — L/M/H/J (light through super), drives separation.

## Status

`ACTIVE` (airborne and tracked), `PROPOSED` (filed, not departed), `DROPPED` (track lost or
handed off out of coverage), `CANCELLED`, `COMPLETED`.

A DROPPED flight is often just transitioning between centres — it is not necessarily an incident.

## Sources and what each is good for

| Source | Carries | Note |
|---|---|---|
| **SFDPS** | en-route flight data, position, altitude, ownership, handoffs | ~240 msg/s, each flight updating ~every 12 s |
| **STDDS** | terminal: STARS tracks, CPDLC clearances, surface movement | per-TRACON / per-airport |
| **TFMS** | traffic flow: filed route, predicted crossings, delay programs | often has a flight **hours before** SFDPS |
| **ITWS** | terminal weather | alerting products subscribed at very few sites |
| **TFDM** | surface and departure management | surface only — no route or type |

## LADD

Aircraft on the FAA's Limiting Aircraft Data Displayed list are **masked by the server**, by
design. Report a masked record as masked. Do not attempt to identify or track a blocked aircraft
by combining endpoints, mining history, or going around the API.
