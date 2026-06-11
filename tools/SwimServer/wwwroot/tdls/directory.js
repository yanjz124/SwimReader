const AIRPORT_NAMES = {
    KABQ:'ALBUQUERQUE',KATL:'ATLANTA',KAUS:'AUSTIN',KBDL:'BRADLEY',KBOI:'BOISE',KBNA:'NASHVILLE',KBOS:'BOSTON',KBUF:'BUFFALO',KBUR:'BURBANK',KBWI:'BALTIMORE',
    KCHS:'CHARLESTON',KCLE:'CLEVELAND',KCLT:'CHARLOTTE',KCMH:'COLUMBUS',KCVG:'CINCINNATI',KDAL:'DALLAS LOVE',KDCA:'WASHINGTON REAGAN',
    KDEN:'DENVER',KDFW:'DALLAS FT WORTH',KDTW:'DETROIT',KELP:'EL PASO',KEWR:'NEWARK',
    KFLL:'FT LAUDERDALE',KGSO:'GREENSBORO',KHPN:'WESTCHESTER',KHOU:'HOUSTON HOBBY',KIAH:'HOUSTON INTL',
    KIAD:'WASHINGTON DULLES',KIND:'INDIANAPOLIS',KJFK:'NEW YORK JFK',
    KLAS:'LAS VEGAS',KLAX:'LOS ANGELES',KLGA:'LAGUARDIA',KLIT:'LITTLE ROCK',
    KMCI:'KANSAS CITY',KMCO:'ORLANDO',KMEM:'MEMPHIS',KMIA:'MIAMI',KMKE:'MILWAUKEE',
    KMDW:'CHICAGO MIDWAY',KMSP:'MINNEAPOLIS',KMSY:'NEW ORLEANS',
    KOAK:'OAKLAND',KOKC:'OKLAHOMA CITY',KOMA:'OMAHA',KONT:'ONTARIO',
    KORD:'CHICAGO O\'HARE',KPDX:'PORTLAND',KPHL:'PHILADELPHIA',
    KPHX:'PHOENIX',KPIT:'PITTSBURGH',KPVD:'PROVIDENCE',
    KRDU:'RALEIGH DURHAM',KRNO:'RENO',
    KSAN:'SAN DIEGO',KSAT:'SAN ANTONIO',KSDF:'LOUISVILLE',KSEA:'SEATTLE',KSJC:'SAN JOSE',KSMF:'SACRAMENTO',KSFO:'SAN FRANCISCO',
    KSLC:'SALT LAKE CITY',KSNA:'ORANGE COUNTY',KSTL:'ST LOUIS',
    KTEB:'TETERBORO',KTPA:'TAMPA',KTUL:'TULSA',
    KVNY:'VAN NUYS',PANC:'ANCHORAGE',PHNL:'HONOLULU',TJSJ:'SAN JUAN',
    KADW:'ANDREWS AFB',
};

const statusEl = document.getElementById('status');
const countBar = document.getElementById('count-bar');
const grid     = document.getElementById('grid');

async function refresh() {
    try {
        const r = await fetch('/api/tdls');
        if (!r.ok) throw new Error(r.status);
        const airports = await r.json();

        statusEl.textContent = 'LIVE';
        statusEl.className = 'ok';

        if (!airports.length) {
            countBar.textContent = '';
            grid.innerHTML = '<div class="empty">No TDLS airports active — waiting for CPDLC clearances</div>';
            return;
        }

        airports.sort((a, b) => a.airport.localeCompare(b.airport));
        const totalAc = airports.reduce((s, a) => s + a.aircraftCount, 0);
        const totalMsg = airports.reduce((s, a) => s + a.messageCount, 0);
        countBar.textContent = `${airports.length} airports  •  ${totalAc} acft  •  ${totalMsg} msg`;

        grid.innerHTML = airports.map(a => {
            const icao = a.airport;
            const name = AIRPORT_NAMES[icao] || '';
            const href = '/tdls/' + icao.toLowerCase();
            return `<a class="card" href="${href}">
                <div class="card-icao">${icao}</div>
                <div class="card-name">${name}</div>
                <div class="card-counts">
                    <div><span class="num">${a.aircraftCount}</span>ACFT</div>
                    <div><span class="num">${a.messageCount}</span>MSG</div>
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
