// ── State ────────────────────────────────────────────────────
const allFlights = new Map();
const knownFacilities = new Set();
let selectedGufi = null;
let currentDetail = null;
let activeTab = 'plan';
let expandedEvents = new Set();  // event indices with expanded XML
let xmlCache = {};               // `${gufi}:${index}` → xml string
let sortCol = 'callsign', sortAsc = true;
let searchTerm = '';
let ws = null;
let showIcao = false;
let lastIcaoText = '';

// Historical flights: retained after server purge, size-capped
const MAX_HIST_BYTES = 50 * 1024 * 1024; // 50 MB
let historicalBytes = 0;

function trimHistorical() {
    if (historicalBytes <= MAX_HIST_BYTES) return;
    const hist = [];
    for (const [gufi, f] of allFlights) {
        if (f._historical) hist.push([gufi, f._removedAt || 0, f._histBytes || 0]);
    }
    hist.sort((a, b) => a[1] - b[1]); // oldest first
    while (historicalBytes > MAX_HIST_BYTES && hist.length > 0) {
        const [gufi, , bytes] = hist.shift();
        allFlights.delete(gufi);
        historicalBytes -= bytes;
    }
}

const statusEl   = document.getElementById('status');
const statsEl    = document.getElementById('stats');
const rowsEl     = document.getElementById('rows');
const searchEl   = document.getElementById('search');
const countEl    = document.getElementById('resultCount');
const filterStatus   = document.getElementById('filterStatus');
const filterFacility = document.getElementById('filterFacility');
const filterRules    = document.getElementById('filterRules');
const detailPanel = document.getElementById('detailPanel');
const detailBody  = document.getElementById('detailBody');

