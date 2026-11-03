// ─────────────────────────────────────────────────────────────────────────────
// One ARTCC's TBFM: its meter points, the hold each is assigning, its acceptance rates, and the
// adaptation geometry drawn on a map.
//
// The map is the part nothing else in SwimReader shows. A TBFM meter point is either a FIX (MFX,
// a named point with a position) or an ARC (MFA / OMA / OOA / O3A / O4A — a segment of a circle
// at a given radius from the TRACON reference, spanning bearings `lan` → `ran` clockwise). The
// arc geometry is published in full, so these draw as the real thing rather than a sketch:
// lat/lon is the arc's CENTRE, not a point on it.
// ─────────────────────────────────────────────────────────────────────────────

const segs = location.pathname.split('/').filter(Boolean);
const CTR = decodeURIComponent(segs[segs.length - 1] || '').toUpperCase();

const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hhmm = iso => iso ? String(iso).slice(11, 16) : '';

let board = null, map = null, layer = null;
let sortKey = 'scheduled', sortDir = -1;

// Arc / fix colours by point type. Meter fixes are the ERAM yellow the rest of the site uses;
// the arcs step outward through cooler colours so nested rings read at a glance.
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

// ── map ─────────────────────────────────────────────────────────────────────
function drawMap() {
    const g = (board.geometry || []).filter(p => p.lat != null && p.lon != null);
    if (!g.length) {
        $('map').innerHTML = '<div class="empty">No adaptation geometry received for this centre yet. '
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
    if (layer) layer.remove();
    layer = L.layerGroup().addTo(map);

    const bounds = [];
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
        } else {
            L.circleMarker([p.lat, p.lon], {
                radius: busy ? 4 : 2.5, color: col, weight: 1,
                fillColor: col, fillOpacity: busy ? 0.9 : 0.3, opacity: busy ? 0.9 : 0.4,
            }).bindTooltip(tip, { className: 'tt', sticky: true }).addTo(layer);
            bounds.push([p.lat, p.lon]);
        }
    }
    if (bounds.length) map.fitBounds(L.latLngBounds(bounds).pad(0.06));

    const kinds = [...new Set(g.map(p => p.type).filter(Boolean))].sort();
    $('legend').innerHTML = kinds.map(k =>
        `<i style="background:${TYPE_COLOR[k] || '#888'}"></i>${k}`).join('')
        + ' &nbsp;&nbsp; solid = being metered now, dashed = adapted but idle, thick = holding. '
        + `${g.length} of ${board.adaptedPoints} adapted points have coordinates.`;
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
        : '<tr><td class="empty" colspan="6">No rates published.</td></tr>';
}

function renderAirports() {
    const as = (board.airports || []).slice()
        .sort((a, b) => b.metered - a.metered || a.name.localeCompare(b.name));
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
                + '<a href="/tbfm?tab=centers">All centres</a>.</div>';
            return;
        }
        board = await r.json();
        $('title').textContent = 'TBFM ' + board.ctr;
        document.title = `TBFM ${board.ctr} — Meter Points`;
        $('status').textContent = new Date().toISOString().slice(11, 19) + 'Z';
        $('status').classList.add('ok');
        renderStrip(); renderInfo(); drawMap(); renderPoints(); renderRates(); renderAirports();
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
// Point it at the directory's centre tab instead, once frame.js has built the cluster.
window.addEventListener('load', () => {
    const up = document.querySelector('.nav-up');
    if (up) { up.href = '/tbfm?tab=centers'; up.innerHTML = '&uarr; TBFM'; }
});

$('q').oninput = () => board && renderPoints();
$('onlydly').onchange = () => board && renderPoints();
renderPHeader();
load();
setInterval(load, 10000);
