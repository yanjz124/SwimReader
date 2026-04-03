const HALO_RADIUS = 14; // px — match the halo circle radius for click + hover detection

// ── Crosshair cursor + proximity halo ───────────────────────────────────────
const ch = document.getElementById('crosshair');
let haloTid = null; // trackId of currently highlighted halo

document.addEventListener('mousemove', e => {
    ch.style.left = e.clientX + 'px';
    ch.style.top  = e.clientY + 'px';
    ch.style.display = 'block';

    // Proximity halo: show halo on nearest marker within radius
    if (typeof markers === 'undefined') return;
    let bestTid = null, bestDist = Infinity;
    for (const [tid, marker] of Object.entries(markers)) {
        const el = marker.getElement();
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        const dist = Math.hypot(e.clientX - (rect.left + 9), e.clientY - (rect.top + 9));
        if (dist < HALO_RADIUS && dist < bestDist) { bestDist = dist; bestTid = tid; }
    }
    if (bestTid !== haloTid) {
        // Remove old halo
        if (haloTid) {
            const old = markers[haloTid]?.getElement()?.querySelector('.halo');
            if (old) old.style.opacity = '0';
        }
        // Show new halo
        if (bestTid) {
            const halo = markers[bestTid]?.getElement()?.querySelector('.halo');
            if (halo) halo.style.opacity = '1';
        }
        haloTid = bestTid;
    }
});
document.addEventListener('mouseleave', () => {
    ch.style.display = 'none';
    if (haloTid) {
        const old = markers[haloTid]?.getElement()?.querySelector('.halo');
        if (old) old.style.opacity = '0';
        haloTid = null;
    }
});

// ── Map rotation ────────────────────────────────────────────────────────────
let mapRotation = 0; // degrees, 360=north-up
const rotInput = document.getElementById('rot');
function applyRotation(deg) {
    mapRotation = ((deg % 360) + 360) % 360;
    // 360 = north-up (no rotation). Rotation = -(360 - value) = value - 360
    const cssAngle = mapRotation === 360 ? 0 : -mapRotation;
    document.getElementById('map').style.transform = `rotate(${cssAngle}deg)`;
    // Counter-rotate data blocks so text stays upright
    document.querySelectorAll('.db').forEach(el => {
        el.style.transform = `rotate(${-cssAngle}deg)`;
    });
}
rotInput.addEventListener('input', () => applyRotation(parseInt(rotInput.value) || 360));

// ── Font size adjustment ───────────────────────────────────────────────────
let dbFontSize = 15;
const fontInput = document.getElementById('font-size');
fontInput.addEventListener('input', () => {
    dbFontSize = parseInt(fontInput.value) || 13;
    // Invalidate all hashes so next batch re-creates icons with new font size
    for (const tid of Object.keys(hashes)) hashes[tid] = '';
});

// ── Data block field toggles ────────────────────────────────────────────────
let dbShowAlt  = true;   // Field D: Altitude
let dbShowType = true;   // Field F: Aircraft type
let dbShowSens = false;  // Field E: Sensors (FUS/CST)
let dbShowCat  = false;  // Field G: Wake category
let dbShowFix  = true;   // Field H: Fix/destination
let dbShowVel  = true;   // Field I: Velocity
let dbToggleVer = 0;     // bumped on any toggle change to invalidate hashes

// Restore from localStorage
try {
    const saved = JSON.parse(localStorage.getItem('asdex-db-toggles') || '{}');
    if (saved.alt  !== undefined) dbShowAlt  = saved.alt;
    if (saved.type !== undefined) dbShowType = saved.type;
    if (saved.sens !== undefined) dbShowSens = saved.sens;
    if (saved.cat  !== undefined) dbShowCat  = saved.cat;
    if (saved.fix  !== undefined) dbShowFix  = saved.fix;
    if (saved.vel  !== undefined) dbShowVel  = saved.vel;
} catch(e) {}

function saveDbToggles() {
    localStorage.setItem('asdex-db-toggles', JSON.stringify({
        alt: dbShowAlt, type: dbShowType, sens: dbShowSens,
        cat: dbShowCat, fix: dbShowFix, vel: dbShowVel
    }));
    dbToggleVer++;
    // Invalidate all hashes so icons rebuild
    for (const tid of Object.keys(hashes)) hashes[tid] = '';
}

// Toggle button wiring
const dbTogMap = { alt: () => dbShowAlt, type: () => dbShowType, sens: () => dbShowSens, cat: () => dbShowCat, fix: () => dbShowFix, vel: () => dbShowVel };
const dbTogSet = { alt: v => dbShowAlt=v, type: v => dbShowType=v, sens: v => dbShowSens=v, cat: v => dbShowCat=v, fix: v => dbShowFix=v, vel: v => dbShowVel=v };
document.querySelectorAll('.db-tog').forEach(btn => {
    const f = btn.dataset.field;
    if (dbTogMap[f]()) btn.classList.add('on');
    btn.addEventListener('click', () => {
        const nv = !dbTogMap[f]();
        dbTogSet[f](nv);
        btn.classList.toggle('on', nv);
        saveDbToggles();
    });
});

// Wake category mapping (RECAT A-F → CRC display letter)
function wakeToCategory(wake, acType) {
    if (!wake && !acType) return '';
    // Check B757 first
    if (acType && /^B75[237]$/.test(acType)) return 'B';
    if (!wake) return '';
    switch (wake) {
        case 'A': return 'J'; // Super → J (Jumbo)
        case 'B': return 'H'; // Upper Heavy → H
        case 'C': return 'H'; // Lower Heavy → H
        case 'D': return 'L'; // Upper Large → L
        case 'E': return 'L'; // Lower Large → L
        case 'F': return 'L'; // Upper Small → L
        case 'G': return 'S'; // Lower Small → S
        case 'H': return 'S'; // Light → S
        default: return wake.length === 1 ? wake : '';
    }
}

// ── Day/Night toggle ────────────────────────────────────────────────────────
const dnBtn = document.getElementById('dn-toggle');
dnBtn.addEventListener('click', () => {
    isNightMode = !isNightMode;
    asdexColors = isNightMode ? ASDEX_NIGHT : ASDEX_DAY;
    dnBtn.textContent = isNightMode ? 'NIGHT' : 'DAY';
    // Restyle surface polygons
    const bg = asdexColors.bg;
    document.getElementById('map').style.background = bg;
    document.body.style.background = bg;
    if (surfaceLayer) {
        surfaceLayer.setStyle(feature => {
            const sfc = (feature.properties && feature.properties.asdex) || 'structure';
            return {
                fillColor: asdexColors[sfc] || asdexColors.structure,
                fillOpacity: 1,
                color: asdexColors[sfc] || asdexColors.structure,
                weight: 0.5, opacity: 1
            };
        });
    }
});

