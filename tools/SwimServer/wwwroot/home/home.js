// Signed-in (operator) view, from the non-secret "sv" cookie /login sets — the same cookie
// frame.js reads to add .op-signed, which is what actually hides the SYSTEM group. Used here
// only to not fire four requests per poll that would 403: the gate is server-side
// (LaddService.OperatorView), so forging this cookie buys empty cards.
const OPERATOR = /(?:^|;\s*)sv=1(?:;|$)/.test(document.cookie);

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
// ── Per-feed throughput ──────────────────────────────────────────────────
// /api/feed reports every SWIM feed's last-10s rate, how hard its single parse thread is
// working, how far behind the publisher it is, and any broker discards. The card shows all of
// it per feed, because "the feed is fine" used to be a judgement made from ONE number
// (SFDPS's) while nothing surfaced the other five at all.
let _feed = null;      // latest /api/feed
let _stdds = null;     // latest /api/feed/stdds (the other consumer of the STDDS queue)

const STATE_WHY = {
    ok:        'keeping up',
    lagging:   'behind the publisher in bursts, but the lag keeps draining to ~0 — normal for a bursty feed',
    behind:    "lag is high and never drains while the parse thread sits idle AND the process gate is uncontended: one session's transport ceiling. Raising this feed's FLOWS is the fix.",
    gated:     'lag is high and never drains, but the parse thread is not the bottleneck — the receivers are queueing on this feed\'s process gate. Processing is serialized, so MORE FLOWS WILL NOT HELP: shorten the critical section or move work out of it.',
    saturated: 'our parse thread is the bottleneck. Still lossless — the broker spools for us — but the spool is the only thing preventing discards.',
    silent:    "no messages for 90s+, which is the receiver's own watchdog reconnect threshold",
    loss:      'the broker discarded messages before delivering them. Confirmed, unrecoverable data loss.',
    idle:      'configured, nothing received yet',
    off:       'not consuming the live queues',
};

// A tiny sparkline over the last 10 minutes. Two series on one baseline: rate (filled) and lag
// (line), scaled independently — each answers a question about its own shape, not their ratio.
function sparkline(hist) {
    if (!hist || hist.length < 2) return '';
    const W = 100, H = 20, n = hist.length;
    const x = (i) => (i / (n - 1)) * W;
    const maxR = Math.max(1, ...hist.map(h => h.rate));
    const lags = hist.map(h => (h.lagSec != null && h.lagSec >= 0) ? h.lagSec : null);
    const seen = lags.filter(v => v != null);
    const maxL = Math.max(1, ...(seen.length ? seen : [1]));
    const ry = (v) => H - (v / maxR) * (H - 2) - 1;
    const area = 'M 0 ' + H + ' '
        + hist.map((h, i) => 'L ' + x(i).toFixed(1) + ' ' + ry(h.rate).toFixed(1)).join(' ')
        + ' L ' + W + ' ' + H + ' Z';
    // The lag line BREAKS across windows that recorded no samples rather than interpolating a
    // value that was never measured.
    let lagPath = '', pen = false;
    lags.forEach((v, i) => {
        if (v == null) { pen = false; return; }
        const yy = (H - (v / maxL) * (H - 2) - 1).toFixed(1);
        lagPath += (pen ? 'L' : 'M') + ' ' + x(i).toFixed(1) + ' ' + yy + ' ';
        pen = true;
    });
    // A baseline under the area makes each row read as its own chart rather than as part of a
    // continuous band running down the column.
    return '<svg class="spark" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-hidden="true">'
        + '<path d="' + area + '" fill="#23230e" stroke="#cccc44" stroke-width="0.7"/>'
        + (lagPath ? '<path d="' + lagPath + '" fill="none" stroke="#e08a3c" stroke-width="1.1" stroke-linejoin="round"/>' : '')
        + '<line x1="0" y1="' + (H - 0.3) + '" x2="' + W + '" y2="' + (H - 0.3) + '" stroke="#333" stroke-width="0.6"/>'
        + '</svg>';
}

