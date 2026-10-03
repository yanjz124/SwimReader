const AIRPORT = location.pathname.split('/').pop().toUpperCase();
// LIVE = WebSocket over the server's last 12 h; HISTORY = one day of this airport from disk
// (/api/tdls/history), fetched only when chosen. ?date=YYYY-MM-DD opens in history mode.
const _params = new URLSearchParams(location.search);
let mode = (_params.get('date') || _params.get('mode') === 'history') ? 'history' : 'live';
// No date filter: history is every recorded day, narrowed by the callsign box instead.
document.getElementById('airport-title').textContent = AIRPORT;
document.title = `TDLS ${AIRPORT}`;

let state = {}; // aircraftId → { aircraftId, acType, destination, beaconCode, messageCount, lastSeen, messages:[] }
let selectedAc = null;
let searchQuery = '';
let seenMessages = new Set(); // Track message hashes to prevent duplicates

const acListEl = document.getElementById('ac-list');
const detailEl = document.getElementById('detail');
const statsEl  = document.getElementById('stats');
const statusEl = document.getElementById('status');
const searchEl = document.getElementById('ac-search');
const clearEl = document.getElementById('ac-search-clear');

// Generate unique hash for a message to deduplicate
function messageHash(msg) {
    return `${msg.aircraftId}|${msg.time}|${msg.type}|${msg.dataBody || ''}|${msg.gate || ''}|${msg.runway || ''}`;
}

