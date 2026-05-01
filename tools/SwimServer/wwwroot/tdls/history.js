const $ = (id) => document.getElementById(id);
const dateSel = $('dateSel'), typeSel = $('typeSel'),
      airportInput = $('airportInput'), qInput = $('qInput'), goBtn = $('goBtn');
const rowsEl = $('rows'), emptyEl = $('empty'), countEl = $('count');

function fmtTime(iso) {
    if (!iso) return '';
    try { return new Date(iso).toISOString().replace('T', ' ').slice(0, 19) + 'Z'; } catch { return iso; }
}
function esc(s) {
    return (s ?? '').toString()
        .replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
}

async function loadDates() {
    try {
        const resp = await fetch('/api/tdls/history/dates');
        const data = await resp.json();
        const today = new Date().toISOString().slice(0, 10);
        const dates = (data.dates || []);
        const haveToday = dates.some(d => d.date === today);
        const opts = haveToday ? dates : [{ date: today, sizeBytes: 0 }, ...dates];
        dateSel.innerHTML = opts.map(d => {
            const mb = (d.sizeBytes / 1024 / 1024).toFixed(1);
            return `<option value="${d.date}">${d.date} (${mb} MB)</option>`;
        }).join('');
    } catch (e) {
        dateSel.innerHTML = `<option value="${new Date().toISOString().slice(0, 10)}">today</option>`;
    }
}

async function search() {
    const params = new URLSearchParams();
    if (dateSel.value) params.set('date', dateSel.value);
    if (typeSel.value) params.set('type', typeSel.value);
    if (airportInput.value.trim()) params.set('airport', airportInput.value.trim().toUpperCase());
    if (qInput.value.trim()) params.set('q', qInput.value.trim());
    params.set('limit', '500');
    countEl.textContent = 'searching...';
    try {
        const resp = await fetch('/api/tdls/history?' + params.toString());
        const data = await resp.json();
        render(data.results || []);
        countEl.textContent = `${data.count || 0} matches`;
    } catch (e) {
        countEl.textContent = 'error';
    }
}

function render(list) {
    if (list.length === 0) {
        rowsEl.innerHTML = '';
        emptyEl.style.display = '';
        emptyEl.textContent = 'No matches.';
        return;
    }
    emptyEl.style.display = 'none';
    rowsEl.innerHTML = list.map(m => {
        let detail = '';
        if (m.type === 'CPDLC') {
            detail = (m.dataHeader ? `<b>${esc(m.dataHeader)}</b>\n` : '') + esc(m.dataBody || '');
        } else if (m.type === 'DEPART') {
            const parts = [];
            if (m.gate) parts.push(`Gate: ${esc(m.gate)}`);
            if (m.runway) parts.push(`Rwy: ${esc(m.runway)}`);
            if (m.clearanceTime) parts.push(`CLR: ${esc(fmtTime(m.clearanceTime).slice(11, 16))}`);
            if (m.taxiTime) parts.push(`TAXI: ${esc(fmtTime(m.taxiTime).slice(11, 16))}`);
            if (m.takeoffTime) parts.push(`T/O: ${esc(fmtTime(m.takeoffTime).slice(11, 16))}`);
            detail = parts.join('  ');
        }
        return `<tr>
            <td class="col-tm">${esc(fmtTime(m.time))}</td>
            <td class="col-tp">${esc(m.type)}</td>
            <td class="col-ap">${esc(m.airport)}</td>
            <td class="col-cs">${esc(m.aircraftId)}</td>
            <td class="col-bcn">${esc(m.beaconCode || '')}</td>
            <td class="col-tp">${esc(m.acType || '')}</td>
            <td class="col-ap">${esc(m.destination || '')}</td>
            <td class="col-detail">${detail}</td>
        </tr>`;
    }).join('');
}

goBtn.addEventListener('click', search);
qInput.addEventListener('keydown', e => { if (e.key === 'Enter') search(); });
airportInput.addEventListener('keydown', e => { if (e.key === 'Enter') search(); });
dateSel.addEventListener('change', search);
typeSel.addEventListener('change', search);

loadDates().then(search);
