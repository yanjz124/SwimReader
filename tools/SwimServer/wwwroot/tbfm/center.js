// ─────────────────────────────────────────────────────────────────────────────
// One ARTCC's TBFM: its meter points, the hold each is assigning, its acceptance rates, and the
// adaptation geometry drawn on a map.
//
// The map is the part nothing else in SwimReader shows. A TBFM meter point is either a FIX (MFX,
// a named point with a position) or an ARC (MFA / OMA / OOA / O3A / O4A — a segment of a circle
// at a given radius from the TRACON reference, spanning bearings `lan` → `ran` clockwise). The
// arc geometry is published in full, so these draw as the real thing rather than a sketch:
// lat/lon is the arc's CENTER, not a point on it.
// ─────────────────────────────────────────────────────────────────────────────

const segs = location.pathname.split('/').filter(Boolean);
const CTR = decodeURIComponent(segs[segs.length - 1] || '').toUpperCase();

const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hhmm = iso => iso ? String(iso).slice(11, 16) : '';

let board = null, map = null, layer = null, bndLayer = null, bndGeo = null;
let sortKey = 'scheduled', sortDir = -1;

// Arc / fix colors by point type. Meter fixes are the ERAM yellow the rest of the site uses;
// the arcs step outward through cooler colors so nested rings read at a glance.
const TYPE_COLOR = {
    MFX: '#cccc44', MFA: '#ff9944', OMA: '#44bbdd', OOA: '#6688ff', O3A: '#aa66dd', O4A: '#dd66aa',
};

// ── geometry ────────────────────────────────────────────────────────────────
const R_NM = 3440.065;   // earth radius in nautical miles

/** Point at `distNm` on bearing `brg` (degrees true) from lat/lon. */
function dest(lat, lon, brg, distNm) {
    const d = distNm / R_NM, t = brg * Math.PI / 180;
    const p1 = lat * Math.PI / 180, l1 = lon * Math.PI / 180;
    const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(t));
    const l2 = l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(p1),
        Math.cos(d) - Math.sin(p1) * Math.sin(p2));
    return [p2 * 180 / Math.PI, ((l2 * 180 / Math.PI + 540) % 360) - 180];
}

/** The arc from `lan` to `ran`, clockwise, as a polyline. */
function arcPath(lat, lon, radiusNm, lan, ran) {
    let span = (ran - lan + 360) % 360;
    if (span === 0) span = 360;                   // a full ring, not a zero-length line
    const steps = Math.max(8, Math.ceil(span / 3));
    const pts = [];
    for (let i = 0; i <= steps; i++) pts.push(dest(lat, lon, lan + span * i / steps, radiusNm));
    return pts;
}

// ── ARTCC boundaries ────────────────────────────────────────────────
// Whole-center outlines, so a meter point reads against the airspace it belongs to and extended
// metering is visible as points sitting in somebody else's center.
//
// Deliberately NOT the FAVs: those are per-sector, per-altitude-slab volumes (2,641 nationally)
// and drawing them here would bury the adaptation this page exists to show. vNAS's
// ArtccBoundaries.geojson is one polygon per ARTCC and publishes no high/low variants, so it IS
// already the high-altitude outline — there is no altitude choice to expose.
//
// Fetched ONCE and kept in its own layer and pane. `layer` below is torn down and rebuilt on every
// 10 s refresh; boundaries must not ride on that (24 polygons re-added 6x a minute), and the pane
// pins them under the adaptation instead of relying on add order surviving each rebuild.
const BND_PANE = 'artccBnd';

async function drawBoundaries() {
    if (!map || bndLayer) return;
    if (!bndGeo) {
        try {
            const r = await fetch('/api/airspace/artcc-boundaries');
            if (!r.ok) return;              // not fetched yet — the map is still fine without it
            bndGeo = await r.json();
        } catch { return; }
    }
    if (!map.getPane(BND_PANE)) map.createPane(BND_PANE).style.zIndex = 350;   // tiles 200, overlays 400
    bndLayer = L.geoJSON(bndGeo, {
        pane: BND_PANE,
        style: f => {
            const own = String(f.properties && f.properties.id || '').toUpperCase() === CTR;
            return {
                // This center solid and brighter, its neighbours dashed and dim, so they read as
                // context rather than competing with the meter points for attention.
                color: own ? '#6f7f8f' : '#44515c',
                weight: own ? 1.6 : 0.8,
                opacity: own ? 0.95 : 0.5,
                dashArray: own ? null : '2 6',
                fill: false,
                interactive: false,         // never steal a tooltip from a meter point
            };
        },
    }).addTo(map);
}