// ── Fullscreen toggle ───────────────────────────────────────────────────────
const fsBtn = document.getElementById('fs-toggle');
fsBtn.addEventListener('click', () => {
    if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen();
    } else {
        document.exitFullscreen();
    }
});
document.addEventListener('fullscreenchange', () => {
    fsBtn.textContent = document.fullscreenElement ? 'EXIT' : 'FULL';
});

// ── Airport from URL ─────────────────────────────────────────────────────────
const pathParts = window.location.pathname.split('/').filter(Boolean);
const AIRPORT = (pathParts[pathParts.length - 1] || 'UNKN').toUpperCase();
document.getElementById('airport-id').textContent = AIRPORT;
document.title = 'ASDE-X ' + AIRPORT;

// ── Leaflet map (right-click drag to pan) ───────────────────────────────────
const map = L.map('map', {
    center: [38.85, -77.04],
    zoom: 14,
    zoomControl: false,
    zoomSnap: 0.25,
    zoomDelta: 0.25,
    attributionControl: false,
    dragging: false,
    doubleClickZoom: false
});

// Right-click drag panning
(function() {
    let panning = false, startX, startY;
    const el = map.getContainer();
    el.addEventListener('contextmenu', e => e.preventDefault());
    el.addEventListener('mousedown', e => {
        if (e.button !== 2) return;
        panning = true;
        startX = e.clientX;
        startY = e.clientY;
        e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
        if (!panning) return;
        const dx = e.clientX - startX, dy = e.clientY - startY;
        startX = e.clientX; startY = e.clientY;
        map.panBy([-dx, -dy], { animate: false });
    });
    document.addEventListener('mouseup', e => {
        if (e.button === 2) panning = false;
    });
})();

// ── ASDEX surface colors (vNAS spec) ────────────────────────────────────────
const ASDEX_NIGHT = {
    bg:        '#393939',
    runway:    'rgb(0,0,0)',
    taxiway:   'rgb(17,39,80)',
    apron:     'rgb(18,55,97)',
    structure: 'rgb(34,63,103)'
};
const ASDEX_DAY = {
    bg:        '#005C73',
    runway:    'rgb(0,0,0)',
    taxiway:   'rgb(47,47,47)',
    apron:     'rgb(73,73,73)',
    structure: 'rgb(100,100,100)'
};
let asdexColors = ASDEX_NIGHT;
let isNightMode = true;
let surfaceLayer = null;

// ── Load airport surface GeoJSON ────────────────────────────────────────────
let surfaceLoaded = false;
fetch(`/asdex/maps/${AIRPORT}.geojson`)
    .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(geojson => {
        surfaceLayer = L.geoJSON(geojson, {
            style: feature => {
                const sfc = (feature.properties && feature.properties.asdex) || 'structure';
                return {
                    fillColor: asdexColors[sfc] || asdexColors.structure,
                    fillOpacity: 1,
                    color: asdexColors[sfc] || asdexColors.structure,
                    weight: 0.5,
                    opacity: 1
                };
            },
            interactive: false
        }).addTo(map);
        map.fitBounds(surfaceLayer.getBounds(), { padding: [20, 20] });
        surfaceLoaded = true;
        centeredOnce = true;
    })
    .catch(() => {
        // No surface map — fall back to CartoDB dark tiles
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
            subdomains: 'abcd', maxZoom: 20
        }).addTo(map);
    });

// ── State ────────────────────────────────────────────────────────────────────
const markers  = {};   // trackId → L.marker
const hashes   = {};   // trackId → hash string for change detection
const trackData = {};  // trackId → latest track object (for flight list)
let   trackCount = 0;
let   centeredOnce = false;

// ── Data block positions (8 compass points) ─────────────────────────────────
const DB_ORDERS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const DB_POS = {
    N:  { wl: -5,  wt: -43, lx: 9,   ly: -16 },
    NE: { wl: 26,  wt: -24, lx: 26,  ly: -8 },
    E:  { wl: 26,  wt: -7,  lx: 26,  ly: 9 },
    SE: { wl: 26,  wt: 10,  lx: 26,  ly: 26 },
    S:  { wl: -5,  wt: 33,  lx: 9,   ly: 30 },
    SW: { wl: -83, wt: 10,  lx: -8,  ly: 26 },
    W:  { wl: -83, wt: -7,  lx: -8,  ly: 9 },
    NW: { wl: -83, wt: -24, lx: -8,  ly: -8 },
};
const dbPositions = {};  // trackId → 'N'|'NE'|..., default NE
const hiddenDbs = new Set();  // trackIds with hidden data blocks

// ── LDR DIR (numpad data block positioning) ─────────────────────────────────
// Numpad digit → compass direction (same layout as ERAM)
const NUMPAD_TO_DIR = { 1:'SW', 2:'S', 3:'SE', 4:'W', 5:'NE', 6:'E', 7:'NW', 8:'N', 9:'NE' };
let pendingLdrDir = null;  // null or digit 1-9

const ldrOverlay = document.getElementById('ldr-dir-overlay');
const ldrValueEl = document.getElementById('ldr-dir-value');

function showLdrOverlay(digit) {
    ldrValueEl.textContent = digit + '_';
    ldrOverlay.style.display = 'block';
}
function hideLdrOverlay() {
    pendingLdrDir = null;
    ldrOverlay.style.display = 'none';
}

document.addEventListener('keydown', e => {
    // Don't intercept if typing in an input field
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'Escape') {
        if (pendingLdrDir !== null) { hideLdrOverlay(); e.preventDefault(); }
        return;
    }
    const digit = parseInt(e.key);
    if (digit >= 1 && digit <= 9) {
        pendingLdrDir = digit;
        showLdrOverlay(digit);
        e.preventDefault();
    }
});

// ── Data block drag (snap to 8 compass positions) ──────────────────────────
let dragTid = null, dragOrigin = null;