// ── WebSocket ──────────────────────────────────────────────────
let ws = null;
function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/tdls/ws/${AIRPORT.toLowerCase()}`);

    ws.onopen = () => {
        statusEl.textContent = 'LIVE · last 12 h';
        statusEl.className = 'ok';
    };

    ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'snapshot') {
            handleSnapshot(msg.data);
        } else if (msg.type === 'new') {
            handleNewMessages(msg.data);
        }
    };

    ws.onclose = () => {
        if (mode !== 'live') return;
        statusEl.textContent = 'DISCONNECTED';
        statusEl.className = '';
        if (!window.idlePaused || !window.idlePaused()) setTimeout(() => { if (mode === 'live' && !ws) connect(); }, 5000);
        ws = null;
    };

    ws.onerror = () => ws.close();
}

function handleSnapshot(data) {
    state = {};
    seenMessages.clear();
    if (data.aircraft) {
        for (const ac of data.aircraft) {
            state[ac.aircraftId] = ac;
            // Track all messages in snapshot as already seen
            if (ac.messages) {
                for (const msg of ac.messages) {
                    seenMessages.add(messageHash(msg));
                }
            }
        }
    }
    renderAcList();
    if (selectedAc && state[selectedAc]) renderDetail(selectedAc);
    else if (selectedAc) { selectedAc = null; renderDetail(null); }
}

function handleNewMessages(messages) {
    const flashIds = new Set();
    for (const msg of messages) {
        const hash = messageHash(msg);
        // Skip if we've already seen this message
        if (seenMessages.has(hash)) continue;
        seenMessages.add(hash);

        const id = msg.aircraftId;
        if (!state[id]) {
            state[id] = {
                aircraftId: id,
                acType: msg.acType,
                destination: msg.destination,
                beaconCode: msg.beaconCode,
                messageCount: 0,
                lastSeen: msg.time,
                messages: []
            };
        }
        const ac = state[id];
        ac.messages.push(msg);
        ac.messageCount = ac.messages.length;
        ac.lastSeen = msg.time;
        if (msg.acType) ac.acType = msg.acType;
        if (msg.destination) ac.destination = msg.destination;
        if (msg.beaconCode) ac.beaconCode = msg.beaconCode;
        flashIds.add(id);
    }
    renderAcList(flashIds);
    if (selectedAc && flashIds.has(selectedAc)) renderDetail(selectedAc);
}

// ── Render aircraft list ───────────────────────────────────────
function renderAcList(flashIds) {
    let sorted = Object.values(state).sort((a, b) => {
        const ta = new Date(a.lastSeen).getTime();
        const tb = new Date(b.lastSeen).getTime();
        return tb - ta;
    });

    // Filter by search query
    const query = searchQuery.toLowerCase();
    if (query) {
        sorted = sorted.filter(ac =>
            ac.aircraftId.toLowerCase().includes(query) ||
            (ac.acType && ac.acType.toLowerCase().includes(query)) ||
            (ac.destination && ac.destination.toLowerCase().includes(query))
        );
    }

    const totalMsg = sorted.reduce((s, a) => s + a.messageCount, 0);
    statsEl.textContent = `${sorted.length} acft  •  ${totalMsg} msg`;

    const now = Date.now();
    const HISTORY_MS = 2 * 60 * 60 * 1000; // 2 hours
    let dividerInserted = false;

    acListEl.innerHTML = sorted.map(ac => {
        const sel = ac.aircraftId === selectedAc ? ' selected' : '';
        const flash = flashIds && flashIds.has(ac.aircraftId) ? ' flash' : '';
        const dest = ac.destination ? ` → ${ac.destination.replace(/^K/, '')}` : '';
        const ts = ac.lastSeen ? fmtTime(ac.lastSeen) : '';
        const age = ac.lastSeen ? now - new Date(ac.lastSeen).getTime() : Infinity;
        const hist = mode === 'live' && age > HISTORY_MS ? ' historical' : '';
        let prefix = '';
        if (hist && !dividerInserted) {
            dividerInserted = true;
            prefix = `<div class="ac-divider">HISTORICAL</div>`;
        }
        return `${prefix}<div class="ac-item${sel}${flash}${hist}" data-id="${ac.aircraftId}">
            <div class="callsign">${ac.aircraftId}<span class="badge">${ac.messageCount}</span></div>
            <div class="meta">${ac.acType || ''}${dest}</div>
            <div class="ts">${ts}</div>
        </div>`;
    }).join('');

    acListEl.querySelectorAll('.ac-item').forEach(el => {
        el.addEventListener('click', () => {
            selectedAc = el.dataset.id;
            renderAcList();
            renderDetail(selectedAc);
        });
    });
}

// ── Render message detail ──────────────────────────────────────
function renderDetail(aircraftId) {
    if (!aircraftId || !state[aircraftId]) {
        detailEl.innerHTML = '<div class="empty">Select an aircraft to view CPDLC messages</div>';
        return;
    }

    const ac = state[aircraftId];
    // Show messages newest first
    const msgs = [...ac.messages].reverse();

    detailEl.innerHTML = msgs.map(m => {
        if (m.type === 'CPDLC') return renderCpdlc(m);
        if (m.type === 'DEPART') return renderDepart(m);
        return '';
    }).join('');

    detailEl.scrollTop = 0;
}

function renderCpdlc(m) {
    const t = fmtTime(m.time);
    const subMsgs = parseCpdlcBody(m.dataBody || '');

    let metaParts = [];
    if (m.acType) metaParts.push(`<div class="field"><span>${m.acType}</span></div>`);
    if (m.beaconCode) metaParts.push(`<div class="field">BCN <span>${m.beaconCode}</span></div>`);
    if (m.cid) metaParts.push(`<div class="field">CID <span>${m.cid}</span></div>`);
    if (m.destination) metaParts.push(`<div class="field">→ <span>${m.destination}</span></div>`);

    return `<div class="msg-card">
        <div class="msg-header">
            <span class="msg-time">${t}</span>
            <span class="msg-type cpdlc">CPDLC</span>
        </div>
        ${metaParts.length ? `<div class="msg-meta">${metaParts.join('')}</div>` : ''}
        <div class="msg-body">${subMsgs.map(renderSubMsg).join('')}</div>
    </div>`;
}

function renderDepart(m) {
    const t = fmtTime(m.time);

    let gridItems = [];
    if (m.gate && m.gate !== 'N/A') gridItems.push({ label: 'GATE', value: m.gate });
    if (m.runway) gridItems.push({ label: 'RUNWAY', value: m.runway });
    if (m.destination) gridItems.push({ label: 'DESTINATION', value: m.destination });
    if (m.acType) gridItems.push({ label: 'TYPE', value: m.acType });
    if (m.beaconCode) gridItems.push({ label: 'BEACON', value: m.beaconCode });
    if (m.cid) gridItems.push({ label: 'CID', value: m.cid });

    let timeline = [];
    if (m.clearanceTime) timeline.push({ label: 'CLR', time: fmtTimeShort(m.clearanceTime) });
    if (m.taxiTime) timeline.push({ label: 'TAXI', time: fmtTimeShort(m.taxiTime) });
    if (m.takeoffTime) timeline.push({ label: 'T/O', time: fmtTimeShort(m.takeoffTime) });

    return `<div class="msg-card">
        <div class="msg-header">
            <span class="msg-time">${t}</span>
            <span class="msg-type depart">DEPARTURE</span>
        </div>
        <div class="depart-grid">
            ${gridItems.map(i => `<div><div class="label">${i.label}</div><div class="value">${i.value}</div></div>`).join('')}
        </div>
        ${timeline.length ? `<div class="depart-timeline">${timeline.map(s => `<div class="step">${s.label} <span class="t">${s.time}</span></div>`).join('')}</div>` : ''}
    </div>`;
}

// ── CPDLC body parser ──────────────────────────────────────────
// Each dataBody starts with a 3-digit sequence number (e.g. "001 ...", "005 ...")
// The sequence number is only at the very beginning — not mid-text.
function parseCpdlcBody(body) {
    if (!body) return [{ text: body, isPilot: false }];

    // Strip leading sequence number if present
    const seqMatch = body.match(/^(\d{3})\s/);
    const num = seqMatch ? seqMatch[1] : null;
    const text = seqMatch ? body.substring(seqMatch[0].length).trim() : body.trim();
    const isPilot = /PILOT\s+RESPONSE/i.test(text);
    return [{ num, text, isPilot }];
}

function renderSubMsg(sub) {
    if (sub.isPilot) {
        // Extract the response text after "PILOT RESPONSE - "
        const respMatch = sub.text.match(/PILOT\s+RESPONSE\s*-\s*(.*)/i);
        const resp = respMatch ? respMatch[1].trim() : sub.text;
        return `<div class="sub-msg">
            <span class="sub-num">${sub.num || ''}</span> <span class="pilot-response">PILOT RESPONSE — ${resp}</span>
        </div>`;
    }

    // Format clearance text — highlight key parts
    let text = sub.text || '';
    // Try to find the clearance portion
    const clrMatch = text.match(/(CLEARED TO .+)/i);
    if (clrMatch) {
        const before = text.substring(0, clrMatch.index);
        const clr = clrMatch[1];
        return `<div class="sub-msg">
            <span class="sub-num">${sub.num || ''}</span> ${escHtml(before)}
