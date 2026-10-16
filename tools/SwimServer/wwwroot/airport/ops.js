// ── Airport Operations board ────────────────────────────────────────────────
// Everything numeric is computed server-side (AirportOpsRoutes) so the board reads the same for
// every client; this file is presentation: the compass rose, the runway geometry, and the panels.
//
// Two conventions worth stating once, because mixing them is the classic way these displays go
// wrong: a raw METAR's wind is referenced to TRUE north, and NASR's TRUE_ALIGNMENT is also true.
// So head/crosswind needs no variation applied, and the rose is drawn north-up TRUE. What a
// controller *says* ("wind two-two-zero") is magnetic — that is why each runway end also carries a
// magnetic alignment, and why the runway labels use it (a runway is numbered off magnetic).

const $ = (id) => document.getElementById(id);
const QUICK = ['KDCA', 'KIAD', 'KBWI', 'KJFK', 'KEWR', 'KLGA', 'KBOS', 'KPHL', 'KORD', 'KATL',
    'KDFW', 'KDEN', 'KLAX', 'KSFO', 'KSEA', 'KMIA', 'KCLT', 'KPHX', 'KLAS', 'KMCO'];

let timer = null;

// ── theme ───────────────────────────────────────────────────────────────────
// Two palettes: "day", modelled on the ASOS/tower boards this page copies (pale blue field, white
// panels, navy labels, cream value boxes), and "night" for a dim room. Both live entirely in CSS
// custom properties — including every colour in the SVG rose and trend, which is why the drawing
// code below sets classes rather than fill/stroke attributes. Switching themes restyles what is
// already on screen; nothing is redrawn.
const THEME_KEY = 'airport.theme';
function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    const b = document.getElementById('themeBtn');
    if (b) {
        b.textContent = t === 'day' ? '\u25D1 DAY' : '\u25D0 NIGHT';
        b.title = t === 'day' ? 'Switch to the night palette' : 'Switch to the day palette';
    }
    try { localStorage.setItem(THEME_KEY, t); } catch { }
}
function initTheme() {
    let t = null;
    try { t = localStorage.getItem(THEME_KEY); } catch { }
    if (t !== 'day' && t !== 'night') {
        // No choice stored: follow the OS, which is what someone opening this at 2am expects.
        t = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'day' : 'night';
    }
    applyTheme(t);
}

// ── entry ───────────────────────────────────────────────────────────────────
function idFromPath() {
    const m = location.pathname.match(/^\/airport\/([A-Za-z0-9]{3,4})\/?$/);
    return m ? m[1].toUpperCase() : '';
}

function boot() {
    initTheme();
    const tb = $('themeBtn');
    if (tb) tb.addEventListener('click', () =>
        applyTheme(document.documentElement.getAttribute('data-theme') === 'day' ? 'night' : 'day'));
    $('quick').innerHTML = QUICK.map(a => `<a href="/airport/${a}">${a}</a>`).join('');
    $('pickForm').addEventListener('submit', (e) => {
        e.preventDefault();
        const v = $('pickInput').value.trim().toUpperCase();
        if (v.length >= 3) location.href = '/airport/' + encodeURIComponent(v);
    });
    const id = idFromPath();
    if (!id) return;
    $('picker').hidden = true;
    $('board').hidden = false;
    load(id);
    clearInterval(timer);
    timer = setInterval(() => load(id), 60000);   // METARs are hourly; a minute is plenty
    setInterval(clocks, 1000);
    clocks();
}

function clocks() {
    const n = new Date();
    const z = (x) => String(x).padStart(2, '0');
    $('hZulu').textContent = `${z(n.getUTCHours())}:${z(n.getUTCMinutes())}:${z(n.getUTCSeconds())}`;
    $('hLocal').textContent = `${z(n.getHours())}:${z(n.getMinutes())}:${z(n.getSeconds())}`;
    try {
        $('hLocalLbl').textContent =
            new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
                .formatToParts(n).find(p => p.type === 'timeZoneName')?.value || 'local';
    } catch { /* label stays "local" */ }
}

async function load(id) {
    let d;
    try {
        const r = await fetch('/api/airport/' + encodeURIComponent(id));
        if (!r.ok) throw new Error(r.status);
        d = await r.json();
    } catch (e) {
        $('note').textContent = 'Could not reach the server for ' + id + '.';
        return;
    }
    render(d);
}