document.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    const db = e.target.closest('.db');
    if (!db) return;
    const icon = e.target.closest('.ac-icon[data-tid]');
    if (!icon) return;
    dragTid = icon.dataset.tid;
    const m = markers[dragTid];
    if (!m) { dragTid = null; return; }
    const el = m.getElement();
    if (!el) { dragTid = null; return; }
    const rect = el.getBoundingClientRect();
    dragOrigin = { x: rect.left + 9, y: rect.top + 9 };
    e.preventDefault();
    e.stopPropagation();
});

document.addEventListener('mousemove', e => {
    if (!dragTid) return;
    const sdx = e.clientX - dragOrigin.x;
    const sdy = e.clientY - dragOrigin.y;
    // Convert screen delta to icon-local (undo CSS rotation)
    const rad = mapRotation * Math.PI / 180;
    const ldx = sdx * Math.cos(rad) + sdy * Math.sin(rad);
    const ldy = -sdx * Math.sin(rad) + sdy * Math.cos(rad);
    // Snap to nearest octant
    let angle = Math.atan2(ldx, -ldy) * 180 / Math.PI;
    if (angle < 0) angle += 360;
    const idx = Math.round(angle / 45) % 8;
    const dir = DB_ORDERS[idx];
    if (dbPositions[dragTid] === dir) return;
    dbPositions[dragTid] = dir;
    // Update DOM live
    const iconEl = document.querySelector(`.ac-icon[data-tid="${dragTid}"]`);
    if (!iconEl) return;
    const pos = DB_POS[dir];
    const wrap = iconEl.querySelector('.db-wrap');
    if (wrap) { wrap.style.left = pos.wl + 'px'; wrap.style.top = pos.wt + 'px'; }
    const line = iconEl.querySelector('.ldr line');
    if (line) { line.setAttribute('x2', pos.lx); line.setAttribute('y2', pos.ly); }
});

document.addEventListener('mouseup', () => { dragTid = null; dragOrigin = null; });

// ── Touch support: tap symbol to toggle DB, drag DB to reposition ────────────
let touchDragTid = null, touchOrigin = null, touchMoved = false;

document.addEventListener('touchstart', e => {
    const touch = e.touches[0];
    // Drag: start on data block
    const db = touch.target.closest('.db');
    if (db) {
        const icon = touch.target.closest('.ac-icon[data-tid]');
        if (!icon) return;
        touchDragTid = icon.dataset.tid;
        const m = markers[touchDragTid];
        if (!m) { touchDragTid = null; return; }
        const el = m.getElement();
        if (!el) { touchDragTid = null; return; }
        const rect = el.getBoundingClientRect();
        touchOrigin = { x: rect.left + 9, y: rect.top + 9 };
        touchMoved = false;
        e.preventDefault();
        return;
    }
    // Tap: on target symbol — track for toggle on touchend
    const sym = touch.target.closest('svg.sym');
    if (sym) { touchMoved = false; }
}, { passive: false });

document.addEventListener('touchmove', e => {
    touchMoved = true;
    if (!touchDragTid) return;
    const touch = e.touches[0];
    const sdx = touch.clientX - touchOrigin.x;
    const sdy = touch.clientY - touchOrigin.y;
    const rad = mapRotation * Math.PI / 180;
    const ldx = sdx * Math.cos(rad) + sdy * Math.sin(rad);
    const ldy = -sdx * Math.sin(rad) + sdy * Math.cos(rad);
    let angle = Math.atan2(ldx, -ldy) * 180 / Math.PI;
    if (angle < 0) angle += 360;
    const idx = Math.round(angle / 45) % 8;
    const dir = DB_ORDERS[idx];
    if (dbPositions[touchDragTid] === dir) return;
    dbPositions[touchDragTid] = dir;
    const iconEl = document.querySelector(`.ac-icon[data-tid="${touchDragTid}"]`);
    if (!iconEl) return;
    const pos = DB_POS[dir];
    const wrap = iconEl.querySelector('.db-wrap');
    if (wrap) { wrap.style.left = pos.wl + 'px'; wrap.style.top = pos.wt + 'px'; }
    const line = iconEl.querySelector('.ldr line');
    if (line) { line.setAttribute('x2', pos.lx); line.setAttribute('y2', pos.ly); }
    e.preventDefault();
}, { passive: false });

document.addEventListener('touchend', e => {
    if (touchDragTid) { touchDragTid = null; touchOrigin = null; return; }
    if (touchMoved) return;
    const touch = e.changedTouches[0];
    // Use proximity-based detection (same as click handler)
    let bestTid = null, bestDist = Infinity;
    for (const [tid, marker] of Object.entries(markers)) {
        const el = marker.getElement();
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        const cx = rect.left + 9, cy = rect.top + 9;
        const dist = Math.hypot(touch.clientX - cx, touch.clientY - cy);
        if (dist < HALO_RADIUS && dist < bestDist) { bestDist = dist; bestTid = tid; }
    }
    if (!bestTid) {
        if (pendingLdrDir !== null) hideLdrOverlay();
        return;
    }
    // LDR DIR mode: apply numpad position instead of toggling visibility
    if (pendingLdrDir !== null) {
        const dir = NUMPAD_TO_DIR[pendingLdrDir];
        dbPositions[bestTid] = dir;
        hiddenDbs.delete(bestTid);
        hashes[bestTid] = '';
        const iconEl = markers[bestTid]?.getElement()?.querySelector('.ac-icon');
        if (iconEl) {
            const pos = DB_POS[dir];
            const wrap = iconEl.querySelector('.db-wrap');
            if (wrap) { wrap.style.left = pos.wl + 'px'; wrap.style.top = pos.wt + 'px'; wrap.style.display = ''; }
            const line = iconEl.querySelector('.ldr line');
            if (line) { line.setAttribute('x2', pos.lx); line.setAttribute('y2', pos.ly); }
            const ldr = iconEl.querySelector('.ldr');
            if (ldr) ldr.style.display = '';
        }
        hideLdrOverlay();
        e.preventDefault();
        return;
    }
    // Normal mode: toggle data block visibility
    if (hiddenDbs.has(bestTid)) hiddenDbs.delete(bestTid);
    else hiddenDbs.add(bestTid);
    const hidden = hiddenDbs.has(bestTid);
    const icon = markers[bestTid].getElement()?.querySelector('.ac-icon');
    if (!icon) return;
    const wrap = icon.querySelector('.db-wrap');
    const ldr = icon.querySelector('.ldr');
    if (wrap) wrap.style.display = hidden ? 'none' : '';
    if (ldr) ldr.style.display = hidden ? 'none' : '';
    e.preventDefault();
});

