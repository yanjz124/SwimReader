// ── Map setup ────────────────────────────────────────────────
const map = L.map('map', {
    center: [39, -98],
    zoom: 5,
    zoomControl: false
});

L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OSM &copy; CARTO',
    maxZoom: 18
}).addTo(map);

L.control.zoom({ position: 'topright' }).addTo(map);

let routeLine = null;
let fixMarkers = [];
let posMarker = null;
let sectorLines = [];
let currentFlight = null;

// ── URL params ───────────────────────────────────────────────
const params = new URLSearchParams(location.search);
const initFlight = params.get('flight');
if (initFlight) {
    document.getElementById('searchInput').value = initFlight;
    loadFlight(initFlight);
}

// ── Search ───────────────────────────────────────────────────
document.getElementById('searchBtn').addEventListener('click', doSearch);
document.getElementById('searchInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') doSearch();
});

function doSearch() {
    const q = document.getElementById('searchInput').value.trim();
    if (q) loadFlight(q);
}

// ── Load flight ──────────────────────────────────────────────
async function loadFlight(key) {
    try {
        const r = await fetch(`/api/tfms/flights/${encodeURIComponent(key)}`);
        if (!r.ok) {
            document.getElementById('sidebar').innerHTML =
                '<div class="empty-sidebar"><div>Flight not found</div></div>';
            return;
        }
        const f = await r.json();
        currentFlight = f;
        renderRoute(f);
        renderSidebar(f);
    } catch (err) {
        console.error(err);
    }
}

