/* ── NAS map ───────────────────────────────────────────────────────────────────
 * An overview browser over the fused NAS picture: SFDPS en route, STARS terminal
 * and ASDE-X surface, one entity per airframe, streamed viewport-bounded.
 *
 * Three things shape this file.
 *
 * ONE CANVAS, NOT MARKERS. A continental view holds up to the server's cap
 * (3,000 by default, 10,000 on request). Leaflet markers are a DOM node each and
 * die well before that — the ASDE-X scope already struggles at a few hundred.
 *
 * THE CANVAS RIDES THE MAP PANE. See NasCanvas: targets are drawn in LAYER
 * coordinates and the pane's own CSS transform carries them during a drag, so a
 * pan costs zero redraws and cannot lag the tiles. The first version cancelled
 * that transform and redrew on a 110 ms throttle, which pinned stale pixels to
 * the screen while the tiles moved underneath — the targets visibly swam.
 *
 * DEAD RECKONING, BECAUSE THE FEED IS NOT THE FRAME RATE. Positions arrive every
 * two seconds at best and SFDPS reports every twelve, so drawing only on arrival
 * makes every target jump. Each one is advanced along its own track between
 * updates — same formula as eram.js, and the same units trap: ground speed is
 * KNOTS, so a minute of travel is gs/3600 degrees, not gs/60.
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
    // Bright enough to FIND against the dark basemap. It was #5a6472, which is
    // only a shade off the map itself — a target you cannot see is not
    // de-emphasised, it is missing, and this class is ~20% of the picture.
    // It stays the coolest and least saturated of the six, so it still reads as
    // the bottom of the hierarchy rather than competing with real traffic.
    Primary: '#9fb0c4',
};

// Dead reckoning is a lie that gets worse with time, so it is capped: past this a
// target is drawn where it was last actually reported. 60 s is five SFDPS cycles —
// beyond that the aircraft may well have turned.
const DR_MAX_MS = 60000;
// Labels are unreadable in a crowd and expensive to lay out, so they are
// suppressed above this many on screen however the checkbox is set.
const TRAIL_MIN_MS = 4000;   // don't record a trail dot more often than this
const DR_TICK_MS = 110;      // idle repaint rate, so dead reckoning is visible

// ── Map ────────────────────────────────────────────────────────────────────────
const map = L.map('map', {
    // Leaflet puts the zoom control top-left by default, which is exactly where
    // common.css floats the HOME button — they overlapped.
    zoomControl: false,
    attributionControl: false,
    worldCopyJump: true,
    minZoom: 3,
    maxZoom: 14,
}).setView([39.0, -97.0], 4);

L.control.zoom({ position: 'bottomleft' }).addTo(map);
L.tileLayer('/basemap/dark_nolabels/{z}/{x}/{y}{r}.png', { maxZoom: 14 }).addTo(map);

// Weather under boundaries under traffic. Leaflet's own overlayPane is 400.
map.createPane('nasWx');
map.getPane('nasWx').style.zIndex = 250;
map.createPane('nasBounds');
map.getPane('nasBounds').style.zIndex = 400;
map.getPane('nasBounds').style.pointerEvents = 'none';
map.createPane('nasTargets');
map.getPane('nasTargets').style.zIndex = 450;
map.getPane('nasTargets').style.pointerEvents = 'none';

const $ = id => document.getElementById(id);

// A numeric control, with a fallback. Reading `+el.value` raw returns NaN for a
// blank or unrecognised option — and `4 * NaN` is NaN, which draws every symbol at
// radius NaN and empties the map with no error at all. (Found by setting size to
// "1.0" when the option value is "1": the page looked exactly like a dead renderer.)
// A stale persisted value or a future option rename would do the same.
function num(id, fallback) {
    const v = parseFloat($(id)?.value);
    return Number.isFinite(v) ? v : fallback;
}

// ── Weather ────────────────────────────────────────────────────────────────────
let wxLayer = null;
function updateWx() {
    const on = $('wx').checked;
    if (wxLayer) { map.removeLayer(wxLayer); wxLayer = null; }
    if (!on) return;
    // The layer name is `nexrad-n0q-900913`, NOT `nexrad-n0q` — the short name is
    // not in IEM's GetCapabilities at all and silently returns nothing, which cost
    // this repo a debugging round once already.
    wxLayer = L.tileLayer.wms('https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0q.cgi', {
        layers: 'nexrad-n0q-900913',
        format: 'image/png',
        transparent: true,
        opacity: num('wxop', 45) / 100,
        pane: 'nasWx',
    }).addTo(map);
}
setInterval(() => { if (wxLayer) updateWx(); }, 5 * 60 * 1000);

// ── The canvas layer ───────────────────────────────────────────────────────────
//
// This mirrors what L.Renderer does for Leaflet's own vector layers, and for the
// same reason: a canvas whose pixels are addressed in LAYER space is carried by
// the map pane's transform during a pan and scaled during a zoom animation, so it
// stays glued to the ground with no work at all. Only when the view settles — or
// when a drag runs past the padded edge — does it reposition and redraw.
const PAD = 0.4;   // extra canvas, in screens, on each side: pan headroom

const NasCanvas = L.Layer.extend({
    onAdd() {
        this._canvas = L.DomUtil.create('canvas', '');
        this._canvas.style.position = 'absolute';
        this._ctx = this._canvas.getContext('2d');
        map.getPane('nasTargets').appendChild(this._canvas);
        this.reset();
    },

    getEvents() {
        return {
            viewreset: this.reset,
            moveend: this.reset,
            zoomend: this.reset,
            resize: this.reset,
            move: this._onMove,
            zoom: this._onZoom,
            zoomanim: this._onAnimZoom,
        };
    },

    // Re-anchor the canvas to the current view and redraw it crisply.
    reset() {
        const size = map.getSize();
        const padded = size.multiplyBy(1 + 2 * PAD).round();
        const min = map.containerPointToLayerPoint(size.multiplyBy(-PAD)).round();

        this._origin = min;
        this._bounds = new L.Bounds(min, min.add(padded));
        this._center = map.getCenter();
        this._zoom = map.getZoom();

        dpr = window.devicePixelRatio || 1;
        this._canvas.width = Math.round(padded.x * dpr);
        this._canvas.height = Math.round(padded.y * dpr);
        this._canvas.style.width = padded.x + 'px';
        this._canvas.style.height = padded.y + 'px';
        L.DomUtil.setTransform(this._canvas, min, 1);
        draw();
    },

    // During a drag the pane transform does the work. The only thing that needs
    // doing is noticing when the view has run past the padding, which a long fling
    // or an animated pan will do, and re-anchoring before the edge shows.
    _onMove() {
        if (!this._bounds) return;
        const size = map.getSize();
        const tl = map.containerPointToLayerPoint([0, 0]);
        if (!this._bounds.contains(tl) || !this._bounds.contains(tl.add(size))) this.reset();
    },

    _onZoom() { this._updateTransform(map.getCenter(), map.getZoom()); },
    _onAnimZoom(e) { this._updateTransform(e.center, e.zoom); },

    // Scale and shift the already-drawn pixels to match a zoom in progress, so the
    // targets grow with the tiles instead of jumping at the end of the animation.
    // `_getNewPixelOrigin` is Leaflet-internal; this is the same call L.Renderer
    // makes, and reimplementing the projection maths to avoid it would be worse.
    _updateTransform(center, zoom) {
        if (!this._bounds) return;
        const scale = map.getZoomScale(zoom, this._zoom);
        const offset = map.getSize().multiplyBy(0.5 + PAD).multiplyBy(-scale)
            .add(map.project(this._center, zoom))
            .subtract(map._getNewPixelOrigin(center, zoom));
        L.DomUtil.setTransform(this._canvas, offset, scale);
    },

    // Screen position within the canvas, for a geographic point.
    pt(lat, lon) { return map.latLngToLayerPoint([lat, lon]).subtract(this._origin); },
});

// The layer is INSTANTIATED AT THE BOTTOM OF THIS FILE, not here, because
// addTo(map) runs onAdd -> reset -> draw synchronously and draw touches half the
// module's state. Every `const`/`let` below this point would be in its temporal
// dead zone at that moment, so each one throws on page load in turn -- and the
// throw escapes module evaluation, so NOTHING after it runs: the socket never
// connects and the page sits on "connecting" with an empty canvas. Chasing the
// names one at a time is whack-a-mole; ordering the construction after the
// declarations removes the whole class. `node --check` cannot see any of it,
// because it is a runtime error and not a syntax one.
let dpr = 1;
let layer = null;

// ── Dead reckoning ─────────────────────────────────────────────────────────────
function displayPos(t, now) {
    const dt = Math.min(now - t.t, DR_MAX_MS);
    if (dt <= 0 || !t.gs || t.trk === null || t.trk === undefined) return [t.lat, t.lon];
    // gs is KNOTS — nautical miles per hour. Degrees of latitude per hour is gs/60,
    // so per millisecond it is gs/60/3600000. The factor the TBFM map got wrong by 60.
    const nm = t.gs * (dt / 3600000);
    const rad = t.trk * Math.PI / 180;
    const cosLat = Math.cos(t.lat * Math.PI / 180) || 1e-6;
    return [t.lat + nm / 60 * Math.cos(rad), t.lon + nm / 60 * Math.sin(rad) / cosLat];
}

// ── Color ─────────────────────────────────────────────────────────────────────
//
// Three modes. CLASS is what a controller-style display does: color says what
// kind of thing it is. ALTITUDE and ENERGY are what an overview browser wants:
// color says where in the vertical the traffic is, which is the question a
// whole-NAS view is actually good at answering.
const RAMP = [
    [0, [255, 112, 67]],       // surface — warm
    [5000, [255, 183, 77]],
    [12000, [255, 224, 130]],
    [20000, [126, 231, 135]],
    [30000, [78, 201, 255]],
    [40000, [124, 140, 255]],
    [52000, [199, 125, 255]],  // above anything civil — cool
];

function ramp(v) {
    if (!(v > RAMP[0][0])) return rgb(RAMP[0][1]);
    for (let i = 1; i < RAMP.length; i++) {
        if (v <= RAMP[i][0]) {
            const [v0, c0] = RAMP[i - 1], [v1, c1] = RAMP[i];
            const f = (v - v0) / (v1 - v0);
            return rgb([0, 1, 2].map(k => Math.round(c0[k] + f * (c1[k] - c0[k]))));
        }
    }
    return rgb(RAMP[RAMP.length - 1][1]);
}
const rgb = c => `rgb(${c[0]},${c[1]},${c[2]})`;

// Specific energy height: the altitude an aircraft could reach by trading all its
// speed for height, h + v²/2g. A real quantity, not a made-up blend of two
// numbers — and the one that makes a fast low aircraft and a slow high one read
// as comparable, which is the whole point of asking for "energy". At 450 kt the
// kinetic term is about 9,000 ft.
const KT_TO_MS = 0.514444, G = 9.80665, M_TO_FT = 3.28084;
function energyFt(alt, gs) {
    const v = (gs || 0) * KT_TO_MS;
    return (alt || 0) + (v * v) / (2 * G) * M_TO_FT;
}

function colorOf(t) {
    switch ($('color').value) {
        case 'alt': return ramp(t.alt || 0);
        case 'energy': return ramp(energyFt(t.alt, t.gs));
        default: return CLASS_COLOR[t.cls] || '#8b94a2';
    }
}

// ── Symbols ────────────────────────────────────────────────────────────────────
//
// One shape per class, so the kind of target is legible even when color is
// carrying altitude instead. Two of these borrow conventions already in this
// repo rather than inventing new ones: ERAM draws an uncorrelated primary as a
// '+', and the ASDE-X scope draws a vehicle as a square.
//
// The airborne classes are heading-oriented; the ones with no identity are
// deliberately NOT drawn as airplanes. A triangle asserts a nose, and therefore
// an aircraft — which is a claim the data does not make for a primary return,
// about half of which are not aircraft at all.
function drawSymbol(g, t, x, y, r, col, emph) {
    const trk = t.trk || 0;
    const a = trk * Math.PI / 180;
    const sin = Math.sin(a), cos = Math.cos(a);
    // Rotate (dx, dy) where -y is the nose, into screen space.
    const P = (dx, dy) => [x + dx * cos - dy * sin, y + dx * sin + dy * cos];

    g.lineWidth = emph ? 1.6 : 1;
    g.strokeStyle = emph ? '#ffffff' : col;
    g.fillStyle = col;

    const tri = () => {
        const p1 = P(0, -r * 1.25), p2 = P(r * 0.78, r * 0.9), p3 = P(-r * 0.78, r * 0.9);
        g.beginPath();
        g.moveTo(p1[0], p1[1]); g.lineTo(p2[0], p2[1]); g.lineTo(p3[0], p3[1]);
        g.closePath();
    };

    switch (t.cls) {
        case 'EnRoute':
            tri(); g.fill();
            if (emph) g.stroke();
            break;

        case 'Terminal':
            // Same shape hollow: still an airplane with a heading, visibly a
            // different layer of the system.
            tri();
            g.strokeStyle = col; g.lineWidth = emph ? 1.8 : 1.1;
            g.stroke();
            if (emph) { g.strokeStyle = '#ffffff'; g.stroke(); }
            break;

        case 'Surface': {
            // A fuselage along the track. On the ground an airplane still has a
            // direction, but it is not flying, and a delta would read as airborne.
            const L1 = P(0, -r * 1.2), L2 = P(0, r * 1.2);
            g.lineCap = 'round';
            g.lineWidth = Math.max(2, r * 0.95);
            g.strokeStyle = col;
            g.beginPath(); g.moveTo(L1[0], L1[1]); g.lineTo(L2[0], L2[1]); g.stroke();
            g.lineCap = 'butt';
            if (emph) {
                g.lineWidth = 1; g.strokeStyle = '#ffffff';
                g.beginPath(); g.arc(x, y, r * 1.5, 0, 6.283); g.stroke();
            }
            break;
        }

        case 'Untagged': {
            // Hollow circle plus a heading tick: the radar gives a track, but
            // nothing in the NAS says what this is.
            g.beginPath(); g.arc(x, y, r * 0.82, 0, 6.283);
            g.strokeStyle = col; g.lineWidth = emph ? 1.8 : 1.1; g.stroke();
            if (t.gs) {
                const q = P(0, -r * 1.7);
                g.beginPath(); g.moveTo(x, y); g.lineTo(q[0], q[1]); g.stroke();
            }
            if (emph) {
                g.strokeStyle = '#ffffff'; g.lineWidth = 1;
                g.beginPath(); g.arc(x, y, r * 1.5, 0, 6.283); g.stroke();
            }
            break;
        }

        case 'Vehicle':
            // Square, unrotated — the ASDE-X scope's convention.
            g.fillRect(x - r * 0.75, y - r * 0.75, r * 1.5, r * 1.5);
            if (emph) g.strokeRect(x - r * 1.2, y - r * 1.2, r * 2.4, r * 2.4);
            break;

        default: {
            // Primary only: ERAM's '+' for an uncorrelated return.
            //
            // Drawn over a dark halo rather than merely brightened. A one-pixel
            // cross is hard to pick out wherever the basemap happens to be light
            // — a city, a coastline, a NEXRAD cell — and raising the colour alone
            // cannot fix the places where the BACKGROUND is the problem.
            const k = r * 0.95;
            g.strokeStyle = 'rgba(8,11,16,0.85)';
            g.lineWidth = (emph ? 1.8 : 1.2) + 2;
            g.beginPath();
            g.moveTo(x - k, y); g.lineTo(x + k, y);
            g.moveTo(x, y - k); g.lineTo(x, y + k);
            g.stroke();
            g.strokeStyle = col; g.lineWidth = emph ? 1.8 : 1.2;
            g.beginPath();
            g.moveTo(x - k, y); g.lineTo(x + k, y);
            g.moveTo(x, y - k); g.lineTo(x, y + k);
            g.stroke();
            if (emph) {
                g.strokeStyle = '#ffffff'; g.lineWidth = 1;
                g.beginPath(); g.arc(x, y, r * 1.6, 0, 6.283); g.stroke();
            }
            break;
        }
    }
}

// ── Painting ───────────────────────────────────────────────────────────────────
let paintQueued = false;
function paint() {
    if (paintQueued) return;
    paintQueued = true;
    requestAnimationFrame(() => { paintQueued = false; draw(); });
}
// Idle repaints so dead reckoning is visible. A pan needs none of these: the pane
// transform moves the pixels, so this stays at a modest rate even while dragging.
setInterval(paint, DR_TICK_MS);

function altOk(t) {
    const v = $('alt').value;
    if (v === 'all') return true;
    const [lo, hi] = v.split('-').map(Number);
    const a = t.alt || 0;
    return a >= lo && a < hi;
}

// ── Labels ─────────────────────────────────────────────────────────────────────
//
// Which fields a label carries is a setting, because the useful answer depends
// entirely on the question: a continental overview wants a callsign and nothing
// else, and one airport's arrivals want type and speed as well.
//
// THE HARD PART IS NOT THE TEXT, IT IS THE PLACEMENT. Labels are the one thing
// on this map whose size does not shrink as you zoom out, so the same 400 targets
// that are comfortable over one TRACON are a solid block of overlapping text over
// CONUS. Three rules keep that readable, and the third is what makes the other
// two worth having:
//
//   1. placement is CHOSEN, not fixed - eight candidate anchors around the
//      target, first free one wins;
//   2. a label that fits nowhere is DROPPED rather than drawn on top of another,
//      because two overlapping labels are strictly worse than one label;
//   3. placement is STICKY and the order is deterministic, so the arrangement
//      does not reshuffle on every frame. Without this the first two rules
//      produce a legible still image and an unreadable moving one - which is
//      exactly the sort of thing that looks fine in a screenshot.
//
// The occupancy test is a coarse hash grid rather than pairwise rectangle
// intersection: at 400 labels that is 160,000 comparisons a frame against a few
// thousand cell probes, and this runs inside the same rAF as the targets.
// 6 px, not 12. The grid ROUNDS UP to whole cells, so a coarse cell reserves space
// the label does not occupy -- at a 10 px line height a 12 px cell over-reserves by
// most of a line, and over three lines and a few hundred labels that is most of the
// screen claimed by nothing. The extra probes are a few thousand integer lookups.
const LB_CELL = 6;
const LB_BUDGET = 700;          // hard cap on labels per frame - a CPU guard
const LABEL_MAX = 400;          // 'auto' draws labels only below this many targets

// Candidate anchors, in preference order: right of the target first (reading
// direction), then left, then the diagonals, then directly above and below.
const LB_DIRS = [
    [1, 0], [-1, 0], [1, -1], [1, 1], [-1, -1], [-1, 1], [0, -1], [0, 1],
];

// Two rings. The first sits against the symbol; the second is pushed out far enough
// to clear a neighbor's label, and earns a LEADER LINE because at that distance the
// association between a label and its target stops being obvious -- which is why
// every real scope in this repo draws one.
//
// Measured at Atlanta, zoom 9, 310 targets: one ring labelled 105 and dropped 209.
// A target whose own neighborhood is full is usually one of a cluster, and a cluster
// is exactly where a label is worth having.
const LB_RINGS = [1, 2.6];
const LB_ANCHORS = [];
for (let ring = 0; ring < LB_RINGS.length; ring++)
    for (const d of LB_DIRS) LB_ANCHORS.push([d[0], d[1], LB_RINGS[ring], ring]);

const lbGrid = new Set();
function lbKey(cx, cy) { return cx * 100000 + cy; }

function lbFree(x, y, w, h) {
    const c0 = Math.floor(x / LB_CELL), c1 = Math.floor((x + w) / LB_CELL);
    const r0 = Math.floor(y / LB_CELL), r1 = Math.floor((y + h) / LB_CELL);
    for (let cx = c0; cx <= c1; cx++)
        for (let cy = r0; cy <= r1; cy++)
            if (lbGrid.has(lbKey(cx, cy))) return false;
    return true;
}

function lbTake(x, y, w, h) {
    const c0 = Math.floor(x / LB_CELL), c1 = Math.floor((x + w) / LB_CELL);
    const r0 = Math.floor(y / LB_CELL), r1 = Math.floor((y + h) / LB_CELL);
    for (let cx = c0; cx <= c1; cx++)
        for (let cy = r0; cy <= r1; cy++) lbGrid.add(lbKey(cx, cy));
}

/// The lines this target's label should carry, given the field toggles. Line 1 is
/// the identity; everything else is packed onto as few further lines as possible,
/// because label HEIGHT is what collides on a busy screen.
function labelLines(t, f) {
    const lines = [];
    if (f.id) {
        // An untagged return has no callsign. Its facility is the honest answer to
        // "what is this", and without the fallback half the map labels nothing.
        let top = t.cs || t.fac || t.apt;
        if (!top && !f.sq) top = t.sqk;   // else SQ already carries it on line 2
        if (top) lines.push(top);
    }
    const second = [];
    if (f.type && t.type) second.push(t.type);
    if (f.alt && t.alt) second.push(altTag(t.alt));
    if (f.spd && t.gs) second.push(String(t.gs));
    if (f.sq && t.sqk) second.push(t.sqk);
    if (second.length) lines.push(second.join(' '));
    if (f.rte && (t.org || t.dst)) lines.push(`${t.org || '?'}-${t.dst || '?'}`);
    return lines;
}

// Zero-padded hundreds of feet - the data-block convention every scope in this
// repo already uses, and what this map was already drawing.
//
// Deliberately NOT the FL-above-18,000 rule that /track and the bot follow. That
// rule is about PROSE, where "at FL10" for an aircraft on final is the wrong unit
// for the reader; a data block is read as hundreds of feet by definition and
// mixing two notations into one column is worse than either.
function altTag(alt) {
    return String(Math.round(alt / 100)).padStart(3, '0');
}

function labelFields() {
    return {
        id: $('lfId').checked, type: $('lfType').checked, alt: $('lfAlt').checked,
        spd: $('lfSpd').checked, rte: $('lfRte').checked, sq: $('lfSq').checked,
    };
}

// Last-drawn screen positions, so hover and click pick off what is actually on
// screen instead of re-projecting every target on every mouse move.
let visList = [];

function draw() {
    const g = layer && layer._ctx;
    if (!g || !layer._origin) return;
    const W = layer._canvas.width, H = layer._canvas.height;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    g.scale(dpr, dpr);

    const now = Date.now();
    const trailN = num('trail', 4);
    const leaderMin = num('leader', 1);
    const lbMode = $('labels').value;
    const r = 4 * num('size', 1);
    const w = W / dpr, h = H / dpr;
    const pad = 30;

    visList = [];
    for (const t of targets.values()) {
        if (!altOk(t)) continue;
        const [lat, lon] = displayPos(t, now);
        const p = layer.pt(lat, lon);
        if (p.x < -pad || p.y < -pad || p.x > w + pad || p.y > h + pad) continue;
        t._sx = p.x; t._sy = p.y; t._lat = lat; t._lon = lon;
        visList.push(t);
    }
    const labels = lbMode === 'on' || (lbMode === 'auto' && visList.length <= LABEL_MAX);

    // Trails first, so targets sit on top of their own history.
    if (trailN > 0) {
        for (const t of visList) {
            if (!t.trail.length) continue;
            const col = colorOf(t);
            const from = Math.max(0, t.trail.length - trailN);
            for (let i = from; i < t.trail.length; i++) {
                const q = layer.pt(t.trail[i][0], t.trail[i][1]);
                const age = (t.trail.length - i) / Math.max(1, trailN);
                g.fillStyle = col;
                g.globalAlpha = 0.5 * (1 - age) + 0.08;
                const s = Math.max(1, r * 0.35);
                g.fillRect(q.x - s / 2, q.y - s / 2, s, s);
            }
        }
        g.globalAlpha = 1;
    }

    // Leaders.
    if (leaderMin > 0) {
        g.lineWidth = 0.6;
        g.globalAlpha = 0.45;
        for (const t of visList) {
            if (!t.gs || t.trk === null || t.trk === undefined) continue;
            const nm = t.gs * (leaderMin / 60);
            const rad = t.trk * Math.PI / 180;
            const cosLat = Math.cos(t._lat * Math.PI / 180) || 1e-6;
            const q = layer.pt(t._lat + nm / 60 * Math.cos(rad),
                               t._lon + nm / 60 * Math.sin(rad) / cosLat);
            g.strokeStyle = colorOf(t);
            g.beginPath(); g.moveTo(t._sx, t._sy); g.lineTo(q.x, q.y); g.stroke();
        }
        g.globalAlpha = 1;
    }

    // Targets.
    for (const t of visList) {
        drawSymbol(g, t, t._sx, t._sy, r, colorOf(t), t.id === hoverId || t.id === selId);
    }

    // Labels last so nothing is drawn over them.
    lastLabelStat = null;
    if (labels) drawLabels(g, r);
}

let lastLabelStat = null;

function drawLabels(g, r) {
    const f = labelFields();
    const fs = Math.round(8 + r);
    const lineH = fs + 2;
    g.font = `${fs}px Consolas, monospace`;
    g.textBaseline = 'top';

    lbGrid.clear();
    // Every TARGET is an obstacle before any label is placed - a label parked on
    // another aircraft hides the thing the map is for. Same rule the ASDE-X auto
    // offset follows, and the reason it has to happen in a separate pass first.
    for (const t of visList) lbTake(t._sx - r, t._sy - r, r * 2, r * 2);

    // Deterministic order so the arrangement is reproducible frame to frame:
    // identified traffic gets first refusal on the space, ties broken by id and
    // never by iteration order.
    const order = visList.slice().sort((a, b) => {
        const pa = a.cs ? 0 : 1, pb = b.cs ? 0 : 1;
        return pa !== pb ? pa - pb : (a.id - b.id);
    });

    let drawn = 0, dropped = 0;
    for (const t of order) {
        if (drawn >= LB_BUDGET) { dropped++; continue; }
        const lines = labelLines(t, f);
        if (!lines.length) continue;

        let w = 0;
        for (const ln of lines) w = Math.max(w, g.measureText(ln).width);
        const h = lines.length * lineH;
        const gap = r + 3;

        // Sticky: the anchor that worked last frame is tried first, so a label
        // only moves when it actually has to. Without this, two targets drifting
        // past each other trade places every frame and both become unreadable.
        let px = 0, py = 0, placed = false;
        const tryOrder = t._lb === undefined ? LB_ANCHORS
                       : [LB_ANCHORS[t._lb], ...LB_ANCHORS];
        let ring = 0;
        for (let i = 0; i < tryOrder.length; i++) {
            const [dx, dy, mul, rg] = tryOrder[i];
            const off = gap * mul;
            const x = t._sx + (dx > 0 ? off : dx < 0 ? -off - w : -w / 2);
            const y = t._sy + (dy > 0 ? off : dy < 0 ? -off - h : -h / 2);
            if (!lbFree(x, y, w, h)) continue;
            px = x; py = y; placed = true; ring = rg;
            // tryOrder holds references INTO LB_ANCHORS, so indexOf recovers the
            // canonical slot whether this came from the sticky probe or the scan.
            t._lb = LB_ANCHORS.indexOf(tryOrder[i]);
            break;
        }
        // Nowhere free: DROP it. Drawing it anyway would make two labels
        // unreadable instead of one, which is a strictly worse trade, and at this
        // density the target symbol is still there to hover.
        if (!placed) { dropped++; t._lb = undefined; continue; }

        lbTake(px, py, w, h);
        // A leader only on the outer ring: on the inner one the label is touching
        // its own symbol and a line would just be ink.
        if (ring > 0) {
            g.strokeStyle = 'rgba(139,148,162,0.45)';
            g.lineWidth = 0.6;
            g.beginPath();
            g.moveTo(t._sx, t._sy);
            g.lineTo(px < t._sx ? px + w : px, py + h / 2);
            g.stroke();
        }
        for (let i = 0; i < lines.length; i++) {
            g.fillStyle = i === 0 ? (t.cs ? '#e6edf3' : '#9aa4b2') : '#8b94a2';
            g.fillText(lines[i], px, py + i * lineH);
        }
        drawn++;
    }
    g.textBaseline = 'alphabetic';
    lastLabelStat = { drawn, dropped };
}

// ── Boundaries ─────────────────────────────────────────────────────────────────
//
// Three sources, deliberately kept separate because they are not the same data:
//
//   ARTCC      vNAS ArtccBoundaries.geojson — one lateral outline per center.
//              There is no high/low variant of an ARTCC boundary, so there is no
//              altitude control over this one.
//   SECTORS    vNAS Fixed Airspace Volumes: real volumes with a numeric floor and
//              ceiling per slab, so the ALTITUDE filter RESHAPES them. That is
//              what the FAVs can do and the KML cannot.
//   KML        the legacy AllSectors/AllHigh/AllLow files. Kept because they are
//              what exists offline, parsed by the same shared module the ERAM
//              scope uses. ~4.5 MB and parsed in the browser, so strictly on
//              demand and never by default.
const bndLayers = { artcc: null, sectors: null, kml: null };
const favCache = new Map();     // "ZDC|lo|hi" -> GeoJSON
const kmlCache = new Map();     // filename -> parsed sectors
let artccGeo = null;

const BND_STYLE = {
    artcc: { color: '#5b708a', weight: 1.4, opacity: 0.85, fill: false, interactive: false },
    sectors: { color: '#48617d', weight: 0.7, opacity: 0.7, fill: false, interactive: false },
    kml: { color: '#6b5a7d', weight: 0.7, opacity: 0.7, fill: false, interactive: false },
};

async function loadArtcc() {
    if (!artccGeo) {
        const r = await fetch('/api/airspace/artcc-boundaries');
        if (!r.ok) throw new Error('artcc-boundaries ' + r.status);
        artccGeo = await r.json();
    }
    return artccGeo;
}

function clearBnd(k) {
    if (bndLayers[k]) { map.removeLayer(bndLayers[k]); bndLayers[k] = null; }
}

async function updateArtccLayer() {
    clearBnd('artcc');
    if (!$('bArtcc').checked) return;
    try {
        const geo = await loadArtcc();
        bndLayers.artcc = L.geoJSON(geo, {
            pane: 'nasBounds',
            style: BND_STYLE.artcc,
            // interactive:false everywhere, so a boundary can never take a hover
            // or a click from a target — the lesson the TBFM map learned.
            interactive: false,
        }).addTo(map);
    } catch (e) { console.warn('[NAS] ARTCC boundaries:', e.message); }
}

// Which centers the current view touches, so the sector layer loads a handful of
// ARTCCs rather than all 24 (2,641 volumes, 75,185 points nationally).
function artccsInView() {
    if (!artccGeo) return [];
    const b = map.getBounds().pad(0.1);
    const out = [];
    for (const f of artccGeo.features) {
        const ring = f.geometry?.coordinates?.[0] || [];
        let hit = false;
        for (const [lon, lat] of ring) {
            if (b.contains([lat, lon])) { hit = true; break; }
        }
        // A view wholly inside one center contains none of its vertices, so also
        // take the center whose bounding box contains the view's middle.
        if (!hit) {
            let s = 90, w = 180, n = -90, e = -180;
            for (const [lon, lat] of ring) {
                if (lat < s) s = lat; if (lat > n) n = lat;
                if (lon < w) w = lon; if (lon > e) e = lon;
            }
            const c = b.getCenter();
            hit = c.lat >= s && c.lat <= n && c.lng >= w && c.lng <= e;
        }
        if (hit) out.push(f.properties.id);
    }
    return out;
}

function altBand() {
    const v = $('alt').value;
    if (v === 'all') return null;
    const [lo, hi] = v.split('-').map(Number);
    return [lo, hi];
}

const SECTOR_ARTCC_MAX = 8;

async function updateSectorLayer() {
    clearBnd('sectors');
    if (!$('bSectors').checked) return;
    const note = $('bndNote');
    try {
        await loadArtcc();
        const ids = artccsInView().slice(0, SECTOR_ARTCC_MAX);
        if (!ids.length) { note.textContent = 'Zoom to US airspace for sector volumes.'; return; }
        const band = altBand();
        const group = L.layerGroup([], { pane: 'nasBounds' });
        let vols = 0;
        for (const id of ids) {
            const key = `${id}|${band ? band.join('-') : 'all'}`;
            let geo = favCache.get(key);
            if (!geo) {
                const q = band ? `?lowFt=${band[0]}&highFt=${band[1]}` : '';
                const r = await fetch(`/api/airspace/favs/${id}${q}`);
                if (!r.ok) continue;
                geo = await r.json();
                favCache.set(key, geo);
            }
            // An exclusion is a 3-D subtraction, not a boundary anyone works to,
            // and the 99k sentinel volumes encode something unknown — drawing
            // either as an outline would show a sector that isn't there.
            const feats = (geo.features || []).filter(f =>
                !f.properties?.exclude && !f.properties?.sentinel);
            vols += feats.length;
            if (feats.length) {
                L.geoJSON({ type: 'FeatureCollection', features: feats }, {
                    pane: 'nasBounds', style: BND_STYLE.sectors, interactive: false,
                }).addTo(group);
            }
        }
        group.addTo(map);
        bndLayers.sectors = group;
        note.textContent = `${vols.toLocaleString()} volumes · ${ids.join(' ')}`
            + (band ? ` · ${band[0].toLocaleString()}–${band[1].toLocaleString()} ft` : ' · all altitudes');
    } catch (e) {
        console.warn('[NAS] sector volumes:', e.message);
        note.textContent = 'Sector volumes unavailable.';
    }
}

async function updateKmlLayer() {
    clearBnd('kml');
    const file = $('bKml').value;
    const note = $('kmlNote');
    if (!file) { note.textContent = ''; return; }
    note.textContent = 'loading…';
    try {
        let sectors = kmlCache.get(file);
        if (!sectors) {
            sectors = await window.KmlSectors.parse(file);
            kmlCache.set(file, sectors);
        }
        const group = L.layerGroup([], { pane: 'nasBounds' });
        for (const s of sectors) {
            L.polyline(s.coords, { pane: 'nasBounds', ...BND_STYLE.kml }).addTo(group);
        }
        group.addTo(map);
        bndLayers.kml = group;
        note.textContent = `${sectors.length.toLocaleString()} placemarks`;
    } catch (e) {
        console.warn('[NAS] KML:', e.message);
        note.textContent = 'Not available on this deployment.';
    }
}

// Sector volumes depend on the viewport, so they reload when it settles — but
// only when that layer is on, since each reload is a handful of fetches.
map.on('moveend zoomend', () => { if ($('bSectors').checked) updateSectorLayer(); });

// Offer only the KML files this deployment actually has: they are gitignored and
// a fresh checkout has none, so a fixed list would advertise three dead options.
(async () => {
    try {
        const r = await fetch('/api/kml');
        if (!r.ok) return;
        const files = await r.json();
        const sel = $('bKml');
        for (const f of files) {
            const o = document.createElement('option');
            o.value = f;
            o.textContent = f.replace(/\.kml$/i, '').replace(/^All/, '');
            sel.appendChild(o);
        }
        if (!files.length) $('kmlRow').style.display = 'none';
    } catch { $('kmlRow').style.display = 'none'; }
})();

// ── Flow restrictions ──────────────────────────────────────────────────────────
//
// What is holding traffic, drawn where it is being held. Two sources that answer
// DIFFERENT questions and are deliberately not combined into one number:
//
//   TBFM  arrival metering — airborne holding into a field. The figure is the
//         governing hold, which the server computes as the chain MAXIMUM; summing
//         the per-center delays double-counts, because TBFM distributes a hold
//         upstream and a center that has absorbed it reads ~0 one point down.
//   TFDM  the field itself — runway configuration, AAR/ADR, closures and terminal
//         restrictions (MIT/MINIT). Surface and departure, not arrival.
//
// An airport can easily have one without the other, so the ring shows the metering
// hold and the chip turns amber when TFDM has something in force.
let flowLayer = null, flowTimer = null, flowData = null;

// TFDM reports gridlock as an enum whose NEGATIVE values are the common case --
// NO_PREDICTED_GRIDLOCK, NONE. Rendering those put "ATL NO_PREDICTED_GRIDLOCK" on
// the map as though the absence of a problem were a restriction.
const gridlocked = v => !!v && !/^NO/i.test(v) && v.toUpperCase() !== 'NONE';

// At continental zoom 36 chips overlap into an unreadable band across the east, so
// detail is earned by zooming: far out, only the airport and the hold.
const FLOW_DETAIL_ZOOM = 6;
const FLOW_MAX_CHIPS = 40;

// TBFM's "no restriction" default is 3,600/hour — not a rate. 53 of 57 published
// AARs sat at exactly that, including fields that could not take one an hour, so
// the server's `aarRestricted` flag is what to read and this is only a guard for
// anything that reaches the client raw.
const RATE_UNRESTRICTED = 3600;

async function updateFlow() {
    if (flowLayer) { map.removeLayer(flowLayer); flowLayer = null; }
    clearInterval(flowTimer);
    const note = $('flowNote');
    if (!$('bFlow').checked) { note.textContent = ''; return; }

    const load = async () => {
        try {
            const r = await fetch('/api/nas/flow');
            if (!r.ok) throw new Error(r.status);
            const d = await r.json();
            if (!$('bFlow').checked) return;
            if (flowLayer) { map.removeLayer(flowLayer); flowLayer = null; }

            flowData = d;
            drawFlow();
        } catch (e) {
            console.warn('[NAS] flow:', e.message);
            note.textContent = 'Flow data unavailable.';
        }
    };
    await load();
    // TBFM schedules and TFDM airport records both move on the order of a minute;
    // a 30 s refresh is well inside that and costs one small request.
    flowTimer = setInterval(load, 30000);
}

// ── Flow areas: FEA and FCA ────────────────────────────────────────────────────
//
// TFMS publishes the actual outline of every flow area, with a floor, a ceiling
// and its own active window. The bridge parses it now; this draws it.
//
// FEA AND FCA ARE SEPARATE SWITCHES because they mean different things. An FCA is
// a constraint; an FEA is a traffic manager watching a volume with nothing
// restricted. They arrive in the same message in the same shape and the FEAs are
// far more numerous, so one combined toggle would paint the country with boxes
// that mean nothing is wrong.
//
// A LINE IS DRAWN AS A LINE. An FCA can be a flow line aircraft cross rather than
// an area they are inside, and closing it into a two-point ring draws a shape with
// no interior that merely looks right.
let fcaLayer = null, fcaTimer = null, fcaData = null;

const FCA_STYLE = {
    FCA: { color: '#ffb02e', weight: 1.6, opacity: 0.9, fillOpacity: 0.07, dashArray: null },
    FEA: { color: '#5fa8d3', weight: 1.1, opacity: 0.65, fillOpacity: 0.04, dashArray: '5 4' },
};

async function updateFca() {
    const want = $('bFca').checked || $('bFea').checked;
    if (fcaLayer) { map.removeLayer(fcaLayer); fcaLayer = null; }
    clearInterval(fcaTimer);
    if (!want) { $('fcaNote').textContent = ''; return; }

    const load = async () => {
        try {
            const r = await fetch('/api/tfms/fca');
            if (!r.ok) throw new Error(r.status);
            fcaData = await r.json();
            drawFca();
        } catch (e) {
            console.warn('[NAS] fca:', e.message);
            $('fcaNote').textContent = 'Flow areas unavailable.';
        }
    };
    await load();
    // Areas are adaptation-rate, not traffic-rate: they change when a traffic
    // manager draws one, which is minutes apart at the very fastest.
    fcaTimer = setInterval(load, 60000);
}

function drawFca() {
    if (fcaLayer) { map.removeLayer(fcaLayer); fcaLayer = null; }
    if (!fcaData) return;
    const wantFca = $('bFca').checked, wantFea = $('bFea').checked;
    if (!wantFca && !wantFea) return;

    const g = L.layerGroup([], { pane: 'nasBounds' });
    // The SAME altBand() the sector layer uses - it returns null for "all", not a
    // pair. This was briefly a second copy of the function returning [null, null],
    // which in a classic script SHADOWS the first: the sector layer would have
    // started receiving a truthy pair for "all" and queried the FAVs with an empty
    // band. Two copies of one rule, for the fourth time in this repo, and only the
    // linter saw it.
    // Named filterBand, NOT band: the loop below declares its own `band` for the
    // altitude label, and in the same block scope that shadows this one for the
    // whole body -- so `if (band && ...)` above the inner declaration is a temporal
    // dead zone reference and throws on the first area drawn. node --check cannot
    // see it; the linter reported this one as "assigned but never used", which is
    // the symptom of every reference having resolved to the other binding.
    const filterBand = altBand();
    let drawn = 0, offBand = 0, hidden = 0;

    // Chip placement is the same problem as the target labels and takes the same
    // answer. Area centroids cluster hard -- the space-launch hazard areas alone put
    // a dozen names on one patch of Texas -- and a stack of unreadable chips is
    // worse than none. One chip per cell of screen; the OUTLINE is always drawn, it
    // is only the name that is dropped.
    const taken = new Set();
    const cell = p => {
        const q = map.latLngToContainerPoint(p);
        return Math.round(q.x / 64) * 10000 + Math.round(q.y / 18);
    };

    // FCA before FEA, so when the two want one cell the constraint wins it.
    const areas = (fcaData.areas || []).slice().sort((x, y) => {
        const fx = (x.type || '').toUpperCase() === 'FCA' ? 0 : 1;
        const fy = (y.type || '').toUpperCase() === 'FCA' ? 0 : 1;
        return fx !== fy ? fx - fy : String(x.id).localeCompare(String(y.id));
    });

    for (const a of areas) {
        const isFca = (a.type || '').toUpperCase() === 'FCA';
        if (isFca ? !wantFca : !wantFea) continue;
        if (!a.points || a.points.length < 2) continue;

        // The ALTITUDE filter applies, because an area has a real floor and ceiling.
        // An area wholly outside the band the user is looking at is not relevant to
        // the traffic they can see.
        if (filterBand
            && !bandOverlaps(a.floorFt, a.ceilingFt, filterBand[0], filterBand[1])) { offBand++; continue; }

        const st = { pane: 'nasBounds', interactive: false, ...FCA_STYLE[isFca ? 'FCA' : 'FEA'] };
        if (a.shape === 'line') L.polyline(a.points, st).addTo(g);
        else L.polygon(a.points, st).addTo(g);

        // The label is the only interactive thing: shapes stay interactive:false so
        // an area can never take a hover or a click from an aircraft, which is the
        // same rule every other overlay on this map follows.
        const c = centroid(a.points);
        const k = cell(c);
        if (taken.has(k)) { hidden++; drawn++; continue; }
        taken.add(k);
        const band = a.floorFt != null && a.ceilingFt != null
            ? `${Math.round(a.floorFt / 100)}\u2013${Math.round(a.ceilingFt / 100)}` : '';
        L.marker(c, {
            pane: 'nasBounds',
            interactive: true,
            icon: L.divIcon({
                className: 'fca-lb' + (isFca ? ' fca' : ' fea'),
                html: `<b>${esc(a.name || a.id)}</b>${band ? ' ' + band : ''}`
                    + (a.flights ? ` <i>${a.flights}</i>` : ''),
                iconSize: null,
            }),
        }).bindTooltip(
            `<b>${esc(a.name || '')}</b><br>${isFca ? 'Flow Constrained Area' : 'Flow Evaluation Area'}`
            + (a.reason ? ` \u00b7 ${esc(a.reason)}` : '')
            + (band ? `<br>FL${band}` : '')
            + (a.flights ? `<br>${a.flights} flights` : '')
            + (a.facility ? `<br>${esc(a.facility)}` : ''),
            { sticky: true }).addTo(g);
        drawn++;
    }

    fcaLayer = g.addTo(map);
    const d = fcaData;
    $('fcaNote').textContent =
        `${drawn} drawn \u00b7 ${d.active} of ${d.total} in force `
        + `\u00b7 ${d.fca} FCA / ${d.fea} FEA published`
        + (offBand ? ` \u00b7 ${offBand} outside the altitude band` : '')
        + (d.active > d.withShape ? ` \u00b7 ${d.active - d.withShape} with no outline` : '')
        + (hidden ? ` \u00b7 ${hidden} names hidden` : '');
}

// The sidebar altitude filter as feet, or [null, null] when it is "all".
// Inclusive overlap. An area with no published floor or ceiling is treated as
// unbounded that way rather than excluded -- missing is not the same as zero, and
// dropping it would silently hide areas whose band TFMS simply did not state.
function bandOverlaps(floor, ceil, lo, hi) {
    const f = floor == null ? -1e9 : floor;
    const c = ceil == null ? 1e9 : ceil;
    return c >= lo && f <= hi;
}

function centroid(pts) {
    let y = 0, x = 0;
    for (const p of pts) { y += p[0]; x += p[1]; }
    return [y / pts.length, x / pts.length];
}

function drawFlow() {
    if (!flowData || !$('bFlow').checked) return;
    if (flowLayer) { map.removeLayer(flowLayer); flowLayer = null; }

    const detail = map.getZoom() >= FLOW_DETAIL_ZOOM;
    const g = L.layerGroup([], { pane: 'nasBounds' });
    let drawn = 0, held = 0, placed = 0;

    // Ranked before capping, so a crowded screen keeps the WORST restrictions rather
    // than whichever the server happened to list first.
    const sorted = [...flowData.airports].sort((x, y) => (y.maxDelayMin || 0) - (x.maxDelayMin || 0));

    for (const a of sorted) {
        const hold = a.maxDelayMin || 0;
        const t = a.tfdm || {};
        const tfdmHot = !!(t.tmiCount || (t.closed && t.closed.length)
            || gridlocked(t.gridlock)
            || (t.aar && +t.aar > 0 && +t.aar < RATE_UNRESTRICTED));

        // Only draw what is actually saying something. An airport merely reporting a
        // runway configuration is not restricted.
        if (hold < 1 && !tfdmHot && !a.aarRestricted) continue;
        held++;
        if (a.lat === null || a.lon === null) continue;   // NASR did not know it
        placed++;
        if (drawn >= FLOW_MAX_CHIPS) continue;

        // Radius grows with the hold, floored so a flagged field with no airborne
        // hold is still visible.
        const rad = Math.max(6, Math.min(26, 6 + hold * 1.6));
        L.circleMarker([a.lat, a.lon], {
            pane: 'nasBounds', interactive: false,
            radius: rad, weight: 1.2,
            color: hold >= 1 ? '#ff9f6e' : '#ddaa44',
            opacity: 0.85, fillColor: '#ff7043',
            fillOpacity: hold >= 1 ? Math.min(0.28, 0.05 + hold / 90) : 0.04,
        }).addTo(g);

        const bits = [];
        if (hold >= 1) bits.push(`<b>+${hold.toFixed(0)}m</b>`);
        if (detail) {
            const aar = a.aarRestricted ? a.aar
                : (t.aar && +t.aar > 0 && +t.aar < RATE_UNRESTRICTED ? t.aar : null);
            if (aar) bits.push(`AAR ${esc(String(aar))}`);
            if (t.closed && t.closed.length) bits.push(`${t.closed.length} RWY CLSD`);
            if (t.tmiCount) bits.push(`${t.tmiCount} TMI`);
            if (gridlocked(t.gridlock)) bits.push(esc(t.gridlock));
        } else if (tfdmHot) {
            bits.push('●');   // a dot: something is in force, zoom to see what
        }

        L.marker([a.lat, a.lon], {
            pane: 'nasBounds', interactive: false,
            icon: L.divIcon({
                className: '',
                html: `<div class="flow-chip${tfdmHot ? ' hot' : ''}">`
                    + `${esc(a.apt)}${bits.length ? ' ' + bits.join(' ') : ''}</div>`,
                iconSize: null, iconAnchor: [-rad + 2, 6],
            }),
        }).addTo(g);
        drawn++;
    }

    g.addTo(map);
    flowLayer = g;
    $('flowNote').textContent =
        `${drawn} shown of ${held} restricted`
        + (held > placed ? ` · ${held - placed} unplaced` : '')
        + (detail ? '' : ' · zoom in for detail');
}

// ── Stream ─────────────────────────────────────────────────────────────────────
let ws = null, wsTimer = null, lastMsg = 0;

function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/nas/ws`);

    ws.onopen = () => {
        $('status').textContent = 'live';
        $('status').className = 'ok';
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
        $('status').textContent = 'reconnecting…';
        $('status').className = 'bad';
        clearTimeout(wsTimer);
        wsTimer = setTimeout(connect, 3000);
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
}

function apply(m) {
    if (m.type === 'snapshot') targets.clear();
    const now = Date.now();

    for (const r of (m.add || [])) {
        const [id, lat, lon, alt, trk, gs, cls, cs, type, org, dst, owner,
               fac, apt, sqk, dupN] = r;
        const prev = targets.get(id);
        targets.set(id, {
            id, lat, lon, alt, trk, gs,
            cls: CLASS_NAMES[cls] || 'Primary',
            cs: cs || '', type: type || '', org: org || '', dst: dst || '', owner: owner || '',
            // What an UNTAGGED target has instead of an identity. `fac` may name several
            // facilities joined with '+': a primary return near a TRACON boundary is published
            // by both, and with no Mode S and no callsign nothing merges them, so they arrive
            // as two entities on top of each other with only this to tell them apart.
            fac: fac || '', apt: apt || '', sqk: sqk || '',
            // >1 when this row stands for several facilities' copies of one airplane.
            // 0 when not deduping, so the two row forms decode identically.
            dupN: dupN || 0,
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
    const q = $('q').value.trim();
    const msg = {
        cmd: 'view',
        bbox: [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()],
        cap: num('cap', 3000),
        dedupe: $('dedupe').checked,
        cls,
        q: q || undefined,
    };
    const key = JSON.stringify(msg);
    if (!force && key === sendView._last) return;
    sendView._last = key;
    ws.send(key);
}

let viewTimer = null;
map.on('moveend zoomend', () => {
    clearTimeout(viewTimer);
    viewTimer = setTimeout(() => sendView(false), 250);
});

// A silent socket looks identical to an empty sky, so say so rather than showing
// a frozen map as if it were current.
setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const age = Date.now() - lastMsg;
    if (lastMsg && age > 15000) {
        $('status').textContent = `no data ${Math.round(age / 1000)}s`;
        $('status').className = 'bad';
    } else if (lastMsg) {
        $('status').textContent = 'live';
        $('status').className = 'ok';
    }
}, 2000);

// ── Counts and legend ──────────────────────────────────────────────────────────
function renderCounts() {
    $('counts').innerHTML =
        `<b>${shown.toLocaleString()}</b> shown · ${matched.toLocaleString()} in view · `
        + `<b>${total.toLocaleString()}</b> tracked`;
    $('trunc').textContent = truncated
        ? `trimmed to the ${num('cap', 3000).toLocaleString()} limit — zoom in or filter`
        : '';
    for (const n of document.querySelectorAll('.n')) {
        const v = classCounts[n.dataset.n];
        n.textContent = v === undefined ? '' : v.toLocaleString();
    }
}

// The legend has to say what color MEANS, and that changes with the mode. In
// class mode the swatches are the key; in altitude or energy mode they would be
// actively misleading, so they go gray and a gradient scale appears instead.
function renderLegend() {
    const mode = $('color').value;
    document.body.classList.toggle('by-value', mode !== 'class');
    const bar = $('scale');
    if (mode === 'class') { bar.style.display = 'none'; return; }
    bar.style.display = '';
    const stops = RAMP.map(([v, c]) =>
        `${rgb(c)} ${Math.round(100 * v / RAMP[RAMP.length - 1][0])}%`).join(', ');
    $('scaleBar').style.background = `linear-gradient(to right, ${stops})`;
    $('scaleLabel').textContent = mode === 'alt'
        ? 'ALTITUDE  SFC → FL520'
        : 'ENERGY (h + v²/2g)  0 → 52,000 ft';
}

// ── Hover ──────────────────────────────────────────────────────────────────────
let hoverId = null, selId = null;
const tip = $('tip');

// Picks off the LAST DRAWN positions, so it costs a scan of what is on screen
// rather than a re-projection of every target on every mouse move.
function pick(px, py) {
    const o = layer._origin;
    if (!o) return null;
    const lx = px + (map.containerPointToLayerPoint([0, 0]).x - o.x);
    const ly = py + (map.containerPointToLayerPoint([0, 0]).y - o.y);
    const grab = 8 + 3 * num('size', 1);
    let best = null, bestD = grab * grab;
    for (const t of visList) {
        const d = (t._sx - lx) ** 2 + (t._sy - ly) ** 2;
        // Identified traffic wins a tie: a primary return sitting on top of an
        // airliner should not steal the hover.
        if (d < bestD || (d === bestD && best && !best.cs && t.cs)) { best = t; bestD = d; }
    }
    return best;
}

// "PCT", "PCT+N90", "KORD", or both. A '+' means several facilities are reporting
// the same target, which is the thing worth noticing.
function reportedBy(t) {
    const bits = [];
    if (t.fac) bits.push(t.fac);
    if (t.apt && t.apt !== t.fac) bits.push(t.apt);
    if (!bits.length) return null;
    // The count matters beyond the list because the list is CAPPED at four: a
    // six-facility target would otherwise read as a four-facility one.
    return bits.join(' ') + (t.dupN > 1 ? ` (${t.dupN} merged)` : '');
}

function fl(alt) {
    if (!alt) return '—';
    return alt >= 18000 ? 'FL' + String(Math.round(alt / 100)).padStart(3, '0')
                        : alt.toLocaleString() + ' ft';
}

let hoverThrottle = 0;
map.getContainer().addEventListener('mousemove', ev => {
    const nowMs = performance.now();
    if (nowMs - hoverThrottle < 30) return;
    hoverThrottle = nowMs;

    const r = map.getContainer().getBoundingClientRect();
    const t = pick(ev.clientX - r.left, ev.clientY - r.top);
    if (!t) {
        if (hoverId !== null) { hoverId = null; tip.style.display = 'none'; paint(); }
        return;
    }
    if (t.id !== hoverId) { hoverId = t.id; paint(); }

    const name = t.cs || (t.cls === 'Primary' ? 'primary return' : 'untagged');
    const e = energyFt(t.alt, t.gs);
    const l2 = [t.type, fl(t.alt), t.gs ? t.gs + ' kt' : null,
                t.sqk ? 'sq ' + t.sqk : null].filter(Boolean).join(' · ');
    const l3 = [
        t.org || t.dst ? `${t.org || '?'} ▸ ${t.dst || '?'}` : null,
        t.owner || null,
        // Who is reporting it. For a tagged flight this is extra; for an untagged one it is
        // the whole answer to "why are there two of these".
        reportedBy(t),
        t.cls,
        $('color').value === 'energy' ? `E ${Math.round(e).toLocaleString()} ft` : null,
    ].filter(Boolean).join(' · ');
    tip.innerHTML = `<div class="t1">${esc(name)}</div>`
                  + (l2 ? `<div class="t2">${esc(l2)}</div>` : '')
                  + (l3 ? `<div class="t3">${esc(l3)}</div>` : '');
    tip.style.display = 'block';
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
const detail = $('detail');
let detailTimer = null;

map.on('click', ev => {
    const p = map.latLngToContainerPoint(ev.latlng);
    const t = pick(p.x, p.y);
    if (!t) return;
    selId = t.id;
    paint();
    openDetail(t);
});

$('dClose').addEventListener('click', () => {
    detail.classList.remove('open');
    selId = null;
    clearInterval(detailTimer);
    paint();
});

function openDetail(t) {
    detail.classList.add('open');
    $('dTitle').textContent = t.cs || t.cls;
    const body = $('dBody');

    // What the stream already gave us renders immediately; the cross-source
    // picture is fetched behind it. An untagged return has no callsign, so there
    // is nothing to look up and the panel says so instead of spinning.
    body.innerHTML = rows('TARGET', [
        ['Class', t.cls],
        ['Type', t.type],
        ['Reported by', reportedBy(t)],
        ['Squawk', t.sqk],
        ['Altitude', fl(t.alt)],
        ['Ground speed', t.gs ? t.gs + ' kt' : null],
        ['Energy', `${Math.round(energyFt(t.alt, t.gs)).toLocaleString()} ft`],
        ['Track', t.trk !== null && t.trk !== undefined
            ? String(t.trk).padStart(3, '0') + '°' : null],
        ['Route', t.org || t.dst ? `${t.org || '?'} ▸ ${t.dst || '?'}` : null],
        ['Ownership', t.owner],
    ]) + (t.cs ? '<div class="d-empty">loading…</div>'
               : '<div class="d-sec">NO IDENTITY</div><div class="d-empty">An uncorrelated '
                 + 'radar return. Nothing else in the NAS knows what this is'
                 + (t.fac ? `, beyond ${esc(t.fac)} reporting it` : '')
                 + (t.fac && t.fac.includes('+')
                    ? ' — the <b>+</b> means more than one facility is, so the same object may '
                      + 'also be on screen as a separate target.' : '.')
                 + '</div>');

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
    const body = $('dBody');

    // These are the SFDPS projection's own abbreviations (acType, dest, assignedAlt,
    // rules, status, sectorFreq), checked against the live endpoint rather than
    // assumed: a wrong name renders as a MISSING ROW, not an error, so the panel
    // would just look sparse. Same shape as the modeSCode/modeS slip that made a
    // fusion measurement report zero Mode S.
    let html = rows('TARGET', [
        ['Class', t ? t.cls : null],
        ['Type', sf.acType || (t && t.type)],
        ['Reported by', t ? reportedBy(t) : null],
        ['Registration', sf.registration],
        ['Altitude', t ? fl(t.alt) : null],
        ['Ground speed', t && t.gs ? t.gs + ' kt' : null],
        ['Energy', t ? `${Math.round(energyFt(t.alt, t.gs)).toLocaleString()} ft` : null],
        ['Squawk', sf.squawk || (t && t.sqk)],
    ]);

    // controllingTracon is the real TRACON id for an SFDPS NAS code (ORT -> C90) and
    // is null for an ARTCC sector, which is exactly when the raw facility is right.
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
        // The hold is the chain MAXIMUM, which is what the server already computed.
        // Summing the per-center delays double-counts: TBFM distributes a hold
        // upstream and a center that has absorbed it reads ~0 one point down.
        if (b.delayMin) flow.push(['Metering hold', `${b.delayMin.toFixed(1)} min`
            + (b.holdCtr ? ` (${b.holdCtr}${b.holdPoint ? '/' + b.holdPoint : ''})` : '')]);
        if (b.point) flow.push(['Meter point', b.point]);
        if (b.meterFix && b.meterFix !== b.point) flow.push(['Meter fix', b.meterFix]);
        if (b.rwy) flow.push(['Metered runway', b.rwy]);
        if (b.tracon) flow.push(['Metering TRACON', b.tracon]);
        if (b.frozen) flow.push(['Schedule', 'frozen']);
    }
    if (d.edct) flow.push(['EDCT', String(d.edct)]);
    if (d.tfms) {
        const f = d.tfms;
        if (f.status) flow.push(['TFMS status', f.status]);
        // TFMS calls it the boundary fix; it is the NAS entry point for an inbound.
        if (f.boundaryFix) flow.push(['Boundary fix', f.boundaryFix]);
        if (f.coordinationFix) flow.push(['Coordination fix', f.coordinationFix]);
        if (f.diversion) flow.push(['Diversion', String(f.diversion)]);
    }
    if (d.tfdm && d.tfdm.runway) flow.push(['Departure runway', d.tfdm.runway]);
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

// Everything in the readouts comes from the feed, and a callsign is free text as
// far as this page is concerned — so it is escaped, not interpolated raw. Same
// reason the STARS picker renders its ?notice= with textContent.
function esc(s) {
    return String(s).replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── Controls ───────────────────────────────────────────────────────────────────
for (const el of document.querySelectorAll('.cls, #cap')) {
    el.addEventListener('change', () => { sendView(true); renderCounts(); });
}
// Field toggles only mean something while labels are on, and a row of live
// checkboxes that do nothing reads as broken rather than as inapplicable.
function syncLabelUi() {
    const on = $('labels').value !== 'off';
    $('lbFields').classList.toggle('off', !on);
    const st = lastLabelStat;
    $('lbNote').textContent = !on ? ''
        : st && st.dropped
            ? `${st.drawn} shown, ${st.dropped} hidden — no room at this zoom`
            : 'Labels that cannot fit without overlapping are hidden, not stacked.';
}
for (const id of ['lfId', 'lfType', 'lfAlt', 'lfSpd', 'lfRte', 'lfSq']) {
    $(id).addEventListener('change', () => { paint(); setTimeout(syncLabelUi, 60); });
}
$('labels').addEventListener('change', () => { paint(); setTimeout(syncLabelUi, 60); });
setInterval(syncLabelUi, 1500);

// Dedupe is a SERVER-side filter on what this client is sent, not a draw option,
// so it has to re-send the view command rather than just repaint.
// Dedupe is a SERVER-side filter on what this client is sent, not a draw option,
// so it has to re-send the view command rather than just repaint.
//
// It must NOT clear what the client holds. The server's delta is computed against
// what it believes this client has: flipping the flag re-sends the group leaders
// (their label changed) and adds or deletes the followers, but a target in NO
// group has an unchanged identity hash and is correctly sent nothing at all.
// Clearing locally would therefore delete every solo target permanently - most of
// the map - and it would look like the toggle broke the stream.
$('dedupe').addEventListener('change', () => sendView());

for (const id of ['bFca', 'bFea']) $(id).addEventListener('change', updateFca);

for (const id of ['trail', 'leader', 'labels', 'size']) {
    $(id).addEventListener('change', paint);
}
$('color').addEventListener('change', () => { renderLegend(); paint(); });
// Altitude does double duty: it filters targets AND reshapes the sector volumes,
// which is the thing the FAVs can do and the legacy KML cannot.
// Altitude does triple duty: it filters targets, reshapes the sector volumes (the
// thing the FAVs can do and the legacy KML cannot), and decides which flow areas
// are relevant, since an FEA/FCA carries a real floor and ceiling.
$('alt').addEventListener('change', () => {
    paint();
    if ($('bSectors').checked) updateSectorLayer();
    if ($('bFca').checked || $('bFea').checked) drawFca();
});
for (const id of ['wx', 'wxop']) $(id).addEventListener('change', updateWx);
$('bArtcc').addEventListener('change', updateArtccLayer);
$('bSectors').addEventListener('change', updateSectorLayer);
$('bKml').addEventListener('change', updateKmlLayer);
$('bFlow').addEventListener('change', updateFlow);
// The chip detail depends on zoom, so a zoom has to re-render what is already loaded
// (no refetch -- the data has not changed).
map.on('zoomend', () => { if ($('bFlow').checked && flowData) drawFlow(); });
// Chip collisions are in SCREEN space, so a pan changes them with no data having
// changed -- the same reason the ASDE-X auto offset re-runs on moveend.
map.on('moveend zoomend', () => {
    if (($('bFca').checked || $('bFea').checked) && fcaData) drawFca();
});

const qEl = $('q');
let qTimer = null;
qEl.addEventListener('input', () => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => sendView(true), 300);
});
$('qclear').addEventListener('click', () => { qEl.value = ''; sendView(true); });

$('ctlToggle').addEventListener('click', () => { $('ctl').classList.toggle('open'); });

// Deep link: /nas?q=UAL1&lat=..&lon=..&z=..
const qs = new URLSearchParams(location.search);
if (qs.get('q')) qEl.value = qs.get('q');
const qlat = parseFloat(qs.get('lat')), qlon = parseFloat(qs.get('lon'));
if (Number.isFinite(qlat) && Number.isFinite(qlon)) {
    map.setView([qlat, qlon], parseInt(qs.get('z') || '7', 10));
}

// Now that every declaration above exists, build the canvas layer (see the note
// where `layer` is declared) and start the stream.
layer = new NasCanvas();
layer.addTo(map);

renderLegend();
renderCounts();
connect();