// ── Left-click target to toggle data block (or apply LDR DIR) ──────────────
// Bypass DOM hit-testing entirely: on any click, find the nearest marker center
// within the halo radius. This works regardless of overlapping data blocks.
document.addEventListener('click', e => {
    // Don't toggle if clicking UI elements
    if (e.target.closest('#statusbar, #gatecode-popup, #flight-list, #holdbar-panel')) return;

    const clickPt = { x: e.clientX, y: e.clientY };
    let bestTid = null, bestDist = Infinity;

    for (const [tid, marker] of Object.entries(markers)) {
        const el = marker.getElement();
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        // Marker anchor is at (9, 9) within the icon
        const cx = rect.left + 9;
        const cy = rect.top + 9;
        const dx = clickPt.x - cx;
        const dy = clickPt.y - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < HALO_RADIUS && dist < bestDist) {
            bestDist = dist;
            bestTid = tid;
        }
    }

    if (!bestTid) {
        // Clicked empty space — cancel LDR DIR if active
        if (pendingLdrDir !== null) hideLdrOverlay();
        return;
    }

    // LDR DIR mode: apply numpad position instead of toggling visibility
    if (pendingLdrDir !== null) {
        const dir = NUMPAD_TO_DIR[pendingLdrDir];
        dbPositions[bestTid] = dir;
        // Also ensure the data block is visible
        hiddenDbs.delete(bestTid);
        // Invalidate hash so icon rebuilds with new position
        hashes[bestTid] = '';
        // Update DOM immediately
        const iconEl = markers[bestTid]?.getElement()?.querySelector('.ac-icon');
        if (iconEl) {
            const pos = DB_POS[dir];
            const wrap = iconEl.querySelector('.db-wrap');
            if (wrap) { wrap.style.left = pos.wl + 'px'; wrap.style.top = pos.wt + 'px'; wrap.style.display = ''; }
            const line = iconEl.querySelector('.ldr line');
            if (line) { line.setAttribute('x2', pos.lx); line.setAttribute('y2', pos.ly); }
            const ldr = iconEl.querySelector('.ldr');
            if (ldr) ldr.style.display = '';
        }
        hideLdrOverlay();
        return;
    }

    // Normal mode: toggle data block visibility
    if (hiddenDbs.has(bestTid)) hiddenDbs.delete(bestTid);
    else hiddenDbs.add(bestTid);
    const hidden = hiddenDbs.has(bestTid);
    const icon = markers[bestTid].getElement()?.querySelector('.ac-icon');
    if (!icon) return;
    const wrap = icon.querySelector('.db-wrap');
    const ldr = icon.querySelector('.ldr');
    if (wrap) wrap.style.display = hidden ? 'none' : '';
    if (ldr) ldr.style.display = hidden ? 'none' : '';
});

const connEl  = document.getElementById('conn');
const cntEl   = document.getElementById('track-count');

// ── Gate code configuration popup ───────────────────────────────────────────
const gcPopup = document.getElementById('gatecode-popup');
const gcBody = document.getElementById('gc-body');
const gcAirportEl = document.getElementById('gc-airport');