// ── Smoothing function ──────────────────────────────────────
function smoothWaypoints(waypoints, pointsPerSegment = 3) {
    if (waypoints.length < 2) return waypoints;
    const smooth = [];
    for (let i = 0; i < waypoints.length - 1; i++) {
        const p0 = waypoints[Math.max(0, i - 1)];
        const p1 = waypoints[i];
        const p2 = waypoints[i + 1];
        const p3 = waypoints[Math.min(waypoints.length - 1, i + 2)];
        smooth.push(p1);
        for (let t = 1; t < pointsPerSegment; t++) {
            const s = t / pointsPerSegment;
            const s2 = s * s;
            const s3 = s2 * s;
            const lat = 0.5 * (
                2 * p1[0] +
                (-p0[0] + p2[0]) * s +
                (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * s2 +
                (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * s3
            );
            const lon = 0.5 * (
                2 * p1[1] +
                (-p0[1] + p2[1]) * s +
                (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * s2 +
                (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * s3
            );
            smooth.push([lat, lon]);
        }
    }
    smooth.push(waypoints[waypoints.length - 1]);
    return smooth;
}

// ── Render route on map ──────────────────────────────────────
function renderRoute(f) {
    // Clear previous
    if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
    fixMarkers.forEach(m => map.removeLayer(m));
    fixMarkers = [];
    sectorLines.forEach(m => map.removeLayer(m));
    sectorLines = [];
    if (posMarker) { map.removeLayer(posMarker); posMarker = null; }

    // Fit bounds to route (will be set by sector lines below)
    if (f.waypoints && f.waypoints.length > 1) {
        // Bounds will be set from sector lines or fix markers
    }

    // Draw fix markers
    if (f.fixes) {
        f.fixes.forEach(fix => {
            // Find closest waypoint to get lat/lon
            if (f.waypoints && fix.elapsedTime != null) {
                const wp = findWaypointAtTime(f.waypoints, fix.elapsedTime);
                if (wp) {
                    const marker = L.circleMarker([wp.lat, wp.lon], {
                        radius: 4,
                        color: '#39d2c0',
                        fillColor: '#39d2c0',
                        fillOpacity: 0.8,
                        weight: 1
                    }).addTo(map);
                    marker.bindTooltip(fix.name, {
                        permanent: false,
                        direction: 'top',
                        className: 'fix-tooltip'
                    });
                    fixMarkers.push(marker);
                }
            }
        });
    }

    // Draw current position
    if (f.lat && f.lon && f.lat !== 0) {
        posMarker = L.circleMarker([f.lat, f.lon], {
            radius: 6,
            color: '#cccc44',
            fillColor: '#cccc44',
            fillOpacity: 1,
            weight: 2
        }).addTo(map);
        posMarker.bindTooltip(f.callsign || '?', {
            permanent: true,
            direction: 'right',
            className: 'pos-tooltip'
        });
    }

    // Draw center boundaries as colored segments
    if (f.centers && f.centers.length > 1 && f.waypoints) {
        const colors = ['#4444cc', '#44cc44', '#cc4444', '#cc44cc', '#cccc44', '#44cccc'];
        for (let i = 0; i < f.centers.length; i++) {
            const startTime = f.centers[i].elapsedEntryTime || 0;
            const endTime = i + 1 < f.centers.length ? f.centers[i + 1].elapsedEntryTime : Infinity;
            const segWps = f.waypoints.filter(w =>
                (w.elapsedTime || 0) >= startTime && (w.elapsedTime || 0) < endTime);
            // Prepend last wp from previous segment for continuity
            if (i > 0 && startTime > 0) {
                const prev = f.waypoints.filter(w => (w.elapsedTime || 0) < startTime);
                if (prev.length > 0) segWps.unshift(prev[prev.length - 1]);
            }
            if (segWps.length > 1) {
                const segCoords = segWps.map(w => [w.lat, w.lon]);
                const smoothedSeg = segWps.length > 2 ? smoothWaypoints(segCoords, 5) : segCoords;
                const line = L.polyline(smoothedSeg, {
                    color: colors[i % colors.length],
                    weight: 3,
                    opacity: 0.6
                }).addTo(map);
                sectorLines.push(line);
                // Label at midpoint
                const mid = segWps[Math.floor(segWps.length / 2)];
                const label = L.divIcon({
                    html: `<span style="color:${colors[i % colors.length]}; font-size:10px; font-family:ERAM,monospace; white-space:nowrap;">${f.centers[i].name}</span>`,
                    className: '',
                    iconAnchor: [0, -8]
                });
                const marker = L.marker([mid.lat, mid.lon], { icon: label }).addTo(map);
                fixMarkers.push(marker);
            }
        }
        // Fit bounds to sector lines
        if (sectorLines.length > 0) {
            const bounds = L.latLngBounds([]);
            sectorLines.forEach(line => bounds.extend(line.getBounds()));
            map.fitBounds(bounds, { padding: [50, 50] });
        }
    }
}

function findWaypointAtTime(waypoints, elapsed) {
    let best = null;
    let bestDiff = Infinity;
    for (const wp of waypoints) {
        const diff = Math.abs((wp.elapsedTime || 0) - elapsed);
        if (diff < bestDiff) { bestDiff = diff; best = wp; }
    }
    return best;
}

// ── Render sidebar ───────────────────────────────────────────
function renderSidebar(f) {
    const sidebar = document.getElementById('sidebar');
    const etdStr = f.etd ? formatTime(f.etd) : '?';
    const etaStr = f.eta ? formatTime(f.eta) : '?';
    const altStr = f.altitude ? (f.altitude >= 18000 ? 'FL' + Math.round(f.altitude/100) : f.altitude + 'ft') : '?';

    let html = `
        <div class="flight-info">
            <div class="cs">${esc(f.callsign || '?')}</div>
            <div class="route">${esc(f.depArpt || '?')} → ${esc(f.arrArpt || '?')}</div>
            <div class="meta">
                ${esc(f.category || '')} ${esc(f.userCategory || '')} |
                ${altStr} | ${f.speed || '?'} kts
            </div>
            <div class="meta">
                ETD: ${etdStr} | ETA: ${etaStr}
                ${f.star ? ' | STAR: ' + esc(f.star) : ''}
                ${f.starTransitionFix ? ' via ' + esc(f.starTransitionFix) : ''}
            </div>
            ${f.routeOfFlight ? `<div class="meta" style="color:#666; margin-top:6px; word-break:break-all;">${esc(f.routeOfFlight)}</div>` : ''}
        </div>
    `;

    // Fixes
    if (f.fixes && f.fixes.length > 0) {
        html += '<div class="section-title">ROUTE FIXES</div><div class="fix-list">';
        for (const fix of f.fixes) {
            const time = fix.elapsedTime != null ? formatElapsed(fix.elapsedTime, f.etd) : '';
            html += `<div class="fix-item">
                <span class="fix-name">${esc(fix.name)}</span>
                <span class="fix-time">${time}</span>
            </div>`;
        }
        html += '</div>';
    }

    // Centers
    if (f.centers && f.centers.length > 0) {
        html += '<div class="section-title">ARTCC TRAVERSAL</div><div class="sector-list">';
        for (const c of f.centers) {
            const time = c.elapsedEntryTime != null ? formatElapsed(c.elapsedEntryTime, f.etd) : 'origin';
            html += `<div class="sector-item">
                <span class="sec-name">${esc(c.name)}</span>
                <span class="sec-time">${time}</span>
            </div>`;
        }
        html += '</div>';
    }

    // Sectors
    if (f.sectors && f.sectors.length > 0) {
        html += '<div class="section-title">SECTOR TRAVERSAL</div><div class="sector-list" style="max-height:none;">';
        for (const s of f.sectors) {
            const time = s.elapsedEntryTime != null ? formatElapsed(s.elapsedEntryTime, f.etd) : 'origin';
            html += `<div class="sector-item">
                <span class="sec-name">${esc(s.name)}</span>
                <span class="sec-time">${time}</span>
            </div>`;
        }
        html += '</div>';
    }

    // Airways
    if (f.airways && f.airways.length > 0) {
        html += `<div class="section-title">AIRWAYS</div>
            <div style="padding:6px 12px; font-size:11px; color:#aaa;">
                ${f.airways.map(a => esc(a)).join(' &nbsp; ')}
            </div>`;
    }

    sidebar.innerHTML = html;
}

// ── Utils ────────────────────────────────────────────────────
function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function formatTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toISOString().substring(11, 16) + 'Z';
}

function formatElapsed(secs, etdIso) {
    if (etdIso) {
        const etd = new Date(etdIso);
        const t = new Date(etd.getTime() + secs * 1000);
        return t.toISOString().substring(11, 16) + 'Z';
    }
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    return h > 0 ? `+${h}h${String(m).padStart(2, '0')}m` : `+${m}m`;
}

// ── Auto-refresh current flight ──────────────────────────────
setInterval(() => {
    if (currentFlight && currentFlight.flightRef) {
        loadFlight(currentFlight.flightRef);
    }
}, 30000);
