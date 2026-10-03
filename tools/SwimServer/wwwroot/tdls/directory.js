const AIRPORT_NAMES = {
    KABQ:'ALBUQUERQUE',KALB:'ALBANY',KATL:'ATLANTA',KAUS:'AUSTIN',KBDL:'BRADLEY',KBOI:'BOISE',KBNA:'NASHVILLE',KBOS:'BOSTON',KBUF:'BUFFALO',KBUR:'BURBANK',KBWI:'BALTIMORE',
    KCHS:'CHARLESTON',KCLE:'CLEVELAND',KCLT:'CHARLOTTE',KCMH:'COLUMBUS',KCVG:'CINCINNATI',KDAL:'DALLAS LOVE',KDCA:'WASHINGTON REAGAN',
    KDEN:'DENVER',KDFW:'DALLAS FT WORTH',KDTW:'DETROIT',KELP:'EL PASO',KEWR:'NEWARK',
    KFLL:'FT LAUDERDALE',KGSO:'GREENSBORO',KHPN:'WESTCHESTER',KHOU:'HOUSTON HOBBY',KIAH:'HOUSTON INTL',
    KIAD:'WASHINGTON DULLES',KIND:'INDIANAPOLIS',KJAX:'JACKSONVILLE',KJFK:'NEW YORK JFK',
    KLAS:'LAS VEGAS',KLAX:'LOS ANGELES',KLGA:'LAGUARDIA',KLIT:'LITTLE ROCK',
    KMCI:'KANSAS CITY',KMCO:'ORLANDO',KMEM:'MEMPHIS',KMIA:'MIAMI',KMKE:'MILWAUKEE',
    KMDW:'CHICAGO MIDWAY',KMSP:'MINNEAPOLIS',KMSY:'NEW ORLEANS',
    KOAK:'OAKLAND',KOKC:'OKLAHOMA CITY',KOMA:'OMAHA',KONT:'ONTARIO',
    KORD:'CHICAGO O\'HARE',KPBI:'WEST PALM BEACH',KPDX:'PORTLAND',KPHL:'PHILADELPHIA',
    KPHX:'PHOENIX',KPIT:'PITTSBURGH',KPVD:'PROVIDENCE',
    KRDU:'RALEIGH DURHAM',KRNO:'RENO',KRSW:'SOUTHWEST FLORIDA',
    KSAN:'SAN DIEGO',KSAT:'SAN ANTONIO',KSDF:'LOUISVILLE',KSEA:'SEATTLE',KSJC:'SAN JOSE',KSMF:'SACRAMENTO',KSFO:'SAN FRANCISCO',
    KSLC:'SALT LAKE CITY',KSNA:'ORANGE COUNTY',KSTL:'ST LOUIS',
    KTEB:'TETERBORO',KTPA:'TAMPA',KTUL:'TULSA',
    KVNY:'VAN NUYS',PANC:'ANCHORAGE',PHNL:'HONOLULU',TJSJ:'SAN JUAN',
    KADW:'ANDREWS AFB',
};

const statusEl = document.getElementById('status');
const countBar = document.getElementById('count-bar');
const grid     = document.getElementById('grid');
const dateSel  = document.getElementById('dateSel');
const histBox  = document.getElementById('histSearch');
const csInput  = document.getElementById('csInput');
const csOut    = document.getElementById('csResults');

// LIVE = the last 12 h the server keeps in memory (polled). HISTORY = one day read from disk
// (tdls-history), only when asked for — so neither view ever loads more than it shows.
const params = new URLSearchParams(location.search);
let mode = (params.get('date') || params.get('mode') === 'history') ? 'history' : 'live';
let histDate = params.get('date') || '';

function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

function renderGrid(airports, hrefFor) {
    if (!airports.length) {
        countBar.textContent = '';
        grid.innerHTML = mode === 'live'
            ? '<div class="empty">No TDLS airports active — waiting for CPDLC clearances</div>'
            : '<div class="empty">No TDLS messages recorded on this day.</div>';
        return;
    }
    airports.sort((a, b) => a.airport.localeCompare(b.airport));
    const totalAc = airports.reduce((s, a) => s + a.aircraftCount, 0);
    const totalMsg = airports.reduce((s, a) => s + a.messageCount, 0);
    countBar.textContent = `${airports.length} airports  •  ${totalAc} acft  •  ${totalMsg} msg`;
    grid.innerHTML = airports.map(a => {
        const icao = a.airport;
        return `<a class="card" href="${hrefFor(icao)}">
            <div class="card-icao">${esc(icao)}</div>
            <div class="card-name">${AIRPORT_NAMES[icao] || ''}</div>
            <div class="card-counts">
                <div><span class="num">${a.aircraftCount}</span>ACFT</div>
                <div><span class="num">${a.messageCount}</span>MSG</div>
            </div>
        </a>`;
    }).join('');
}