// ── metered traffic ─────────────────────────────────────────────────────────
// The aircraft being metered to these points, which is what turns the adaptation from a diagram
// into a picture of what the center is actually doing.
//
// TBFM publishes NO position — the only lat/lon in the whole feed is adaptation geometry — so each
// target is a TBFM schedule joined to SFDPS by callsign, server-side, in
// /api/tbfm/center/{ctr}/traffic. Measured at ZLA: 86% of metered callsigns have a position,
// median age 6 s; every miss was an oceanic or international inbound TBFM is metering while it is
// still outside domestic radar. Those are counted in the legend rather than silently dropped.
//
// Refreshed on its OWN timer: positions move on SFDPS's ~12 s cadence while the board's aggregates
// barely do, so moving a dot must not re-render the tables, the rates and the adaptation.
const TRAFFIC_PANE = 'tbfmTraffic';
let traffic = null, trafficLayer = null;
let showTraffic = localStorage.getItem('tbfm-traffic') !== '0';
let showAllLinks = localStorage.getItem('tbfm-links') === '1';

// Hold severity, warm as it gets worse. Deliberately NOT the adaptation palette: a target's color
// has to mean "how much hold", not "what kind of point", or the two readings compete.
function holdColor(min) {
    if (min == null || min < 1) return '#9fb0c0';
    if (min < 5) return '#ffcc44';
    if (min < 10) return '#ff8844';
    return '#ff4444';
}

