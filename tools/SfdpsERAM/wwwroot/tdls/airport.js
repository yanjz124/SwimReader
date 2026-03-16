const AIRPORT = location.pathname.split('/').pop().toUpperCase();
document.getElementById('airport-title').textContent = `TDLS  ${AIRPORT}`;
document.title = `TDLS ${AIRPORT} | swim.vncrcc.org`;

let state = {}; // aircraftId → { aircraftId, acType, destination, beaconCode, messageCount, lastSeen, messages:[] }
let selectedAc = null;

const acListEl = document.getElementById('ac-list');
const detailEl = document.getElementById('detail');
const statsEl  = document.getElementById('stats');
const statusEl = document.getElementById('status');

// ── WebSocket ──────────────────────────────────────────────────
let ws = null;
function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/tdls/ws/${AIRPORT.toLowerCase()}`);

    ws.onopen = () => {
        statusEl.textContent = 'LIVE';
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
        statusEl.textContent = 'DISCONNECTED';
        statusEl.className = '';
        if (!window.idlePaused || !window.idlePaused()) setTimeout(connect, 5000);
    };

    ws.onerror = () => ws.close();
}

function handleSnapshot(data) {
    state = {};
    if (data.aircraft) {
        for (const ac of data.aircraft) {
            state[ac.aircraftId] = ac;
        }
    }
    renderAcList();
    if (selectedAc && state[selectedAc]) renderDetail(selectedAc);
    else if (selectedAc) { selectedAc = null; renderDetail(null); }
}

function handleNewMessages(messages) {
    const flashIds = new Set();
    for (const msg of messages) {
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
    const sorted = Object.values(state).sort((a, b) => {
        const ta = new Date(a.lastSeen).getTime();
        const tb = new Date(b.lastSeen).getTime();
        return tb - ta;
    });

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
        const hist = age > HISTORY_MS ? ' historical' : '';
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

// ── Init ───────────────────────────────────────────────────────
window.idleOnPause = () => { if (ws) { ws.onclose = null; ws.close(); ws = null; } };
window.idleOnResume = () => { connect(); };
connect();
