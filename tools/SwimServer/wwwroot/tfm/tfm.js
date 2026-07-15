// ── State ────────────────────────────────────────────────────
let flights = [];
let selectedFlight = null;
let detailMap = null;
let detailRouteLine = null;
let detailMarkers = [];

// ── Flight polling ───────────────────────────────────────────
async function refreshFlights() {
    try {
        const r = await fetch('/api/tfms/flights');
        if (!r.ok) return;
        flights = await r.json();
        renderFlightTable();
    } catch {}
}

function renderFlightTable() {
    const search = (document.getElementById('flightSearch').value || '').toUpperCase();
    const filtered = flights.filter(f => {
        if (!search) return true;
        return (f.callsign || '').toUpperCase().includes(search)
            || (f.depArpt || '').toUpperCase().includes(search)
            || (f.arrArpt || '').toUpperCase().includes(search)
            || (f.star || '').toUpperCase().includes(search)
            || (f.acType || '').toUpperCase().includes(search)
            || (f.acModel || '').toUpperCase().includes(search)
            || (f.status || '').toUpperCase().includes(search);
    });

    const body = document.getElementById('flightTableBody');
    body.innerHTML = filtered.slice(0, 500).map(f => {
        const sel = selectedFlight === f.flightRef ? 'selected' : '';
        const statusCls = f.status === 'ACTIVE' ? 'active' : '';
        return `<tr class="${sel}" data-ref="${esc(f.flightRef || '')}">
        <td class="cs">${esc(f.callsign || '?')}</td>
        <td>${esc(f.depArpt || '')}</td>
        <td>${esc(f.arrArpt || '')}</td>
        <td>${fmtAlt(f.altitude)}</td>
        <td>${f.speed || ''}</td>
        <td>${esc(f.star || '')}</td>
        <td class="time">${f.eta ? formatTime(f.eta) : ''}</td>
        <td class="${statusCls}">${esc(f.status || '')}</td>
        <td>${esc(f.category || '')}</td>
    </tr>`;
    }).join('');

    body.querySelectorAll('tr').forEach(row => {
        row.addEventListener('click', () => {
            const ref = row.dataset.ref;
            if (ref) loadFlightDetail(ref, 'flightDetail');
        });
        row.style.cursor = 'pointer';
    });

    document.getElementById('flightCount').innerHTML = `Flights: <b>${flights.length}</b>`;
}

document.getElementById('flightSearch').addEventListener('input', renderFlightTable);

// ── Load flight detail ───────────────────────────────────────
async function loadFlightDetail(key, panelId) {
    try {
        const r = await fetch(`/api/tfms/flights/${encodeURIComponent(key)}`);
        if (!r.ok) return;
        const f = await r.json();
        selectedFlight = f.flightRef;
        renderFlightDetail(f, panelId);
        if (panelId === 'flightDetail') renderFlightTable(); // highlight row
    } catch {}
}