/** Bearing from (lat,lon) to (lat2,lon2), degrees true. */
function bearing(lat, lon, lat2, lon2) {
    const p1 = lat * Math.PI / 180, p2 = lat2 * Math.PI / 180, dl = (lon2 - lon) * Math.PI / 180;
    const y = Math.sin(dl) * Math.cos(p2);
    const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/**
 * Where on a meter point a flight is actually heading.
 *
 * For a FIX that is the fix. For an ARC it is NOT the published lat/lon — that is the arc's CENTER
 * (the TRACON reference), so a leader drawn to it would point at a spot the aircraft is never
 * cleared to and, on a 50 nm arc, be wrong by 50 nm. The real target is the point on the arc
 * nearest the aircraft: the bearing from the center, clamped into the arc's clockwise span.
 */
function pointTarget(p, lat, lon) {
    if (!p || p.lat == null || p.lon == null) return null;
    if (!p.radiusNm || p.leftAngle == null || p.rightAngle == null) return [p.lat, p.lon];
    let span = (p.rightAngle - p.leftAngle + 360) % 360;
    if (span === 0) span = 360;
    let off = (bearing(p.lat, p.lon, lat, lon) - p.leftAngle + 360) % 360;
    // Outside the arc: clamp to whichever end is nearer, rather than wrapping to the far one.
    if (off > span) off = (off - span) < (360 - off) ? span : 0;
    return dest(p.lat, p.lon, p.leftAngle + off, p.radiusNm);
}

function drawTraffic() {
    if (!map) return;
    if (trafficLayer) { trafficLayer.remove(); trafficLayer = null; }
    if (!showTraffic || !traffic) { renderTrafficLegend(); return; }
    if (!map.getPane(TRAFFIC_PANE)) map.createPane(TRAFFIC_PANE).style.zIndex = 450;
    trafficLayer = L.layerGroup([], { pane: TRAFFIC_PANE }).addTo(map);

    // Adaptation by name, so a leader can be aimed at the real geometry. Arc names carry a
    // trailing dot in adaptation (HELNS. beside the fix HELNS), so both spellings are indexed.
    const geo = {};
    for (const p of (board && board.geometry || [])) {
        geo[p.name] = p;
        geo[p.name.replace(/\.$/, '')] = p;
    }

    for (const t of (traffic.flights || [])) {
        if (t.lat == null || t.lon == null) continue;
        const hold = t.holdMin;
        const col = holdColor(hold);
        const held = hold != null && hold >= 1;

        // Leader to the point this center is sequencing it to. Held flights only by default:
        // 215 lines at ZLA bury the adaptation underneath them, and an unheld flight's leader
        // carries nothing the point's own load count doesn't already give.
        const p = geo[t.point];
        if (p && (held || showAllLinks)) {
            const to = pointTarget(p, t.lat, t.lon);
            if (to) L.polyline([[t.lat, t.lon], to], {
                pane: TRAFFIC_PANE, color: col, weight: 0.8,
                opacity: held ? 0.45 : 0.2, dashArray: '2 4', interactive: false,
            }).addTo(trafficLayer);
        }

        // One-minute velocity vector, the same idiom as the ERAM scope: direction of flight reads
        // instantly and costs one canvas polyline, where a rotated symbol costs a DOM marker each.
        if (t.vx != null && t.vy != null && (t.vx || t.vy)) {
            const dLat = t.vy / 60, dLon = t.vx / (60 * Math.cos(t.lat * Math.PI / 180));
            L.polyline([[t.lat, t.lon], [t.lat + dLat, t.lon + dLon]], {
                pane: TRAFFIC_PANE, color: col, weight: 1.2, opacity: 0.8, interactive: false,
            }).addTo(trafficLayer);
        }

        const fl = t.alt == null ? ''
            : t.alt >= 18000 ? 'FL' + Math.round(t.alt / 100)
            : Math.round(t.alt).toLocaleString() + ' ft';
        const tip = `<b style="color:${col}">${esc(t.aid)}</b>`
            + (t.type ? ' ' + esc(t.type) : '')
            + `<br>${esc(t.dep || '?')} &rarr; <b>${esc(t.apt || '?')}</b>`
            + (fl ? '<br>' + fl : '') + (t.gs ? ' &middot; ' + Math.round(t.gs) + ' kt' : '')
            + (t.ctrl ? '<br>' + esc(t.ctrl) + (t.sector ? '/' + esc(t.sector) : '') : '')
            + (t.point ? `<br>next <b>${esc(t.point)}</b>`
                + (t.pointType ? ' ' + esc(t.pointType) : '')
                + (t.sta ? ' STA ' + hhmm(t.sta) : '')
                + (t.eta ? ' ETA ' + hhmm(t.eta) : '') : '')
            // The governing hold is usually NOT at the next point — TBFM distributes it upstream,
            // so a flight next at a ZLA fix with no delay can be carrying its whole hold from a
            // ZAB fix two links later. Naming where it is taken is the point of showing it at all.
            + (held
                ? `<br><b style="color:${col}">hold ${hold.toFixed(1)} min</b>`
                  + (t.holdPoint && (t.holdPoint !== t.point || t.holdCtr !== CTR)
                      ? ' at ' + esc(t.holdPoint) + (t.holdCtr ? ' (' + esc(t.holdCtr) + ')' : '')
                      : '')
                : '<br>no hold')
            + (t.rwy || t.staRwy ? '<br>rwy ' + esc(t.rwy || '?')
                + (t.staRwy ? ' STA ' + hhmm(t.staRwy) : '') : '')
            + (t.centers > 1 ? `<br>metered by ${t.centers} centers` : '')
            + (t.frozen ? '<br>frozen' : '') + (t.suspended ? '<br>suspended' : '')
            + (t.posAgeSec != null && t.posAgeSec > 60
                ? `<br><i>position ${t.posAgeSec}s old</i>` : '');

        L.circleMarker([t.lat, t.lon], {
            pane: TRAFFIC_PANE, radius: held ? 4 : 2.8, color: col, weight: 1,
            fillColor: col, fillOpacity: held ? 0.95 : 0.6, opacity: 0.95,
        }).bindTooltip(tip, { className: 'tt', sticky: true })
            .on('click', () => window.open('/track/' + encodeURIComponent(t.aid), '_blank'))
            .addTo(trafficLayer);
    }
    renderTrafficLegend();
}

function renderTrafficLegend() {
    const el = $('tlegend');
    if (!el) return;
    if (!showTraffic) { el.innerHTML = 'Traffic hidden.'; return; }
    if (!traffic) { el.innerHTML = 'Loading metered traffic&hellip;'; return; }
    const held = (traffic.flights || [])
        .filter(t => t.lat != null && t.holdMin != null && t.holdMin >= 1).length;
    el.innerHTML = '<i style="background:#9fb0c0"></i>no hold'
        + '<i style="background:#ffcc44"></i>1&ndash;5 min'
        + '<i style="background:#ff8844"></i>5&ndash;10'
        + '<i style="background:#ff4444"></i>10+ &nbsp; '
        + `<b>${traffic.located}</b> of ${traffic.scheduled} metered flights drawn, ${held} held. `
        + 'The vector is one minute of travel; the dashed leader points at the fix &mdash; or at '
        + 'the nearest point <i>on</i> the arc, never the arc&rsquo;s center &mdash; this center '
        + 'is sequencing it to. '
        + (traffic.unlocated
            ? `<b>${traffic.unlocated}</b> not drawn: TBFM is metering them but SFDPS has no `
              + 'position yet &mdash; oceanic and international inbounds, still outside domestic '
              + 'radar. '
            : '')
        + 'Click a target for its full cross-source status.';
}

async function loadTraffic() {
    if (!showTraffic) { renderTrafficLegend(); return; }
    try {
        const r = await fetch('/api/tbfm/center/' + encodeURIComponent(CTR) + '/traffic');
        if (!r.ok) return;
        traffic = await r.json();
        drawTraffic();
    } catch { /* a missed poll is a stale dot, not a broken page */ }
}

// ── map ─────────────────────────────────────────────────────────────────────
function drawMap() {
    const g = (board.geometry || []).filter(p => p.lat != null && p.lon != null);
    if (!g.length) {
        $('map').innerHTML = '<div class="empty">No adaptation geometry received for this center yet. '
            + 'TBFM publishes adaptation rarely — it is cached to disk, so it fills in over hours.</div>';
        $('map').style.height = 'auto';
        return;
    }
    // Load counts so a point that is actually being metered stands out from one that is only adapted.
    const load = {};
    for (const p of (board.points || [])) load[p.name] = p;

    if (!map) {
        map = L.map('map', { zoomControl: true, attributionControl: false, preferCanvas: true });
        // Same proxied basemap the scopes use, so there's no third-party tile dependency here.
        L.tileLayer('/basemap/dark_nolabels/{z}/{x}/{y}{r}.png', { maxZoom: 11 }).addTo(map);
    }
    drawBoundaries();   // once; fire-and-forget so a slow fetch never holds up the adaptation
    if (layer) layer.remove();
    layer = L.layerGroup().addTo(map);

    // Fit to the points being METERED, not to all of them. A center's adaptation reaches well
    // outside its own airspace for extended metering — ZLA adapts points as far as the east coast
    // — so fitting everything shrank the SoCal cluster that is the actual subject to a smudge.
    // Everything is still drawn; only the initial view is narrowed, and a center with nothing
    // scheduled falls back to its whole adaptation.
    const bounds = [], busyBounds = [];
    for (const p of g) {
        const col = TYPE_COLOR[p.type] || '#888';
        const l = load[p.name] || load[p.name.replace(/\.$/, '')];
        const busy = l && l.scheduled > 0;
        const held = l && l.delayed > 0;
        const tip = `<b style="color:${col}">${esc(p.name)}</b> ${esc(p.type || '')}`
            + (p.gate ? `<br>gate ${esc(p.gate)}` : '')
            + (p.tracon ? `<br>${esc(p.tracon)}` : '')
            + (p.radiusNm ? `<br>${p.radiusNm} nm, ${p.leftAngle}°–${p.rightAngle}°` : '')
            + (p.altLow != null || p.altHigh != null
                ? `<br>${p.altLow ?? '?'}–${p.altHigh ?? '?'} ft` : '')
            + (l ? `<br><b>${l.scheduled}</b> scheduled`
                + (l.delayed ? `, ${l.delayed} held ${l.delayMin} min` : '') : '<br>not in use');

        if (p.radiusNm && p.leftAngle != null && p.rightAngle != null) {
            const path = arcPath(p.lat, p.lon, p.radiusNm, p.leftAngle, p.rightAngle);
            L.polyline(path, {
                color: col, weight: held ? 3.5 : busy ? 2.5 : 1,
                opacity: busy ? 0.9 : 0.35, dashArray: busy ? null : '3 5',
            }).bindTooltip(tip, { className: 'tt', sticky: true }).addTo(layer);
            bounds.push(...path);
            if (busy) busyBounds.push(...path);
        } else {
            L.circleMarker([p.lat, p.lon], {
                radius: busy ? 4 : 2.5, color: col, weight: 1,
                fillColor: col, fillOpacity: busy ? 0.9 : 0.3, opacity: busy ? 0.9 : 0.4,
            }).bindTooltip(tip, { className: 'tt', sticky: true }).addTo(layer);
            bounds.push([p.lat, p.lon]);
            if (busy) busyBounds.push([p.lat, p.lon]);
        }
    }
    // Only on the first draw — a refresh every 10s must not yank a view the reader has panned.
    const fit = busyBounds.length ? busyBounds : bounds;
    if (fit.length && !map._tbfmFitted) {
        map.fitBounds(L.latLngBounds(fit).pad(0.1));
        map._tbfmFitted = true;
    }

    const kinds = [...new Set(g.map(p => p.type).filter(Boolean))].sort();
    $('legend').innerHTML = kinds.map(k =>
        `<i style="background:${TYPE_COLOR[k] || '#888'}"></i>${k}`).join('')
        + `<i style="background:#6f7f8f"></i>${esc(CTR)}<i style="background:#44515c"></i>adjacent ARTCC`
        + ' &nbsp;&nbsp; solid = being metered now, dashed = adapted but idle, thick = holding. '
        + `${g.length} of ${board.adaptedPoints} adapted points have coordinates`
        + (busyBounds.length
            ? ', view fitted to the ones in use — zoom out for the rest, which reach outside '
              + 'this center for extended metering.'
            : '.');
}

// ── strip / info ────────────────────────────────────────────────────────────
function cell(k, v, cls) {
    return `<div class="cell"><span class="k">${k}</span><span class="v ${cls || ''}">${v}</span></div>`;
}

function renderStrip() {
    const b = board;
    const stale = b.lastMessageSec == null || b.lastMessageSec > 300;
    $('strip').innerHTML =
        cell('SCHEDULED', b.scheduled) +
        cell('HELD &ge;1 MIN', b.delayed, b.delayed ? 'warn' : '') +
        cell('HOLD ASSIGNED', `${b.delayMin}<small style="font-size:11px;color:#888"> min</small>`,
            b.delayMin > 100 ? 'bad' : b.delayMin ? 'warn' : '') +
        cell('LONGEST', `${b.maxDelayMin}<small style="font-size:11px;color:#888"> min</small>`,
            b.maxDelayMin >= 10 ? 'bad' : b.maxDelayMin >= 1 ? 'warn' : '') +
        cell('POINTS IN USE', (b.points || []).length) +
        cell('ADAPTED POINTS', b.adaptedPoints, 'sm') +
        cell('ADAPTED APTS', b.adaptedAirports, 'sm') +
        cell('HEARTBEAT', b.heartbeatSec == null ? '—' : b.heartbeatSec + 's',
            stale ? 'bad' : 'good');
}

function renderInfo() {
    const b = board;
    const bits = [];
    const tr = (b.tracons || []).filter(t => t !== 'EDC');
    if (tr.length) bits.push('TRACONs ' + esc(tr.join(' ')));
    bits.push(`${Object.keys(b.gates || {}).length} gates`);
    bits.push(`${b.streamClasses} stream classes`);
    if ((b.otherConfigKinds || []).length)
        bits.push('Config records with no rate: ' + b.otherConfigKinds
            .map(k => `${esc(k.kind)} (${k.n})`).join(', '));
    $('info').innerHTML = bits.join(' · ');
    $('tracons').textContent = tr.join(' ');
}

// ── meter-point table ───────────────────────────────────────────────────────
const PCOLS = [
    { k: 'name', t: 'POINT' }, { k: 'type', t: 'KIND' }, { k: 'tracon', t: 'TRACON' },
    { k: 'gate', t: 'GATE' }, { k: 'scheduled', t: 'SCHED', n: 1 },
    { k: 'delayed', t: 'HELD', n: 1 }, { k: 'delayMin', t: 'HOLD MIN', n: 1 },
    { k: 'maxDelayMin', t: 'LONGEST', n: 1 }, { k: 'frozen', t: 'FRZ', n: 1 },
    { k: 'airports', t: 'AIRPORTS' }, { k: 'nextSta', t: 'NEXT STA' },
    { k: 'radiusNm', t: 'GEOMETRY' },
];

function renderPHeader() {
    $('phdr').innerHTML = PCOLS.map(c =>
        `<th class="sortable ${c.n ? 'num' : ''}" data-k="${c.k}">${c.t}` +
        (sortKey === c.k ? `<span class="arr"> ${sortDir > 0 ? '▲' : '▼'}</span>` : '') + '</th>'
    ).join('');
    for (const th of $('phdr').querySelectorAll('th.sortable')) {
        th.onclick = () => {
            const k = th.dataset.k;
            if (sortKey === k) sortDir = -sortDir;
            else { sortKey = k; sortDir = PCOLS.find(c => c.k === k).n ? -1 : 1; }
            renderPHeader(); renderPoints();
        };
    }
}

function renderPoints() {
    const q = $('q').value.trim().toUpperCase();
    const onlyDly = $('onlydly').checked;
    let rows = (board.points || []).filter(p => {
        if (onlyDly && !p.delayed) return false;
        if (!q) return true;
        const hay = [p.name, p.type, p.tracon, p.gate,
            ...(p.airports || []).map(a => a.apt)].join(' ').toUpperCase();
        return q.split(/\s+/).filter(Boolean).every(t => hay.includes(t));
    });
    rows.sort((a, b) => {
        let x = a[sortKey], y = b[sortKey];
        if (sortKey === 'airports') { x = (a.airports[0] || {}).apt; y = (b.airports[0] || {}).apt; }
        if (x == null && y == null) return 0;
        if (x == null) return 1;
        if (y == null) return -1;
        if (typeof x === 'number' && typeof y === 'number') return (x - y) * sortDir;
        return String(x).localeCompare(String(y)) * sortDir;
    });
    $('count').textContent = `${rows.length} of ${(board.points || []).length}`;
    if (!rows.length) {
        $('pbody').innerHTML = `<tr><td class="empty" colspan="${PCOLS.length}">No meter points match.</td></tr>`;
        return;
    }
    $('pbody').innerHTML = rows.map(p => {
        const col = TYPE_COLOR[p.type] || '#888';
        const geo = p.radiusNm
            ? `${p.radiusNm} nm ${p.leftAngle}°–${p.rightAngle}°`
            : p.lat != null ? 'fix' : '';
        const dCls = p.delayMin >= 60 ? 'pos big' : p.delayMin ? 'pos' : 'ok';
        return `<tr>
            <td style="color:${col};font-weight:bold">${esc(p.name)}</td>
            <td class="dim">${esc(p.type || '')}</td>
            <td>${esc(p.tracon || '')}</td>
            <td class="dim">${esc(p.gate || '')}</td>
            <td class="num">${p.scheduled}</td>
            <td class="num ${p.delayed ? 'pos' : 'dim'}">${p.delayed || ''}</td>
            <td class="num ${dCls}">${p.delayMin || ''}</td>
            <td class="num ${p.maxDelayMin >= 10 ? 'pos big' : p.maxDelayMin >= 1 ? 'pos' : 'dim'}">${p.maxDelayMin || ''}</td>
            <td class="num dim">${p.frozen || ''}</td>
            <td>${(p.airports || []).map(a =>
            `<a href="/tbfm/${esc(a.apt.toLowerCase())}">${esc(a.apt)}</a><span class="dim">·${a.n}</span>`).join(' ')}</td>
            <td class="dim">${hhmm(p.nextSta)}</td>
            <td class="dim">${geo}</td>
        </tr>`;
    }).join('');
}

function renderRates() {
    const rs = board.rates || [];
    $('rbody').innerHTML = rs.length ? rs.map(r => `<tr>
        <td>${esc(r.kind.toUpperCase())}</td>
        <td style="color:#cccc44">${esc(r.id)}</td>
        <td class="dim">${esc(r.tracon || '')}</td>
        <td class="num ${r.restricted ? 'pos' : 'dim'}">${r.rate}${r.restricted ? '' : ' <span class="dim">(none)</span>'}</td>
        <td class="dim">${esc(r.type || '')}</td>
        <td class="dim">${(r.effective || '').replace('T', ' ').replace('Z', 'Z')}</td>
      </tr>`).join('')
        // Rates are NOT persisted across a restart (only adaptation is), and <con> is a rare
        // message — ~1.3% of TBFM traffic — so an empty table shortly after a deploy is expected
        // rather than broken. Say so, since "No rates published" reads like a fault.
        : '<tr><td class="empty" colspan="6">No rates published yet. Rates arrive on TBFM’s '
        + 'rare <code>con</code> messages and are rebuilt from the feed after a restart, so this '
        + 'fills in over the following hour.</td></tr>';
}

function renderAirports() {
    // A center adapts every airport it might meter to, which for ZLA is 67 — and ~60 of those are
    // bare EDC entries with no runways, no configs and nothing scheduled. They are real, but a
    // screenful of empty rows buries the handful that matter, so they're behind a toggle.
    const all = (board.airports || []).slice()
        .sort((a, b) => b.metered - a.metered || a.name.localeCompare(b.name));
    const useful = a => a.metered > 0 || (a.runways || []).length
        || Object.keys(a.configs || {}).length;
    const showAll = $('allapts').checked;
    const as = showAll ? all : all.filter(useful);
    const hidden = all.length - all.filter(useful).length;
    $('aptnote').innerHTML = hidden
        ? `${hidden} adapted airport${hidden === 1 ? '' : 's'} with no runways, configs or traffic `
          + `${showAll ? 'shown' : 'hidden'}`
        : '';
    $('abody').innerHTML = as.length ? as.map(a => `<tr>
        <td><a href="/tbfm/${esc(a.name.toLowerCase())}">${esc(a.name)}</a></td>
        <td class="dim">${esc(a.tracon || '')}</td>
        <td class="num ${a.metered ? '' : 'dim'}">${a.metered || ''}</td>
        <td class="dim">${esc((a.runways || []).join(' '))}</td>
        <td class="dim">${esc(Object.keys(a.configs || {}).join(' '))}</td>
      </tr>`).join('')
        : '<tr><td class="empty" colspan="5">No airports in adaptation yet.</td></tr>';
}



async function load() {
    try {
        const r = await fetch('/api/tbfm/center/' + encodeURIComponent(CTR));
        if (!r.ok) {
            $('status').textContent = 'not found';
            $('strip').innerHTML = `<div class="empty">No TBFM system called ${esc(CTR)}. `
                + '<a href="/tbfm?tab=centers">All centers</a>.</div>';
            return;
        }
        board = await r.json();
        $('title').textContent = 'TBFM ' + board.ctr;
        document.title = `TBFM ${board.ctr} — Meter Points`;
        $('status').textContent = new Date().toISOString().slice(11, 19) + 'Z';
        $('status').classList.add('ok');
        renderStrip(); renderInfo(); drawMap(); renderPoints(); renderRates(); renderAirports();
        drawTraffic();   // the geometry it just loaded is what aims each leader
        $('note').innerHTML = 'A meter point’s hold is its <b>own</b> — what the sector working '
            + 'it sees — so these do not add up to an airport’s total: a flight held here reads '
            + '~0 at the next point downstream once that hold has been absorbed. '
            + 'An arc (MFA / OMA / OOA / O3A / O4A) is a segment of a circle at the published radius '
            + 'from the TRACON reference, drawn clockwise from its left bearing to its right. '
            + 'Rates of 3600/hr are TBFM’s “no restriction” default, not real '
            + 'acceptance rates.';
    } catch (e) {
        $('status').textContent = 'error';
        $('status').classList.remove('ok');
    }
}

// frame.js derives UP from the path, which for /tbfm/center/ZAB would be /tbfm/center — not a page.
// Point it at the directory's center tab instead, once frame.js has built the cluster.
window.addEventListener('load', () => {
    const up = document.querySelector('.nav-up');
    if (up) { up.href = '/tbfm?tab=centers'; up.innerHTML = '&uarr; TBFM'; }
});

$('allapts').onchange = () => board && renderAirports();
$('q').oninput = () => board && renderPoints();
$('onlydly').onchange = () => board && renderPoints();

$('tf-traffic').checked = showTraffic;
$('tf-links').checked = showAllLinks;
$('tf-traffic').onchange = e => {
    showTraffic = e.target.checked;
    localStorage.setItem('tbfm-traffic', showTraffic ? '1' : '0');
    if (showTraffic && !traffic) loadTraffic(); else drawTraffic();
};
$('tf-links').onchange = e => {
    showAllLinks = e.target.checked;
    localStorage.setItem('tbfm-links', showAllLinks ? '1' : '0');
    drawTraffic();
};

renderPHeader();
load();
setInterval(load, 10000);
// Its own timer, matched to SFDPS's ~12 s cadence. Separate from load() on purpose: a position
// refresh must not re-render the tables, the rates and the adaptation just to move a dot.
loadTraffic();
setInterval(loadTraffic, 12000);