// A floor computed from only a few windows cannot have seen a trough, so it must not be read
// as "never drains". Marked with a ? rather than hidden — the number is still the lowest seen.
function settling(f) { return f.floorSamples != null && f.floorSamples < 30; }

const FEED_COLS = [
    ['FEED', ''], ['STATE', ''], ['MSG/S', 'c-rate'], ['KB/S', 'c-kb'],
    ['LAG', 'c-lag'], ['FLOOR', 'c-floor'], ['BUSY', 'c-busy'], ['WAIT', 'c-wait'],
    ['FLOWS', 'c-flows'], ['RECONN', 'c-reconn'], ['DISCARD', 'c-disc'],
    ['10 MIN · RATE / LAG', 'c-trend'],
];

function feedRow(f, opts) {
    const o = opts || {};
    const st = o.noState ? null : (f.state || 'ok');
    const n1 = (v, suf) => v == null ? '--' : v.toFixed(1) + (suf || '');
    const n0 = (v) => v == null ? '--' : v.toFixed(0);
    return '<span class="fd" title="' + (o.title || '') + '">' + f.feed + '</span>'
        + (st ? '<span class="st ' + st + '" title="' + (STATE_WHY[st] || '') + '">' + st + '</span>'
              : '<span class="st idle" title="Sub-service of the neighboring process">·</span>')
        + '<span class="nm c-rate">' + n1(f.msgsPerSec) + '</span>'
        + '<span class="nm c-kb">' + n0(f.kbPerSec) + '</span>'
        + '<span class="nm c-lag">' + n1(f.lagSec, 's') + '</span>'
        + '<span class="nm c-floor' + ((f.lagFloorSec != null && f.lagFloorSec < 1) ? ' dim' : '') + '"'
        + ' title="Lowest lag seen in the last 10 min. Near 0 = the lag drains between bursts.'
        + ' Close to LAG = it never drains, which is a queue pinned at the transport ceiling.'
        + (settling(f) ? ' Only ' + f.floorSamples + ' of 30 windows so far — not long enough'
            + ' to have seen a trough, so do not read this as pinned yet.' : '') + '">'
        + n1(f.lagFloorSec, 's') + (settling(f) ? '?' : '') + '</span>'
        + '<span class="nm c-busy' + ((f.busyPct || 0) < 25 ? ' dim' : '') + '">'
        + (f.busyPct == null ? '--' : f.busyPct + '%') + '</span>'
        + '<span class="nm c-wait' + ((f.waitPct || 0) < 25 ? ' dim' : '') + '"'
        + ' title="Share of a receiver thread spent BLOCKED on this feed\'s process gate, measured'
        + ' apart from parse time. High WAIT with low BUSY means processing is serialized rather'
        + ' than slow, and adding flows cannot help — each extra flow just queues on the same lock.'
        + ' This used to be counted as BUSY, which made the number move against its own fix.">'
        + (f.waitPct == null ? '--' : f.waitPct + '%') + '</span>'
        + '<span class="nm c-flows' + ((f.flows || 0) ? '' : ' dim') + '">' + (f.flows || '--') + '</span>'
        + '<span class="nm c-reconn' + ((f.reconnects || 0) ? '' : ' dim') + '">' + (f.reconnects || 0) + '</span>'
        + '<span class="nm c-disc"' + ((f.discardEvents || 0) ? ' style="color:#ff5555"' : '') + '>'
        + (f.discardEvents || 0) + '</span>'
        + '<span class="c-trend">' + sparkline(f.history) + '</span>';
}

