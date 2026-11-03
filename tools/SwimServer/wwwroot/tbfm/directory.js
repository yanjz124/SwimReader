// ─────────────────────────────────────────────────────────────────────────────
// TBFM directory: metered airports, and the 20 centre TBFM systems publishing them.
//
// Two tabs because the feed and the question don't line up. TBFM is a per-centre system — each
// ARTCC schedules a flight across its own boundary gate — but what anyone actually wants to know
// is how a FIELD is flowing. So the airport tab groups the chain back into aeroplanes, and the
// centre tab shows the systems themselves.
// ─────────────────────────────────────────────────────────────────────────────

// Curated short labels: they read better on a card than a full legal name. Anything missing is
// filled from /api/airports/find after render (see shared/airport-names.js), so a rename fills
// itself in — which is how DJT showed up when PBI retired.
const NAMES = {
    ATL: "ATLANTA", LAX: "LOS ANGELES", ORD: "CHICAGO O'HARE", DFW: "DALLAS-FT WORTH",
    DEN: "DENVER", JFK: "NEW YORK JFK", LGA: "NEW YORK LAGUARDIA", EWR: "NEWARK",
    LAS: "LAS VEGAS", MCO: "ORLANDO", MIA: "MIAMI", CLT: "CHARLOTTE", SEA: "SEATTLE",
    PHX: "PHOENIX", IAH: "HOUSTON", SFO: "SAN FRANCISCO", BOS: "BOSTON", DTW: "DETROIT",
    MSP: "MINNEAPOLIS", FLL: "FT LAUDERDALE", MDW: "CHICAGO MIDWAY", TEB: "TETERBORO",
    SAN: "SAN DIEGO", IAD: "WASHINGTON DULLES", DCA: "WASHINGTON NATIONAL", BWI: "BALTIMORE",
    PDX: "PORTLAND", SLC: "SALT LAKE CITY", PHL: "PHILADELPHIA", TPA: "TAMPA", BNA: "NASHVILLE",
    STL: "ST LOUIS", MCI: "KANSAS CITY", CVG: "CINCINNATI", CLE: "CLEVELAND", PIT: "PITTSBURGH",
    IND: "INDIANAPOLIS", MEM: "MEMPHIS", SDF: "LOUISVILLE", AUS: "AUSTIN", SAT: "SAN ANTONIO",
    HOU: "HOUSTON HOBBY", DAL: "DALLAS LOVE FIELD", OAK: "OAKLAND", SJC: "SAN JOSE",
    SMF: "SACRAMENTO", SNA: "ORANGE COUNTY", RDU: "RALEIGH-DURHAM", MSY: "NEW ORLEANS",
    JAX: "JACKSONVILLE", RSW: "SOUTHWEST FLORIDA", PBI: "WEST PALM BEACH", DJT: "WEST PALM BEACH",
    ABQ: "ALBUQUERQUE", TUS: "TUCSON", OKC: "OKLAHOMA CITY", TUL: "TULSA", OMA: "OMAHA",
    HPN: "WESTCHESTER", PVD: "PROVIDENCE", BDL: "HARTFORD", ALB: "ALBANY", BUF: "BUFFALO",
    ROC: "ROCHESTER", SYR: "SYRACUSE", GSO: "GREENSBORO", GSP: "GREENVILLE", CHS: "CHARLESTON",
    SAV: "SAVANNAH", BHM: "BIRMINGHAM", MKE: "MILWAUKEE", GRR: "GRAND RAPIDS", BOI: "BOISE",
    GEG: "SPOKANE", ANC: "ANCHORAGE", HNL: "HONOLULU", TJSJ: "SAN JUAN", MDPC: "PUNTA CANA",
};

let tab = 'apt';
let aptRows = [], ctrRows = [], stats = null;
let showAllApts = false;

// TBFM publishes a schedule for every flight crossing a metered gate, whatever its destination —
// which is why 180 airports appear and ~120 of them are a single overflight bound for Heathrow,
// Narita or a grass strip. Those records are real, but an airport is only being FLOW-MANAGED when
// TBFM is scheduling it to a runway or holding someone for it. That is the default view; the rest
// are one click away.
const managed = r => r.arriving > 0 || r.delayed > 0;

const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hhmm = iso => iso ? String(iso).slice(11, 16) + 'Z' : '';

function cell(k, v, cls) {
    return `<div class="cell"><span class="k">${k}</span><span class="v ${cls || ''}">${v}</span></div>`;
}

function renderStrip() {
    if (!stats) return;
    const s = stats;
    const feedCls = s.live === s.centers && s.centers > 0 ? 'good' : s.live ? 'warn' : 'bad';
    $('strip').innerHTML =
        cell('TBFM SYSTEMS', `${s.live}<small style="font-size:11px;color:#888">/${s.centers}</small>`, feedCls) +
        cell('FLIGHTS METERED', (s.flights || 0).toLocaleString()) +
        cell('SCHEDULES', (s.records || 0).toLocaleString(), 'sm') +
        cell('AIRPORTS', s.airports || 0) +
        cell('HELD &ge;1 MIN', s.delayed || 0, s.delayed ? 'warn' : '') +
        cell('DELAY ASSIGNED', `${(s.delayMin || 0).toLocaleString()}<small style="font-size:11px;color:#888"> min</small>`,
            s.delayMin > 200 ? 'bad' : s.delayMin ? 'warn' : '');
}

