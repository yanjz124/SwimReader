const panelEl = document.getElementById('panel');
const navItems = document.querySelectorAll('.nav-item');
let stats = {};

// ── Nav hover → show detail in right panel ────────────────────
const pages = {
    eram: {
        title: 'ERAM SCOPE',
        source: 'SFDPS — FDPS VPN — FIXM XML',
        desc: 'Full radar scope display with ERAM-style data blocks, history symbols, and velocity vectors. Shows en route flight data from all 20 ARTCCs in real-time. Includes handoff indicators, point-outs, altitude conformance, coast tracks, and MCA commands.',
        href: '/eram',
        fields: [
            ['Data Source', 'SFDPS (FIXM en route)'],
            ['Update Rate', '~240 msg/sec'],
            ['Coverage', 'All 20 ARTCCs (CONUS)'],
            ['Features', 'Data blocks, history, vectors, NEXRAD, boundaries'],
        ]
    },
    'flight-table': {
        title: 'Flight Table — SFDPS',
        source: 'SFDPS — FDPS VPN — FIXM XML',
        desc: 'Flight data explorer with searchable table, detail panel showing full flight plans, altitude/ownership/clearance data, and complete SWIM event history with raw XML. Filter by status, facility, sector, and flight rules.',
        href: '/flight-table',
        fields: [
            ['Data Source', 'SFDPS (FIXM en route)'],
            ['Features', 'Search, sort, detail panel, event history, raw XML'],
        ]
    },
    tfm: {
        title: 'TFM — Traffic Flow Management',
        source: 'TFMS — TFMS VPN',
        desc: 'Traffic Flow Management dashboard. View active TMIs (Traffic Management Initiatives), ground stops, GDPs, and FCAs with affected flight lists. Live flight tracking with ETD/ETA, route, STAR, and sector traversal data.',
        href: '/tfm',
        fields: [
            ['Data Source', 'TFMS (flow management)'],
            ['Features', 'TMI dashboard, flight search, route data'],
        ]
    },
    'tfm-route': {
        title: 'TFM — Route Viewer',
        source: 'TFMS — TFMS VPN',
        desc: 'Visualize full route traversal on a map with fix-by-fix lat/lon waypoints, ARTCC center crossings, and sector-by-sector transit predictions. Enter a callsign to see the complete TFMS route.',
        href: '/tfm/route',
        fields: [
            ['Data Source', 'TFMS (traversal data)'],
            ['Features', 'Map, waypoints, centers, sectors, airways'],
        ]
    },
    'tfm-sectors': {
        title: 'TFM — Sector Loading',
        source: 'TFMS — TFMS VPN',
        desc: 'Predicted sector traffic from TFMS traversal data. Grid of all sectors with flight counts. Click a sector to see which flights are predicted to transit it and their entry times.',
        href: '/tfm/sectors',
        fields: [
            ['Data Source', 'TFMS (sector traversal)'],
            ['Features', 'Sector grid, traffic predictions, ARTCC filter'],
        ]
    },
    'tfm-flow': {
        title: 'TFM — Flow Advisory',
        source: 'TFMS — TFMS VPN',
        desc: 'Active FCAs (Flow Constrained Areas) and TMIs mapped on a Leaflet display. See entry points of affected flights and browse FCA details with flight lists.',
        href: '/tfm/flow',
        fields: [
            ['Data Source', 'TFMS (flow information)'],
            ['Features', 'FCA map, entry points, live updates'],
        ]
    },
    tais: {
        title: 'TAIS — Terminal Automation',
        source: 'STDDS — STDDS VPN — STARS XML',
        desc: 'Terminal radar tracks with flight plan data from STARS TRACONs. Shows callsign, aircraft type, origin/destination, altitude, squawk, runway, scratchpads, and controller ownership per facility.',
        href: '/tais',
        fields: [
            ['Data Source', 'TAIS (STARS terminal)'],
            ['Coverage', 'All STARS TRACONs'],
            ['Features', 'Per-facility tracks, search, frozen filter'],
        ]
    },
    asdex: {
        title: 'ASDE-X — Surface Surveillance',
        source: 'STDDS — STDDS VPN — SMES XML',
        desc: 'Airport surface movement radar. Live Leaflet map showing aircraft and vehicle positions on taxiways and runways. Updates every second from ASDE-X sensors at ~40 major airports.',
        href: '/asdex',
        fields: [
            ['Data Source', 'SMES (ASDE-X surface)'],
            ['Update Rate', '~1 sec'],
            ['Coverage', '~40 airports'],
            ['Features', 'Live map, target types, data blocks'],
        ]
    },
    tdls: {
        title: 'TDLS — Clearance Delivery',
        source: 'STDDS — STDDS VPN — TDES XML',
        desc: 'Tower Data Link Services. Shows CPDLC pre-departure clearances (PDC/DCL) and tower departure events (gate, taxi, takeoff times) per airport.',
        href: '/tdls',
        fields: [
            ['Data Source', 'TDES (CPDLC/departure)'],
            ['Features', 'Per-airport messages, CPDLC body, departure timeline'],
        ]
    },
};

