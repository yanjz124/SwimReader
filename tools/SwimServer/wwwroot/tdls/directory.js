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
// No date box: history covers every recorded day. Searching one day was useless (you rarely
// know which day a flight was on) and having it beside an all-days search was just confusing.
const histBox  = document.getElementById('histSearch');
const csInput  = document.getElementById('csInput');
const csOut    = document.getElementById('csResults');

// LIVE = the last 12 h the server keeps in memory (polled). HISTORY = one day read from disk
// (tdls-history), only when asked for — so neither view ever loads more than it shows.
const params = new URLSearchParams(location.search);
let mode = params.get('mode') === 'history' ? 'history' : 'live';

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

async function loadHistory() {
    const u = new URL(location.href); u.searchParams.delete('date'); history.replaceState(null, '', u);
    statusEl.textContent = 'loading history…';
    statusEl.className = 'hist';
    grid.innerHTML = '';
    try {
        // No date: the server totals the whole archive from the callsign index, no files read.
        const airports = await (await fetch('/api/tdls/history/airports')).json();
        if (mode !== 'history') return;
        statusEl.textContent = 'HISTORY · all recorded days';
        if (!airports.length) { grid.innerHTML = '<div class="empty">No TDLS history recorded yet.</div>'; return; }
        renderGrid(airports, icao => `/tdls/${icao.toLowerCase()}?mode=history`);
    } catch { statusEl.textContent = 'ERROR'; }
}

// Cross-airport, cross-DAY callsign search. Answered from the server's callsign index, which
// returns day + airport + count without reading any history file — reading the messages for a
// daily flight number means opening ~110 day files, which measured 54s cold on the Pi.
let csSeq = 0;
async function findCallsign() {
    const q = csInput.value.trim().toUpperCase();
    const seq = ++csSeq;
    if (q.length < 3) { csOut.innerHTML = ''; return; }
    csOut.innerHTML = '<span class="muted">searching all days…</span>';
    try {
        const d = await (await fetch(`/api/tdls/history/callsign?q=${encodeURIComponent(q)}`)).json();
        if (seq !== csSeq) return;
        const occ = d.occurrences || [];
        if (!occ.length) {
            csOut.innerHTML = d.indexState === 'Building'
                ? '<span class="muted">Still indexing history — try again shortly.</span>'
                : '<span class="muted">No callsign matches in recorded history.</span>';
            return;
        }
        csOut.innerHTML = occ.map(o =>
            `<a href="/tdls/${String(o.airport || '').toLowerCase()}?mode=history&q=${encodeURIComponent(d.callsign)}">` +
            `<span class="muted">${esc(o.date)}</span> ${esc(o.airport)} · ${esc(d.callsign)} ` +
            `<span class="muted">${o.count} msg</span></a>`).join('')
            + `<span class="muted">· ${d.total} message${d.total === 1 ? '' : 's'} over ${occ.length} day/airport</span>`;
    } catch { csOut.innerHTML = '<span class="muted">search failed</span>'; }
}
// ?q=CALLSIGN (e.g. the flight table's TDLS HISTORY button) opens history with that search run.
(function () {
    const q = params.get('q');
    if (!q) return;
    csInput.value = q.toUpperCase();
    if (mode !== 'history') mode = 'history';
})();

let csTimer = null;
csInput.addEventListener('input', () => { clearTimeout(csTimer); csTimer = setTimeout(findCallsign, 350); });

let _pollTimer = null;
function setMode(m) {
    mode = m;
    document.querySelectorAll('#modeToggle button').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
    histBox.hidden = m !== 'history';
    clearInterval(_pollTimer); _pollTimer = null;
    const url = new URL(location.href);
    url.searchParams.delete('date');
    if (m === 'history') { url.searchParams.set('mode', 'history'); loadHistory(); }
    else { url.searchParams.delete('mode'); refresh(); _pollTimer = setInterval(refresh, 5000); }
    history.replaceState(null, '', url);
}
document.getElementById('modeToggle').addEventListener('click', e => {
    const b = e.target.closest('button[data-mode]');
    if (b && b.dataset.mode !== mode) setMode(b.dataset.mode);
});

setMode(mode);
// Run the prefilled search once the mode is set up (the box is filled above from ?q=).
if (csInput.value.trim().length >= 3) findCallsign();
window.idleOnPause = () => { clearInterval(_pollTimer); _pollTimer = null; };
window.idleOnResume = () => { if (mode === 'live') { refresh(); _pollTimer = setInterval(refresh, 5000); } };
