/* ── NAS map ───────────────────────────────────────────────────────────────────
 * An overview browser over the fused NAS picture: SFDPS en route, STARS terminal
 * and ASDE-X surface, one entity per airframe, streamed viewport-bounded.
 *
 * Two things shape the whole file.
 *
 * ONE CANVAS, NOT MARKERS. A continental view holds up to the server's cap of
 * targets (3,000 by default, 10,000 on request). Leaflet markers are a DOM node
 * each and die well before that — the ASDE-X scope already struggles at a few
 * hundred. Everything here is drawn into a single canvas in its own Leaflet pane,
 * which is the same approach eram.js takes for history and velocity vectors.
 *
 * DEAD RECKONING, BECAUSE THE FEED IS NOT THE FRAME RATE. Positions arrive every
 * two seconds at best, and SFDPS itself only reports every twelve. Drawing only
 * on arrival makes every target jump; advancing each one along its own track
 * between updates is what makes the map look like it is moving rather than
 * stepping. Same formula as eram.js, and the same units trap: ground speed is
 * KNOTS, so one minute of travel is gs/3600 degrees of latitude.
 * ──────────────────────────────────────────────────────────────────────────── */

'use strict';

// ── Target store ───────────────────────────────────────────────────────────────
// id -> {lat, lon, alt, trk, gs, cls, cs, type, org, dst, owner, t, trail:[]}
const targets = new Map();

let shown = 0, matched = 0, truncated = false, total = 0, classCounts = {};

const CLASS_NAMES = ['EnRoute', 'Terminal', 'Surface', 'Vehicle', 'Untagged', 'Primary'];
const CLASS_COLOR = {
    EnRoute: '#4ec9ff',
    Terminal: '#7ee787',
    Surface: '#ffd166',
    Vehicle: '#4fd1c5',
    Untagged: '#9b8cff',
    Primary: '#5a6472',
};

// Dead reckoning is a lie that gets worse with time, so it is capped: past this
// a target is drawn where it was last actually reported. 60 s is five SFDPS
// cycles — beyond that the aircraft may well have turned.
const DR_MAX_MS = 60000;
// Labels are unreadable in a crowd and expensive to lay out, so they are
// suppressed above this many on screen however the checkbox is set.
const LABEL_MAX = 400;
const TRAIL_MIN_MS = 4000;   // don't record a trail dot more often than this

// ── Map ────────────────────────────────────────────────────────────────────────
const map = L.map('map', {
    zoomControl: true,
    attributionControl: false,
    worldCopyJump: true,
    minZoom: 3,
    maxZoom: 14,
}).setView([39.0, -97.0], 4);

// Same proxied CARTO basemap the scopes use, so there is no third-party tile
// dependency and no key in the page.
L.tileLayer('/basemap/dark_nolabels/{z}/{x}/{y}{r}.png', { maxZoom: 14 }).addTo(map);

// Weather sits under the traffic. The layer name is `nexrad-n0q-900913`, NOT
// `nexrad-n0q` — the short name is not in IEM's GetCapabilities at all and
// silently returns nothing, which cost this repo a debugging round once already.
map.createPane('nasWx');
map.getPane('nasWx').style.zIndex = 250;
map.createPane('nasTargets');
map.getPane('nasTargets').style.zIndex = 450;
map.getPane('nasTargets').style.pointerEvents = 'none';

let wxLayer = null;
function updateWx() {
    const on = document.getElementById('wx').checked;
    const op = +document.getElementById('wxop').value / 100;
    if (wxLayer) { map.removeLayer(wxLayer); wxLayer = null; }
    if (!on) return;
    wxLayer = L.tileLayer.wms('https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0q.cgi', {
        layers: 'nexrad-n0q-900913',
        format: 'image/png',
        transparent: true,
        opacity: op,
        pane: 'nasWx',
    }).addTo(map);
}
// IEM publishes a new composite every 5 minutes.
setInterval(() => { if (wxLayer) updateWx(); }, 5 * 60 * 1000);

// ── Canvas overlay ─────────────────────────────────────────────────────────────
const canvas = document.createElement('canvas');
canvas.style.position = 'absolute';
map.getPane('nasTargets').appendChild(canvas);
const cx = canvas.getContext('2d');
let dpr = 1;

