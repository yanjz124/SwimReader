const $ = (id) => document.getElementById(id);
const rowsEl = $('rows'), emptyEl = $('empty'), countEl = $('count'), updatedEl = $('updated');
const theadEl = $('thead-row');
const searchEl = $('searchInput'), statusEl = $('statusFilter'),
      depEl = $('depInput'), arrEl = $('arrInput'), sortEl = $('sortBy'),
      presetEl = $('presetSel');
const dlg = $('detailDialog'), detailBody = $('detailBody'), closeBtn = $('closeDetail');

let allFlights = [];

const fmtTime = (iso) => {
    if (!iso) return '';
    try { return new Date(iso).toISOString().slice(11, 16) + 'Z'; } catch { return ''; }
};
const fmtAlt = (a) => {
    if (a == null) return '';
    return a >= 18000 ? 'FL' + Math.round(a / 100).toString().padStart(3, '0')
                      : Math.round(a).toLocaleString();
};
const esc = (s) => (s ?? '').toString()
    .replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');

// ── Column presets ──────────────────────────────────────────────────────────
// Mirror what an ATC flight strip shows (terminal + en route).
const altDisp = (f) => fmtAlt(f.altitude ?? f.assignedAlt ?? f.requestedAlt);
const filedSpd = (f) => f.filedTas ? 'T' + f.filedTas : (f.filedMach ? 'M' + f.filedMach : '');

const COLS = {
    callsign: { label: 'CS',  title: 'Callsign / Aircraft ID', cls: 'col-cs', get: (f) => esc(f.callsign || '') },
    cid:      { label: 'CID', title: 'Computer ID (facility/idNumber)', get: (f) =>
        f.facility || f.cid
            ? `<span style="color:#aaa">${esc(f.facility || '')}</span>${f.cid ? '/<span style="color:#cccc44">' + esc(f.cid) + '</span>' : ''}`
            : '' },
    status:   { label: 'ST',  title: 'Flight status', cls: 'col-status', get: (f) => esc(f.status || '') },
    type:     { label: 'TYPE', title: 'Aircraft type / model / equipment', get: (f) => {
        const t = f.acType || '';
        const eq = f.specialQual ? '/' + f.specialQual : '';
        return `<span>${esc(t)}</span><span style="color:#666">${esc(eq)}</span>`;
    }},
    cat:      { label: 'CAT', title: 'Aircraft category (JET/PROP/HEL)', get: (f) =>
        `<span style="color:#aaa">${esc(f.category || '')}</span>${f.userCategory ? '/<span style="color:#666">' + esc(f.userCategory.slice(0,4)) + '</span>' : ''}` },
    bcn:      { label: 'BCN', title: 'Assigned beacon code', get: (f) => esc(f.beaconCode || '') },
    spd:      { label: 'SPD', title: 'Filed TAS (T) or Mach (M)', get: (f) => esc(filedSpd(f)) },
    alt:      { label: 'ALT', title: 'Altitude (filed/assigned/current)', get: (f) => fmtAlt(f.altitude ?? f.assignedAlt ?? f.requestedAlt) },
    reqAlt:   { label: 'REQ', title: 'Requested altitude', get: (f) => fmtAlt(f.requestedAlt) },
    asgAlt:   { label: 'ASG', title: 'Assigned altitude', get: (f) => fmtAlt(f.assignedAlt) },
    curAlt:   { label: 'CUR', title: 'Current altitude (track)', get: (f) => fmtAlt(f.altitude) },
    curSpd:   { label: 'GS', title: 'Current ground speed', get: (f) => f.speed ?? '' },
    dep:      { label: 'DEP', cls: 'col-ap', get: (f) => esc(f.depArpt || '') },
    arr:      { label: 'ARR', cls: 'col-ap', get: (f) => esc(f.arrArpt || '') },
    dp:       { label: 'DP', title: 'Departure procedure (SID)', get: (f) =>
        f.dpName ? esc(f.dpName) + (f.dpTransitionFix ? '.<span style="color:#888">' + esc(f.dpTransitionFix) + '</span>' : '') : '' },
    star:     { label: 'STAR', title: 'Standard Terminal Arrival', get: (f) =>
        f.star ? esc(f.star) + (f.starTransitionFix ? '.<span style="color:#888">' + esc(f.starTransitionFix) + '</span>' : '') : '' },
    depFix:   { label: 'DEP FIX', get: (f) => esc(f.depFix || '') },
    arrFix:   { label: 'ARR FIX', get: (f) => esc(f.arrFix || '') },
    coord:    { label: 'COORD', title: 'Coordination fix / time', get: (f) =>
        f.coordinationFix ? esc(f.coordinationFix) + (f.coordinationTime ? ' ' + fmtTime(f.coordinationTime) : '') : '' },
    bnd:      { label: 'BND', title: 'Boundary fix / time', get: (f) =>
        f.boundaryFix ? esc(f.boundaryFix) + (f.boundaryCrossingTime ? ' ' + fmtTime(f.boundaryCrossingTime) : '') : '' },
    route:    { label: 'ROUTE', cls: 'col-route', title: 'Filed route', get: (f) => esc(f.route || '') },
    igtd:     { label: 'IGTD', cls: 'col-tm', title: 'Initial Gate Time of Departure', get: (f) => fmtTime(f.igtd) },
    etd:      { label: 'ETD',  cls: 'col-tm', title: 'Estimated time of departure', get: (f) => fmtTime(f.etd) },
    eta:      { label: 'ETA',  cls: 'col-tm', title: 'Estimated time of arrival', get: (f) => fmtTime(f.eta) },
    rwyOff:   { label: 'RWY OFF', cls: 'col-tm', title: 'Runway departure time', get: (f) => fmtTime(f.runwayDeparture) },
    out:      { label: 'OUT', cls: 'col-tm', title: 'Airline OUT (gate)', get: (f) => fmtTime(f.airlineOutTime) },
    off:      { label: 'OFF', cls: 'col-tm', title: 'Airline OFF (wheels up)', get: (f) => fmtTime(f.airlineOffTime) },
    on:       { label: 'ON',  cls: 'col-tm', title: 'Airline ON (wheels down)', get: (f) => fmtTime(f.airlineOnTime) },
    in:       { label: 'IN',  cls: 'col-tm', title: 'Airline IN (gate)', get: (f) => fmtTime(f.airlineInTime) },
    src:      { label: 'SRC', title: 'Source facility (last update)', get: (f) => `<span style="color:#666">${esc(f.sourceFacility || '')}</span>` },
    airline:  { label: 'OPR', title: 'Operator', get: (f) => esc(f.airline || '') },
    model:    { label: 'MODEL', get: (f) => esc(f.acModel || '') },
    diverted: { label: 'DIV', title: 'Diversion indicator', get: (f) => esc(f.diversionIndicator || '') },
};

