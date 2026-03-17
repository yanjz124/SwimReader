let sectors = [];
let selectedSector = null;
let maxCount = 1;

// ── Load sector summary ──────────────────────────────────────
async function loadSectors() {
    try {
        const r = await fetch('/api/tfms/sectors');
        if (!r.ok) return;
        sectors = await r.json();
        maxCount = Math.max(1, ...sectors.map(s => s.count));

        // Populate ARTCC filter
        const artccs = new Set();
        sectors.forEach(s => {
            const artcc = s.sector.replace(/[0-9]+$/, '').replace(/[A-Z]{2}$/, function(m) {
                // Keep full sector ID but extract ARTCC prefix (e.g., ZOA from ZOA13)
                return '';
            });
            // Simple extraction: first 3-4 chars (Z** pattern)
            const m = s.sector.match(/^(Z[A-Z]{2})/);
            if (m) artccs.add(m[1]);
        });
        const sel = document.getElementById('artccFilter');
        const current = sel.value;
        sel.innerHTML = '<option value="">ALL</option>';
        [...artccs].sort().forEach(a => {
            sel.innerHTML += `<option value="${a}" ${a === current ? 'selected' : ''}>${a}</option>`;
        });

        renderGrid();
        document.getElementById('sectorCount').innerHTML = `Sectors: <b>${sectors.length}</b>`;
    } catch {}
}

// ── Render sector grid ───────────────────────────────────────
function renderGrid() {
    const search = (document.getElementById('searchInput').value || '').toUpperCase();
    const artcc = document.getElementById('artccFilter').value;

    const filtered = sectors.filter(s => {
        if (search && !s.sector.toUpperCase().includes(search)) return false;
        if (artcc && !s.sector.toUpperCase().startsWith(artcc)) return false;
        return true;
    });

    const grid = document.getElementById('sectorGrid');
    grid.innerHTML = filtered.map(s => {
        const pct = Math.round((s.count / maxCount) * 100);
        const sel = selectedSector === s.sector ? 'selected' : '';
        // Color by load
        const color = s.count > maxCount * 0.8 ? '#cc4444'
            : s.count > maxCount * 0.5 ? '#cccc44' : '#44aa44';
        return `<div class="sector-card ${sel}" data-sector="${esc(s.sector)}">
            <div class="sec-name">${esc(s.sector)}</div>
            <div class="sec-count" style="color:${color}">${s.count}</div>
            <div class="sec-label">predicted transits</div>
            <div class="bar"><div class="bar-fill" style="width:${pct}%; background:${color}"></div></div>
        </div>`;
    }).join('');

    grid.querySelectorAll('.sector-card').forEach(el => {
        el.addEventListener('click', () => {
            selectedSector = el.dataset.sector;
            renderGrid();
            loadSectorDetail(el.dataset.sector);
        });
    });
}

document.getElementById('searchInput').addEventListener('input', renderGrid);
document.getElementById('artccFilter').addEventListener('change', renderGrid);

// ── Load sector detail ───────────────────────────────────────
async function loadSectorDetail(sector) {
    try {
        const r = await fetch(`/api/tfms/sectors/${encodeURIComponent(sector)}`);
        if (!r.ok) return;
        const flights = await r.json();
        renderSectorDetail(sector, flights);
    } catch {}
}

function renderSectorDetail(sector, flights) {
    const sidebar = document.getElementById('sidebar');
    sidebar.innerHTML = `
        <div class="sector-header">
            <h2>${esc(sector)}</h2>
            <div class="meta">${flights.length} predicted flights</div>
        </div>
        <div class="section-title">PREDICTED TRANSITS</div>
        <table class="flight-table">
            <thead>
                <tr>
                    <th>CALLSIGN</th>
                    <th>DEP</th>
                    <th>ARR</th>
                    <th>ALT</th>
                    <th>ENTRY TIME</th>
                </tr>
            </thead>
            <tbody>
                ${flights.map(f => `<tr>
                    <td class="cs">${esc(f.callsign || '?')}</td>
                    <td>${esc(f.depArpt || '')}</td>
                    <td>${esc(f.arrArpt || '')}</td>
                    <td>${f.altitude ? (f.altitude >= 18000 ? 'FL' + Math.round(f.altitude/100) : f.altitude) : ''}</td>
                    <td class="time">${f.entryTime ? formatTime(f.entryTime) : ''}</td>
                </tr>`).join('')}
            </tbody>
        </table>
    `;
}

// ── Utils ────────────────────────────────────────────────────
function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function formatTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toISOString().substring(11, 16) + 'Z';
}

// ── Init ─────────────────────────────────────────────────────
loadSectors();
setInterval(loadSectors, 30000);