// ── formatting helpers ──────────────────────────────────────────────────────
const esc = (v) => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n0 = (v) => v == null ? null : Math.round(v);
const fmtInt = (v, suffix = '') => v == null ? '--' : Math.round(v).toLocaleString() + suffix;
const deg3 = (v) => v == null ? '---' : String(Math.round(v) % 360).padStart(3, '0');
function ago(iso) {
    if (!iso) return '';
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 90) return Math.round(s) + 's ago';
    if (s < 5400) return Math.round(s / 60) + 'm ago';
    return (s / 3600).toFixed(1) + 'h ago';
}

// ── render ──────────────────────────────────────────────────────────────────
function render(d) {
    const a = d.airport, m = d.metar, dv = d.derived;

    $('hId').textContent = a?.icao || a?.lid || d.id;
    $('hName').textContent = a?.name || d.stationName || (d.found ? '' : 'Unknown identifier');
    const bits = [];
    if (a?.city) bits.push(a.city + (a.state ? ', ' + a.state : ''));
    if (a?.artcc) bits.push(a.artcc);
    if (a?.magVarDeg != null) bits.push(`var ${Math.abs(a.magVarDeg).toFixed(0)}°${a.magVarDeg < 0 ? 'W' : 'E'}`);
    if (d.nasrCycle) bits.push('NASR ' + d.nasrCycle);
    $('hSub').textContent = bits.join('  ·  ');

    const cat = m?.flightCategory || '';
    const catEl = $('hCat');
    catEl.textContent = cat || '--';
    catEl.className = 'cat ' + cat;

    // wind
    let windTxt = '---';
    if (m) {
        if (m.windSpeedKt === 0) windTxt = 'CALM';
        else if (m.windVariable) windTxt = `VRB ${fmtInt(m.windSpeedKt)} kt`;
        else if (m.windDirDeg != null) {
            windTxt = `${deg3(m.windDirDeg)}° / ${fmtInt(m.windSpeedKt)} kt`;
            if (m.windGustKt) windTxt += ` G${Math.round(m.windGustKt)}`;
        }
    }
    $('fWind').textContent = windTxt;

    $('fAltim').textContent = m?.altimeterInHg != null ? m.altimeterInHg.toFixed(2) + '"' : '--';
    $('fDensAlt').textContent = fmtInt(dv?.densityAltFt, ' ft');
    $('fPressAlt').textContent = fmtInt(dv?.pressureAltFt, ' ft');
    $('fElev').textContent = fmtInt(a?.elevFt ?? dv?.fieldElevFt, ' ft');
    $('fTemp').textContent = m?.tempC != null ? `${Math.round(m.tempC)}°C / ${fmtInt(dv?.tempF)}°F` : '--';
    $('fDewp').textContent = m?.dewpointC != null ? `${Math.round(m.dewpointC)}°C / ${fmtInt(dv?.dewpointF)}°F` : '--';
    $('fRh').textContent = dv?.relHumidityPct != null ? Math.round(dv.relHumidityPct) + '%' : '--';
    $('fCeil').textContent = m?.ceilingFt != null ? fmtInt(m.ceilingFt, ' ft') : (m?.ceilingText || '--');
    $('fVis').textContent = m?.visibilityText || (m?.visibilitySm != null ? m.visibilitySm + ' SM' : '--');
    $('fWx').textContent = m?.weather || 'no significant weather reported';
    $('fRmk').textContent = m?.remarks || '--';

    // Heat index and wind chill are the same slot — only one can apply, and usually neither.
    const hiWrap = $('fHiWrap');
    if (dv?.heatIndexF != null) {
        hiWrap.hidden = false; $('fHiLabel').textContent = 'HEAT INDEX';
        $('fHi').textContent = Math.round(dv.heatIndexF) + '°F';
    } else if (dv?.windChillF != null) {
        hiWrap.hidden = false; $('fHiLabel').textContent = 'WIND CHILL';
        $('fHi').textContent = Math.round(dv.windChillF) + '°F';
    } else hiWrap.hidden = true;

    $('mRaw').textContent = m?.raw || 'No observation available for this identifier.';
    $('mAge').textContent = m?.obsTime ? `${m.type || 'METAR'} · ${ago(m.obsTime)}` : '';

    drawRose(d);
    drawRunways(d);
    $('rwyList').innerHTML = componentsHtml(d);
    drawTrend(d.history || []);

    const notes = [];
    if (!d.runways?.length) notes.push('No NASR runway data for this identifier — the rose shows wind only.');
    notes.push('Wind and runway alignments are TRUE; runway numbers are magnetic. Components are computed from the observation above, so they are as old as it is.');
    $('note').textContent = notes.join('  ');
}

