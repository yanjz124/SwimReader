# vNAS Data API Endpoints Used

All STARS profile data comes from `https://data-api.vnas.vatsim.net/`. The
data is the same shape that `scope/MapImporter/CRC/CRCARTCC.cs` parses (the
WPF program reads exported CRC files; the vNAS API publishes the live
upstream version of the same schema).

## Endpoints we hit

### `GET /api/artccs/`
Returns an array of ARTCC summaries: `[{ id, name, lastUpdatedAt }, ...]`.
We only extract the IDs. Refreshed once per 24h.

### `GET /api/artccs/{artccId}/`
Full ARTCC document mirroring `CRCARTCC`:
- `id`, `lastUpdatedAt`
- `facility` — root facility (recursive `childFacilities[]`)
- `visibilityCenters[]`
- `videoMaps[]` — full GeoJSON descriptors (we use this in Phase 2)

Cached per-ARTCC on first request.

### Facility schema (recursive)

```
facility {
  id, name, type,
  childFacilities[],
  starsConfiguration: { areas[], beaconCodeBanks[], primaryScratchpadRules[],
                       secondaryScratchpadRules[], rnavPatterns[],
                       starsHandoffIds[], videoMapIds[], mapGroups[],
                       allow4CharacterScratchpad },
  eramConfiguration: { ... },
  positions[],
  neighboringFacilityIds[],
}
```

## Derived endpoints (server-side)

We expose three derived endpoints to keep the client simple:

| Endpoint | Returns |
|----------|---------|
| `GET /api/stars/artccs` | `["ZDC", "ZNY", ...]` |
| `GET /api/stars/artcc/{id}` | `{ artccId, facilities: [{id,name,type,parentId,videoMapCount,areaCount}] }` — only facilities that have a STARS configuration |
| `GET /api/stars/facility/{artccId}/{facilityId}` | Single facility's `starsConfiguration`, `positions`, `location`, plus the resolved `videoMaps[]` metadata (id/name/shortName/starsId/starsBrightnessCategory) |

## Auto-pick behavior

`CRCMapImporter.cs` lines 28-50: if exactly one facility under the ARTCC
has a STARS configuration with video maps, auto-pick it. The web picker
mirrors this — when `/api/stars/artcc/{id}` returns exactly one facility,
the browser auto-navigates to `/stars/{artcc}/{facility}` without showing
a second list.

## Refresh policy

ARTCC list: once on startup, then every 24h.
Per-ARTCC facility tree: lazy on first request, kept in memory; on next
startup it's re-fetched on demand. We don't persist to disk — vNAS is the
single source of truth and a fresh fetch is fast (≤200 KB JSON typical).
