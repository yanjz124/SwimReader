/* ── Sector KML parser (shared) ─────────────────────────────────────────────────
 * Parses an `AllSectors.kml` / `AllHighSectors.kml` / `AllLowSectors.kml` into
 * {artcc, name, sectorId, alt, category, coords} records.
 *
 * Extracted from eram.js so there is ONE copy. The categorization is not
 * mechanical and would drift immediately if duplicated:
 *
 *   - Most placemarks carry a FolderPath in their description table, as
 *     "xxx/ZDC/High Altitude (17)/sectorId", and the category needs its "(17)"
 *     count stripped.
 *   - The WESTERN ARTCCs have no FolderPath at all. For those the ARTCC and the
 *     category have to be recovered by walking up to an ancestor <Folder> whose
 *     name looks like "ZLA_HIGH_NEW" and pattern-matching the words in it.
 *     Without that fallback those centers silently vanish — 204 of ~2,124
 *     placemarks, which looks like missing data rather than a parse gap.
 *
 * This file is the legacy source. vNAS Fixed Airspace Volumes are better in
 * every way that matters (numeric floor/ceiling per slab, real volumes, dated,
 * server-cached) and are what /api/airspace/favs serves; the KML is kept because
 * it is what exists offline and because its categories are what the ERAM scope's
 * boundary layers were built around.
 *
 * Published on `window` deliberately: a top-level `const` in a classic script is
 * NOT a property of the global object, which is the bug GlobalScopeContractTests
 * exists to catch.
 * ──────────────────────────────────────────────────────────────────────────── */

'use strict';

window.KmlSectors = {
    /**
     * Fetch and parse one sector KML.
     * @param {string} file e.g. 'AllSectors.kml'
     * @returns {Promise<Array<{artcc,name,sectorId,alt,category,coords}>>}
     *          coords are [lat, lon] pairs, ready for Leaflet.
     */
    async parse(file) {
        const parsed = [];
        const resp = await fetch('/api/kml/' + encodeURIComponent(file));
        if (!resp.ok) throw new Error(`${file}: HTTP ${resp.status}`);
        const text = await resp.text();
        const xml = new DOMParser().parseFromString(text, 'text/xml');
        const placemarks = xml.querySelectorAll('Placemark');

        for (const pm of placemarks) {
            const name = pm.querySelector('name')?.textContent || '';
            const desc = pm.querySelector('description')?.textContent || '';
            const coordEl = pm.querySelector('coordinates');
            if (!coordEl) continue;

            // The description is an HTML table of key/value cells.
            const descDoc = new DOMParser().parseFromString(desc, 'text/html');
            const tds = descDoc.querySelectorAll('td');
            const data = {};
            for (let i = 0; i < tds.length - 1; i += 2) {
                data[tds[i].textContent.trim()] = tds[i + 1].textContent.trim();
            }

            const folderPath = data['FolderPath'] || '';
            const parts = folderPath.split('/');
            let artcc = parts.length >= 2 ? parts[1] : '';
            let category = '';
            let sectorId = name;

            if (artcc) {
                // "xxx/ZDC/High Altitude (17)/sectorId"
                const catRaw = parts.length >= 3 ? parts[2] : '';
                category = catRaw.replace(/\s*\(\d+\)$/, '');
                sectorId = parts.length >= 4 ? parts[3] : name;
            } else {
                // Western ARTCCs: no FolderPath. Walk up to a Folder named like
                // "ZLA_HIGH_NEW" and read the ARTCC and category out of it.
                let el = pm.parentElement;
                while (el) {
                    const fn = el.tagName === 'Folder'
                        ? (el.querySelector(':scope > name')?.textContent || '') : '';
                    const m = fn.match(/^(Z[A-Z]{2})[_ ]/);
                    if (m) {
                        artcc = m[1];
                        const upper = fn.toUpperCase();
                        if (upper.includes('ULTRA')) category = 'Ultra High';
                        else if (upper.includes('HIGH')) category = 'High Altitude';
                        else if (upper.includes('LOW')) category = 'Low Altitude';
                        else if (upper.includes('APPROACH')) category = 'Approach Control';
                        else category = 'High Altitude';
                        break;
                    }
                    el = el.parentElement;
                }
            }
            if (!artcc) continue;

            const coords = coordEl.textContent.trim().split(/\s+/).map(c => {
                const [lon, lat] = c.split(',');
                return [parseFloat(lat), parseFloat(lon)];
            }).filter(c => !isNaN(c[0]) && !isNaN(c[1]));

            if (coords.length < 2) continue;
            parsed.push({ artcc, name, sectorId, alt: data['ALT'] || '', category, coords });
        }

        const catCounts = {};
        for (const s of parsed) catCounts[s.category] = (catCounts[s.category] || 0) + 1;
        console.log(`[KML] ${file}: ${parsed.length} sectors`, catCounts);
        return parsed;
    },
};
