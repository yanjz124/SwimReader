# CRC STARS Reference

**Authoritative source:** https://docs.virtualnas.net/crc/stars/ — the official CRC/vNAS STARS
documentation. This file is a curated local capture of the rules the web STARS port (`/stars`,
`tools/SwimServer/wwwroot/stars/`) must match. **When porting any STARS feature, command, color,
or behavior, consult this file and the live docs first — match exactly, invent nothing.** If a
detail isn't captured here, fetch the live page and add it.

The live docs cover these sections: Display Control Bar (DCB), System Status Area (SSA), Preview
Area, System Lists, Video Maps, Compass Rose, Tracking Aircraft, Handoffs, Point Outs,
Consolidation, Coordination, Data Blocks, Quick Look, Flight Plans, Track Association, Short Term
Conflict Alerts (STCA), Special Purpose Codes, Predicted Track Lines (PTLs), TPA J-Rings and
Cones, ATPA, ATIS/GI Text, CRDA, Secondary STARS Displays, NEXRAD, VATSIMisms, Display Settings,
Differences From vSTARS, Command Reference.

---

## Colors & Ownership

| Element | Color |
|---|---|
| Owned track (you have / had control) | **white** |
| Track owned by another controller | **green** |
| Point out (to/from you) | **yellow** (blinking yellow when incoming, pending) |
| Pending handoff (accepted) | **blinking white** for 5 s, then green |
| Conflict Alert (CA) annotation | **blinking red** (unacknowledged) → **solid red** (acknowledged) |

- Taking control: "the data block will turn white and the position symbol will change to yours."
- Dropping: position symbol returns to an asterisk (or other symbol per factors).

## Position / Target Symbols (Tracking Aircraft)

| Symbol | Meaning |
|---|---|
| `*` (asterisk) | Unassociated track receiving a beacon code |
| `V` | Unassociated track squawking 1200 |
| square | Track squawking a selected beacon code group |
| `◇` (diamond) | Primary-only track (no transponder) |
| (your sector char) | A track you own — position symbol becomes yours |

STARS has **no** ERAM-style coast `#` / `\` / `+` glyphs.

## Data Blocks

- **LDB (Limited):** unassociated tracks. Beacon code + altitude by default; clicking reveals
  ground speed temporarily.
- **PDB (Partial):** associated tracks owned by **other** controllers. Line-2 content only
  (altitude / ground speed time-sharing with scratchpad and aircraft type). Shown in **green**.
- **FDB (Full):** tracks you own, being handed off to you, or pointed out to you. Shown in
  **white** (own) / **blinking yellow** (incoming point out) / **blinking white** (accepted handoff).
  - **Line 1:** aircraft callsign
  - **Line 2:** Mode C altitude (time-shares with scratchpad 1/2) · handoff-recipient indicator
    (single char, center) · ground speed (time-shares with aircraft type / requested altitude)
  - **Line 3:** reported and assigned beacon codes if not squawking the assigned code

## Special Purpose Codes (SPC)

Displayed as a **two-character** identifier in data-block **line 1**, plus an SSA indication and
an audible alert. **Acknowledge by clicking the track.**

| Squawk | Code | Meaning |
|---|---|---|
| 7700 | `EM` | Emergency |
| 7600 | `RF` | Radio failure |
| 7500 | `HJ` | Hijack |
| 7777 | `MI` | Military intercept |
| 7400 | `LL` | Lost link |

## Short Term Conflict Alert (STCA / CA)

**Trigger logic:** two tracks within **3 NM horizontally AND 1,000 ft vertically** **with
non-increasing separation** (closing or constant — a passing/diverging pair does NOT alert).
Detection runs continuously.

**Display:** the conflicting track shows **`CA` in blinking red in the top line of the data
block**, and an **alert tone sounds continuously** until acknowledged. (It is an annotation — the
rest of the block keeps its normal color; it is NOT a whole-block multi-color flash.)

**Acknowledge:** **click on either of the two tracks** → tone silenced, the `CA` text becomes
**solid red**.

**LA/CA/MCI list:** lists tracks in MSAW/Low-Altitude alert (not yet in CRC STARS), Conflict
Alert, or **Mode C Intruder (MCI)** status. MCI = an unassociated track in conflict-alert status;
it shows its **beacon code** instead of a callsign.

## Handoffs

- **Outgoing:** data block changes to indicate pending handoff. When accepted, the receiving
  controller's position symbol shows for **5 s in blinking white**, then converts to green.
- **Incoming:** data-block format changes to the incoming-handoff state. **Accept by clicking the
  target**; position symbol converts to yours.

## Point Outs

- **Incoming:** FDB appears in **blinking yellow** with a `PO` indicator **after the callsign**.
- **Outgoing:** `PO` indicator after the callsign with the receiving TCP shown.
- **Accept** by clicking (blinking stops, returns to solid yellow). **Reject** with the `UN`
  command. **Convert to handoff** with the `**` command.

## Track control commands (Tracking Aircraft)

- **Start track:** `F3` (INIT CNTL) → aircraft ID → click target. Track must be associated with a
  flight plan and assigned squawk.
- **Drop track:** `F4` (TERM CNTL) + click target, or `F4` + callsign/beacon + Enter.
