// EDCT page — fetches /api/edct and renders a searchable, sortable table.
const $ = (id) => document.getElementById(id);
const rowsEl = $('rows'), emptyEl = $('empty');
const searchEl = $('searchInput'), originEl = $('originFilter'),
      destEl = $('destFilter'), statusEl = $('statusFilter'), sortEl = $('sortBy');
const countEl = $('count'), updatedEl = $('updated');

let allFlights = [];

function fmtTime(iso) {
    if (!iso) return '';
    try { return new Date(iso).toISOString().slice(11, 16) + 'Z'; } catch { return iso; }
}
function fmtMinutes(m) {
    if (m == null) return '';
    if (m === 0) return '0';
    // minutesUntil is (edct - now): positive = still ahead of EDCT, negative = past EDCT.
    // Show as a signed countdown, e.g. "−12" (past) / "+45" (ahead).
    const sign = m < 0 ? '−' : '+';
    return sign + Math.abs(m);
}

// Derive a clear operational status from the raw flight state. Key semantic fix:
// a flight that is ACTIVE (airborne) is NOT "overdue" even if it's past its EDCT —
// many foreign departures never report an actualDeparture time, so we can't rely on
// the server's `departed` flag alone. Only flights still on the ground get the
// countdown-based overdue/soon treatment.
function deriveStatus(f) {
    const st = f.flightStatus;
    if (st === 'CANCELLED') return { key: 'cancelled', label: 'CANCELLED', onGround: false };
    if (st === 'ACTIVE' || f.departed)
        return { key: 'airborne', label: f.departed ? 'DEPARTED' : 'AIRBORNE', onGround: false };
    if (st === 'DROPPED') return { key: 'dropped', label: 'DROPPED', onGround: false };
    // Otherwise it's on the ground (PROPOSED) awaiting its EDCT.
    const m = f.minutesUntil;
    if (m == null) return { key: 'pending', label: 'PENDING', onGround: true };
    if (m < 0)  return { key: 'overdue', label: 'OVERDUE', onGround: true };
    if (m <= 30) return { key: 'soon', label: 'SOON', onGround: true };
    return { key: 'pending', label: 'PENDING', onGround: true };
}
function uniqueSorted(arr) { return [...new Set(arr.filter(Boolean))].sort(); }

function refreshFilterOptions() {
    const origins = uniqueSorted(allFlights.map(f => f.origin));
    const dests = uniqueSorted(allFlights.map(f => f.destination));
    fillSelect(originEl, origins);
    fillSelect(destEl, dests);
}
function fillSelect(el, items) {
    const cur = el.value;
    el.innerHTML = '<option value="">ALL</option>' +
        items.map(v => `<option value="${v}">${v}</option>`).join('');
    if (items.includes(cur)) el.value = cur;
}

function applyFilters() {
    const q = searchEl.value.trim().toUpperCase();
    const origin = originEl.value;
    const dest = destEl.value;
    const statusMode = statusEl.value;
    const sortKey = sortEl.value;

    let filtered = allFlights.filter(f => {
        if (origin && f.origin !== origin) return false;
        if (dest && f.destination !== dest) return false;
        if (q) {
            const hay = [f.callsign, f.origin, f.destination, f.aircraftType,
                         f.controllingFacility, f.controllingSector, f.route]
                        .filter(Boolean).join(' ').toUpperCase();
            if (!hay.includes(q)) return false;
        }
        if (statusMode !== 'all') {
            const s = deriveStatus(f);
            if (statusMode === 'ground' && !s.onGround) return false;
            if (statusMode === 'soon' && s.key !== 'soon') return false;
            if (statusMode === 'overdue' && s.key !== 'overdue') return false;
            if (statusMode === 'airborne' && s.key !== 'airborne') return false;
        }
        return true;
    });

    filtered.sort((a, b) => {
        switch (sortKey) {
            case 'callsign': return (a.callsign || '').localeCompare(b.callsign || '');
            case 'origin': return (a.origin || '').localeCompare(b.origin || '');
            case 'dest': return (a.destination || '').localeCompare(b.destination || '');
            case 'delay': return (a.minutesUntil ?? 9999) - (b.minutesUntil ?? 9999);
            case 'edct':
            default: return (a.edct || '').localeCompare(b.edct || '');
        }
    });

    render(filtered);
}

function render(list) {
    let ground = 0, overdue = 0, soon = 0;
    for (const f of allFlights) {
        const k = deriveStatus(f);
        if (k.onGround) ground++;
        if (k.key === 'overdue') overdue++;
        if (k.key === 'soon') soon++;
    }
    countEl.innerHTML = `${list.length}/${allFlights.length}`
        + ` &nbsp;·&nbsp; ${ground} on ground`
        + (soon ? ` &nbsp;·&nbsp; <span style="color:#ffb454">${soon} soon</span>` : '')
        + (overdue ? ` &nbsp;·&nbsp; <span style="color:#ff6b6b">${overdue} overdue</span>` : '');
    if (list.length === 0) {
        rowsEl.innerHTML = '';
        emptyEl.style.display = '';
        emptyEl.textContent = allFlights.length === 0
            ? 'No flights with EDCT assignments. EDCTs appear during Ground Delay Programs, CTOPs, and Ground Stops.'
            : 'No flights match the current filters.';
        return;
    }
    emptyEl.style.display = 'none';
    const html = list.map(f => {
        const s = deriveStatus(f);
        const sector = f.controllingFacility
            ? f.controllingFacility + (f.controllingSector ? '/' + f.controllingSector : '')
            : '';
        // Countdown only means something for flights still on the ground.
        const inCell = s.onGround ? fmtMinutes(f.minutesUntil) : '·';
        return `<tr class="st-${s.key}">
            <td class="col-cs"><a href="/eram#facility=${f.controllingFacility || ''}&search=${f.callsign || ''}">${f.callsign || ''}</a></td>
            <td class="col-tp">${f.aircraftType || ''}</td>
            <td class="col-ap">${f.origin || ''}</td>
            <td class="col-arw">▸</td>
            <td class="col-ap">${f.destination || ''}</td>
            <td class="col-tm col-edct">${fmtTime(f.edct)}</td>
            <td class="col-tu">${inCell}</td>
            <td class="col-tm col-off">${fmtTime(f.actualDeparture) || '·'}</td>
            <td class="col-tm col-eta">${fmtTime(f.eta) || '·'}</td>
            <td class="col-fac">${sector || '·'}</td>
            <td class="col-st"><span class="chip ${s.key}">${s.label}</span></td>
        </tr>`;
    }).join('');
    rowsEl.innerHTML = html;
}

async function refresh() {
    try {
        const resp = await fetch('/api/edct');
        const data = await resp.json();
        allFlights = data.flights || [];
        refreshFilterOptions();
        applyFilters();
        const now = new Date();
        updatedEl.textContent = 'updated ' + now.toISOString().slice(11, 19) + 'Z';
    } catch (e) {
        countEl.textContent = 'error';
        console.error(e);
    }
}

searchEl.addEventListener('input', applyFilters);
originEl.addEventListener('change', applyFilters);
destEl.addEventListener('change', applyFilters);
statusEl.addEventListener('change', applyFilters);
sortEl.addEventListener('change', applyFilters);

refresh();
setInterval(refresh, 15000);
