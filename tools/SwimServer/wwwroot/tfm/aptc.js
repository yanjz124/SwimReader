const $ = (id) => document.getElementById(id);
const gridEl = $('grid'), emptyEl = $('empty'), countEl = $('count'), updatedEl = $('updated');
const searchEl = $('searchInput'), wxEl = $('wxFilter'), sortEl = $('sortBy');

let allConfigs = [];

const esc = (s) => (s ?? '').toString()
    .replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');

function fmtAge(s) {
    if (s == null) return '';
    if (s < 60) return s + 's';
    if (s < 3600) return Math.round(s / 60) + 'm';
    return (s / 3600).toFixed(1) + 'h';
}
function fmtTime(iso) {
    if (!iso) return '';
    try { return new Date(iso).toISOString().replace('T', ' ').slice(11, 16) + 'Z'; } catch { return ''; }
}

function refreshFilters() {
    const wxs = [...new Set(allConfigs.map(c => c.weather).filter(Boolean))].sort();
    const cur = wxEl.value;
    wxEl.innerHTML = '<option value="">ALL</option>' + wxs.map(w => `<option value="${esc(w)}">${esc(w)}</option>`).join('');
    if (wxs.includes(cur)) wxEl.value = cur;
}

function applyFilters() {
    const q = searchEl.value.trim().toUpperCase();
    const wx = wxEl.value;
    const sortKey = sortEl.value;

    let filtered = allConfigs.filter(c => {
        if (wx && c.weather !== wx) return false;
        if (q) {
            const hay = [c.airport, c.facility, c.enteringFacility, c.weather,
                         c.arrRunwayConf, c.depRunwayConf]
                        .filter(Boolean).join(' ').toUpperCase();
            if (!hay.includes(q)) return false;
        }
        return true;
    });

    filtered.sort((a, b) => {
        switch (sortKey) {
            case 'updated': return (a.ageSec ?? 9e9) - (b.ageSec ?? 9e9);
            case 'aar': return (b.arrRate ?? -1) - (a.arrRate ?? -1);
            case 'adr': return (b.depRate ?? -1) - (a.depRate ?? -1);
            case 'combined': return ((b.arrRate ?? 0) + (b.depRate ?? 0)) - ((a.arrRate ?? 0) + (a.depRate ?? 0));
            case 'airport':
            default: return (a.airport || '').localeCompare(b.airport || '');
        }
    });
    render(filtered);
}

function render(list) {
    countEl.textContent = `${list.length} of ${allConfigs.length}`;
    if (list.length === 0) {
        gridEl.innerHTML = '';
        emptyEl.style.display = '';
        emptyEl.textContent = allConfigs.length === 0 ? 'No APTC messages received yet.' : 'No matches.';
        return;
    }
    emptyEl.style.display = 'none';
    gridEl.innerHTML = list.map(c => {
        const wxClass = (c.weather === 'VMC' || c.weather === 'IMC') ? c.weather : '';
        const ageStale = (c.ageSec ?? 0) > 1800 ? 'stale' : '';
        return `<div class="card">
            <div class="ap">${esc(c.airport)}<span class="fac">${esc(c.facility || '')}</span>
                ${c.weather ? `<span class="wx ${wxClass}">${esc(c.weather)}</span>` : ''}
            </div>
            <div class="rates">
                <div class="rate">
                    <div class="label">AAR</div>
                    <div class="value">${c.arrRate ?? '--'}</div>
                    ${c.stratAar ? `<div class="strat">strat ${c.stratAar}</div>` : ''}
                </div>
                <div class="rate">
                    <div class="label">ADR</div>
                    <div class="value">${c.depRate ?? '--'}</div>
                </div>
            </div>
            <div class="rwy">
                <div class="col"><div class="label">ARR RWY</div><div class="value">${esc(c.arrRunwayConf || '--')}</div></div>
                <div class="col"><div class="label">DEP RWY</div><div class="value">${esc(c.depRunwayConf || '--')}</div></div>
            </div>
            <div class="meta">
                <span>updated ${fmtTime(c.updateTime || c.eventTime)}</span>
                <span class="age ${ageStale}">${fmtAge(c.ageSec)} ago</span>
            </div>
        </div>`;
    }).join('');
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

searchEl.addEventListener('input', applyFilters);
wxEl.addEventListener('change', applyFilters);
sortEl.addEventListener('change', applyFilters);

refresh();
setInterval(refresh, 30000);