function gcAddRow(fix = '', code = '') {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><input class="gc-fix" value="${fix}" placeholder="FIX"></td>` +
        `<td><input class="gc-code" value="${code}" placeholder="CODE"></td>` +
        `<td><span class="gc-del">\u2715</span></td>`;
    tr.querySelector('.gc-del').onclick = () => tr.remove();
    gcBody.appendChild(tr);
    return tr;
}

async function gcOpen() {
    gcAirportEl.textContent = AIRPORT;
    gcBody.innerHTML = '';
    try {
        const resp = await fetch(`/api/asdex/${AIRPORT}/gatecodes`);
        const data = await resp.json();
        for (const [fix, code] of Object.entries(data)) gcAddRow(fix, code);
    } catch {}
    if (!gcBody.children.length) gcAddRow();
    // Load vNAS auto rules (read-only display, ordered by vNAS priority)
    try {
        const resp = await fetch(`/api/asdex/${AIRPORT}/vnasrules`);
        const rules = await resp.json();
        const section = document.getElementById('vnas-rules-section');
        if (rules.length > 0) {
            section.style.display = 'block';
            document.getElementById('vnas-count').textContent = `(${rules.length})`;
            document.getElementById('vnas-rules-body').innerHTML = rules
                .map(r => `<span style="color:#888">${r.pattern}</span> → <span style="color:#cccc44">${r.code}</span>`)
                .join('<br>');
        } else {
            section.style.display = 'none';
        }
    } catch { document.getElementById('vnas-rules-section').style.display = 'none'; }
    gcPopup.style.display = 'block';
}

async function gcSave() {
    const entries = {};
    for (const tr of gcBody.querySelectorAll('tr')) {
        const fix = tr.querySelector('.gc-fix').value.trim().toUpperCase();
        const code = tr.querySelector('.gc-code').value.trim().toUpperCase();
        if (fix && code) entries[fix] = code;
    }
    await fetch(`/api/asdex/${AIRPORT}/gatecodes`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entries)
    });
    gcPopup.style.display = 'none';
    // Force hash invalidation so all icons rebuild with new gate codes
    for (const tid of Object.keys(hashes)) hashes[tid] = '';
}

document.getElementById('gc-toggle').onclick = () => {
    if (gcPopup.style.display === 'block') gcPopup.style.display = 'none';
    else gcOpen();
};
document.getElementById('gc-add').onclick = () => { const tr = gcAddRow(); tr.querySelector('.gc-fix').focus(); };
document.getElementById('gc-save').onclick = gcSave;
document.getElementById('gc-close').onclick = () => { gcPopup.style.display = 'none'; };
document.getElementById('gc-import-btn').onclick = () => {
    const raw = document.getElementById('gc-import-area').value.trim();
    if (!raw) return;
    let count = 0;
    for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // Try tab-separated, then comma, then 2+ spaces, then last whitespace token
        let parts = trimmed.split('\t').map(s => s.trim()).filter(Boolean);
        if (parts.length < 2) parts = trimmed.split(',').map(s => s.trim()).filter(Boolean);
        if (parts.length < 2) parts = trimmed.split(/\s{2,}/).map(s => s.trim()).filter(Boolean);
        if (parts.length < 2) {
            // Last token is code, everything before is pattern
            const m = trimmed.match(/^(.+)\s+(\S+)$/);
            if (m) parts = [m[1].trim(), m[2].trim()];
        }
        if (parts.length >= 2) {
            const pattern = parts.slice(0, parts.length - 1).join(' ').toUpperCase();
            const code = parts[parts.length - 1].toUpperCase();
            if (pattern && code) { gcAddRow(pattern, code); count++; }
        }
    }
    document.getElementById('gc-import-area').value = '';
    if (count) document.querySelector('details').removeAttribute('open');
};

// ── Flight list panel ────────────────────────────────────────────────────────
const flPanel = document.getElementById('flight-list');
let flVisible = false;
let flInterval = null;

function routeSnippet(route, origin, dest) {
    if (!route) return origin && dest ? `${origin}-${dest}` : origin || dest || '';
    const tokens = route.split('.')
        .filter(t => t && t !== 'DCT' && t !== origin && t !== dest
                   && t !== ('K' + origin) && t !== ('K' + dest)
                   && !/^\d+$/.test(t));
    return tokens.slice(0, 3).join(' ') || (origin && dest ? `${origin}-${dest}` : '');
}

function renderFlightList() {
    const tracks = Object.values(trackData)
        .filter(t => t.callsign && t.tgtType !== 'vehicle' && t.tgtType !== 'unknown')
        .sort((a, b) => (a.callsign || '').localeCompare(b.callsign || ''));
    document.getElementById('fl-count').textContent = tracks.length + ' aircraft';
    const tbody = document.getElementById('fl-tbody');
    let html = '';
    for (const t of tracks) {
        const cs = t.callsign || '';
        const dep = t.origin || '';
        const arr = t.dest || '';
        const rte = routeSnippet(t.route, dep, arr);
        html += `<tr data-tid="${t.trackId}"><td class="fl-cs">${cs}</td><td class="fl-apt">${dep}</td><td class="fl-apt">${arr}</td><td class="fl-route">${rte}</td></tr>`;
    }
    tbody.innerHTML = html;
}

document.getElementById('fl-toggle').onclick = () => {
    flVisible = !flVisible;
    flPanel.style.display = flVisible ? 'flex' : 'none';
    if (flVisible) {
        renderFlightList();
        flInterval = setInterval(renderFlightList, 2000);
    } else {
        if (flInterval) { clearInterval(flInterval); flInterval = null; }
    }
};

// Click flight list row → center map on that target
document.getElementById('fl-tbody').addEventListener('click', (e) => {
    const row = e.target.closest('tr');
    if (!row) return;
    const tid = row.dataset.tid;
    const t = trackData[tid];
    if (t && t.lat != null && t.lon != null) map.setView([t.lat, t.lon], Math.max(map.getZoom(), 16));
});

// ── Hold bar debug panel ─────────────────────────────────────────────────────

const hbPanel = document.getElementById('holdbar-panel');
const hbBtn = document.getElementById('hb-toggle');
let hbVisible = false;
let holdbarOverlayVisible = true;

hbBtn.onclick = (e) => {
    if (e.shiftKey) {
        // Shift+click: toggle debug panel
        hbVisible = !hbVisible;
        hbPanel.style.display = hbVisible ? 'flex' : 'none';
    } else {
        // Normal click: toggle holdbar overlay on map
        holdbarOverlayVisible = !holdbarOverlayVisible;
        if (holdbarLayerGroup) {
            if (holdbarOverlayVisible) holdbarLayerGroup.addTo(map);
            else map.removeLayer(holdbarLayerGroup);
        }
    }
    hbBtn.style.color = holdbarOverlayVisible ? '#ff8c00' : '#ccc';
};

// ── Holdbar GeoJSON overlay ─────────────────────────────────────────────────
let holdbarLines = [];       // ordered LineString features from GeoJSON
let holdbarLayers = [];      // L.polyline layers (same order as holdbarLines)
let holdbarLayerGroup = null;
let holdbarGeoReady = false; // true once GeoJSON loaded and layers created
let lastHoldbarData = null;  // latest WS holdbar data (kept for re-apply)
let holdbarBitMap = null;    // learned mapping: { "176": 3, "177": 7, ... } (bit→lineIdx)
let holdbarMapPolled = 0;    // how many times we've polled for mapping updates

// Custom pane so hold bars render above surface polygons but below markers
map.createPane('holdbar');
map.getPane('holdbar').style.zIndex = 450;

// Load GeoJSON and learned bit mapping in parallel
Promise.all([
    fetch(`/api/asdex/${AIRPORT}/holdbar-geo`).then(r => r.ok ? r.json() : null),
    fetch(`/api/asdex/${AIRPORT}/holdbar-map`).then(r => r.ok ? r.json() : null)
]).then(([geojson, bitMap]) => {
    if (!geojson) { console.warn('[HOLDBAR] No GeoJSON for this airport'); return; }
    holdbarLines = geojson.features.filter(f => f.geometry.type === 'LineString');
    holdbarLayerGroup = L.layerGroup().addTo(map);
    for (const feat of holdbarLines) {
        const coords = feat.geometry.coordinates.map(c => [c[1], c[0]]);
        const layer = L.polyline(coords, {
            color: '#555', weight: 0.5, opacity: 0.4, interactive: false,
            pane: 'holdbar'
        });
        holdbarLayers.push(layer);
        holdbarLayerGroup.addLayer(layer);
    }
    holdbarBitMap = (bitMap && Object.keys(bitMap).length > 0) ? bitMap : null;
    holdbarGeoReady = true;
    console.log(`[HOLDBAR] loaded ${holdbarLines.length} lines, ${holdbarBitMap ? Object.keys(holdbarBitMap).length + ' mapped bits' : 'no mapping yet (learning...)'}`);
    if (lastHoldbarData) applyHoldbarToMap(lastHoldbarData);
}).catch(err => console.warn('[HOLDBAR] fetch failed:', err));

// Re-poll the learned mapping every 60s so newly learned correlations appear
setInterval(() => {
    fetch(`/api/asdex/${AIRPORT}/holdbar-map`)
        .then(r => r.ok ? r.json() : null)
        .then(bitMap => {
            if (!bitMap || Object.keys(bitMap).length === 0) return;
            const newCount = Object.keys(bitMap).length;
            const oldCount = holdbarBitMap ? Object.keys(holdbarBitMap).length : 0;
            if (newCount !== oldCount) {
                console.log(`[HOLDBAR] mapping updated: ${oldCount} → ${newCount} bits`);
                holdbarBitMap = bitMap;
                if (lastHoldbarData && holdbarGeoReady) applyHoldbarToMap(lastHoldbarData);
            }
        }).catch(() => {});
}, 60000);

function parseHoldbarBits(hex) {
    const bits = [];
    for (let i = 0; i < hex.length; i++) {
        const nibble = parseInt(hex[i], 16);
        if (isNaN(nibble)) { bits.push(false, false, false, false); continue; }
        for (let b = 3; b >= 0; b--) bits.push(!!((nibble >> b) & 1));
    }
    return bits;
}

function applyHoldbarToMap(data) {
    const bits = parseHoldbarBits(data.status || '');

    holdbarLayerGroup.clearLayers();
    let litCount = 0;
    const litLines = new Set(); // line indices that are lit green

    if (holdbarBitMap) {
        // Use learned mapping: bit position → line index
        for (const [bitStr, lineIdx] of Object.entries(holdbarBitMap)) {
            const bitPos = parseInt(bitStr);
            if (bitPos < bits.length && bits[bitPos] && lineIdx < holdbarLines.length) {
                litLines.add(lineIdx);
            }
        }
    }

    // Render all lines (green if lit, grey otherwise)
    for (let li = 0; li < holdbarLines.length; li++) {
        const on = litLines.has(li);
        if (on) litCount++;
        const coords = holdbarLines[li].geometry.coordinates.map(c => [c[1], c[0]]);
        const layer = L.polyline(coords, on
            ? { color: '#00cc00', weight: 0.5, opacity: 1, interactive: false, pane: 'holdbar' }
            : { color: '#555', weight: 0.5, opacity: 0.4, interactive: false, pane: 'holdbar' });
        holdbarLayers[li] = layer;
        holdbarLayerGroup.addLayer(layer);
    }

    const activeBits = bits.map((b, i) => b ? i : -1).filter(i => i >= 0);
    const mappedCount = holdbarBitMap ? Object.keys(holdbarBitMap).length : 0;
    console.log(`[HOLDBAR] ${litCount}/${holdbarLines.length} lines lit, ${activeBits.length} active bits, ${mappedCount} mapped`);
}

function renderHoldBar(data) {
    lastHoldbarData = data;

    // Update map if GeoJSON is loaded
    if (holdbarGeoReady) applyHoldbarToMap(data);

    // Update debug panel
    const statusEl = document.getElementById('hb-status');
    const bitsEl = document.getElementById('hb-bits');
    const rawEl = document.getElementById('hb-raw');
    if (!statusEl || !bitsEl) return;

    const bits = parseHoldbarBits(data.status || '');
    const activeBitPositions = bits.map((b, i) => b ? i : -1).filter(i => i >= 0);
    statusEl.textContent = `ctrl=${data.control}  ${activeBitPositions.length} active  ${data.ageSec || 0}s ago`;

    let html = '';
    for (let i = 0; i < bits.length; i++) {
        const on = bits[i];
        html += `<div class="hb-bit ${on ? 'on' : 'off'}" title="Bit ${i}"></div>`;
        if ((i + 1) % 8 === 0 && i < bits.length - 1) html += `<div class="hb-nibble-gap"></div>`;
    }
    bitsEl.innerHTML = html;
    rawEl.textContent = `Active bits: ${activeBitPositions.join(', ') || 'none'}  |  ${holdbarLines.length} GeoJSON lines`;
}

// ── Wake turbulence detection (FAA 7360.1D type→weight class) ────────────────
// Loaded from wake-categories.json: { "A320": "L", "B738": "L", "C172": "S", "C17": "H", ... }
// Weight classes: J=Super, H=Heavy, L=Large, S=Small, S+=Small 12.5-41K lbs
let WAKE_MAP = {};  // populated async on load
fetch('/wake-categories.json').then(r => r.json()).then(data => {
    WAKE_MAP = data;
    // Invalidate all hashes so icons rebuild with correct wake colors
    for (const tid of Object.keys(hashes)) hashes[tid] = '';
}).catch(() => {});

function targetCategory(t) {
    // unknown = no callsign/squawk, OR tgtType explicitly unknown
    if (t.tgtType === 'unknown') return 'unknown';
    if (t.tgtType === 'vehicle') return 'vehicle';
    if (!t.callsign && !t.squawk) return 'unknown';
    // RECAT wake category A-E from SMES = heavy (orange)
    if (t.wake && 'ABCDE'.includes(t.wake.toUpperCase())) return 'heavy';
    if (t.acType) {
        const wt = WAKE_MAP[t.acType.toUpperCase()];
        if (wt === 'J' || wt === 'H') return 'heavy';
    }
    return 'aircraft';
}

// ── SVG path for airplane (pointing up = heading 0°) ─────────────────────────
// Fuselage + swept wings + V-tail. ViewBox centered on 0,0, nose at top.
const PLANE_PATH = 'M 0 -8 L 1.3 -5 L 1.3 -1 L 8 2 L 7.5 3 L 1.8 1.5 L 1.8 5 L 4 7 L 0 6 L -4 7 L -1.8 5 L -1.8 1.5 L -7.5 3 L -8 2 L -1.3 -1 L -1.3 -5 Z';
// Kite shape (unknown): pointy bottom, wide top — smaller than aircraft
const DIAMOND_PATH = 'M 0 3.5 L 2.5 0.5 L 0 -4.5 L -2.5 0.5 Z';
// Vehicle: small square
const VEHICLE_PATH = 'M -4 -4 L 4 -4 L 4 4 L -4 4 Z';

function makeIcon(t) {
    const cat = targetCategory(t);
    const hdg = t.hdg ?? 0;

    let fill, symHtml;
    if (cat === 'unknown') {
        fill = '#00ffff';
        symHtml = `<path d="${DIAMOND_PATH}" fill="${fill}" fill-opacity="0.9"/>`;
    } else if (cat === 'vehicle') {
        fill = '#00cccc';
        symHtml = `<path d="${VEHICLE_PATH}" fill="${fill}" fill-opacity="0.75"/>`;
    } else {
        fill = cat === 'heavy' ? '#ff8c00' : '#ffffff';
        // rotate inline via SVG transform (faster than CSS for many markers)
        symHtml = `<g transform="rotate(${hdg})">${'<path d="' + PLANE_PATH + '" fill="' + fill + '" fill-opacity="0.95"/>'}</g>`;
    }

    // Data block — skip for targets with no callsign and no squawk
    const cs  = t.callsign || t.squawk || '';
    const alt = (dbShowAlt && t.altFt != null) ? Math.round(t.altFt / 100).toString().padStart(3, '0') : '';
    const sens = dbShowSens ? (t.ageSec > 8 ? 'CST' : 'FUS') : '';
    const spd = (dbShowVel && t.spdKts != null) ? Math.round(t.spdKts / 10).toString().padStart(2, '0') : '';
    const typ = dbShowType ? (t.acType || '') : '';
    const catLetter = dbShowCat ? wakeToCategory(t.wake, t.acType) : '';
    const fix = dbShowFix ? (t.gateCode || '') : '';

    let dbHtml = '';
    const dbStyle = `font-size:${dbFontSize}px;line-height:${Math.round(dbFontSize * 1.25)}px`;
    if (cs && cat !== 'unknown') {
        if (cat !== 'vehicle') {
            // Line 1: {callsign} {altitude?} {sensors?}
            const parts1 = [cs, alt, sens].filter(Boolean).join(' ');
            // Line 2: {type?} {cat?} {fix?} {velocity?}
            const parts2 = [typ, catLetter, fix, spd].filter(Boolean).join(' ');
            dbHtml = `<div class="db" style="${dbStyle}">
                <div class="db-line1">${parts1}</div>
                ${parts2 ? `<div class="db-line2">${parts2}</div>` : ''}
            </div>`;
        } else {
            dbHtml = `<div class="db" style="${dbStyle}"><div class="db-line1">${cs}</div></div>`;
        }
    }

    const posKey = dbPositions[t.trackId] || 'NE';
    const pos = DB_POS[posKey];
    const hideStyle = hiddenDbs.has(t.trackId) ? ';display:none' : '';
    const showLdr = cs && cat !== 'unknown';
    const ldrHtml = showLdr ? `<svg class="ldr" width="18" height="18" viewBox="0 0 18 18" style="position:absolute;left:0;top:0;overflow:visible${hideStyle}">
            <line x1="9" y1="9" x2="${pos.lx}" y2="${pos.ly}" stroke="#00cc00" stroke-width="0.5" opacity="0.6"/>
        </svg>` : '';

    const html = `<div class="ac-icon" data-tid="${t.trackId}">
        <svg class="sym" width="18" height="18" viewBox="-9 -9 18 18" style="display:block"><circle cx="0" cy="0" r="14" fill="transparent"/>${symHtml}<circle class="halo" cx="0" cy="0" r="11" fill="none" stroke="#fff" stroke-width="1"/></svg>
        ${ldrHtml}
        <div class="db-wrap" style="left:${pos.wl}px;top:${pos.wt}px${hideStyle}">${dbHtml}</div>
    </div>`;

    return L.divIcon({ className: '', html, iconSize: [200, 18], iconAnchor: [9, 9] });
}

function trackHash(t) {
    return `${t.lat?.toFixed(5)},${t.lon?.toFixed(5)},${t.callsign||''},${t.altFt||0},${t.spdKts||0},${t.hdg?.toFixed(0)||0},${t.tgtType||''},${t.acType||''},${t.wake||''},${t.gateCode||''},${t.ageSec||0},${dbToggleVer}`;
}

// ── Apply one track update ───────────────────────────────────────────────────
function applyTrack(t) {
    if (t.lat == null || t.lon == null) return;
    trackData[t.trackId] = t;
    const ll  = [t.lat, t.lon];
    const h   = trackHash(t);
    const tid = t.trackId;

    if (!markers[tid]) {
        markers[tid] = L.marker(ll, { icon: makeIcon(t), zIndexOffset: 0 }).addTo(map);
    } else {
        markers[tid].setLatLng(ll);
        if (hashes[tid] !== h) {
            markers[tid].setIcon(makeIcon(t));
        }
    }
    hashes[tid] = h;
}

function removeTrack(trackId) {
    if (markers[trackId]) { map.removeLayer(markers[trackId]); delete markers[trackId]; }
    delete hashes[trackId];
    delete trackData[trackId];
}

function updateCount() {
    trackCount = Object.keys(markers).length;
    cntEl.textContent = trackCount + ' track' + (trackCount !== 1 ? 's' : '');
}

// ── Center map on track centroid ─────────────────────────────────────────────
function centerOnTracks(tracks) {
    if (!tracks.length || centeredOnce) return;
    const lat = tracks.reduce((s, t) => s + t.lat, 0) / tracks.length;
    const lon = tracks.reduce((s, t) => s + t.lon, 0) / tracks.length;
    map.setView([lat, lon], 14);
    centeredOnce = true;
}

// ── WebSocket ────────────────────────────────────────────────────────────────
let ws = null;
let wsRetryTimer = null;

function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url   = `${proto}//${location.host}/asdex/ws/${AIRPORT}`;
    ws = new WebSocket(url);
    connEl.textContent = 'CONNECTING';
    connEl.className   = 'waiting';

    ws.onopen = () => {
        connEl.textContent = 'LIVE';
        connEl.className   = 'ok';
        if (wsRetryTimer) { clearTimeout(wsRetryTimer); wsRetryTimer = null; }
    };

    ws.onmessage = ev => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }

        if (msg.type === 'snapshot') {
            // Remove stale markers not in snapshot
            const incoming = new Set((msg.data.tracks || []).map(t => t.trackId));
            for (const tid of Object.keys(markers)) {
                if (!incoming.has(tid)) removeTrack(tid);
            }
            for (const t of (msg.data.tracks || [])) applyTrack(t);
            centerOnTracks(msg.data.tracks || []);
            updateCount();

        } else if (msg.type === 'batch') {
            // Batch contains ALL current (deduped) tracks — remove any not present
            const batchIds = new Set((msg.data || []).map(t => t.trackId));
            for (const tid of Object.keys(markers)) {
                if (!batchIds.has(tid)) removeTrack(tid);
            }
            for (const t of (msg.data || [])) applyTrack(t);
            updateCount();

        } else if (msg.type === 'remove') {
            removeTrack(msg.data.trackId);
            updateCount();

        } else if (msg.type === 'holdbar') {
            renderHoldBar(msg.data);
        }
    };

    ws.onclose = () => {
        connEl.textContent = 'DISCONNECTED';
        connEl.className   = '';
        if (!window.idlePaused || !window.idlePaused()) wsRetryTimer = setTimeout(connect, 5000);
    };

    ws.onerror = () => { ws.close(); };
}

