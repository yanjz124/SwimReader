# LADD block list (FAA compliance)

Drop the FAA **IndustryLADD** file here (`.txt` or `.csv`). `LaddService` loads every
identifier it finds (registration / call sign / flight number). Matching aircraft are
kept in the data but their **identity is masked to "LADD"** on every public output —
scopes (ERAM / ASDE-X / TAIS / TDLS / TFMS), the flight table, EDCT, the route finder,
history search, and (for direct call-sign lookups) the Track page and Telegram bot.

## Backdoor (owner reveal)
Set env `LADD_BYPASS_KEY=<secret>`. A request carrying it — query `?laddKey=<secret>`,
header `X-LADD-Key`, or cookie `laddKey` — sees the real, un-masked identities. For the
ERAM WebSocket the key is read at connect (`/ws?laddKey=…`). Leave `LADD_BYPASS_KEY`
unset to disable the backdoor entirely.

## Where to get it
Download **IndustryLADD** from the FAA **ADX portal** — https://adx.faa.gov
(SCBlockAtIndustry Collaboration Community). Questions: LADD program office,
(202) 267-0346 / LADD@faa.gov.

## Cadence (required)
- The list is published on the **first Thursday of each month**.
- You must update your copy within **FIVE business days** of publication.
- The server reloads this folder every ~6 hours, so replacing the file is enough — no restart needed.

## Auto-fetch (optional — no manual download)
Set `LADD_FETCH_URL` to the IndustryLADD download URL and the server pulls it **daily**
into this folder itself (so it's never >1 day stale, satisfying the 5-day rule automatically).
The ADX portal is auth-gated, so supply credentials from your ADX session:
- `LADD_FETCH_COOKIE` — a full `Cookie:` header value from an authenticated ADX session, and/or
- `LADD_FETCH_AUTH` — an `Authorization:` header value (e.g. `Bearer …`).

The fetcher refuses to overwrite the list if the response looks like a login/HTML page (so an
expired session won't wipe a good file). **You still need ADX access** — there is no public LADD
endpoint; the FAA gates it behind the SCBlockAtIndustry community. Without `LADD_FETCH_URL`, drop
the file here manually as above.

## Format
One identifier per line is ideal; CSV/TSV is tolerated (tokens split on `, ; | tab space`).
Matching is case-insensitive with dashes/spaces removed (`N123-AB` == `N123AB`).

## Important
- **Do not commit the actual list** — it identifies owners who requested privacy. The
  `.txt`/`.csv` files here are gitignored; only this README is tracked.
- If no list is present, `LaddService` logs a prominent WARNING and masks nothing —
  which is **not** compliant for public display. Keep a current list here whenever the
  public site is reachable.
- Real identities are still **stored** internally (flight cache + history), so the
  backdoor can reveal them; only the public projection is masked.
