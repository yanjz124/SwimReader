// Known airport names for display (augmented from live data as needed)
const AIRPORT_NAMES = {
    KATL:'ATLANTA',KBDL:'BRADLEY',KBOS:'BOSTON',KBWI:'BALTIMORE',
    KCLE:'CLEVELAND',KCLT:'CHARLOTTE',KCVG:'CINCINNATI',KDCA:'WASHINGTON REAGAN',
    KDEN:'DENVER',KDFW:'DALLAS FT WORTH',KDTW:'DETROIT',KEWR:'NEWARK',
    KFLL:'FT LAUDERDALE',KHOU:'HOUSTON HOBBY',KIAH:'HOUSTON INTL',
    KJFK:'NEW YORK JFK',KLAS:'LAS VEGAS',KLAX:'LOS ANGELES',
    KMCO:'ORLANDO',KMEM:'MEMPHIS',KMIA:'MIAMI',KMKE:'MILWAUKEE',
    KMDW:'CHICAGO MIDWAY',KMSP:'MINNEAPOLIS',KMSY:'NEW ORLEANS',
    KORD:'CHICAGO O\'HARE',KPDX:'PORTLAND',KPHL:'PHILADELPHIA',
    KPHX:'PHOENIX',KPIT:'PITTSBURGH',KPVD:'PROVIDENCE',
    KSAN:'SAN DIEGO',KSDF:'LOUISVILLE',KSEA:'SEATTLE',KSFO:'SAN FRANCISCO',
    KSLC:'SALT LAKE CITY',KSNA:'ORANGE COUNTY',KSTL:'ST LOUIS',
    KTPA:'TAMPA',PANC:'ANCHORAGE',PHNL:'HONOLULU',
};

const statusEl = document.getElementById('status');
const countBar = document.getElementById('count-bar');
const grid     = document.getElementById('grid');

async function refresh() {
    try {
        const r = await fetch('/api/asdex');
        if (!r.ok) throw new Error(r.status);
        const airports = await r.json();

        statusEl.textContent = 'LIVE';
        statusEl.className = 'ok';

        if (!airports.length) {
            countBar.textContent = '';
            grid.innerHTML = '<div class="empty">No ASDE-X airports active</div>';
            return;
        }

        airports.sort((a, b) => a.airport.localeCompare(b.airport));
        const total = airports.reduce((s, a) => s + a.count, 0);
        countBar.textContent = `${airports.length} airports  •  ${total} tracks`;

        grid.innerHTML = airports.map(a => {
            const icao = a.airport;
            const name = AIRPORT_NAMES[icao] || '';
            const href = '/asdex/' + icao.toLowerCase();
            return `<a class="card" href="${href}">
                <div class="card-icao">${icao}</div>
                <div class="card-name">${name}</div>
                <div class="card-count"><span>${a.count}</span>TRACKS</div>
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
