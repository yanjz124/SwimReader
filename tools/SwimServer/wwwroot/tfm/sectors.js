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

        // Populate ARTCC filter — uses the same grouping function as the
        // grouped grid below, so what the dropdown shows always matches the
        // headers users see.
        const artccs = new Set();
        sectors.forEach(s => artccs.add(groupOf(s.sector)));
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

// Pull the ARTCC/facility prefix off a sector ID. Z** is the common case
// (e.g. ZNY77 → ZNY); fall back to letters before the first digit; else "OTHER".
function groupOf(sectorId) {
    const s = String(sectorId).toUpperCase();
    const m = s.match(/^(Z[A-Z]{2})/);
    if (m) return m[1];
    const m2 = s.match(/^([A-Z]+)/);
    if (m2) return m2[1];
    return 'OTHER';
}

// ── Render sector grid, grouped by facility/ARTCC ────────────
function renderGrid() {
    const search = (document.getElementById('searchInput').value || '').toUpperCase();
    const artcc  = document.getElementById('artccFilter').value;

    const filtered = sectors.filter(s => {
        if (search && !s.sector.toUpperCase().includes(search)) return false;
        if (artcc && groupOf(s.sector) !== artcc) return false;
        return true;
    });

    // Bucket by ARTCC. Each bucket sums totalTransits + max so the heatmap
    // colour normalizes against the whole network (not just within a bucket).
    const groups = new Map();
    for (const s of filtered) {
        const g = groupOf(s.sector);
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(s);
    }

    const grid = document.getElementById('sectorGrid');
    if (filtered.length === 0) {
        grid.innerHTML = `<div class="empty-grid">No sectors match the current filter</div>`;
        return;
    }

    // Sort groups: known ARTCCs alphabetically; "OTHER" at the bottom.
    const sortedGroups = [...groups.entries()].sort((a, b) => {
        if (a[0] === 'OTHER') return 1;
        if (b[0] === 'OTHER') return -1;
        return a[0].localeCompare(b[0]);
    });

    grid.innerHTML = sortedGroups.map(([g, items]) => {
        const total = items.reduce((a, s) => a + s.count, 0);
        const cards = items
            .sort((a, b) => b.count - a.count || a.sector.localeCompare(b.sector))
            .map(s => {
                const pct = Math.round((s.count / maxCount) * 100);
                const sel = selectedSector === s.sector ? 'selected' : '';
                const color = s.count > maxCount * 0.8 ? '#cc4444'
                            : s.count > maxCount * 0.5 ? '#cccc44' : '#44aa44';
                // Strip the ARTCC prefix from the displayed sector ID so cards
                // read e.g. "77" under the ZNY group rather than "ZNY77".
                const short = s.sector.toUpperCase().startsWith(g) ? s.sector.slice(g.length) : s.sector;
                return `<div class="sector-card ${sel}" data-sector="${esc(s.sector)}">
                    <div class="sec-name">${esc(short || s.sector)}</div>
                    <div class="sec-count" style="color:${color}">${s.count}</div>
                    <div class="sec-label">transits</div>
                    <div class="bar"><div class="bar-fill" style="width:${pct}%; background:${color}"></div></div>
                </div>`;
            }).join('');
        return `<section class="artcc-group" data-artcc="${esc(g)}">
            <div class="artcc-header">
                <span class="artcc-name">${esc(g)}</span>
                <span class="artcc-meta">${items.length} sector${items.length === 1 ? '' : 's'} · ${total.toLocaleString()} transits</span>
            </div>
            <div class="artcc-cards">${cards}</div>
        </section>`;
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
