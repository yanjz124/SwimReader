# faa-swim — a Claude skill for live FAA SWIM data

Lets Claude answer questions against a running [SwimReader](https://github.com/yanjz124/SwimReader)
server: where a flight is across every data source, airport conditions and runway winds, surface
and departure boards, terminal clearances, feed health, flight history, real filed routes for a
city pair, and airline fleet research.

It is a **skill**, not an MCP server — no extra process to run. Claude calls the SwimReader HTTP
API directly and the skill teaches it which endpoint answers which question, and how to read the
answers without drawing wrong conclusions.

## Install

**As a plugin** (from a local clone):

```
/plugin marketplace add /path/to/SwimReader/claude-plugin
/plugin install faa-swim
```

**Or just the skill** — copy the folder:

```bash
cp -r claude-plugin/skills/faa-swim ~/.claude/skills/faa-swim
```

## Configure

Set these wherever your shell picks them up:

```bash
export SWIM_API_URL=https://your-swimreader-host       # required
export SWIM_API_USER=...                               # only if that host uses HTTP Basic
export SWIM_API_PASS=...
```

Credentials are optional and read from the environment — **nothing is committed**. If the server
you point at isn't gated, leave them unset; the skill sends no auth header rather than an empty one.

With no `SWIM_API_URL` the skill tells you it isn't configured instead of guessing a hostname.

## Try it

> where is UAL1247 right now
> what are the winds and runway situation at KBOS
> is the SWIM feed healthy
> what route do aircraft actually file from KJFK to KLAX
> how hard does Delta work its 757s

## What it will and won't do

The skill is written to avoid the specific mistakes this data invites:

- it quotes the **current** feed rate from `/api/feed`, not the lifetime average in `/api/stats`
- it treats `discardEvents` and `lagSec` as the health signals, not throughput
- it knows one callsign is several GUFIs, that CIDs are per-facility, and that TFMS often has a
  flight hours before SFDPS does
- it filters the large responses (`/api/tfdm/{apt}` ~600 KB, `/api/airlines/{icao}` ~450 KB)
  rather than dumping them

**LADD-blocked aircraft are masked server-side** and the skill is instructed to report them as
masked and never to reconstruct a blocked aircraft's identity or movements by other means.

This is operational awareness and research data. It is not a navigation, separation or dispatch
source, and the skill says so.

## Sharing it

Each person points `SWIM_API_URL` at a server they're allowed to use and supplies their own
credentials. Don't redistribute bulk extracts of the data itself.
