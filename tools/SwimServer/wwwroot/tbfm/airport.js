// ─────────────────────────────────────────────────────────────────────────────
// One airport's TBFM arrival metering board.
//
// A row is an AIRPLANE, not a schedule. TBFM meters a flight once in every center it crosses on
// the way in, so a single arrival can carry up to eight schedules — click the row to see the whole
// chain, nearest the field last. Only the last link has a runway STA.
//
// HOLD is the largest hold assigned anywhere along the chain, which is the flight's delay; it is
// not the sum, because TBFM spreads one hold upstream and the point downstream of where it was
// absorbed reads ~0. The per-link column shows where it is actually being taken.
// ─────────────────────────────────────────────────────────────────────────────

const APT = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '').toUpperCase();

const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hhmm = iso => iso ? String(iso).slice(11, 16) : '';
const hhmmss = iso => iso ? String(iso).slice(11, 19) : '';

let board = null;
let sortKey = 'sta', sortDir = 1;
const expanded = new Set();      // callsigns whose chain is expanded
// NOT `open`: a top-level lexical `open` shadows window.open for the whole file, and
// GlobalScopeContractTests flags it because the sibling page does call window.open.

// ── delay formatting ────────────────────────────────────────────────────────
// Negative is shown as-is, never clamped: it means the record's STA and ETA came from two
// different schedules (this bridge merges field by field, so an older sta_sfx can outlive the
// scheduled point it belonged to). A big negative is the signal, so hiding it would hide the bug.
function dlyCell(d) {
    if (d == null) return '<td class="num dim">—</td>';
    if (d >= 10) return `<td class="num pos big">+${d.toFixed(1)}</td>`;
    if (d >= 1) return `<td class="num pos">+${d.toFixed(1)}</td>`;
    if (d <= -1) return `<td class="num neg">${d.toFixed(1)}</td>`;
    return `<td class="num ok">${d.toFixed(1)}</td>`;
}

function flagStr(f) {
    let s = '';
    if (f.frozen) s += 'F';
    if (f.suspended) s += 'S';
    if (f.manual) s += 'M';
    return s;
}

// ── header strip ────────────────────────────────────────────────────────────
function cell(k, v, cls) {
    return `<div class="cell"><span class="k">${k}</span><span class="v ${cls || ''}">${v}</span></div>`;
}

function renderStrip() {
    const b = board;
    const aar = (b.rates || []).filter(r => r.kind === 'aar' && r.id === b.apt)
        .sort((x, y) => (y.effective || '').localeCompare(x.effective || ''))[0];
    const aarTxt = !aar ? '—'
        : aar.restricted ? String(aar.rate)
            : `<small style="font-size:11px;color:#777">none</small>`;
    $('strip').innerHTML =
        cell('METERED', b.metered, b.metered ? '' : 'sm') +
        cell('TO A RUNWAY', b.arriving) +
        cell('HELD &ge;1 MIN', b.delayed, b.delayed ? 'warn' : '') +
        cell('HOLD ASSIGNED', `${b.delayMin}<small style="font-size:11px;color:#888"> min</small>`,
            b.delayMin > 60 ? 'bad' : b.delayMin ? 'warn' : '') +
        cell('LONGEST', `${b.maxDelayMin}<small style="font-size:11px;color:#888"> min</small>`,
            b.maxDelayMin >= 10 ? 'bad' : b.maxDelayMin >= 1 ? 'warn' : '') +
        cell('FROZEN', b.frozen, b.frozen ? 'sm' : 'sm') +
        cell('AAR', aarTxt, aar && aar.restricted ? 'warn' : 'sm') +
        cell('TRACON', b.tracon || '—', 'sm') +
        cell('CENTERS', (b.centers || []).length, 'sm');
}

function renderInfo() {
    const b = board;
    const bits = [];
    if (b.activeConfigs && b.activeConfigs.length)
        bits.push('Config ' + b.activeConfigs.map(c => `<b>${esc(c.cfg)}</b> (${c.flights})`).join(', '));
    const rwys = (b.configs || []).flatMap(c => c.runways || []);
    if (rwys.length) bits.push('Runways ' + esc([...new Set(rwys)].join(' ')));
    if ((b.centers || []).length)
        bits.push('Metered by ' + b.centers.map(c =>
            `<a href="/tbfm/center/${esc(c.toLowerCase())}">${esc(c)}</a>`).join(' '));
    const rr = (b.rates || []).filter(r => r.restricted);
    if (rr.length) bits.push('Rates ' + rr.map(r =>
        `${esc(r.kind.toUpperCase())} ${esc(r.id)} <b>${r.rate}</b>/hr`).join(', '));
    if (b.suspended) bits.push(`<b>${b.suspended}</b> suspended`);
    $('info').innerHTML = bits.join(' · ') || 'No adaptation or rates published for this airport.';
}

