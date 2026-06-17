let _sys = {};            // latest /api/system snapshot
const serverCard   = document.getElementById('serverCard');
const serverDetail = document.getElementById('serverDetail');

// ── Server card: expand/collapse inline detail (tap-friendly, no hover) ──
function toggleServer() {
    const open = serverCard.classList.toggle('open');
    serverCard.setAttribute('aria-expanded', open ? 'true' : 'false');
    serverDetail.hidden = !open;
    if (open) renderServerDetail();
}
serverCard.addEventListener('click', toggleServer);
serverCard.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleServer(); }
});

function fmtMB(mb) {
    if (mb == null) return '--';
    return mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : mb + ' MB';
}

function renderServerDetail() {
    const s = _sys || {};
    const fields = [
        ['CPU', (s.cpuPercent ?? 0) + '%  (' + (s.cores ?? '?') + ' cores)'],
        ['Memory (RSS)', fmtMB(s.memWorkingSetMB)],
        ['Managed heap', fmtMB(s.memManagedMB) + '  /  GC ' + fmtMB(s.gcHeapMB)],
        ['GC gen 0/1/2', `${s.gen0 ?? 0} / ${s.gen1 ?? 0} / ${s.gen2 ?? 0}`],
        ['Threads', s.threads ?? '--'],
        ['WS clients', s.wsClients ?? '--'],
        ['Flights in memory', (s.flights ?? 0).toLocaleString()],
        ['Uptime', s.uptime ?? '--'],
        ['Disk free', (s.diskFreeGB ?? '--') + ' / ' + (s.diskTotalGB ?? '--') + ' GB'],
        ['Host', (s.machine ?? '--') + '  (pid ' + (s.pid ?? '--') + ')'],
        ['.NET', s.dotnet ?? '--'],
    ];
    serverDetail.innerHTML = fields.map(([l, v]) =>
        `<span class="lbl">${l}</span><span class="val">${v}</span>`
    ).join('');
}

// ── Active STARS positions (TCPs owning tracks) ───────────────
function renderTcps(facs) {
    const grid = document.getElementById('tcpGrid');
    const summary = document.getElementById('tcpSummary');
    if (!grid) return;
    if (!Array.isArray(facs) || facs.length === 0) {
        grid.innerHTML = '<div class="tcp-empty">No active positions</div>';
        if (summary) summary.textContent = '';
        return;
    }
    const totalPos = facs.reduce((s, f) => s + f.tcpCount, 0);
    if (summary) summary.textContent = `· ${totalPos} positions across ${facs.length} facilities`;
    grid.innerHTML = facs.map(f =>
        `<a class="card tcp-card" href="/tais/${encodeURIComponent(f.facility)}">
            <div class="title">${f.facility} <span class="tcp-n">${f.tcpCount} pos · ${f.trackCount} trk</span></div>
            <div class="tcp-chips">${f.tcps.map(t =>
                `<span class="tcp-chip">${t.tcp}<b>${t.count}</b></span>`).join('')}</div>
        </a>`).join('');
}

// ── Live stats polling ────────────────────────────────────────
async function refreshStats() {
    try {
        const syr = await fetch('/api/system');
        if (syr.ok) {
            _sys = await syr.json();
            const sEl = document.getElementById('serverStat');
            if (sEl) sEl.innerHTML =
                `SRV: <b>CPU ${(_sys.cpuPercent ?? 0).toFixed(0)}%</b>  <b>${fmtMB(_sys.memWorkingSetMB)}</b>`;
            const scEl = document.getElementById('serverCount');
            if (scEl) scEl.textContent =
                `CPU ${(_sys.cpuPercent ?? 0).toFixed(0)}%  ${fmtMB(_sys.memWorkingSetMB)}  ${_sys.wsClients ?? 0} clients`;
            if (serverCard.classList.contains('open')) renderServerDetail();
        }
    } catch {}

    try {
        const sr = await fetch('/api/stats');
        if (sr.ok) {
            const s = await sr.json();
            document.getElementById('sfdpsStat').innerHTML =
                `SFDPS: <b>${(s.flights || 0).toLocaleString()} flights</b>  <b>${(s.rate || 0).toFixed(0)}/s</b>`;
            document.getElementById('eramCount').textContent =
                `${(s.flights || 0).toLocaleString()} flights`;
            const connEl = document.getElementById('connStat');
            connEl.className = s.connected ? 'stat live' : 'stat';
            connEl.textContent = s.connected ? 'LIVE' : 'OFFLINE';
        }
    } catch {}

    try {
        const ar = await fetch('/api/asdex');
        if (ar.ok) {
            const airports = await ar.json();
            const totalTracks = airports.reduce((s, a) => s + a.count, 0);
            document.getElementById('asdexCount').textContent =
                `${airports.length} airports  ${totalTracks} tracks`;
        }
    } catch {}

    try {
        const tr = await fetch('/api/tais');
        if (tr.ok) {
            const facilities = await tr.json();
            const totalTracks = facilities.reduce((s, f) => s + f.trackCount, 0);
            document.getElementById('taisCount').textContent =
                `${facilities.length} facilities  ${totalTracks} tracks`;
        }
    } catch {}

    try {
        const pr = await fetch('/api/tais/tcps');
        if (pr.ok) renderTcps(await pr.json());
    } catch {}

    try {
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

    try {
        const er = await fetch('/api/edct');
        if (er.ok) {
            const ed = await er.json();
            const el = document.getElementById('edctCount');
            if (el) el.textContent = (ed.count || 0) + ' EDCTs';
        }
    } catch {}
}

refreshStats();
let _pollTimer = setInterval(refreshStats, 10000);
window.idleOnPause = () => { clearInterval(_pollTimer); };
window.idleOnResume = () => { refreshStats(); _pollTimer = setInterval(refreshStats, 10000); };
