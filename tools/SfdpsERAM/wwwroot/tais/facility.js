const FACILITY = location.pathname.split('/').pop().toUpperCase();
document.getElementById('title').textContent = `TAIS  ${FACILITY}`;
document.title = `TAIS ${FACILITY} | swim.vncrcc.org`;

let tracks = []; // array of track objects from server
let sortCol = 'callsign';
let sortAsc = true;
let expandedTrack = null;
let searchTerm = '';

const statusEl     = document.getElementById('status');
const statsEl      = document.getElementById('stats');
const rowsEl       = document.getElementById('rows');
const searchEl     = document.getElementById('search');
const resultEl     = document.getElementById('resultCount');
const filterFrozen = document.getElementById('filterFrozen');

filterFrozen.addEventListener('change', () => render());

// ── WebSocket ──────────────────────────────────────────────────
let ws = null;
function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/tais/ws/${FACILITY.toLowerCase()}`);

    ws.onopen = () => {
        statusEl.textContent = 'LIVE';
        statusEl.className = 'status ok';
    };

    ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'snapshot') {
            tracks = msg.data.tracks || [];
            render();
        } else if (msg.type === 'batch') {
            tracks = msg.data || [];
            render();
        } else if (msg.type === 'remove') {
            const r = msg.data;
            tracks = tracks.filter(t => t.trackNum !== r.trackNum);
            render();
        }
    };

    ws.onclose = () => {
        statusEl.textContent = 'DISCONNECTED';
        statusEl.className = 'status';
        if (!window.idlePaused || !window.idlePaused()) setTimeout(connect, 5000);
    };

    ws.onerror = () => ws.close();
}

// ── Search ────────────────────────────────────────────────────
searchEl.addEventListener('input', () => {
    searchTerm = searchEl.value.trim().toUpperCase();
    render();
});

function matchesSearch(t) {
    if (!searchTerm) return true;
    const fields = [
        t.callsign, t.acType, t.origin, t.dest,
        t.reportedSqk, t.assignedSqk, t.owner, t.sp1, t.sp2,
        t.trackNum, t.runway, t.entryFix, t.exitFix, t.modeS
    ];
    return fields.some(f => f && f.toUpperCase().includes(searchTerm));
}

// ── Sorting ───────────────────────────────────────────────────
document.getElementById('colHeader').addEventListener('click', (e) => {
    const col = e.target.dataset.col;
    if (!col) return;
    if (sortCol === col) { sortAsc = !sortAsc; }
    else { sortCol = col; sortAsc = true; }
    document.querySelectorAll('.col-header span').forEach(s => s.classList.remove('sorted'));
    e.target.classList.add('sorted');
    render();
});

function getSortValue(t, col) {
    switch (col) {
        case 'callsign': return t.callsign || t.trackNum || '';
        case 'acType':   return t.acType || '';
        case 'origin':   return t.origin || '';
        case 'dest':     return t.dest || '';
        case 'altFt':    return t.altFt ?? -1;
        case 'gs':       return t.gs ?? -1;
        case 'reportedSqk': return t.reportedSqk || '';
        case 'runway':   return t.runway || '';
        case 'sp1':      return t.sp1 || '';
        case 'owner':    return t.owner || '';
        default:         return '';
    }
}

function cmpSort(a, b) {
    let va = getSortValue(a, sortCol);
    let vb = getSortValue(b, sortCol);
    if (typeof va === 'number' && typeof vb === 'number') {
        return sortAsc ? va - vb : vb - va;
    }
    va = String(va); vb = String(vb);
    return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
}

// ── Render ────────────────────────────────────────────────────
function render() {
    const fFrozen = filterFrozen.value;
    const filtered = tracks.filter(t => {
        if (!matchesSearch(t)) return false;
        if (fFrozen === 'yes' && !t.frozen) return false;
        if (fFrozen === 'no' && t.frozen) return false;
        return true;
    });
    filtered.sort(cmpSort);

    statsEl.textContent = `${tracks.length} tracks`;
    const isFiltered = searchTerm || fFrozen;
    resultEl.textContent = isFiltered ? `${filtered.length} / ${tracks.length}` : '';

    const html = filtered.map(t => {
        const isExpanded = expandedTrack === t.trackNum;
        const cs = t.callsign || `#${t.trackNum}`;
        const csClass = t.callsign ? 'cs' : 'cs noplan';
        const alt = fmtAlt(t.altFt);
        const gs = t.gs != null ? t.gs : '';

        let flags = '';
        if (t.frozen) flags += ' <span class="frozen">FRZ</span>';
        if (t.pseudo) flags += ' <span class="pseudo">PSE</span>';

        return `<div class="track-row${isExpanded ? ' expanded' : ''}" data-tn="${t.trackNum}">
            <span class="${csClass}">${esc(cs)}${flags}</span>
            <span>${esc(t.acType || '')}</span>
            <span class="dep">${esc(fmtApt(t.origin))}</span>
            <span class="arr">${esc(fmtApt(t.dest))}</span>
            <span class="alt">${alt}</span>
            <span class="gs">${gs}</span>
            <span class="sqk">${esc(t.reportedSqk || '')}</span>
            <span class="rwy">${esc(t.runway || '')}</span>
            <span class="sp">${esc(t.sp1 || '')}</span>
            <span class="own">${esc(t.owner || '')}</span>
        </div>
        <div class="track-detail${isExpanded ? ' open' : ''}" data-tn="${t.trackNum}">
            ${isExpanded ? renderDetail(t) : ''}
        </div>`;
    }).join('');

    rowsEl.innerHTML = html;

    rowsEl.querySelectorAll('.track-row').forEach(el => {
        el.addEventListener('click', () => {
            const tn = el.dataset.tn;
            expandedTrack = expandedTrack === tn ? null : tn;
            render();
        });
    });
}

