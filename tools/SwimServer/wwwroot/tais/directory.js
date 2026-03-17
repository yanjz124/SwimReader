const statusEl = document.getElementById('status');
const countBar = document.getElementById('count-bar');
const grid     = document.getElementById('grid');

async function refresh() {
    try {
        const r = await fetch('/api/tais');
        if (!r.ok) throw new Error(r.status);
        const facilities = await r.json();

        statusEl.textContent = 'LIVE';
        statusEl.className = 'ok';

        if (!facilities.length) {
            countBar.textContent = '';
            grid.innerHTML = '<div class="empty">No TAIS facilities active — waiting for STDDS data</div>';
            return;
        }

        const totalTracks = facilities.reduce((s, f) => s + f.trackCount, 0);
        countBar.textContent = `${facilities.length} facilities  •  ${totalTracks} tracks`;

        grid.innerHTML = facilities.map(f => {
            const href = '/tais/' + f.facility.toLowerCase();
            return `<a class="card" href="${href}">
                <div class="card-id">${f.facility}</div>
                <div class="card-counts">
                    <div><span class="num">${f.trackCount}</span>TRACKS</div>
                </div>
            </a>`;
        }).join('');
    } catch (e) {
        statusEl.textContent = 'ERROR';
        statusEl.className = '';
    }
}

refresh();
let _pollTimer = setInterval(refresh, 5000);
window.idleOnPause = () => { clearInterval(_pollTimer); };
window.idleOnResume = () => { refresh(); _pollTimer = setInterval(refresh, 5000); };
