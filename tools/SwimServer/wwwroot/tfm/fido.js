const $ = (id) => document.getElementById(id);
const rowsEl = $('rows'), emptyEl = $('empty'), countEl = $('count'), updatedEl = $('updated');
const searchEl = $('searchInput'), statusEl = $('statusFilter'),
      depEl = $('depInput'), arrEl = $('arrInput'), sortEl = $('sortBy');
const dlg = $('detailDialog'), detailBody = $('detailBody'), closeBtn = $('closeDetail');

let allFlights = [];

function fmtTime(iso) {
    if (!iso) return '';
    try { return new Date(iso).toISOString().slice(11, 16) + 'Z'; } catch { return ''; }
}
function fmtAlt(a) {
    if (a == null) return '';
    return a > 18000 ? 'FL' + Math.round(a / 100).toString().padStart(3, '0')
                     : Math.round(a).toLocaleString();
}
function esc(s) {
    return (s ?? '').toString()
        .replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
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
                         f.acType, f.acModel, f.facility, f.route, f.star, f.beaconCode]
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
    const html = list.map(f => {
        const cls = (f.status || '').toLowerCase();
        return `<tr class="${cls}" data-ref="${esc(f.flightRef)}">
            <td class="col-cs">${esc(f.callsign || '')}</td>
            <td class="col-status">${esc(f.status || '')}</td>
            <td>${esc(f.acType || '')}</td>
            <td class="col-ap">${esc(f.depArpt || '')}</td>
            <td class="col-ap">${esc(f.arrArpt || '')}</td>
            <td class="col-tm">${fmtTime(f.igtd)}</td>
            <td class="col-tm">${fmtTime(f.etd)}</td>
            <td class="col-tm">${fmtTime(f.runwayDeparture)}</td>
            <td class="col-tm">${fmtTime(f.eta)}</td>
            <td>${fmtAlt(f.altitude || f.assignedAlt)}</td>
            <td>${f.speed || ''}</td>
            <td>${esc(f.beaconCode || '')}</td>
            <td>${esc(f.star || '')}</td>
            <td>${esc(f.facility || '')}${f.cid ? '/' + esc(f.cid) : ''}</td>
            <td style="color:#666">${esc(f.sourceFacility || '')}</td>
        </tr>`;
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
        if (!resp.ok) return;
        const f = await resp.json();
        const fields = Object.entries(f)
            .filter(([k, v]) => v !== null && v !== undefined && v !== ''
                && typeof v !== 'object')
            .map(([k, v]) => `<div class="field"><span class="label">${esc(k)}</span><span class="value">${esc(v)}</span></div>`)
            .join('');
        detailBody.innerHTML = `<h2>${esc(f.callsign || ref)}</h2>${fields}`;
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
    } catch (e) {
        countEl.textContent = 'error';
    }
}

searchEl.addEventListener('input', applyFilters);
statusEl.addEventListener('change', applyFilters);
depEl.addEventListener('input', applyFilters);
arrEl.addEventListener('input', applyFilters);
sortEl.addEventListener('change', applyFilters);

refresh();
setInterval(refresh, 15000);