function renderFlightDetail(f, panelId) {
    const panel = document.getElementById(panelId);
    panel.classList.add('open');

    const altStr = fmtAlt(f.altitude);
    const etdStr = f.etd ? formatTime(f.etd) : '?';
    const etaStr = f.eta ? formatTime(f.eta) : '?';

    let html = `<span class="detail-close" onclick="closeDetail('${panelId}')">X</span>`;

    // Header
    html += `<div class="detail-header">
        <div class="callsign">${esc(f.callsign || '?')}</div>
        <div class="route-text">${esc(f.depArpt || '?')} &rarr; ${esc(f.arrArpt || '?')}</div>
        <div class="meta">
            ${esc(f.category || '')} ${esc(f.userCategory || '')}
            ${f.airline ? ' | ' + esc(f.airline) : ''}
            ${f.facility ? ' | ' + esc(f.facility) : ''}
        </div>
    </div>`;

    // Identity & Status
    html += '<div class="section-title">IDENTITY & STATUS</div>';
    html += '<div class="detail-grid">';
    html += row('CID', f.idNumber);
    html += row('GUFI', f.gufi);
    html += row('Flight Ref', f.flightRef);
    html += row('Status', f.flightStatus, f.flightStatus === 'ACTIVE' ? 'active-status' : '');
    html += row('Category', [f.category, f.userCategory].filter(Boolean).join(' / ') || null);
    html += row('Aircraft Type', f.acType);
    html += row('Aircraft Model', f.acModel);
    html += row('Engine Class', f.aircraftEngineClass);
    if (f.specialAircraftQualifier) html += row('Special Qual', f.specialAircraftQualifier);
    html += row('Beacon Code', f.assignedBeaconCode);
    if (f.diversionIndicator) html += row('Diversion', f.diversionIndicator);
    html += '</div>';

    // Flight Plan section
    html += '<div class="section-title">FLIGHT PLAN</div>';
    html += '<div class="detail-grid">';
    html += row('Departure', f.depArpt, 'hi');
    html += row('Arrival', f.arrArpt, 'hi');
    html += row('Altitude', altStr);
    html += row('Reported', f.reportedAltitudeRaw);
    html += row('Assigned Alt', f.assignedAltitude ? fmtAlt(f.assignedAltitude) : null);
    html += row('Requested Alt', f.requestedAltitude ? fmtAlt(f.requestedAltitude) : null);
    html += row('Speed', f.speed ? f.speed + ' kts' : null);
    html += row('Ground Speed', f.groundSpeed ? f.groundSpeed + ' kts' : null);
    html += row('Filed TAS', f.filedTrueAirSpeed ? f.filedTrueAirSpeed + ' kts' : null);
    html += row('Filed Mach', f.filedMach);
    html += row('ETD', etdStr, 'cyan');
    html += row('ETA', etaStr, 'cyan');
    html += row('STAR', f.star ? (f.star + (f.starTransitionFix ? ' via ' + f.starTransitionFix : '')) : null);
    html += row('SID/DP', f.dpName ? (f.dpName + (f.dpType ? ' (' + f.dpType + ')' : '') + (f.dpTransitionFix ? ' via ' + f.dpTransitionFix : '')) : null);
    if (f.coordinationFix) html += row('Coord Fix', f.coordinationFix + (f.coordinationTime ? ' @ ' + formatTime(f.coordinationTime) : ''), 'cyan');
    html += '</div>';

    // CDM / Airline Times
    html += '<div class="section-title">CDM / AIRLINE TIMES</div>';
    html += '<div class="detail-grid">';
    html += row('OUT (Gate Push)', f.airlineOutTime ? formatTime(f.airlineOutTime) : null, 'cyan');
    html += row('OFF (Takeoff)', f.airlineOffTime ? formatTime(f.airlineOffTime) : null, 'cyan');
    html += row('ON (Landing)', f.airlineOnTime ? formatTime(f.airlineOnTime) : null, 'cyan');
    html += row('IN (Gate Arrival)', f.airlineInTime ? formatTime(f.airlineInTime) : null, 'cyan');
    html += row('Gate Departure', f.gateDeparture ? formatTime(f.gateDeparture) : null, 'cyan');
    html += row('Gate Arrival', f.gateArrival ? formatTime(f.gateArrival) : null, 'cyan');
    html += row('Runway Departure', f.runwayDeparture ? formatTime(f.runwayDeparture) : null, 'cyan');
    html += row('Runway Arrival', f.runwayArrival ? formatTime(f.runwayArrival) : null, 'cyan');
    html += row('Original Dep', f.originalDeparture ? formatTime(f.originalDeparture) : null);
    html += row('Original Arr', f.originalArrival ? formatTime(f.originalArrival) : null);
    html += row('Flight Creation', f.flightCreation ? formatTime(f.flightCreation) : null);
    html += '</div>';

    // Boundary crossing
    html += '<div class="section-title">BOUNDARY CROSSING</div>';
    html += '<div class="detail-grid">';
    html += row('Fix', f.boundaryFix);
    html += row('Time', f.boundaryCrossingTime ? formatTime(f.boundaryCrossingTime) : null, 'cyan');
    html += row('Radial', f.boundaryRadial ? f.boundaryRadial + '\u00B0' : null);
    html += row('Distance', f.boundaryDistance ? f.boundaryDistance + ' nm' : null);
    html += '</div>';

    // Position extras
    html += '<div class="section-title">TRACK DATA</div>';
    html += '<div class="detail-grid">';
    html += row('Position Time', f.positionTime ? formatTime(f.positionTime) : null, 'cyan');
    html += row('Next Event', f.nextEventLat ? f.nextEventLat.toFixed(3) + ', ' + f.nextEventLon.toFixed(3) : null);
    html += '</div>';

    // Message metadata
    html += '<div class="section-title">MESSAGE META</div>';
    html += '<div class="detail-grid">';
    html += row('FD Trigger', f.fdTrigger);
    html += row('Sensitivity', f.sensitivity);
    html += row('CDM Part', f.cdmPart);
    html += row('Source Facility', f.sourceFacility);
    html += '</div>';

    // Route of flight
    if (f.routeOfFlight) {
        html += '<div class="section-title">ROUTE</div>';
        html += `<div class="route-full">${esc(f.routeOfFlight)}</div>`;
    }

    // Arrival/departure fixes
    if (f.arrivalFix || f.departureFix) {
        html += '<div class="section-title">BOUNDARY FIXES</div>';
        html += '<div class="detail-grid">';
        if (f.departureFix) html += row('Dep Fix', f.departureFix + (f.departureFixTime ? ' @ ' + formatTime(f.departureFixTime) : ''), 'cyan');
        if (f.arrivalFix) html += row('Arr Fix', f.arrivalFix + (f.arrivalFixTime ? ' @ ' + formatTime(f.arrivalFixTime) : ''), 'cyan');
        html += '</div>';
    }

    // Route fixes
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

    // ARTCC traversal
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

    // Sector traversal
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
            <div style="padding:6px 14px; font-size:11px; color:#aaa;">
                ${f.airways.map(a => esc(a)).join(' &nbsp; ')}
            </div>`;
    }

    // Map (secondary, at bottom)
    html += '<div class="section-title">ROUTE MAP</div>';
    html += '<div id="detailMap_' + panelId + '" style="height:200px;"></div>';

    panel.innerHTML = html;

    // Initialize map
    setTimeout(() => renderDetailMap(f, panelId), 50);
}

function renderDetailMap(f, panelId) {
    const mapEl = document.getElementById('detailMap_' + panelId);
    if (!mapEl) return;

    const map = L.map(mapEl, { zoomControl: false, attributionControl: false });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', { maxZoom: 18 }).addTo(map);

    if (f.waypoints && f.waypoints.length > 1) {
        const latlngs = f.waypoints.map(w => [w.lat, w.lon]);
        L.polyline(latlngs, { color: '#44aa44', weight: 2, opacity: 0.8 }).addTo(map);
        map.fitBounds(L.latLngBounds(latlngs), { padding: [20, 20] });
    } else if (f.lat && f.lon && f.lat !== 0) {
        map.setView([f.lat, f.lon], 6);
    } else {
        map.setView([39, -98], 4);
    }

    // Current position
    if (f.lat && f.lon && f.lat !== 0) {
        L.circleMarker([f.lat, f.lon], {
            radius: 5, color: '#cccc44', fillColor: '#cccc44', fillOpacity: 1, weight: 2
        }).addTo(map).bindTooltip(f.callsign || '?', { permanent: true, direction: 'right', className: '' });
    }

    // Center-colored segments
    if (f.centers && f.centers.length > 1 && f.waypoints) {
        const colors = ['#4444cc', '#44cc44', '#cc4444', '#cc44cc', '#cccc44', '#44cccc'];
        for (let i = 0; i < f.centers.length; i++) {
            const startTime = f.centers[i].elapsedEntryTime || 0;
            const endTime = i + 1 < f.centers.length ? f.centers[i + 1].elapsedEntryTime : Infinity;
            const segWps = f.waypoints.filter(w =>
                (w.elapsedTime || 0) >= startTime && (w.elapsedTime || 0) < endTime);
            if (i > 0 && startTime > 0) {
                const prev = f.waypoints.filter(w => (w.elapsedTime || 0) < startTime);
                if (prev.length > 0) segWps.unshift(prev[prev.length - 1]);
            }
            if (segWps.length > 1) {
                L.polyline(segWps.map(w => [w.lat, w.lon]), {
                    color: colors[i % colors.length], weight: 3, opacity: 0.6
                }).addTo(map);
            }
        }
    }
}

function closeDetail(panelId) {
    document.getElementById(panelId).classList.remove('open');
    document.getElementById(panelId).innerHTML = `<span class="detail-close" onclick="closeDetail('${panelId}')">X</span>`;
    selectedFlight = null;
    renderFlightTable();
}

document.getElementById('flightDetailClose').addEventListener('click', () => closeDetail('flightDetail'));

// ── Stats polling ────────────────────────────────────────────
async function refreshStats() {
    try {
        const r = await fetch('/api/tfms/stats');
        if (!r.ok) return;
        const s = await r.json();
        document.getElementById('tfmsStatus').innerHTML = s.connected
            ? `TFMS: <b style="color:#44aa44">LIVE</b> ${s.messageCount?.toLocaleString() || 0} msg`
            : `TFMS: <b style="color:#aa4444">DISCONNECTED</b>`;
        document.getElementById('flightCount').innerHTML = `Flights: <b>${s.flightCount || 0}</b>`;
    } catch {}
}

// ── Utils ────────────────────────────────────────────────────
function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function formatTime(iso) {
    if (!iso) return '';
    return new Date(iso).toISOString().substring(11, 16) + 'Z';
}
function timeSince(iso) {
    const d = new Date(iso);
    const sec = Math.floor((Date.now() - d.getTime()) / 1000);
    if (sec < 60) return sec + 's ago';
    if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
    return Math.floor(sec / 3600) + 'h ago';
}
function fmtAlt(alt) {
    if (!alt) return '';
    return alt >= 18000 ? 'FL' + Math.round(alt / 100) : alt + 'ft';
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
function row(label, value, cls) {
    if (value == null || value === '') return '';
    return `<span class="lbl">${label}</span><span class="val ${cls || ''}">${esc(String(value))}</span>`;
}

// ── Init ─────────────────────────────────────────────────────
refreshStats();
refreshFlights();
setInterval(refreshStats, 10000);
setInterval(refreshFlights, 15000);