// ── WebSocket ────────────────────────────────────────────────
function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws`);

    ws.onopen = () => {
        statusEl.textContent = 'LIVE';
        statusEl.className = 'status ok';
    };

    ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'snapshot') {
            for (const f of msg.data) { allFlights.set(f.gufi, f); noteFacility(f); }
        } else if (msg.type === 'batch') {
            for (const f of msg.data) { allFlights.set(f.gufi, f); noteFacility(f); }
        } else if (msg.type === 'update') {
            allFlights.set(msg.data.gufi, msg.data);
            noteFacility(msg.data);
        } else if (msg.type === 'remove') {
            const rf = allFlights.get(msg.data.gufi);
            if (rf && !rf._historical) {
                rf._historical = true;
                rf._removedAt = Date.now();
                rf._histBytes = JSON.stringify(rf).length;
                historicalBytes += rf._histBytes;
                trimHistorical();
            }
        } else if (msg.type === 'stats') {
            statsEl.textContent = `${(msg.data.flights || 0).toLocaleString()} flights  ${(msg.data.rate || 0).toFixed(0)} msg/s`;
        }
        scheduleRender();
    };

    ws.onclose = () => {
        statusEl.textContent = 'DISCONNECTED';
        statusEl.className = 'status';
        if (!window.idlePaused || !window.idlePaused()) setTimeout(connect, 2000);
    };
    ws.onerror = () => ws.close();
}

function noteFacility(f) {
    if (f.reportingFacility && !knownFacilities.has(f.reportingFacility)) {
        knownFacilities.add(f.reportingFacility);
        rebuildFacilityDropdown();
    }
}

function rebuildFacilityDropdown() {
    const current = filterFacility.value;
    const sorted = [...knownFacilities].sort();
    filterFacility.innerHTML = '<option value="">All</option>' +
        sorted.map(f => `<option value="${f}"${f === current ? ' selected' : ''}>${f}</option>`).join('');
}

// ── Render (throttled) ───────────────────────────────────────
let renderPending = false;
function scheduleRender() {
    if (renderPending) return;
    renderPending = true;
    requestAnimationFrame(render);
}

function render() {
    renderPending = false;
    const fStatus = filterStatus.value;
    const fFacility = filterFacility.value;
    const fRules = filterRules.value;
    const q = searchTerm.toUpperCase();

    let filtered = [];
    let histCount = 0;
    for (const f of allFlights.values()) {
        if (f._historical) histCount++;
        if (fStatus === 'historical' && !f._historical) continue;
        if (fStatus === 'active' && (f.flightStatus !== 'ACTIVE' || f._historical)) continue;
        if (fStatus === 'dropped' && (f.flightStatus !== 'DROPPED' || f._historical)) continue;
        // fStatus === '' (All) shows everything including historical
        if (fFacility && f.reportingFacility !== fFacility) continue;
        if (fRules && f.flightRules !== fRules) continue;
        if (q && !matchesSearch(f, q)) continue;
        filtered.push(f);
    }

    filtered.sort((a, b) => {
        let va = getSortValue(a, sortCol);
        let vb = getSortValue(b, sortCol);
        if (va < vb) return sortAsc ? -1 : 1;
        if (va > vb) return sortAsc ? 1 : -1;
        return 0;
    });

    countEl.textContent = histCount > 0
        ? `${filtered.length} shown (${histCount} historical)`
        : `${filtered.length} shown`;

    const html = [];
    for (const f of filtered) {
        const sel = f.gufi === selectedGufi ? ' selected' : '';
        html.push(renderRow(f, sel));
    }
    rowsEl.innerHTML = html.join('');

    rowsEl.querySelectorAll('.flight-row').forEach(el => {
        el.addEventListener('click', (e) => {
            // Pin star click is handled separately
            if (e.target.dataset && e.target.dataset.action === 'pin') {
                e.stopPropagation();
                handlePinClick(el.dataset.gufi);
                return;
            }
            selectFlight(el.dataset.gufi);
        });
    });
}

// Field-scoped search syntax (mirrors backend /api/history):
//   bare value         → matches default fields (callsign starts-with, origin/dest, reg, cid)
//   field:value        → matches a specific field (contains)
//   value with *       → wildcard (foo*, *foo, *foo*)
//   multiple terms     → AND'ed together (whitespace-separated)
const FIELD_ALIAS = {
    cs: 'callsign', callsign: 'callsign',
    op: 'operator', operator: 'operator', airline: 'operator',
    org: 'origin', origin: 'origin', from: 'origin', dep: 'origin',
    dest: 'destination', destination: 'destination', to: 'destination', arr: 'destination',
    type: 'aircraftType', actype: 'aircraftType', aircrafttype: 'aircraftType', ac: 'aircraftType',
    reg: 'registration', registration: 'registration',
    sq: 'squawk', squawk: 'squawk', beacon: 'squawk',
    rules: 'flightRules', flightrules: 'flightRules',
    ftype: 'flightType', flighttype: 'flightType',
    route: 'route', rte: 'route',
    star: 'star',
    rmk: 'remarks', remarks: 'remarks', rmks: 'remarks',
    altitude: 'assignedAltitude', alt: 'assignedAltitude',
    status: 'flightStatus', flightstatus: 'flightStatus',
    cid: 'computerId', computerid: 'computerId',
    fac: 'controllingFacility', facility: 'controllingFacility', controllingfacility: 'controllingFacility',
    sector: 'controllingSector', controllingsector: 'controllingSector',
    ho: 'handoffEvent', handoff: 'handoffEvent',
    text: 'clearanceText', clearancetext: 'clearanceText',
    tmi: 'tmiIds', tmiids: 'tmiIds',
    datalink: 'dataLinkCode', cpdlc: 'dataLinkCode',
    gufi: 'gufi', fdpsgufi: 'fdpsGufi'
};
// "All" mode default fields — broad match across the most useful fields.
const DEFAULT_FIELDS_ALL = [
    { f: 'callsign',            style: 'startsWith' },
    { f: 'origin',              style: 'airport' },
    { f: 'destination',         style: 'airport' },
    { f: 'aircraftType',        style: 'contains' },
    { f: 'route',               style: 'contains' },
    { f: 'remarks',             style: 'contains' },
    { f: 'squawk',              style: 'contains' },
    { f: 'registration',        style: 'startsWith' },
    { f: 'computerId',          style: 'exact' },
    { f: 'controllingFacility', style: 'contains' },
    { f: 'controllingSector',   style: 'contains' }
];

// Per-field default search style when the dropdown selects a single field
const SINGLE_FIELD_STYLE = {
    callsign:           'startsWith',
    aircraftType:       'contains',
    origin:             'airport',
    destination:        'airport',
    airport:            'airport',  // virtual: matches origin OR destination
    route:              'contains',
    remarks:            'contains',
    squawk:             'contains',
    registration:       'startsWith',
    computerId:         'exact',
    controllingSector:  'contains',
    tmiIds:             'contains'
};

let searchField = 'all';   // current dropdown selection

function defaultFieldsForCurrent() {
    if (searchField === 'all') return DEFAULT_FIELDS_ALL;
    if (searchField === 'airport')
        return [
            { f: 'origin',      style: 'airport' },
            { f: 'destination', style: 'airport' }
        ];
    return [{ f: searchField, style: SINGLE_FIELD_STYLE[searchField] || 'contains' }];
}

function parseQuery(raw) {
    const tokens = [];
    let buf = '', inQ = false;
    for (const c of raw) {
        if (c === '"') { inQ = !inQ; continue; }
        if (!inQ && /\s/.test(c)) {
            if (buf) { tokens.push(buf); buf = ''; }
        } else buf += c;
    }
    if (buf) tokens.push(buf);
    return tokens.map(t => {
        const i = t.indexOf(':');
        if (i > 0 && i < t.length - 1) return { field: t.slice(0, i).toLowerCase(), pat: t.slice(i + 1) };
        return { field: null, pat: t };
    });
}

function airportMatches(field, q) {
    field = (field || '').toUpperCase();
    q = (q || '').toUpperCase();
    if (field === q) return true;
    if (field.length === 4 && (field[0] === 'K' || field[0] === 'P') && field.slice(1) === q) return true;
    if (q.length === 4 && (q[0] === 'K' || q[0] === 'P') && field === q.slice(1)) return true;
    return false;
}

function wildcardMatch(value, pattern, defaultStyle) {
    value = String(value || '').toUpperCase();
    pattern = pattern.toUpperCase();
    if (pattern.indexOf('*') >= 0) {
        const lead = pattern.startsWith('*'), trail = pattern.endsWith('*');
        const core = pattern.replace(/^\*+|\*+$/g, '');
        if (!core) return value.length > 0;
        if (lead && trail) return value.includes(core);
        if (lead) return value.endsWith(core);
        if (trail) return value.startsWith(core);
        // Mid wildcards: split, anchor first/last
        const parts = pattern.split('*');
        let idx = 0;
        for (let i = 0; i < parts.length; i++) {
            if (!parts[i]) continue;
            const found = value.indexOf(parts[i], idx);
            if (found < 0) return false;
            if (i === 0 && found !== 0) return false;
            idx = found + parts[i].length;
        }
        if (parts[parts.length - 1] && !value.endsWith(parts[parts.length - 1])) return false;
        return true;
    }
    switch (defaultStyle) {
        case 'startsWith': return value.startsWith(pattern);
        case 'exact':      return value === pattern;
        case 'airport':    return airportMatches(value, pattern);
        case 'contains':
        default:           return value.includes(pattern);
    }
}

function matchesClause(f, c) {
    if (c.field) {
        const jsonField = FIELD_ALIAS[c.field];
        if (!jsonField) return false;
        const v = f[jsonField];
        if (v === undefined || v === null) return false;
        return wildcardMatch(String(v), c.pat, 'contains');
    }
    for (const { f: jf, style } of defaultFieldsForCurrent()) {
        const v = f[jf];
        if (v && wildcardMatch(String(v), c.pat, style)) return true;
    }
    return false;
}

function matchesSearch(f, q) {
    // Cache parsed clauses per query string to avoid re-parsing every flight
    if (matchesSearch._lastQ !== q) {
        matchesSearch._lastQ = q;
        matchesSearch._clauses = parseQuery(q);
    }
    const clauses = matchesSearch._clauses;
    if (clauses.length === 0) return true;
    for (const c of clauses) {
        if (!matchesClause(f, c)) return false;
    }
    return true;
}

function getSortValue(f, col) {
    switch (col) {
        case 'callsign': return f.callsign || '';
        case 'aircraftType': return f.aircraftType || '';
        case 'origin': return f.origin || '';
        case 'destination': return f.destination || '';
        case 'assignedAltitude': return f.assignedAltitude || 0;
        case 'interimAltitude': return f.interimAltitude || 0;
        case 'flightRules': return f.flightRules || '';
        case 'controllingFacility': return (f.controllingFacility || '') + (f.controllingSector || '');
        case 'squawk': return f.squawk || '';
        case 'dataLinkCode': return f.dataLinkCode && f.dataLinkCode.includes('J') ? 0 : 1;
        default: return '';
    }
}

function renderRow(f, selClass) {
    const alt = fmtAlt(f);
    const altCls = f.assignedVfr ? ' vfr' : '';
    const intAlt = f.interimAltitude ? `FL${Math.round(f.interimAltitude / 100)}` : '';
    const rules = f.flightRules === 'IFR' ? 'I' : f.flightRules === 'VFR' ? 'V' : (f.flightRules || '');
    const sector = f.controllingFacility
        ? f.controllingFacility + (f.controllingSector ? '/' + f.controllingSector : '')
        : '';
    const histCls = f._historical ? ' historical' : '';
    const stCls = f._historical ? 'historical' : (f.flightStatus || '').toLowerCase();
    const pinState = pinRecords.get(f.gufi);
    const pinCls = !pinState ? '' : (pinState.pinned ? ' pinned' : ' grace');
    const pinChar = pinState && pinState.pinned ? '★' : '☆';
    const pinTitle = !pinState
        ? 'Pin to protect from history cleanup'
        : pinState.pinned
            ? 'Unpin (will be kept ≥24h after unpin)'
            : 'Recently unpinned — click to re-pin';
    return `<div class="flight-row${selClass}${histCls}" data-gufi="${f.gufi}">
        <span class="pin${pinCls}" data-action="pin" title="${pinTitle}">${pinChar}</span>
        <span class="cs">${f.callsign || '????'}</span>
        <span>${f.aircraftType || ''}</span>
        <span class="dep">${f.origin || ''}</span>
        <span class="arr">${f.destination || ''}</span>
        <span class="alt${altCls}">${alt}</span>
        <span class="int">${intAlt}</span>
        <span class="rules">${rules}</span>
        <span class="sector">${sector}</span>
        <span class="sqk">${f.squawk || ''}</span>
        <span class="dl ${f.dataLinkCode && f.dataLinkCode.includes('J') ? 'yes' : 'no'}">${f.dataLinkCode && f.dataLinkCode.includes('J') ? 'J' : ''}</span>
        <span class="st ${stCls}"></span>
    </div>`;
}

function fmtAlt(f) {
    if (f.assignedVfr) {
        if (f.assignedAltitude) return `VFR/${Math.round(f.assignedAltitude / 100)}`;
        return 'VFR';
    }
    if (f.blockFloor && f.blockCeiling)
        return `${Math.round(f.blockFloor / 100)}B${Math.round(f.blockCeiling / 100)}`;
    if (f.assignedAltitude) {
        const fl = Math.round(f.assignedAltitude / 100);
        return f.assignedAltitude >= 18000 ? `FL${fl}` : `${Math.round(f.assignedAltitude)}`;
    }
    return '';
}

// ── Detail panel ─────────────────────────────────────────────
async function selectFlight(gufi) {
    selectedGufi = gufi;
    expandedEvents.clear();
    xmlCache = {};
    detailPanel.classList.remove('collapsed');
    scheduleRender();

    try {
        const resp = await fetch(`/api/flights/${encodeURIComponent(gufi)}`);
        if (resp.ok) {
            currentDetail = await resp.json();
            currentDetail._purged = false;
        } else {
            // 404 — flight purged from server, use last known data from Map
            const f = allFlights.get(gufi);
            if (!f) return;
            currentDetail = Object.assign({}, f, { _purged: true, events: [] });
        }
        renderDetailHeader(currentDetail);
        renderActiveTab();
    } catch {}
}

function closeDetail() {
    selectedGufi = null;
    currentDetail = null;
    detailPanel.classList.add('collapsed');
    scheduleRender();
}

function renderDetailHeader(d) {
    document.getElementById('detailCallsign').textContent = d.callsign || '????';
    document.getElementById('detailType').textContent = [d.aircraftType, d.wakeCategory].filter(Boolean).join('/');
    const statEl = document.getElementById('detailStatus');
    if (d._purged) {
        statEl.textContent = 'HISTORICAL';
        statEl.className = 'status-badge historical';
    } else {
        statEl.textContent = d.flightStatus || '';
        statEl.className = 'status-badge ' + (d.flightStatus || '').toLowerCase();
    }
    document.getElementById('eventCount').textContent = d.events ? ` (${d.events.length})` : '';
}

function renderActiveTab() {
    if (!currentDetail) return;
    if (activeTab === 'plan') {
        detailBody.innerHTML = renderFlightPlan(currentDetail);
    } else {
        if (currentDetail._purged) {
            detailBody.innerHTML = '<div class="purge-banner">PURGED FROM SERVER &mdash; EVENT LOG UNAVAILABLE</div>';
        } else {
            detailBody.innerHTML = renderEventLog(currentDetail);
            attachEventHandlers();
        }
    }
}

// ── ICAO FPL ────────────────────────────────────────────────
function toIcao(lid) {
    if (!lid) return 'ZZZZ';
    if (lid.length >= 4) return lid.toUpperCase();
    return 'K' + lid.toUpperCase();
}

function nasToIcaoRoute(route, origin, dest) {
    if (!route) return 'DCT';
    let r = route;
    r = r.replace(/\/\d{4}$/, '');           // strip trailing /HHMM ETE
    r = r.replace(/\.\./g, ' DCT ');         // .. = direct-to
    r = r.replace(/\./g, ' ');               // . = element separator
    // Strip origin/dest ICAO codes at boundaries
    if (origin) {
        const oI = toIcao(origin);
        r = r.replace(new RegExp('^\\s*(' + origin + '|' + oI + ')\\s*'), '');
    }
    if (dest) {
        const dI = toIcao(dest);
        r = r.replace(new RegExp('\\s*(' + dest + '|' + dI + ')\\s*$'), '');
    }
    return r.replace(/\s+/g, ' ').trim() || 'DCT';
}

function buildIcaoFpl(d) {
    // Field 7: Aircraft identification
    const f7 = d.callsign || 'ZZZZ';

    // Field 8: Flight rules + type of flight (S=scheduled, N=non-scheduled, G=GA, M=military, X=other)
    const rules = d.flightRules ? d.flightRules.charAt(0).toUpperCase() : 'I';
    const ftypeMap = { SCHEDULED: 'S', NON_SCHEDULED: 'N', GENERAL: 'G', MILITARY: 'M', OTHER: 'X' };
    const ftype = d.flightType ? (ftypeMap[d.flightType] || 'N') : 'N';
    const f8 = rules + ftype;

    // Field 9: Type/Wake (FAA→ICAO wake: L→M, S→L)
    const acType = d.aircraftType || 'ZZZZ';
    const wakeMap = { J: 'J', H: 'H', L: 'M', S: 'L' };
    const wake = wakeMap[d.wakeCategory] || d.wakeCategory || 'M';
    const f9 = acType + '/' + wake;

    // Field 10: Equipment & Capabilities / Surveillance
    // 10a: COM/NAV equipment letters (concatenated, no spaces)
    let f10a = '';
    if (d.communicationCode) f10a += d.communicationCode.replace(/\s+/g, '');
    if (d.navigationCode) f10a += d.navigationCode.replace(/\s+/g, '');
    // J codes from dataLinkCode (J1-J7 = CPDLC capabilities, e.g. "J4 J5")
    if (d.dataLinkCode) {
        const jCodes = d.dataLinkCode.match(/J\d/g) || [];
        for (const jc of jCodes) { if (!f10a.includes(jc)) f10a += jc; }
    }
    if (!f10a) f10a = d.equipmentQualifier || 'S';
    // S = Standard (VOR, VHF, ILS) — always present for IFR aircraft
    if (!f10a.includes('S')) f10a = 'S' + f10a;

    // Build Field 18 PBN/NAV first so we can set R and Z in 10a
    let pbnStr = '', navStr = '';
    if (d.pbnCode) {
        // PBN/ allows up to 8 codes; additional PBN capabilities (Z1,Z2,Z5,R1,P1,M1,M2) overflow to NAV/
        const allCodes = d.pbnCode.replace(/\s+/g, '').match(/.{2}/g) || [];
        const additional = new Set(['Z1','Z2','Z5','R1','P1','M1','M2']);
        const pbnCodes = [], navCodes = [];
        for (const c of allCodes) {
            if (additional.has(c)) navCodes.push(c);
            else pbnCodes.push(c);
        }
        // If standard codes exceed 8, overflow to NAV/ too
        if (pbnCodes.length > 8) navCodes.push(...pbnCodes.splice(8));
        pbnCodes.sort();
        navCodes.sort();
        pbnStr = pbnCodes.join('');
        navStr = navCodes.join('');
    }
    const hasDAT = !!d.otherDataLink;
    const hasCOM = !!d.otherCommunicationCapabilities;
    const hasNAV = navStr.length > 0 || !!d.otherNavigationCapabilities;
    // R in 10a when filing PBN/ in Field 18
    if (pbnStr && !f10a.includes('R')) f10a += 'R';
    // Z in 10a when filing NAV/, COM/, or DAT/ in Field 18
    if ((hasDAT || hasCOM || hasNAV) && !f10a.includes('Z')) f10a += 'Z';
    // Sort alphabetically: S always first, then remaining tokens sorted
    // Tokens are letter+digit pairs (E3, J4, B1) or single letters (D, G, R, W, Z)
    {
        const tokens = f10a.match(/[A-Z]\d|[A-Z]/g) || [];
        const rest = tokens.filter(t => t !== 'S');
        rest.sort();
        f10a = 'S' + rest.join('');
    }

    // 10b: Surveillance equipment (concatenated, no spaces)
    const f10b = d.surveillanceCode ? d.surveillanceCode.replace(/\s+/g, '') : 'C';
    const f10 = f10a + '/' + f10b;

    // Field 13: Departure aerodrome + EOBT (estimated off-block time)
    const dep = toIcao(d.origin);
    let depTime = '0000';
    if (d.actualDepartureTime) {
        const dt = new Date(d.actualDepartureTime);
        depTime = String(dt.getUTCHours()).padStart(2, '0') +
                  String(dt.getUTCMinutes()).padStart(2, '0');
    }
    const f13 = dep + depTime;

    // Field 15: Cruising speed + level + route
    // Use filed airspeed (requestedSpeed) for ICAO FPL, not ground speed
    let speed = 'N0000';
    if (d.requestedSpeed) {
        speed = 'N' + String(Math.round(d.requestedSpeed)).padStart(4, '0');
    } else if (d.groundSpeed) {
        speed = 'N' + String(Math.round(d.groundSpeed)).padStart(4, '0');
    }
    let level = 'F000';
    if (d.assignedVfr) {
        level = 'VFR';
        if (d.assignedAltitude) level += '/' + String(Math.round(d.assignedAltitude / 100)).padStart(3, '0');
    } else if (d.blockFloor && d.blockCeiling) {
        level = 'F' + String(Math.round(d.blockFloor / 100)).padStart(3, '0') +
                'F' + String(Math.round(d.blockCeiling / 100)).padStart(3, '0');
    } else if (d.assignedAltitude) {
        if (d.assignedAltitude >= 18000) {
            level = 'F' + String(Math.round(d.assignedAltitude / 100)).padStart(3, '0');
        } else {
            level = 'A' + String(Math.round(d.assignedAltitude / 100)).padStart(3, '0');
        }
    }
    // Use original (filed) route for ICAO FPL, fall back to current
    const routeSource = d.originalRoute || d.route;
    const route = nasToIcaoRoute(routeSource, d.origin, d.destination);
    const f15 = speed + level + ' ' + route;

    // Field 16: Destination + ETE + alternate(s)
    const dest = toIcao(d.destination);
    let eet = '0000';
    if (d.eta && d.actualDepartureTime) {
        const diffMin = Math.round((new Date(d.eta) - new Date(d.actualDepartureTime)) / 60000);
        if (diffMin > 0 && diffMin < 6000) {
            eet = String(Math.floor(diffMin / 60)).padStart(2, '0') +
                  String(diffMin % 60).padStart(2, '0');
        }
    }
    // Alternate aerodrome(s) from SFDPS <arrivalAerodromeAlternate code="KMIA"/>
    let altnStr = '';
    if (d.alternateAerodrome) {
        altnStr = ' ' + d.alternateAerodrome.split(' ').map(a => toIcao(a)).join(' ');
    }
    const f16 = dest + eet + altnStr;

    // Field 18: Other information (per FAA FPL Quick Guide)
    const f18 = [];
    if (pbnStr) f18.push('PBN/' + pbnStr);
    // NAV/: PBN overflow codes + otherNavigationCapabilities from FIXM
    const navParts = [];
    if (navStr) navParts.push(navStr);
    if (d.otherNavigationCapabilities) navParts.push(d.otherNavigationCapabilities);
    if (navParts.length) f18.push('NAV/' + navParts.join(' '));
    if (d.otherCommunicationCapabilities) f18.push('COM/' + d.otherCommunicationCapabilities.trim());
    if (hasDAT) f18.push('DAT/' + d.otherDataLink.trim());
    // SUR/: from FIXM <surveillance otherSurveillanceCapabilities="...">
    // AAL Airbus flights file codes concatenated (260BC2I0 CANMANDATE) but SFDPS
    // spaces them out. Concatenate codes only for AAL+Airbus; keep raw for everyone else.
    if (d.otherSurveillanceCapabilities) {
        const isAalAirbus = /^AAL/.test(d.callsign || '') && /^A\d/.test(d.aircraftType || '');
        let sur = d.otherSurveillanceCapabilities.trim();
        if (isAalAirbus) {
            const surTokens = sur.split(/\s+/);
            sur = ''; let needSpace = false;
            for (const t of surTokens) {
                const isCode = /\d/.test(t);
                if (!isCode && sur) needSpace = true;
                if (needSpace) sur += ' ';
                sur += t;
                needSpace = !isCode;
            }
        }
        f18.push('SUR/' + sur);
    }
    // DOF: date of flight (YYMMDD)
    if (d.actualDepartureTime) {
        const dt = new Date(d.actualDepartureTime);
        const dof = String(dt.getUTCFullYear() % 100).padStart(2, '0') +
                    String(dt.getUTCMonth() + 1).padStart(2, '0') +
                    String(dt.getUTCDate()).padStart(2, '0');
        f18.push('DOF/' + dof);
    }
    if (d.registration) f18.push('REG/' + d.registration);
    // EET/: estimated elapsed times to FIR boundaries
    if (d.estimatedElapsedTimes) f18.push('EET/' + d.estimatedElapsedTimes);
    // OPR/: operating organization name from SFDPS <operator><organization name="...">
    if (d.operator) f18.push('OPR/' + d.operator);
    // ORGN/: originator AFTN address from SFDPS <originator><aftnAddress>
    if (d.originator) f18.push('ORGN/' + d.originator);
    if (d.selcal) f18.push('SEL/' + d.selcal);
    if (d.modeSCode) f18.push('CODE/' + d.modeSCode);
    if (d.aircraftPerformance) f18.push('PER/' + d.aircraftPerformance);
    if (d.remarks) f18.push('RMK/' + d.remarks.replace(/\|/g, '').trim());
    const f18str = f18.length > 0 ? f18.join(' ') : '0';

    // Format per FAA ICAO FPL Quick Guide
    return `(FPL-${f7}-${f8}\n-${f9}-${f10}\n-${f13}\n-${f15}\n-${f16}\n-${f18str})`;
}

function buildSimBriefUrl(d) {
    const p = new URLSearchParams();
    // 3-letter ICAO airline + alphanumeric fltnum (AAL123, BAW12AB)
    // Otherwise everything goes into fltnum (N123AB, BLOCKED, etc.)
    const cs = d.callsign || '';
    const csMatch = cs.match(/^([A-Z]{3})([A-Z0-9]+)$/);
    if (csMatch) {
        p.set('airline', csMatch[1]);
        p.set('fltnum', csMatch[2]);
    } else if (cs) {
        p.set('fltnum', cs);
    }
    if (cs) p.set('callsign', cs);
    // Aircraft
    if (d.aircraftType) p.set('type', d.aircraftType);
    // Airports (already ICAO in SFDPS)
    if (d.origin) p.set('orig', d.origin);
    if (d.destination) p.set('dest', d.destination);
    if (d.alternateAerodrome) {
        const altns = d.alternateAerodrome.split(' ').filter(Boolean);
        if (altns[0]) p.set('altn', altns[0]);
    }
    // Route (NAS → ICAO cleaned)
    const routeSource = d.originalRoute || d.route;
    if (routeSource) {
        const r = nasToIcaoRoute(routeSource, d.origin, d.destination);
        if (r && r !== 'DCT') p.set('route', r);
    }
    // Altitude
    if (d.assignedAltitude && !d.assignedVfr) {
        p.set('fl', String(Math.round(d.assignedAltitude / 100)));
    }
    if (d.assignedVfr) p.set('flightrules', 'v');
    // Registration & Mode S
    if (d.registration) p.set('reg', d.registration);
    if (d.modeSCode) p.set('hexcode', d.modeSCode);
    // Equipment (acdata JSON for equip/transponder/pbn/extrarmk)
    const acdata = {};
    const wakeMap = { J: 'J', H: 'H', L: 'M', S: 'L' };
    if (d.wakeCategory) acdata.cat = wakeMap[d.wakeCategory] || d.wakeCategory;
    // Build equipment and transponder strings from ICAO FPL fields
    let equip = '';
    if (d.communicationCode) equip += d.communicationCode.replace(/\s+/g, '');
    if (d.navigationCode) equip += d.navigationCode.replace(/\s+/g, '');
    if (d.dataLinkCode) {
        const jCodes = d.dataLinkCode.match(/J\d/g) || [];
        for (const jc of jCodes) { if (!equip.includes(jc)) equip += jc; }
    }
    if (!equip) equip = d.equipmentQualifier || 'S';
    if (!equip.includes('S')) equip = 'S' + equip;
    acdata.equip = equip;
    if (d.surveillanceCode) acdata.transponder = d.surveillanceCode.replace(/\s+/g, '');
    if (d.pbnCode) acdata.pbn = 'PBN/' + d.pbnCode.replace(/\s+/g, '');
    // Extra remarks (DAT, SUR, etc.)
    const extra = [];
    if (d.otherCommunicationCapabilities) extra.push('COM/' + d.otherCommunicationCapabilities.trim());
    if (d.otherDataLink) extra.push('DAT/' + d.otherDataLink.trim());
    if (d.otherSurveillanceCapabilities) extra.push('SUR/' + d.otherSurveillanceCapabilities.trim());
    if (extra.length) acdata.extrarmk = extra.join(' ');
    if (Object.keys(acdata).length) p.set('acdata', JSON.stringify(acdata));
    // Remarks (Field 18 RMK/ → extrarmk, not dispatch remarks)
    if (d.remarks) p.set('extrarmk', 'RMK/' + d.remarks.replace(/\|/g, '').trim());
    p.set('units', 'LBS');
    return 'https://dispatch.simbrief.com/options/custom?' + p.toString();
}

function toggleIcaoFpl() {
    showIcao = !showIcao;
    renderActiveTab();
}

function copyIcaoFpl(ev) {
    ev.stopPropagation();
    navigator.clipboard.writeText(lastIcaoText).then(() => {
        ev.target.textContent = 'COPIED';
        setTimeout(() => { ev.target.textContent = 'COPY'; }, 1500);
    });
}

function renderFlightPlan(d) {
    const routeHtml = d.route
        ? `<div class="section"><h3>ROUTE</h3><div class="route-text">${esc(d.route)}</div></div>`
        : '';
    const purgeBanner = d._purged
        ? '<div class="purge-banner">PURGED FROM SERVER &mdash; SHOWING LAST KNOWN DATA</div>'
        : '';

    // ICAO FPL toggle
    lastIcaoText = buildIcaoFpl(d);
    const icaoHtml = showIcao
        ? `<div class="icao-block"><button class="icao-copy" onclick="copyIcaoFpl(event)">COPY</button>${esc(lastIcaoText).replace(/\n/g, '<br>')}</div>`
        : '';
    const icaoBtn = `<button class="icao-btn" onclick="toggleIcaoFpl()">${showIcao ? 'HIDE ICAO FPL' : 'ICAO FPL'}</button>`;
    const sbUrl = buildSimBriefUrl(d);
    const sbBtn = `<a class="icao-btn simbrief-btn" href="${esc(sbUrl)}" target="_blank" rel="noopener">SIMBRIEF</a>`;
    const vatUrl = 'https://my.vatsim.net/pilots/flightplan?raw=' + encodeURIComponent(lastIcaoText);
    const vatBtn = `<a class="icao-btn simbrief-btn" href="${esc(vatUrl)}" target="_blank" rel="noopener">VATSIM</a>`;

    return `${purgeBanner}${icaoBtn}${sbBtn}${vatBtn}${icaoHtml}
        ${section('Identity', [
            ['Callsign', d.callsign],
            ['Aircraft Type', d.aircraftType],
            ['Registration', d.registration],
            ['Wake Category', d.wakeCategory],
            ['Mode S', d.modeSCode],
            ['Equipment', d.equipmentQualifier],
            ['CID', fmtCids(d)],
            ['GUFI', d.gufi],
        ])}
        ${section('Flight Plan', [
            ['Origin', d.origin],
            ['Destination', d.destination],
            ['Flight Rules', d.flightRules],
            ['STAR', d.star],
            ['Remarks', d.remarks, d.remarks ? 'warn' : ''],
        ])}
        ${routeHtml}
        ${d.originalRoute && d.originalRoute !== d.route
            ? `<div class="section"><h3>ORIGINAL ROUTE</h3><div class="route-text">${esc(d.originalRoute)}</div></div>`
            : ''}
        ${section('Altitude', [
            ['Assigned', d.assignedAltitude ? fmtAltDetail(d) : null, 'hl'],
            ['Interim', d.interimAltitude ? `FL${Math.round(d.interimAltitude / 100)} (${Math.round(d.interimAltitude)} ft)` : null, 'warn'],
            ['Reported', d.reportedAltitude ? `FL${Math.round(d.reportedAltitude / 100)}` : null],
        ])}
        ${section('Position', [
            ['Latitude', d.latitude?.toFixed(4)],
            ['Longitude', d.longitude?.toFixed(4)],
            ['Ground Speed', d.groundSpeed ? Math.round(d.groundSpeed) + ' kt' : null],
        ])}
        ${section('Ownership', [
            ['Reporting', d.reportingFacility, 'accent'],
            ['Controlling', d.controllingFacility ? d.controllingFacility + (d.controllingSector ? '/' + d.controllingSector : '') : null, 'accent'],
            ['Handoff', d.handoffEvent ? `${d.handoffEvent}: ${d.handoffTransferring || '?'} \u2192 ${d.handoffReceiving || '?'}` : null, 'accent'],
            ['Accepting', d.handoffAccepting],
            ['Point-out', d.pointoutOriginatingUnit ? `${d.pointoutOriginatingUnit} \u2192 ${d.pointoutReceivingUnit || '?'}` : null],
        ])}
        ${section('Beacon', [
            ['Squawk', d.squawk],
            ['Assigned Sqk', d.assignedSquawk],
        ])}
        ${section('Clearance', [
            ['Heading', d.clearanceHeading],
            ['Speed', d.clearanceSpeed],
            ['Text', d.clearanceText],
        ])}
        ${section('Datalink', [
            ['Data Link', d.dataLinkCode, d.dataLinkCode?.includes('J') ? 'accent' : ''],
            ['Other DL', d.otherDataLink],
            ['Other Comm', d.otherCommunicationCapabilities],
            ['Comm Code', d.communicationCode],
            ['SELCAL', d.selcal],
        ])}
        ${section('Times', [
            ['Dep Time', d.actualDepartureTime ? fmtTime(d.actualDepartureTime) : null],
            ['ETA', d.eta ? fmtTime(d.eta) : null],
            ['Coord Time', d.coordinationTime ? fmtTime(d.coordinationTime) : null],
            ['Coord Fix', d.coordinationFix],
        ])}
        ${section('TMI / Navigation', [
            ['TMI IDs', d.tmiIds],
            ['Nav Code', d.navigationCode],
            ['PBN Code', d.pbnCode],
            ['Surveillance', d.surveillanceCode],
        ])}
    `;
}

function renderEventLog(d) {
    if (!d.events || d.events.length === 0) {
        return '<div class="loading">No events recorded</div>';
    }

    // Show all events newest first, but group consecutive TH/HZ runs
    const events = d.events.slice().reverse();
    const html = [];
    let i = 0;
    while (i < events.length) {
        const e = events[i];
        if (e.source === 'TH' || e.source === 'HZ') {
            // Count consecutive TH/HZ
            let count = 0;
            while (i < events.length && (events[i].source === 'TH' || events[i].source === 'HZ')) {
                count++;
                i++;
            }
            html.push(`<div class="th-group" data-thgroup="1">\u2022\u2022\u2022 ${count} position update${count > 1 ? 's' : ''} \u2022\u2022\u2022</div>`);
        } else {
            const srcLc = (e.source || '').toLowerCase();
            const xmlInd = e.hasXml ? 'has-xml' : '';
            const idx = e.index;
            const isExpanded = expandedEvents.has(idx);
            const xmlKey = `${d.gufi}:${idx}`;
            const xmlHtml = isExpanded && xmlCache[xmlKey] !== undefined
                ? `<div class="xml-block open"><button class="xml-copy-btn" onclick="copyXml(event,'${xmlKey}')">Copy</button>${highlightXml(xmlCache[xmlKey])}</div>`
                : isExpanded
                ? `<div class="xml-block open"><span class="loading">Loading XML...</span></div>`
                : '';
            html.push(`<div class="event-row" data-idx="${idx}" data-hasxml="${e.hasXml ? '1' : '0'}">
                <div class="ev-line">
                    <span class="ev-time">${fmtTime(e.time)}</span>
                    <span class="ev-src ${srcLc}">${e.source}</span>
                    <span class="ev-centre">${e.centre}</span>
                    <span class="ev-summary">${esc(e.summary)}</span>
                    <span class="ev-xml-indicator ${xmlInd}">${e.hasXml ? 'XML' : ''}</span>
                </div>
                ${xmlHtml}
            </div>`);
            i++;
        }
    }

    return html.join('');
}

function attachEventHandlers() {
    detailBody.querySelectorAll('.event-row[data-idx]').forEach(el => {
        el.addEventListener('click', () => toggleEventXml(el));
    });
}

async function toggleEventXml(el) {
    const idx = parseInt(el.dataset.idx);
    const hasXml = el.dataset.hasxml === '1';
    if (!hasXml) return;

    if (expandedEvents.has(idx)) {
        expandedEvents.delete(idx);
    } else {
        expandedEvents.add(idx);
        // Fetch XML if not cached
        const key = `${selectedGufi}:${idx}`;
        if (xmlCache[key] === undefined) {
            xmlCache[key] = null; // mark as loading
            try {
                const resp = await fetch(`/api/event-xml/${idx}/${encodeURIComponent(selectedGufi)}`);
                if (resp.ok) {
                    const data = await resp.json();
                    xmlCache[key] = data.xml || '(no XML available)';
                } else {
                    xmlCache[key] = '(failed to load)';
                }
            } catch {
                xmlCache[key] = '(failed to load)';
            }
        }
    }
    // Re-render events tab
    renderActiveTab();
}

function copyXml(ev, key) {
    ev.stopPropagation();
    const xml = xmlCache[key];
    if (!xml) return;
    navigator.clipboard.writeText(xml).then(() => {
        const btn = ev.target;
        btn.textContent = 'Copied';
        setTimeout(() => btn.textContent = 'Copy', 1500);
    });
}

function highlightXml(xml) {
    if (!xml) return '<span class="xml-text">(no XML)</span>';
    // Simple XML syntax highlighting
    return esc(xml)
        .replace(/(&lt;\/?[\w:.-]+)/g, '<span class="xml-tag">$1</span>')
        .replace(/(&gt;)/g, '<span class="xml-tag">$1</span>')
        .replace(/([\w:-]+)=(&quot;[^&]*&quot;)/g, '<span class="xml-attr">$1</span>=<span class="xml-val">$2</span>')
        .replace(/([\w:-]+)=(&apos;[^&]*&apos;)/g, '<span class="xml-attr">$1</span>=<span class="xml-val">$2</span>');
}

function section(title, fields) {
    const rows = fields.filter(f => f[1] != null && f[1] !== '');
    if (rows.length === 0) return '';
    return `<div class="section"><h3>${title}</h3><div class="field-grid">
        ${rows.map(([label, value, cls]) =>
            `<span class="field-label">${label}</span><span class="field-value${cls ? ' ' + cls : ''}">${esc(String(value))}</span>`
        ).join('')}
    </div></div>`;
}

function fmtCids(d) {
    if (d.computerIds && Object.keys(d.computerIds).length > 0) {
        return Object.entries(d.computerIds).map(([fac, cid]) => `${fac}/${cid}`).join('  ');
    }
    return d.computerId || null;
}

function fmtAltDetail(d) {
    if (d.assignedVfr) {
        if (d.assignedAltitude) return `VFR/${Math.round(d.assignedAltitude / 100)}`;
        return 'VFR';
    }
    if (d.blockFloor && d.blockCeiling)
        return `${Math.round(d.blockFloor / 100)}B${Math.round(d.blockCeiling / 100)}`;
    if (d.assignedAltitude) {
        const ft = Math.round(d.assignedAltitude);
        return d.assignedAltitude >= 18000 ? `FL${Math.round(ft / 100)} (${ft} ft)` : `${ft} ft`;
    }
    return '';
}

// ── Helpers ──────────────────────────────────────────────────
function fmtTime(iso) {
    if (!iso) return '';
    try {
        const d = new Date(iso);
        return d.toISOString().substring(11, 19) + 'Z';
    } catch { return iso; }
}

function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// ── Tabs ─────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
        activeTab = tab.dataset.tab;
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        renderActiveTab();
    });
});

// ── Close detail ─────────────────────────────────────────────
document.getElementById('detailClose').addEventListener('click', closeDetail);

// ── Sort ─────────────────────────────────────────────────────
document.getElementById('colHeader').addEventListener('click', (e) => {
    const col = e.target.dataset?.col;
    if (!col) return;
    if (sortCol === col) sortAsc = !sortAsc;
    else { sortCol = col; sortAsc = true; }
    document.querySelectorAll('.col-header span').forEach(s => s.classList.remove('sorted'));
    e.target.classList.add('sorted');
    scheduleRender();
});

// ── Historical flight search ─────────────────────────────────
// On-disk JSONL history (flight-history/YYYY-MM-DD.jsonl) is queried by the
// /api/history endpoint. We load matching records into allFlights with
// _historical=true so they appear alongside live flights.
let historyDates = [];
const historyLoaded = new Set();  // `${term}:${date}` keys, to avoid duplicate fetches
const HIST_MAX_DATES = 7;          // search at most this many recent dates per query

async function loadHistoryDates() {
    try {
        const r = await fetch('/api/history/dates');
        if (!r.ok) return;
        const arr = await r.json();
        historyDates = arr.map(d => d.date).slice(0, HIST_MAX_DATES);
    } catch {}
}
loadHistoryDates();

async function searchHistory(query) {
    if (query.length < 2 || historyDates.length === 0) return;
    // If the dropdown selected a specific field and the user didn't already type
    // a field:value clause, scope the history query to that field.
    let apiQuery = query;
    if (searchField !== 'all' && !query.includes(':')) {
        const fieldKey = (searchField === 'airport') ? 'origin' : searchField;
        apiQuery = `${fieldKey}:${query}`;
        // For 'airport' we'd ideally OR origin/destination — backend doesn't support OR yet,
        // so we accept origin-only; user can type dest:KORD explicitly for arrival queries.
    }
    const cacheKey = apiQuery;
    const dates = historyDates.filter(d => !historyLoaded.has(`${cacheKey}:${d}`));
    if (dates.length === 0) return;
    const fetches = dates.map(d => {
        historyLoaded.add(`${cacheKey}:${d}`);
        return fetch(`/api/history?q=${encodeURIComponent(apiQuery)}&date=${d}`)
            .then(r => r.ok ? r.json() : [])
            .catch(() => []);
    });
    const results = await Promise.all(fetches);
    let added = 0;
    for (const dayResults of results) {
        if (!Array.isArray(dayResults)) continue;
        for (const f of dayResults) {
            if (!f.gufi) continue;
            // Don't overwrite a live flight with a historical record
            const existing = allFlights.get(f.gufi);
            if (existing && !existing._historical) continue;
            f._historical = true;
            f._removedAt = f.lastSeen ? new Date(f.lastSeen).getTime() : 0;
            f._histBytes = JSON.stringify(f).length;
            if (!existing) historicalBytes += f._histBytes;
            allFlights.set(f.gufi, f);
            noteFacility(f);
            added++;
        }
    }
    if (added) {
        trimHistorical();
        scheduleRender();
    }
}

// ── Filter events ────────────────────────────────────────────
const searchFieldEl = document.getElementById('searchField');
let searchTimeout;
searchEl.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
        searchTerm = searchEl.value.trim();
        if (searchTerm.length >= 2) searchHistory(searchTerm.toUpperCase());
        // Invalidate the parsed-clauses cache when query changes
        matchesSearch._lastQ = null;
        scheduleRender();
    }, 200);
});
if (searchFieldEl) {
    searchFieldEl.addEventListener('change', () => {
        searchField = searchFieldEl.value;
        // Force re-parse since DEFAULT fields changed
        matchesSearch._lastQ = null;
        // Re-fetch history with the new scope if there's a search term
        if (searchTerm.length >= 2) searchHistory(searchTerm.toUpperCase());
        scheduleRender();
    });
}
filterStatus.addEventListener('change', scheduleRender);
filterFacility.addEventListener('change', scheduleRender);
filterRules.addEventListener('change', scheduleRender);

// ── Pin / unpin (server-side, persists across users + restarts) ─
// Map gufi → { pinned, pinnedAt, unpinnedAt, callsign, origin, destination }
const pinRecords = new Map();

async function loadPinState() {
    try {
        const r = await fetch('/api/history/pins');
        if (!r.ok) return;
        const obj = await r.json();
        pinRecords.clear();
        for (const [gufi, rec] of Object.entries(obj)) pinRecords.set(gufi, rec);
        // Also fetch full pinned-flight records and merge into table
        const pr = await fetch('/api/history/pinned');
        if (pr.ok) {
            const pinnedFlights = await pr.json();
            if (Array.isArray(pinnedFlights)) {
                for (const f of pinnedFlights) {
                    if (!f.gufi) continue;
                    const existing = allFlights.get(f.gufi);
                    if (existing && !existing._historical) continue;  // live wins
                    f._historical = true;
                    f._pinned = true;
                    f._removedAt = f.lastSeen ? new Date(f.lastSeen).getTime() : 0;
                    f._histBytes = JSON.stringify(f).length;
                    if (!existing) historicalBytes += f._histBytes;
                    allFlights.set(f.gufi, f);
                    noteFacility(f);
                }
                trimHistorical();
            }
        }
        scheduleRender();
    } catch (e) { console.error('loadPinState failed', e); }
}
// Refresh pin state every 60s so multiple users stay in sync
setInterval(loadPinState, 60000);
loadPinState();

function showConfirm(title, body, onConfirm, dangerLabel) {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
        <div class="confirm-box">
            <h3>${title}</h3>
            <div>${body}</div>
            <div class="actions">
                <button data-action="cancel">Cancel</button>
                <button data-action="confirm" class="danger">${dangerLabel || 'Confirm'}</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) document.body.removeChild(overlay);
        if (e.target.dataset?.action === 'cancel') document.body.removeChild(overlay);
        if (e.target.dataset?.action === 'confirm') {
            document.body.removeChild(overlay);
            onConfirm();
        }
    });
}

async function handlePinClick(gufi) {
    const existing = pinRecords.get(gufi);
    const isPinnedActive = existing && existing.pinned;
    const flight = allFlights.get(gufi);

    if (isPinnedActive) {
        // Unpin → confirm
        const cs = flight?.callsign || existing.callsign || gufi.slice(0, 8);
        showConfirm(
            'Unpin flight?',
            `<b>${cs}</b> will no longer be protected from automatic history cleanup. ` +
            `It will be kept for at least <b>24 hours</b>, and up to 4 days if disk space allows. ` +
            `After that it may be removed.`,
            async () => {
                try {
                    const r = await fetch('/api/history/unpin', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ gufi })
                    });
                    if (r.ok) {
                        existing.pinned = false;
                        existing.unpinnedAt = new Date().toISOString();
                        scheduleRender();
                    }
                } catch (e) { console.error('unpin failed', e); }
            },
            'Unpin'
        );
        return;
    }

    // Pin (or re-pin if in grace period)
    const body = { gufi };
    if (flight) body.record = flight;
    try {
        const r = await fetch('/api/history/pin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        if (r.ok) {
            pinRecords.set(gufi, {
                pinned: true,
                pinnedAt: new Date().toISOString(),
                callsign: flight?.callsign,
                origin: flight?.origin,
                destination: flight?.destination
            });
            scheduleRender();
        } else {
            const err = await r.json().catch(() => ({}));
            alert('Pin failed: ' + (err.error || r.status));
        }
    } catch (e) { console.error('pin failed', e); alert('Pin failed: ' + e.message); }
}

// ── CSV export ────────────────────────────────────────────────
const exportBtn = document.getElementById('exportCsv');
if (exportBtn) {
    exportBtn.addEventListener('click', () => {
        // Re-run the same filter as render() to get visible rows
        const fStatus = filterStatus.value;
        const fFacility = filterFacility.value;
        const fRules = filterRules.value;
        const q = searchTerm.toUpperCase();

        const rows = [];
        for (const f of allFlights.values()) {
            if (fStatus === 'historical' && !f._historical) continue;
            if (fStatus === 'active' && (f.flightStatus !== 'ACTIVE' || f._historical)) continue;
            if (fStatus === 'dropped' && (f.flightStatus !== 'DROPPED' || f._historical)) continue;
            if (fFacility && f.reportingFacility !== fFacility) continue;
            if (fRules && f.flightRules !== fRules) continue;
            if (q && !matchesSearch(f, q)) continue;
            rows.push(f);
        }

        const cols = [
            'gufi','callsign','aircraftType','origin','destination','assignedAltitude',
            'interimAltitude','flightRules','flightType','controllingFacility','controllingSector',
            'squawk','assignedSquawk','dataLinkCode','flightStatus','registration','wakeCategory',
            'route','star','remarks','clearanceHeading','clearanceSpeed','clearanceText',
            'reportingFacility','operator','originator','equipmentQualifier','tmiIds',
            'latitude','longitude','groundSpeed','lastSeen','lastMsgSource'
        ];
        const esc = v => {
            if (v === null || v === undefined) return '';
            const s = String(v);
            if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
            return s;
        };
        const lines = [
            ['#pinned', ...cols].join(','),  // first column is pinned flag
            ...rows.map(f => [
                pinRecords.get(f.gufi)?.pinned ? '1' : '',
                ...cols.map(c => esc(f[c]))
            ].join(','))
        ];
        const csv = lines.join('\r\n');
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `flights-${stamp}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    });
}

// ── Auto-refresh selected flight every 3s ────────────────────
const _fdioDetailRefresh = () => { if (selectedGufi && !(currentDetail && currentDetail._purged)) fetch(`/api/flights/${encodeURIComponent(selectedGufi)}`).then(r => r.ok ? r.json() : null).then(d => { if (d) { currentDetail = d; currentDetail._purged = false; renderDetailHeader(d); renderActiveTab(); } }).catch(() => {}); };
let _fdioDetailTimer = setInterval(_fdioDetailRefresh, 3000);

window.idleOnPause = () => { if (ws) { ws.onclose = null; ws.close(); ws = null; } clearInterval(_fdioDetailTimer); };
window.idleOnResume = () => { connect(); _fdioDetailTimer = setInterval(_fdioDetailRefresh, 3000); };

// ── Init ─────────────────────────────────────────────────────
connect();