function sizeCanvas() {
    const size = map.getSize();
    dpr = window.devicePixelRatio || 1;
    canvas.width = size.x * dpr;
    canvas.height = size.y * dpr;
    canvas.style.width = size.x + 'px';
    canvas.style.height = size.y + 'px';
    // The pane is positioned by Leaflet, so cancel its offset to keep the canvas
    // pinned to the viewport and let us draw in plain screen pixels.
    const topLeft = map.containerPointToLayerPoint([0, 0]);
    L.DomUtil.setPosition(canvas, topLeft);
}
map.on('move zoom resize zoomend viewreset moveend', () => { sizeCanvas(); paint(); });
sizeCanvas();

// ── Dead reckoning ─────────────────────────────────────────────────────────────
function displayPos(t, now) {
    const dt = Math.min(now - t.t, DR_MAX_MS);
    if (dt <= 0 || !t.gs || t.trk === null || t.trk === undefined) return [t.lat, t.lon];
    // gs is KNOTS: nautical miles per hour. Degrees of latitude per hour is gs/60,
    // so per second it is gs/3600 — the factor eram.js uses and the TBFM map once
    // got wrong by exactly 60.
    const nm = t.gs * (dt / 3600000);
    const rad = t.trk * Math.PI / 180;
    const dLat = nm / 60 * Math.cos(rad);
    const cosLat = Math.cos(t.lat * Math.PI / 180) || 1e-6;
    const dLon = nm / 60 * Math.sin(rad) / cosLat;
    return [t.lat + dLat, t.lon + dLon];
}

// ── Painting ───────────────────────────────────────────────────────────────────
let paintQueued = false;
let lastPaint = 0;
const PAINT_MIN_MS = 110;   // ~9 fps: enough for smooth motion, cheap enough for 3,000 targets

function paint() {
    if (paintQueued) return;
    paintQueued = true;
    requestAnimationFrame(() => {
        paintQueued = false;
        const now = performance.timeOrigin ? Date.now() : Date.now();
        if (now - lastPaint < PAINT_MIN_MS) return;
        lastPaint = now;
        draw(now);
    });
}
// Keep repainting while anything is moving, so dead reckoning is visible.
setInterval(paint, PAINT_MIN_MS);

const altSel = () => document.getElementById('alt').value;

function altOk(t) {
    const v = altSel();
    if (v === 'all') return true;
    const [lo, hi] = v.split('-').map(Number);
    const a = t.alt || 0;
    return a >= lo && a < hi;
}

function draw(now) {
    const w = canvas.width, h = canvas.height;
    cx.setTransform(1, 0, 0, 1, 0, 0);
    cx.clearRect(0, 0, w, h);
    cx.scale(dpr, dpr);

    const trailN = +document.getElementById('trail').value;
    const leaderMin = +document.getElementById('leader').value;
    const wantLabels = document.getElementById('labels').checked;
    const size = map.getSize();
    const pad = 40;

    // Count what will actually be drawn before deciding about labels, so the
    // threshold is about what is on screen and not about what the server sent.
    const vis = [];
    for (const t of targets.values()) {
        if (!altOk(t)) continue;
        const [lat, lon] = displayPos(t, now);
        const p = map.latLngToContainerPoint([lat, lon]);
        if (p.x < -pad || p.y < -pad || p.x > size.x + pad || p.y > size.y + pad) continue;
        vis.push([t, p, lat, lon]);
    }
    const labels = wantLabels && vis.length <= LABEL_MAX;

    // Trails first, so targets sit on top of their own history.
    if (trailN > 0) {
        for (const [t] of vis) {
            if (!t.trail.length) continue;
            const from = Math.max(0, t.trail.length - trailN);
            for (let i = from; i < t.trail.length; i++) {
                const q = map.latLngToContainerPoint(t.trail[i]);
                const age = (t.trail.length - i) / Math.max(1, trailN);
                cx.fillStyle = CLASS_COLOR[t.cls] || '#888';
                cx.globalAlpha = 0.5 * (1 - age) + 0.08;
                cx.fillRect(q.x - 0.75, q.y - 0.75, 1.5, 1.5);
            }
        }
        cx.globalAlpha = 1;
    }

    // Leaders.
    if (leaderMin > 0) {
        cx.lineWidth = 0.6;
        for (const [t, p, lat, lon] of vis) {
            if (!t.gs || t.trk === null) continue;
            const nm = t.gs * (leaderMin / 60);
            const rad = t.trk * Math.PI / 180;
            const cosLat = Math.cos(lat * Math.PI / 180) || 1e-6;
            const q = map.latLngToContainerPoint([
                lat + nm / 60 * Math.cos(rad),
                lon + nm / 60 * Math.sin(rad) / cosLat,
            ]);
            cx.strokeStyle = CLASS_COLOR[t.cls] || '#888';
            cx.globalAlpha = 0.45;
            cx.beginPath();
            cx.moveTo(p.x, p.y);
            cx.lineTo(q.x, q.y);
            cx.stroke();
        }
        cx.globalAlpha = 1;
    }

    // Targets.
    cx.lineWidth = 1;
    for (const [t, p] of vis) {
        const col = CLASS_COLOR[t.cls] || '#888';
        if (t.cls === 'Primary' || t.cls === 'Untagged') {
            // No identity: a dot, not an aeroplane. Drawing a delta here would
            // assert a heading and an aircraft that the data does not claim.
            cx.fillStyle = col;
            const r = t.cls === 'Primary' ? 1.1 : 1.6;
            cx.beginPath();
            cx.arc(p.x, p.y, r, 0, 6.283);
            cx.fill();
        } else if (t.cls === 'Vehicle') {
            cx.fillStyle = col;
            cx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
        } else {
            drawDelta(p.x, p.y, t.trk || 0, col, t.id === hoverId || t.id === selId);
        }
        if (labels && t.cs) {
            cx.fillStyle = '#cfd6de';
            cx.font = '9px Consolas, monospace';
            cx.fillText(t.cs, p.x + 6, p.y - 2);
            if (t.alt) {
                cx.fillStyle = '#8b94a2';
                cx.fillText(String(Math.round(t.alt / 100)).padStart(3, '0'), p.x + 6, p.y + 7);
            }
        }
    }
}

