const HALO_RADIUS = 14; // px — match the halo circle radius for click + hover detection

// ── Crosshair cursor + proximity halo ───────────────────────────────────────
const ch = document.getElementById('crosshair');
const statusBar = document.getElementById('statusbar');
let haloTid = null; // trackId of currently highlighted halo

document.addEventListener('mousemove', e => {
    // Hide crosshair if over status bar, UI panels, or popups
    const overUI = e.target.closest('.nav-home, #statusbar, #flight-list, #holdbar-panel, #replay-panel, #ldr-dir-overlay, #zulu-clock, #cmd-overlay, #fp-popup');
    
    if (overUI) {
        ch.style.display = 'none';
        return;
    }
    
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
let dbShowUnk  = true;   // Show unknown targets (no callsign/squawk)
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
    if (saved.unk  !== undefined) dbShowUnk  = saved.unk;
} catch(e) {}

function saveDbToggles() {
    localStorage.setItem('asdex-db-toggles', JSON.stringify({
        alt: dbShowAlt, type: dbShowType, sens: dbShowSens,
        cat: dbShowCat, fix: dbShowFix, vel: dbShowVel, unk: dbShowUnk
    }));
    dbToggleVer++;
    // Invalidate all hashes and immediately re-render all tracks
    for (const tid of Object.keys(hashes)) hashes[tid] = '';
    for (const t of Object.values(trackData)) applyTrack(t);
    updateCount();
}

// Toggle button wiring
const dbTogMap = { alt: () => dbShowAlt, type: () => dbShowType, sens: () => dbShowSens, cat: () => dbShowCat, fix: () => dbShowFix, vel: () => dbShowVel, unk: () => dbShowUnk };
const dbTogSet = { alt: v => dbShowAlt=v, type: v => dbShowType=v, sens: v => dbShowSens=v, cat: v => dbShowCat=v, fix: v => dbShowFix=v, vel: v => dbShowVel=v, unk: v => dbShowUnk=v };
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

// UNKNOWNS toggle
const unkBtn = document.getElementById('unk-toggle');
if (dbShowUnk) unkBtn.classList.add('on');
unkBtn.addEventListener('click', () => {
    dbShowUnk = !dbShowUnk;
    unkBtn.classList.toggle('on', dbShowUnk);
    saveDbToggles();
    // If toggling UNKNOWNS off, remove all unknown markers
    if (!dbShowUnk) {
        for (const tid of Object.keys(markers)) {
            const t = trackData[tid];
            if (t && targetCategory(t) === 'unknown') removeTrack(tid);
        }
        updateCount();
    } else {
        // If toggling back on, re-render all unknown tracks
        for (const t of Object.values(trackData)) {
            if (targetCategory(t) === 'unknown') applyTrack(t);
        }
        updateCount();
    }
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
    doubleClickZoom: false,
    keyboard: false
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
const _hour = new Date().getHours();
let isNightMode = _hour < 8 || _hour >= 19;
let asdexColors = isNightMode ? ASDEX_NIGHT : ASDEX_DAY;
let surfaceLayer = null;
document.getElementById('map').style.background = asdexColors.bg;
document.body.style.background = asdexColors.bg;
document.getElementById('dn-toggle').textContent = isNightMode ? 'NIGHT' : 'DAY';

// ── Load airport surface GeoJSON ────────────────────────────────────────────
let surfaceLoaded = false;
fetch(`/asdex/maps/${AIRPORT}.geojson`)
    .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(geojson => {
        // Sort features so runways render on top (drawn last)
        // Order: apron → taxiway → runway → structure (terminal buildings on top)
        const renderOrder = { apron: 0, taxiway: 1, runway: 2, structure: 3 };
        geojson.features.sort((a, b) => {
            const aType = a.properties?.asdex || 'structure';
            const bType = b.properties?.asdex || 'structure';
            return (renderOrder[aType] || 0) - (renderOrder[bType] || 0);
        });
        
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
        L.tileLayer('/basemap/dark_all/{z}/{x}/{y}{r}.png', {
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

// Geometry: aircraft center in ac-icon coords = (CX, CY).
// lx/ly = leader line tip. wl/wt = db-wrap top-left. tf = CSS transform that
// anchors the correct edge/corner of the db to the (wl, wt) point so the gap
// between leader tip and nearest db edge is uniform (GAP px) in every direction.
(function () {
    const CX = 9, CY = 9, LDR = 22, GAP = 0;
    const D = Math.round(LDR / Math.SQRT2); // diagonal component ≈ 10
    window.DB_POS = {
        N:  { lx: CX,     ly: CY-LDR, wl: CX,     wt: CY-LDR-GAP, tf: 'translate(-50%,-100%)' },
        NE: { lx: CX+D,   ly: CY-D,   wl: CX+D+GAP, wt: CY-D-GAP, tf: 'translate(0,-100%)' },
        E:  { lx: CX+LDR, ly: CY,     wl: CX+LDR+GAP, wt: CY,     tf: 'translate(0,-50%)' },
        SE: { lx: CX+D,   ly: CY+D,   wl: CX+D+GAP, wt: CY+D+GAP, tf: 'translate(0,0)' },
        S:  { lx: CX,     ly: CY+LDR, wl: CX,     wt: CY+LDR+GAP, tf: 'translate(-50%,0)' },
        SW: { lx: CX-D,   ly: CY+D,   wl: CX-D-GAP, wt: CY+D+GAP, tf: 'translate(-100%,0)' },
        W:  { lx: CX-LDR, ly: CY,     wl: CX-LDR-GAP, wt: CY,     tf: 'translate(-100%,-50%)' },
        NW: { lx: CX-D,   ly: CY-D,   wl: CX-D-GAP, wt: CY-D-GAP, tf: 'translate(-100%,-100%)' },
    };
})();

// Apply a DB_POS entry to a db-wrap element.
function setWrap(wrap, pos, forceVisible) {
    wrap.style.left      = pos.wl + 'px';
    wrap.style.top       = pos.wt + 'px';
    wrap.style.transform = pos.tf;
    if (forceVisible) wrap.style.display = '';
}

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

// ── Command input (.FP etc.) ─────────────────────────────────────────────────
const cmdOverlay = document.getElementById('cmd-overlay');
let cmdText = '';

function showCmd() {
    cmdOverlay.textContent = cmdText + '_';
    cmdOverlay.style.display = 'block';
}
function hideCmd() {
    cmdText = '';
    cmdOverlay.style.display = 'none';
}

function lookupTrack(acid) {
    const up = acid.toUpperCase();
    return Object.values(trackData).find(t => t.callsign && t.callsign.toUpperCase() === up) || null;
}

// True when the user has typed .FP (with optional trailing space) and hasn't yet provided an ACID —
// meaning a click on a target should fill in the aircraft.
function isPendingFpClick() {
    if (!cmdText) return false;
    const parts = cmdText.trim().toUpperCase().split(/\s+/);
    return parts[0] === '.FP' && parts.length === 1;
}

function openFpPopup(t) {
    const pop    = document.getElementById('fp-popup');
    const title  = document.getElementById('fp-title');
    const fields = document.getElementById('fp-fields');
    const rte    = document.getElementById('fp-rte');

    const cs      = t.callsign || '???';
    const dep     = t.origin   || '—';
    const dest    = t.dest     || '—';
    const type    = t.acType   || '—';
    const wake    = t.wake     || '—';
    const bcn     = t.squawk   || '—';
    const route   = t.route    || '';
    const star    = t.star     || '';
    const rteText = [route, star].filter(Boolean).join(' ') || '—';

    title.textContent = cs;

    const cols = [
        { hdr: 'AID',  val: cs,   hi: true },
        { hdr: 'BCN',  val: bcn },
        { hdr: 'TYP',  val: type, hi: true },
        { hdr: 'WAKE', val: wake },
        { hdr: 'DEP',  val: dep,  hi: true },
        { hdr: 'DEST', val: dest, hi: true },
    ];

    fields.innerHTML = `<table class="fp-tbl"><thead><tr>${
        cols.map(c => `<th>${c.hdr}</th>`).join('')
    }</tr></thead><tbody><tr>${
        cols.map(c => `<td${c.hi ? ' class="hi"' : ''}>${c.val}</td>`).join('')
    }</tr></tbody></table>`;

    rte.innerHTML = `<span class="fp-rte-lbl">RTE</span><span>${rteText}</span>`;

    pop.style.display = 'block';
}

// Draggable FP popup
(function () {
    const pop = document.getElementById('fp-popup');
    const bar = document.getElementById('fp-titlebar');
    let dragging = false, ox = 0, oy = 0;
    bar.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        dragging = true;
        const r = pop.getBoundingClientRect();
        ox = e.clientX - r.left;
        oy = e.clientY - r.top;
        e.stopPropagation();
    });
    document.addEventListener('mousemove', e => {
        if (!dragging) return;
        pop.style.left = (e.clientX - ox) + 'px';
        pop.style.top  = (e.clientY - oy) + 'px';
    });
    document.addEventListener('mouseup', () => { dragging = false; });
    document.getElementById('fp-close').addEventListener('click', () => {
        pop.style.display = 'none';
    });
})();

document.addEventListener('keydown', e => {
    // Don't intercept if typing in an input field
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    if (e.key === 'Escape') {
        if (cmdText)                { hideCmd();        e.preventDefault(); return; }
        if (pendingLdrDir !== null) { hideLdrOverlay(); e.preventDefault(); }
        return;
    }

    // Command input mode — active once first char is '.'
    if (cmdText) {
        if (e.key === 'Backspace') {
            cmdText = cmdText.slice(0, -1);
            if (!cmdText) hideCmd(); else showCmd();
            e.preventDefault();
            return;
        }
        if (e.key === 'Enter') {
            const parts = cmdText.trim().toUpperCase().split(/\s+/);
            if (parts[0] === '.FP' && parts[1]) {
                const t = lookupTrack(parts[1]);
                if (t) openFpPopup(t);
            }
            hideCmd();
            e.preventDefault();
            return;
        }
        if (e.key.length === 1) {
            cmdText += e.key.toUpperCase();
            showCmd();
            e.preventDefault();
            return;
        }
        return;
    }

    // Backspace clears pending LDR DIR
    if (e.key === 'Backspace' && pendingLdrDir !== null) {
        hideLdrOverlay();
        e.preventDefault();
        return;
    }

    // Start command on '.'
    if (e.key === '.') {
        cmdText = '.';
        showCmd();
        e.preventDefault();
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
    if (wrap) setWrap(wrap, pos, false);
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
    if (wrap) setWrap(wrap, pos, false);
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
            if (wrap) setWrap(wrap, pos, true);
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
    if (e.target.closest('#statusbar, #flight-list, #holdbar-panel')) return;

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

    // .FP click-pick mode: open flight plan for clicked aircraft
    if (isPendingFpClick()) {
        const t = trackData[bestTid];
        if (t && t.callsign) openFpPopup(t);
        hideCmd();
        e.preventDefault();
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
            if (wrap) setWrap(wrap, pos, true);
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
    const lid = AIRPORT.replace(/^K/, '');  // KDCA → DCA
    const icao = AIRPORT;

    const tracks = Object.values(trackData)
        .filter(t => t.callsign && t.tgtType !== 'vehicle' && t.tgtType !== 'unknown')
        .sort((a, b) => (a.callsign || '').localeCompare(b.callsign || ''));

    const departures = tracks.filter(t => t.origin === lid || t.origin === icao);
    const arrivals   = tracks.filter(t => t.dest   === lid || t.dest   === icao);
    const other      = tracks.filter(t =>
        (t.origin !== lid && t.origin !== icao) &&
        (t.dest   !== lid && t.dest   !== icao));

    document.getElementById('fl-count').textContent = tracks.length + ' aircraft';

    const COLS = `<colgroup><col style="width:7em"><col style="width:3.5em"><col style="width:3.5em"><col></colgroup>`;
    const THEAD = `<tr><th>CALLSIGN</th><th>DEP</th><th>ARR</th><th>ROUTE</th></tr>`;

    function sectionHtml(label, color, list) {
        if (!list.length) return '';
        let h = `<tr class="fl-section-hdr"><td colspan="4" style="color:${color};padding:4px 6px 2px;border-bottom:1px solid #333;font-size:10px">${label} (${list.length})</td></tr>`;
        h += THEAD;
        for (const t of list) {
            const cs  = t.callsign || '';
            const dep = t.origin || '';
            const arr = t.dest || '';
            const rte = routeSnippet(t.route, dep, arr);
            h += `<tr data-tid="${t.trackId}"><td class="fl-cs">${cs}</td><td class="fl-apt">${dep}</td><td class="fl-apt">${arr}</td><td class="fl-route">${rte}</td></tr>`;
        }
        return h;
    }

    document.getElementById('fl-tbody').innerHTML =
        sectionHtml('DEPARTURES', '#00cc88', departures) +
        sectionHtml('ARRIVALS',   '#4488ff', arrivals)   +
        sectionHtml('OTHER',      '#888',    other);
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
let holdbarOverlayVisible = localStorage.getItem('asdex-holdbars') === 'on';
hbBtn.style.color = holdbarOverlayVisible ? '#ff8c00' : '#ccc';

hbBtn.onclick = (e) => {
    if (e.shiftKey) {
        // Shift+click: toggle debug panel
        hbVisible = !hbVisible;
        hbPanel.style.display = hbVisible ? 'flex' : 'none';
    } else {
        // Normal click: toggle holdbar overlay on map
        holdbarOverlayVisible = !holdbarOverlayVisible;
        localStorage.setItem('asdex-holdbars', holdbarOverlayVisible ? 'on' : 'off');
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
    holdbarLayerGroup = L.layerGroup();
    if (holdbarOverlayVisible) holdbarLayerGroup.addTo(map);
    for (const feat of holdbarLines) {
        const coords = feat.geometry.coordinates.map(c => [c[1], c[0]]);
        const layer = L.polyline(coords, {
            color: '#555', weight: 1, opacity: 0.4, interactive: false,
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
    const litLines = new Set();

    if (holdbarBitMap) {
        // Use learned mapping: bit position → seed line index
        for (const [bitStr, lineIdx] of Object.entries(holdbarBitMap)) {
            const bitPos = parseInt(bitStr);
            if (bitPos < bits.length && bits[bitPos] && lineIdx < holdbarLines.length) {
                litLines.add(lineIdx);
            }
        }
        // Propagate: hold bars activate per runway, so when any line on runway X is lit,
        // light ALL lines tagged with that runwayId (each intersection along the runway)
        if (litLines.size > 0) {
            const litRunways = new Set();
            for (const li of litLines) {
                const rwy = holdbarLines[li].properties?.runwayId;
                if (rwy) litRunways.add(rwy);
            }
            for (let li = 0; li < holdbarLines.length; li++) {
                const rwy = holdbarLines[li].properties?.runwayId;
                if (rwy && litRunways.has(rwy)) litLines.add(li);
            }
        }
    }

    // Update existing layer styles in-place — never clear/re-add, which causes tearing mid-drag
    let litCount = 0;
    for (let li = 0; li < holdbarLayers.length; li++) {
        const on = litLines.has(li);
        if (on) litCount++;
        holdbarLayers[li].setStyle(on
            ? { color: '#00cc00', opacity: 1 }
            : { color: '#555', opacity: 0.4 });
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
// Aircraft: clean top-down silhouette matching CRC ASDE-X reference
const PLANE_PATH = 'M 0 -8 L 1.4 -6 L 1.4 -1.5 L 7.5 1.5 L 7.5 3 L 1.4 1 L 1.4 5.5 L 3.5 7 L 3.5 8 L 0 7 L -3.5 8 L -3.5 7 L -1.4 5.5 L -1.4 1 L -7.5 3 L -7.5 1.5 L -1.4 -1.5 L -1.4 -6 Z';
// Unknown: tall pointed kite/diamond (point at top, wider at bottom half)
const DIAMOND_PATH = 'M 0 -5.5 L 3 1 L 0 5 L -3 1 Z';
// Vehicle: small square
const VEHICLE_PATH = 'M -4 -4 L 4 -4 L 4 4 L -4 4 Z';

function makeIcon(t) {
    const cat = targetCategory(t);
    const hdg = t.hdg ?? 0;

    let fill, symHtml;
    if (cat === 'unknown') {
        fill = '#00ffff';
        // Rotate kite if heading is available (server derives it from position delta for primaries)
        const inner = `<path d="${DIAMOND_PATH}" fill="${fill}" fill-opacity="0.9"/>`;
        symHtml = t.hdg != null ? `<g transform="rotate(${hdg})">${inner}</g>` : inner;
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
    // Counter-rotate the data block so text stays upright when the map is rotated.
    // Baked in here (not just applyRotation) so it survives icon rebuilds on updates.
    const dbCounter = mapRotation === 360 ? 0 : mapRotation;
    const dbStyle = `font-size:${dbFontSize}px;line-height:${Math.round(dbFontSize * 0.87)}px;transform:rotate(${dbCounter}deg)`;
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
        <div class="db-wrap" style="left:${pos.wl}px;top:${pos.wt}px;transform:${pos.tf}${hideStyle}">${dbHtml}</div>
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

    // Skip rendering if this is an unknown target and they're filtered out
    const isUnknown = targetCategory(t) === 'unknown';
    if (isUnknown && !dbShowUnk) {
        if (markers[tid]) removeTrack(tid);
        return;
    }

    if (!markers[tid]) {
        markers[tid] = L.marker(ll, { icon: makeIcon(t), zIndexOffset: 0 }).addTo(map);
    } else {
        markers[tid].setLatLng(ll);
        if (hashes[tid] !== h) {
            markers[tid].setIcon(makeIcon(t));
            // setIcon replaces the DOM element — re-apply halo if this is the hovered track
            if (tid === haloTid) {
                const halo = markers[tid]?.getElement()?.querySelector('.halo');
                if (halo) halo.style.opacity = '1';
            }
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

// ── Zulu clock ───────────────────────────────────────────────────────────────
(function () {
    const el = document.getElementById('zulu-clock');

    function tick() {
        const now = new Date();
        const hh  = String(now.getUTCHours()).padStart(2, '0');
        const mm  = String(now.getUTCMinutes()).padStart(2, '0');
        const ss  = String(now.getUTCSeconds()).padStart(2, '0');
        el.textContent = `${hh}${mm}/${ss}`;
    }
    tick();
    setInterval(tick, 1000);

    // Restore saved position (right-anchored default)
    const saved = localStorage.getItem('asdex-clock-pos');
    if (saved) {
        try {
            const { x, y } = JSON.parse(saved);
            el.style.right = '';
            el.style.left  = x + 'px';
            el.style.top   = y + 'px';
        } catch (_) {}
    }

    // Drag
    let dragging = false, ox = 0, oy = 0;
    el.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        dragging = true;
        const r = el.getBoundingClientRect();
        ox = e.clientX - r.left;
        oy = e.clientY - r.top;
        // Switch from CSS right-anchor to explicit left so drag math works
        el.style.left  = r.left + 'px';
        el.style.right = '';
        e.stopPropagation();
    });
    document.addEventListener('mousemove', e => {
        if (!dragging) return;
        el.style.left = (e.clientX - ox) + 'px';
        el.style.top  = (e.clientY - oy) + 'px';
    });
    document.addEventListener('mouseup', e => {
        if (!dragging) return;
        dragging = false;
        localStorage.setItem('asdex-clock-pos', JSON.stringify({
            x: parseInt(el.style.left),
            y: parseInt(el.style.top)
        }));
    });
})();

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

// ── Replay system — delegates to /shared/replay-bar.js ────────────────────
(function() {
const rpBtn = document.getElementById('replay-btn');

function applyTracks(arr) {
    for (const t of (arr || [])) applyTrack(t);
}

function init() {
    if (!window.ReplayBar) { setTimeout(init, 50); return; }
    window.ReplayBar.init({
        wsPath:   '/replay/asdex/ws/' + AIRPORT.toUpperCase(),
        rangeKey: 'asdex',
        rangeSubKey: AIRPORT.toUpperCase(),
        onStart: () => {
            if (ws) { ws.onclose = null; ws.close(); ws = null; }
            if (wsRetryTimer) { clearTimeout(wsRetryTimer); wsRetryTimer = null; }
            for (const tid of Object.keys(markers)) removeTrack(tid);
            updateCount();
            connEl.textContent = 'REPLAY';
            connEl.className = '';
            connEl.style.color = '#ff8c00';
        },
        onTime: () => {},
        onSnapshot: (arr) => {
            for (const tid of Object.keys(markers)) removeTrack(tid);
            applyTracks(arr);
            updateCount();
        },
        onBatch: (arr) => {
            const ids = new Set((arr || []).map(t => t.trackId));
            for (const tid of Object.keys(markers)) {
                if (!ids.has(tid)) removeTrack(tid);
            }
            applyTracks(arr);
            updateCount();
        },
        onRemove: (data) => {
            if (data && data.trackId) { removeTrack(data.trackId); updateCount(); }
        },
        onSeek: () => {
            for (const tid of Object.keys(markers)) removeTrack(tid);
            updateCount();
        },
        onStop: () => {
            connEl.style.color = '';
            connect();
        },
        onMessage: (msg) => {
            if (msg.type === 'holdbar') renderHoldBar(msg.data);
        },
    });
    if (rpBtn) {
        rpBtn.addEventListener('click', () => {
            window.ReplayBar.toggle();
            rpBtn.style.color = window.ReplayBar.isOpen() ? '#ff8c00' : '#ccc';
        });
    }
}
init();
})();
