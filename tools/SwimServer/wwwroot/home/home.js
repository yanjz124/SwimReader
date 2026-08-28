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

// ── Throughput card: same expand/collapse pattern ──
let _thr = {};            // latest throughput metrics
const throughputCard   = document.getElementById('throughputCard');
const throughputDetail = document.getElementById('throughputDetail');
function toggleThroughput() {
    const open = throughputCard.classList.toggle('open');
    throughputCard.setAttribute('aria-expanded', open ? 'true' : 'false');
    throughputDetail.hidden = !open;
    if (open) renderThroughputDetail();
}
throughputCard.addEventListener('click', toggleThroughput);
throughputCard.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleThroughput(); }
});
function renderThroughputDetail() {
    const t = _thr || {};
    const fields = [
        ['Flights tracked', (t.flights ?? 0).toLocaleString()],
        ['Msg / sec', (t.rate ?? 0).toFixed(0)],
        ['Msg / day (est)', fmtCompact((t.rate ?? 0) * 86400)],
        ['Data ingress', t.todayData ?? '--'],
        ['Avg data / day', t.avgData ?? '--'],
        ['Flight archive', t.archive ?? '--'],
    ];
    throughputDetail.innerHTML = fields.map(([l, v]) =>
        `<span class="lbl">${l}</span><span class="val">${v}</span>`).join('');
}
function updateThroughput() {
    const t = _thr || {};
    const cEl = document.getElementById('throughputCount');
    if (cEl) cEl.textContent =
        `${(t.flights ?? 0).toLocaleString()} flights  ${(t.rate ?? 0).toFixed(0)}/s`
        + (t.todayData ? `  ${t.todayData} today` : '');
    if (throughputCard.classList.contains('open')) renderThroughputDetail();
}

function fmtMB(mb) {
    if (mb == null) return '--';
    return mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : mb + ' MB';
}
// Compact count (e.g. 1.2M, 34K) for messages/day.
function fmtCompact(n) {
    n = n || 0;
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K';
    return Math.round(n).toString();
}
// Data volume from a MB value (→ MB or GB).
function fmtData(mb) {
    if (mb == null) return '--';
    return mb >= 1024 ? (mb / 1024).toFixed(2) + ' GB' : mb.toFixed(1) + ' MB';
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
        ['Flights stored', (s.flights ?? 0).toLocaleString()],
        ['Uptime', s.uptime ?? '--'],
        ['Disk free', (s.diskFreeGB ?? '--') + ' / ' + (s.diskTotalGB ?? '--') + ' GB'],
        ['Host', (s.machine ?? '--') + '  (pid ' + (s.pid ?? '--') + ')'],
        ['.NET', s.dotnet ?? '--'],
    ];
    serverDetail.innerHTML = fields.map(([l, v]) =>
        `<span class="lbl">${l}</span><span class="val">${v}</span>`
    ).join('');
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
            // THROUGHPUT card
            _thr.flights = s.flights || 0;
            _thr.rate = s.rate || 0;
            updateThroughput();
        }
    } catch {}

    // Flight-history archive → data ingress per day (daily jsonl file sizes) + archive totals.
    try {
        const hr = await fetch('/api/history/dates');
        if (hr.ok) {
            const dates = await hr.json();               // [{ date: "YYYY-MM-DD", sizeMb }]
            const days = dates.length;
            const totalMb = dates.reduce((a, d) => a + (d.sizeMb || 0), 0);
            const todayStr = new Date().toISOString().slice(0, 10);
            const today = dates.find(d => d.date === todayStr);
            _thr.todayData = today ? fmtData(today.sizeMb) : '0 MB';
            _thr.avgData = days ? fmtData(totalMb / days) : '--';
            _thr.archive = days ? `${days} d · ${fmtData(totalMb)}` : '--';
            updateThroughput();
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

// Deployed build (git commit + time) so you can confirm what's actually live.
async function refreshVersion() {
    const el = document.getElementById('buildFooter');
    if (!el) return;
    try {
        const r = await fetch('/api/version');
        if (!r.ok) return;
        const v = await r.json();
        let when = '';
        if (v.commitTime) {
            const d = new Date(v.commitTime);
            const z = (n) => String(n).padStart(2, '0');
            const abs = `${d.getUTCFullYear()}-${z(d.getUTCMonth() + 1)}-${z(d.getUTCDate())} ${z(d.getUTCHours())}:${z(d.getUTCMinutes())}Z`;
            const mins = Math.round((Date.now() - d.getTime()) / 60000);
            const rel = mins < 1 ? 'just now' : mins < 60 ? `${mins}m ago`
                : mins < 1440 ? `${Math.round(mins / 60)}h ago` : `${Math.round(mins / 1440)}d ago`;
            when = `  ·  updated ${abs} (${rel})`;
        }
        el.textContent = `build ${v.commit || '?'}${when}`;
    } catch {}
}

refreshStats();
refreshVersion();
setInterval(refreshVersion, 60000);
let _pollTimer = setInterval(refreshStats, 10000);
window.idleOnPause = () => { clearInterval(_pollTimer); };
window.idleOnResume = () => { refreshStats(); _pollTimer = setInterval(refreshStats, 10000); };