// ── compass rose + runway diagram ───────────────────────────────────────────
const SVG = 'http://www.w3.org/2000/svg';
const CX = 300, CY = 300, R = 258;   // rose radius inside the 600×600 viewBox

function el(name, attrs, text) {
    const e = document.createElementNS(SVG, name);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    return e;
}
// Compass bearing (0 = north, clockwise) to screen point.
function pt(bearingDeg, radius) {
    const r = (bearingDeg - 90) * Math.PI / 180;
    return [CX + radius * Math.cos(r), CY + radius * Math.sin(r)];
}

function drawRose(d) {
    const svg = $('rose');
    svg.innerHTML = '';

    svg.appendChild(el('circle', { cx: CX, cy: CY, r: R, class: 'rose-face' }));
    svg.appendChild(el('circle', { cx: CX, cy: CY, r: R, class: 'rose-ring' }));
    svg.appendChild(el('circle', { cx: CX, cy: CY, r: R - 26, class: 'rose-ring inner' }));

    for (let b = 0; b < 360; b += 5) {
        const major = b % 30 === 0, mid = b % 10 === 0;
        const [x1, y1] = pt(b, R);
        const [x2, y2] = pt(b, R - (major ? 22 : mid ? 14 : 8));
        svg.appendChild(el('line', { x1, y1, x2, y2, class: 'tick' + (major ? ' major' : '') }));
        if (major) {
            const [tx, ty] = pt(b, R - 40);
            const lbl = b === 0 ? 'N' : b === 90 ? 'E' : b === 180 ? 'S' : b === 270 ? 'W' : String(b / 10);
            svg.appendChild(el('text', {
                x: tx, y: ty + 5, class: 'rose-lbl' + (b % 90 === 0 ? ' cardinal' : ''),
                'font-size': b % 90 === 0 ? 20 : 15, 'text-anchor': 'middle',
            }, lbl));
        }
    }
}

function drawRunways(d) {
    const svg = $('rose');
    const m = d.metar;
    const rwys = (d.runways || []).filter(r => r.ends?.length);

    // Project thresholds to a local plane around the airport. Equirectangular is exact enough
    // across a few km, and keeps the runways' true relative positions and lengths.
    const lat0 = d.airport?.lat, lon0 = d.airport?.lon;
    const pts = [];
    for (const rw of rwys) for (const e of rw.ends)
        if (e.lat != null && e.lon != null) pts.push([rw, e]);

    let project = null, maxM = 0;
    if (lat0 != null && pts.length >= 2) {
        const k = Math.cos(lat0 * Math.PI / 180);
        project = (lat, lon) => [(lon - lon0) * k * 111320, (lat - lat0) * 110540];
        for (const [, e] of pts) {
            const [x, y] = project(e.lat, e.lon);
            maxM = Math.max(maxM, Math.hypot(x, y));
        }
    }

    const usable = R - 56;               // keep the diagram inside the tick ring
    const scale = maxM > 0 ? usable / (maxM * 1.12) : 0;

    const g = el('g', {});
    svg.appendChild(g);

    for (const rw of rwys) {
        const ends = rw.ends;
        let a, b;
        if (project && ends.length >= 2 && ends[0].lat != null && ends[1].lat != null) {
            const [x1, y1] = project(ends[0].lat, ends[0].lon);
            const [x2, y2] = project(ends[1].lat, ends[1].lon);
            a = [CX + x1 * scale, CY - y1 * scale];
            b = [CX + x2 * scale, CY - y2 * scale];
        } else if (ends[0]?.trueAlignDeg != null && rw.lenFt) {
            // No threshold coordinates (rare, and usual at small fields): draw it through the
            // centre on its alignment, still at the right length.
            const align = ends[0].trueAlignDeg;
            const halfPx = Math.min(usable, (rw.lenFt * 0.3048) * (scale || usable / 4000) / 2);
            a = pt(align, halfPx);                    // threshold of end[0] is upwind of centre
            b = pt((align + 180) % 360, halfPx);
        } else continue;

        // Real width would be a hairline at this scale; clamp so it still reads as pavement.
        const wPx = Math.max(6, Math.min(14, (rw.widthFt || 150) * 0.3048 * scale));
        g.appendChild(el('line', {
            x1: a[0], y1: a[1], x2: b[0], y2: b[1],
            class: 'rwy-edge', 'stroke-width': wPx + 3, 'stroke-linecap': 'butt',
        }));
        g.appendChild(el('line', {
            x1: a[0], y1: a[1], x2: b[0], y2: b[1],
            class: 'rwy-pave', 'stroke-width': wPx, 'stroke-linecap': 'butt',
        }));
        // Centreline stripes
        g.appendChild(el('line', {
            x1: a[0], y1: a[1], x2: b[0], y2: b[1],
            class: 'rwy-center', 'stroke-width': 1.2, 'stroke-dasharray': '7 7',
        }));

        // End numbers go just beyond each threshold, pushed sideways off the centreline so they
        // don't land on another runway's pavement (PANC's 33 threshold sits right on the 07/25
        // pair), with a dark halo so they stay readable wherever they end up. Always upright.
        const ends2 = [[ends[0], a, b], [ends[1], b, a]];
        for (const [e, p, other] of ends2) {
            if (!e) continue;
            const dx = p[0] - other[0], dy = p[1] - other[1];
            const len = Math.hypot(dx, dy) || 1;
            const ux = dx / len, uy = dy / len;
            const lx = p[0] + ux * 19 - uy * 11;      // along the runway, then abeam it
            const ly = p[1] + uy * 19 + ux * 11;
            g.appendChild(el('text', {
                x: lx, y: ly + 5, class: 'rwy-id', 'font-size': 15, 'text-anchor': 'middle',
                'stroke-width': 3.5, 'paint-order': 'stroke', 'stroke-linejoin': 'round',
            }, e.id));
        }
    }

    // ── wind arrows ──
    // Meteorological: an arrow drawn FROM the reported direction, pointing at the field.
    const hist = (d.history || []).filter(h => h.speedKt > 0 && h.dirDeg != null).slice(-5);
    hist.forEach((h, i) => windArrow(svg, h.dirDeg, h.speedKt, {
        cls: 'wind-prev', width: 3, label: '', opacity: 0.35 + 0.1 * i,
    }));
    if (m && m.windSpeedKt > 0 && m.windDirDeg != null && !m.windVariable) {
        windArrow(svg, m.windDirDeg, m.windSpeedKt, {
            cls: 'wind-cur', width: 7, opacity: 1,
            label: `${Math.round(m.windSpeedKt)}${m.windGustKt ? 'G' + Math.round(m.windGustKt) : ''} kt`,
        });
    } else {
        svg.appendChild(el('text', {
            x: CX, y: CY - 6, class: 'rose-lbl cardinal', 'font-size': 20, 'text-anchor': 'middle',
        }, m?.windVariable ? 'VRB' : m?.windSpeedKt === 0 ? 'CALM' : ''));
    }
}

