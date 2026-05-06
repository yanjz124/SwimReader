const $ = (id) => document.getElementById(id);
const rowsEl = $('rows'), emptyEl = $('empty'), countEl = $('count'), updatedEl = $('updated');
const searchEl = $('searchInput'), wxEl = $('wxFilter'), facEl = $('facFilter');
const headers = document.querySelectorAll('th.sortable');

let allConfigs = [];
let sortKey = 'airport';
let sortAsc = true;

const esc = (s) => (s ?? '').toString()
    .replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const fmtAge = (s) => {
    if (s == null) return '';
    if (s < 60) return s + 's';
    if (s < 3600) return Math.round(s / 60) + 'm';
    return (s / 3600).toFixed(1) + 'h';
};
const fmtTime = (iso) => {
    if (!iso) return '';
    try { return new Date(iso).toISOString().slice(11, 16) + 'Z'; } catch { return ''; }
};

function refreshFilters() {
    const wxs = [...new Set(allConfigs.map(c => c.weather).filter(Boolean))].sort();
    const facs = [...new Set(allConfigs.map(c => c.facility).filter(Boolean))].sort();
    const setOpts = (sel, vals) => {
        const cur = sel.value;
        sel.innerHTML = '<option value="">ALL</option>'
            + vals.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
        if (vals.includes(cur)) sel.value = cur;
    };
    setOpts(wxEl, wxs);
    setOpts(facEl, facs);
}

function applyFilters() {
    const q = searchEl.value.trim().toUpperCase();
    const wx = wxEl.value;
    const fac = facEl.value;

    let filtered = allConfigs.filter(c => {
        if (wx && c.weather !== wx) return false;
        if (fac && c.facility !== fac) return false;
        if (q) {
            const hay = [c.airport, c.facility, c.enteringFacility, c.weather,
                         c.arrRunwayConf, c.depRunwayConf]
                        .filter(Boolean).join(' ').toUpperCase();
            if (!hay.includes(q)) return false;
        }
        return true;
    });

    const cmpStr = (a, b) => (a || '').localeCompare(b || '');
    filtered.sort((a, b) => {
        let v;
        switch (sortKey) {
            case 'aar': v = (a.arrRate ?? -1) - (b.arrRate ?? -1); break;
            case 'adr': v = (a.depRate ?? -1) - (b.depRate ?? -1); break;
            case 'aarStrat': v = (a.stratAar ?? -1) - (b.stratAar ?? -1); break;
            case 'combined': v = ((a.arrRate ?? 0) + (a.depRate ?? 0))
                              - ((b.arrRate ?? 0) + (b.depRate ?? 0)); break;
            case 'age': v = (a.ageSec ?? 9e9) - (b.ageSec ?? 9e9); break;
            case 'airport':
            default: v = cmpStr(a.airport, b.airport);
        }
        return sortAsc ? v : -v;
    });
    render(filtered);
}

function render(list) {
    countEl.textContent = `${list.length} of ${allConfigs.length}`;
    if (list.length === 0) {
        rowsEl.innerHTML = '';
        emptyEl.style.display = '';
        emptyEl.textContent = allConfigs.length === 0
            ? 'No APTC messages received yet. APTC arrives when an airport changes its config.'
            : 'No matches.';
        return;
    }
    emptyEl.style.display = 'none';
    rowsEl.innerHTML = list.map(c => {
        const stale = (c.ageSec ?? 0) > 1800;
        const ageClass = c.ageSec != null
            ? (c.ageSec < 300 ? 'fresh' : c.ageSec > 1800 ? 'warn' : '')
            : '';
        const wxClass = c.weather === 'VMC' || c.weather === 'IMC' || c.weather === 'MVFR'
            ? c.weather : '';
        const combined = (c.arrRate ?? 0) + (c.depRate ?? 0);
        return `<tr class="${stale ? 'stale' : ''}">
            <td class="col-ap">${esc(c.airport)}</td>
            <td class="col-fac">${esc(c.facility || '')}</td>
            <td class="col-wx">${c.weather ? `<span class="wx-badge ${wxClass}">${esc(c.weather)}</span>` : ''}</td>
            <td class="col-rwy">${esc(c.arrRunwayConf || '')}</td>
            <td class="col-rate">${c.arrRate ?? '--'}</td>
            <td class="col-strat">${c.stratAar || ''}</td>
            <td class="col-rwy">${esc(c.depRunwayConf || '')}</td>
            <td class="col-rate">${c.depRate ?? '--'}</td>
            <td class="col-rate combined">${combined || ''}</td>
            <td class="col-tm">${fmtTime(c.updateTime || c.eventTime)}</td>
            <td class="col-age ${ageClass}">${fmtAge(c.ageSec)}</td>
        </tr>`;
    }).join('');

    // Update header sort indicators
    headers.forEach(th => {
        th.classList.remove('sort-active', 'asc');
        if (th.dataset.sort === sortKey) {
            th.classList.add('sort-active');
            if (sortAsc) th.classList.add('asc');
        }
    });
}

async function refresh() {
    try {
        const resp = await fetch('/api/tfms/aptc');
        const data = await resp.json();
        allConfigs = Array.isArray(data) ? data : [];
        refreshFilters();
        applyFilters();
        updatedEl.textContent = 'updated ' + new Date().toISOString().slice(11, 19) + 'Z';
    } catch (e) { countEl.textContent = 'error'; }
}

headers.forEach(th => {
    th.addEventListener('click', () => {
        const k = th.dataset.sort;
        if (sortKey === k) sortAsc = !sortAsc;
        else { sortKey = k; sortAsc = true; }
        applyFilters();
    });
});

searchEl.addEventListener('input', applyFilters);
wxEl.addEventListener('change', applyFilters);
facEl.addEventListener('change', applyFilters);

refresh();
setInterval(refresh, 30000);