navItems.forEach(item => {
    item.addEventListener('mouseenter', () => {
        const key = item.dataset.key;
        showPanel(key);
        navItems.forEach(n => n.classList.remove('selected'));
        item.classList.add('selected');
    });
    // Prevent default nav on click, open in same tab
    item.addEventListener('click', (e) => {
        // Allow normal navigation
    });
});

function showPanel(key) {
    const p = pages[key];
    if (!p) return;

    const fieldsHtml = p.fields.map(([lbl, val]) =>
        `<span class="lbl">${lbl}</span><span class="val">${val}</span>`
    ).join('');

    panelEl.innerHTML = `
        <h2>${p.title}</h2>
        <div class="source">${p.source}</div>
        <div class="description">${p.desc}</div>
        <a class="open-btn" href="${p.href}">OPEN</a>
        <div class="field-grid">${fieldsHtml}</div>
    `;
}

// ── Live stats polling ────────────────────────────────────────
async function refreshStats() {
    try {
        // SFDPS stats
        const sr = await fetch('/api/stats');
        if (sr.ok) {
            const s = await sr.json();
            document.getElementById('sfdpsStat').innerHTML =
                `SFDPS: <b>${(s.flights || 0).toLocaleString()} flights</b>  <b>${(s.rate || 0).toFixed(0)}/s</b>`;
            document.getElementById('eramCount').textContent =
                `${(s.flights || 0).toLocaleString()} flights`;
            document.getElementById('connStat').className = 'stat live';
            document.getElementById('connStat').textContent = 'LIVE';
        }
    } catch {}

    try {
        // ASDE-X stats
        const ar = await fetch('/api/asdex');
        if (ar.ok) {
            const airports = await ar.json();
            const totalTracks = airports.reduce((s, a) => s + a.count, 0);
            document.getElementById('asdexCount').textContent =
                `${airports.length} airports  ${totalTracks} tracks`;
        }
    } catch {}

    try {
        // TAIS stats
        const tr = await fetch('/api/tais');
        if (tr.ok) {
            const facilities = await tr.json();
            const totalTracks = facilities.reduce((s, f) => s + f.trackCount, 0);
            document.getElementById('taisCount').textContent =
                `${facilities.length} facilities  ${totalTracks} tracks`;
        }
    } catch {}

    try {
        // TDLS stats
        const dr = await fetch('/api/tdls');
        if (dr.ok) {
            const airports = await dr.json();
            const totalMsg = airports.reduce((s, a) => s + a.messageCount, 0);
            document.getElementById('tdlsCount').textContent =
                `${airports.length} airports  ${totalMsg} messages`;
            const stddsTracks = document.getElementById('asdexCount').textContent;
            document.getElementById('stddsStat').innerHTML =
                `STDDS: <b>${stddsTracks || 'connecting...'}</b>`;
        }
    } catch {}

    try {
        // TFMS stats
        const tfr = await fetch('/api/tfms/stats');
        if (tfr.ok) {
            const ts = await tfr.json();
            document.getElementById('tfmsStat').innerHTML = ts.connected
                ? `TFMS: <b>${(ts.flightCount || 0).toLocaleString()} flights</b>`
                : `TFMS: <b>--</b>`;
            const fidoEl = document.getElementById('tfmCount');
            if (fidoEl) fidoEl.textContent =
                `${(ts.flightCount || 0).toLocaleString()} flights  ${(ts.tmiCount || 0)} TMIs`;
        }
    } catch {}
}

refreshStats();
let _pollTimer = setInterval(refreshStats, 10000);
window.idleOnPause = () => { clearInterval(_pollTimer); };
window.idleOnResume = () => { refreshStats(); _pollTimer = setInterval(refreshStats, 10000); };