function windArrow(svg, fromDeg, kt, opt) {
    const tail = R - 8, head = R - 74;          // points inward, toward the field
    const [x1, y1] = pt(fromDeg, tail);
    const [x2, y2] = pt(fromDeg, head);
    const g = el('g', { opacity: opt.opacity, class: opt.cls });
    g.appendChild(el('line', {
        x1, y1, x2, y2, class: 'arrow-stem', 'stroke-width': opt.width, 'stroke-linecap': 'round',
    }));
    // arrowhead
    const back = 18, spread = 7.5;
    const [bx, by] = pt(fromDeg, head + back);
    const [lx, ly] = pt(fromDeg - spread, head + back + 4);
    const [rx, ry] = pt(fromDeg + spread, head + back + 4);
    g.appendChild(el('polygon', { points: `${x2},${y2} ${lx},${ly} ${bx},${by} ${rx},${ry}`, class: 'arrow-head' }));
    if (opt.label) {
        // Offset abeam the arrow as well as along it, or the text lands on its own stem.
        const [ax, ay] = pt(fromDeg, tail - 30);
        const [px, py] = pt(fromDeg + 90, 1);
        const ux = px - CX, uy = py - CY;          // unit vector perpendicular to the arrow
        const tx = ax + ux * 26, ty = ay + uy * 26;
        g.appendChild(el('text', {
            x: tx, y: ty + 4, class: 'wind-lbl', 'font-size': 15, 'text-anchor': 'middle',
            'stroke-width': 3.5, 'paint-order': 'stroke', 'stroke-linejoin': 'round',
        }, opt.label));
    }
    svg.appendChild(g);
}

// ── per-runway components ───────────────────────────────────────────────────
function runwayRows(d) {
    const rows = [];
    for (const rw of d.runways || []) {
        for (const e of rw.ends || []) {
            if (!e.components) continue;
            rows.push({ rw, e, c: e.components });
        }
    }
    // Best runway first: most headwind, then least crosswind — the order a tower would pick in.
    rows.sort((p, q) => (q.c.headKt - p.c.headKt) || (Math.abs(p.c.crossKt) - Math.abs(q.c.crossKt)));
    return rows;
}