async function refresh() {
    if (mode !== 'live') return;
    try {
        const r = await fetch('/api/tdls');
        if (!r.ok) throw new Error(r.status);
        const airports = await r.json();
        if (mode !== 'live') return;
        statusEl.textContent = 'LIVE · last 12 h';
        statusEl.className = 'ok';
        renderGrid(airports, icao => '/tdls/' + icao.toLowerCase());
    } catch (e) {
        statusEl.textContent = 'ERROR';
        statusEl.className = '';
    }
}

async function loadDates() {
    if (dateSel.options.length) return;
    try {
        const data = await (await fetch('/api/tdls/history/dates')).json();
        const dates = (data.dates || []).map(d => d.date);
        // This box only picks which day's AIRPORT GRID is shown — the callsign search below
        // always covers every recorded day.
        dateSel.innerHTML = dates.map(d => `<option value="${d}">grid: ${d}</option>`).join('');
        if (!histDate || !dates.includes(histDate)) histDate = dates[0] || '';
        dateSel.value = histDate;
    } catch { }
}

async function loadHistory() {
    await loadDates();
    if (!histDate) { grid.innerHTML = '<div class="empty">No TDLS history recorded yet.</div>'; return; }
    const u = new URL(location.href); u.searchParams.set('date', histDate); history.replaceState(null, '', u);
    statusEl.textContent = 'loading ' + histDate + '…';
    statusEl.className = 'hist';
    grid.innerHTML = '';
    try {
        const airports = await (await fetch('/api/tdls/history/airports?date=' + histDate)).json();
        if (mode !== 'history') return;
        statusEl.textContent = 'HISTORY · ' + histDate;
        renderGrid(airports, icao => `/tdls/${icao.toLowerCase()}?date=${histDate}`);
    } catch { statusEl.textContent = 'ERROR'; }
}

// Cross-airport, cross-DAY callsign search. Searching one day was useless — you rarely know which
// day a flight was on. The server resolves a callsign through its index, so this costs a couple of
// files rather than a scan of the whole archive.
let csSeq = 0;
async function findCallsign() {
    const q = csInput.value.trim().toUpperCase();
    const seq = ++csSeq;
    if (q.length < 3) { csOut.innerHTML = ''; return; }
    csOut.innerHTML = '<span class="muted">searching all days…</span>';
    try {
        const d = await (await fetch(`/api/tdls/history?q=${encodeURIComponent(q)}&limit=500`)).json();
        if (seq !== csSeq) return;
        // Group by day + airport + callsign, so the same flight number on different days stays apart.
        const byKey = new Map();
        for (const m of d.results || []) {
            if (!String(m.aircraftId || '').toUpperCase().includes(q)) continue;
            const day = String(m.time || '').slice(0, 10);
            const k = day + '|' + m.airport + '|' + m.aircraftId;
            byKey.set(k, (byKey.get(k) || 0) + 1);
        }
        if (!byKey.size) {
            csOut.innerHTML = d.indexState === 'Building'
                ? '<span class="muted">No matches yet — still indexing history, try again shortly.</span>'
                : '<span class="muted">No callsign matches in recorded history.</span>';
            return;
        }
        // Newest day first.
        const rows = [...byKey].sort((a, b) => a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0);
        csOut.innerHTML = rows.map(([k, n]) => {
            const [day, ap, cs] = k.split('|');
            return `<a href="/tdls/${ap.toLowerCase()}?date=${day}&q=${encodeURIComponent(cs)}">` +
                   `<span class="muted">${esc(day)}</span> ${esc(ap)} · ${esc(cs)} ` +
                   `<span class="muted">${n} msg</span></a>`;
        }).join('') + (d.truncated
            ? '<span class="muted">· partial (hit the search limit)</span>' : '');
    } catch { csOut.innerHTML = '<span class="muted">search failed</span>'; }
}
let csTimer = null;
csInput.addEventListener('input', () => { clearTimeout(csTimer); csTimer = setTimeout(findCallsign, 350); });

let _pollTimer = null;
function setMode(m) {
    mode = m;
    document.querySelectorAll('#modeToggle button').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
    dateSel.hidden = histBox.hidden = m !== 'history';
    clearInterval(_pollTimer); _pollTimer = null;
    const url = new URL(location.href);
    url.searchParams.delete('mode');
    if (m === 'history') { if (histDate) url.searchParams.set('date', histDate); loadHistory(); }
    else { url.searchParams.delete('date'); refresh(); _pollTimer = setInterval(refresh, 5000); }
    history.replaceState(null, '', url);
}
document.getElementById('modeToggle').addEventListener('click', e => {
    const b = e.target.closest('button[data-mode]');
    if (b && b.dataset.mode !== mode) setMode(b.dataset.mode);
});
dateSel.addEventListener('change', () => { histDate = dateSel.value; setMode('history'); });

setMode(mode);
window.idleOnPause = () => { clearInterval(_pollTimer); _pollTimer = null; };
window.idleOnResume = () => { if (mode === 'live') { refresh(); _pollTimer = setInterval(refresh, 5000); } };
