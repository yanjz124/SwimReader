// ── Map ──────────────────────────────────────────────────────
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

let tmis = [];
let selectedFca = null;
let entryMarkers = [];

// ── Load TMIs ────────────────────────────────────────────────
async function loadTmis() {
    try {
        const r = await fetch('/api/tfms/tmis');
        if (!r.ok) return;
        tmis = await r.json();
        renderFcaList();
        document.getElementById('fcaCount').innerHTML = `FCAs: <b>${tmis.length}</b>`;
    } catch {}
}

// ── Render FCA list ──────────────────────────────────────────
function renderFcaList() {
    const search = (document.getElementById('fcaSearch').value || '').toUpperCase();
    const filtered = tmis
        .filter(t => {
            if (!search) return true;
            return (t.fcaName || '').toUpperCase().includes(search)
                || (t.fcaId || '').toUpperCase().includes(search);
        })
        .sort((a, b) => (b.flightCount || 0) - (a.flightCount || 0));

    const list = document.getElementById('fcaList');
    list.innerHTML = filtered.map(t => {
        const name = t.fcaName || '(unnamed)';
        const sel = selectedFca === t.fcaId ? 'selected' : '';
        return `<div class="fca-item ${sel}" data-id="${esc(t.fcaId)}">
            <div class="fca-name">${esc(name)}</div>
            <div class="fca-meta">
                <span class="flights">${t.flightCount || 0} flights</span>
                <span class="updated">${timeSince(t.lastUpdated)}</span>
            </div>
            <div class="fca-id">${esc(t.fcaId)}</div>
        </div>`;
    }).join('');

    list.querySelectorAll('.fca-item').forEach(el => {
        el.addEventListener('click', () => {
            selectedFca = el.dataset.id;
            renderFcaList();
            loadFcaDetail(el.dataset.id);
        });
    });
}

document.getElementById('fcaSearch').addEventListener('input', renderFcaList);

// ── Load FCA detail and show on map ──────────────────────────
async function loadFcaDetail(fcaId) {
    try {
        const r = await fetch(`/api/tfms/tmis/${encodeURIComponent(fcaId)}`);
        if (!r.ok) return;
        const t = await r.json();
        showFlightsOnMap(t);
        showFlightPopup(t);
    } catch {}
}

function showFlightsOnMap(t) {
    // Clear old markers
    entryMarkers.forEach(m => map.removeLayer(m));
    entryMarkers = [];

    const flights = t.flights || [];
    const bounds = [];

    flights.forEach(f => {
        if (f.entryLat && f.entryLon) {
            const marker = L.circleMarker([f.entryLat, f.entryLon], {
                radius: 4,
                color: f.status === 'ACTIVE' ? '#44aa44' : '#666',
                fillColor: f.status === 'ACTIVE' ? '#44aa44' : '#666',
                fillOpacity: 0.7,
                weight: 1
            }).addTo(map);
            marker.bindTooltip(`${f.callsign || '?'} ${f.depArpt||'?'}-${f.arrArpt||'?'}`, {
                direction: 'top',
                className: ''
            });
            entryMarkers.push(marker);
            bounds.push([f.entryLat, f.entryLon]);
        }
    });

    if (bounds.length > 0) {
        map.fitBounds(bounds, { padding: [60, 60], maxZoom: 8 });
    }
}

function showFlightPopup(t) {
    const popup = document.getElementById('flightPopup');
    const flights = t.flights || [];
    document.getElementById('popupTitle').textContent =
        `${t.fcaName || t.fcaId} — ${flights.length} flights`;

    document.getElementById('popupBody').innerHTML = flights.map(f => `<tr>
        <td class="cs">${esc(f.callsign || '?')}</td>
        <td>${esc(f.depArpt || '')}</td>
        <td>${esc(f.arrArpt || '')}</td>
        <td class="${f.status === 'ACTIVE' ? 'active' : ''}">${esc(f.status || '')}</td>
        <td class="time">${f.entryTime ? formatTime(f.entryTime) : ''}</td>
        <td class="time">${f.exitTime ? formatTime(f.exitTime) : ''}</td>
    </tr>`).join('');

    popup.style.display = 'block';
}

document.getElementById('popupClose').addEventListener('click', () => {
    document.getElementById('flightPopup').style.display = 'none';
});

// ── WebSocket for live updates ───────────────────────────────
function connectWs() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/tfms/ws/tmi`);
    ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'snapshot') {
            tmis = msg.data;
            renderFcaList();
        } else if (msg.type === 'update') {
            for (const t of msg.data) {
                const idx = tmis.findIndex(x => x.fcaId === t.fcaId);
                if (idx >= 0) tmis[idx] = t;
                else tmis.push(t);
            }
            renderFcaList();
            if (selectedFca) {
                const updated = msg.data.find(t => t.fcaId === selectedFca);
                if (updated) loadFcaDetail(selectedFca);
            }
        }
    };
    ws.onclose = () => setTimeout(connectWs, 5000);
    ws.onerror = () => ws.close();
}
connectWs();

// ── Utils ────────────────────────────────────────────────────
function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function formatTime(iso) {
    if (!iso) return '';
    return new Date(iso).toISOString().substring(11, 16) + 'Z';
}
function timeSince(iso) {
    if (!iso) return '?';
    const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (sec < 60) return sec + 's ago';
    if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
    return Math.floor(sec / 3600) + 'h ago';
}

// ── Init ─────────────────────────────────────────────────────
loadTmis();
