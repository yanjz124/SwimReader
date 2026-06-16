const statusEl = document.getElementById('status');
const countBar = document.getElementById('count-bar');
const grid     = document.getElementById('grid');
const toast    = document.getElementById('toast');

// Feed URL template, derived from the current origin so it works locally and behind the tunnel.
const feedTemplate = `${location.origin}/dstars/{FACILITY}/updates`;
const feedUrl = (facility) => `${location.origin}/dstars/${facility}/updates`;

document.getElementById('feedUrl').textContent = feedTemplate;

let _toastTimer = null;
function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => toast.classList.remove('show'), 1600);
}

async function copy(text, label) {
    try {
        await navigator.clipboard.writeText(text);
        showToast(`Copied ${label}`);
    } catch {
        // Fallback for non-secure contexts where the Clipboard API is unavailable
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); showToast(`Copied ${label}`); }
        catch { showToast('Copy failed — select manually'); }
        document.body.removeChild(ta);
    }
}

document.getElementById('copyTemplate').addEventListener('click',
    () => copy(feedTemplate, 'feed URL template'));

async function refresh() {
    try {
        const r = await fetch('/api/tais');
        if (!r.ok) throw new Error(r.status);
        const facilities = await r.json();

        statusEl.textContent = 'LIVE';
        statusEl.className = 'ok';

        if (!facilities.length) {
            countBar.textContent = '';
            grid.innerHTML = '<div class="empty">No facilities active — waiting for STDDS terminal data</div>';
            return;
        }

        const totalTracks = facilities.reduce((s, f) => s + f.trackCount, 0);
        countBar.textContent = `${facilities.length} facilities  •  ${totalTracks} tracks  •  click a facility to copy its feed URL`;

        grid.innerHTML = facilities.map(f => `
            <div class="card" data-facility="${f.facility}">
                <div class="card-id">${f.facility}</div>
                <div class="card-counts">
                    <div><span class="num">${f.trackCount}</span>TRACKS</div>
                </div>
                <div class="card-copy">COPY FEED URL</div>
            </div>`).join('');
    } catch (e) {
        statusEl.textContent = 'ERROR';
        statusEl.className = '';
    }
}

grid.addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    const facility = card.dataset.facility;
    copy(feedUrl(facility), `${facility} feed URL`);
});

refresh();
let _pollTimer = setInterval(refresh, 5000);
window.idleOnPause = () => { clearInterval(_pollTimer); };
window.idleOnResume = () => { refresh(); _pollTimer = setInterval(refresh, 5000); };
