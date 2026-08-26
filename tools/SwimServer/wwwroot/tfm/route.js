// ── Map setup ────────────────────────────────────────────────
const map = L.map('map', {
    center: [39, -98],
    zoom: 5,
    zoomControl: false
});

L.tileLayer('/basemap/dark_nolabels/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OSM &copy; CARTO',
    maxZoom: 18
}).addTo(map);

L.control.zoom({ position: 'topright' }).addTo(map);

let routeLine = null;
let fixMarkers = [];
let posMarker = null;
let sectorLines = [];
let currentFlight = null;
let isInitialLoad = false;

// ── URL params ───────────────────────────────────────────────
const params = new URLSearchParams(location.search);
const initFlight = params.get('flight');
if (initFlight) {
    document.getElementById('searchInput').value = initFlight;
    loadFlight(initFlight);
}

// ── Search ───────────────────────────────────────────────────
const searchInput = document.getElementById('searchInput');
searchInput.addEventListener('input', e => {
    e.target.value = e.target.value.toUpperCase();
});
document.getElementById('searchBtn').addEventListener('click', doSearch);
searchInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') doSearch();
});

function doSearch() {
    const q = searchInput.value.trim();
    if (q) loadFlight(q);
}

// ── Load flight ──────────────────────────────────────────────
async function loadFlight(key, skipFitBounds = false) {
    try {
        const r = await fetch(`/api/tfms/flights/${encodeURIComponent(key)}`);
        if (!r.ok) {
            document.getElementById('sidebar').innerHTML =
                '<div class="empty-sidebar"><div>Flight not found</div></div>';
            return;
        }
        const f = await r.json();
        currentFlight = f;
        // Fit bounds only on first load
        renderRoute(f, !isInitialLoad);
        renderSidebar(f);

        // Fit map bounds to entire route only on initial load
        if (!skipFitBounds) {
            if (f.waypoints && f.waypoints.length > 1) {
                const bounds = L.latLngBounds([]);
                f.waypoints.forEach(wp => bounds.extend([wp.lat, wp.lon]));
                map.fitBounds(bounds, { padding: [50, 50] });
            } else if (f.lat && f.lon) {
                map.setView([f.lat, f.lon], 8);
            }
        }

        isInitialLoad = true;
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
function renderRoute(f, fitBounds = false) {
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

    // Draw fix markers with ERAM-style data blocks and leader lines
    if (f.fixes) {
        f.fixes.forEach((fix, idx) => {
            const isFirst = idx === 0;
            const isLast = idx === f.fixes.length - 1;
            let wp = null;

            // For first fix, use origin airport; for last, use destination; for others, find by elapsed time
            if (isFirst && f.waypoints) {
                wp = f.waypoints[0];
            } else if (isLast && f.waypoints) {
                wp = f.waypoints[f.waypoints.length - 1];
            } else if (f.waypoints && fix.elapsedTime != null) {
                wp = findWaypointAtTime(f.waypoints, fix.elapsedTime);
            }

            if (wp) {
                if (isFirst || isLast) {
                    // Endpoint fixes - different, more prominent look
                    const endpointHtml = `
                        <div class="endpoint-marker">
                            <div class="endpoint-dot"></div>
                            <div class="endpoint-label">${fix.name}</div>
                        </div>
                    `;
                    const icon = L.divIcon({
                        html: endpointHtml,
                        className: 'endpoint-icon',
                        iconAnchor: [6, 6]
                    });
                    const marker = L.marker([wp.lat, wp.lon], { icon: icon }).addTo(map);
                    fixMarkers.push(marker);
                } else {
                    // Regular fixes - normal hover-based look
                    const markerHtml = `
                        <div class="fix-container">
                            <div class="fix-dot"></div>
                            <div class="fix-block">
                                <div class="fix-leader"></div>
                                <div class="fix-text">${fix.name}</div>
                            </div>
                        </div>
                    `;
                    const icon = L.divIcon({
                        html: markerHtml,
                        className: 'fix-marker',
                        iconAnchor: [3, 3]
                    });
                    const marker = L.marker([wp.lat, wp.lon], { icon: icon }).addTo(map);
                    fixMarkers.push(marker);
                }
            }
        });
    }

    // Draw current position with aircraft symbol and ASDEX data block
    if (f.lat && f.lon && f.lat !== 0) {
        const heading = calculateHeading(f.lat, f.lon, f.waypoints) + 180;
        const altStr = f.altitude ? (f.altitude >= 18000 ? 'FL' + Math.round(f.altitude/100) : f.altitude + 'ft') : '?';
        const spdStr = f.speed ? f.speed : '?';

        // Data block fixed at top-left of aircraft, leader line goes to block's lower-right corner
        const blockLeft = -75;
        const blockTop = -13;
        const blockWidth = 40;  // approximate width of data block
        const blockHeight = 18; // approximate height of data block
        const blockRight = blockLeft + blockWidth;
        const blockBottom = blockTop + blockHeight;

        const lineLen = Math.sqrt((blockRight - 15) ** 2 + (blockBottom - 15) ** 2);
        const lineAngle = Math.atan2(blockBottom - 15, blockRight - 15) * 180 / Math.PI;

        // Scale block dimensions based on zoom level to maintain visual proportions
        const zoomScale = Math.pow(2, map.getZoom() - 15) * 0.5;
        const scaledBlockWidth = blockWidth * (1 + zoomScale * 0.5);
        const scaledBlockHeight = blockHeight * (1 + zoomScale * 0.5);
        const scaledBlockRight = blockLeft + scaledBlockWidth;
        const scaledBlockBottom = blockTop + scaledBlockHeight;

        const markerHtml = `
            <div class="ac-container">
                <svg class="ac-canvas" viewBox="0 0 200 200" width="200" height="200" style="position: absolute; left: -85px; top: -85px;">
                    <line x1="100" y1="100" x2="${scaledBlockRight + 85}" y2="${scaledBlockBottom + 85}" stroke="#cccc44" stroke-width="1" opacity="0.6"/>
                </svg>
                <svg viewBox="-15 -15 30 30" width="30" height="30" class="aircraft-symbol">
                    <g transform="rotate(${heading})">
                        <path d="M 0 -12 L 4.5 3 L 0 1.5 L -4.5 3 Z" fill="#cccc44" stroke="#cccc44" stroke-width="0.5"/>
                    </g>
                </svg>
                <div class="ac-data-block" style="left: ${blockLeft}px; top: ${blockTop}px;">
                    <div class="ac-line1">${esc(f.callsign || '?')} ${altStr}</div>
                    <div class="ac-line2">${esc(f.acType || '?')} ${spdStr}</div>
                </div>
            </div>
        `;
        const aircraftIcon = L.divIcon({
            html: markerHtml,
            className: 'aircraft-marker',
            iconAnchor: [15, 15]
        });
        posMarker = L.marker([f.lat, f.lon], { icon: aircraftIcon }).addTo(map);
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
                // Label at distance midpoint with perpendicular offset from line
                const mid = findDistanceMidpoint(segWps);

                // Calculate perpendicular offset to position label clear of the line
                let labelPos = { lat: mid.lat, lon: mid.lon };
                const midIdx = segWps.indexOf(mid);
                if (midIdx > 0 && midIdx < segWps.length - 1) {
                    const before = segWps[midIdx - 1];
                    const after = segWps[midIdx + 1];
                    // Line direction vector (normalized)
                    const dx = after.lon - before.lon;
                    const dy = after.lat - before.lat;
                    const len = Math.sqrt(dx * dx + dy * dy);
                    if (len > 0) {
                        // Perpendicular vector (rotated 90° counter-clockwise), offset in lat/lon space
                        const perpDx = -dy / len;
                        const perpDy = dx / len;
                        const offsetDist = 0.015; // ~1-2km offset in lat/lon degrees
                        labelPos.lat = mid.lat + perpDy * offsetDist;
                        labelPos.lon = mid.lon + perpDx * offsetDist;
                    }
                }

                const label = L.divIcon({
                    html: `<span style="color:${colors[i % colors.length]};">${f.centers[i].name}</span>`,
                    className: 'artcc-label',
                    iconAnchor: [0, 0]
                });
                const marker = L.marker([labelPos.lat, labelPos.lon], { icon: label }).addTo(map);
                fixMarkers.push(marker);
            }
        }
        // Fit bounds to sector lines (only on initial load)
        if (fitBounds && sectorLines.length > 0) {
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

// Calculate distance between two lat/lon points (in arbitrary units, for ratio calc)
function distance(p1, p2) {
    const dlat = p2.lat - p1.lat;
    const dlon = p2.lon - p1.lon;
    return Math.sqrt(dlat * dlat + dlon * dlon);
}

// Find waypoint at distance midpoint of a segment
function findDistanceMidpoint(waypoints) {
    if (waypoints.length < 2) return waypoints[0];

    // Calculate cumulative distances
    const distances = [0];
    for (let i = 1; i < waypoints.length; i++) {
        distances.push(distances[i - 1] + distance(waypoints[i - 1], waypoints[i]));
    }

    const totalDist = distances[distances.length - 1];
    const halfDist = totalDist / 2;

    // Find waypoint closest to halfway point
    let bestIdx = 0;
    let bestDiff = Math.abs(distances[0] - halfDist);
    for (let i = 1; i < distances.length; i++) {
        const diff = Math.abs(distances[i] - halfDist);
        if (diff < bestDiff) {
            bestDiff = diff;
            bestIdx = i;
        }
    }

    return waypoints[bestIdx];
}

// Calculate heading from current position toward next waypoint
function calculateHeading(currentLat, currentLon, waypoints) {
    if (!waypoints || waypoints.length < 2) return 0;

    // Find the next waypoint ahead of current position
    let nextWp = null;
    for (const wp of waypoints) {
        if (distance({lat: currentLat, lon: currentLon}, wp) > 0.01) {
            nextWp = wp;
            break;
        }
    }

    if (!nextWp) nextWp = waypoints[waypoints.length - 1];

    // Calculate bearing in degrees
    const lat1 = currentLat * Math.PI / 180;
    const lat2 = nextWp.lat * Math.PI / 180;
    const dLon = (nextWp.lon - currentLon) * Math.PI / 180;

    const y = Math.sin(dLon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    let bearing = Math.atan2(y, x) * 180 / Math.PI;

    return (bearing + 360) % 360;
}

// ── Render sidebar ───────────────────────────────────────────
function findClosestTimePosition(items, timeField, etdIso) {
    if (!items || items.length === 0 || !etdIso) return -1;

    const now = new Date(); // Current UTC time
    const etd = new Date(etdIso);

    let closestBefore = -1;
    let closestAfter = -1;
    let minBeforeDiff = Infinity;
    let minAfterDiff = Infinity;

    for (let i = 0; i < items.length; i++) {
        const itemElapsed = items[i][timeField];
        if (itemElapsed == null) continue;

        // Calculate absolute time of this item
        const itemTime = new Date(etd.getTime() + itemElapsed * 1000);
        const diff = now.getTime() - itemTime.getTime();

        if (diff >= 0 && diff < minBeforeDiff) {
            minBeforeDiff = diff;
            closestBefore = i;
        }
        if (diff < 0 && Math.abs(diff) < minAfterDiff) {
            minAfterDiff = Math.abs(diff);
            closestAfter = i;
        }
    }

    // Return position to insert after (between before and after)
    if (closestBefore >= 0 && closestAfter > closestBefore) {
        return closestBefore;
    }
    return -1;
}

function insertTimeIndicator(listContainer, items, timeField) {
    if (!items || items.length === 0 || !listContainer) return;

    // Remove any existing indicator
    const existing = listContainer.querySelector('.time-indicator');
    if (existing) existing.remove();

    const insertAfterIdx = findClosestTimePosition(items, timeField, currentFlight.etd);
    if (insertAfterIdx >= 0 && insertAfterIdx < items.length - 1) {
        const indicator = document.createElement('div');
        indicator.className = 'time-indicator';
        const itemDivs = listContainer.querySelectorAll('.fix-item, .sector-item');
        if (itemDivs.length > insertAfterIdx + 1) {
            itemDivs[insertAfterIdx + 1].parentNode.insertBefore(indicator, itemDivs[insertAfterIdx + 1]);
        }
    }
}

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
        html += '<div class="section-title">ROUTE FIXES</div><div class="fix-list" data-list-type="fixes">';
        for (const fix of f.fixes) {
            const time = fix.elapsedTime != null ? formatElapsed(fix.elapsedTime, f.etd) : '';
            html += `<div class="fix-item" data-elapsed="${fix.elapsedTime || 0}">
                <span class="fix-name">${esc(fix.name)}</span>
                <span class="fix-time">${time}</span>
            </div>`;
        }
        html += '</div>';
    }

    // Centers
    if (f.centers && f.centers.length > 0) {
        html += '<div class="section-title">ARTCC TRAVERSAL</div><div class="sector-list" data-list-type="centers">';
        for (const c of f.centers) {
            const time = c.elapsedEntryTime != null ? formatElapsed(c.elapsedEntryTime, f.etd) : 'origin';
            html += `<div class="sector-item" data-elapsed="${c.elapsedEntryTime || 0}">
                <span class="sec-name">${esc(c.name)}</span>
                <span class="sec-time">${time}</span>
            </div>`;
        }
        html += '</div>';
    }

    // Sectors
    if (f.sectors && f.sectors.length > 0) {
        html += '<div class="section-title">SECTOR TRAVERSAL</div><div class="sector-list" data-list-type="sectors" style="max-height:none;">';
        for (const s of f.sectors) {
            const time = s.elapsedEntryTime != null ? formatElapsed(s.elapsedEntryTime, f.etd) : 'origin';
            html += `<div class="sector-item" data-elapsed="${s.elapsedEntryTime || 0}">
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

    // Insert time indicators
    setTimeout(() => {
        if (f.fixes && f.fixes.length > 0) {
            const fixList = sidebar.querySelector('[data-list-type="fixes"]');
            insertTimeIndicator(fixList, f.fixes, 'elapsedTime');
        }
        if (f.centers && f.centers.length > 0) {
            const centerList = sidebar.querySelector('[data-list-type="centers"]');
            insertTimeIndicator(centerList, f.centers, 'elapsedEntryTime');
        }
        if (f.sectors && f.sectors.length > 0) {
            const sectorList = sidebar.querySelector('[data-list-type="sectors"]');
            insertTimeIndicator(sectorList, f.sectors, 'elapsedEntryTime');
        }
    }, 0);
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

// ── Auto-refresh current flight (skip fit bounds) ────────────
setInterval(() => {
    if (currentFlight && currentFlight.flightRef) {
        loadFlight(currentFlight.flightRef, true);
    }
}, 30000);

// ── Update time indicators every 5 seconds ────────────────────
setInterval(() => {
    if (!currentFlight) return;
    const sidebar = document.getElementById('sidebar');

    if (currentFlight.fixes && currentFlight.fixes.length > 0) {
        const fixList = sidebar.querySelector('[data-list-type="fixes"]');
        insertTimeIndicator(fixList, currentFlight.fixes, 'elapsedTime');
    }
    if (currentFlight.centers && currentFlight.centers.length > 0) {
        const centerList = sidebar.querySelector('[data-list-type="centers"]');
        insertTimeIndicator(centerList, currentFlight.centers, 'elapsedEntryTime');
    }
    if (currentFlight.sectors && currentFlight.sectors.length > 0) {
        const sectorList = sidebar.querySelector('[data-list-type="sectors"]');
        insertTimeIndicator(sectorList, currentFlight.sectors, 'elapsedEntryTime');
    }
}, 5000);
