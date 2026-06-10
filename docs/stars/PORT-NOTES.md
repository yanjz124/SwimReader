# STARS Port Notes

Working notes for the WPF DGScope → web STARS port. Treat this as the project
journal: every architectural decision, every place the source had to be
interpreted, every gap from "100% exact" gets recorded here so a future reader
can audit our work against `github.com/yanjz124/scope`.

## Sources of truth

1. **Primary** — the WPF source at `github.com/yanjz124/scope` (cloned locally
   into the gitignored `.stars-reference/` directory for grep/read).
2. **Domain reference** — CRC STARS docs at `https://docs.virtualnas.net/crc/stars/`.
   Used only for clarification when the WPF source is ambiguous.
3. **Profiles + settings** — vNAS data API at `https://data-api.vnas.vatsim.net/`.
   The user explicitly OK'd pulling all profile data from vNAS (this is the same
   data CRC itself uses).

## Rule

> "Never be creative. Follow visual, behavior, and functionalities EXACTLY.
> Replicate everything 100%. If you need a workaround it must be 100% the same.
> If it can't happen, document it so we can test to get as close as possible."

When the WPF source disagrees with the CRC docs, the WPF source wins.
When a browser platform constraint blocks an exact replication, it gets
documented in [KNOWN-DEVIATIONS.md](KNOWN-DEVIATIONS.md) — not silently worked
around.

## Phase plan

| # | Phase | Status | Commit |
|---|-------|--------|--------|
| 1 | Foundation + chrome | done | b30e4a6 |
| 2 | Video maps | done | 00bc4e5 |
| 3a | DSTARS stream + position symbols | done | edf03e3 |
| 3b | Data blocks + leaders + history | done | 3a11de4 |
| 4 | DCB (main + Aux + submenus) | done | 8139847 |
| 5 | Command line + preview area | done | 1d222e6 |
| 6 | System lists | skipped (not in WPF; see PHASE-NOTES) | (this commit) |
| 7 | SSA | pending | — |
| 8 | Handoffs / point-outs / consolidation / coordination | pending | — |
| 9 | STCA / ATPA / CRDA / MinSep / J-rings | pending | — |
| 10 | NEXRAD | pending | — |
| 11 | Secondary displays + polish | pending | — |

Update the row when a phase commits — link to the commit hash.

## Data sources at runtime

- **Tracks + flight plans:** the existing SwimReader DSTARS server at
  `/dstars/{facility}/updates`. The WPF program already consumes this exact
  protocol via `DGScope.Receivers.ScopeServer/ScopeServerClient.cs` — we
  mirror its parsing.
- **Profiles / facilities / video maps / STARS config:** vNAS data API.
  See [VNAS-API.md](VNAS-API.md) for the endpoints we hit.

## How a phase gets committed

Each phase ends with:

1. A self-contained commit on `feat/stars` with a `stars:phaseN:` prefix.
2. The phase row above updated to `done` with the commit hash.
3. Any new deviations appended to `KNOWN-DEVIATIONS.md`.
4. Any per-phase implementation notes appended to `PHASE-NOTES.md`.

Backtracking: `git checkout feat/stars~N` jumps back to that phase. Phases
are independent enough to bisect.