// ── table ───────────────────────────────────────────────────────────────────
const COLS = [
    { k: 'sta', t: 'STA', s: true },
    { k: 'eta', t: 'ETA', s: true },
    { k: 'dly', t: 'HOLD', s: true },
    { k: 'aid', t: 'CALLSIGN', s: true },
    { k: 'type', t: 'TYPE', s: true },
    { k: 'dep', t: 'FROM', s: true },
    { k: 'rwy', t: 'RWY', s: true },
    { k: 'point', t: 'POINT', s: true },
    { k: 'ptype', t: 'KIND', s: true },
    { k: 'ctr', t: 'CTR', s: true },
    { k: 'gate', t: 'GATE', s: true },
    { k: 'trk', t: 'TRK', s: true },
    { k: 'cat', t: 'CATEGORY', s: true },
    { k: 'flg', t: 'FLG', s: false },
    { k: 'lnk', t: 'LNKS', s: true },
];

function lastLink(f) { return (f.chain && f.chain.length) ? f.chain[f.chain.length - 1] : null; }

// The sortable/filterable shape of a row, so sorting and filtering agree with what's displayed.
function proj(f) {
    const term = f.staRwy ? f : null;
    const l = lastLink(f);
    return {
        f,
        sta: f.staRwy || (l && l.sta) || null,
        eta: f.etaRwy || (l && l.eta) || null,
        onRwy: !!f.staRwy,
        dly: f.delayMin,
        aid: f.aid,
        type: f.type || '',
        dep: f.dep || '',
        rwy: f.rwy || '',
        point: (l && l.point) || '',
        ptype: (l && l.pointType) || '',
        ctr: f.terminalCtr || (l && l.ctr) || '',
        gate: (l && l.gate) || '',
        trk: f.trackedBy || '',
        cat: (f.cat || '').replace(/_/g, ' '),
        flg: flagStr(f),
        lnk: (f.chain || []).length,
    };
}

function renderHeader() {
    $('hdr').innerHTML = COLS.map(c =>
        `<th class="${c.s ? 'sortable' : ''}" data-k="${c.k}">${c.t}` +
        (sortKey === c.k ? `<span class="arr"> ${sortDir > 0 ? '▲' : '▼'}</span>` : '') + '</th>'
    ).join('');
    for (const th of $('hdr').querySelectorAll('th.sortable')) {
        th.onclick = () => {
            const k = th.dataset.k;
            if (sortKey === k) sortDir = -sortDir;
            else { sortKey = k; sortDir = k === 'dly' || k === 'lnk' ? -1 : 1; }
            renderHeader(); renderBody();
        };
    }
}

function chainRows(f) {
    const n = (f.chain || []).length;
    const head = '<tr><th>#</th><th>CTR</th><th>POINT</th><th>KIND</th><th>TRACON</th>'
        + '<th>GATE</th><th>STREAM</th><th>CATEGORY</th><th>ETA</th><th>STA</th><th>HOLD</th>'
        + '<th>ARCS</th><th>FLG</th><th>AGE</th></tr>';
    const body = (f.chain || []).map((l, i) => {
        const arcs = l.arcs
            ? Object.entries(l.arcs).map(([k, v]) =>
                `${k.toUpperCase()}${v.name ? ' ' + esc(v.name) : ''} ${hhmm(v.sta)}`).join(' · ')
            : '';
        let fl = '';
        if (l.frozen) fl += 'F';
        if (l.rwyFrozen) fl += 'R';
        if (l.suspended) fl += 'S';
        if (l.manual) fl += 'M';
        const d = l.delayMin;
        const dCls = d == null ? 'dim' : d >= 10 ? 'pos big' : d >= 1 ? 'pos' : d <= -1 ? 'neg' : 'ok';
        const stale = l.ageSec != null && l.ageSec > 300;
        return `<tr class="${i === n - 1 ? 'last' : ''}">
            <td class="dim">${i + 1}</td>
            <td><a href="/tbfm/center/${esc((l.ctr || '').toLowerCase())}">${esc(l.ctr)}</a></td>
            <td style="color:#cccc44">${esc(l.point)}</td>
            <td class="dim">${esc(l.pointType || '')}</td>
            <td>${esc(l.tracon || '')}</td>
            <td>${esc(l.gate || '')}</td>
            <td class="dim">${esc(l.streamClass || '')}</td>
            <td class="dim">${esc((l.cat || '').replace(/_/g, ' '))}</td>
            <td>${hhmmss(l.eta)}</td>
            <td>${hhmmss(l.sta)}</td>
            <td class="${dCls}">${d == null ? '—' : (d > 0 ? '+' : '') + d.toFixed(1)}</td>
            <td class="dim">${arcs}</td>
            <td class="flags">${fl}</td>
            <td class="${stale ? 'neg' : 'dim'}">${l.ageSec == null ? '' : l.ageSec + 's'}</td>
        </tr>` + (l.staRwy ? `<tr><td></td><td colspan="13" class="dim">
            &rarr; runway ${esc(l.rwy || '')} &nbsp; ETA ${hhmmss(l.etaRwy)} &nbsp; STA ${hhmmss(l.staRwy)}
            &nbsp; hold ${l.rwyDelayMin == null ? '—' : (l.rwyDelayMin > 0 ? '+' : '') + l.rwyDelayMin.toFixed(1)}
            </td></tr>` : '');
    }).join('');
    const route = f.route ? `<div class="dim" style="font-size:10px;padding:2px 0 4px">
        ${esc(f.route)}</div>` : '';
    return `<tr class="chain"><td colspan="${COLS.length}">${route}
        <table class="sub"><thead>${head}</thead><tbody>${body}</tbody></table></td></tr>`;
}