<span class="clearance">${escHtml(clr)}</span>
        </div>`;
    }

    return `<div class="sub-msg">
        <span class="sub-num">${sub.num || ''}</span> ${escHtml(text)}
    </div>`;
}

// ── Helpers ────────────────────────────────────────────────────
function fmtTime(iso) {
    if (!iso) return '';
    const s = new Date(iso).toISOString();
    return s.substring(5, 10).replace('-', '/') + ' ' + s.substring(11, 19) + 'Z';
}

function fmtTimeShort(iso) {
    if (!iso) return '';
    const s = new Date(iso).toISOString();
    return s.substring(11, 16);
}

function escHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Search ────────────────────────────────────────────────────
let searchTimer = null;
searchEl.addEventListener('input', (ev) => {
    searchQuery = ev.target.value;
    clearEl.style.display = searchQuery ? 'flex' : 'none';
    renderAcList();                       // instant feedback on what's already loaded
    // In history mode the answer may be on a day we haven't loaded, so ask the server.
    if (mode === 'history') {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(loadHistory, 400);
    }
});

clearEl.addEventListener('click', () => {
    searchEl.value = '';
    searchQuery = '';
    clearEl.style.display = 'none';
    renderAcList();
    searchEl.focus();
    if (mode === 'history') loadHistory();     // back to the airport's recent traffic
});

// ── Keyboard shortcuts ─────────────────────────────────────────
document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && selectedAc) {
        selectedAc = null;
        renderAcList();
        renderDetail(null);
    }
});

// ── Live / history mode ────────────────────────────────────────
function closeWs() { if (ws) { ws.onclose = null; ws.close(); ws = null; } }

let histSeq = 0;
async function loadHistory() {
    const seq = ++histSeq;
    // With a callsign the server searches EVERY day via its callsign index, so the day box is only
    // a narrowing option. Without one, "All days" shows the airport's most recent traffic (the
    // server scans newest-first and stops at the limit) rather than loading all 128 days.
    const q = searchQuery.trim();
    const useQuery = q.length >= 3;
    statusEl.textContent = 'loading history' + (useQuery ? ' · ' + q.toUpperCase() : '') + '…';
    statusEl.className = 'hist';
    state = {}; seenMessages.clear();
    renderAcList(); renderDetail(null);
    const u = new URL(location.href);
    u.searchParams.delete('date');
    u.searchParams.set('mode', 'history');
    history.replaceState(null, '', u);
    try {
        // Always all days. With a callsign the server resolves it through the callsign index;
        // without one it returns this airport's most recent traffic.
        const qs = new URLSearchParams({ airport: AIRPORT, limit: useQuery ? '2000' : '500' });
        if (useQuery) qs.set('q', q);
        const d = await (await fetch('/api/tdls/history?' + qs)).json();
        if (seq !== histSeq || mode !== 'history') return;
        // The API returns newest first; build the same per-aircraft state the live snapshot has.
        const msgs = (d.results || []).slice().reverse();
        for (const m of msgs) {
            const id = m.aircraftId;
            const ac = state[id] ||= { aircraftId: id, messageCount: 0, messages: [] };
            ac.messages.push(m);
            ac.messageCount = ac.messages.length;
            ac.lastSeen = m.time;
            if (m.acType) ac.acType = m.acType;
            if (m.destination) ac.destination = m.destination;
            if (m.beaconCode) ac.beaconCode = m.beaconCode;
        }
        statusEl.textContent = 'HISTORY · all days'
            + (useQuery ? ' · ' + q.toUpperCase() : ' · most recent')
            + (d.truncated ? ' (partial)' : '');
        renderAcList();
        autoSelectFromQuery();
    } catch { if (seq === histSeq) statusEl.textContent = 'ERROR'; }
}

// ?q=CALLSIGN (from the directory's callsign search) prefills the search and opens that aircraft.
function autoSelectFromQuery() {
    const q = _params.get('q');
    if (!q) return;
    searchEl.value = searchQuery = q; clearEl.style.display = 'flex';
    renderAcList();
    const ids = Object.keys(state).filter(id => id.toUpperCase().includes(q.toUpperCase()));
    if (ids.length === 1) { selectedAc = ids[0]; renderAcList(); renderDetail(selectedAc); }
    _params.delete('q');
}

function setMode(m) {
    mode = m;
    document.querySelectorAll('#modeToggle button').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
    selectedAc = null;
    if (m === 'history') { closeWs(); loadHistory(); }
    else {
        histSeq++;
        const u = new URL(location.href); u.searchParams.delete('date'); u.searchParams.delete('mode');
        history.replaceState(null, '', u);
        state = {}; seenMessages.clear(); renderAcList(); renderDetail(null);
        statusEl.textContent = 'connecting...'; statusEl.className = '';
        connect();
    }
}
document.getElementById('modeToggle').addEventListener('click', e => {
    const b = e.target.closest('button[data-mode]');
    if (b && b.dataset.mode !== mode) setMode(b.dataset.mode);
});

// ── Init ───────────────────────────────────────────────────────
window.idleOnPause = () => { closeWs(); };
window.idleOnResume = () => { if (mode === 'live' && !ws) connect(); };
setMode(mode);
if (mode === 'live') setTimeout(autoSelectFromQuery, 1500);