function renderThroughputDetail() {
    const t = _thr || {};
    const feeds = (_feed && _feed.feeds) || [];
    const out = [];

    out.push('<div class="feed-table">');
    out.push(FEED_COLS.map(c => '<span class="hd ' + c[1] + '">' + c[0] + '</span>').join(''));
    for (const f of feeds) out.push(feedRow(f));

    // The OTHER consumer of the STDDS queue, shown inline because the two numbers only mean
    // something together: a Solace queue delivers each message to exactly one bound consumer, so
    // our "STDDS" row is a SHARE of the queue rather than the queue's rate.
    if (_stdds && _stdds.reachable !== false && Array.isArray(_stdds.services)) {
        const tot = _stdds.services.find(x => x.feed === 'TOTAL');
        out.push('<span class="feed-sub">dgscope / stars service &mdash; same STDDS queue, port 5000</span>');
        for (const sv of _stdds.services) {
            if (sv.feed === 'TOTAL') continue;
            // flows is reported once for the whole service, not per sub-service, so fold it in
            // or the FLOWS column reads blank on exactly the rows where it is the lever.
            out.push(feedRow(Object.assign({ flows: _stdds.flows }, sv),
                { noState: true, title: 'STDDS sub-service on the neighboring process' }));
        }
        if (tot) {
            const here = feeds.find(f => f.feed === 'STDDS');
            const mine = here ? (here.msgsPerSec || 0) : 0;
            const theirs = tot.msgsPerSec || 0;
            out.push('<div class="feed-note"><b>The STDDS queue is shared.</b> This process takes '
                + mine.toFixed(1) + '/s and the DGScope/STARS service takes ' + theirs.toFixed(1)
                + '/s, so the queue is delivering about <b>' + (mine + theirs).toFixed(1)
                + '/s</b> and each process sees only its own share &mdash; a Solace queue hands every '
                + 'message to exactly one consumer. SWIM_FEED_HOST does not cover this: it stops a '
                + 'second <i>host</i> binding the queue, and both of these run on the feed host.'
                + (tot.inboundDropped ? ' <span class="bad">That service has also dropped '
                    + tot.inboundDropped.toLocaleString() + ' messages internally (its parse loop fell '
                    + 'behind) &mdash; loss we cause, not the broker.</span>' : '')
                + '</div>');
        }
    } else if (_stdds && _stdds.reachable === false) {
        out.push('<div class="feed-note"><span class="warn">DGScope/STARS service (port 5000) is '
            + 'unreachable</span> &mdash; its share of the STDDS queue is unknown.</div>');
    }

    // Plain-language verdict, so the table doesn't have to be interpreted to be useful.
    const bad = feeds.filter(f => f.state === 'loss');
    const watch = feeds.filter(f => ['behind', 'saturated', 'silent'].includes(f.state));
    let verdict;
    if (bad.length)
        verdict = '<span class="bad">Confirmed data loss on ' + bad.map(f => f.feed).join(', ')
            + '</span> &mdash; the broker discarded messages before delivery. Not recoverable.';
    else if (watch.length)
        verdict = '<span class="warn">Watch ' + watch.map(f => f.feed + ' (' + f.state + ')').join(', ')
            + '</span> &mdash; no broker discards yet, so nothing is lost. Hover a badge for what it means.';
    else
        verdict = 'No broker discards on any feed &mdash; nothing is being lost upstream.';

    out.push('<div class="feed-note">' + verdict + '<br>'
        + '<b>LAG</b> is the publisher\'s own timestamp against our receipt; <b>FLOOR</b> is its lowest '
        + 'value over 10 minutes. High LAG with a near-zero FLOOR is a bursty feed that is keeping up. '
        + 'High LAG whose FLOOR never drops is a queue pinned at one session\'s transport ceiling, and '
        + 'more <b>FLOWS</b> is what fixes that. <b>BUSY</b> is the share of that feed\'s single parse '
        + 'thread spent parsing &mdash; sustained high values mean only the broker\'s spool is keeping us '
        + 'lossless. <b>DISCARD</b> is the one authoritative loss signal: Solace sets it on the next '
        + 'message after it has thrown some away.</div>');
    out.push('</div>');

    const fields = [
        ['Flights tracked', (t.flights ?? 0).toLocaleString()],
        ['All feeds now', feeds.length
            ? feeds.reduce((a, f) => a + (f.msgsPerSec || 0), 0).toFixed(0) + '/s' : '--'],
        ['SFDPS msg / day (est)', fmtCompact(feedRate('SFDPS') * 86400)],
        ['Data ingress today', t.todayData ?? '--'],
        ['Avg data / day', t.avgData ?? '--'],
        ['Flight archive', t.archive ?? '--'],
    ];
    out.push(fields.map(f =>
        '<span class="lbl">' + f[0] + '</span><span class="val">' + f[1] + '</span>').join(''));
    throughputDetail.innerHTML = out.join('');
}

