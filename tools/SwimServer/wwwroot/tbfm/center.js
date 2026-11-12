// ─────────────────────────────────────────────────────────────────────────────
// One ARTCC's TBFM: its meter points, the hold each is assigning, its acceptance rates, and the
// adaptation geometry drawn on a map with the traffic being metered to it.
//
// The geometry, the boundaries and the traffic layer all live in map.js, shared with the airport
// board — the two pages draw the same things and differ only in which points and which flights.
// ─────────────────────────────────────────────────────────────────────────────

const segs = location.pathname.split('/').filter(Boolean);
const CTR = decodeURIComponent(segs[segs.length - 1] || '').toUpperCase();

const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hhmm = iso => iso ? String(iso).slice(11, 16) : '';

let board = null, map = null, layer = null;
let sortKey = 'scheduled', sortDir = -1;

const TYPE_COLOR = TbfmMap.TYPE_COLOR;

// The traffic layer: its own endpoint, its own 12 s timer, its own controls. A center map shows
// THIS center's link for every flight, because that is what its controllers are scheduling.
const traffic = TbfmMap.Traffic({
    url: () => '/api/tbfm/center/' + encodeURIComponent(CTR) + '/traffic',
    getMap: () => map,
    geometry: () => (board && board.geometry) || [],
    legendEl: 'tlegend',
});

// ── map ─────────────────────────────────────────────────────────────────────
function drawMap() {
    const g = (board.geometry || []).filter(p => p.lat != null && p.lon != null);
    if (!g.length) {
        $('map').innerHTML = '<div class="empty">No adaptation geometry received for this center yet. '
            + 'TBFM publishes adaptation rarely — it is cached to disk, so it fills in over hours.</div>';
        $('map').style.height = 'auto';
        return;
    }
    // Load counts so a point that is actually being metered stands out from one only adapted.
    const load = {};
    for (const p of (board.points || [])) load[p.name] = p;

    if (!map) {
        map = L.map('map', { zoomControl: true, attributionControl: false, preferCanvas: true });
        // Same proxied basemap the scopes use, so there's no third-party tile dependency here.
        L.tileLayer('/basemap/dark_nolabels/{z}/{x}/{y}{r}.png', { maxZoom: 11 }).addTo(map);
    }
    // Once; fire-and-forget so a slow fetch never holds up the adaptation.
    TbfmMap.drawBoundaries({
        map,
        highlight: [CTR],
        get bndLayer() { return map._tbfmBnd; },
        set bndLayer(v) { map._tbfmBnd = v; },
    });
    if (layer) layer.remove();
    layer = L.layerGroup().addTo(map);

    const { bounds, busyBounds } = TbfmMap.drawPoints(layer, g,
        p => load[p.name] || load[p.name.replace(/\.$/, '')] || null);

    // Fit to the points being METERED, not to all of them. A center's adaptation reaches well
    // outside its own airspace for extended metering — ZLA adapts points as far as the east coast
    // — so fitting everything shrank the SoCal cluster that is the actual subject to a smudge.
    // Everything is still drawn; only the initial view is narrowed, and a center with nothing
    // scheduled falls back to its whole adaptation.
    //
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
        traffic.draw();   // the geometry it just loaded is what aims each leader
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

traffic.bindControls();

renderPHeader();
load();
setInterval(load, 10000);
// Its own timer, matched to SFDPS's ~12 s cadence. Separate from load() on purpose: a position
// refresh must not re-render the tables, the rates and the adaptation just to move a dot.
traffic.load();
setInterval(() => traffic.load(), 12000);