window.idleOnPause = () => { if (ws) { ws.onclose = null; ws.close(); ws = null; } if (wsRetryTimer) { clearTimeout(wsRetryTimer); wsRetryTimer = null; } };
window.idleOnResume = () => { connect(); };

connect();

// ── Replay system ──────────────────────────────────────────────────────────
(function() {

const rpPanel = document.getElementById('replay-panel');
const rpBtn = document.getElementById('replay-btn');
const rpStartInput = document.getElementById('rp-start');
const rpGoBtn = document.getElementById('rp-go');
const rpControls = document.getElementById('rp-controls');
const rpPauseBtn = document.getElementById('rp-pause');
const rpSpeedSel = document.getElementById('rp-speed');
const rpTimeEl = document.getElementById('rp-time');
const rpStatusEl = document.getElementById('rp-status');
const rpStopBtn = document.getElementById('rp-stop');
const rpRangeEl = document.getElementById('rp-range');

let rpWs = null;
let rpActive = false;
let rpPaused = false;

rpBtn.onclick = () => {
    const vis = rpPanel.style.display === 'none' || !rpPanel.style.display;
    rpPanel.style.display = vis ? 'block' : 'none';
    rpBtn.style.color = vis ? '#ff8c00' : '#ccc';
    if (vis) fetchRange();
};

async function fetchRange() {
    try {
        const resp = await fetch('/api/replay/range');
        const data = await resp.json();
        const k = data.asdex?.[AIRPORT.toUpperCase()];
        if (k) {
            rpRangeEl.textContent = `${k.hours}h avail, ${k.totalSizeMB.toFixed(1)} MB`;
            const def = new Date(Date.now() - 3600000);
            rpStartInput.value = toLocal(def);
        } else {
            rpRangeEl.textContent = 'No data yet';
        }
    } catch(e) {
        rpRangeEl.textContent = 'Error';
    }
}

function toLocal(d) {
    const off = d.getTimezoneOffset();
    return new Date(d.getTime() - off * 60000).toISOString().slice(0, 19);
}

rpGoBtn.onclick = () => {
    const val = rpStartInput.value;
    if (!val) return;
    startReplay(new Date(val).toISOString());
};

function startReplay(startTime) {
    // Close any existing replay connection first
    if (rpWs) { rpWs.onclose = null; rpWs.close(); rpWs = null; }
    // Disconnect live
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
    if (wsRetryTimer) { clearTimeout(wsRetryTimer); wsRetryTimer = null; }

    // Clear
    for (const tid of Object.keys(markers)) removeTrack(tid);
    updateCount();

    rpActive = true;
    rpPaused = false;
    rpPauseBtn.textContent = '\u23F8';
    rpControls.style.display = '';
    rpStatusEl.textContent = 'Connecting...';
    connEl.textContent = 'REPLAY';
    connEl.className = '';
    connEl.style.color = '#ff8c00';

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const icao = AIRPORT.toUpperCase();
    const speed = rpSpeedSel.value || '1';
    rpWs = new WebSocket(`${proto}//${location.host}/replay/asdex/ws/${icao}?start=${encodeURIComponent(startTime)}&speed=${speed}`);

    rpWs.onopen = () => { rpStatusEl.textContent = 'Loading...'; };
    rpWs.onclose = () => { if (rpActive) rpStatusEl.textContent = 'Disconnected'; };

    rpWs.onmessage = ev => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }

        if (msg.replayTime) {
            const t = new Date(msg.replayTime);
            rpTimeEl.textContent = t.toISOString().replace('T', ' ').slice(0, 19) + 'Z';
        }

        if (msg.type === 'snapshot') {
            for (const tid of Object.keys(markers)) removeTrack(tid);
            for (const t of (msg.data || [])) applyTrack(t);
            updateCount();
            rpStatusEl.textContent = `${Object.keys(markers).length} tracks`;
        } else if (msg.type === 'batch') {
            const batchIds = new Set((msg.data || []).map(t => t.trackId));
            for (const tid of Object.keys(markers)) {
                if (!batchIds.has(tid)) removeTrack(tid);
            }
            for (const t of (msg.data || [])) applyTrack(t);
            updateCount();
            rpStatusEl.textContent = `${Object.keys(markers).length} tracks`;
        } else if (msg.type === 'remove') {
            removeTrack(msg.data.trackId);
            updateCount();
        } else if (msg.type === 'holdbar') {
            renderHoldBar(msg.data);
        } else if (msg.type === 'replay_seek') {
            for (const tid of Object.keys(markers)) removeTrack(tid);
            rpStatusEl.textContent = 'Seeking...';
        } else if (msg.type === 'replay_end') {
            rpStatusEl.textContent = 'End of data';
        } else if (msg.type === 'replay_error') {
            rpStatusEl.textContent = msg.message || 'Error';
        }
    };
}

rpPauseBtn.onclick = () => {
    if (!rpWs || rpWs.readyState !== WebSocket.OPEN) return;
    rpPaused = !rpPaused;
    rpWs.send(JSON.stringify({ cmd: rpPaused ? 'pause' : 'resume' }));
    rpPauseBtn.textContent = rpPaused ? '\u25B6' : '\u23F8';
};

rpSpeedSel.onchange = () => {
    if (!rpWs || rpWs.readyState !== WebSocket.OPEN) return;
    rpWs.send(JSON.stringify({ cmd: 'speed', value: parseFloat(rpSpeedSel.value) }));
};

rpStopBtn.onclick = () => {
    rpActive = false;
    if (rpWs) { rpWs.onclose = null; rpWs.close(); rpWs = null; }
    rpControls.style.display = 'none';
    rpTimeEl.textContent = '';
    rpStatusEl.textContent = '';
    connEl.style.color = '';
    connect();
};

})();