function feedRate(name) {
    const f = _feed && (_feed.feeds || []).find(x => x.feed === name);
    return f ? (f.msgsPerSec || 0) : 0;
}

function updateThroughput() {
    const t = _thr || {};
    const feeds = (_feed && _feed.feeds) || [];
    const total = feeds.reduce((a, f) => a + (f.msgsPerSec || 0), 0);
    const loss = feeds.filter(f => (f.discardEvents || 0) > 0).length;
    const watch = feeds.filter(f => ['behind', 'saturated', 'silent'].includes(f.state)).length;
    const cEl = document.getElementById('throughputCount');
    if (cEl) {
        // Collapsed line: the combined rate of EVERY feed, then whichever of "losing data" /
        // "to watch" / "all ok" applies. It used to show SFDPS's rate alone.
        cEl.textContent = feeds.length
            ? total.toFixed(0) + '/s across ' + feeds.length + ' feeds  ·  '
              + (loss ? loss + ' LOSING DATA' : watch ? watch + ' to watch' : 'all ok')
            : (t.flights ?? 0).toLocaleString() + ' flights  ' + (t.rate ?? 0).toFixed(0) + '/s';
        cEl.style.color = loss ? '#ff5555' : (watch ? '#d9a066' : '');
    }
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

// Live clients, summed across every feed, with the per-feed split the server sends
// (SFDPS /ws, the proxied STARS stream, ASDE-X, TAIS, TDLS, TFDM, TFMS, ITWS, replay).
// One person with two tabs open is two clients — these are connections, not people.
function clientsText(s) {
    const n = s.wsClients;
    if (n == null) return '--';
    const by = (s.wsByFeed || []).map(f => `${f.feed} ${f.count}`).join('  ·  ');
    return n === 0 ? '0' : `${n}   (${by})`;
}

function renderServerDetail() {
    const s = _sys || {};
    const fields = [
        ['CPU', (s.cpuPercent ?? 0) + '%  (' + (s.cores ?? '?') + ' cores)'],
        ['Memory (RSS)', fmtMB(s.memWorkingSetMB)],
        ['Managed heap', fmtMB(s.memManagedMB) + '  /  GC ' + fmtMB(s.gcHeapMB)],
        ['GC gen 0/1/2', `${s.gen0 ?? 0} / ${s.gen1 ?? 0} / ${s.gen2 ?? 0}`],
        ['Threads', s.threads ?? '--'],
        ['Clients', clientsText(s)],
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

// ── Storage & retention card ─────────────────────────────────────────────
// /api/storage walks the data directories (cached server-side for a minute), so it's fetched on
// load and whenever the card is opened, not on the fast stats timer.
let _storage = null;
const storageCard   = document.getElementById('storageCard');
const storageDetail = document.getElementById('storageDetail');
function fmtBytes(b) {
    if (b == null) return '--';
    if (b >= 1e12) return (b / 1e12).toFixed(1) + ' TB';
    if (b >= 1e9)  return (b / 1e9).toFixed(1) + ' GB';
    if (b >= 1e6)  return Math.round(b / 1e6) + ' MB';
    return Math.max(1, Math.round(b / 1e3)) + ' KB';
}
function fmtSpan(days) {
    if (days == null) return '';
    if (days < 1) return Math.round(days * 24) + ' h';
    if (days < 60) return (Math.round(days * 10) / 10) + ' days';
    return Math.round(days / 30.4) + ' months';
}
function fmtStamp(iso) {
    const d = new Date(iso); if (isNaN(d)) return '';
    const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()];
    return `${d.getUTCDate()} ${M} ${String(d.getUTCHours()).padStart(2,'0')}Z`;
}
async function loadStorage() {
    if (!OPERATOR) return;
    try {
        const r = await fetch('/api/storage');
        if (!r.ok) return;
        _storage = await r.json();
        const used = (_storage.datasets || []).reduce((a, d) => a + (d.bytes || 0), 0);
        const cEl = document.getElementById('storageCount');
        if (cEl) cEl.textContent = `${fmtBytes(used)} stored` +
            (_storage.diskFreeBytes != null ? `  ·  ${fmtBytes(_storage.diskFreeBytes)} free` : '');
        if (storageCard.classList.contains('open')) renderStorageDetail();
    } catch (e) { /* card just stays blank */ }
}
function renderStorageDetail() {
    const s = _storage;
    if (!s) { storageDetail.innerHTML = '<span class="lbl">loading…</span><span></span>'; return; }
    const caps = new Map((s.buckets || []).map(b => [b.bucket, b]));
    const out = [];
    let group = null;
    const shownCap = new Set();
    for (const d of s.datasets || []) {
        if (d.group !== group) { group = d.group; out.push(`<span class="grp">${group.toUpperCase()}</span>`); }
        let v = `<b>${fmtBytes(d.bytes)}</b>`;
        if (d.key === 'incidents') v += `  ·  ${d.items} archived`;
        else if (d.oldest && d.spanDays != null && d.group !== 'Reference')
            v += `  ·  <b>${fmtSpan(d.spanDays)}</b>  (${fmtStamp(d.oldest)} → now)`;
        out.push(`<span class="lbl" title="${d.note || ''}">${d.name}</span><span class="val">${v}</span>`);
        // Once per rolling bucket, after its last dataset: used vs cap. The oldest data is trimmed
        // when a bucket reaches its cap, so this is what decides how far back it can reach.
        const b = d.bucket && caps.get(d.bucket);
        const lastOfBucket = b && !(s.datasets || []).slice((s.datasets || []).indexOf(d) + 1).some(x => x.bucket === d.bucket);
        if (b && b.capBytes && lastOfBucket && !shownCap.has(d.bucket)) {
            shownCap.add(d.bucket);
            const pct = Math.min(100, Math.round(100 * b.usedBytes / b.capBytes));
            out.push(`<span class="lbl">  ↳ ${d.bucket} cap</span><span class="val">${fmtBytes(b.usedBytes)} of ${fmtBytes(b.capBytes)}` +
                `<span class="bar${pct >= 95 ? ' full' : ''}"><i style="width:${pct}%"></i></span>` +
                (pct >= 95 ? '  oldest trimmed as new data arrives' : '') + `</span>`);
        }
    }
    if (s.diskTotalBytes)
        out.push(`<span class="grp">DISK</span><span class="lbl">Free</span><span class="val"><b>${fmtBytes(s.diskFreeBytes)}</b> of ${fmtBytes(s.diskTotalBytes)}</span>`);
    storageDetail.innerHTML = out.join('');
}
function toggleStorage() {
    const open = storageCard.classList.toggle('open');
    storageCard.setAttribute('aria-expanded', open ? 'true' : 'false');
    storageDetail.hidden = !open;
    if (open) { renderStorageDetail(); loadStorage(); }
}
storageCard.addEventListener('click', toggleStorage);
storageCard.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleStorage(); }
});
loadStorage();
setInterval(loadStorage, 5 * 60 * 1000);