function componentsHtml(d) {
    const rows = runwayRows(d);
    if (!rows.length) {
        const any = (d.runways || []).length;
        return `<div class="dim">${any
            ? 'No wind in the observation, so there are no components to compute.'
            : 'No runway data for this identifier.'}</div>`;
    }
    return rows.map(({ rw, e, c }, i) => {
        const cross = Math.abs(c.crossKt);
        const xClass = cross >= 20 ? 'severe' : cross >= 12 ? 'strong' : '';
        const meta = [
            e.magAlignDeg != null ? deg3(e.magAlignDeg) + '°M' : (e.trueAlignDeg != null ? deg3(e.trueAlignDeg) + '°T' : ''),
            rw.lenFt ? rw.lenFt.toLocaleString() + "'" : '',
            rw.surface || '',
            e.ils || '',
        ].filter(Boolean).join(' · ');
        return `<div class="rwy${i === 0 && c.headKt > 0 ? ' best' : ''}">
            <div class="rid">${esc(e.id)}</div>
            <div class="meta">${esc(meta)}</div>
            <div class="comp">
              <span class="h${c.tailwind ? ' tail' : ''}">${c.tailwind ? 'TAIL' : 'HEAD'} ${Math.abs(c.headKt).toFixed(0)}</span>
              &nbsp;<span class="x ${xClass}">X ${cross.toFixed(0)}${cross >= 1 ? c.crossFrom : ''}</span>
            </div>
          </div>`;
    }).join('');
}

// ── 6-hour trend ────────────────────────────────────────────────────────────
function drawTrend(hist) {
    const svg = $('trend');
    svg.innerHTML = '';
    const pts = hist.filter(h => h.speedKt != null);
    if (pts.length < 2) {
        svg.appendChild(el('text', {
            x: 160, y: 75, class: 't-lbl', 'font-size': 11, 'text-anchor': 'middle',
        }, 'not enough history yet'));
        return;
    }
    const W = 320, H = 150, PAD = 26;
    const t0 = new Date(pts[0].time).getTime(), t1 = new Date(pts[pts.length - 1].time).getTime();
    const xs = (t) => PAD + (W - PAD - 6) * ((new Date(t).getTime() - t0) / Math.max(1, t1 - t0));

    const maxKt = Math.max(10, ...pts.map(p => Math.max(p.speedKt || 0, p.gustKt || 0)));
    const ysKt = (v) => H - 22 - (H - 44) * (v / maxKt);
    const temps = pts.map(p => p.tempC).filter(v => v != null);
    const tMin = temps.length ? Math.min(...temps) - 1 : 0, tMax = temps.length ? Math.max(...temps) + 1 : 1;
    const ysT = (v) => H - 22 - (H - 44) * ((v - tMin) / Math.max(0.1, tMax - tMin));

    svg.appendChild(el('line', { x1: PAD, y1: H - 22, x2: W - 6, y2: H - 22, class: 't-axis' }));
    svg.appendChild(el('text', { x: 2, y: ysKt(maxKt) + 4, class: 't-lbl', 'font-size': 9 }, maxKt + 'kt'));

    // 'M' goes on the first point we actually emit, not on index 0 — gust is usually absent from
    // the oldest observation, and starting a path with 'L' makes the browser reject the whole d.
    const path = (sel, scale) => {
        let started = false;
        return pts.map((p) => {
            const v = sel(p);
            if (v == null) return '';
            const cmd = started ? 'L' : 'M';
            started = true;
            return `${cmd} ${xs(p.time).toFixed(1)} ${scale(v).toFixed(1)}`;
        }).filter(Boolean).join(' ');
    };

    if (temps.length) svg.appendChild(el('path', { d: path(p => p.tempC, ysT), class: 't-temp', 'stroke-width': 1.5 }));
    svg.appendChild(el('path', { d: path(p => p.gustKt, ysKt), class: 't-gust', 'stroke-width': 1.5 }));
    svg.appendChild(el('path', { d: path(p => p.speedKt, ysKt), class: 't-wind', 'stroke-width': 2 }));

    // Hour ticks
    for (const p of pts) {
        const d2 = new Date(p.time);
        if (d2.getUTCMinutes() > 5) continue;
        svg.appendChild(el('text', {
            x: xs(p.time), y: H - 8, class: 't-lbl', 'font-size': 9, 'text-anchor': 'middle',
        }, String(d2.getUTCHours()).padStart(2, '0') + 'Z'));
    }
}

boot();