function renderDetail(t) {
    const fields1 = [
        ['Callsign', t.callsign, ''],
        ['Track #', t.trackNum, ''],
        ['Type', t.acType, ''],
        ['Wake', t.wake, ''],
        ['Equipment', t.equip, ''],
        ['Rules', fmtRules(t.rules), ''],
    ];
    const fields2 = [
        ['Origin', t.origin, ''],
        ['Destination', t.dest, ''],
        ['Entry Fix', t.entryFix, ''],
        ['Exit Fix', t.exitFix, ''],
        ['Runway', t.runway, ''],
    ];
    const fields3 = [
        ['Assigned SQK', t.assignedSqk, ''],
        ['Reported SQK', t.reportedSqk, ''],
        ['Req Altitude', t.reqAlt != null ? t.reqAlt.toLocaleString() + ' ft' : null, ''],
        ['Scratchpad 1', t.sp1, ''],
        ['Scratchpad 2', t.sp2, ''],
        ['Owner (CPS)', t.owner, 'accent'],
        ['Pending H/O', t.handoff, 'warn'],
    ];
    const fields4 = [
        ['Latitude', t.lat != null ? t.lat.toFixed(4) : null, ''],
        ['Longitude', t.lon != null ? t.lon.toFixed(4) : null, ''],
        ['Altitude', t.altFt != null ? t.altFt.toLocaleString() + ' ft' : null, 'hl'],
        ['Ground Speed', t.gs != null ? t.gs + ' kts' : null, ''],
        ['Track', t.trk != null ? t.trk + '°' : null, ''],
        ['Vert Rate', t.vs != null ? (t.vs >= 0 ? '+' : '') + t.vs + ' fpm' : null, ''],
        ['Mode S', t.modeS, ''],
        ['Frozen', t.frozen ? 'YES' : 'No', t.frozen ? 'warn' : ''],
        ['Pseudo', t.pseudo ? 'YES' : 'No', t.pseudo ? 'warn' : ''],
        ['Age', t.ageSec != null ? t.ageSec + 's' : null, ''],
    ];

    return `
    <div class="detail-section">
        <h4>IDENTITY</h4>
        <div class="detail-grid">${renderFields(fields1)}</div>
    </div>
    <div class="detail-section">
        <h4>ROUTE</h4>
        <div class="detail-grid">${renderFields(fields2)}</div>
    </div>
    <div class="detail-section">
        <h4>FLIGHT PLAN</h4>
        <div class="detail-grid">${renderFields(fields3)}</div>
    </div>
    <div class="detail-section">
        <h4>TRACK / POSITION</h4>
        <div class="detail-grid">${renderFields(fields4)}</div>
    </div>`;
}

function renderFields(fields) {
    return fields
        .filter(([, v]) => v != null && v !== '')
        .map(([label, value, cls]) =>
            `<div class="f"><span class="lbl">${label}</span><span class="val${cls ? ' ' + cls : ''}">${esc(String(value))}</span></div>`
        ).join('');
}

// ── Helpers ───────────────────────────────────────────────────
function fmtAlt(ft) {
    if (ft == null) return '';
    if (ft >= 18000) return 'FL' + Math.round(ft / 100);
    return ft.toLocaleString();
}

function fmtApt(code) {
    if (!code) return '';
    return code.replace(/^K/, '');
}

function fmtRules(r) {
    if (r === 'IFR') return 'IFR';
    if (r === 'VFR') return 'VFR';
    return r || '';
}

function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Init ──────────────────────────────────────────────────────
window.idleOnPause = () => { if (ws) { ws.onclose = null; ws.close(); ws = null; } };
window.idleOnResume = () => { connect(); };
connect();
