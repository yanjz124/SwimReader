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
    const sign = m < 0 ? '-' : '+';
    return sign + Math.abs(m);
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
        if (statusMode === 'pending' && f.departed) return false;
        if (statusMode === 'departed' && !f.departed) return false;
        if (statusMode === 'upcoming30' &&
            !(f.minutesUntil != null && !f.departed && f.minutesUntil >= 0 && f.minutesUntil <= 30))
            return false;
        if (statusMode === 'overdue' &&
            !(f.minutesUntil != null && !f.departed && f.minutesUntil < 0))
            return false;
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
    countEl.textContent = `${list.length} of ${allFlights.length}`;
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
        const cls = [];
        if (f.departed) cls.push('departed');
        else if (f.minutesUntil != null && f.minutesUntil < 0) cls.push('overdue');
        else if (f.minutesUntil != null && f.minutesUntil <= 30) cls.push('upcoming');
        const sector = f.controllingFacility
            ? f.controllingFacility + (f.controllingSector ? '/' + f.controllingSector : '')
            : '';
        return `<tr class="${cls.join(' ')}">
            <td class="col-cs"><a href="/eram#facility=${f.controllingFacility || ''}&search=${f.callsign || ''}" style="color:inherit;text-decoration:none;">${f.callsign || ''}</a></td>
            <td class="col-tp">${f.aircraftType || ''}</td>
            <td class="col-ap">${f.origin || ''}</td>
            <td class="col-ap">${f.destination || ''}</td>
            <td class="col-tm">${fmtTime(f.edct)}</td>
            <td class="col-tu">${fmtMinutes(f.minutesUntil)}</td>
            <td class="col-tm">${fmtTime(f.actualDeparture)}</td>
            <td class="col-tm">${fmtTime(f.eta)}</td>
            <td class="col-fac">${sector}</td>
            <td class="col-st">${f.flightStatus || ''}</td>
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