// A small filled triangle pointing along the track. 0 degrees is north, and
// canvas y grows downward, so the nose is at -y.
function drawDelta(x, y, trk, col, emphasised) {
    const r = emphasised ? 6 : 4;
    const a = trk * Math.PI / 180;
    const sin = Math.sin(a), cos = Math.cos(a);
    const pt = (dx, dy) => [x + dx * cos - dy * sin, y + dx * sin + dy * cos];
    const [x1, y1] = pt(0, -r);
    const [x2, y2] = pt(r * 0.62, r * 0.72);
    const [x3, y3] = pt(-r * 0.62, r * 0.72);
    cx.fillStyle = col;
    cx.beginPath();
    cx.moveTo(x1, y1);
    cx.lineTo(x2, y2);
    cx.lineTo(x3, y3);
    cx.closePath();
    cx.fill();
    if (emphasised) {
        cx.strokeStyle = '#ffffff';
        cx.lineWidth = 1;
        cx.stroke();
    }
}

// ── Stream ─────────────────────────────────────────────────────────────────────
let ws = null, wsTimer = null, lastMsg = 0;

function statusEl() { return document.getElementById('status'); }

function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/nas/ws`);

    ws.onopen = () => {
        statusEl().textContent = 'live';
        statusEl().className = 'ok';
        sendView(true);
    };
    ws.onmessage = ev => {
        lastMsg = Date.now();
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        apply(m);
        paint();
        renderCounts();
    };
    ws.onclose = () => {
        statusEl().textContent = 'reconnecting…';
        statusEl().className = 'bad';
        clearTimeout(wsTimer);
        wsTimer = setTimeout(connect, 3000);
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
}

function apply(m) {
    if (m.type === 'snapshot') targets.clear();
    const now = Date.now();

    for (const r of (m.add || [])) {
        const [id, lat, lon, alt, trk, gs, cls, cs, type, org, dst, owner] = r;
        const prev = targets.get(id);
        targets.set(id, {
            id, lat, lon, alt, trk, gs,
            cls: CLASS_NAMES[cls] || 'Primary',
            cs: cs || '', type: type || '', org: org || '', dst: dst || '', owner: owner || '',
            t: now,
            // An upsert (identity changed) keeps the trail: it is the same airframe.
            trail: prev ? prev.trail : [],
            trailT: prev ? prev.trailT : 0,
        });
    }
    for (const r of (m.upd || [])) {
        const [id, lat, lon, alt, trk, gs, cls] = r;
        const t = targets.get(id);
        if (!t) continue;
        if ((t.lat !== lat || t.lon !== lon) && now - t.trailT > TRAIL_MIN_MS) {
            t.trail.push([t.lat, t.lon]);
            if (t.trail.length > 24) t.trail.shift();
            t.trailT = now;
        }
        t.lat = lat; t.lon = lon; t.alt = alt; t.trk = trk; t.gs = gs;
        t.cls = CLASS_NAMES[cls] || t.cls;
        t.t = now;
    }
    for (const id of (m.del || [])) targets.delete(id);

    shown = m.shown ?? shown;
    matched = m.matched ?? matched;
    truncated = !!m.truncated;
    total = m.total ?? total;
    if (m.classes) classCounts = m.classes;
}

// The viewport is sent padded, so a pan reveals targets that are already here
// rather than a blank margin that fills in a tick later.
function sendView(force) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const b = map.getBounds().pad(0.35);
    const cls = [...document.querySelectorAll('.cls')].filter(c => c.checked).map(c => c.value);
    const q = document.getElementById('q').value.trim();
    const msg = {
        cmd: 'view',
        bbox: [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()],
        cap: +document.getElementById('cap').value,
        cls,
        q: q || undefined,
    };
    const key = JSON.stringify(msg);
    if (!force && key === sendView._last) return;
    sendView._last = key;
    ws.send(key);
}

let viewTimer = null;
function scheduleView() {
    clearTimeout(viewTimer);
    viewTimer = setTimeout(() => sendView(false), 250);
}
map.on('moveend zoomend', scheduleView);

// A silent socket looks identical to an empty sky, so say so rather than
// showing a frozen map as if it were current.
setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const age = Date.now() - lastMsg;
    if (lastMsg && age > 15000) {
        statusEl().textContent = `no data ${Math.round(age / 1000)}s`;
        statusEl().className = 'bad';
    } else if (lastMsg) {
        statusEl().textContent = 'live';
        statusEl().className = 'ok';
    }
}, 2000);

// ── Counts ─────────────────────────────────────────────────────────────────────
function renderCounts() {
    const el = document.getElementById('counts');
    el.innerHTML = `<b>${shown.toLocaleString()}</b> shown · ${matched.toLocaleString()} in view · `
                 + `<b>${total.toLocaleString()}</b> tracked`;
    document.getElementById('trunc').textContent = truncated
        ? `trimmed to the ${(+document.getElementById('cap').value).toLocaleString()} limit — zoom in or filter`
        : '';
    for (const n of document.querySelectorAll('.n')) {
        const v = classCounts[n.dataset.n];
        n.textContent = v === undefined ? '' : v.toLocaleString();
    }
}

// ── Hover ──────────────────────────────────────────────────────────────────────
let hoverId = null, selId = null;
const tip = document.getElementById('tip');

function pick(px, py) {
    const now = Date.now();
    let best = null, bestD = 12 * 12;
    for (const t of targets.values()) {
        if (!altOk(t)) continue;
        const [lat, lon] = displayPos(t, now);
        const p = map.latLngToContainerPoint([lat, lon]);
        const d = (p.x - px) * (p.x - px) + (p.y - py) * (p.y - py);
        // Identified traffic wins a tie: it is what someone is looking for, and a
        // primary return sitting on top of an airliner should not steal the hover.
        if (d < bestD || (d === bestD && best && !best.cs && t.cs)) { best = t; bestD = d; }
    }
    return best;
}

function fl(alt) {
    if (!alt) return '—';
    return alt >= 18000 ? 'FL' + String(Math.round(alt / 100)).padStart(3, '0')
                        : alt.toLocaleString() + ' ft';
}

map.getContainer().addEventListener('mousemove', ev => {
    const r = map.getContainer().getBoundingClientRect();
    const t = pick(ev.clientX - r.left, ev.clientY - r.top);
    if (!t) {
        if (hoverId !== null) { hoverId = null; tip.style.display = 'none'; paint(); }
        return;
    }
    if (t.id !== hoverId) { hoverId = t.id; paint(); }
    const name = t.cs || (t.cls === 'Primary' ? 'primary return' : 'untagged');
    const l2 = [t.type, fl(t.alt), t.gs ? t.gs + ' kt' : null].filter(Boolean).join(' · ');
    const l3 = [
        t.org || t.dst ? `${t.org || '?'} ▸ ${t.dst || '?'}` : null,
        t.owner || null,
        t.cls,
    ].filter(Boolean).join(' · ');
    tip.innerHTML = `<div class="t1">${esc(name)}</div>`
                  + (l2 ? `<div class="t2">${esc(l2)}</div>` : '')
                  + (l3 ? `<div class="t3">${esc(l3)}</div>` : '');
    tip.style.display = 'block';
    // Flip the tip before it leaves the window rather than after.
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let x = ev.clientX + 14, y = ev.clientY + 14;
    if (x + tw > window.innerWidth - 8) x = ev.clientX - tw - 14;
    if (y + th > window.innerHeight - 8) y = ev.clientY - th - 14;
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
});

map.getContainer().addEventListener('mouseleave', () => {
    hoverId = null;
    tip.style.display = 'none';
    paint();
});

// ── Detail panel ───────────────────────────────────────────────────────────────
const detail = document.getElementById('detail');
let detailTimer = null;

map.on('click', ev => {
    const p = map.latLngToContainerPoint(ev.latlng);
    const t = pick(p.x, p.y);
    if (!t) return;
    selId = t.id;
    paint();
    openDetail(t);
});

document.getElementById('dClose').addEventListener('click', () => {
    detail.classList.remove('open');
    selId = null;
    clearInterval(detailTimer);
    paint();
});

function openDetail(t) {
    detail.classList.add('open');
    document.getElementById('dTitle').textContent = t.cs || t.cls;
    const body = document.getElementById('dBody');

    // What the stream already gave us renders immediately; the cross-source
    // picture is fetched behind it. An untagged return has no callsign, so there
    // is nothing to look up and the panel says so instead of spinning.
    body.innerHTML = rows('TARGET', [
        ['Class', t.cls],
        ['Type', t.type],
        ['Altitude', fl(t.alt)],
        ['Ground speed', t.gs ? t.gs + ' kt' : null],
        ['Track', t.trk !== null ? String(t.trk).padStart(3, '0') + '°' : null],
        ['Route', t.org || t.dst ? `${t.org || '?'} ▸ ${t.dst || '?'}` : null],
        ['Ownership', t.owner],
    ]) + (t.cs ? '<div class="d-empty">loading…</div>'
               : '<div class="d-sec">NO IDENTITY</div><div class="d-empty">An uncorrelated '
                 + 'radar return. Nothing else in the NAS knows what this is.</div>');

    clearInterval(detailTimer);
    if (!t.cs) return;
    const load = () => fetchDetail(t.cs, t.id);
    load();
    detailTimer = setInterval(load, 8000);
}

async function fetchDetail(cs, id) {
    try {
        const r = await fetch('/api/track/' + encodeURIComponent(cs));
        if (!r.ok) throw new Error(r.status);
        const d = await r.json();
        if (selId !== id) return;   // the user moved on while this was in flight
        renderDetail(d);
    } catch {
        if (selId === id) {
            const el = document.querySelector('#dBody .d-empty');
            if (el) el.textContent = 'detail unavailable';
        }
    }
}

function renderDetail(d) {
    const t = targets.get(selId);
    const sf = (d.sfdps || [])[0] || {};
    const body = document.getElementById('dBody');
    // These are the SFDPS projection's own abbreviations (acType, dest, assignedAlt, rules,
    // status, sectorFreq), checked against the live endpoint rather than assumed: a wrong
    // name renders as a MISSING ROW, not an error, so the panel would just look sparse. Same
    // shape as the modeSCode/modeS slip that made a fusion measurement report zero Mode S.
    let html = rows('TARGET', [
        ['Class', t ? t.cls : null],
        ['Type', sf.acType || (t && t.type)],
        ['Registration', sf.registration],
        ['Altitude', t ? fl(t.alt) : null],
        ['Ground speed', t && t.gs ? t.gs + ' kt' : null],
        ['Squawk', sf.squawk],
    ]);

    // controllingTracon is the real TRACON id for an SFDPS NAS code (ORT -> C90) and is null
    // for an ARTCC sector, which is exactly when the raw facility is the right thing to show.
    const fac = sf.controllingTracon || sf.controllingFacility;
    html += rows('FLIGHT', [
        ['Route', (sf.origin || t?.org || '?') + ' ▸ ' + (sf.dest || t?.dst || '?')],
        ['Assigned', sf.assignedAlt ? fl(sf.assignedAlt) : null],
        ['Rules', sf.rules],
        ['Status', sf.status],
        ['Controller', fac
            ? fac + (sf.controllingSector ? '/' + sf.controllingSector : '')
              + (sf.sectorFreq ? ' · ' + sf.sectorFreq : '')
            : (t && t.owner)],
        ['Handoff', sf.handoffReceivingMapped || sf.handoffReceiving],
    ]);

    if (sf.route) html += '<div class="d-sec">FILED ROUTE</div>'
                       + `<div class="d-route">${esc(sf.route)}</div>`;

    // Flow restrictions, from whichever source has them. These are the reason a
    // fused map beats a position feed: metering and EDCT live nowhere near SFDPS.
    const flow = [];
    if (d.tbfm) {
        const b = d.tbfm;
        if (b.delayMin) flow.push(['Metering hold', `${b.delayMin.toFixed(1)} min`
            + (b.holdCtr ? ` (${b.holdCtr}${b.holdPoint ? '/' + b.holdPoint : ''})` : '')]);
        if (b.point) flow.push(['Meter point', b.point]);
        if (b.meterFix && b.meterFix !== b.point) flow.push(['Meter fix', b.meterFix]);
        if (b.tracon) flow.push(['Metering TRACON', b.tracon]);
        if (b.frozen) flow.push(['Schedule', 'frozen']);
        if (b.rwy) flow.push(['Metered runway', b.rwy]);
    }
    if (d.edct) flow.push(['EDCT', String(d.edct)]);
    if (d.tfms) {
        const f = d.tfms;
        if (f.status) flow.push(['TFMS status', f.status]);
        // TFMS calls it the boundary fix; it is the NAS entry point for an inbound.
        if (f.boundaryFix) flow.push(['Boundary fix', f.boundaryFix]);
        if (f.coordinationFix) flow.push(['Coordination fix', f.coordinationFix]);
    }
    if (flow.length) html += rows('FLOW', flow);

    const terminal = (d.tais || [])[0];
    if (terminal) html += rows('TERMINAL', [
        ['Facility', terminal.facility],
        ['Owner', terminal.owner],
        ['Scratchpad', [terminal.sp1, terminal.sp2].filter(Boolean).join(' ') || null],
        ['Entry ▸ exit', terminal.entryFix || terminal.exitFix
            ? `${terminal.entryFix || '?'} ▸ ${terminal.exitFix || '?'}` : null],
    ]);

    const surf = (d.asdex || [])[0];
    if (surf) html += rows('SURFACE', [
        ['Airport', surf.airport],
        ['Ground speed', surf.track && surf.track.spdKts !== null
            ? surf.track.spdKts + ' kt' : null],
    ]);

    const cs = (t && t.cs) || d.callsign;
    html += '<div class="d-sec">ELSEWHERE</div>'
          + `<div class="d-row"><a href="/track/${encodeURIComponent(cs)}">Track a Flight &rarr;</a></div>`;

    body.innerHTML = html;
}

function rows(title, pairs) {
    const live = pairs.filter(([, v]) => v !== null && v !== undefined && v !== '');
    if (!live.length) return '';
    return `<div class="d-sec">${esc(title)}</div>`
         + live.map(([k, v]) => `<div class="d-row"><span class="k">${esc(k)}</span>`
                              + `<span class="v">${esc(String(v))}</span></div>`).join('');
}

// Everything in the readouts comes from the feed, and a callsign is free text
// as far as this page is concerned — so it is escaped, not interpolated raw.
// Same reason the STARS picker renders its ?notice= with textContent.
function esc(s) {
    return String(s).replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── Controls ───────────────────────────────────────────────────────────────────
for (const el of document.querySelectorAll('.cls, #cap')) {
    el.addEventListener('change', () => { sendView(true); renderCounts(); });
}
for (const id of ['trail', 'leader', 'labels', 'alt']) {
    document.getElementById(id).addEventListener('change', paint);
}
for (const id of ['wx', 'wxop']) {
    document.getElementById(id).addEventListener('change', updateWx);
}

const qEl = document.getElementById('q');
let qTimer = null;
qEl.addEventListener('input', () => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => sendView(true), 300);
});
document.getElementById('qclear').addEventListener('click', () => {
    qEl.value = '';
    sendView(true);
});

document.getElementById('ctlToggle').addEventListener('click', () => {
    document.getElementById('ctl').classList.toggle('open');
});

// Deep link: /nas?q=UAL1&lat=..&lon=..&z=..
const qs = new URLSearchParams(location.search);
if (qs.get('q')) qEl.value = qs.get('q');
const qlat = parseFloat(qs.get('lat')), qlon = parseFloat(qs.get('lon'));
if (Number.isFinite(qlat) && Number.isFinite(qlon)) {
    map.setView([qlat, qlon], parseInt(qs.get('z') || '7', 10));
}

connect();
renderCounts();