const PRESETS = {
    // Mirror an ATC flight-strip layout (terminal + en route data combined)
    strip:     ['callsign', 'cid', 'bcn', 'type', 'cat', 'dep', 'dp', 'igtd', 'etd',
                'spd', 'alt', 'route', 'arr', 'star', 'eta', 'coord', 'bnd', 'status'],
    oooi:      ['callsign', 'cid', 'type', 'dep', 'arr', 'igtd', 'etd',
                'out', 'off', 'on', 'in', 'rwyOff', 'eta', 'bcn', 'src'],
    track:     ['callsign', 'cid', 'type', 'bcn', 'curAlt', 'curSpd', 'asgAlt',
                'dep', 'arr', 'star', 'eta', 'status'],
    everything: Object.keys(COLS),
};

let curPreset = localStorage.getItem('fido-preset') || 'strip';
if (!PRESETS[curPreset]) curPreset = 'strip';
presetEl.value = curPreset;

function buildHead() {
    const cols = PRESETS[curPreset].map(k => COLS[k]).filter(Boolean);
    theadEl.innerHTML = cols.map(c =>
        `<th${c.title ? ` title="${esc(c.title)}"` : ''}>${esc(c.label)}</th>`).join('');
}

function refreshFilterOptions() {
    const statuses = [...new Set(allFlights.map(f => f.status).filter(Boolean))].sort();
    const cur = statusEl.value;
    statusEl.innerHTML = '<option value="">ALL</option>'
        + statuses.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
    if (statuses.includes(cur)) statusEl.value = cur;
}

function applyFilters() {
    const q = searchEl.value.trim().toUpperCase();
    const status = statusEl.value;
    const dep = depEl.value.trim().toUpperCase();
    const arr = arrEl.value.trim().toUpperCase();
    const sortKey = sortEl.value;

    let filtered = allFlights.filter(f => {
        if (status && f.status !== status) return false;
        if (dep && (f.depArpt || '') !== dep) return false;
        if (arr && (f.arrArpt || '') !== arr) return false;
        if (q) {
            const hay = [f.callsign, f.airline, f.cid, f.depArpt, f.arrArpt,
                         f.acType, f.acModel, f.facility, f.route, f.star,
                         f.beaconCode, f.depFix, f.arrFix, f.sourceFacility]
                        .filter(Boolean).join(' ').toUpperCase();
            if (!hay.includes(q)) return false;
        }
        return true;
    });

    const cmpStr = (a, b) => (a || '').localeCompare(b || '');
    filtered.sort((a, b) => {
        switch (sortKey) {
            case 'callsign': return cmpStr(a.callsign, b.callsign);
            case 'dep': return cmpStr(a.depArpt, b.depArpt);
            case 'arr': return cmpStr(a.arrArpt, b.arrArpt);
            case 'status': return cmpStr(a.status, b.status);
            case 'age': return (a.ageSec ?? 9e9) - (b.ageSec ?? 9e9);
            case 'etd': return cmpStr(a.etd, b.etd);
            case 'igtd':
            default: return cmpStr(a.igtd || a.etd, b.igtd || b.etd);
        }
    });

    render(filtered);
}

