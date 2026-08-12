// Video-map bridge for the DGScope port — pulls the facility's STARS video maps from SwimServer
// (/api/stars/facility/{artcc}/{facility} for the list, /api/stars/videoMap/{artcc}/{id} for each
// GeoJSON) and feeds them through the port's own GeoJSONMapExporter into RadarWindow.VideoMaps.
import { GeoJSONMapExporter } from "./src/MapGeoJSON.js";
import { MapCategory } from "./src/VideoMap.js";

export async function loadVideoMaps(rw, artcc, facility) {
  if (!artcc || !facility) return { loaded: 0 };
  let metas = [];
  try {
    const fac = await fetch(`/api/stars/facility/${encodeURIComponent(artcc)}/${encodeURIComponent(facility)}`).then(r => r.json());
    metas = fac.videoMaps || [];
  } catch (e) { console.warn("[dstars-maps] facility list failed", e); return { loaded: 0 }; }

  const displayed = rw.CurrentPrefSet?.DisplayedMaps; // starsIds the profile wants shown (may be null/empty)
  let loaded = 0;
  for (const m of metas) {
    try {
      const maps = await GeoJSONMapExporter.GeoJSONFileToMaps(`/api/stars/videoMap/${encodeURIComponent(artcc)}/${encodeURIComponent(m.id)}`);
      if (!maps || maps.length === 0) continue;
      const map = maps[0];
      if (m.name) map.Name = m.name;
      if (m.shortName) map.Mnemonic = m.shortName;
      if (m.starsId != null) map.Number = m.starsId;
      map.Category = (m.starsBrightnessCategory === "A") ? MapCategory.A : MapCategory.B;
      // Visible if the profile lists this starsId; if the profile carries no list, show it so
      // there's something on screen (the DCB MAP buttons still toggle individual maps).
      map.Visible = (displayed && displayed.length) ? displayed.includes(m.starsId) : true;
      rw.VideoMaps.Add(map);
      loaded++;
    } catch (e) { console.warn("[dstars-maps] map load failed", m.id, e); }
  }
  return { loaded };
}