// Both feed endpoints, once per poll. Ordered first in refreshStats so the status bar and the
// THROUGHPUT card read the same snapshot. The STDDS one is a proxy to the neighboring process
// and returns {reachable:false} rather than failing when that service is restarting.
async function refreshFeeds() {
    if (!OPERATOR) return;   // _feed stays null; updateThroughput() already tolerates that
    try {
        const r = await fetch('/api/feed');
        if (r.ok) _feed = await r.json();
    } catch { /* keep the previous snapshot */ }
}

// Separate from refreshFeeds so the proxied neighbor (up to a 2 s timeout when it is restarting)
// never holds up the SFDPS rate or any card; it repaints the throughput table when it lands.
async function refreshStdds() {
    if (!OPERATOR) return;
    try {
        const r = await fetch('/api/feed/stdds');
        if (r.ok) _stdds = await r.json();
    } catch { _stdds = { reachable: false }; }
    updateThroughput();
}

// ── Live stats polling ────────────────────────────────────────
//
// Every group below is its own function and refreshStats() runs them all at once. They used to run
// back to back, ~13 awaited requests in a row: free on localhost, but through the tunnel each is a
// ~60-170 ms round trip, so cards filled in one at a time over a second or two. Only the work that
// reads the /api/feed snapshot (the SFDPS rate, the throughput repaint) waits for it.
async function refreshSystem() {
    try {
        const syr = OPERATOR ? await fetch('/api/system') : null;
        if (syr && syr.ok) {
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

}

async function refreshCore() {
    await refreshFeeds();
    try {
        const sr = await fetch('/api/stats');
        if (sr.ok) {
            const s = await sr.json();
            // Show the rate we are receiving NOW, not the average since the process started.
            //
            // s.rate is total/elapsed over the whole life of the process, which is not the number
            // anyone is comparing against: the SCDS portal shows an instantaneous rate, and SFDPS
            // publisher volume roughly halves overnight. A server up through a night therefore
            // showed ~44/s here against ~93/s on the portal and looked like it was losing half the
            // feed, when the two numbers simply measured different things. /api/feed samples the
            // last 10 seconds per feed, which is the comparable quantity.
            // _feed is refreshed once per poll in refreshFeeds() and shared by the status bar
            // and the THROUGHPUT card, so this costs no extra request.
            let rate = s.rate || 0, rateTitle = 'average since start (no live sample)';
            const sf = (_feed && (_feed.feeds || []).find(f => f.feed === 'SFDPS')) || null;
            if (sf && typeof sf.msgsPerSec === 'number') {
                rate = sf.msgsPerSec;
                rateTitle = `last 10s sample · lag ${sf.lagSec}s (floor ${sf.lagFloorSec}s) · `
                    + `${sf.flows} flows · ${sf.busyPct}% parse · `
                    + `${sf.discardEvents ? sf.discardEvents + ' broker discards' : 'no broker discards'}`
                    + ` · ${(s.rate || 0).toFixed(0)}/s average since start`;
            }
            document.getElementById('sfdpsStat').innerHTML =
                `SFDPS: <b>${(s.flights || 0).toLocaleString()} flights</b>  `
                + `<b title="${rateTitle}">${rate.toFixed(0)}/s</b>`;
            document.getElementById('eramCount').textContent =
                `${(s.flights || 0).toLocaleString()} flights`;
            const connEl = document.getElementById('connStat');
            // liveFeed false = this host deliberately isn't consuming the SWIM queues
            // (FeedGuard), which is a very different thing from a broken connection.
            if (s.liveFeed === false) {
                connEl.className = 'stat';
                connEl.textContent = 'FEED OFF';
                connEl.title = 'Live SWIM feed disabled on this host — ' + (s.feedBlocked || '');
            } else {
                connEl.className = s.connected ? 'stat live' : 'stat';
                connEl.textContent = s.connected ? 'LIVE' : 'OFFLINE';
                connEl.title = '';
            }
            // THROUGHPUT card
            _thr.flights = s.flights || 0;
            _thr.rate = s.rate || 0;
        }
    } catch {}

    // One repaint per poll, after the feed snapshot is in — not inside the /api/stats block,
    // so the feed table still updates on a poll where /api/stats happens to fail.
    updateThroughput();

}

async function refreshHistory() {
    // Flight-history archive → data ingress per day (daily jsonl file sizes) + archive totals.
    // Only feeds the THROUGHPUT card, so it follows the same gate.
    try {
        const hr = OPERATOR ? await fetch('/api/history/dates') : null;
        if (hr && hr.ok) {
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

}

async function refreshAsdex() {
    try {
        const ar = await fetch('/api/asdex');
        if (ar.ok) {
            const airports = await ar.json();
            const totalTracks = airports.reduce((s, a) => s + a.count, 0);
            const asdexText = `${airports.length} airports  ${totalTracks} tracks`;
            document.getElementById('asdexCount').textContent = asdexText;
            document.getElementById('stddsStat').innerHTML = `STDDS: <b>${asdexText}</b>`;
        }
    } catch {}

}

async function refreshTais() {
    try {
        const tr = await fetch('/api/tais');
        if (tr.ok) {
            const facilities = await tr.json();
            const totalTracks = facilities.reduce((s, f) => s + f.trackCount, 0);
            // No TAIS card on this page today — guard it, or this throws and takes the
            // rest of the block with it (every other write here is guarded for the same reason).
            const taisEl = document.getElementById('taisCount');
            if (taisEl) taisEl.textContent = `${facilities.length} facilities  ${totalTracks} tracks`;
        }
    } catch {}

}

async function refreshTdls() {
    try {
        const dr = await fetch('/api/tdls');
        if (dr.ok) {
            const airports = await dr.json();
            const totalMsg = airports.reduce((s, a) => s + a.messageCount, 0);
            document.getElementById('tdlsCount').textContent =
                `${airports.length} airports  ${totalMsg} messages`;
        }
    } catch {}

}

async function refreshTfms() {
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

}

async function refreshEdct() {
    try {
        const er = await fetch('/api/edct');
        if (er.ok) {
            const ed = await er.json();
            const el = document.getElementById('edctCount');
            if (el) el.textContent = (ed.count || 0) + ' EDCTs';
        }
    } catch {}

}

async function refreshTfdm() {
    try {
        const fr = await fetch('/api/tfdm');
        if (fr.ok) {
            const airports = await fr.json();
            const total = airports.reduce((a, x) => a + (x.count || 0), 0);
            const el = document.getElementById('tfdmCount');
            if (el) el.textContent = `${airports.length} airports  ${total.toLocaleString()} flights`;
        }
    } catch {}

}

async function refreshTbfm() {
    // TBFM counts airplanes, not schedules: a flight is metered once in every center it
    // crosses, so the record count runs 2x the flight count (see TbfmDashboard.cs).
    try {
        const br = await fetch('/api/tbfm/stats');
        if (br.ok) {
            const bt = await br.json();
            const el = document.getElementById('tbfmCount');
            if (el) el.textContent = bt.configured
                ? `${bt.live}/${bt.centers} centers  ${(bt.flights || 0).toLocaleString()} metered`
                  + (bt.delayMin ? `  ${bt.delayMin} min held` : '')
                : 'not configured';
        }
    } catch {}

}

async function refreshItws() {
    // ITWS counts sites and product types, not flights — a terminal area publishes ~20
    // products and `connected` is what distinguishes "calm weather" from "feed is down".
    try {
        const ir = await fetch('/api/itws/stats');
        if (ir.ok) {
            const it = await ir.json();
            const el = document.getElementById('itwsCount');
            if (el) el.textContent = it.connected
                ? `${it.siteCount || 0} sites  ${it.productTypeCount || 0} products`
                : 'disconnected';
        }
    } catch {}
}

// Deployed build (git commit + time) so you can confirm what's actually live.
let _statsBusy = false;
async function refreshStats() {
    if (_statsBusy) return;   // a slow poll must not stack another full round on top of itself
    _statsBusy = true;
    try {
        // The timer is a release valve: one request that never answers can't wedge polling for good.
        await Promise.race([
            Promise.all([refreshSystem(), refreshCore(), refreshStdds(), refreshHistory(), refreshAsdex(),
                refreshTais(), refreshTdls(), refreshTfms(), refreshEdct(), refreshTfdm(), refreshTbfm(),
                refreshItws()]),
            new Promise(r => setTimeout(r, 15000)),
        ]);
    } finally { _statsBusy = false; }
}

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