function matches(p, q) {
    if (!q) return true;
    const hay = [p.aid, p.type, p.dep, p.rwy, p.point, p.ptype, p.ctr, p.gate, p.trk, p.cat]
        .join(' ').toUpperCase();
    // Wildcard tokens, all of which must hit — same convention as the TFDM board's filter.
    return q.toUpperCase().split(/\s+/).filter(Boolean).every(t => {
        if (t.includes('*')) {
            const re = new RegExp('^' + t.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*'));
            return hay.split(' ').some(w => re.test(w));
        }
        return hay.includes(t);
    });
}

function renderBody() {
    if (!board) return;
    const q = $('q').value.trim();
    const onlyDly = $('onlydly').checked, onlyRwy = $('onlyrwy').checked;
    let rows = (board.flights || []).map(proj)
        .filter(p => matches(p, q))
        .filter(p => !onlyDly || (p.dly != null && p.dly >= 1))
        .filter(p => !onlyRwy || p.onRwy);

    rows.sort((a, b) => {
        const x = a[sortKey], y = b[sortKey];
        if (x == null && y == null) return 0;
        if (x == null) return 1;            // blanks last, whichever direction
        if (y == null) return -1;
        if (typeof x === 'number' && typeof y === 'number') return (x - y) * sortDir;
        return String(x).localeCompare(String(y)) * sortDir;
    });

    $('count').textContent = `${rows.length} of ${(board.flights || []).length}`;
    if (!rows.length) {
        $('body').innerHTML = `<tr><td class="empty" colspan="${COLS.length}">No flights match.</td></tr>`;
        return;
    }
    $('body').innerHTML = rows.map(p => {
        const f = p.f, isOpen = expanded.has(f.aid);
        return `<tr class="flt ${isOpen ? 'open' : ''}" data-aid="${esc(f.aid)}">
            <td>${hhmm(p.sta)}${p.onRwy ? '' : '<span class="dim">*</span>'}</td>
            <td class="dim">${hhmm(p.eta)}</td>
            ${dlyCell(p.dly)}
            <td class="cs">${esc(p.aid)}</td>
            <td>${esc(p.type)}</td>
            <td>${esc(p.dep)}</td>
            <td>${esc(p.rwy)}</td>
            <td style="color:#cccc44">${esc(p.point)}</td>
            <td class="dim">${esc(p.ptype)}</td>
            <td>${esc(p.ctr)}</td>
            <td class="dim">${esc(p.gate)}</td>
            <td class="dim">${esc(p.trk)}</td>
            <td class="dim">${esc(p.cat)}</td>
            <td class="flags">${esc(p.flg)}</td>
            <td class="num dim">${p.lnk}</td>
        </tr>` + (isOpen ? chainRows(f) : '');
    }).join('');

    for (const tr of $('body').querySelectorAll('tr.flt')) {
        tr.onclick = () => {
            const aid = tr.dataset.aid;
            if (expanded.has(aid)) expanded.delete(aid); else expanded.add(aid);
            renderBody();
        };
    }
}

async function load() {
    try {
        const r = await fetch('/api/tbfm/airport/' + encodeURIComponent(APT));
        board = await r.json();
        $('title').textContent = 'TBFM ' + board.apt;
        document.title = `TBFM ${board.apt} — Arrival Metering`;
        $('status').textContent = new Date().toISOString().slice(11, 19) + 'Z';
        $('status').classList.add('ok');
        renderStrip(); renderInfo(); renderBody();
        $('note').innerHTML = 'A row is one airplane; <b>LNKS</b> is how many centers are metering '
            + 'it. Click a row for the chain, nearest the field last — only the last link carries a '
            + 'runway STA, and an <span class="dim">*</span> on STA means this flight has no runway '
            + 'schedule yet, so the time shown is its nearest meter point. <b>HOLD</b> is the largest '
            + 'hold anywhere on the chain, not the total: TBFM spreads one hold upstream, so the point '
            + 'after it was absorbed reads ~0. <b>FLG</b> — F frozen, S suspended, M manual; in the '
            + 'chain, R runway-frozen. A negative hold is a record whose STA and ETA are from two '
            + 'different schedules, and is shown rather than hidden.';
        if (window.AirportNames) {
            AirportNames.lookup([board.apt]).then(() => {
                $('aptname').textContent = AirportNames.get(board.apt, null) || '';
            });
        }
    } catch (e) {
        $('status').textContent = 'error';
        $('status').classList.remove('ok');
    }
}

$('q').oninput = renderBody;
$('onlydly').onchange = renderBody;
$('onlyrwy').onchange = renderBody;
renderHeader();
load();
setInterval(load, 8000);