function aptCard(r) {
    const name = NAMES[r.apt] || '';
    const dly = r.delayed
        ? `<span class="chip dly">${r.delayMin} MIN · ${r.delayed}</span>` : '';
    const rate = r.aarRestricted ? `<span class="chip rate">AAR ${r.aar}</span>` : '';
    const frz = r.frozen ? `<span class="chip frz">FRZ ${r.frozen}</span>` : '';
    return `<a class="card ${r.delayed ? 'hot' : ''}" data-icao="${esc(r.apt)}" href="/tbfm/${esc(r.apt.toLowerCase())}">
        <div class="icao">${esc(r.apt)}</div>
        <div class="card-name">${esc(name)}</div>
        <div class="big">${r.metered}<small> metered</small></div>
        <div class="line">${r.arriving} to a runway · ${r.centers} ctr${r.centers === 1 ? '' : 's'}${r.tracon ? ' · ' + esc(r.tracon) : ''}</div>
        ${dly}${rate}${frz}</a>`;
}

function ctrCard(c) {
    const stale = c.lastMessageSec == null || c.lastMessageSec > 300;
    const dly = c.delayMin
        ? `<span class="chip dly">${c.delayMin} MIN · ${c.delayed}</span>` : '';
    return `<a class="card ${c.delayMin ? 'hot' : ''}" href="/tbfm/center/${esc(c.ctr.toLowerCase())}">
        <div class="icao">${esc(c.ctr)}</div>
        <div class="card-name">${esc((c.tracons || []).filter(t => t !== 'EDC').join(' '))}</div>
        <div class="big">${c.schedules}<small> scheduled</small></div>
        <div class="line">${c.points} meter points · ${c.airports} airports</div>
        ${dly}${stale ? '<span class="chip off">NO MSGS</span>'
            : `<span class="chip">HB ${c.heartbeatSec == null ? '—' : c.heartbeatSec + 's'}</span>`}</a>`;
}

function render() {
    const g = $('grid');
    if (tab === 'apt') {
        $('sub').textContent = 'Airports TBFM is metering arrivals into. A flight is metered once in '
            + 'every centre it crosses on the way to the field — the card counts aeroplanes, not schedules.';
        $('note').innerHTML = 'Delay is scheduled time of arrival minus estimated time of arrival, '
            + 'taken as the largest hold anywhere along the flight’s metering chain — TBFM spreads a '
            + 'hold upstream, so adding the links up would count it twice. '
            + '<b>AAR</b> appears only where a real rate is set: TBFM publishes 3600/hr as its '
            + '“no restriction” default. Shown by default are the airports TBFM is '
            + 'scheduling to a runway or holding for; the rest are destinations of flights it '
            + 'happens to meter across a gate on the way somewhere else.';
        if (!aptRows.length) { g.innerHTML = '<div class="empty">No airports being metered.</div>'; return; }
        const shown = showAllApts ? aptRows : aptRows.filter(managed);
        const hidden = aptRows.length - aptRows.filter(managed).length;
        g.innerHTML = shown.map(aptCard).join('')
            + (hidden ? `<a class="card" id="moreapts" href="#" style="border-style:dashed">
                <div class="icao" style="font-size:15px">${showAllApts ? '− FEWER' : '+ ' + hidden}</div>
                <div class="card-name">${showAllApts ? 'hide en-route only' : 'metered en route only'}</div>
                <div class="line" style="margin-top:9px">${showAllApts
                    ? 'airports with no runway schedule and no hold'
                    : 'crossing a metered gate, bound elsewhere'}</div></a>` : '');
        const more = document.getElementById('moreapts');
        if (more) more.onclick = e => { e.preventDefault(); showAllApts = !showAllApts; render(); };
        if (window.AirportNames) AirportNames.fill(g);
    } else {
        $('sub').textContent = 'The 20 ARTCC TBFM systems. Each publishes its own schedules, '
            + 'adaptation (meter points and arcs) and acceptance rates.';
        $('note').innerHTML = 'A centre’s delay total is the hold its own meter points are '
            + 'assigning, which is not the same roll-up as an airport’s — a flight held by one '
            + 'centre reads ~0 at the next point downstream once that hold has been absorbed.';
        if (!ctrRows.length) { g.innerHTML = '<div class="empty">No TBFM systems reporting.</div>'; return; }
        g.innerHTML = ctrRows.map(ctrCard).join('');
    }
}

function setTab(t) {
    tab = t;
    $('tab-apt').classList.toggle('on', t === 'apt');
    $('tab-ctr').classList.toggle('on', t === 'ctr');
    history.replaceState(null, '', t === 'ctr' ? '?tab=centers' : location.pathname);
    render();
}

async function load() {
    try {
        const [s, a, c] = await Promise.all([
            fetch('/api/tbfm/stats').then(r => r.json()),
            fetch('/api/tbfm/airports').then(r => r.json()),
            fetch('/api/tbfm/centers').then(r => r.json()),
        ]);
        stats = s;
        aptRows = a || [];
        ctrRows = (c || []).slice().sort((x, y) => y.schedules - x.schedules || x.ctr.localeCompare(y.ctr));
        $('status').textContent = new Date().toISOString().slice(11, 19) + 'Z';
        $('status').classList.add('ok');
        renderStrip();
        render();
    } catch (e) {
        $('status').textContent = 'error';
        $('status').classList.remove('ok');
    }
}

$('tab-apt').onclick = () => setTab('apt');
$('tab-ctr').onclick = () => setTab('ctr');
if (new URLSearchParams(location.search).get('tab') === 'centers') setTab('ctr');
load();
setInterval(load, 10000);