function render(list) {
    countEl.textContent = `${list.length} of ${allFlights.length}`;
    if (list.length === 0) {
        rowsEl.innerHTML = '';
        emptyEl.style.display = '';
        emptyEl.textContent = allFlights.length === 0 ? 'No flights in TFMS feed yet.' : 'No matches.';
        return;
    }
    emptyEl.style.display = 'none';
    const cols = PRESETS[curPreset].map(k => COLS[k]).filter(Boolean);
    const html = list.map(f => {
        const cls = (f.status || '').toLowerCase();
        const tds = cols.map(c => `<td${c.cls ? ` class="${c.cls}"` : ''}>${c.get(f)}</td>`).join('');
        return `<tr class="${cls}" data-ref="${esc(f.flightRef)}">${tds}</tr>`;
    }).join('');
    rowsEl.innerHTML = html;
    rowsEl.querySelectorAll('tr').forEach(tr => {
        tr.addEventListener('click', () => showDetail(tr.dataset.ref));
    });
}

async function showDetail(ref) {
    if (!ref) return;
    try {
        const resp = await fetch('/api/tfms/flights/' + encodeURIComponent(ref));
        if (!resp.ok) { detailBody.innerHTML = `<h2>${esc(ref)}</h2><div style="color:#888">No detail available</div>`; dlg.showModal(); return; }
        const f = await resp.json();
        const groups = {
            'Identity': ['flightRef','callsign','airline','gufi','facility','cid','category','userCategory','status'],
            'Aircraft': ['acType','acModel','aircraftEngineClass','specialAircraftQualifier'],
            'Flight Plan': ['depArpt','arrArpt','requestedAltitude','assignedAlt','assignedBeaconCode','filedTrueAirSpeed','filedMach','star','starTransitionFix','dpName','dpType','dpTransitionFix','depFix','arrFix','route','routeOfFlight','coordinationFix','coordinationTime'],
            'Times': ['igtd','etd','eta','originalDeparture','originalArrival','gateDeparture','gateArrival','runwayDeparture','runwayArrival','airlineOutTime','airlineOffTime','airlineOnTime','airlineInTime','flightCreation','boundaryCrossingTime','arrivalFixTime','departureFixTime'],
            'Track': ['lat','lon','speed','altitude','reportedAltitudeRaw','positionTime','groundSpeed'],
            'Boundary': ['boundaryFix','boundaryRadial','boundaryDistance'],
            'Source': ['fdTrigger','sensitivity','cdmPart','sourceFacility','diversionIndicator'],
        };
        const seen = new Set();
        let html = `<h2>${esc(f.callsign || ref)}</h2>`;
        for (const [grp, keys] of Object.entries(groups)) {
            const rows = keys.filter(k => f[k] != null && f[k] !== '' && typeof f[k] !== 'object')
                .map(k => { seen.add(k); return `<div class="field"><span class="label">${esc(k)}</span><span class="value">${esc(f[k])}</span></div>`; })
                .join('');
            if (rows) html += `<h3>${esc(grp)}</h3>${rows}`;
        }
        const extras = Object.entries(f)
            .filter(([k, v]) => !seen.has(k) && v != null && v !== '' && typeof v !== 'object')
            .map(([k, v]) => `<div class="field"><span class="label">${esc(k)}</span><span class="value">${esc(v)}</span></div>`)
            .join('');
        if (extras) html += `<h3>Other</h3>${extras}`;
        // List collections (centers/sectors/waypoints/airways/fixes)
        for (const k of ['centers','sectors','airways','fixes','waypoints']) {
            const arr = f[k];
            if (Array.isArray(arr) && arr.length) {
                html += `<h3>${esc(k)} (${arr.length})</h3><div class="value" style="font-size:11px">${arr.map(item =>
                    typeof item === 'object' ? esc(JSON.stringify(item)) : esc(item)).join('<br>')}</div>`;
            }
        }
        detailBody.innerHTML = html;
        dlg.showModal();
    } catch (e) { console.error(e); }
}
closeBtn.addEventListener('click', () => dlg.close());

async function refresh() {
    try {
        const resp = await fetch('/api/tfms/all');
        const data = await resp.json();
        allFlights = Array.isArray(data) ? data : [];
        refreshFilterOptions();
        applyFilters();
        updatedEl.textContent = 'updated ' + new Date().toISOString().slice(11, 19) + 'Z';
    } catch (e) { countEl.textContent = 'error'; }
}

presetEl.addEventListener('change', () => {
    curPreset = presetEl.value;
    localStorage.setItem('fido-preset', curPreset);
    buildHead();
    applyFilters();
});
searchEl.addEventListener('input', applyFilters);
statusEl.addEventListener('change', applyFilters);
depEl.addEventListener('input', applyFilters);
arrEl.addEventListener('input', applyFilters);
sortEl.addEventListener('change', applyFilters);

buildHead();
refresh();
setInterval(refresh, 15000);
