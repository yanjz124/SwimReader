// State
// ════════════════════════════════════════════════════════════════════════════
const flights = new Map();          // current displayed state — datablock fields updated instantly
// Position updates applied immediately — history dots use time-based decay for scan simulation
const flightHistory = new Map();
let MAX_HISTORY = 5;
let TRACK_COLOR = '#cccc44';  // dynamic, updated by FDB brightness slider
let PR_HIST_COLOR = '#cccc44';  // dynamic, updated by PR HIST brightness slider
let UNP_TGT_COLOR = '#cccc44';  // dynamic, updated by UNP TGT brightness slider
let UNP_HIST_COLOR = '#cccc44';  // dynamic, updated by UNP HIST brightness slider
const EMRG_COLOR = '#ff4444';
const MAP_COLOR = '#555555';
const RENDER_INTERVAL = 2000;  // render repaint interval (ms)
const SCAN_INTERVAL = 12000;   // SFDPS update cadence (used for history decay cutoff)

let myFacility = '';
let mySectors = new Set();
let facilityOnly = false;   // when true + facility selected, hide all non-facility aircraft
let showFdb = true;
let showHistory = true;
let vectorMinutes = 0;
// showBoundaries removed — boundaries always on, controlled by brightness sliders
let selectedGufi = null;
let wsConnected = false;
let msgRate = 0;
let altFilterLow = 0;      // FL (hundreds of feet), 0 = no filter
let altFilterHigh = 999;    // FL (hundreds of feet), 999 = no filter
let fontSize = 10;          // data block font size in px
let ldbBrightness = 50;     // 0-100, opacity for LDB history symbols (data block brightness now controlled by PR/UNP TGT sliders)
let scopeBckgrd = 50;       // 0-100, scope background brightness (BCKGRD DCB slider)
let scopeBcklght = 90;      // 0-100, scope backlight brightness (BCKLGHT DCB slider)
let showPortalFence = true; // two corner brackets on FDB with PO/R indicators
let showMapBg = false;      // tile layer hidden by default
let line4Mode = 'DEST';     // 'DEST' | 'TYPE' | 'OFF' — what FDB line 4 shows
let replayActive = false;   // replay mode active (set by replay system IIFE)
let replayCurrentTime = null; // ISO string of current replay position
const quickLookSectors = new Set(); // QL sectors — force FDB on tracks in these sectors without claiming ownership
const quickLookDests = new Set();   // QL destinations — force FDB on flights to these airports (e.g. KCLT, KGSO)
const fdbOverrides = new Map(); // gufi → true/false — user toggle for FDB/LDB per track
const wasOwnOrHo = new Set();  // tracks that were own/ho — keeps FDB sticky when they become other
const manuallyHidden = new Set(); // GUFIs user explicitly hid via middle-click cycle or QX command
const lastVisibleAt = new Map(); // gufi → performance.now() — grace period prevents flicker on facility field changes

const knownFacilities = new Map();
const hoCompletedInfo = new Map(); // gufi → { time, receiving, transferring } — track completed handoffs for 60s O display
const dbPositions = new Map(); // gufi → position number 1-9 (data block placement)
const ldrLenOverrides = new Map(); // gufi → leader length level (0-3), default 1
const driActive = new Map();       // gufi → 'J' (standard 5nm) or 'T' (reduced 3nm)
const dwellLocked = new Set();     // GUFIs with persistent dwell emphasis (toggled via Field A click)
const vciActive = new Set();       // GUFIs with VCI (Visual Communications Indicator) toggled on
let codeButtonPressed = false;     // momentary CODE button state — show squawk codes when true
let speedButtonPressed = false;    // momentary SPEED button state — show speed instead of handoff when true
const activeTearoffs = new Map();  // btnKey → { floatingEl, buttonClone } — toolbar tearoff state
const activeFloatingMenus = new Map(); // btnKey → { floatingMenuEl, anchorEl } — floating menu state
let tearoffDeleteMode = false;  // when true, left-click marks for deletion, middle-click deletes
const selectedTearoffsForDeletion = new Set();  // btnKey → marked for deletion

// Controller-entered altitude overrides (QZ/QQ/QR commands)
// Local wins when present; SWIM clears local override only when it sends a genuinely NEW different value
const localAssignedAlt = new Map();  // gufi → { feet, rules, block, serverVal } — QZ assigned altitude
const localInterimAlt = new Map();   // gufi → { feet, type, serverVal } — QQ interim (type: 'I'|'P'|'L')
const localReportedAlt = new Map();  // gufi → { feet, serverVal } — QR controller-entered reported altitude

// HSF (Heading/Speed/Free text) data — QS command (local overrides)
const hsfData = new Map();     // gufi → { heading, speed, freeText } — local QS overrides
const hsfShowMap = new Set();  // GUFIs currently displaying HSF on line 4 (toggled by ↴ click or QS <FLID>)
const hsfClrSuppressed = new Map();  // gufi → {h,s,t} — suppressed server clearance values (after QS * clear)

// Effective HSF: merges server clearance data with local QS overrides (local wins per-field)
// Server clearanceSpeed may be bare number — normalize: 2-digit → M prefix, 3-digit → S prefix
function normalizeSpeed(s) {
    if (!s) return s;
    if (/^\d{2}[+-]?$/.test(s)) return 'M' + s;  // e.g. 75 → M75, 78+ → M78+
    if (/^\d{3}$/.test(s)) return 'S' + s;        // e.g. 250 → S250
    return s;  // 280+, 250-, M79, S270 etc. pass through
}
function normalizeHeading(h) {
    if (!h) return h;
    if (/^\d{3}$/.test(h)) return 'H' + h;  // e.g. 255 → H255
    return h;  // 15R, PH, VK etc. pass through
}
function getEffectiveHsf(f) {
    const local = hsfData.get(f.gufi);
    const heading = normalizeHeading(local?.heading ?? f.clearanceHeading ?? null);
    const speed = local?.speed ?? normalizeSpeed(f.clearanceSpeed) ?? null;
    const freeText = local?.freeText ?? f.clearanceText ?? null;
    if (!heading && !speed && !freeText) return null;
    return { heading, speed, freeText };
}

// Point-out state
const pointoutAcked = new Set();  // GUFIs with acknowledged point-outs (P→A)
const pointoutFirstSeen = new Map();  // GUFI → timestamp (ms) when PO first appeared on client
const PO_CLIENT_TIMEOUT = 3 * 60 * 1000;  // 3 minutes
const pointoutBlocked = new Set();  // GUFIs that had a point-out — FLID toggle blocked until QP <FLID>
let pointoutMenuGufi = null;       // GUFI of flight whose point-out menu is open

// Altimeter settings state
const altimeterStations = new Map();  // station → { airport, code, altimeter, time, updatedAt }
let altimeterMenuOpen = false;
let altimeterSelectedStation = null;  // currently selected station for deletion

// Weather report state
const weatherStations = new Map();  // station → { airport, metar, time, updatedAt }
let weatherMenuOpen = false;
let weatherSelectedStation = null;  // currently selected station for deletion

let crrMenuOpen = false;
let crrGroups = new Map();  // label -> { lat, lon, aircraft: [{ callsign/cid, gufi, distance }], color }
let crrSelectedGroup = null;
let crrColor = '#00D000';
let crrColorSelectorOpen = false;
let crrRdbEnabled = false;
let crrRdbOffset = 3;  // 0=right, 1=left, 2=above-left, 3=bottom-left (cycles with Ctrl+Shift+O)

function setCrrColor(color) {
    crrColor = color;
    updateCrrMenuBody();
}

function toggleCrrColorSelector() {
    crrColorSelectorOpen = !crrColorSelectorOpen;
    updateCrrMenuBody();
}

function updatePointoutMenuBody(f, poInfo) {
    const body = document.getElementById('po-menu-body');
    const acked = pointoutAcked.has(f.gufi);
    let html = '';
    if (poInfo.role === 'originator') {
        // Originator sees each receiving sector as a separate row
        for (const rs of poInfo.recvSectors) {
            const sectorId = rs.sector || '??';
            const pColor = acked ? '#fff' : '#cccc44';
            const sectorCls = acked ? 'po-acked' : 'po-orig-pending';
            html += `<div class="po-sector-row" data-gufi="${f.gufi}" data-role="${poInfo.role}"><span style="color:${pColor}">P</span> <span class="po-sector-box ${sectorCls}">${sectorId}</span></div>`;
        }
    } else {
        // Receiver sees initiating sector
        const sectorId = poInfo.origSector || '??';
        const pColor = acked ? '#fff' : '#00cccc';
        const sectorCls = acked ? 'po-acked' : 'po-recv-pending';
        html = `<div class="po-sector-row" data-gufi="${f.gufi}" data-role="${poInfo.role}"><span style="color:${pColor}">P</span> <span class="po-sector-box ${sectorCls}">${sectorId}</span></div>`;
    }
    body.innerHTML = html;
}

function openPointoutMenu(f, poInfo, clientX, clientY) {
    closePointoutMenu();
    pointoutMenuGufi = f.gufi;
    const menu = document.getElementById('po-menu');
    document.getElementById('po-menu-callsign').textContent = f.callsign || '???';

    updatePointoutMenuBody(f, poInfo);

    // Position to the right of the data block
    const container = document.getElementById('map-container');
    const cRect = container.getBoundingClientRect();
    const gufi = f.gufi;
    const marker = markers.get(gufi);
    let menuLeft = clientX - cRect.left + 10;
    let menuTop = clientY - cRect.top - 10;
    if (marker) {
        const mEl = marker.getElement();
        const dbEl = mEl?.querySelector('.ac-db');
        if (dbEl) {
            const dbRect = dbEl.getBoundingClientRect();
            menuLeft = dbRect.right - cRect.left + 6;
            menuTop = dbRect.top - cRect.top;
        }
    }
    menu.style.left = menuLeft + 'px';
    menu.style.top = menuTop + 'px';
    menu.style.bottom = 'auto';
    menu.style.right = 'auto';
    menu.style.display = 'block';
    requestAnimationFrame(() => clampBox(menu));
}

function closePointoutMenu() {
    pointoutMenuGufi = null;
    document.getElementById('po-menu').style.display = 'none';
}

function getAltimeterObsAgeMinutes(updatedAt) {
    if (!updatedAt) return null;
    try {
        const obsTime = new Date(updatedAt);
        const now = new Date();
        const ageMs = now - obsTime;
        return Math.floor(ageMs / 1000 / 60);  // age in minutes
    } catch {
        return null;
    }
}

function formatAltimeterValue(altimStr) {
    // Input: "29.89" or "30.12" etc.
    // Output: "989" (remove 2 and decimal) or "012" (remove 3 and decimal)
    // Returns 3 digits without first digit and decimal point
    if (!altimStr || altimStr === 'N/A') return null;

    const clean = altimStr.replace(/[^\d]/g, '');  // Remove non-digits
    if (clean.length < 3) return null;

    // Remove first digit, keep last 3 digits (the decimal part without point)
    return clean.substring(1);  // e.g., "2989" → "989", "3012" → "012"
}

function isAltimeterBelowStandard(altimStr) {
    // Standard is 29.92 inHg
    if (!altimStr || altimStr === 'N/A') return false;
    try {
        const val = parseFloat(altimStr);
        return val < 29.92;
    } catch {
        return false;
    }
}

function updateAltimeterMenuBody() {
    const body = document.getElementById('altim-menu-body');
    if (altimeterStations.size === 0) {
        body.innerHTML = '<div style="color:#888; font-size:11px; padding:6px 4px; min-width:180px; text-align:center;">No stations</div>';
        return;
    }
    let html = '';
    for (const [station, data] of altimeterStations) {
        const timeStr = (data.time || '????Z').padEnd(6);
        const ageMin = getAltimeterObsAgeMinutes(data.updatedAt);

        // Determine altimeter display and styling
        let altimHtml;
        if (ageMin !== null && ageMin > 120) {
            // Too old — show -M-
            altimHtml = '<span class="altim-value-digits">-M-</span>';
        } else if (!data.altimeter || data.altimeter === 'N/A') {
            // Missing report
            altimHtml = '<span class="altim-value-digits">-M-</span>';
        } else {
            // Format as 3-digit code (e.g., "989" for 29.89)
            const formatted = formatAltimeterValue(data.altimeter);
            if (formatted) {
                const belowStandard = isAltimeterBelowStandard(data.altimeter);
                const underlineClass = belowStandard ? 'below-standard' : '';
                altimHtml = `<span class="altim-value-digits ${underlineClass}">${formatted}</span>`;
            } else {
                altimHtml = '<span class="altim-value-digits">-M-</span>';
            }
        }

        // Underline observation time if stale (>65 min)
        let timeStyle = '';
        if (ageMin !== null && ageMin > 65) {
            timeStyle = 'text-decoration: underline;';
        }

        const isSelected = altimeterSelectedStation === station;
        const selectedClass = isSelected ? 'altim-entry-selected' : '';
        html += `<div class="altim-entry ${selectedClass}" data-station="${station}" onclick="selectAltimeterStation('${station}', event)">
            <span class="altim-box"></span>
            <span class="altim-station">${station.padEnd(4)}</span>
            <span class="altim-time" style="${timeStyle}">${timeStr}</span>
            <span class="altim-value">${altimHtml}</span>
            ${isSelected ? '<span class="altim-delete-btn" onclick="deleteSelectedAltimeterStation(event)">DEL</span>' : ''}
        </div>`;
    }
    body.innerHTML = html;
}

function selectAltimeterStation(station, event) {
    event.stopPropagation();
    altimeterSelectedStation = altimeterSelectedStation === station ? null : station;
    updateAltimeterMenuBody();
}

function deleteSelectedAltimeterStation(event) {
    event.stopPropagation();
    if (altimeterSelectedStation) {
        removeAltimeterStation(altimeterSelectedStation);
        altimeterSelectedStation = null;
    }
}

let altimeterUpdateInterval = null;
let altimeterRefreshInterval = null;

async function refreshAllAltimeterStations() {
    for (const station of altimeterStations.keys()) {
        try {
            const resp = await fetch(`/api/metar/${encodeURIComponent(station)}`);
            if (!resp.ok) continue;
            const metarText = (await resp.text()).trim();
            if (!metarText) continue;

            // Parse altimeter and time from METAR
            const altimValue = extractAltimeterFromMetar(metarText);
            const obsTime = extractTimeFromMetar(metarText);

            // Update the station data
            altimeterStations.set(station, {
                airport: station,
                code: '?',
                altimeter: altimValue || 'N/A',
                time: obsTime,
                updatedAt: new Date().toISOString(),
                metar: metarText
            });
        } catch (e) {
            console.warn('[ALTIM] Refresh error for', station, ':', e);
        }
    }
    if (altimeterMenuOpen) updateAltimeterMenuBody();
}

function openAltimeterMenu() {
    altimeterMenuOpen = true;
    const menu = document.getElementById('altim-menu');
    updateAltimeterMenuBody();

    // Try to restore position from localStorage
    const savedPos = localStorage.getItem('boxPos_altim-menu');
    if (!savedPos) {
        // No saved position — set default (middle of screen)
        menu.style.left = 'calc(50vw - 110px)';
        menu.style.top = 'calc(50vh - 80px)';
        menu.style.bottom = 'auto';
        menu.style.right = 'auto';
    } else {
        // Restore from localStorage
        try {
            const pos = JSON.parse(savedPos);
            if (pos.left) menu.style.left = pos.left;
            if (pos.top) { menu.style.top = pos.top; menu.style.bottom = 'auto'; menu.style.right = 'auto'; }
            requestAnimationFrame(() => clampBox(menu));
        } catch(e) {
            // Fallback to default if parse fails
            menu.style.left = 'calc(50vw - 110px)';
            menu.style.top = 'calc(50vh - 80px)';
            menu.style.bottom = 'auto';
            menu.style.right = 'auto';
        }
    }

    menu.style.display = 'block';

    // Update the toolbar button state to reflect open menu
    updateAltimSetButtonState();

    // Start periodic updates to refresh observation ages
    if (altimeterUpdateInterval) clearInterval(altimeterUpdateInterval);
    altimeterUpdateInterval = setInterval(() => {
        if (altimeterMenuOpen) updateAltimeterMenuBody();
    }, 30000);  // Update every 30 seconds

    // Start periodic refresh of ATIS data (every 5 minutes)
    if (altimeterRefreshInterval) clearInterval(altimeterRefreshInterval);
    altimeterRefreshInterval = setInterval(() => {
        if (altimeterMenuOpen) refreshAllAltimeterStations();
    }, 5 * 60 * 1000);  // Refresh every 5 minutes
}

function closeAltimeterMenu() {
    altimeterMenuOpen = false;
    document.getElementById('altim-menu').style.display = 'none';
    if (altimeterUpdateInterval) {
        clearInterval(altimeterUpdateInterval);
        altimeterUpdateInterval = null;
    }
    if (altimeterRefreshInterval) {
        clearInterval(altimeterRefreshInterval);
        altimeterRefreshInterval = null;
    }
    // Update the toolbar button state to reflect closed menu
    updateAltimSetButtonState();
}

function updateAltimSetButtonState() {
    const buttons = document.querySelectorAll('.tb-btn');
    for (const btn of buttons) {
        const label = btn.querySelector('.tb-label');
        if (label && label.textContent.includes('ALTIM')) {
            btn.classList.toggle('tb-toggle-on', altimeterMenuOpen);
        }
    }
    // Also update tearoff buttons
    for (const [btnKey, tearoff] of activeTearoffs) {
        if (btnKey.includes('ALTIM')) {
            tearoff.buttonClone.classList.toggle('tb-toggle-on', altimeterMenuOpen);
        }
    }
}

function removeAltimeterStation(station) {
    altimeterStations.delete(station);
    updateAltimeterMenuBody();
}

async function addAltimeterStation(station) {
    // Normalize: strip leading K if present
    let stationCode = station.toUpperCase();
    if (stationCode.startsWith('K')) {
        stationCode = stationCode.substring(1);
    }

    try {
        const resp = await fetch(`/api/metar/${encodeURIComponent(stationCode)}`);
        if (!resp.ok) {
            return { feedback: [{ type: 'err', text: `NO METAR FOR ${stationCode}` }] };
        }
        const metarText = (await resp.text()).trim();
        if (!metarText) {
            return { feedback: [{ type: 'err', text: `NO METAR FOR ${stationCode}` }] };
        }

        // Parse altimeter and time from METAR
        const altimValue = extractAltimeterFromMetar(metarText);
        const obsTime = extractTimeFromMetar(metarText);

        altimeterStations.set(stationCode, {
            airport: stationCode,
            code: '?',
            altimeter: altimValue || 'N/A',
            time: obsTime,
            updatedAt: new Date().toISOString(),
            metar: metarText
        });

        updateAltimeterMenuBody();
        return { feedback: [
            { type: 'ok', text: 'ACCEPT' },
            { type: 'info', text: `ALTIMETER ${stationCode}` },
            { type: 'info', text: `${altimValue || 'N/A'}` }
        ]};
    } catch (e) {
        console.warn('[ALTIM] Error:', e);
        return { feedback: [{ type: 'err', text: `METAR REQ FAILED: ${e.message}` }] };
    }
}

// ── Weather Report Panel ──
function getWeatherObsAgeMinutes(updatedAt) {
    if (!updatedAt) return null;
    try {
        const now = new Date();
        const obs = new Date(updatedAt);
        return (now - obs) / (1000 * 60);
    } catch {
        return null;
    }
}

function extractMetarFromDatis(datis) {
    if (!datis) return null;
    // DATIS format: "LAX ATIS INFO Y 0253Z. 24013KT 10SM BKN010 19/16 A2995..."
    // Extract everything after the time and period (e.g., after "0253Z.")
    const match = datis.match(/\d{4}Z\.\s*(.+)/);
    if (match) {
        return match[1].trim();
    }
    return datis;
}

function extractTimeFromMetar(metar) {
    if (!metar) return '????';
    // METAR format: "DCA 121551Z..." or similar
    // Extract time in format DDHHMMZ
    const match = metar.match(/\s(\d{2})(\d{2})(\d{2})Z/);
    if (match) {
        return match[2] + match[3];  // Return HHMM
    }
    return '????';
}

function extractAltimeterFromMetar(metar) {
    if (!metar) return null;
    // METAR format: "... A2995 ..." or "... A3012 ..."
    const match = metar.match(/\bA(\d{4})\b/);
    if (match) {
        const raw = match[1];
        return raw.substring(0, 2) + '.' + raw.substring(2);
    }
    return null;
}

function cleanMetarText(metar) {
    if (!metar) return '';
    // Remove "METAR " prefix if present
    let text = metar.replace(/^METAR\s+/, '');
    // Remove station ID at the beginning (4 characters followed by space)
    text = text.replace(/^[A-Z]{4}\s+/, '');
    return text.trim();
}

function updateWeatherMenuBody() {
    const body = document.getElementById('wx-menu-body');
    if (weatherStations.size === 0) {
        body.innerHTML = '<div style="color:#888; font-size:11px; text-align:center; width:100%;">No stations</div>';
        body.style.display = 'flex';
        body.style.alignItems = 'center';
        body.style.justifyContent = 'center';
        return;
    }
    body.style.display = 'block';
    let html = '';
    for (const [station, data] of weatherStations) {
        const timeStr = (data.time || '????') + 'Z';
        const ageMin = getWeatherObsAgeMinutes(data.updatedAt);

        // Determine METAR display and styling
        let metarHtml;
        if (ageMin !== null && ageMin > 120) {
            // Too old — show -M-
            metarHtml = '<span class="wx-metar missing">-M-</span>';
        } else if (!data.metar || data.metar === 'N/A') {
            // Missing report
            metarHtml = '<span class="wx-metar missing">-M-</span>';
        } else {
            // Format METAR text with word wrap at ~35 chars per line (for 250px display)
            const metar = cleanMetarText(data.metar);
            const maxCharsPerLine = 35;
            let lines = [];
            let currentLine = '';
            const words = metar.split(' ');
            for (const word of words) {
                if ((currentLine + ' ' + word).length > maxCharsPerLine) {
                    if (currentLine) lines.push(currentLine);
                    currentLine = word;
                } else {
                    currentLine = currentLine ? currentLine + ' ' + word : word;
                }
            }
            if (currentLine) lines.push(currentLine);

            const displayLines = lines.slice(0, 2);  // Show max 2 lines in menu
            const hasMore = lines.length > 2;
            const metarText = displayLines.join('\n') + (hasMore ? ' >' : '');
            metarHtml = `<span class="wx-metar">${metarText.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</span>`;
        }

        // Underline observation time if stale (>65 min)
        const staleClass = ageMin !== null && ageMin > 65 ? 'stale' : '';

        const isSelected = weatherSelectedStation === station;
        const selectedClass = isSelected ? 'wx-entry-selected' : '';
        html += `<div class="wx-entry ${selectedClass}" data-station="${station}" onclick="selectWeatherStation('${station}', event)">
            <div class="wx-station-row">
                <span class="wx-box" style="${isSelected ? 'background:#ff8844;' : ''}"></span>
                <span class="wx-station">${station.padEnd(4)}</span>
                <span class="wx-time ${staleClass}">${timeStr}</span>
            </div>
            ${metarHtml}
            ${isSelected ? '<span class="wx-delete-btn" onclick="deleteSelectedWeatherStation(event)">DEL</span>' : ''}
        </div>`;
    }
    body.innerHTML = html;
}

function selectWeatherStation(station, event) {
    event.stopPropagation();
    weatherSelectedStation = weatherSelectedStation === station ? null : station;
    updateWeatherMenuBody();
}

function deleteSelectedWeatherStation(event) {
    event.stopPropagation();
    if (weatherSelectedStation) {
        removeWeatherStation(weatherSelectedStation);
        weatherSelectedStation = null;
    }
}

let weatherUpdateInterval = null;
let weatherRefreshInterval = null;

async function refreshAllWeatherStations() {
    for (const station of weatherStations.keys()) {
        try {
            const resp = await fetch(`/api/metar/${encodeURIComponent(station)}`);
            if (!resp.ok) continue;
            const metarText = (await resp.text()).trim();
            if (!metarText) continue;

            // Extract time from METAR
            const obsTime = extractTimeFromMetar(metarText);

            // Update the station data
            weatherStations.set(station, {
                airport: station,
                metar: metarText,
                time: obsTime,
                updatedAt: new Date().toISOString()
            });
        } catch (e) {
            console.warn('[WX] Refresh error for', station, ':', e);
        }
    }
    if (weatherMenuOpen) updateWeatherMenuBody();
}

function openWeatherMenu() {
    weatherMenuOpen = true;
    const menu = document.getElementById('wx-menu');
    updateWeatherMenuBody();

    // Try to restore position from localStorage
    const savedPos = localStorage.getItem('boxPos_wx-menu');
    if (!savedPos) {
        // No saved position — set default (right side of screen)
        menu.style.left = 'auto';
        menu.style.right = '20px';
        menu.style.top = '100px';
        menu.style.bottom = 'auto';
    } else {
        // Restore from localStorage
        try {
            const pos = JSON.parse(savedPos);
            if (pos.left) menu.style.left = pos.left;
            if (pos.top) { menu.style.top = pos.top; menu.style.bottom = 'auto'; menu.style.right = 'auto'; }
            requestAnimationFrame(() => clampBox(menu));
        } catch(e) {
            // Fallback to default if parse fails
            menu.style.left = 'auto';
            menu.style.right = '20px';
            menu.style.top = '100px';
            menu.style.bottom = 'auto';
        }
    }

    menu.style.display = 'block';

    // Update the toolbar button state to reflect open menu
    updateWxButtonState();

    // Start periodic updates to refresh observation ages
    if (weatherUpdateInterval) clearInterval(weatherUpdateInterval);
    weatherUpdateInterval = setInterval(() => {
        if (weatherMenuOpen) updateWeatherMenuBody();
    }, 30000);  // Update every 30 seconds

    // Start periodic refresh of ATIS data (every 5 minutes)
    if (weatherRefreshInterval) clearInterval(weatherRefreshInterval);
    weatherRefreshInterval = setInterval(() => {
        if (weatherMenuOpen) refreshAllWeatherStations();
    }, 5 * 60 * 1000);  // Refresh every 5 minutes
}

function closeWeatherMenu() {
    weatherMenuOpen = false;
    document.getElementById('wx-menu').style.display = 'none';
    if (weatherUpdateInterval) {
        clearInterval(weatherUpdateInterval);
        weatherUpdateInterval = null;
    }
    if (weatherRefreshInterval) {
        clearInterval(weatherRefreshInterval);
        weatherRefreshInterval = null;
    }
    // Update the toolbar button state to reflect closed menu
    updateWxButtonState();
}

function updateWxButtonState() {
    const buttons = document.querySelectorAll('.tb-btn');
    for (const btn of buttons) {
        const label = btn.querySelector('.tb-label');
        if (label && label.textContent.includes('WX')) {
            btn.classList.toggle('tb-toggle-on', weatherMenuOpen);
        }
    }
    // Also update tearoff buttons
    for (const [btnKey, tearoff] of activeTearoffs) {
        if (btnKey.includes('WX')) {
            tearoff.buttonClone.classList.toggle('tb-toggle-on', weatherMenuOpen);
        }
    }
}

function removeWeatherStation(station) {
    weatherStations.delete(station);
    updateWeatherMenuBody();
}

async function addWeatherStation(station) {
    // Normalize: strip leading K if present
    let stationCode = station.toUpperCase();
    if (stationCode.startsWith('K')) {
        stationCode = stationCode.substring(1);
    }

    try {
        const resp = await fetch(`/api/metar/${encodeURIComponent(stationCode)}`);
        if (!resp.ok) {
            return { feedback: [{ type: 'err', text: `NO METAR FOR ${stationCode}` }] };
        }
        const metarText = (await resp.text()).trim();
        if (!metarText) {
            return { feedback: [{ type: 'err', text: `NO METAR FOR ${stationCode}` }] };
        }

        // Extract time from METAR
        const obsTime = extractTimeFromMetar(metarText);

        weatherStations.set(stationCode, {
            airport: stationCode,
            metar: metarText,
            time: obsTime,
            updatedAt: new Date().toISOString()
        });

        updateWeatherMenuBody();
        return { feedback: [
            { type: 'ok', text: 'ACCEPT' },
            { type: 'info', text: `WEATHER ${stationCode}` },
            { type: 'info', text: `${obsTime + 'Z'}` }
        ]};
    } catch (e) {
        console.warn('[WX] Error:', e);
        return { feedback: [{ type: 'err', text: `METAR REQ FAILED: ${e.message}` }] };
    }
}

// ── CRR (Continuous Range Readout) ──
function openCrrMenu() {
    crrMenuOpen = true;
    const menu = document.getElementById('crr-menu');
    updateCrrMenuBody();

    // Try to restore position from localStorage
    const savedPos = localStorage.getItem('boxPos_crr-menu');
    if (!savedPos) {
        menu.style.left = 'calc(50vw - 110px)';
        menu.style.top = 'calc(50vh - 80px)';
        menu.style.bottom = 'auto';
        menu.style.right = 'auto';
    } else {
        try {
            const pos = JSON.parse(savedPos);
            if (pos.left) menu.style.left = pos.left;
            if (pos.top) { menu.style.top = pos.top; menu.style.bottom = 'auto'; menu.style.right = 'auto'; }
            requestAnimationFrame(() => clampBox(menu));
        } catch(e) {
            menu.style.left = 'calc(50vw - 110px)';
            menu.style.top = 'calc(50vh - 80px)';
            menu.style.bottom = 'auto';
            menu.style.right = 'auto';
        }
    }

    menu.style.display = 'block';
    updateCrrButtonState();
}

function closeCrrMenu() {
    crrMenuOpen = false;
    document.getElementById('crr-menu').style.display = 'none';
    updateCrrButtonState();
}

function updateCrrButtonState() {
    const buttons = document.querySelectorAll('.tb-btn');
    for (const btn of buttons) {
        const label = btn.querySelector('.tb-label');
        if (label && label.textContent.includes('CRR')) {
            btn.classList.toggle('tb-toggle-on', crrMenuOpen);
        }
    }
    for (const [btnKey, tearoff] of activeTearoffs) {
        if (btnKey.includes('CRR') && !btnKey.includes('CRR FIX') && !btnKey.includes('CRR RDB')) {
            tearoff.buttonClone.classList.toggle('tb-toggle-on', crrMenuOpen);
        }
    }
}

function updateCrrMenuBody() {
    const body = document.getElementById('crr-menu-body');

    let html = '';

    // Color selector (only shown if toggled on)
    if (crrColorSelectorOpen) {
        const colorOptions = ['#00D000', '#cccc44', '#ff4444', '#00ccff', '#ff00ff', '#ffff00'];
        html += '<div style="padding:4px; border-bottom:1px solid #333; display:flex; gap:4px;">';
        for (const color of colorOptions) {
            const isSelected = crrColor === color;
            const borderStyle = isSelected ? 'border:3px solid #fff;' : 'border:1px solid #666;';
            html += `<div onclick="setCrrColor('${color}')" style="width:16px; height:16px; background:${color}; cursor:pointer; ${borderStyle}"></div>`;
        }
        html += '</div>';
    }

    if (crrGroups.size === 0) {
        body.innerHTML = html + '<div style="color:#888; font-size:11px; padding:4px; min-width:180px; text-align:center;">No groups</div>';
        return;
    }
    for (const [label, group] of crrGroups) {
        const isSelected = crrSelectedGroup === label;
        const selectedClass = isSelected ? 'crr-group-selected' : '';
        const groupColor = group.color || crrColor;

        let aircraftHtml = '';
        for (const ac of group.aircraft) {
            const id = ac.callsign || ac.cid || '?';
            const distStr = ac.distance !== null ? ac.distance.toFixed(1) : '?';
            aircraftHtml += `<div class="crr-aircraft" data-group="${label}" data-gufi="${ac.gufi}" data-callsign="${id}">${id.padEnd(10)} ${distStr.padStart(5)}</div>`;
        }

        html += `<div class="crr-group ${selectedClass}" data-label="${label}">
            <div class="crr-group-label" data-group="${label}" style="color:${groupColor}">${label}${isSelected ? ` <span class="crr-group-label-delete" data-delete="${label}">X</span>` : ''}</div>
            ${aircraftHtml}
        </div>`;
    }

    body.innerHTML = html;
}

function selectCrrGroup(label, event) {
    event.stopPropagation();

    if (event.button === 0) {
        // Left-click: Start LF command to add/remove aircraft
        mcaState.content = `LF ${label} `;
        mcaState.selectedFlids = [];
        updateMcaPreview();
    } else if (event.button === 1) {
        // Middle-click: Open delete popup
        event.preventDefault();
        openCrrGroupDeletePopup(label, event);
    }
}

function deleteCrrGroup(label, event) {
    if (event) event.stopPropagation();
    const group = crrGroups.get(label);
    // Invalidate markers for all aircraft in the deleted group
    if (group && group.aircraft) {
        for (const ac of group.aircraft) {
            invalidateMarker(ac.gufi);
        }
    }
    crrGroups.delete(label);
    crrSelectedGroup = null;
    closeCrrGroupDeletePopup();
    updateCrrMenuBody();
    lastRenderTime = 0;  // Force immediate render
}

let crrGroupDeletePopupOpen = false;
let crrGroupDeletePopupLabel = null;

function openCrrGroupDeletePopup(label, event) {
    closeCrrGroupDeletePopup();
    crrGroupDeletePopupOpen = true;
    crrGroupDeletePopupLabel = label;

    const group = crrGroups.get(label);
    const menu = document.getElementById('crr-group-delete-popup');
    const hasAircraft = group.aircraft.length > 0;

    let html = '';
    if (hasAircraft) {
        html = `<div class="crr-popup-option" onclick="deleteCrrGroupAllAircraft('${label}', event); event.stopPropagation();">Delete all aircraft</div>`;
        html += `<div class="crr-popup-option" onclick="deleteCrrGroup('${label}', event); event.stopPropagation();">Delete group</div>`;
    } else {
        html = `<div class="crr-popup-option" onclick="deleteCrrGroup('${label}', event); event.stopPropagation();">Delete group (empty)</div>`;
    }

    menu.innerHTML = html;
    menu.style.display = 'block';
    menu.style.left = event.clientX + 'px';
    menu.style.top = event.clientY + 'px';
}

function closeCrrGroupDeletePopup() {
    crrGroupDeletePopupOpen = false;
    crrGroupDeletePopupLabel = null;
    const menu = document.getElementById('crr-group-delete-popup');
    if (menu) menu.style.display = 'none';
}

function deleteCrrGroupAllAircraft(label, event) {
    if (event) event.stopPropagation();
    const group = crrGroups.get(label);
    if (group) {
        // Invalidate markers for all aircraft in the group
        for (const ac of group.aircraft) {
            invalidateMarker(ac.gufi);
        }
        group.aircraft = [];
    }
    closeCrrGroupDeletePopup();
    updateCrrMenuBody();
    lastRenderTime = 0;  // Force immediate render
}

let crrAircraftDeletePopupOpen = false;
let crrAircraftDeletePopupLabel = null;
let crrAircraftDeletePopupGufi = null;

function openCrrAircraftDeletePopup(label, gufi, callsign, event) {
    closeCrrAircraftDeletePopup();
    crrAircraftDeletePopupOpen = true;
    crrAircraftDeletePopupLabel = label;
    crrAircraftDeletePopupGufi = gufi;

    const menu = document.getElementById('crr-aircraft-delete-popup');
    const html = `<div class="crr-popup-option" onclick="deleteCrrAircraft('${label}', '${gufi}', event); event.stopPropagation();">Delete ${callsign}</div>`;

    menu.innerHTML = html;
    menu.style.display = 'block';
    menu.style.left = event.clientX + 'px';
    menu.style.top = event.clientY + 'px';
}

function closeCrrAircraftDeletePopup() {
    crrAircraftDeletePopupOpen = false;
    crrAircraftDeletePopupLabel = null;
    crrAircraftDeletePopupGufi = null;
    const menu = document.getElementById('crr-aircraft-delete-popup');
    if (menu) menu.style.display = 'none';
}

function deleteCrrAircraft(label, gufi, event) {
    if (event) event.stopPropagation();
    const group = crrGroups.get(label);
    if (group) {
        group.aircraft = group.aircraft.filter(a => a.gufi !== gufi);
    }
    closeCrrAircraftDeletePopup();
    updateCrrMenuBody();
    invalidateMarker(gufi);  // Update RDB visibility
    lastRenderTime = 0;  // Force immediate render
}

function addCrrGroup(label, lat, lon) {
    if (crrGroups.has(label)) {
        return { feedback: [{ type: 'err', text: `GROUP ${label} EXISTS` }] };
    }
    crrGroups.set(label, { lat, lon, aircraft: [] });
    updateCrrMenuBody();
    return { feedback: [
        { type: 'ok', text: 'ACCEPT' },
        { type: 'info', text: `CRR GROUP ${label}` }
    ]};
}

function addAircraftToCrrGroup(label, flids) {
    const group = crrGroups.get(label);
    if (!group) {
        return { feedback: [{ type: 'err', text: `GROUP ${label} NOT FOUND` }] };
    }

    for (const flid of flids) {
        const flight = findFlight(flid);
        if (!flight || !flight.latitude || !flight.longitude) {
            return { feedback: [{ type: 'err', text: `${flid} NOT FOUND OR NO POS` }] };
        }

        const distance = calculateNmDistance(group.lat, group.lon, flight.latitude, flight.longitude);
        const existing = group.aircraft.find(a => a.gufi === flight.gufi);
        if (!existing) {
            group.aircraft.push({
                gufi: flight.gufi,
                callsign: flight.callsign,
                cid: getCid(flight),
                distance: distance
            });
            // Invalidate marker to update RDB visibility
            invalidateMarker(flight.gufi);
        }
    }

    updateCrrMenuBody();
    lastRenderTime = 0;  // Force immediate render
    return { feedback: [
        { type: 'ok', text: 'ACCEPT' },
        { type: 'info', text: `CRR AC ADDED` }
    ]};
}

function calculateNmDistance(lat1, lon1, lat2, lon2) {
    const R = 3440.065;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
}

function getCrrRdbDistance(f) {
    // Find the closest CRR group this aircraft is in, return distance
    let minDistance = null;
    for (const [label, group] of crrGroups) {
        for (const ac of group.aircraft) {
            if (ac.gufi === f.gufi) {
                const distance = calculateNmDistance(group.lat, group.lon, f.latitude, f.longitude);
                if (minDistance === null || distance < minDistance) {
                    minDistance = distance;
                }
            }
        }
    }
    return minDistance;
}

// Update distances for all CRR groups
function updateCrrDistances() {
    for (const [label, group] of crrGroups) {
        for (const ac of group.aircraft) {
            const flight = flights.get(ac.gufi);
            if (flight && flight.latitude && flight.longitude) {
                ac.distance = calculateNmDistance(group.lat, group.lon, flight.latitude, flight.longitude);
            }
        }
    }
    if (crrMenuOpen) updateCrrMenuBody();
}

// .FIND overlay state
let findMarker = null;   // { ident, lat, lon, time } — active find highlight
let findTimer = null;    // auto-clear timeout
let findBlinkRaf = null; // setTimeout ID for blink redraw

function setFindMarker(ident, lat, lon) {
    clearFindMarker();
    findMarker = { ident, lat, lon, time: performance.now() };
    // Auto-clear after 30 seconds
    findTimer = setTimeout(clearFindMarker, 30000);
    // Start blink redraw — every 500ms to match blink rate
    (function blinkLoop() {
        if (!findMarker) return;
        drawOverlay();
        findBlinkRaf = setTimeout(blinkLoop, 500);
    })();
}

function clearFindMarker() {
    findMarker = null;
    if (findTimer) { clearTimeout(findTimer); findTimer = null; }
    if (findBlinkRaf) { clearTimeout(findBlinkRaf); findBlinkRaf = null; }
    drawOverlay();
}

// Global flash reference — updated once per 500ms tick so ALL tracks see the same phase
let flashTime = performance.now();

// Dedup: when a facility is selected, only show one GUFI per callsign (prefer our facility)
const bestGufiByCallsign = new Map();  // callsign → gufi — rebuilt each render cycle
// callsign → merged {facility: cid} across all that callsign's GUFIs. Lets getCid() show the
// selected ARTCC's CID even when the displayed GUFI isn't the one carrying it — e.g. after an
// inter-ARTCC handoff the old centre's CID lives on the old GUFI, but we still want to show it
// when viewing from that centre. Rebuilt each render cycle (only when a facility is selected).
const cidUnionByCallsign = new Map();
function isDedupHidden(gufi, f) {
    return myFacility && f.callsign && bestGufiByCallsign.get(f.callsign) !== gufi;
}

// Facility handoff codes — loaded from handoff-codes.json
// Structure: { default: { FAC: code }, ZDC: { PCT: code }, ... }
let handoffCodesConfig = { default: {} };

async function loadHandoffCodes() {
    try {
        const resp = await fetch('/handoff-codes.json');
        if (!resp.ok) return;
        handoffCodesConfig = await resp.json();
        console.log('[HO-Codes] Loaded', Object.keys(handoffCodesConfig.default).length, 'default codes');
    } catch (e) { console.warn('[HO-Codes]', e); }
}
loadHandoffCodes();

// Look up handoff code for a facility, respecting per-scope overrides
function getHandoffCode(facility) {
    // Per-scope override first (e.g. ZDC scope sees PCT as "E")
    if (myFacility && handoffCodesConfig[myFacility]) {
        const code = handoffCodesConfig[myFacility][facility];
        if (code) return code;
    }
    // Default codes
    const code = handoffCodesConfig.default?.[facility];
    if (code) return code;
    // Fallback: first character of facility ID
    return facility.charAt(0);
}

// Destination airport single-letter codes — loaded from destination-codes.json
// Structure: { ZDC: { A: ["ATL"], B: ["BWI"], ... }, ... }
// Reverse lookup: destCodeLookup[facility][airport] = letter
let destCodesConfig = {};
const destCodeLookup = {};  // facility → { airport → letter }

async function loadDestinationCodes() {
    try {
        const resp = await fetch('/destination-codes.json');
        if (!resp.ok) return;
        destCodesConfig = await resp.json();
        // Build reverse lookup: airport → letter for each facility
        for (const [fac, letters] of Object.entries(destCodesConfig)) {
            destCodeLookup[fac] = {};
            for (const [letter, airports] of Object.entries(letters)) {
                for (const apt of airports) {
                    destCodeLookup[fac][apt] = letter;
                }
            }
        }
        const facCount = Object.keys(destCodesConfig).length;
        console.log('[DestCodes] Loaded destination codes for', facCount, 'facilities');
    } catch (e) { console.warn('[DestCodes]', e); }
}
loadDestinationCodes();

// Look up single-letter destination code for an airport, using selected facility's config
function getDestinationLetter(dest) {
    if (!dest || !myFacility) return '';
    const lookup = destCodeLookup[myFacility];
    if (!lookup) return '';
    // Try as-is (FAA LID), then with K prefix stripped (ICAO→LID)
    return lookup[dest] || lookup[dest.replace(/^K/, '')] || '';
}

// ════════════════════════════════════════════════════════════════════════════
// Map setup
// ════════════════════════════════════════════════════════════════════════════
const map = L.map('map', {
    center: [39.0, -98.0],
    zoom: 6,
    dragging: false,       // disable left-click drag — we use right-click pan
    doubleClickZoom: false, // disable double-click zoom
    zoomControl: false,
    keyboard: false,       // disable numpad/+/- zoom — conflicts with MCA input
    attributionControl: false,
    zoomSnap: 0.1,        // granular zoom (0.1 steps)
    zoomDelta: 0.1,       // each scroll/click zooms by 0.1
    wheelPxPerZoomLevel: 200,  // smooth scroll zoom
});

const tileLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
    subdomains: 'abcd', maxZoom: 19, opacity: 0.4
});

map.createPane('nexrad');
map.getPane('nexrad').style.zIndex = 250;
map.getPane('nexrad').style.pointerEvents = 'none';

map.createPane('routes');
map.getPane('routes').style.zIndex = 420;

map.createPane('targets');
map.getPane('targets').style.zIndex = 450;

const markers = new Map();

// QU route display: gufi → { polyline, destMarker, time, minutes }
// polyline = Leaflet L.polyline, destMarker = L.marker for destination X
// time = performance.now() when added (auto-remove after 30s for QU commands, null = persistent)
// minutes = display length in minutes (null = full route)
const activeRoutes = new Map();

// ════════════════════════════════════════════════════════════════════════════
// Canvas overlay for history dots + velocity vectors
// ════════════════════════════════════════════════════════════════════════════
const overlayCanvas = document.createElement('canvas');
overlayCanvas.style.position = 'absolute';
overlayCanvas.style.pointerEvents = 'none';
overlayCanvas.style.zIndex = '440';
map.getPane('overlayPane').appendChild(overlayCanvas);

// Draw a symbol as canvas geometry at (cx, cy) — same shapes as the HTML target symbols
const SYM_LINE_LEN = 14;   // length of \ and / lines (px)
const SYM_LINE_W = 2;      // stroke width
const SYM_DOT_R = 2.5;     // dot radius for • symbol
function drawSymbolGeometry(ctx, sym, cx, cy, color) {
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = SYM_LINE_W;
    const half = SYM_LINE_LEN / 2;
    if (sym === '\\') {
        // Backslash: top-left to bottom-right
        ctx.beginPath();
        ctx.moveTo(cx - half * 0.707, cy - half * 0.707);
        ctx.lineTo(cx + half * 0.707, cy + half * 0.707);
        ctx.stroke();
    } else if (sym === '/') {
        // Forward slash: bottom-left to top-right
        ctx.beginPath();
        ctx.moveTo(cx - half * 0.707, cy + half * 0.707);
        ctx.lineTo(cx + half * 0.707, cy - half * 0.707);
        ctx.stroke();
    } else if (sym === '\u2022') {
        // Dot: filled circle
        ctx.beginPath();
        ctx.arc(cx, cy, SYM_DOT_R, 0, 2 * Math.PI);
        ctx.fill();
    } else if (sym === '#') {
        // Coast track: # — 2 horizontal lines + 2 slanted vertical lines (like /)
        const sz = half * 0.85, g = sz * 0.4, slant = sz * 0.2;
        ctx.beginPath();
        ctx.moveTo(cx - sz, cy - g); ctx.lineTo(cx + sz, cy - g);
        ctx.moveTo(cx - sz, cy + g); ctx.lineTo(cx + sz, cy + g);
        ctx.moveTo(cx - g + slant, cy - sz); ctx.lineTo(cx - g - slant, cy + sz);
        ctx.moveTo(cx + g + slant, cy - sz); ctx.lineTo(cx + g - slant, cy + sz);
        ctx.stroke();
    }
    // ◇ (diamond): history doesn't draw diamond overlay, only the current position marker does
}

function drawOverlay() {
    const size = map.getSize();
    if (size.x === 0 || size.y === 0) return;
    const bounds = map.getBounds();
    const topLeft = map.containerPointToLayerPoint([0, 0]);
    overlayCanvas.width = size.x;
    overlayCanvas.height = size.y;
    L.DomUtil.setPosition(overlayCanvas, topLeft);

    const ctx = overlayCanvas.getContext('2d');

    // ── History symbols (dimmer target symbols — drawn as geometry, not font) ──
    if (showHistory) {
        const histNow = performance.now();
        const histCutoff = histNow - (MAX_HISTORY * SCAN_INTERVAL);
        for (const [gufi, hist] of flightHistory) {
            if (hist.length === 0) continue;
            const f = flights.get(gufi);
            if (!f || f.latitude == null) continue;
            if (!isVisible(f)) continue;
            if (isDedupHidden(gufi, f)) continue;
            if (isCidRecycled(gufi, f)) continue;
            if (manuallyHidden.has(gufi)) continue;

            const isFdb = shouldShowFdb(gufi, classifyTrack(f));
            const histAlpha = isFdb ? 0.30 : (ldbBrightness / 100) * 0.30;
            if (histAlpha <= 0) continue;

            // Use PR_HIST_COLOR for paired targets (with callsign), UNP_HIST_COLOR for unpaired, otherwise TRACK_COLOR
            const isPaired = f.callsign ? true : false;
            const isUnpaired = f.squawk && !f.callsign ? true : false;
            const color = isEmergency(f) ? EMRG_COLOR : (isPaired ? PR_HIST_COLOR : (isUnpaired ? UNP_HIST_COLOR : TRACK_COLOR));

            for (let i = 0; i < hist.length; i++) {
                if (hist[i].time && hist[i].time < histCutoff) continue;
                if (!bounds.contains([hist[i].lat, hist[i].lon])) continue;
                const pt = map.latLngToLayerPoint([hist[i].lat, hist[i].lon]);
                const x = pt.x - topLeft.x;
                const y = pt.y - topLeft.y;
                ctx.globalAlpha = histAlpha;
                drawSymbolGeometry(ctx, hist[i].sym || '\\', x, y, color);
            }
        }
    }

    // ── Velocity vectors ──
    if (vectorMinutes > 0) {
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 1.0;
        for (const [gufi, f] of flights) {
            if (f.latitude == null || f.longitude == null) continue;
            if (f.trackVelocityX == null || f.trackVelocityY == null) continue;
            if (!isVisible(f)) continue;
            if (isDedupHidden(gufi, f)) continue;
            if (isCidRecycled(gufi, f)) continue;
            if (manuallyHidden.has(gufi)) continue;
            if (isCoasting(f)) continue;  // no velocity vector for coast tracks
            if (!showFdb || !shouldShowFdb(gufi, classifyTrack(f))) continue;
            const vll = displayPosition(f);
            if (!bounds.contains(vll)) continue;

            const color = isEmergency(f) ? EMRG_COLOR : TRACK_COLOR;

            const dLat = f.trackVelocityY * vectorMinutes / 3600;
            const dLon = f.trackVelocityX * vectorMinutes / (3600 * Math.cos(vll[0] * Math.PI / 180));

            const startPt = map.latLngToLayerPoint(vll);
            const endPt = map.latLngToLayerPoint([vll[0] + dLat, vll[1] + dLon]);

            ctx.strokeStyle = color;
            ctx.beginPath();
            ctx.moveTo(startPt.x - topLeft.x, startPt.y - topLeft.y);
            ctx.lineTo(endPt.x - topLeft.x, endPt.y - topLeft.y);
            ctx.stroke();
        }
    }

    // ── DRI halos (QP command — 5nm standard or 3nm reduced) ──
    if (driActive.size > 0) {
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 1.0;
        for (const [gufi, driType] of driActive) {
            const f = flights.get(gufi);
            if (!f || f.latitude == null || f.longitude == null) continue;
            if (!isVisible(f)) continue;
            if (isDedupHidden(gufi, f)) continue;
            if (manuallyHidden.has(gufi)) continue;
            const dll = displayPosition(f);
            if (!bounds.contains(dll)) continue;

            const radiusNm = driType === 'T' ? 3 : 5;
            const radiusDeg = radiusNm / 60; // 1 NM = 1/60 degree latitude
            const centerPt = map.latLngToLayerPoint(dll);
            const edgePt = map.latLngToLayerPoint([dll[0] + radiusDeg, dll[1]]);
            const radiusPx = Math.abs(centerPt.y - edgePt.y);
            const cx = centerPt.x - topLeft.x;
            const cy = centerPt.y - topLeft.y;
            const color = isEmergency(f) ? EMRG_COLOR : TRACK_COLOR;
            ctx.strokeStyle = color;

            if (driType === 'T') {
                // Reduced DRI: circle with 4 gaps (at N, E, S, W)
                const gapAngle = Math.PI / 12; // 15° gap at each cardinal
                for (let q = 0; q < 4; q++) {
                    const cardinal = -Math.PI / 2 + q * Math.PI / 2; // N, E, S, W
                    ctx.beginPath();
                    ctx.arc(cx, cy, radiusPx, cardinal + gapAngle, cardinal + Math.PI / 2 - gapAngle);
                    ctx.stroke();
                }
            } else {
                // Standard DRI: full circle
                ctx.beginPath();
                ctx.arc(cx, cy, radiusPx, 0, 2 * Math.PI);
                ctx.stroke();
            }
        }
    }

    // ── Airport overlay (NASR) ──
    if (airportOverlayData && nasrBrightness.airports > 0) {
        const aptCol = nasrColor(nasrBrightness.airports);
        ctx.strokeStyle = aptCol;
        ctx.fillStyle = aptCol;
        ctx.lineWidth = 1;
        ctx.font = `${Math.round(fontSize * 0.75)}px 'ERAM', Consolas, monospace`;
        ctx.textBaseline = 'top';
        ctx.textAlign = 'left';
        ctx.globalAlpha = nasrBrightness.airports / 100;

        for (const apt of airportOverlayData) {
            if (!bounds.contains([apt.lat, apt.lon])) continue;
            const pt = map.latLngToLayerPoint([apt.lat, apt.lon]);
            const x = pt.x - topLeft.x;
            const y = pt.y - topLeft.y;

            if (apt.cls === 'B') {
                // Class B: hollow square 7×7
                ctx.strokeRect(x - 3.5, y - 3.5, 7, 7);
            } else if (apt.cls === 'C') {
                // Class C: smaller hollow square 5×5
                ctx.strokeRect(x - 2.5, y - 2.5, 5, 5);
            } else if (apt.cls === 'D') {
                // Class D: small hollow circle r=3
                ctx.beginPath();
                ctx.arc(x, y, 3, 0, Math.PI * 2);
                ctx.stroke();
            } else {
                // Class E/G: L-shape (top + left sides only)
                ctx.beginPath();
                ctx.moveTo(x - 2.5, y + 2.5);
                ctx.lineTo(x - 2.5, y - 2.5);
                ctx.lineTo(x + 2.5, y - 2.5);
                ctx.stroke();
            }

            // ICAO label: top-left of text at symbol center
            ctx.fillText(apt.icao || apt.lid, x, y);
        }
        ctx.globalAlpha = 1;
        ctx.textBaseline = 'alphabetic';
    }

    // ── ILS/LOC/LDA centerlines — dashed lines from threshold, 15 NM ──
    if (centerlineData && nasrBrightness.centerlines > 0) {
        const clCol = nasrColor(nasrBrightness.centerlines);
        ctx.strokeStyle = clCol;
        ctx.lineWidth = 1;
        ctx.globalAlpha = nasrBrightness.centerlines / 100;

        for (const cl of centerlineData) {
            // Quick bounds check: skip if both endpoints off-screen
            const clBounds = L.latLngBounds([cl.lat1, cl.lon1], [cl.lat2, cl.lon2]);
            if (!bounds.intersects(clBounds)) continue;

            const p1 = map.latLngToLayerPoint([cl.lat1, cl.lon1]);
            const p2 = map.latLngToLayerPoint([cl.lat2, cl.lon2]);
            const x1 = p1.x - topLeft.x, y1 = p1.y - topLeft.y;
            const x2 = p2.x - topLeft.x, y2 = p2.y - topLeft.y;

            // Compute 1 NM in pixels (total line = 15 NM)
            const dx = x2 - x1, dy = y2 - y1;
            const totalPx = Math.sqrt(dx * dx + dy * dy);
            const nmPx = totalPx / 15;

            ctx.setLineDash([nmPx, nmPx]);
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
    }

    // ── .FIND highlight — blinking yellow square (full ↔ half bright) ──
    if (findMarker && bounds.contains([findMarker.lat, findMarker.lon])) {
        const blinkPhase = Math.floor(performance.now() / 500) % 2 === 0;
        const pt = map.latLngToLayerPoint([findMarker.lat, findMarker.lon]);
        const x = pt.x - topLeft.x;
        const y = pt.y - topLeft.y;
        const sz = Math.round(fontSize * 0.8);
        ctx.globalAlpha = blinkPhase ? 1.0 : 0.4;
        ctx.strokeStyle = TRACK_COLOR;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x - sz / 2, y - sz - 2, sz, sz);
        // Label below — always full bright
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = TRACK_COLOR;
        ctx.fillText(findMarker.ident, x, y + LINE_H);
    }

    ctx.globalAlpha = 1;
}

// Clear canvas immediately on zoom start to prevent ghost shadows
map.on('zoomstart', () => {
    const ctx = overlayCanvas.getContext('2d');
    ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
});

let _overlayRafPending = false;
map.on('move zoom viewreset resize', () => {
    closePointoutMenu();
    closeFieldMenu();
    if (!_overlayRafPending) {
        _overlayRafPending = true;
        requestAnimationFrame(() => {
            _overlayRafPending = false;
            try { drawOverlay(); } catch(e) { console.error('[Overlay]', e); }
        });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// KML sector boundaries (video maps — grey)
// ════════════════════════════════════════════════════════════════════════════
let kmlSectors = [];
const boundaryLayers = {};        // keyed by 'ARTCC:category'
let activeBoundaryArtcc = '';
const BOUNDARY_CATS = ['Ultra High', 'High Altitude', 'Low Altitude', 'Approach Control'];
const BOUNDARY_CAT_LABELS = { 'Ultra High': 'UHI', 'High Altitude': 'HI', 'Low Altitude': 'LO', 'Approach Control': 'APP' };
const BOUNDARY_CAT_SLIDER = { 'Ultra High': 'rng-bnd-uhi', 'High Altitude': 'rng-bnd-hi', 'Low Altitude': 'rng-bnd-lo', 'Approach Control': 'rng-bnd-app' };
const BOUNDARY_CAT_LABEL = { 'Ultra High': 'lbl-bnd-uhi', 'High Altitude': 'lbl-bnd-hi', 'Low Altitude': 'lbl-bnd-lo', 'Approach Control': 'lbl-bnd-app' };
let boundaryBrightness = { 'Ultra High': 60, 'High Altitude': 60, 'Low Altitude': 60, 'Approach Control': 30 };

function bndColor(brightness) {
    const v = Math.round(brightness * 2.55);
    return `rgb(${v},${v},${v})`;
}

async function loadKml() {
    try {
        const resp = await fetch('/api/kml/AllSectors.kml');
        if (!resp.ok) return;
        const text = await resp.text();
        const parser = new DOMParser();
        const xml = parser.parseFromString(text, 'text/xml');
        const placemarks = xml.querySelectorAll('Placemark');

        for (const pm of placemarks) {
            const name = pm.querySelector('name')?.textContent || '';
            const desc = pm.querySelector('description')?.textContent || '';
            const coordEl = pm.querySelector('coordinates');
            if (!coordEl) continue;

            const descDoc = new DOMParser().parseFromString(desc, 'text/html');
            const tds = descDoc.querySelectorAll('td');
            const data = {};
            for (let i = 0; i < tds.length - 1; i += 2) {
                data[tds[i].textContent.trim()] = tds[i + 1].textContent.trim();
            }

            const folderPath = data['FolderPath'] || '';
            const parts = folderPath.split('/');
            let artcc = parts.length >= 2 ? parts[1] : '';
            let category = '';
            let sectorId = name;

            if (artcc) {
                // Standard format: FolderPath = "xxx/ZDC/High Altitude (17)/sectorId"
                const catRaw = parts.length >= 3 ? parts[2] : '';
                category = catRaw.replace(/\s*\(\d+\)$/, '');
                sectorId = parts.length >= 4 ? parts[3] : name;
            } else {
                // Western ARTCCs: no FolderPath, derive from ancestor Folder names
                // e.g. Folder "ZLA_HIGH_NEW" → artcc=ZLA, category=High Altitude
                let el = pm.parentElement;
                while (el) {
                    const fn = el.tagName === 'Folder' ? (el.querySelector(':scope > name')?.textContent || '') : '';
                    const m = fn.match(/^(Z[A-Z]{2})[_ ]/);
                    if (m) {
                        artcc = m[1];
                        const upper = fn.toUpperCase();
                        if (upper.includes('ULTRA')) category = 'Ultra High';
                        else if (upper.includes('HIGH')) category = 'High Altitude';
                        else if (upper.includes('LOW')) category = 'Low Altitude';
                        else if (upper.includes('APPROACH')) category = 'Approach Control';
                        else category = 'High Altitude';
                        break;
                    }
                    el = el.parentElement;
                }
            }
            if (!artcc) continue;

            const coords = coordEl.textContent.trim().split(/\s+/).map(c => {
                const [lon, lat] = c.split(',');
                return [parseFloat(lat), parseFloat(lon)];
            }).filter(c => !isNaN(c[0]) && !isNaN(c[1]));

            if (coords.length < 2) continue;
            kmlSectors.push({ artcc, name, sectorId, alt: data['ALT'] || '', category, coords });
        }
        const catCounts = {};
        for (const s of kmlSectors) catCounts[s.category] = (catCounts[s.category] || 0) + 1;
        console.log(`[KML] Loaded ${kmlSectors.length} sectors`, catCounts);
        // Clear any boundary layers cached before KML finished (they'd be empty)
        for (const key in boundaryLayers) {
            if (boundaryLayers[key]) map.removeLayer(boundaryLayers[key]);
            delete boundaryLayers[key];
        }
        if (myFacility) showBoundariesForFacility(myFacility);
    } catch (e) { console.warn('[KML]', e); }
}

function showBoundariesForFacility(artcc) {
    // Remove all layers for the previous ARTCC
    if (activeBoundaryArtcc) {
        for (const cat of BOUNDARY_CATS) {
            const key = `${activeBoundaryArtcc}:${cat}`;
            if (boundaryLayers[key]) map.removeLayer(boundaryLayers[key]);
        }
    }
    activeBoundaryArtcc = artcc;
    if (!artcc) return;

    for (const cat of BOUNDARY_CATS) {
        const br = boundaryBrightness[cat];
        if (br <= 0) continue;
        const key = `${artcc}:${cat}`;
        if (!boundaryLayers[key]) {
            const group = L.layerGroup();
            const dash = cat === 'Approach Control' ? '8 4' : '16 8';
            for (const sec of kmlSectors.filter(s => s.artcc === artcc && s.category === cat)) {
                L.polyline(sec.coords, { color: bndColor(br), weight: 1, opacity: 1, dashArray: dash, interactive: false, className: 'bnd-path' }).addTo(group);
            }
            boundaryLayers[key] = group;
        }
        boundaryLayers[key].addTo(map);
    }
}

function setBoundaryBrightness(cat, brightness) {
    boundaryBrightness[cat] = brightness;
    if (!activeBoundaryArtcc) return;
    const key = `${activeBoundaryArtcc}:${cat}`;
    if (brightness <= 0) {
        if (boundaryLayers[key]) map.removeLayer(boundaryLayers[key]);
        return;
    }
    const col = bndColor(brightness);
    if (!boundaryLayers[key]) {
        const group = L.layerGroup();
        const dash = cat === 'Approach Control' ? '8 4' : '16 8';
        for (const sec of kmlSectors.filter(s => s.artcc === activeBoundaryArtcc && s.category === cat)) {
            L.polyline(sec.coords, { color: col, weight: 1, opacity: 1, dashArray: dash, interactive: false, className: 'bnd-path' }).addTo(group);
        }
        boundaryLayers[key] = group;
        boundaryLayers[key].addTo(map);
    } else {
        // Update color on existing polylines
        boundaryLayers[key].eachLayer(l => l.setStyle({ color: col }));
        if (!map.hasLayer(boundaryLayers[key])) boundaryLayers[key].addTo(map);
    }
}

function zoomToFacility(artcc) {
    if (!artcc || kmlSectors.length === 0) return;
    const sectors = kmlSectors.filter(s => s.artcc === artcc);
    if (sectors.length === 0) return;
    let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
    for (const sec of sectors) {
        for (const [lat, lon] of sec.coords) {
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
            if (lon < minLon) minLon = lon;
            if (lon > maxLon) maxLon = lon;
        }
    }
    map.fitBounds([[minLat, minLon], [maxLat, maxLon]], { padding: [20, 20] });
}

loadKml();

// ════════════════════════════════════════════════════════════════════════════
// NASR overlay layers (airways, VORs, SID/STARs)
// ════════════════════════════════════════════════════════════════════════════
const nasrLayers = {};    // 'jroutes'|'vroutes'|'vors'|'proc:DCA' → L.layerGroup
const nasrCache = {};     // same keys → raw API data (cache across toggles)
const nasrBrightness = { jroutes: 0, vroutes: 0, vors: 15, airports: 0, centerlines: 0, proc: 0 };
let airportOverlayData = null; // cached from /api/nasr/airports
let centerlineData = null;     // cached from /api/nasr/centerlines

const nasrLoading = {};   // guard against double-click during async fetch
function nasrColor(brightness) { return bndColor(brightness); }  // same grey ramp as boundaries

async function showNasrLayer(layerKey, url, renderer) {
    const br = nasrBrightness[layerKey];
    if (br <= 0) {
        if (nasrLayers[layerKey]) { map.removeLayer(nasrLayers[layerKey]); delete nasrLayers[layerKey]; }
        return;
    }
    // Already showing — just update color
    if (nasrLayers[layerKey]) {
        const col = nasrColor(br);
        nasrLayers[layerKey].eachLayer(l => l.setStyle({ color: col }));
        return;
    }
    if (nasrLoading[layerKey]) return;
    // Fetch data (cached)
    if (!nasrCache[layerKey]) {
        nasrLoading[layerKey] = true;
        try {
            const resp = await fetch(url);
            if (!resp.ok) { console.warn(`[NASR] ${layerKey}: ${resp.status}`); delete nasrLoading[layerKey]; return; }
            nasrCache[layerKey] = await resp.json();
        } catch (e) { console.warn(`[NASR] ${layerKey}:`, e); delete nasrLoading[layerKey]; return; }
        delete nasrLoading[layerKey];
    }
    // Re-check brightness after async fetch (slider may have changed to 0)
    const finalBr = nasrBrightness[layerKey];
    if (finalBr <= 0) return;
    const group = L.layerGroup();
    renderer(nasrCache[layerKey], group, finalBr);
    nasrLayers[layerKey] = group;
    group.addTo(map);
}

function renderAirways(data, group, br) {
    const col = nasrColor(br);
    for (const awy of data) {
        if (awy.points.length < 2) continue;
        L.polyline(awy.points, { color: col, weight: 1, opacity: 1, interactive: false, className: 'bnd-path' }).addTo(group);
    }
}

function renderVors(data, group, br) {
    const col = nasrColor(br);
    for (const vor of data) {
        L.circleMarker([vor.lat, vor.lon], {
            radius: 4, color: col, weight: 1, opacity: 1, fill: false, interactive: false, className: 'bnd-path'
        }).addTo(group);
    }
}

function setupNasrSlider(sliderId, labelId, layerKey, url, renderer) {
    document.getElementById(sliderId).addEventListener('input', function () {
        nasrBrightness[layerKey] = parseInt(this.value);
        document.getElementById(labelId).textContent = nasrBrightness[layerKey];
        showNasrLayer(layerKey, url, renderer);
        saveSettingsToLocalStorage();
    });
}
setupNasrSlider('rng-jroutes', 'lbl-jroutes', 'jroutes', '/api/nasr/airways?type=hi', renderAirways);
setupNasrSlider('rng-vroutes', 'lbl-vroutes', 'vroutes', '/api/nasr/airways?type=lo', renderAirways);
setupNasrSlider('rng-vors', 'lbl-vors', 'vors', '/api/nasr/navaids', renderVors);

// Airport overlay — drawn on canvas in drawOverlay()
document.getElementById('rng-airports').addEventListener('input', async function () {
    nasrBrightness.airports = parseInt(this.value);
    document.getElementById('lbl-airports').textContent = nasrBrightness.airports;
    if (nasrBrightness.airports > 0 && !airportOverlayData) {
        try {
            const resp = await fetch('/api/nasr/airports');
            if (resp.ok) airportOverlayData = await resp.json();
        } catch (e) { console.warn('[NASR] airports:', e); }
    }
    drawOverlay();
    saveSettingsToLocalStorage();
});

document.getElementById('rng-centerlines').addEventListener('input', async function () {
    nasrBrightness.centerlines = parseInt(this.value);
    document.getElementById('lbl-centerlines').textContent = nasrBrightness.centerlines;
    if (nasrBrightness.centerlines > 0 && !centerlineData) {
        try {
            const resp = await fetch('/api/nasr/centerlines');
            if (resp.ok) centerlineData = await resp.json();
        } catch (e) { console.warn('[NASR] centerlines:', e); }
    }
    drawOverlay();
    saveSettingsToLocalStorage();
});

// Procedure overlay — managed via .SID/.STAR/.PROC MCA commands
// activeProcedures: Map<string, { layer: L.layerGroup, procs: Array, query: string }>
const activeProcedures = new Map();

function renderProcedureLegs(data, group, br) {
    const col = nasrColor(br);
    for (const proc of data) {
        for (const leg of proc.legs) {
            if (leg.length >= 2) {
                L.polyline(leg, { color: col, weight: 1, opacity: 1, dashArray: '6 4', interactive: false, className: 'bnd-path' }).addTo(group);
            }
        }
    }
}

document.getElementById('rng-proc').addEventListener('input', function () {
    nasrBrightness.proc = parseInt(this.value);
    document.getElementById('lbl-proc').textContent = nasrBrightness.proc;
    const col = nasrColor(nasrBrightness.proc);
    for (const [key, entry] of activeProcedures) {
        if (nasrBrightness.proc <= 0) {
            if (map.hasLayer(entry.layer)) map.removeLayer(entry.layer);
        } else {
            if (!map.hasLayer(entry.layer)) entry.layer.addTo(map);
            entry.layer.eachLayer(l => l.setStyle({ color: col }));
        }
    }
    saveSettingsToLocalStorage();
});

function clearProcOverlay() {
    for (const [key, entry] of activeProcedures) {
        if (map.hasLayer(entry.layer)) map.removeLayer(entry.layer);
    }
    activeProcedures.clear();
}

// ════════════════════════════════════════════════════════════════════════════
// MRMS weather radar overlay — ERAM-style pixel rendering
// Source: NOAA nowCOAST WMS (MRMS base reflectivity composite)
// https://nowcoast.noaa.gov/geoserver/observations/weather_radar/ows
// Updates every ~4 minutes, CORS-enabled, transparent PNG tiles
// NWS standard radar colors → parsed on canvas → remapped to ERAM categories:
//   Moderate (20-40 dBZ, NWS greens/yellows) → solid blue #0044ff
//   Heavy (40-55 dBZ, NWS oranges/reds) → checkered cyan #00ccff / black
//   Extreme (55+ dBZ, NWS dark reds/magentas) → solid cyan #00ccff
// ════════════════════════════════════════════════════════════════════════════
let nexradLayer = null;
let nexradLevel = 3;           // 0=OFF, 1=extreme(3), 2=heavy+extreme(23), 3=all(123)
let nexradBrightness = 30;
const MRMS_WMS_URL = 'https://nowcoast.noaa.gov/geoserver/observations/weather_radar/ows';

// Classify NWS radar pixel to ERAM NEXRAD level (0=none, 1=moderate, 2=heavy, 3=extreme)
// MRMS reflectivity palette: blue/cyan (5-20 dBZ) → green (20-35) → yellow (35-45) → orange (45-50) → red (50-65) → magenta (65+)
// Blue/cyan = moderate (1), green = heavy (2), yellow+ = extreme (3)
function classifyNwsPixel(r, g, b, a) {
    if (a < 128) return 0;                              // filter anti-aliased edges
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    if (max < 30) return 0;
    const delta = max - min;
    if (delta < 15) return 0;                            // filter greys/unsaturated
    // Yellow/orange/red/magenta: R is significant and B is low → extreme (35+ dBZ)
    if (r > 80 && b < r * 0.5 && b < g * 0.5) return 3;
    // Blue/cyan dominant: moderate (5-20 dBZ)
    if (b > r && b >= g) return 1;
    // Green dominant: heavy (20-35 dBZ)
    if (g > r && g > b) return 2;
    // Fallback: extreme
    return 3;
}

const MrmsEramLayer = L.GridLayer.extend({
    createTile: function (coords, done) {
        const tile = document.createElement('canvas');
        tile.width = tile.height = 256;
        const ctx = tile.getContext('2d');
        const level = this.options.nxLevel || 3;
        // Build WMS GetMap URL
        const bounds = this._tileCoordsToBounds(coords);
        const sw = bounds.getSouthWest(), ne = bounds.getNorthEast();
        const bbox = `${sw.lng},${sw.lat},${ne.lng},${ne.lat}`;
        const url = `${MRMS_WMS_URL}?service=WMS&version=1.1.1&request=GetMap` +
            `&layers=conus_base_reflectivity_mosaic&srs=EPSG:4326` +
            `&bbox=${bbox}&width=256&height=256&format=image/png&transparent=true`;
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            ctx.drawImage(img, 0, 0, 256, 256);
            // Remap NWS colors to ERAM categories
            const imageData = ctx.getImageData(0, 0, 256, 256);
            const d = imageData.data;
            for (let i = 0; i < d.length; i += 4) {
                const cat = classifyNwsPixel(d[i], d[i + 1], d[i + 2], d[i + 3]);
                if (cat === 0) { d[i + 3] = 0; continue; }
                // NX LVL filtering: 1=extreme only, 2=heavy+extreme, 3=all
                if (level === 1 && cat < 3) { d[i + 3] = 0; continue; }
                if (level === 2 && cat < 2) { d[i + 3] = 0; continue; }
                const px = i / 4;
                const tx = px % 256, ty = Math.floor(px / 256);
                if (cat === 1) {
                    // Moderate: solid blue (#0044ff)
                    d[i] = 0; d[i + 1] = 68; d[i + 2] = 255;
                } else if (cat === 2) {
                    // Heavy: checkered cyan (#00ccff) and black
                    if ((Math.floor(tx / 4) + Math.floor(ty / 4)) % 2 === 0) {
                        d[i] = 0; d[i + 1] = 204; d[i + 2] = 255;
                    } else {
                        d[i] = 0; d[i + 1] = 0; d[i + 2] = 0;
                    }
                } else {
                    // Extreme: solid cyan (#00ccff)
                    d[i] = 0; d[i + 1] = 204; d[i + 2] = 255;
                }
                d[i + 3] = 255;
            }
            ctx.putImageData(imageData, 0, 0);
            done(null, tile);
        };
        img.onerror = () => done(null, tile);  // blank tile on error
        img.src = url;
        return tile;
    }
});

function createNexradLayer() {
    return new MrmsEramLayer({
        pane: 'nexrad',
        opacity: nexradBrightness / 100,
        maxZoom: 16,
        tileSize: 256,
        nxLevel: nexradLevel,
    });
}

function updateNexrad() {
    if (nexradLayer) { map.removeLayer(nexradLayer); nexradLayer = null; }
    if (nexradLevel === 0) return;
    nexradLayer = createNexradLayer();
    nexradLayer.addTo(map);
}

// Auto-refresh every 5 minutes (nowCOAST updates every ~4 min)
if (nexradLevel > 0) updateNexrad();
setInterval(() => {
    if (!nexradLayer) return;
    // Double-buffer: add new layer on top, remove old after new tiles finish loading
    const oldLayer = nexradLayer;
    const newLayer = createNexradLayer();
    nexradLayer = newLayer;
    newLayer.addTo(map);
    newLayer.once('load', () => { if (map.hasLayer(oldLayer)) map.removeLayer(oldLayer); });
    // Safety: remove old layer after 15s even if load event doesn't fire
    setTimeout(() => { if (map.hasLayer(oldLayer)) map.removeLayer(oldLayer); }, 15000);
}, 5 * 60 * 1000);

document.getElementById('sel-nxlvl').addEventListener('change', function () {
    const v = this.value;
    nexradLevel = v === '123' ? 3 : v === '23' ? 2 : v === '3' ? 1 : 0;
    updateNexrad();
    saveSettingsToLocalStorage();
});

document.getElementById('rng-nx').addEventListener('input', function () {
    nexradBrightness = parseInt(this.value);
    document.getElementById('lbl-nx').textContent = nexradBrightness;
    if (nexradLayer) nexradLayer.setOpacity(nexradBrightness / 100);
    saveSettingsToLocalStorage();
});

// ════════════════════════════════════════════════════════════════════════════
// Visibility & classification
// ════════════════════════════════════════════════════════════════════════════
function isEmergency(f) {
    return f.squawk === '7700' || f.squawk === '7600' || f.squawk === '7500';
}

// Seconds since the CLIENT last received an update for this track.
function clientAgeSec(f) {
    return f._clientLastUpdate != null ? (performance.now() - f._clientLastUpdate) / 1000 : 0;
}
// Effective track age. The server stops sending a GUFI's batches once another facility
// takes over (inter-ARTCC handoff), which FREEZES its server-side posAge at a small value
// — so a stale duplicate would otherwise look "fresh" forever, lingering as a frozen ghost
// and winning the callsign dedup over the live track (causing the disappear/reappear flicker).
// Taking the max with client-receipt age lets these ghosts age out and release the live track.
function effAgeSec(f) {
    return Math.max(f.posAge != null ? f.posAge : 0, clientAgeSec(f));
}

function isVisible(f) {
    if (f.latitude == null || f.longitude == null) return false;
    // Allow DROPPED flights briefly — 1 minute grace for handoff transitions where
    // old center drops the track but new center hasn't sent position yet.
    // Uses server-side posAge (seconds since last position) — immune to snapshot resets.
    if (f.flightStatus === 'CANCELLED') return false;
    if (f.flightStatus === 'DROPPED' && (f.posAge == null || f.posAge > 60)) return false;
    if (f.flightStatus && f.flightStatus !== 'ACTIVE' && f.flightStatus !== 'DROPPED') return false;
    // Hide stale ACTIVE flights — no position update for >5 min means track is lost
    // (SFDPS can have gaps during inter-facility handoff transitions). Uses effective age
    // so a GUFI the server stopped sending (handed off to another ARTCC) ages out too.
    if (f.flightStatus === 'ACTIVE' && effAgeSec(f) > 300 && !f.handoffEvent) return false;

    // Altitude filter (reported altitude in feet → FL in hundreds)
    // Exempt: FDB tracks, and any track the user explicitly toggled (fdbOverrides entry)
    if (altFilterLow > 0 || altFilterHigh < 999) {
        const cls = classifyTrack(f);
        if (!shouldShowFdb(f.gufi, cls) && !fdbOverrides.has(f.gufi)) {
            const alt = f.reportedAltitude;
            if (alt != null) {
                const fl = Math.round(alt / 100);
                if (fl < altFilterLow || fl > altFilterHigh) return false;
            }
        }
    }

    // No facility selected → show all
    if (!myFacility) return true;
    // Show if controlling/reporting facility matches
    // In facilityOnly mode, only controllingFacility counts — reportingFacility alternates
    // between centers on each SFDPS update, causing flicker if used for strict filtering
    const fac = f.controllingFacility || '';
    const rptFac = f.reportingFacility || '';
    if (fac === myFacility || (!facilityOnly && rptFac === myFacility)) return true;
    // Show if handoff involves our facility
    if (f.handoffReceiving && extractFac(f.handoffReceiving) === myFacility) return true;
    if (f.handoffTransferring && extractFac(f.handoffTransferring) === myFacility) return true;
    // "Facility only" — strict mode: only show aircraft reported by our facility (above checks)
    if (facilityOnly) return false;
    // Keep flights visible that were previously own/ho (prevents disappearing during handoff transitions)
    if (wasOwnOrHo.has(f.gufi)) return true;
    // Keep flights visible that have a recent completed handoff involving us
    if (hoCompletedInfo.has(f.gufi)) return true;
    // Grace period: keep recently-visible flights for 300s to prevent flicker on facility field changes
    const lastVis = lastVisibleAt.get(f.gufi);
    if (lastVis && performance.now() - lastVis < 300000) return true;
    return false;
}

function classifyTrack(f) {
    if (isEmergency(f)) return 'emrg';
    if (!myFacility) return 'other';
    // Sectors must be selected to have own/ho tracks — prevents entire ARTCC from being FDB
    if (mySectors.size === 0) return 'other';

    const fac = f.controllingFacility || f.reportingFacility || '';
    const sec = f.controllingSector || '';
    const hoEvt = hoEventType(f.handoffEvent);

    // Active handoff involving our sector(s)
    if (hoEvt) {
        const recvFac = extractFac(f.handoffReceiving);
        const xferFac = extractFac(f.handoffTransferring);
        const recvSec = extractSec(f.handoffReceiving);
        const xferSec = extractSec(f.handoffTransferring);
        const recvIsMe = recvFac === myFacility && mySectors.has(recvSec);
        const xferIsMe = xferFac === myFacility && mySectors.has(xferSec);
        if (recvIsMe || xferIsMe) return 'ho';
    }

    if (fac === myFacility && mySectors.has(sec)) return 'own';
    return 'other';
}

function extractFac(unitStr) { return unitStr ? unitStr.split('/')[0] : ''; }
function extractSec(unitStr) { if (!unitStr) return ''; const p = unitStr.split('/'); return p.length > 1 ? p[1] : ''; }

// Get CID for the observed facility (each ARTCC assigns its own CID to a flight)
function getCid(f) {
    // Each ARTCC assigns its own CID — only show the selected facility's CID.
    // Never show a foreign facility's CID (controllers only see their own).
    let cid;
    if (myFacility) {
        cid = (f.computerIds && f.computerIds[myFacility]) || '';
        // Fallback: the displayed GUFI may not carry this facility's CID (it lives on a sibling
        // GUFI of the same callsign after a handoff) — pull it from the per-callsign union.
        if (!cid && f.callsign) cid = cidUnionByCallsign.get(f.callsign)?.[myFacility] || '';
    } else {
        // No facility selected ("All") — show most recent CID from any facility
        cid = f.computerId || '';
    }
    // ERAM CIDs are 3 characters — SFDPS sometimes sends 4-digit with leading zero
    if (cid.length > 3) cid = cid.replace(/^0+/, '').padStart(3, '0');
    return cid;
}

// Handoff event classification — SFDPS sends INITIATION/ACCEPTANCE/UPDATE/EXECUTION
function hoEventType(evt) {
    if (!evt) return '';
    const e = evt.toUpperCase();
    if (e === 'INITIATION' || e.startsWith('PROPOS')) return 'PROPOSED';
    if (e === 'ACCEPTANCE' || e.startsWith('ACCEPT')) return 'ACCEPTED';
    if (e === 'UPDATE') return 'PROPOSED';  // UPDATE during active handoff — treat as proposed
    if (e.startsWith('EXECUT')) return 'EXECUTING';
    return '';  // CANCELLATION, COMPLETED, etc. — not active
}

// ════════════════════════════════════════════════════════════════════════════
// ERAM Full Data Block formatting
// ════════════════════════════════════════════════════════════════════════════
//
// Line 0: P/A (point out) — above data block
// Column 0: R (not your control) — left of data block, bulges out
// Line 1: Field A (callsign) + SatComm (*)
// Line 2: Field B (assigned alt) + status char + Field C (reported alt)
// Line 3: Field D (CID) + Field E (GS/Hxxx/Oxxx/EMRG)
// Line 4: Field F (destination ICAO)
//
// Status chars: C=conforming(hide Field C), T=interim, L=local interim,
//   P=procedure, ↑=climbing, ↓=descending, +=above, -=below,
//   X=no Mode C, N=no target, B=block alt, /=VFR

const LDR_DX = 20;
const LDR_DY = 0;   // flat horizontal leader line (ERAM default position 5 = right)
const LDR_LEN = 40; // leader line length
let CHAR_W = fontSize * 0.625;  // approx char width in ERAM font
let LINE_H = fontSize * 1.25;   // line-height

// Data block position offsets (numpad layout):
//   Standard (789 top):  7=NW 8=N  9=NE / 4=W 5=def 6=E / 1=SW 2=S 3=SE
//   Inverted (123 top):  1=NW 2=N  3=NE / 4=W 5=def 6=E / 7=SW 8=S 9=SE
const NUMPAD_INVERT = { 1: 7, 2: 8, 3: 9, 7: 1, 8: 2, 9: 3 };
function numpadPos(n) {
    // When "Std numpad (789 top)" is checked, standard layout — no remap.
    // When unchecked (inverted, 123 top), swap top/bottom rows.
    const inverted = !document.getElementById('numpad-inverted')?.checked;
    return inverted ? (NUMPAD_INVERT[n] ?? n) : n;
}
function getLeaderOffset(gufi) {
    const pos = dbPositions.get(gufi);
    const level = ldrLenOverrides.get(gufi) ?? 1;
    const len = level * LDR_LEN;
    if (len === 0) return { dx: 0, dy: 0 };
    const D = len * 0.707; // diagonal distance
    if (!pos || pos === 9) return { dx: D, dy: -D };             // NE (default)
    switch (pos) {
        case 1: return { dx: -D, dy: D };      // SW
        case 2: return { dx: 0, dy: len };      // S
        case 3: return { dx: D, dy: D };        // SE
        case 4: return { dx: -len, dy: 0 };     // W
        case 5:
        case 6: return { dx: len, dy: 0 };      // E
        case 7: return { dx: -D, dy: -D };      // NW
        case 8: return { dx: 0, dy: -len };     // N
        case 9: return { dx: D, dy: -D };       // NE
        default: return { dx: D, dy: -D };     // NE (default)
    }
}

// Position data block so the leader line endpoint aligns with the correct edge/line.
// FDB anchor varies by direction:
//   N:  left edge, between lines 3-4    NE: left edge, between lines 2-3
//   E:  left edge, between lines 2-3    SE: left edge, between lines 1-2
//   S:  left edge, between lines 1-2    SW: right edge, between lines 1-2
//   W:  right edge, between lines 2-3   NW: right edge, between lines 2-3
// xShift: 0 = left-aligned (text extends right), -1 = right-aligned (text extends left)
function getDbAnchor(gufi, numLines) {
    const pos = dbPositions.get(gufi) || 9;
    const isLeft = (pos === 1 || pos === 4 || pos === 7);

    if (numLines === 2) {
        // LDB: anchor between lines 1-2 for all directions
        return { xShift: isLeft ? -1 : 0, yShift: -LINE_H };
    }

    // FDB (4 lines): direction-specific anchor
    switch (pos) {
        case 8: return { xShift: 0,  yShift: -3 * LINE_H };  // N:  left edge, between 3-4
        case 9: return { xShift: 0,  yShift: -2 * LINE_H };  // NE: left edge, between 2-3
        case 5:
        case 6: return { xShift: 0,  yShift: -2 * LINE_H };  // E:  left edge, between 2-3
        case 3: return { xShift: 0,  yShift: -LINE_H };       // SE: left edge, between 1-2
        case 2: return { xShift: 0,  yShift: -LINE_H };       // S:  left edge, between 1-2
        case 1: return { xShift: -1, yShift: -LINE_H };       // SW: right edge, between 1-2
        case 4: return { xShift: -1, yShift: -2 * LINE_H };   // W:  right edge, between 2-3
        case 7: return { xShift: -1, yShift: -2 * LINE_H };   // NW: right edge, between 2-3
        default: return { xShift: 0, yShift: -2 * LINE_H };
    }
}

// Check if flight is in reduced separation area (at or below FL230)
function isReducedSep(f) {
    const alt = f.reportedAltitude ?? f.assignedAltitude;
    return alt != null && alt <= 23000;
}

function isCoasting(f) {
    // Primary: ERAM-authoritative coast indicator (from SFDPS position @coastIndicator attribute)
    if (f.CoastIndicator) return true;
    // Fallback: time-based heuristic — no position update for >26s (2 SFDPS cycles + 1s batch + jitter)
    if (f.posAge != null && f.flightStatus === 'ACTIVE' && f.posAge > 26) return true;
    return false;
}

// Compute display position: extrapolate using track velocity when position is stale (>12s).
// Uses ERAM-predicted target position as the 12s extrapolation point, then continues with
// velocity vector beyond that. Returns [lat, lon] for marker placement.
function displayPosition(f) {
    const age = f.posAge ?? 0;
    // Fresh position or no velocity — use actual
    if (age <= 12 || f.trackVelocityX == null || f.trackVelocityY == null)
        return [f.latitude, f.longitude];
    // Coasting (ERAM-confirmed or >26s) — freeze at last known position
    if (isCoasting(f)) return [f.latitude, f.longitude];
    // Stale (12-26s): extrapolate using velocity vector
    const dt = age / 3600;  // hours
    const dLat = f.trackVelocityY * dt / 60;  // knots → degrees lat (1° ≈ 60nm)
    const dLon = f.trackVelocityX * dt / (60 * Math.cos(f.latitude * Math.PI / 180));
    return [f.latitude + dLat, f.longitude + dLon];
}

// Check if this flight's CID has been recycled to a different, fresher flight.
// Built lazily on first call per render frame, then cached.
const _cidOwnerCache = new Map();  // "facility/cid" → gufi of freshest owner
let _cidCacheFrame = 0;
function _buildCidCache() {
    _cidOwnerCache.clear();
    if (!myFacility) return;
    for (const [gufi, f] of flights) {
        const cid = f.computerIds?.[myFacility];
        if (!cid) continue;
        const prev = _cidOwnerCache.get(cid);
        if (!prev) { _cidOwnerCache.set(cid, gufi); continue; }
        const prevF = flights.get(prev);
        if ((f.posAge ?? 0) < (prevF?.posAge ?? 0)) _cidOwnerCache.set(cid, gufi);
    }
}
function isCidRecycled(gufi, f) {
    if (!myFacility) return false;
    const cid = f.computerIds?.[myFacility];
    if (!cid) return false;
    // Rebuild cache once per render frame
    if (_cidCacheFrame !== renderFrameCount) {
        _cidCacheFrame = renderFrameCount;
        _buildCidCache();
    }
    const owner = _cidOwnerCache.get(cid);
    return owner != null && owner !== gufi;
}

function getSymbolClass(f) {
    // Coast: no position update for >2 scan cycles
    if (isCoasting(f)) return 'ac-sym-coast';
    // Reduced separation: at or below FL230 → dot
    if (f.callsign && isReducedSep(f)) return 'ac-sym-reduced-sep';
    // SFDPS en route flights are virtually all transponder-equipped correlated targets.
    if (f.callsign) return 'ac-sym-corr-bcn';      // \ Correlated Beacon (most common)
    if (f.squawk) return 'ac-sym-uncorr-bcn';       // / Uncorrelated Beacon
    return 'ac-sym-flat-track';                      // ◇ Unknown/no identification
}

// History symbol character per target type (drawn on canvas)
function getSymbolChar(f) {
    // Coast: no position update for >2 scan cycles
    if (isCoasting(f)) return '#';
    // Reduced separation: at or below FL230 → dot
    if (f.callsign && isReducedSep(f)) return '\u2022';  // • dot
    if (f.callsign) return '\\';   // Correlated Beacon (most common)
    if (f.squawk) return '/';      // Uncorrelated Beacon
    return '\u25C7';               // ◇ Unknown
}

// Should column 0 "R" indicator show? (track not under our control)
// R = position does not own the track:
//   - Outgoing ACCEPTED/completed: we gave it away → R
//   - Incoming PROPOSED: offered to us but not yet accepted → R
//   - Incoming ACCEPTED/completed: we accepted, we own it → no R
//   - Outgoing PROPOSED: we initiated but still own it → no R
//   - Other tracks not ours at all → R
function shouldShowR(f, cls) {
    if (!myFacility || mySectors.size === 0) return false;
    if (cls === 'emrg') return false;

    // Controlling sector is authoritative — trust what SFDPS says
    if (cls === 'own') return false;
    const ctrlFac = f.controllingFacility || '';
    const ctrlSec = f.controllingSector || '';
    if (ctrlFac === myFacility && mySectors.has(ctrlSec)) return false;

    // Active handoff involving our sector(s)
    const hoEvt = hoEventType(f.handoffEvent);
    if (hoEvt && f.handoffReceiving) {
        const recvFac = extractFac(f.handoffReceiving);
        const recvSec = extractSec(f.handoffReceiving);
        const xferFac = extractFac(f.handoffTransferring);
        const xferSec = extractSec(f.handoffTransferring);
        const recvIsMe = recvFac === myFacility && mySectors.has(recvSec);
        const xferIsMe = xferFac === myFacility && mySectors.has(xferSec);

        if (xferIsMe && hoEvt === 'PROPOSED') return false;  // We initiated, still own it
        if (xferIsMe && hoEvt === 'ACCEPTED') return true;   // We gave it away
        if (recvIsMe && hoEvt === 'PROPOSED') return true;    // Incoming, not yet accepted
        if (recvIsMe && hoEvt === 'ACCEPTED') return false;   // We accepted, we own it
    }

    // Completed handoff — informational (O display), R follows controlling sector above
    const completed = hoCompletedInfo.get(f.gufi);
    if (completed) {
        const recvIsMe = extractFac(completed.receiving) === myFacility && mySectors.has(extractSec(completed.receiving));
        if (recvIsMe) return false;  // Incoming completed — we now own it, no R
        const xferIsMe = extractFac(completed.transferring) === myFacility && mySectors.has(extractSec(completed.transferring));
        if (xferIsMe) return true;   // Outgoing completed — show R
    }

    // Default: R for any track we don't own
    return true;
}

// Determine if a track should show FDB (full data block) or LDB (limited)
function shouldShowFdb(gufi, cls) {
    // User override takes priority
    if (fdbOverrides.has(gufi)) return fdbOverrides.get(gufi);
    // Quick Look sectors: force FDB on tracks in QL'd sectors
    if (quickLookSectors.size > 0) {
        const f = flights.get(gufi);
        if (f) {
            const sec = f.controllingSector || '';
            if (quickLookSectors.has(sec)) return true;
        }
    }
    // Quick Look destinations: force FDB on flights to QL'd airports
    if (quickLookDests.size > 0) {
        const f = flights.get(gufi);
        if (f && f.destination && quickLookDests.has(f.destination.toUpperCase())) return true;
    }
    // Point-out tracks force FDB
    {
        const f = flights.get(gufi);
        if (f && getPointoutIndicator(f)) return true;
    }
    // Default: own and handoff tracks get FDB, others get LDB
    return cls === 'own' || cls === 'ho' || cls === 'emrg';
}

// Dwell emphasis helpers — apply/remove box + LDB brightness boost
function applyDwell(el, gufi) {
    const dbEl = el.querySelector('.ac-db');
    if (!dbEl) return;
    dbEl.classList.add('dwell');
    // FDB: add a real border element sized from actual DOM measurements
    if (dbEl.classList.contains('fdb') && !dbEl.querySelector('.dwell-border')) {
        const b = document.createElement('div');
        b.className = 'dwell-border';
        const w = dbEl.offsetWidth;
        const h = dbEl.offsetHeight;
        const chOff = Math.round(CHAR_W * 2.2); // past column 0 + VCI, scales with font size
        // If Line 0 (point-out indicator) is present, exclude it from the dwell border
        const f0 = flights.get(gufi);
        const hasLine0 = f0 && getPointoutIndicator(f0);
        const heightAdj = hasLine0 ? Math.round(LINE_H) : 0;
        // Use fence positioning for top/left, but data block dimensions for width/height
        const topStyle = hasLine0 ? 'calc(1.25em + 3px)' : '2px';
        b.style.cssText = `position:absolute;top:${topStyle};left:calc(1.5ch + 1px);width:${w - chOff}px;height:${h - heightAdj}px;border:1px solid #FFFF44;pointer-events:none;box-sizing:border-box;z-index:10;opacity:1;`;
        dbEl.appendChild(b);
    }
    const f = flights.get(gufi);
    // Brighten both FDB and LDB on hover
    dbEl.style.opacity = '1';
}
function removeDwell(el, gufi) {
    const dbEl = el.querySelector('.ac-db');
    if (!dbEl) return;
    dbEl.classList.remove('dwell');
    const b = dbEl.querySelector('.dwell-border');
    if (b) b.remove();
    const f = flights.get(gufi);
    if (f && !shouldShowFdb(gufi, classifyTrack(f))) dbEl.style.opacity = String(ldbBrightness / 100);
}

// Build target symbol as pure CSS geometry — no font metrics, pixel-perfect centering at (0,0)
function buildTargetSym(symChar, isEmrg, extraStyle) {
    const c = isEmrg ? '#ff4444' : '#cccc44';
    const st = extraStyle ? extraStyle + ';' : '';
    // Invisible 16×16 hit area centered at (0,0) so thin symbols are easy to click
    const hit = `<div style="position:absolute;width:16px;height:16px;left:-8px;top:-8px;pointer-events:auto;cursor:inherit;z-index:2;"></div>`;
    if (symChar === '\\') {
        // Correlated beacon: 2px × 14px line, rotate(-45deg) = backslash \
        return hit + `<div style="position:absolute;width:2px;height:14px;left:-1px;top:-7px;background:${c};transform:rotate(-45deg);pointer-events:none;z-index:2;${st}"></div>`;
    }
    if (symChar === '/') {
        // Uncorrelated beacon: 2px × 14px line, rotate(45deg) = forward slash /
        return hit + `<div style="position:absolute;width:2px;height:14px;left:-1px;top:-7px;background:${c};transform:rotate(45deg);pointer-events:none;z-index:2;${st}"></div>`;
    }
    if (symChar === '\u2022') {
        // Reduced separation: 5px filled circle centered at (0,0)
        return hit + `<div style="position:absolute;width:5px;height:5px;left:-2.5px;top:-2.5px;border-radius:50%;background:${c};pointer-events:none;z-index:2;${st}"></div>`;
    }
    if (symChar === '#') {
        // Coast track: # — 2 horizontal lines + 2 slanted vertical lines (like /)
        const sz = 14, g = 5, w = 2, slant = 3;
        return hit + `<div style="position:absolute;pointer-events:none;z-index:2;${st}">`
            + `<div style="position:absolute;width:${sz}px;height:${w}px;left:${-sz/2}px;top:${-g/2 - w/2}px;background:${c}"></div>`
            + `<div style="position:absolute;width:${sz}px;height:${w}px;left:${-sz/2}px;top:${g/2 - w/2}px;background:${c}"></div>`
            + `<div style="position:absolute;width:${w}px;height:${sz}px;left:${-g/2 - w/2}px;top:${-sz/2}px;background:${c};transform:skewX(-15deg)"></div>`
            + `<div style="position:absolute;width:${w}px;height:${sz}px;left:${g/2 - w/2}px;top:${-sz/2}px;background:${c};transform:skewX(-15deg)"></div>`
            + `</div>`;
    }
    // Diamond (◇): FDB draws via ac-sym-flat-track; LDB still needs a hit area
    return hit;
}

function buildMarkerHtml(f, cls) {
    const isEmrg = cls === 'emrg';
    const emrgCls = isEmrg ? ' emrg' : '';

    const symChar = getSymbolChar(f);

    const coast = symChar === '#';

    if (!showFdb) {
        // Data blocks off — just target symbol + diamond (no diamond for coast tracks)
        let html = buildTargetSym(symChar, isEmrg);
        if (!coast) html += `<div class="ac-sym-flat-track${emrgCls}"></div>`;
        return html;
    }

    const useFdb = shouldShowFdb(f.gufi, cls);

    // FDB: diamond + symbol; LDB: just the symbol character (no diamond for coast tracks)
    let html;
    if (useFdb) {
        html = buildTargetSym(symChar, isEmrg);
        if (!coast) html += `<div class="ac-sym-flat-track${emrgCls}"></div>`;
    } else {
        const ldbOp = ldbBrightness / 100;
        html = buildTargetSym(symChar, isEmrg, `opacity:${ldbOp}`);
    }

    const color = isEmrg ? EMRG_COLOR : TRACK_COLOR;
    const ldr = getLeaderOffset(f.gufi);
    const numLines = useFdb ? 4 : 2;
    const anchor = getDbAnchor(f.gufi, numLines);
    const isLeftPos = anchor.xShift === -1;
    const pos = dbPositions.get(f.gufi) || 9;
    const isVertical = (pos === 2 || pos === 8);

    // Gap from leader endpoint to data block (Column 0 is inline, provides visual separation)
    const dbGap = Math.ceil(CHAR_W * 0.5);

    // Compute data block CSS position
    let leftStyle;
    if (isLeftPos) leftStyle = `right:${-ldr.dx + dbGap}px`;
    else if (isVertical) leftStyle = `left:${ldr.dx - Math.round(CHAR_W * 1.5) - 2}px`;  // N/S: col0 sits left of leader endpoint
    else leftStyle = `left:${ldr.dx + dbGap}px`;

    // Left-positioned blocks: fixed min-width to prevent jitter during flash
    const leftExtra = isLeftPos ? ` min-width:${Math.ceil(CHAR_W * 9.5)}px;` : '';

    if (useFdb) {
        // Full Data Block (lines 1-4) — with leader line
        const showR = shouldShowR(f, cls);
        const showVci = vciActive.has(f.gufi);
        // Leader extends into col0 area for right-side positions (E/NE/SE)
        let ldrX2 = ldr.dx, ldrY2 = ldr.dy;
        if (!isLeftPos && !isVertical && ldr.dx !== 0) {
            if (showR || showVci) {
                // R/VCI present: end just before the character (left edge of col0)
                ldrX2 += dbGap;
            } else {
                // No R/VCI: extend through empty col0 to reach text
                ldrX2 += dbGap + Math.round(CHAR_W * 1.5);
            }
        }
        const leaderClass = isEmrg ? 'ac-leader emrg' : 'ac-leader fdb-leader';
        html += `<svg class="${leaderClass}" width="1" height="1" overflow="visible"><line x1="0" y1="0" x2="${ldrX2}" y2="${ldrY2}" stroke="${color}" stroke-width="1"/></svg>`;

        const db = formatFdbHtml(f, cls);
        const dbCls = isEmrg ? ' emrg' : '';
        // Line 0 (point-out indicator) adds height — shift div up so Lines 1-4 stay anchored
        const poOffset = getPointoutIndicator(f) ? -LINE_H : 0;
        html += `<div class="ac-db fdb${dbCls}" style="${leftStyle}; top:${ldr.dy + anchor.yShift + poOffset}px;${leftExtra}">${db}</div>`;

        // CRR RDB (Range Data Block) — distance to group location in nautical miles
        // Position relative to target icon (0,0), cycling around it
        if (crrRdbEnabled && f.latitude && f.longitude) {
            const rdbDist = getCrrRdbDistance(f);
            if (rdbDist !== null) {
                const rdbText = rdbDist.toFixed(1) + 'nm';

                // RDB offsets cycle around the target symbol (0,0)
                const offsetConfigs = [
                    { left: Math.ceil(CHAR_W * 2.5), top: -Math.ceil(LINE_H * 0.5) },  // right
                    { left: -Math.ceil(CHAR_W * 8) - 20, top: -Math.ceil(LINE_H * 0.5) },  // left
                    { left: -Math.ceil(CHAR_W * 3) - 10, top: -Math.ceil(LINE_H * 2) },  // above-left
                    { left: -Math.ceil(CHAR_W * 3) - 10, top: Math.ceil(LINE_H * 0.5) }  // bottom-left
                ];
                const cfg = offsetConfigs[crrRdbOffset];

                html += `<div class="ac-rdb" style="left:${cfg.left}px; top:${cfg.top}px;">${rdbText}</div>`;
            }
        }
    } else if (ldbBrightness > 0) {
        // VCI clears when track goes to LDB
        vciActive.delete(f.gufi);
        // Limited Data Block (2-3 lines) — no leader line, right next to target
        const ldbOp = ldbBrightness / 100;
        const l1 = f.callsign || '???';
        const alt = f.reportedAltitude ?? f.assignedAltitude;
        const l2 = alt != null ? String(Math.round(alt / 100)).padStart(3, '0') : '';
        const dbCls = isEmrg ? ' emrg' : '';
        // Add third line with squawk code when CODE button is pressed
        let ldbContent = `${l1}\n${l2}`;
        if (codeButtonPressed) {
            const squawk = f.squawk ? String(f.squawk).padStart(4, '0') : '    ';
            ldbContent += `\n${squawk}`;
        }
        html += `<div class="ac-db ldb${dbCls}" style="left:${Math.ceil(CHAR_W)}px; top:${-LINE_H}px; opacity:${ldbOp};">${ldbContent}</div>`;
    }
    // ldbBrightness === 0 for LDB → no data block at all

    return html;
}

function formatDatablock(f, cls) {
    // Line 1: Field A (callsign)
    const l1 = f.callsign || '???';

    // Line 2: Field B + status + Field C (per ERAM spec)
    const l2 = formatAltLine(f);

    // Line 3: Field D (CID) + Field E
    const l3 = formatLine3(f, cls);

    // Line 4: Field F (full ICAO destination)
    const l4 = f.destination || '';

    return l4 ? `${l1}\n${l2}\n${l3}\n${l4}` : `${l1}\n${l2}\n${l3}`;
}

// Format FDB with Column 0 inline (VCI, R) — returns HTML
const VCI_SVG = '<svg viewBox="0 0 16 16" width="1.2em" height="1.2em" style="vertical-align:-0.2em;"><path d="M3,5 L3,13 L11,13" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5,8 A3,3 0 0,1 8,11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M5,5.5 A5.5,5.5 0 0,1 10.5,11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

function formatLine4(f, hsfCol) {
    const hsf = getEffectiveHsf(f);
    const showHsf = hsfShowMap.has(f.gufi);

    // HSF mode: show heading/speed/free text
    // Speed positioned so last digit sits under ↴ (at hsfCol), +/- extends one past
    if (showHsf && hsf) {
        if (hsf.freeText) return esc(hsf.freeText);
        const h = hsf.heading || '';
        const s = hsf.speed || '';
        if (s) {
            const hasModifier = /[+-]$/.test(s);
            // ↴ is at hsfCol; last digit under it, +/- one past
            const sEnd = hasModifier ? hsfCol + 2 : hsfCol + 1;
            const sStart = sEnd - s.length;
            if (h) {
                const pad = Math.max(1, sStart - h.length);
                return esc(h + '\u00a0'.repeat(pad) + s);
            }
            const pad = Math.max(0, sStart);
            return esc('\u00a0'.repeat(pad) + s);
        }
        return esc(h);
    }

    // Normal mode: based on line4Mode setting
    if (line4Mode === 'DEST') return f.destination ? esc(f.destination) : '';
    if (line4Mode === 'TYPE') {
        const t = f.aircraftType || '';
        const eq = f.equipmentQualifier ? '/' + f.equipmentQualifier : '';
        return t ? esc(t + eq) : '';
    }
    return ''; // OFF
}

function formatFdbHtml(f, cls) {
    const showVci = vciActive.has(f.gufi);
    const showR = shouldShowR(f, cls);
    const hsf = getEffectiveHsf(f);

    const l1 = esc(f.callsign || '???');
    const l2 = esc(formatAltLine(f));
    const l3text = formatLine3(f, cls);
    const l3esc = esc(l3text);
    const l4 = formatLine4(f, l3text.length);

    // ↴ indicator appended directly at end of line 3 (no gap)
    const hasServerClr = f.clearanceHeading || f.clearanceSpeed || f.clearanceText;
    let l3;
    if (hsf && (hasServerClr || hsf.heading || hsf.speed || hsf.freeText)) {
        const hsfInd = '<span class="ac-hsf-ind" style="pointer-events:auto;cursor:inherit;">\u21b4</span>';
        l3 = l3esc + hsfInd;
    } else {
        l3 = l3esc;
    }

    // Column 0: inline spans — VCI hit area on lines 1-2, R on line 3
    const col0Hit = '<span class="ac-vci-hit" style="display:inline-block;width:1.5ch;pointer-events:auto;cursor:inherit;">\u00a0</span>';
    const col0Vci = `<span class="ac-vci-hit ac-vci on-freq" style="display:inline-block;width:1.5ch;text-align:center;pointer-events:auto;cursor:inherit;">${VCI_SVG}</span>`;
    const col0R   = '<span class="ac-col0 ac-r" style="display:inline-block;width:1.5ch;text-align:center;">R</span>';
    const col0Sp  = '<span style="display:inline-block;width:1.5ch;">\u00a0</span>';

    // Line 0: Point-out P/A indicator (between 2nd and 3rd char position)
    const poInfo = getPointoutIndicator(f);
    let html = '';
    if (poInfo) {
        html += `<span class="ac-po-line0" style="pointer-events:auto;cursor:inherit;">${col0Sp}\u00a0\u00a0<span class="ac-po-${poInfo.cls}">${poInfo.ch}</span></span>\n`;
    }
    html += `${col0Hit}${l1}\n`;
    html += `${showVci ? col0Vci : col0Hit}${l2}\n`;
    html += `${showR ? col0R : col0Sp}${l3}`;
    if (l4) html += `\n${col0Sp}${l4}`;
    if (showPortalFence && (poInfo || showR)) {
        let fenceColor;
        if (cls === 'emrg') {
            fenceColor = '#ff4444';
        } else {
            const v = Math.round(tbState.bright.fence * 2.55);
            const hexVal = v.toString(16).padStart(2, '0');
            fenceColor = `#${hexVal}${hexVal}${hexVal}`;
        }
        // Use CSS ch/em units for sizing (matches actual font metrics) and SVG rendering for flicker-free strokes.
        // top: 0 when no line 0; top: calc(1.25em + 1px) skips line 0 (1 line-height + ac-db top padding).
        const topStyle = poInfo ? 'calc(1.25em + 3px)' : '2px';
        html += `<svg style="position:absolute;top:${topStyle};left:calc(1.5ch + 1px);width:3ch;height:3.75em;overflow:visible;pointer-events:none;z-index:1;" viewBox="0 0 100 100" preserveAspectRatio="none"><polyline points="100,0.5 0.5,0.5 0.5,100" fill="none" stroke="${fenceColor}" stroke-width="1" vector-effect="non-scaling-stroke" stroke-linejoin="miter"/></svg>`;
    }
    return html;
}

// Determine point-out indicator for a flight.
// Returns {ch, cls, role, origSector, origFac, recvSectors:[{fac,sector}]} or null.
// recvSectors is always an array (may have multiple receiving sectors).
function getPointoutIndicator(f) {
    if (!f.pointoutOriginatingUnit && !f.pointoutReceivingUnit) {
        pointoutFirstSeen.delete(f.gufi);
        return null;
    }
    // DROPPED flights should not show point-outs — clear the data
    if (f.flightStatus === 'DROPPED') {
        f.pointoutOriginatingUnit = null;
        f.pointoutReceivingUnit = null;
        pointoutAcked.delete(f.gufi);
        pointoutFirstSeen.delete(f.gufi);
        if (pointoutMenuGufi === f.gufi) closePointoutMenu();
        return null;
    }
    if (!myFacility || mySectors.size === 0) return null;

    const origFac = (f.pointoutOriginatingUnit || '').split('/')[0];
    const origSector = (f.pointoutOriginatingUnit || '').split('/')[1] || '';

    // Parse comma-separated receiving units (may be multiple: "ZDV/07,ZDV/34")
    const recvSectors = (f.pointoutReceivingUnit || '').split(',').filter(Boolean)
        .map(u => ({ fac: u.split('/')[0], sector: u.split('/')[1] || '' }));

    // Show P only if a selected sector is the originator or any receiver
    const isOrig = myFacility === origFac && mySectors.has(origSector);
    const isRecv = recvSectors.some(r => myFacility === r.fac && mySectors.has(r.sector));
    if (isOrig || isRecv) {
        // Client-side 3-minute timeout: auto-expire if user hasn't interacted
        const now = Date.now();
        if (!pointoutFirstSeen.has(f.gufi)) {
            pointoutFirstSeen.set(f.gufi, now);
        } else if (now - pointoutFirstSeen.get(f.gufi) > PO_CLIENT_TIMEOUT) {
            // Expired — clear point-out data silently
            f.pointoutOriginatingUnit = null;
            f.pointoutReceivingUnit = null;
            pointoutAcked.delete(f.gufi);
            pointoutFirstSeen.delete(f.gufi);
            if (pointoutMenuGufi === f.gufi) closePointoutMenu();
            return null;
        }
        pointoutBlocked.add(f.gufi);  // block FLID toggle until QP <FLID> (CRC spec)
        const role = isOrig ? 'originator' : 'receiver';
        const acked = pointoutAcked.has(f.gufi);
        return { ch: acked ? 'A' : 'P', cls: acked ? 'accepted' : 'pending',
                 role, origSector, origFac, recvSectors };
    }
    return null;
}

function formatAltLine(f) {
    const localA = localAssignedAlt.get(f.gufi);
    const localI = localInterimAlt.get(f.gufi);
    const localR = localReportedAlt.get(f.gufi);

    // Local controller overrides win when present; server fills gaps
    // Server auto-clears local overrides only when it sends genuinely new values
    const assigned = localA ? localA.feet : (f.assignedAltitude ?? null);
    const reported = localR ? localR.feet : (f.reportedAltitude ?? null);
    const interim = localI ? localI.feet : (f.interimAltitude ?? null);

    const afl = assigned != null ? String(Math.round(assigned / 100)).padStart(3, '0') : '';
    const rfl = reported != null ? String(Math.round(reported / 100)).padStart(3, '0') : '';

    // VFR/OTP display — local QZ override wins, then server assignedVfr
    const isVfr = (localA && (localA.rules === 'VFR' || localA.rules === 'OTP')) || (!localA && f.assignedVfr);
    if (isVfr) {
        const localRules = localA ? localA.rules : null;
        const prefix = localRules === 'OTP' ? 'OTP' : 'VFR';
        // VFR with altitude (vfrPlus) → VFR/055; VFR without → just VFR
        if (afl) return rfl ? `${prefix}/${rfl}` : `${prefix}/${afl}`;
        return rfl ? `${prefix}/${rfl}` : prefix;
    }

    // Block altitude (per CRC spec):
    //   Within block (±200ft): {floor}B{ceil} — conforming, hide Mode C
    //   Outside block: {floor}B{reported} — ceiling replaced by actual position
    if (localA && localA.block) {
        if (reported != null && localA.floorFeet != null && localA.ceilFeet != null
            && reported >= localA.floorFeet - 200 && reported <= localA.ceilFeet + 200)
            return localA.block;
        // Outside block: show floor + B + reported
        const localFloor = localA.block.split('B')[0];
        return rfl ? `${localFloor}B${rfl}` : localA.block;
    }
    if (!localA && f.blockFloor != null && f.blockCeiling != null) {
        const floor = String(Math.round(f.blockFloor / 100)).padStart(3, '0');
        const ceil = String(Math.round(f.blockCeiling / 100)).padStart(3, '0');
        if (reported != null && reported >= f.blockFloor - 200 && reported <= f.blockCeiling + 200)
            return `${floor}B${ceil}`;
        // Outside block: show floor + B + reported
        return rfl ? `${floor}B${rfl}` : `${floor}B${ceil}`;
    }

    // Interim/procedure/local altitude → T, P, or L indicator
    if (interim != null) {
        const ifl = String(Math.round(interim / 100)).padStart(3, '0');
        const localType = localI ? localI.type : null;
        const indicator = localType === 'P' ? 'P' : localType === 'L' ? 'L' : 'T';
        return rfl ? `${ifl}${indicator}${rfl}` : `${ifl}${indicator}`;
    }

    if (assigned == null && reported == null) return '';
    if (assigned == null) return rfl;

    // No Mode C reported → X indicator: {assigned}XXXX
    if (reported == null) return `${afl}XXXX`;

    const aAlt = Math.round(assigned / 100);
    const rAlt = Math.round(reported / 100);
    const diff = rAlt - aAlt;

    // Conforming (at altitude, within ±2 FL / 200ft) → C, hide Field C
    if (Math.abs(diff) <= 2) return `${afl}C`;

    // Non-conforming: track initial side to distinguish ↑↓ (on course) vs +- (overshoot)
    // _altInitialSide records whether reported was above (+1) or below (-1) assigned
    // when the aircraft first became non-conforming (or when assigned altitude changed).
    // Same side as initial → ↑ or ↓ (still en route); crossed to opposite side → + or - (overshot).
    const initSide = f._altInitialSide || 0;
    if (initSide < 0) {
        // Started below assigned (was climbing)
        if (diff < 0) return `${afl}\u2191${rfl}`;  // ↑ still below, climbing to assigned
        return `${afl}+${rfl}`;  // + overshot above assigned
    } else if (initSide > 0) {
        // Started above assigned (was descending)
        if (diff > 0) return `${afl}\u2193${rfl}`;  // ↓ still above, descending to assigned
        return `${afl}-${rfl}`;  // - overshot below assigned
    }
    // No initial side recorded yet — fall back to current position
    if (diff < 0) return `${afl}\u2191${rfl}`;
    return `${afl}\u2193${rfl}`;
}

function formatLine3(f, cls) {
    const cidVal = getCid(f);
    const cid = cidVal ? String(cidVal).padStart(3, ' ') : '   ';
    const gs = f.groundSpeed != null ? String(Math.round(f.groundSpeed)).padStart(3, '0') : '';
    const destLetter = getDestinationLetter(f.destination);
    // Normal Field E: single-letter destination + 3-digit groundspeed, or just groundspeed
    const gsStr = destLetter && gs ? `${cid}${destLetter}${gs}` : gs ? `${cid} ${gs}` : cid;

    // ── CODE button: show squawk code when pressed ──
    if (codeButtonPressed) {
        const squawk = f.squawk ? String(f.squawk).padStart(4, '0') : '    ';
        return `${cid}${squawk}`;
    }

    // ── ERAM Field E priority (per specification) ──

    // 1. Special squawk codes (highest priority, static display)
    if (f.squawk === '7500') return `${cid} HIJK`;
    if (f.squawk === '7600') return `${cid} RDOF`;
    if (f.squawk === '7700') return `${cid} EMRG`;
    if (f.squawk === '1276') return `${cid} ADIZ`;
    if (f.squawk === '7400') return `${cid} LLNK`;
    if (f.squawk === '7777') return `${cid} AFIO`;

    // 1.5 SPEED button: show speed instead of handoff when pressed
    if (speedButtonPressed) {
        const hoEvt = hoEventType(f.handoffEvent);
        if (hoEvt && f.handoffReceiving) {
            // Flight has active handoff and SPEED button is pressed — show speed
            return gsStr;
        }
    }

    // 2. Active handoff — flash in Field E (uses global flashTime so ALL tracks sync)
    //    H = proposed, O = accepted/executing, K = forced acceptance (/OK)
    //    HUNK/OUNK/KUNK = unknown sector variant
    const hoEvt = hoEventType(f.handoffEvent);
    if (hoEvt && f.handoffReceiving) {
        const recvSec = extractSec(f.handoffReceiving);
        const isUnknown = !recvSec;
        let hoLetter;
        if (f.handoffForced) hoLetter = 'K';
        else if (hoEvt === 'PROPOSED') hoLetter = 'H';
        else hoLetter = 'O';

        const hoStr = isUnknown
            ? `${cid} ${hoLetter === 'H' ? 'HUNK' : hoLetter === 'K' ? 'KUNK' : 'OUNK'}`
            : `${cid}${hoLetter}${handoffSuffix(f.handoffReceiving, f.handoffTransferring)}`;
        const padLen = Math.max(hoStr.length, gsStr.length);
        if (hoEvt === 'PROPOSED' && !f.handoffForced) {
            // Fast blink: 0.5s on/off, alternate H-xx / GS every 6s
            const tick = Math.floor(flashTime / 500) % 24;
            const phase = tick < 12 ? 0 : 1;
            const visible = tick % 2 === 0;
            if (!visible) return cid.padEnd(padLen);
            if (phase === 0) return hoStr.padEnd(padLen);
            return gsStr.padEnd(padLen);
        } else {
            // Slow 6-second cycle: 3s indicator, 3s GS (O/K — no rapid on/off)
            const phase = Math.floor(flashTime / 3000) % 2;
            if (phase === 0) return hoStr.padEnd(padLen);
            return gsStr.padEnd(padLen);
        }
    }

    // 3. Completed handoff — rotate indicator / groundspeed for 60 seconds (5 cycles of 12s)
    //    Uses K for forced (/OK) completions, O for normal
    const completed = hoCompletedInfo.get(f.gufi);
    if (completed && flashTime - completed.time < 60000) {
        const recvSec = extractSec(completed.receiving);
        const isUnknown = !recvSec;
        const letter = completed.forced ? 'K' : 'O';
        const hoStr = isUnknown
            ? `${cid} ${letter === 'K' ? 'KUNK' : 'OUNK'}`
            : `${cid}${letter}${handoffSuffix(completed.receiving, completed.transferring)}`;
        const padLen = Math.max(hoStr.length, gsStr.length);
        // 12s per cycle: 6s indicator, 6s groundspeed
        const phase = Math.floor((flashTime - completed.time) / 6000) % 2;
        if (phase === 0) return hoStr.padEnd(padLen);
        return gsStr.padEnd(padLen);
    }

    // 4. Coast track → CST in Field E (per CRC spec)
    if (isCoasting(f)) return `${cid} CST`;

    // 5. Beacon code mismatch (per CRC spec: #### if received differs from assigned, NONE if no received)
    if (f.assignedSquawk) {
        if (!f.squawk) return `${cid} NONE`;
        if (f.squawk !== f.assignedSquawk) return `${cid} ${f.squawk}`;
    }

    // 6. Normal: destination letter + groundspeed
    return gsStr;
}

// Build handoff suffix: intra-facility = -xx, inter-facility = Nxx (handoff code)
function handoffSuffix(receiving, transferring) {
    const recvFac = extractFac(receiving);
    const recvSec = extractSec(receiving);
    const xferFac = transferring ? extractFac(transferring) : '';
    if (!recvFac || !recvSec) return `-${(recvSec || '??').padStart(2, '0')}`;
    // Inter-facility: use handoff code of receiving facility
    if (xferFac && xferFac !== recvFac) {
        const code = getHandoffCode(recvFac);
        return `${code}${recvSec.padStart(2, '0')}`;
    }
    // Intra-facility: use dash
    return `-${recvSec.padStart(2, '0')}`;
}

// ════════════════════════════════════════════════════════════════════════════
// History tracking
// ════════════════════════════════════════════════════════════════════════════
function addHistoryPoint(gufi, lat, lon, sym) {
    if (!flightHistory.has(gufi)) flightHistory.set(gufi, []);
    const hist = flightHistory.get(gufi);
    hist.push({ lat, lon, sym: sym || '\\', time: performance.now() });
    if (hist.length > MAX_HISTORY) hist.shift();
}

// ════════════════════════════════════════════════════════════════════════════
// Flight update processing (shared by 'update' and 'batch' message types)
// ════════════════════════════════════════════════════════════════════════════
function processFlightUpdate(f) {
    trackFacility(f);

    const existing = flights.get(f.gufi);
    if (existing) {
        existing._clientLastUpdate = performance.now();
        // Capture old state BEFORE overwriting
        const oldHoEvt = hoEventType(existing.handoffEvent);
        const oldHoRecv = existing.handoffReceiving;
        const oldHoXfer = existing.handoffTransferring;
        const oldHoForced = existing.handoffForced;
        const oldCuFac = existing.controllingFacility;
        const oldCuSec = existing.controllingSector;
        const hadClr = existing.clearanceHeading || existing.clearanceSpeed || existing.clearanceText;

        // Track vertical rate for altitude status indicators
        if (f.reportedAltitude != null && existing.reportedAltitude != null) {
            existing._vertRate = f.reportedAltitude - existing.reportedAltitude;
        }

        // Track initial side for altitude status indicators (↑↓ vs +-)
        // Reset when assigned altitude changes (new clearance = new intent)
        if ('assignedAltitude' in f && f.assignedAltitude !== existing.assignedAltitude) {
            existing._altInitialSide = 0;
        }

        // Record history from old position, then apply new position immediately
        if (f.latitude != null && f.longitude != null) {
            const oldLat = existing.latitude;
            const oldLon = existing.longitude;
            if (oldLat != null && oldLon != null) {
                const dlat = Math.abs(oldLat - f.latitude);
                const dlon = Math.abs(oldLon - f.longitude);
                if (dlat > 0.0001 || dlon > 0.0001) {
                    addHistoryPoint(f.gufi, oldLat, oldLon, getSymbolChar(existing));
                }
            }
        }
        // Suppress server clearance fields that were manually cleared via QS *
        const sup = hsfClrSuppressed.get(f.gufi);
        if (sup) {
            if ('clearanceHeading' in f) {
                if ((f.clearanceHeading || null) === sup.h) f.clearanceHeading = null;
                else sup.h = null;
            }
            if ('clearanceSpeed' in f) {
                if ((f.clearanceSpeed || null) === sup.s) f.clearanceSpeed = null;
                else sup.s = null;
            }
            if ('clearanceText' in f) {
                if ((f.clearanceText || null) === sup.t) f.clearanceText = null;
                else sup.t = null;
            }
            if (!sup.h && !sup.s && !sup.t) hsfClrSuppressed.delete(f.gufi);
        }

        // Apply all fields including position
        for (const key in f) {
            existing[key] = f[key];
        }

        // Set initial side for altitude indicators after merge (when we have both values)
        // _altInitialSide: -1 = started below assigned (climbing), +1 = started above (descending)
        if (existing.assignedAltitude != null && existing.reportedAltitude != null) {
            const aAlt = Math.round(existing.assignedAltitude / 100);
            const rAlt = Math.round(existing.reportedAltitude / 100);
            const d = rAlt - aAlt;
            if (Math.abs(d) <= 2) {
                existing._altInitialSide = 0;  // Conforming — clear
            } else if (!existing._altInitialSide) {
                existing._altInitialSide = d < 0 ? -1 : 1;  // First non-conforming — record side
            }
        }

        // SWIM data overrides local controller entries ONLY when genuinely new
        // (stale repeats of the same value don't clear local overrides)
        if ('assignedAltitude' in f) {
            const la = localAssignedAlt.get(f.gufi);
            if (la && f.assignedAltitude !== la.serverVal) localAssignedAlt.delete(f.gufi);
        }
        if ('interimAltitude' in f) {
            const li = localInterimAlt.get(f.gufi);
            if (li && f.interimAltitude !== li.serverVal) localInterimAlt.delete(f.gufi);
        }
        if ('reportedAltitude' in f) {
            const lr = localReportedAlt.get(f.gufi);
            if (lr && f.reportedAltitude !== lr.serverVal) localReportedAlt.delete(f.gufi);
        }

        // Auto-show HSF when server clearance data first arrives
        const hasClr = existing.clearanceHeading || existing.clearanceSpeed || existing.clearanceText;
        if (hasClr && !hadClr) hsfShowMap.add(f.gufi);

        // Detect handoff completion via two paths:
        // 1) HO event cleared by server (HO-DONE) + CU matches recv
        // 2) CU changed to match recv (covers missed initiation)
        const newHoEvt = hoEventType(existing.handoffEvent);
        const cuChanged = existing.controllingFacility !== oldCuFac || existing.controllingSector !== oldCuSec;
        const recv = oldHoRecv || existing.handoffReceiving;
        if (recv && !hoCompletedInfo.has(f.gufi)) {
            const recvFac = extractFac(recv);
            const recvSec = extractSec(recv);
            const cuMatchesRecv = existing.controllingFacility === recvFac && existing.controllingSector === recvSec;
            if (cuMatchesRecv && ((!newHoEvt && oldHoEvt) || cuChanged)) {
                hoCompletedInfo.set(f.gufi, {
                    time: performance.now(),
                    receiving: recv,
                    transferring: oldHoXfer || existing.handoffTransferring || '',
                    forced: oldHoForced || existing.handoffForced || false
                });
            }
        }
    } else {
        // New flight — add fully (including position)
        f._clientLastUpdate = performance.now();
        if (f.assignedAltitude != null && f.reportedAltitude != null) {
            const aAlt = Math.round(f.assignedAltitude / 100);
            const rAlt = Math.round(f.reportedAltitude / 100);
            const d = rAlt - aAlt;
            f._altInitialSide = Math.abs(d) <= 2 ? 0 : (d < 0 ? -1 : 1);
        }
        flights.set(f.gufi, f);
    }

    // Handoff targeting our sector → immediately set FDB + rebuild marker
    if (hoEventType(f.handoffEvent)) {
        const cur = flights.get(f.gufi);
        if (cur) {
            const cls = classifyTrack(cur);
            if (cls === 'ho' && !fdbOverrides.has(f.gufi)) {
                fdbOverrides.set(f.gufi, true);
                const marker = markers.get(f.gufi);
                if (marker) {
                    const el = marker.getElement();
                    if (el) el._lastHash = '';
                }
                lastRenderTime = 0;
            }
        }
    }

    // Auto-switch QP T → QP J when aircraft climbs above FL230
    if (driActive.get(f.gufi) === 'T') {
        const alt = f.reportedAltitude ?? f.assignedAltitude;
        if (alt != null && alt > 23000) {
            driActive.set(f.gufi, 'J');
            lastRenderTime = 0;
        }
    }
}

// ════════════════════════════════════════════════════════════════════════════
// WebSocket
// ════════════════════════════════════════════════════════════════════════════
let _ws = null;
function connectWs() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = _ws = new WebSocket(`${proto}//${location.host}/ws`);

    ws.onopen = () => {
        wsConnected = true;
        document.getElementById('connection-status').textContent = 'Connected';
        document.getElementById('connection-status').style.color = '#cccc44';
    };

    ws.onclose = () => {
        wsConnected = false;
        document.getElementById('connection-status').textContent = 'Disconnected \u2014 reconnecting...';
        document.getElementById('connection-status').style.color = '#cc4444';
        if (!window.idlePaused || !window.idlePaused()) setTimeout(connectWs, 3000);
    };

    ws.onmessage = (evt) => {
        const msg = JSON.parse(evt.data);

        if (msg.type === 'snapshot') {
            // Fresh start — seed history from server (survives refresh)
            for (const [, m] of markers) map.removeLayer(m);
            markers.clear();
            flights.clear();
            flightHistory.clear();
            for (const f of msg.data) {
                // Apply clearance suppression from QS * clears (survives reconnect within session)
                const sup = hsfClrSuppressed.get(f.gufi);
                if (sup) {
                    if (sup.h && (f.clearanceHeading || null) === sup.h) f.clearanceHeading = null;
                    else if (f.clearanceHeading) sup.h = null;
                    if (sup.s && (f.clearanceSpeed || null) === sup.s) f.clearanceSpeed = null;
                    else if (f.clearanceSpeed) sup.s = null;
                    if (sup.t && (f.clearanceText || null) === sup.t) f.clearanceText = null;
                    else if (f.clearanceText) sup.t = null;
                    if (!sup.h && !sup.s && !sup.t) hsfClrSuppressed.delete(f.gufi);
                }
                f._clientLastUpdate = performance.now();
                // Initialize altitude initial side for snapshot flights
                if (f.assignedAltitude != null && f.reportedAltitude != null) {
                    const aAlt = Math.round(f.assignedAltitude / 100);
                    const rAlt = Math.round(f.reportedAltitude / 100);
                    const d = rAlt - aAlt;
                    f._altInitialSide = Math.abs(d) <= 2 ? 0 : (d < 0 ? -1 : 1);
                }
                flights.set(f.gufi, f);
                trackFacility(f);
                if (f.history && f.history.length > 0) {
                    const now = performance.now();
                    const hist = f.history.map(h => ({
                        lat: h.lat, lon: h.lon, sym: h.sym || '\\',
                        time: now - ((h.age || 0) * 1000)
                    }));
                    while (hist.length > MAX_HISTORY) hist.shift();
                    flightHistory.set(f.gufi, hist);
                }
                // Auto-show HSF for flights with server clearance data
                if (f.clearanceHeading || f.clearanceSpeed || f.clearanceText) {
                    hsfShowMap.add(f.gufi);
                }
            }
        } else if (msg.type === 'update') {
            processFlightUpdate(msg.data);
        } else if (msg.type === 'batch') {
            // Batched updates — array of flight summaries
            for (const f of msg.data) {
                processFlightUpdate(f);
            }
        } else if (msg.type === 'remove') {
            flights.delete(msg.data.gufi);
            flightHistory.delete(msg.data.gufi);
            fdbOverrides.delete(msg.data.gufi);
            wasOwnOrHo.delete(msg.data.gufi);
            manuallyHidden.delete(msg.data.gufi);
            hoCompletedInfo.delete(msg.data.gufi);
            lastVisibleAt.delete(msg.data.gufi);
            driActive.delete(msg.data.gufi);
            pointoutBlocked.delete(msg.data.gufi);
            const m = markers.get(msg.data.gufi);
            if (m) { map.removeLayer(m); markers.delete(msg.data.gufi); }
            removeRoute(msg.data.gufi);
        } else if (msg.type === 'stats') {
            msgRate = msg.data.rate;
        }
    };
}
connectWs();

// ════════════════════════════════════════════════════════════════════════════
// Facility/sector tracking
// ════════════════════════════════════════════════════════════════════════════
function trackFacility(f) {
    const fac = f.controllingFacility || f.reportingFacility || '';
    if (!fac) return;
    const sec = f.controllingSector || '';
    if (!knownFacilities.has(fac)) knownFacilities.set(fac, new Set());
    if (sec) knownFacilities.get(fac).add(sec);
}

let _lastFacilityInDropdown = false;
function rebuildFacilityDropdown() {
    const sel = document.getElementById('sel-facility');
    const facs = [...knownFacilities.keys()].filter(f => f.startsWith('Z')).sort();
    let html = '<option value="">All</option>';
    for (const fac of facs) html += `<option value="${esc(fac)}">${esc(fac)}</option>`;
    sel.innerHTML = html;
    // Restore selection (myFacility may have been set from URL before facilities were known)
    sel.value = myFacility || '';
    // First time our facility appears in the dropdown — trigger boundary display
    if (myFacility && !_lastFacilityInDropdown && facs.includes(myFacility)) {
        _lastFacilityInDropdown = true;
        showBoundariesForFacility(myFacility);
        rebuildSectorCheckboxes();
    }
}

function rebuildSectorCheckboxes() {
    const container = document.getElementById('sector-checkboxes');
    if (!myFacility) {
        container.innerHTML = '<span style="color:#666; font-size:10px;">Select facility first</span>';
        return;
    }
    const secs = knownFacilities.has(myFacility) ? [...knownFacilities.get(myFacility)].sort() : [];
    if (secs.length === 0) {
        container.innerHTML = '<span style="color:#666; font-size:10px;">No sectors found yet</span>';
        return;
    }
    let html = '';
    for (const sec of secs) {
        const checked = mySectors.has(sec) ? ' checked' : '';
        html += `<label style="display:block; padding:1px 0; cursor:pointer; color:#aaa;">` +
            `<input type="checkbox" class="sec-chk" value="${esc(sec)}"${checked} style="accent-color:#cccc44;"> ${esc(sec)}` +
            `</label>`;
    }
    container.innerHTML = html;
    container.querySelectorAll('.sec-chk').forEach(chk => {
        chk.addEventListener('change', function () {
            if (this.checked) {
                mySectors.add(this.value);
            } else {
                mySectors.delete(this.value);
                // Deactivating a sector: revert all flights associated with that sector to LDB
                demoteSectorFlights(this.value);
            }
            invalidateAllMarkers(); // immediately update R indicators and FDB/LDB
            saveSettingsToLocalStorage();
        });
    });
}

// When a sector is deactivated, revert all flights that were own/ho for that sector back to LDB
function demoteSectorFlights(sector) {
    for (const [gufi, f] of flights) {
        const fac = f.controllingFacility || f.reportingFacility || '';
        const sec = f.controllingSector || '';
        const hoRecvSec = extractSec(f.handoffReceiving);
        const hoXferSec = extractSec(f.handoffTransferring);
        // Flight belongs to the deactivated sector if it's controlled by it or in handoff with it
        if (fac === myFacility && sec === sector ||
            extractFac(f.handoffReceiving) === myFacility && hoRecvSec === sector ||
            extractFac(f.handoffTransferring) === myFacility && hoXferSec === sector) {
            fdbOverrides.delete(gufi);
            wasOwnOrHo.delete(gufi);
        }
    }
}

function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ════════════════════════════════════════════════════════════════════════════
// Change detection — lightweight hash to avoid rebuilding marker HTML
// ════════════════════════════════════════════════════════════════════════════
function flightHash(f, cls) {
    const useFdb = shouldShowFdb(f.gufi, cls);
    // Flash animation is handled by the 500ms flash timer (data block text only),
    // so flashKey is NOT in the hash — prevents full marker rebuild every tick.
    // Include hoCompleted + R state so marker rebuilds when handoff completes
    const hoc = hoCompletedInfo.has(f.gufi) ? 1 : 0;
    const rInd = shouldShowR(f, cls) ? 1 : 0;
    const dbPos = dbPositions.get(f.gufi) || 0;
    const ldrLen = ldrLenOverrides.get(f.gufi) ?? 1;
    const vci = vciActive.has(f.gufi) ? 1 : 0;
    const la = localAssignedAlt.get(f.gufi);
    const li = localInterimAlt.get(f.gufi);
    const lr = localReportedAlt.get(f.gufi);
    const laH = la ? `${la.feet}${la.rules||''}${la.block||''}` : '';
    const liH = li ? `${li.feet}${li.type}` : '';
    const lrH = lr ? lr.feet : '';
    const hsf = getEffectiveHsf(f);
    const hsfH = hsf ? `${hsf.heading||''}${hsf.speed||''}${hsf.freeText||''}` : '';
    const hsfS = hsfShowMap.has(f.gufi) ? 1 : 0;
    const poAck = pointoutAcked.has(f.gufi) ? 1 : 0;
    const coast = isCoasting(f) ? 1 : 0;
    const ais = f._altInitialSide || 0;
    return `${f.latitude}|${f.longitude}|${f.callsign}|${f.reportedAltitude}|${f.assignedAltitude}|${f.interimAltitude}|${f.assignedVfr||0}|${f.blockFloor||''}|${f.blockCeiling||''}|${f.squawk}|${f.assignedSquawk||''}|${f.handoffEvent}|${f.handoffReceiving}|${f.controllingFacility}|${f.controllingSector}|${f.groundSpeed}|${f.destination}|${getCid(f)}|${cls}|${useFdb}|${useFdb ? 0 : ldbBrightness}|${hoc}|${rInd}|${dbPos}|${ldrLen}|${vci}|${laH}|${liH}|${lrH}|${line4Mode}|${f.aircraftType||''}|${hsfH}|${hsfS}|${f.clearanceHeading||''}|${f.clearanceSpeed||''}|${f.clearanceText||''}|${poAck}|${f.pointoutOriginatingUnit||''}|${f.pointoutReceivingUnit||''}|${coast}|${f.flightStatus||''}|${ais}|${showPortalFence?1:0}`;
}

// ════════════════════════════════════════════════════════════════════════════
// Render loop — guaranteed to never stop via requestAnimationFrame-first
// ════════════════════════════════════════════════════════════════════════════
let lastRenderTime = 0;
let renderFrameCount = 0;

// Force all markers to rebuild on next render (invalidate hashes)
function invalidateAllMarkers() {
    for (const [, m] of markers) {
        const el = m.getElement();
        if (el) el._lastHash = '';
    }
    lastRenderTime = 0; // trigger immediate render on next frame
}

function render() {
    requestAnimationFrame(render);  // ALWAYS schedule next — loop never dies

    const now = performance.now();
    if (now - lastRenderTime < RENDER_INTERVAL) return;
    lastRenderTime = now;

    try {
        doRender();
    } catch (e) {
        console.error('[Render]', e);
    }
}

function doRender() {
    // Auto-close point-out menu if the flight no longer has an indicator
    if (pointoutMenuGufi) {
        const pmf = flights.get(pointoutMenuGufi);
        if (!pmf || !getPointoutIndicator(pmf)) closePointoutMenu();
    }
    renderFrameCount++;
    const now = performance.now();
    // Update QU route lines to follow aircraft positions
    if (activeRoutes.size > 0) updateActiveRoutes();
    // Update CRR distances
    if (crrGroups.size > 0) updateCrrDistances();

    const mapBounds = map.getBounds();
    const onScreenGufis = new Set();
    const counts = { own: 0, ho: 0, other: 0, emrg: 0 };

    // Deduplicate: same callsign reported by multiple ARTCCs → keep only the best GUFI.
    // Priority: (1) passes isVisible status/age checks, (2) has position, (3) facility matches,
    // (4) fresher posAge. Only considers candidates that would pass isVisible() status checks
    // to prevent a "dead" GUFI from winning dedup over a "live" one during GUFI transitions.
    bestGufiByCallsign.clear();
    cidUnionByCallsign.clear();
    if (myFacility) {
        for (const [gufi, f] of flights) {
            if (!f.callsign) continue;
            // Merge this GUFI's per-facility CIDs into the callsign union (don't overwrite).
            if (f.computerIds) {
                let u = cidUnionByCallsign.get(f.callsign);
                if (!u) cidUnionByCallsign.set(f.callsign, u = {});
                for (const k in f.computerIds) if (!(k in u)) u[k] = f.computerIds[k];
            }
            if (f.flightStatus === 'CANCELLED') continue;
            // Mirror isVisible() status/age guards — a flight that would fail isVisible()
            // must never win dedup and shadow a visible sibling GUFI
            if (f.latitude == null || f.longitude == null) continue;
            if (f.flightStatus === 'DROPPED' && (f.posAge == null || f.posAge > 60)) continue;
            if (f.flightStatus && f.flightStatus !== 'ACTIVE' && f.flightStatus !== 'DROPPED') continue;
            if (f.flightStatus === 'ACTIVE' && effAgeSec(f) > 300 && !f.handoffEvent) continue;
            const cs = f.callsign;
            const prev = bestGufiByCallsign.get(cs);
            if (!prev) { bestGufiByCallsign.set(cs, gufi); continue; }
            const prevF = flights.get(prev);
            const prevHasPos = prevF.latitude != null && prevF.longitude != null;
            const curHasPos = f.latitude != null && f.longitude != null;
            // Strong preference: has position beats no position
            if (curHasPos && !prevHasPos) { bestGufiByCallsign.set(cs, gufi); continue; }
            if (!curHasPos && prevHasPos) continue;
            const prevAge = effAgeSec(prevF);
            const curAge = effAgeSec(f);
            // A clearly-fresh track beats a clearly-stale one regardless of facility — stops a
            // frozen ghost (old ARTCC, server stopped updating it) from suppressing the live track.
            if (curAge < 60 && prevAge > 120) { bestGufiByCallsign.set(cs, gufi); continue; }
            if (prevAge < 60 && curAge > 120) continue;
            // Both comparably fresh: prefer our facility
            const prevFac = prevF.controllingFacility || prevF.reportingFacility || '';
            const curFac = f.controllingFacility || f.reportingFacility || '';
            if (curFac === myFacility && prevFac !== myFacility) {
                bestGufiByCallsign.set(cs, gufi);
                continue;
            }
            if (prevFac === myFacility && curFac !== myFacility) continue;
            // Both same facility (or neither ours): prefer fresher track
            // But add hysteresis — current winner must be 15s staler to lose (prevents flip-flop)
            if (curAge + 15 < prevAge) {
                bestGufiByCallsign.set(cs, gufi);
            }
        }
    }

    for (const [gufi, f] of flights) {
        if (!isVisible(f)) continue;
        // Skip duplicate callsigns — only show the best GUFI per callsign
        if (isDedupHidden(gufi, f)) continue;
        // Skip flights whose CID has been recycled to another active flight
        if (isCidRecycled(gufi, f)) continue;
        // Skip manually hidden flights (middle-click cycle or QX command)
        if (manuallyHidden.has(gufi)) continue;
        lastVisibleAt.set(gufi, now);  // stamp for grace period

        const cls = classifyTrack(f);
        counts[cls]++;

        // Sticky FDB: when a track transitions from own/ho to other, keep FDB
        if (cls === 'own' || cls === 'ho') {
            wasOwnOrHo.add(gufi);
        } else if (cls === 'other' && wasOwnOrHo.has(gufi) && !fdbOverrides.has(gufi)) {
            fdbOverrides.set(gufi, true);
        }

        // Viewport culling — count all visible flights but only render on-screen ones
        const ll = displayPosition(f);
        if (!mapBounds.contains(ll)) continue;

        onScreenGufis.add(gufi);
        const hash = flightHash(f, cls);

        const existing = markers.get(gufi);
        if (existing) {
            existing.setLatLng(ll);
            const el = existing.getElement();
            if (el) {
                // Unhide if previously hidden (flight became visible again)
                if (el.style.display === 'none') el.style.display = '';
                // Only rebuild HTML when flight data actually changes
                if (el._lastHash !== hash) {
                    el.innerHTML = buildMarkerHtml(f, cls);
                    el._lastHash = hash;
                    // Re-apply dwell emphasis after rebuild
                    if (dwellLocked.has(gufi) || el._isHovering) applyDwell(el, gufi);
                }
            }
        } else {
            const html = buildMarkerHtml(f, cls);
            const icon = L.divIcon({ className: 'ac-group', html, iconSize: [0, 0], iconAnchor: [0, 0] });
            const m = L.marker(ll, { icon, pane: 'targets', interactive: false });
            m.addTo(map);
            const el = m.getElement();
            if (el) {
                el._lastHash = hash;
                el.style.pointerEvents = 'auto';
                el.style.cursor = 'inherit';
                el._isHovering = false;
                el._gufi = gufi;
                // Dwell emphasis — hover
                el.addEventListener('mouseenter', () => {
                    el._isHovering = true;
                    applyDwell(el, gufi);
                });
                el.addEventListener('mouseleave', () => {
                    el._isHovering = false;
                    if (!dwellLocked.has(gufi)) removeDwell(el, gufi);
                });
                // Click: VCI hit area → toggle VCI; Field A → dwell lock; MCA has text → insert target ▽; else → toggle
                el.addEventListener('click', (e) => {
                    // Target symbol priority: if click is on another target's symbol, redirect
                    const redirectGufi = findTargetUnderClick(e, gufi);
                    if (redirectGufi) {
                        if (mca.text.trim().length > 0) {
                            e.stopPropagation();
                            const rf = flights.get(redirectGufi);
                            const rflid = getFlid(rf);
                            if (rflid) mcaInsertTarget(rflid);
                        } else {
                            toggleTrackSelect(redirectGufi);
                        }
                        return;
                    }
                    // Point-out Line 0: P → open menu; A → remove indicator (CRC spec)
                    if (e.target.closest('.ac-po-line0')) {
                        const pf = flights.get(gufi);
                        if (pf) {
                            const poInfo = getPointoutIndicator(pf);
                            if (poInfo) {
                                if (poInfo.cls === 'accepted') {
                                    // Click A (originator) → remove indicator from FDB
                                    pointoutAcked.delete(pf.gufi);
                                    pf.pointoutOriginatingUnit = null;
                                    pf.pointoutReceivingUnit = null;
                                    closePointoutMenu();
                                    invalidateMarker(pf.gufi);
                                } else {
                                    // Click P (either role) → open pop-up menu
                                    openPointoutMenu(pf, poInfo, e.clientX, e.clientY);
                                }
                            }
                        }
                        return;
                    }
                    // VCI toggle: click on Column 0 hit area
                    if (e.target.closest('.ac-vci-hit')) {
                        if (vciActive.has(gufi)) vciActive.delete(gufi);
                        else vciActive.add(gufi);
                        el._lastHash = '';
                        lastRenderTime = 0;
                        return;
                    }
                    // HSF indicator toggle: click ↴ to switch line 4 between DEST/TYPE and HSF
                    if (e.target.closest('.ac-hsf-ind')) {
                        if (hsfShowMap.has(gufi)) hsfShowMap.delete(gufi);
                        else hsfShowMap.add(gufi);
                        el._lastHash = '';
                        lastRenderTime = 0;
                        return;
                    }
                    const dbEl = el.querySelector('.ac-db');
                    if (dbEl) {
                        const rect = dbEl.getBoundingClientRect();
                        // Offset Field A detection when Line 0 (point-out) is present
                        const lf = flights.get(gufi);
                        const hasL0 = lf && getPointoutIndicator(lf);
                        const fieldATop = rect.top + (hasL0 ? LINE_H : 0);
                        if (e.clientX >= rect.left && e.clientX <= rect.right &&
                            e.clientY >= fieldATop && e.clientY <= fieldATop + LINE_H) {
                            // Click on Field A → toggle dwell lock
                            if (dwellLocked.has(gufi)) {
                                dwellLocked.delete(gufi);
                                if (!el._isHovering) removeDwell(el, gufi);
                            } else {
                                dwellLocked.add(gufi);
                                applyDwell(el, gufi);
                            }
                            return;
                        }
                        // Field menu detection (FDB only): line 2 = altitude, line 3 = heading/speed, line 4 = free text
                        if (dbEl.classList.contains('fdb') && mca.text.trim().length === 0) {
                            const lineIdx = Math.floor((e.clientY - fieldATop) / LINE_H);
                            if (lineIdx === 1) { // Line 2: altitude
                                openAltMenu(gufi, e.clientX, e.clientY);
                                return;
                            }
                            if (lineIdx === 2) { // Line 3: CID (left) / Field E (right)
                                const col0W = CHAR_W * 1.5;
                                const charPos = (e.clientX - rect.left - col0W) / CHAR_W;
                                if (charPos < 5) {
                                    openHdgMenu(gufi, e.clientX, e.clientY); // Field D (CID area) → heading
                                } else {
                                    openSpdMenu(gufi, e.clientX, e.clientY); // Field E → speed
                                }
                                return;
                            }
                            if (lineIdx === 3) { // Line 4: HSF area
                                const lfm = flights.get(gufi);
                                const hsf = lfm ? getEffectiveHsf(lfm) : null;
                                if (hsf && hsf.freeText) {
                                    openTxtMenu(gufi, e.clientX, e.clientY);
                                } else if (hsf && hsf.heading) {
                                    openHdgMenu(gufi, e.clientX, e.clientY);
                                } else if (hsf && hsf.speed) {
                                    openSpdMenu(gufi, e.clientX, e.clientY);
                                }
                                return;
                            }
                        }
                    }
                    // If MCA has content, left-click inserts a ▽ target placeholder
                    if (mca.text.trim().length > 0) {
                        e.stopPropagation(); // prevent map click from also firing
                        const f = flights.get(gufi);
                        const flid = getFlid(f);
                        if (flid) mcaInsertTarget(flid);
                        return;
                    }
                    // Left-click does NOT toggle FDB/LDB — use middle-click on target symbol
                });
                // Middle-click: target symbol → toggle FDB/LDB; Field A → QF; VCI → toggle; MCA content → CID Enter
                el.addEventListener('auxclick', (e) => {
                    if (e.button !== 1) return;
                    e.preventDefault();
                    // Target symbol priority: if click is on another target's symbol, redirect
                    const redirectGufi = findTargetUnderClick(e, gufi);
                    if (redirectGufi) {
                        if (mca.text.trim().length > 0) {
                            const rf = flights.get(redirectGufi);
                            const rflid = getFlid(rf);
                            if (rflid) {
                                if (mca.text[mca.text.length - 1] !== ' ') mca.text += ' ';
                                mca.text += rflid;
                                mca.cursor = mca.text.length;
                                mcaExecute();
                            }
                        } else {
                            toggleTrackSelect(redirectGufi);
                        }
                        return;
                    }
                    // Check if click is on the target symbol (within 8px of marker center)
                    const markerPos = map.latLngToContainerPoint(m.getLatLng());
                    const onTarget = Math.abs(e.clientX - markerPos.x - mapEl.getBoundingClientRect().left) <= 8
                                  && Math.abs(e.clientY - markerPos.y - mapEl.getBoundingClientRect().top) <= 8;
                    if (onTarget) {
                        // MCA has content → middle-click target = append FLID + execute (CRC spec)
                        if (mca.text.trim().length > 0) {
                            const tf = flights.get(gufi);
                            const tflid = getFlid(tf);
                            if (tflid) {
                                if (mca.text[mca.text.length - 1] !== ' ') mca.text += ' ';
                                mca.text += tflid;
                                mca.cursor = mca.text.length;
                                mcaExecute();
                            }
                        } else {
                            toggleTrackSelect(gufi);
                        }
                        return;
                    }
                    // Point-out Line 0: P → open menu; A → remove indicator (CRC spec)
                    if (e.target.closest('.ac-po-line0')) {
                        const pf = flights.get(gufi);
                        if (pf) {
                            const poInfo = getPointoutIndicator(pf);
                            if (poInfo) {
                                if (poInfo.cls === 'accepted') {
                                    // Click A (originator) → remove indicator from FDB
                                    pointoutAcked.delete(pf.gufi);
                                    pf.pointoutOriginatingUnit = null;
                                    pf.pointoutReceivingUnit = null;
                                    closePointoutMenu();
                                    invalidateMarker(pf.gufi);
                                } else {
                                    // Click P (either role) → open pop-up menu
                                    openPointoutMenu(pf, poInfo, e.clientX, e.clientY);
                                }
                            }
                        }
                        return;
                    }
                    // VCI hit area: toggle VCI
                    if (e.target.closest('.ac-vci-hit')) {
                        if (vciActive.has(gufi)) vciActive.delete(gufi);
                        else vciActive.add(gufi);
                        el._lastHash = '';
                        lastRenderTime = 0;
                        return;
                    }
                    // HSF indicator: toggle HSF display on line 4
                    if (e.target.closest('.ac-hsf-ind')) {
                        if (hsfShowMap.has(gufi)) hsfShowMap.delete(gufi);
                        else hsfShowMap.add(gufi);
                        el._lastHash = '';
                        lastRenderTime = 0;
                        return;
                    }
                    const f = flights.get(gufi);
                    if (!f) return;
                    const flid = getFlid(f);
                    // Field A (line 1): middle-click → execute QF
                    const dbEl = el.querySelector('.ac-db');
                    if (dbEl) {
                        const rect = dbEl.getBoundingClientRect();
                        // Offset Field A detection when Line 0 (point-out) is present
                        const hasL0 = f && getPointoutIndicator(f);
                        const fieldATop = rect.top + (hasL0 ? LINE_H : 0);
                        if (e.clientX >= rect.left && e.clientX <= rect.right &&
                            e.clientY >= fieldATop && e.clientY <= fieldATop + LINE_H) {
                            showFlightInRA(f);
                            return;
                        }
                        // Field menu detection (FDB only, middle-click): same as left-click
                        if (dbEl.classList.contains('fdb') && mca.text.trim().length === 0) {
                            const lineIdx = Math.floor((e.clientY - fieldATop) / LINE_H);
                            if (lineIdx === 1) { openAltMenu(gufi, e.clientX, e.clientY); return; }
                            if (lineIdx === 2) {
                                const col0W = CHAR_W * 1.5;
                                const charPos = (e.clientX - rect.left - col0W) / CHAR_W;
                                if (charPos < 5) openHdgMenu(gufi, e.clientX, e.clientY);
                                else openSpdMenu(gufi, e.clientX, e.clientY);
                                return;
                            }
                            if (lineIdx === 3) {
                                const hsf = getEffectiveHsf(f);
                                if (hsf && hsf.freeText) openTxtMenu(gufi, e.clientX, e.clientY);
                                else if (hsf && hsf.heading) openHdgMenu(gufi, e.clientX, e.clientY);
                                else if (hsf && hsf.speed) openSpdMenu(gufi, e.clientX, e.clientY);
                                return;
                            }
                        }
                    }
                    // Middle-click on data block area:
                    //   MCA has content → append FLID + execute (CID Enter)
                    if (mca.text.trim().length > 0 && flid) {
                        if (mca.text.length > 0 && mca.text[mca.text.length - 1] !== ' ') {
                            mca.text += ' ';
                        }
                        mca.text += flid;
                        mca.cursor = mca.text.length;
                        mcaExecute();
                    }
                });
            }
            markers.set(gufi, m);
        }
    }

    // Persistent markers: only REMOVE markers for flights that no longer exist (server removed).
    // All other off-screen/invisible flights just get hidden — no DOM destroy/recreate flicker.
    for (const [gufi, m] of markers) {
        if (!flights.has(gufi)) {
            map.removeLayer(m);
            markers.delete(gufi);
        } else if (!onScreenGufis.has(gufi)) {
            const el = m.getElement();
            if (el && el.style.display !== 'none') el.style.display = 'none';
        }
    }

    // Redraw canvas overlay
    drawOverlay();

    // Update counters
    document.getElementById('cnt-own').textContent = counts.own;
    document.getElementById('cnt-ho').textContent = counts.ho;
    document.getElementById('cnt-other').textContent = counts.other;
    document.getElementById('cnt-total').textContent = counts.own + counts.ho + counts.other + counts.emrg;
}

requestAnimationFrame(render);

// ── Handoff flash timer (500ms) ─────────────────────────────────────────────
// Updates DATA BLOCK TEXT for tracks in active handoff OR completed handoff (O display).
// Does NOT rebuild the entire marker — symbol and leader line stay intact.
setInterval(() => {
    // Update global flash reference — ALL tracks see the same phase
    flashTime = performance.now();

    // Cleanup expired hoCompletedInfo entries
    for (const [gufi, info] of hoCompletedInfo) {
        if (flashTime - info.time >= 60000) hoCompletedInfo.delete(gufi);
    }

    for (const [gufi, m] of markers) {
        const f = flights.get(gufi);
        if (!f) continue;

        const hasActiveHo = hoEventType(f.handoffEvent) && f.handoffReceiving;
        const hasCompletedHo = hoCompletedInfo.has(gufi);
        if (!hasActiveHo && !hasCompletedHo) continue;

        const el = m.getElement();
        if (!el) continue;
        const dbEl = el.querySelector('.ac-db');
        if (!dbEl) continue;
        const cls = classifyTrack(f);
        if (shouldShowFdb(gufi, cls)) {
            // Column 0 is inline — just regenerate full HTML (includes R, VCI)
            // Preserve dwell border if present during innerHTML update
            const hasDwell = dbEl.classList.contains('dwell');
            const dwellBorder = hasDwell ? dbEl.querySelector('.dwell-border') : null;
            dbEl.innerHTML = formatFdbHtml(f, cls);
            if (dwellBorder && hasDwell) {
                dbEl.appendChild(dwellBorder);
            }
        }
    }
}, 500);

// ════════════════════════════════════════════════════════════════════════════
// Sidebar controls
// ════════════════════════════════════════════════════════════════════════════
document.getElementById('sidebar-toggle').addEventListener('click', function () {
    const sidebar = document.getElementById('sidebar');
    sidebar.classList.toggle('collapsed');
    this.innerHTML = sidebar.classList.contains('collapsed') ? '&#9654;' : '&#9664;';
});

document.getElementById('sel-facility').addEventListener('change', function () {
    myFacility = this.value;
    mySectors.clear();
    // Changing facility: revert all tracks to default LDB
    fdbOverrides.clear();
    quickLookSectors.clear();
    quickLookDests.clear();
    wasOwnOrHo.clear();
    manuallyHidden.clear();
    pointoutBlocked.clear();
    closePointoutMenu();
    invalidateAllMarkers();
    rebuildSectorCheckboxes();
    showBoundariesForFacility(myFacility);
    zoomToFacility(myFacility);
    saveSettingsToLocalStorage();
});

document.getElementById('chk-facility-only').addEventListener('change', function () {
    facilityOnly = this.checked;
    invalidateAllMarkers();
    saveSettingsToLocalStorage();
});

document.getElementById('sel-histcount').addEventListener('change', function () {
    MAX_HISTORY = parseInt(this.value);
    for (const [, hist] of flightHistory) {
        while (hist.length > MAX_HISTORY) hist.shift();
    }
    invalidateAllMarkers();
    saveSettingsToLocalStorage();
});

document.getElementById('rng-ldb-brightness').addEventListener('input', function () {
    ldbBrightness = parseInt(this.value);
    document.getElementById('lbl-ldb-brightness').textContent = ldbBrightness;
    saveSettingsToLocalStorage();
});

document.getElementById('sel-vector').addEventListener('change', function () {
    vectorMinutes = parseInt(this.value);
    invalidateAllMarkers();
    saveSettingsToLocalStorage();
});

document.getElementById('sel-line4').addEventListener('change', function () {
    line4Mode = this.value;
    invalidateAllMarkers();
    saveSettingsToLocalStorage();
});

for (const [cat, id] of Object.entries(BOUNDARY_CAT_SLIDER)) {
    const lblId = BOUNDARY_CAT_LABEL[cat];
    document.getElementById(id).addEventListener('input', function () {
        setBoundaryBrightness(cat, parseInt(this.value));
        document.getElementById(lblId).textContent = this.value;
    });
    document.getElementById(id).addEventListener('change', function () {
        setBoundaryBrightness(cat, parseInt(this.value));
        document.getElementById(lblId).textContent = this.value;
        saveSettingsToLocalStorage();
    });
}

document.getElementById('chk-mapbg').addEventListener('change', function () {
    showMapBg = this.checked;
    if (showMapBg) tileLayer.addTo(map);
    else map.removeLayer(tileLayer);
    saveSettingsToLocalStorage();
});

document.getElementById('chk-mca-kb').addEventListener('change', function () {
    document.getElementById('mca').classList.toggle('show-kb', this.checked);
    saveSettingsToLocalStorage();
});

const chkMca = document.getElementById('chk-mca');
const chkRa = document.getElementById('chk-ra');
const chkTime = document.getElementById('chk-time');
if (chkMca) {
    chkMca.addEventListener('change', function () {
        const mca = document.getElementById('mca');
        if (mca) mca.style.display = this.checked ? 'block' : 'none';
        saveSettingsToLocalStorage();
    });
}
if (chkRa) {
    chkRa.addEventListener('change', function () {
        const ra = document.getElementById('ra');
        if (ra) ra.style.display = this.checked ? 'block' : 'none';
        saveSettingsToLocalStorage();
    });
}
if (chkTime) {
    chkTime.addEventListener('change', function () {
        const timeView = document.getElementById('time-view');
        if (timeView) timeView.style.display = this.checked ? 'block' : 'none';
        saveSettingsToLocalStorage();
    });
}

// Transp MCA: reserved for future use
// document.getElementById('chk-transp-mca').addEventListener('change', function () {
//     document.getElementById('map-container').classList.toggle('transp-mca', this.checked);
//     saveSettingsToLocalStorage();
// });

document.getElementById('btn-fullscreen').addEventListener('click', function () {
    if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
    } else {
        document.exitFullscreen();
    }
});

document.getElementById('sel-fontsize').addEventListener('change', function () {
    fontSize = parseInt(this.value);
    updateFontSize();
    saveSettingsToLocalStorage();
});

document.getElementById('inp-alt-low').addEventListener('change', function () {
    altFilterLow = parseInt(this.value) || 0;
    saveSettingsToLocalStorage();
});

document.getElementById('inp-alt-high').addEventListener('change', function () {
    altFilterHigh = parseInt(this.value) || 999;
    saveSettingsToLocalStorage();
});

function updateScopeBackground() {
    const b = scopeBckgrd / 100;
    const l = scopeBcklght / 100;
    const blue = Math.floor(b * (82 + 45 * l));
    const color = `rgb(0,0,${blue})`;
    const lc = document.querySelector('.leaflet-container');
    if (lc) lc.style.setProperty('background', color, 'important');

    // Apply backlight to toolbar and floating tearoffs
    const backlightFactor = 0.6 + (l * 0.5);
    const toolbarPanel = document.getElementById('master-toolbar-container');
    if (toolbarPanel) {
        toolbarPanel.style.filter = `brightness(${backlightFactor})`;
    }

    // Apply backlight to tearoff button (visibility toggle)
    const tearoffContainer = document.getElementById('tb-tearoff');
    if (tearoffContainer) {
        tearoffContainer.style.filter = `brightness(${backlightFactor})`;
    }

    // Update floating tearoff colors with backlight (floating menus inherit this since they're children)
    for (const [, tearoff] of activeTearoffs) {
        if (tearoff.floatingEl) {
            tearoff.floatingEl.style.filter = `brightness(${backlightFactor})`;
        }
    }

    updateToolbarBrightness();
}

function updateButtonBrightness() {
    updateToolbarBrightness();
}

function updateBorderBrightness() {
    try {
        // Border brightness: 0-1, where 1=white, 0=black
        const borderFactor = tbState.bright.border / 100;

        // Create or update dynamic CSS for borders
        let styleEl = document.getElementById('dynamic-border-brightness');
        if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = 'dynamic-border-brightness';
            document.head.appendChild(styleEl);
        }

        // Interpolate border color from white (at 100) to black (at 0)
        const borderColor = interpolateColor('#FFFFFF', borderFactor);

        styleEl.textContent = `
            .tb-btn {
                border-top-color: ${borderColor} !important;
                border-right-color: ${borderColor} !important;
                border-bottom-color: ${borderColor} !important;
                border-left-color: ${borderColor} !important;
            }
            .tb-btn .tb-tear { border-right-color: ${borderColor} !important; }
        `;
    } catch (e) {
        // tbState not yet initialized
    }
}

function updateToolbarBackgroundBrightness() {
    try {
        // Toolbar brightness: 0-1, where 1=#C5C5C5 (light gray), 0=black
        const toolbarFactor = tbState.bright.toolbar / 100;

        // Create or update dynamic CSS for toolbar background
        let styleEl = document.getElementById('dynamic-toolbar-bg-brightness');
        if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = 'dynamic-toolbar-bg-brightness';
            document.head.appendChild(styleEl);
        }

        // Interpolate toolbar background from light gray (at 100) to black (at 0)
        const toolbarBgColor = interpolateColor('#C5C5C5', toolbarFactor);

        styleEl.textContent = `
            #master-toolbar-container { background-color: ${toolbarBgColor} !important; }
            .tb-master-grid { background-color: ${toolbarBgColor} !important; }
            .tb-submenu { background-color: ${toolbarBgColor} !important; }
            .tb-side-bar { background-color: ${toolbarBgColor} !important; }
            .tb-side-bar .tb-arrow-btn { background-color: ${toolbarBgColor} !important; }
            .tb-side-bar .tb-arrow-btn:hover { background-color: ${interpolateColor('#D3D3D3', toolbarFactor)} !important; }
        `;
    } catch (e) {
        // tbState not yet initialized
    }
}

function updateTextBrightness() {
    try {
        // Text brightness: 0-1, where 1=#F3F3F3 (light gray/white), 0=black
        const textFactor = tbState.bright.text / 100;

        // Create or update dynamic CSS for text color
        let styleEl = document.getElementById('dynamic-text-brightness');
        if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = 'dynamic-text-brightness';
            document.head.appendChild(styleEl);
        }

        // Interpolate text color from light gray (at 100) to black (at 0)
        const textColor = interpolateColor('#F3F3F3', textFactor);

        styleEl.textContent = `
            .tb-btn .tb-label { color: ${textColor} !important; }
            .tb-btn .tb-value { color: ${textColor} !important; }
            .tb-btn .tb-menu-ind { color: ${textColor} !important; }
            #tb-tearoff-btn .tb-tearoff-label { color: ${textColor} !important; }
        `;
    } catch (e) {
        // tbState not yet initialized
    }
}

function updateToolbarBorderColor() {
    try {
        // Toolbar border brightness: 0-1, where 1=white, 0=black
        const borderFactor = tbState.bright.tbBrdr / 100;

        // Create or update dynamic CSS for toolbar border
        let styleEl = document.getElementById('dynamic-toolbar-border-color');
        if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = 'dynamic-toolbar-border-color';
            document.head.appendChild(styleEl);
        }

        // Interpolate border color from white (at 100) to black (at 0)
        const borderColor = interpolateColor('#FFFFFF', borderFactor);

        styleEl.textContent = `
            #master-toolbar-container { border-bottom: 1px solid ${borderColor} !important; }
        `;
    } catch (e) {
        // tbState not yet initialized
    }
}

function updateCursorBrightness() {
    try {
        // Cursor brightness: 0-1, where 1=white, 0=black
        const cursorFactor = tbState.bright.cursor / 100;

        // Interpolate cursor stroke color from white (at 100) to black (at 0)
        const cursorColor = interpolateColor('#FFFFFF', cursorFactor);

        // Create dynamic CSS with updated cursor SVG
        let styleEl = document.getElementById('dynamic-cursor-brightness');
        if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = 'dynamic-cursor-brightness';
            document.head.appendChild(styleEl);
        }

        // Generate new SVG cursor with interpolated color
        const cursorSvg = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32'%3E%3Cline x1='16' y1='9' x2='16' y2='12' stroke='${encodeURIComponent(cursorColor)}' stroke-width='4.5'/%3E%3Cline x1='16' y1='20' x2='16' y2='23' stroke='${encodeURIComponent(cursorColor)}' stroke-width='4.5'/%3E%3Cline x1='9' y1='16' x2='12' y2='16' stroke='${encodeURIComponent(cursorColor)}' stroke-width='4.5'/%3E%3Cline x1='20' y1='16' x2='23' y2='16' stroke='${encodeURIComponent(cursorColor)}' stroke-width='4.5'/%3E%3Crect x='12' y='12' width='8' height='8' fill='none' stroke='${encodeURIComponent(cursorColor)}' stroke-width='1.3'/%3E%3C/svg%3E") 16 16, crosshair`;

        styleEl.textContent = `
            :root { --eram-cursor: ${cursorSvg}; }
        `;
    } catch (e) {
        // tbState not yet initialized
    }
}

function interpolateColor(hexColor, factor) {
    // Parse hex color (e.g., #00CD00 -> [0, 205, 0])
    const r = parseInt(hexColor.slice(1, 3), 16);
    const g = parseInt(hexColor.slice(3, 5), 16);
    const b = parseInt(hexColor.slice(5, 7), 16);

    // Interpolate toward black: color * factor + black * (1 - factor)
    const newR = Math.round(r * factor);
    const newG = Math.round(g * factor);
    const newB = Math.round(b * factor);

    return `rgb(${newR}, ${newG}, ${newB})`;
}

function updateToolbarBrightness() {
    try {
        // Button brightness: 0-1, where 1=full color, 0=black
        const buttonFactor = tbState.bright.button / 100;

        // Backlight factor: 0.6-1.0 range (affects tearoff color for floating buttons)
        const backlightFactor = 0.6 + ((scopeBcklght / 100) * 0.5);

        // Combined factor for floating tearoff colors
        const combinedFactor = buttonFactor * backlightFactor;

        // Create or update dynamic CSS for button backgrounds
        let styleEl = document.getElementById('dynamic-button-brightness');
        if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = 'dynamic-button-brightness';
            document.head.appendChild(styleEl);
        }

        // Define original button colors
        const colors = {
            'tb-green': '#00CD00',
            'tb-blue': '#0000D4',
            'tb-tan': '#DCA09B',
            'tb-teal': '#00C7D1',
            'tb-dark': '#000000',
            'tb-toggle-grey': '#000000',
            'tb-nosim': '#000066',
            'tb-toggle-on': '#0000D4',
            'tb-menu-open': '#DCA09B',
        };

        // Generate CSS with interpolated colors
        let css = '';
        for (const [className, color] of Object.entries(colors)) {
            const interpolated = interpolateColor(color, buttonFactor);
            css += `.tb-btn.${className} { background: ${interpolated} !important; }\n`;
        }

        // Toggle grey ON state (light gray)
        css += `.tb-btn.tb-toggle-grey.tb-toggle-on { background: ${interpolateColor('#C7C7C7', buttonFactor)} !important; }\n`;

        // Default button color
        css += `.tb-btn { background: ${interpolateColor('#0000D4', buttonFactor)} !important; }\n`;

        // Tearoff strip color (interpolate toward black with backlight)
        const tearoffColor = interpolateColor('#FFFFA1', combinedFactor);
        css += `.tb-btn .tb-tear { background: ${tearoffColor} !important; }\n`;

        // Disabled tearoff strip color (interpolate grey toward black with backlight)
        const disabledTearoffColor = interpolateColor('#C7C7C7', combinedFactor);
        css += `.tb-btn .tb-tear.tb-tear-disabled { background: ${disabledTearoffColor} !important; }\n`;

        // Toolbar toggle button (#tb-tearoff-btn) — green button that shows/hides the toolbar
        const tearoffBtnColor = interpolateColor('#00CD00', buttonFactor);
        css += `#tb-tearoff-btn { background: ${tearoffBtnColor} !important; }\n`;
        css += `#tb-tearoff-btn:hover { background: ${tearoffBtnColor} !important; }\n`;

        // Toolbar toggle button gold strip (affected by backlight like button tearoff strips)
        const tearoffBtnGoldColor = interpolateColor('#FFFFA1', combinedFactor);
        css += `#tb-tearoff-btn .tb-gold-strip { background: ${tearoffBtnGoldColor} !important; }\n`;

        styleEl.textContent = css;
    } catch (e) {
        // tbState not yet initialized
    }
}

function updateFdbBrightness() {
    try {
        // FDB brightness: 0-1, where 1=#FFFF44 (bright yellow), 0=black
        // At 30% brightness, color is #606038 to avoid greenish mid-tones
        const brightness = tbState.bright.fdb;

        // Create or update dynamic CSS for FDB color
        let styleEl = document.getElementById('dynamic-fdb-brightness');
        if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = 'dynamic-fdb-brightness';
            document.head.appendChild(styleEl);
        }

        // Piecewise interpolation: black → #606038 (0-30) → #FFFF44 (30-100)
        let fdbColor;
        if (brightness <= 30) {
            // 0-30: interpolate from black to #606038
            const factor = brightness / 30;
            fdbColor = interpolateColor('#606038', factor);
        } else {
            // 30-100: interpolate from #606038 to #FFFF44
            const factor = (brightness - 30) / 70;
            const r0 = 96, g0 = 96, b0 = 56;  // #606038
            const r1 = 255, g1 = 255, b1 = 68;  // #FFFF44
            const r = Math.round(r0 + (r1 - r0) * factor);
            const g = Math.round(g0 + (g1 - g0) * factor);
            const b = Math.round(b0 + (b1 - b0) * factor);
            fdbColor = `rgb(${r}, ${g}, ${b})`;
        }

        // Update global TRACK_COLOR for canvas vector drawing
        TRACK_COLOR = fdbColor;
        // Force immediate canvas redraw
        lastRenderTime = 0;

        styleEl.textContent = `
            .ac-col0 { color: ${fdbColor} !important; }
            .fdb { color: ${fdbColor} !important; }
            .ac-po-pending, .ac-po-accepted { color: ${fdbColor} !important; }
            .fdb-leader line { stroke: ${fdbColor} !important; }
            .ac-sym-flat-track { border-color: ${fdbColor} !important; }
            .fdb.dwell { color: #FFFF44 !important; }
            .fdb.dwell .ac-col0 { color: #FFFF44 !important; }
            .fdb.dwell .ac-po-pending, .fdb.dwell .ac-po-accepted { color: #FFFF44 !important; }
            .fdb-leader.dwell line { stroke: #FFFF44 !important; }
            .ac-sym-flat-track.dwell { border-color: #FFFF44 !important; }
        `;
    } catch (e) {
        // tbState not yet initialized
    }
}

function updateLdbBrightness() {
    try {
        // LDB brightness: same color interpolation as FDB but for limited data blocks
        const brightness = tbState.bright.ldb;

        // Create or update dynamic CSS for LDB color
        let styleEl = document.getElementById('dynamic-ldb-brightness');
        if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = 'dynamic-ldb-brightness';
            document.head.appendChild(styleEl);
        }

        // Piecewise interpolation: black → #606038 (0-30) → #FFFF44 (30-100)
        let ldbColor;
        if (brightness <= 30) {
            // 0-30: interpolate from black to #606038
            const factor = brightness / 30;
            ldbColor = interpolateColor('#606038', factor);
        } else {
            // 30-100: interpolate from #606038 to #FFFF44
            const factor = (brightness - 30) / 70;
            const r0 = 96, g0 = 96, b0 = 56;  // #606038
            const r1 = 255, g1 = 255, b1 = 68;  // #FFFF44
            const r = Math.round(r0 + (r1 - r0) * factor);
            const g = Math.round(g0 + (g1 - g0) * factor);
            const b = Math.round(b0 + (b1 - b0) * factor);
            ldbColor = `rgb(${r}, ${g}, ${b})`;
        }

        styleEl.textContent = `
            .ldb { color: ${ldbColor} !important; }
            .ldb.dwell { color: #FFFF44 !important; }
        `;
    } catch (e) {
        // tbState not yet initialized
    }
}

function updateOnFreqBrightness() {
    try {
        // ON-FREQ brightness: same color interpolation as FDB
        const brightness = tbState.bright.onFreq;

        // Create or update dynamic CSS for ON-FREQ color
        let styleEl = document.getElementById('dynamic-onfreq-brightness');
        if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = 'dynamic-onfreq-brightness';
            document.head.appendChild(styleEl);
        }

        // Piecewise interpolation: black → #606038 (0-30) → #FFFF44 (30-100)
        let onFreqColor;
        if (brightness <= 30) {
            // 0-30: interpolate from black to #606038
            const factor = brightness / 30;
            onFreqColor = interpolateColor('#606038', factor);
        } else {
            // 30-100: interpolate from #606038 to #FFFF44
            const factor = (brightness - 30) / 70;
            const r0 = 96, g0 = 96, b0 = 56;  // #606038
            const r1 = 255, g1 = 255, b1 = 68;  // #FFFF44
            const r = Math.round(r0 + (r1 - r0) * factor);
            const g = Math.round(g0 + (g1 - g0) * factor);
            const b = Math.round(b0 + (b1 - b0) * factor);
            onFreqColor = `rgb(${r}, ${g}, ${b})`;
        }

        styleEl.textContent = `
            .on-freq { color: ${onFreqColor} !important; }
            .on-freq.dwell { color: #FFFF44 !important; }
        `;
    } catch (e) {
        // tbState not yet initialized
    }
}

function updatePrTgtBrightness() {
    try {
        // PR TGT brightness: same color interpolation as FDB for paired target symbols
        const brightness = tbState.bright.prTgtr;

        // Create or update dynamic CSS for PR TGT color
        let styleEl = document.getElementById('dynamic-prtgt-brightness');
        if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = 'dynamic-prtgt-brightness';
            document.head.appendChild(styleEl);
        }

        // Piecewise interpolation: black → #606038 (0-30) → #FFFF44 (30-100)
        let prTgtColor;
        if (brightness <= 30) {
            // 0-30: interpolate from black to #606038
            const factor = brightness / 30;
            prTgtColor = interpolateColor('#606038', factor);
        } else {
            // 30-100: interpolate from #606038 to #FFFF44
            const factor = (brightness - 30) / 70;
            const r0 = 96, g0 = 96, b0 = 56;  // #606038
            const r1 = 255, g1 = 255, b1 = 68;  // #FFFF44
            const r = Math.round(r0 + (r1 - r0) * factor);
            const g = Math.round(g0 + (g1 - g0) * factor);
            const b = Math.round(b0 + (b1 - b0) * factor);
            prTgtColor = `rgb(${r}, ${g}, ${b})`;
        }

        styleEl.textContent = `
            div[style*="rotate(-45deg)"] { background: ${prTgtColor} !important; }
            div[style*="border-radius:50%"] { background: ${prTgtColor} !important; }
        `;
    } catch (e) {
        // tbState not yet initialized
    }
}

function updatePrHistBrightness() {
    try {
        // PR HIST brightness: same color interpolation as FDB for paired target history
        const brightness = tbState.bright.prHist;

        // Piecewise interpolation: black → #606038 (0-30) → #FFFF44 (30-100)
        let prHistColor;
        if (brightness <= 30) {
            // 0-30: interpolate from black to #606038
            const factor = brightness / 30;
            prHistColor = interpolateColor('#606038', factor);
        } else {
            // 30-100: interpolate from #606038 to #FFFF44
            const factor = (brightness - 30) / 70;
            const r0 = 96, g0 = 96, b0 = 56;  // #606038
            const r1 = 255, g1 = 255, b1 = 68;  // #FFFF44
            const r = Math.round(r0 + (r1 - r0) * factor);
            const g = Math.round(g0 + (g1 - g0) * factor);
            const b = Math.round(b0 + (b1 - b0) * factor);
            prHistColor = `rgb(${r}, ${g}, ${b})`;
        }

        // Update global PR_HIST_COLOR for canvas history drawing
        PR_HIST_COLOR = prHistColor;
        // Force immediate canvas redraw
        lastRenderTime = 0;
    } catch (e) {
        // tbState not yet initialized
    }
}

function updateUnpTgtBrightness() {
    try {
        // UNP TGT brightness: same color interpolation as FDB for unpaired target symbols
        const brightness = tbState.bright.unpTgt;

        // Create or update dynamic CSS for UNP TGT color
        let styleEl = document.getElementById('dynamic-unptgt-brightness');
        if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = 'dynamic-unptgt-brightness';
            document.head.appendChild(styleEl);
        }

        // Piecewise interpolation: black → #606038 (0-30) → #FFFF44 (30-100)
        let unpTgtColor;
        if (brightness <= 30) {
            // 0-30: interpolate from black to #606038
            const factor = brightness / 30;
            unpTgtColor = interpolateColor('#606038', factor);
        } else {
            // 30-100: interpolate from #606038 to #FFFF44
            const factor = (brightness - 30) / 70;
            const r0 = 96, g0 = 96, b0 = 56;  // #606038
            const r1 = 255, g1 = 255, b1 = 68;  // #FFFF44
            const r = Math.round(r0 + (r1 - r0) * factor);
            const g = Math.round(g0 + (g1 - g0) * factor);
            const b = Math.round(b0 + (b1 - b0) * factor);
            unpTgtColor = `rgb(${r}, ${g}, ${b})`;
        }

        styleEl.textContent = `
            div[style*="rotate(45deg)"] { background: ${unpTgtColor} !important; }
        `;
    } catch (e) {
        // tbState not yet initialized
    }
}

function updateUnpHistBrightness() {
    try {
        // UNP HIST brightness: same color interpolation as FDB for unpaired target history
        const brightness = tbState.bright.unpHist;

        // Piecewise interpolation: black → #606038 (0-30) → #FFFF44 (30-100)
        let unpHistColor;
        if (brightness <= 30) {
            // 0-30: interpolate from black to #606038
            const factor = brightness / 30;
            unpHistColor = interpolateColor('#606038', factor);
        } else {
            // 30-100: interpolate from #606038 to #FFFF44
            const factor = (brightness - 30) / 70;
            const r0 = 96, g0 = 96, b0 = 56;  // #606038
            const r1 = 255, g1 = 255, b1 = 68;  // #FFFF44
            const r = Math.round(r0 + (r1 - r0) * factor);
            const g = Math.round(g0 + (g1 - g0) * factor);
            const b = Math.round(b0 + (b1 - b0) * factor);
            unpHistColor = `rgb(${r}, ${g}, ${b})`;
        }

        // Update global UNP_HIST_COLOR for canvas history drawing
        UNP_HIST_COLOR = unpHistColor;
        // Force immediate canvas redraw
        lastRenderTime = 0;
    } catch (e) {
        // tbState not yet initialized
    }
}

function updateFontSize() {
    CHAR_W = fontSize * 0.625;
    LINE_H = fontSize * 1.25;
    // Update data block and symbol CSS dynamically
    let styleEl = document.getElementById('dynamic-fontsize');
    if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = 'dynamic-fontsize';
        document.head.appendChild(styleEl);
    }
    styleEl.textContent = `
        .ac-db {
            font-size: ${fontSize}px !important;
            line-height: ${LINE_H}px !important;
        }
    `;
}

setInterval(() => {
    rebuildFacilityDropdown();
    rebuildSectorCheckboxes();
    document.getElementById('stat-flights').textContent = flights.size;
    document.getElementById('stat-rate').textContent = msgRate;
    // Debug metrics: flight plan coverage
    let nRoute = 0, nCallsign = 0, nType = 0, nAlt = 0, nPos = 0;
    for (const [, f] of flights) {
        if (f.route) nRoute++;
        if (f.callsign) nCallsign++;
        if (f.aircraftType) nType++;
        if (f.assignedAltitude) nAlt++;
        if (f.latitude != null && f.longitude != null) nPos++;
    }
    const t = flights.size || 1;
    document.getElementById('stat-fp').textContent =
        `FP: ${nRoute}/${t} rte ${nCallsign}/${t} cs ${nType}/${t} typ ${nAlt}/${t} alt ${nPos}/${t} pos`;
}, 5000);

// ════════════════════════════════════════════════════════════════════════════
// Click target priority: symbols win over overlapping data blocks
// ════════════════════════════════════════════════════════════════════════════
// When a click lands on a data block that overlaps another target's position symbol,
// redirect the click to the underlying target. Returns the target gufi, or null.
function findTargetUnderClick(e, currentGufi) {
    const m = markers.get(currentGufi);
    if (!m) return null;
    const mapRect = map.getContainer().getBoundingClientRect();
    const cx = e.clientX - mapRect.left;
    const cy = e.clientY - mapRect.top;
    // If click is near our own symbol center, no redirect needed
    const myPt = map.latLngToContainerPoint(m.getLatLng());
    if (Math.hypot(cx - myPt.x, cy - myPt.y) <= 10) return null;
    // Check if another target's symbol is at the click point
    for (const [gufi, om] of markers) {
        if (gufi === currentGufi || !om._icon) continue;
        const pt = map.latLngToContainerPoint(om.getLatLng());
        if (Math.abs(cx - pt.x) <= 10 && Math.abs(cy - pt.y) <= 10) return gufi;
    }
    return null;
}

// ════════════════════════════════════════════════════════════════════════════
// Flight detail panel
// ════════════════════════════════════════════════════════════════════════════
function toggleTrackSelect(gufi) {
    const f = flights.get(gufi);
    if (!f) return;
    const cls = classifyTrack(f);

    // Own/handoff/emergency tracks: default FDB, clicking does NOT toggle to LDB
    if (cls === 'own' || cls === 'ho' || cls === 'emrg') {
        mca.feedback = [
            { type: 'err', text: 'USER ACTION NOT ALLOWED ON A\nCONTROLLED FLIGHT' },
            { type: 'info', text: `FORCED DATA BLK ${f.callsign || '???'}` }
        ];
        mcaRender();
        showFlightDetail(gufi);
        return;
    }

    // Point-out active or was active: cannot toggle to LDB — use QP command (CRC spec:
    // "even if the point out has been accepted and cleared")
    if (getPointoutIndicator(f) || pointoutBlocked.has(gufi)) {
        mca.feedback = [
            { type: 'err', text: 'POINT OUT ACTIVE \u2014 USE QP' },
            { type: 'info', text: `${f.callsign}/${getCid(f) || '???'}` }
        ];
        mcaRender();
        showFlightDetail(gufi);
        return;
    }

    // Other tracks: toggle LDB ↔ FDB (use QX to explicitly drop/hide)
    if (manuallyHidden.has(gufi)) {
        // Currently hidden (via QX) → restore to FDB
        manuallyHidden.delete(gufi);
        fdbOverrides.set(gufi, true);
    } else {
        const currentlyFdb = shouldShowFdb(gufi, cls);
        if (currentlyFdb) {
            // FDB → LDB: also clear dwell emphasis
            fdbOverrides.delete(gufi);
            wasOwnOrHo.delete(gufi);
            dwellLocked.delete(gufi);
            const mel = markers.get(gufi)?.getElement();
            if (mel) removeDwell(mel, gufi);
        } else {
            // LDB → FDB
            fdbOverrides.set(gufi, true);
        }
    }

    // Immediately rebuild the marker so the change is instant (don't wait for render cycle)
    const m = markers.get(gufi);
    if (m) {
        const el = m.getElement();
        if (el) {
            if (el.style.display === 'none') el.style.display = '';
            const newHash = flightHash(f, cls);
            el.innerHTML = buildMarkerHtml(f, cls);
            el._lastHash = newHash;
            if (dwellLocked.has(gufi) || el._isHovering) applyDwell(el, gufi);
        }
    }

    showFlightDetail(gufi);
}

function showFlightDetail(gufi) {
    selectedGufi = gufi;
    const f = flights.get(gufi);
    if (!f) return;

    document.getElementById('fd-title').textContent =
        `${f.callsign || '???'}  ${f.aircraftType || ''}`;

    const cls = classifyTrack(f);
    const heading = (f.trackVelocityX != null && f.trackVelocityY != null)
        ? `${Math.round((Math.atan2(f.trackVelocityX, f.trackVelocityY) * 180 / Math.PI + 360) % 360)}\u00b0` : '';
    const tvSpd = (f.trackVelocityX != null && f.trackVelocityY != null)
        ? `${Math.round(Math.sqrt(f.trackVelocityX ** 2 + f.trackVelocityY ** 2))} kt` : '';

    const rows = [
        ['ODP', `${f.origin || ''}\u2192${f.destination || ''}`],
        ['Track', cls === 'own' ? 'OWN' : cls === 'ho' ? 'HANDOFF' : cls === 'emrg' ? 'EMERGENCY' : 'OTHER'],
        ['Facility', `${f.controllingFacility || f.reportingFacility || ''}`],
        ['Sector', f.controllingSector || ''],
        ['Squawk', f.assignedSquawk && f.squawk !== f.assignedSquawk
            ? `${f.squawk || 'NONE'} (asgn ${f.assignedSquawk})` : f.squawk],
        ['Assigned', f.blockFloor != null && f.blockCeiling != null
            ? `FL${Math.round(f.blockFloor / 100)}B${Math.round(f.blockCeiling / 100)}`
            : f.assignedVfr
                ? (f.assignedAltitude != null ? `VFR/FL${Math.round(f.assignedAltitude / 100)}` : 'VFR')
                : f.assignedAltitude != null ? `FL${Math.round(f.assignedAltitude / 100)}` : ''],
        ['Reported', f.reportedAltitude != null ? `FL${Math.round(f.reportedAltitude / 100)}` : ''],
        ['Interim', f.interimAltitude != null ? `FL${Math.round(f.interimAltitude / 100)}` : ''],
        ['GS', f.groundSpeed != null ? `${Math.round(f.groundSpeed)} kt` : ''],
        ['Heading', heading],
        ['T/V Speed', tvSpd],
        ['Route', f.route || ''],
        ['Rules', f.flightRules || ''],
        ['STAR', f.star || ''],
        ['Coord Fix', f.coordinationFix || ''],
        ['Coord Time', f.coordinationTime || ''],
        ['ETD', f.actualDepartureTime || ''],
        ['ETA', f.eta || ''],
        ['Handoff', f.handoffEvent ? `${f.handoffEvent} ${f.handoffReceiving || ''} \u2190 ${f.handoffTransferring || ''}` : ''],
        ['HO Debug', (() => {
            const parts = [];
            const hoEvt = hoEventType(f.handoffEvent);
            if (hoEvt) parts.push(`active=${hoEvt}`);
            if (f.handoffReceiving) parts.push(`recv=${f.handoffReceiving}`);
            if (f.handoffTransferring) parts.push(`xfer=${f.handoffTransferring}`);
            if (f.handoffAccepting) parts.push(`accept=${f.handoffAccepting}`);
            const comp = hoCompletedInfo.get(f.gufi);
            if (comp) {
                const secsAgo = Math.round((performance.now() - comp.time) / 1000);
                parts.push(`completed=${secsAgo}s ago recv=${comp.receiving}`);
            }
            return parts.join(' | ');
        })()],
        ['CID', getCid(f) || (myFacility ? '' : f.computerId)],
        ['Operator', f.operator],
        ['A/C Type', f.aircraftType || ''],
        ['Reg', f.registration || ''],
        ['Wake', f.wakeCategory],
        ['Equip', f.equipmentQualifier || ''],
        ['Datalink', f.dataLinkCode],
        ['Remarks', f.remarks || ''],
        ['Last msg', f.lastMsgSource],
        ['Last seen', f.lastSeen],
    ];

    let html = '';
    for (const [label, val] of rows) {
        if (!val) continue;
        html += `<div class="fd-row"><span class="fd-label">${label}</span><span class="fd-val">${esc(String(val))}</span></div>`;
    }
    document.getElementById('fd-body').innerHTML = html;
    document.getElementById('flight-detail-section').style.display = 'block';
}

function closeFd() {
    selectedGufi = null;
    document.getElementById('flight-detail-section').style.display = 'none';
}

// ── Route line display ──
// ── QU route display system ──────────────────────────────────────────────
// Great-circle distance in nautical miles between two lat/lon points
function gcDistNm(lat1, lon1, lat2, lon2) {
    const toRad = Math.PI / 180;
    const dLat = (lat2 - lat1) * toRad;
    const dLon = (lon2 - lon1) * toRad;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
    return 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 3440.065;  // Earth radius in nm
}

// Initial true bearing (degrees 0-360) from point 1 to point 2
function gcBearing(lat1, lon1, lat2, lon2) {
    const toRad = Math.PI / 180;
    const dLon = (lon2 - lon1) * toRad;
    const y = Math.sin(dLon) * Math.cos(lat2 * toRad);
    const x = Math.cos(lat1 * toRad) * Math.sin(lat2 * toRad) -
              Math.sin(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.cos(dLon);
    return (Math.atan2(y, x) / toRad + 360) % 360;
}

// Magnetic declination for CONUS (2025 epoch, bilinear interpolation)
// Returns degrees (positive = east, negative = west)
const _magVarGrid = {
    lats: [25, 30, 35, 40, 45, 50],
    lons: [-125, -115, -105, -95, -85, -75, -65],
    // Rows = lat (25→50), cols = lon (-125→-65)
    data: [
        [11, 9, 5, 1, -4, -8, -13],
        [12, 10, 6, 1, -5, -10, -15],
        [13, 11, 7, 2, -5, -11, -16],
        [14, 12, 8, 3, -6, -12, -17],
        [15, 14, 9, 3, -7, -14, -18],
        [17, 16, 11, 4, -8, -16, -20],
    ]
};
function magDeclination(lat, lon) {
    const g = _magVarGrid;
    // Clamp to grid bounds
    const clat = Math.max(g.lats[0], Math.min(g.lats[g.lats.length - 1], lat));
    const clon = Math.max(g.lons[0], Math.min(g.lons[g.lons.length - 1], lon));
    // Find grid cell
    let li = 0, lj = 0;
    for (let i = 0; i < g.lats.length - 1; i++) { if (clat >= g.lats[i]) li = i; }
    for (let j = 0; j < g.lons.length - 1; j++) { if (clon >= g.lons[j]) lj = j; }
    // Bilinear interpolation
    const tLat = (clat - g.lats[li]) / (g.lats[li + 1] - g.lats[li]);
    const tLon = (clon - g.lons[lj]) / (g.lons[lj + 1] - g.lons[lj]);
    const v00 = g.data[li][lj], v10 = g.data[li + 1][lj];
    const v01 = g.data[li][lj + 1], v11 = g.data[li + 1][lj + 1];
    return v00 * (1 - tLat) * (1 - tLon) + v10 * tLat * (1 - tLon) +
           v01 * (1 - tLat) * tLon + v11 * tLat * tLon;
}

// Resolve a location string to { lat, lon, gs, isTrack, name }
// Accepts: FLID (callsign/CID), DDMMN/DDDMMW lat/lon, or fix/navaid/airport
async function resolveLocation(loc) {
    // Try as DDMMN/DDDMMW lat/lon first
    const llMatch = loc.match(/^(\d{2,4})([NS])\/(\d{3,5})([EW])$/i);
    if (llMatch) {
        const rawLat = llMatch[1], latDir = llMatch[2].toUpperCase();
        const rawLon = llMatch[3], lonDir = llMatch[4].toUpperCase();
        let lat, lon;
        if (rawLat.length <= 2) lat = parseInt(rawLat);
        else { lat = parseInt(rawLat.substring(0, rawLat.length - 2)) + parseInt(rawLat.substring(rawLat.length - 2)) / 60; }
        if (rawLon.length <= 3) lon = parseInt(rawLon);
        else { lon = parseInt(rawLon.substring(0, rawLon.length - 2)) + parseInt(rawLon.substring(rawLon.length - 2)) / 60; }
        if (latDir === 'S') lat = -lat;
        if (lonDir === 'W') lon = -lon;
        return { lat, lon, gs: null, isTrack: false, name: loc };
    }
    // Try as track (callsign/CID)
    const f = findFlight(loc);
    if (f && f.latitude != null && f.longitude != null) {
        return { lat: f.latitude, lon: f.longitude, gs: f.groundSpeed, isTrack: true, name: f.callsign || loc };
    }
    // Try as fix/navaid/airport via NASR
    try {
        const resp = await fetch(`/api/nasr/find/${encodeURIComponent(loc)}`);
        if (resp.ok) {
            const data = await resp.json();
            return { lat: data.lat, lon: data.lon, gs: null, isTrack: false, name: data.ident };
        }
    } catch {}
    return null;
}

// Format bearing/distance/time for RA display
function formatRangeResult(dist, bearing, useMag, fromLat, fromLon, speed, name1, name2) {
    let brg = bearing;
    let brgLabel = 'T';
    if (useMag) {
        brg = (bearing - magDeclination(fromLat, fromLon) + 360) % 360;
        brgLabel = 'M';
    }
    let text = `${name1} - ${name2}\n`;
    text += `${String(Math.round(brg)).padStart(3, '0')}${brgLabel}  ${dist.toFixed(1)} NM`;
    if (speed != null && speed > 0) {
        const hours = dist / speed;
        const min = Math.round(hours * 60);
        text += `  GS${Math.round(speed)}  ${min < 60 ? min + ' MIN' : Math.floor(hours) + ':' + String(min % 60).padStart(2, '0')}`;
    }
    return text;
}

// Find closest segment on route to aircraft position, return { index, frac }
// index = segment start index, frac = 0-1 fraction along that segment
function findRouteProgress(waypoints, lat, lon, vx, vy) {
    // vx/vy = trackVelocityX/Y (knots, X=east, Y=north) — used for direction tiebreaking
    let bestDist = Infinity, bestIdx = 0, bestFrac = 0;
    const hasVel = vx != null && vy != null && (vx !== 0 || vy !== 0);

    const cosLat = Math.cos(lat * Math.PI / 180);  // longitude scaling at aircraft latitude
    for (let i = 0; i < waypoints.length - 1; i++) {
        const [aLat, aLon] = waypoints[i];
        const [bLat, bLon] = waypoints[i + 1];
        // Project point onto segment (equirectangular — scale lon by cos(lat))
        const dx = (bLon - aLon) * cosLat, dy = bLat - aLat;
        const lenSq = dx * dx + dy * dy;
        let t = lenSq > 0 ? (((lon - aLon) * cosLat) * dx + (lat - aLat) * dy) / lenSq : 0;
        t = Math.max(0, Math.min(1, t));
        const pLat = aLat + t * (bLat - aLat), pLon = aLon + t * (bLon - aLon);
        let d = gcDistNm(lat, lon, pLat, pLon);
        // Direction penalty: if aircraft velocity opposes this segment direction, add penalty
        // dx/dy are already equirectangular-scaled (lon*cosLat, lat) — same space as vx(east)/vy(north)
        if (hasVel && lenSq > 0) {
            const segLen = Math.sqrt(lenSq);
            const dot = (dx * vx + dy * vy) / (segLen * Math.sqrt(vx * vx + vy * vy));
            if (dot < 0) d += 50;  // 50nm penalty for backwards-facing segments
        }
        if (d < bestDist) { bestDist = d; bestIdx = i; bestFrac = t; }
    }
    // Also check if aircraft is closest to a waypoint directly (within forward direction)
    for (let i = 0; i < waypoints.length; i++) {
        let d = gcDistNm(lat, lon, waypoints[i][0], waypoints[i][1]);
        // For waypoint-only check, penalize waypoints that are behind the aircraft
        if (hasVel && i < waypoints.length - 1) {
            const toBearing = Math.atan2(waypoints[i][1] - lon, waypoints[i][0] - lat);
            const velBearing = Math.atan2(vx, vy);
            const angleDiff = Math.abs(((toBearing - velBearing + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
            if (angleDiff > Math.PI / 2) d += 50;  // behind the aircraft
        }
        if (d < bestDist) { bestDist = d; bestIdx = Math.max(0, i - 1); bestFrac = i === 0 ? 0 : 1; }
    }
    return { index: bestIdx, frac: bestFrac };
}

// Trim route from aircraft position forward by maxNm nautical miles
// Returns { latlngs, reachedDest } — latlngs is array of [lat,lon], reachedDest is bool
function trimRouteForward(waypoints, startIdx, startFrac, maxNm) {
    if (waypoints.length < 2) return { latlngs: [], reachedDest: false };
    const result = [];
    // Interpolated start point
    const [aLat, aLon] = waypoints[startIdx];
    const [bLat, bLon] = waypoints[Math.min(startIdx + 1, waypoints.length - 1)];
    const sLat = aLat + startFrac * (bLat - aLat);
    const sLon = aLon + startFrac * (bLon - aLon);
    result.push([sLat, sLon]);

    if (maxNm === null) {
        // Full route — add all remaining waypoints
        for (let i = startIdx + 1; i < waypoints.length; i++) {
            result.push(waypoints[i]);
        }
        return { latlngs: result, reachedDest: true };
    }

    let remaining = maxNm;
    // Distance from start point to end of current segment
    const segRemain = gcDistNm(sLat, sLon, bLat, bLon);
    if (segRemain >= remaining) {
        // Trim within this segment
        const f = remaining / Math.max(segRemain, 0.001);
        result.push([sLat + f * (bLat - sLat), sLon + f * (bLon - sLon)]);
        return { latlngs: result, reachedDest: false };
    }
    remaining -= segRemain;
    result.push([bLat, bLon]);

    for (let i = startIdx + 2; i < waypoints.length; i++) {
        const segDist = gcDistNm(waypoints[i - 1][0], waypoints[i - 1][1],
            waypoints[i][0], waypoints[i][1]);
        if (segDist >= remaining) {
            const f = remaining / Math.max(segDist, 0.001);
            const pLat = waypoints[i - 1][0] + f * (waypoints[i][0] - waypoints[i - 1][0]);
            const pLon = waypoints[i - 1][1] + f * (waypoints[i][1] - waypoints[i - 1][1]);
            result.push([pLat, pLon]);
            return { latlngs: result, reachedDest: false };
        }
        remaining -= segDist;
        result.push(waypoints[i]);
    }
    return { latlngs: result, reachedDest: true };
}

// Remove a single route display by gufi
function removeRoute(gufi) {
    const r = activeRoutes.get(gufi);
    if (!r) return;
    if (r.polyline) map.removeLayer(r.polyline);
    if (r.destMarker) map.removeLayer(r.destMarker);
    activeRoutes.delete(gufi);
}

// Clear all route displays
function clearAllRoutes() {
    for (const [gufi] of activeRoutes) removeRoute(gufi);
}

// Show route line for a flight — called by QU command and dwell/detail
// minutes: number of minutes to show, null = full route, 0 = max
// persistent: if true, no 30s auto-remove (used by dwell lock / flight detail)
async function showRouteForFlight(gufi, minutes = null, persistent = false) {
    const f = flights.get(gufi);
    if (!f || !f.route) return 'NO ROUTE';

    // Fetch full route waypoints from server
    let waypoints;
    try {
        const resp = await fetch(`/api/route/${encodeURIComponent(gufi)}`);
        if (!resp.ok) return 'ROUTE RESOLVE FAILED';
        const data = await resp.json();
        waypoints = data.waypoints;
        if (!waypoints || waypoints.length < 2) return 'ROUTE NOT RESOLVED';
    } catch (e) { return 'ROUTE FETCH ERROR'; }

    // Remove existing route for this flight
    removeRoute(gufi);

    // Calculate route from aircraft's current position
    let latlngs, reachedDest;
    if (f.latitude != null && f.longitude != null && minutes !== null) {
        // Use filed speed (requestedSpeed / nasAirspeed), fall back to groundSpeed
        const speed = f.requestedSpeed || f.groundSpeed || 250;
        const mins = minutes === 0 ? 9999 : (minutes || 20);  // 0 = /M (max), default 20
        const maxNm = speed * mins / 60;
        const prog = findRouteProgress(waypoints, f.latitude, f.longitude,
            f.trackVelocityX, f.trackVelocityY);
        ({ latlngs, reachedDest } = trimRouteForward(waypoints, prog.index, prog.frac, maxNm));
        // Always start the route line from the aircraft's actual position
        if (latlngs.length > 0) {
            latlngs[0] = [f.latitude, f.longitude];
        }
    } else {
        // No position or full route requested — show entire route
        latlngs = waypoints;
        reachedDest = true;
    }

    if (latlngs.length < 2) return 'ROUTE TOO SHORT';

    const polyline = L.polyline(latlngs, {
        pane: 'routes',
        color: '#cccc44',
        weight: 2,
        opacity: 0.8,
        interactive: false
    }).addTo(map);

    // Endpoint marker: X at destination, or small solid square at truncated endpoint
    let destMarker = null;
    if (latlngs.length >= 2) {
        const last = latlngs[latlngs.length - 1];
        if (reachedDest) {
            destMarker = L.marker(last, {
                pane: 'routes',
                interactive: false,
                icon: L.divIcon({
                    className: '',
                    html: `<div style="color:#cccc44;font-family:ERAM,Consolas,monospace;font-size:${fontSize}px;text-decoration:underline;width:${fontSize}px;height:${fontSize}px;line-height:${fontSize}px;text-align:center;">X</div>`,
                    iconSize: [fontSize, fontSize],
                    iconAnchor: [fontSize / 2, fontSize / 2]
                })
            }).addTo(map);
        } else {
            const sz = Math.max(4, Math.round(fontSize * 0.4));
            destMarker = L.marker(last, {
                pane: 'routes',
                interactive: false,
                icon: L.divIcon({
                    className: '',
                    html: `<div style="width:${sz}px;height:${sz}px;background:#cccc44;"></div>`,
                    iconSize: [sz, sz],
                    iconAnchor: [sz / 2, sz / 2]
                })
            }).addTo(map);
        }
    }

    activeRoutes.set(gufi, {
        polyline,
        destMarker,
        time: persistent ? null : performance.now(),
        minutes,
        waypoints  // cached for dynamic updates
    });

    return null;  // success
}

// Update active QU routes to follow aircraft position
function updateActiveRoutes() {
    for (const [gufi, r] of activeRoutes) {
        if (!r.waypoints || r.minutes === null) continue; // full route, no trimming
        const f = flights.get(gufi);
        if (!f || f.latitude == null || f.longitude == null) continue;

        const speed = f.requestedSpeed || f.groundSpeed || 250;
        const mins = r.minutes === 0 ? 9999 : (r.minutes || 20);
        const maxNm = speed * mins / 60;
        const prog = findRouteProgress(r.waypoints, f.latitude, f.longitude,
            f.trackVelocityX, f.trackVelocityY);
        const { latlngs, reachedDest } = trimRouteForward(r.waypoints, prog.index, prog.frac, maxNm);
        if (latlngs.length > 0) latlngs[0] = [f.latitude, f.longitude];
        if (latlngs.length < 2) continue;

        r.polyline.setLatLngs(latlngs);
        // Update endpoint marker position
        if (r.destMarker) {
            r.destMarker.setLatLng(latlngs[latlngs.length - 1]);
        }
    }
}

// Auto-remove expired QU route displays (30s timeout)
setInterval(() => {
    const now = performance.now();
    for (const [gufi, r] of activeRoutes) {
        if (r.time !== null && now - r.time >= 30000) {
            removeRoute(gufi);
        }
    }
}, 1000);

setInterval(() => { if (selectedGufi) showFlightDetail(selectedGufi); }, 5000);

// ════════════════════════════════════════════════════════════════════════════
// URL-based settings persistence
// ════════════════════════════════════════════════════════════════════════════
function loadSettingsFromLocalStorage() {
    try {
        const saved = localStorage.getItem('eram-settings');
        if (!saved) {
            // No saved settings, but still need to apply rendering with defaults
            updateScopeBackground();
            return;
        }

        const settings = JSON.parse(saved);

        myFacility = settings.facility || '';
        mySectors = new Set(settings.sectors || []);
        if (settings.showFdb !== undefined) showFdb = settings.showFdb;
        if (settings.showHistory !== undefined) showHistory = settings.showHistory;
        if (settings.MAX_HISTORY !== undefined) MAX_HISTORY = settings.MAX_HISTORY;
        if (settings.vectorMinutes !== undefined) vectorMinutes = settings.vectorMinutes;
        if (settings.boundaryBrightness) Object.assign(boundaryBrightness, settings.boundaryBrightness);
        if (settings.line4Mode) line4Mode = settings.line4Mode;
        if (settings.showMapBg !== undefined) showMapBg = settings.showMapBg;
        if (settings.fontSize !== undefined) fontSize = settings.fontSize;
        if (settings.altFilterLow !== undefined) altFilterLow = settings.altFilterLow;
        if (settings.altFilterHigh !== undefined) altFilterHigh = settings.altFilterHigh;
        if (settings.ldbBrightness !== undefined) ldbBrightness = settings.ldbBrightness;
        if (settings.facilityOnly !== undefined) facilityOnly = settings.facilityOnly;
        if (settings.mcaKb !== undefined) document.getElementById('chk-mca-kb').checked = settings.mcaKb;
        if (settings.numinv !== undefined) document.getElementById('numpad-inverted').checked = !settings.numinv;
        if (settings.nasrBrightness) Object.assign(nasrBrightness, settings.nasrBrightness);
        if (settings.nexradLevel !== undefined) nexradLevel = settings.nexradLevel;
        if (settings.nexradBrightness !== undefined) nexradBrightness = settings.nexradBrightness;
        if (settings.scopeBckgrd !== undefined) scopeBckgrd = settings.scopeBckgrd;
        if (settings.scopeBcklght !== undefined) scopeBcklght = settings.scopeBcklght;
        if (settings.tbVisible !== undefined) window._tbVisible = settings.tbVisible;

        // Sync button state with restored global variables
        tbState.bright.bckgrd = scopeBckgrd;
        tbState.bright.bcklght = scopeBcklght;

        // Restore map position/zoom
        if (settings.mapCenter && settings.mapZoom !== undefined) {
            map.setView([settings.mapCenter.lat, settings.mapCenter.lng], settings.mapZoom);
        }
    } catch (e) {
        console.warn('Failed to load settings from localStorage:', e);
    }

    // Apply to UI controls
    document.getElementById('sel-facility').value = myFacility;
    document.getElementById('sel-histcount').value = MAX_HISTORY;
    document.getElementById('sel-vector').value = vectorMinutes;
    for (const [cat, id] of Object.entries(BOUNDARY_CAT_SLIDER)) {
        document.getElementById(id).value = boundaryBrightness[cat];
        document.getElementById(BOUNDARY_CAT_LABEL[cat]).textContent = boundaryBrightness[cat];
    }
    document.getElementById('chk-facility-only').checked = facilityOnly;
    document.getElementById('chk-mapbg').checked = showMapBg;
    document.getElementById('sel-line4').value = line4Mode;
    document.getElementById('sel-fontsize').value = fontSize;
    document.getElementById('inp-alt-low').value = altFilterLow;
    document.getElementById('inp-alt-high').value = altFilterHigh;
    document.getElementById('rng-ldb-brightness').value = ldbBrightness;
    document.getElementById('lbl-ldb-brightness').textContent = ldbBrightness;
    document.getElementById('rng-jroutes').value = nasrBrightness.jroutes;
    document.getElementById('lbl-jroutes').textContent = nasrBrightness.jroutes;
    document.getElementById('rng-vroutes').value = nasrBrightness.vroutes;
    document.getElementById('lbl-vroutes').textContent = nasrBrightness.vroutes;
    document.getElementById('rng-vors').value = nasrBrightness.vors;
    document.getElementById('lbl-vors').textContent = nasrBrightness.vors;
    document.getElementById('rng-airports').value = nasrBrightness.airports;
    document.getElementById('lbl-airports').textContent = nasrBrightness.airports;
    document.getElementById('rng-centerlines').value = nasrBrightness.centerlines;
    document.getElementById('lbl-centerlines').textContent = nasrBrightness.centerlines;
    document.getElementById('rng-proc').value = nasrBrightness.proc;
    document.getElementById('lbl-proc').textContent = nasrBrightness.proc;
    document.getElementById('sel-nxlvl').value = nexradLevel === 3 ? '123' : nexradLevel === 2 ? '23' : nexradLevel === 1 ? '3' : '0';
    document.getElementById('rng-nx').value = nexradBrightness;
    document.getElementById('lbl-nx').textContent = nexradBrightness;
    updateFontSize();
    if (showMapBg) tileLayer.addTo(map);
    if (nexradLevel > 0) updateNexrad();
    // Restore NASR overlays if brightness > 0
    if (nasrBrightness.jroutes > 0) showNasrLayer('jroutes', '/api/nasr/airways?type=hi', renderAirways);
    if (nasrBrightness.vroutes > 0) showNasrLayer('vroutes', '/api/nasr/airways?type=lo', renderAirways);
    if (nasrBrightness.vors > 0) showNasrLayer('vors', '/api/nasr/navaids', renderVors);
    if (nasrBrightness.airports > 0 && !airportOverlayData) {
        fetch('/api/nasr/airports').then(r => r.ok ? r.json() : null).then(d => { if (d) { airportOverlayData = d; drawOverlay(); } });
    }
    if (nasrBrightness.centerlines > 0 && !centerlineData) {
        fetch('/api/nasr/centerlines').then(r => r.ok ? r.json() : null).then(d => { if (d) { centerlineData = d; drawOverlay(); } });
    }
    showBoundariesForFacility(myFacility);
    updateScopeBackground();
}

function saveSettingsToLocalStorage() {
    const settings = {
        facility: myFacility,
        sectors: [...mySectors],
        showFdb,
        showHistory,
        MAX_HISTORY,
        vectorMinutes,
        boundaryBrightness,
        line4Mode,
        showMapBg,
        fontSize,
        altFilterLow,
        altFilterHigh,
        ldbBrightness,
        facilityOnly,
        mcaKb: document.getElementById('chk-mca-kb')?.checked || false,
        mcaVisible: document.getElementById('chk-mca')?.checked !== false,
        raVisible: document.getElementById('chk-ra')?.checked !== false,
        timeVisible: document.getElementById('chk-time')?.checked !== false,
        numinv: !document.getElementById('numpad-inverted')?.checked,
        nasrBrightness,
        nexradLevel,
        nexradBrightness,
        scopeBckgrd,
        scopeBcklght,
        tbVisible: window._tbVisible,
        tbState: { bright: tbState.bright },
        // Map position/zoom
        mapCenter: map.getCenter(),
        mapZoom: map.getZoom()
    };
    try {
        localStorage.setItem('eram-settings', JSON.stringify(settings));
    } catch (e) {
        console.warn('Failed to save settings to localStorage:', e);
    }
}

// ════════════════════════════════════════════════════════════════════════════
// Right-click pan (replaces default left-click drag)
// ════════════════════════════════════════════════════════════════════════════
const mapEl = document.getElementById('map');
mapEl.addEventListener('contextmenu', e => e.preventDefault());
// Prevent middle-click auto-scroll icon on the map
mapEl.addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); });

let _rightDragging = false;
let _rightDragStart = null;

mapEl.addEventListener('mousedown', e => {
    if (e.button === 2) {
        _rightDragging = true;
        _rightDragStart = { x: e.clientX, y: e.clientY };
        mapEl.style.cursor = 'grabbing';
        e.preventDefault();
    }
});

document.addEventListener('mousemove', e => {
    if (!_rightDragging) return;
    const dx = e.clientX - _rightDragStart.x;
    const dy = e.clientY - _rightDragStart.y;
    map.panBy([-dx, -dy], { animate: false });
    _rightDragStart = { x: e.clientX, y: e.clientY };
});

document.addEventListener('mouseup', e => {
    if (e.button === 2 && _rightDragging) {
        _rightDragging = false;
        mapEl.style.cursor = '';
    }
});

// Map click: when MCA has content, left-clicking empty map inserts a ▽ location placeholder
map.on('click', (e) => {
    if (mca.text.trim().length > 0) {
        // Format lat/lon as DDMMN/DDDMMW for ERAM-style location entry
        const lat = e.latlng.lat;
        const lon = e.latlng.lng;
        const latDir = lat >= 0 ? 'N' : 'S';
        const lonDir = lon >= 0 ? 'E' : 'W';
        const absLat = Math.abs(lat);
        const absLon = Math.abs(lon);
        const latDeg = Math.floor(absLat).toString().padStart(2, '0');
        const latMin = Math.round((absLat % 1) * 60).toString().padStart(2, '0');
        const lonDeg = Math.floor(absLon).toString().padStart(3, '0');
        const lonMin = Math.round((absLon % 1) * 60).toString().padStart(2, '0');
        let locStr = `${latDeg}${latMin}${latDir}/${lonDeg}${lonMin}${lonDir}`;
        // For LF commands, prepend // automatically
        if (mca.text.trim().toUpperCase().startsWith('LF')) {
            locStr = '//' + locStr;
        }
        mcaInsertTarget(locStr);
    }
});

// Map middle-click: when MCA has content, insert location + execute immediately (CRC spec)
mapEl.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return;
    if (mca.text.trim().length === 0) return;
    e.preventDefault();
    const pt = map.containerPointToLatLng([e.clientX - mapEl.getBoundingClientRect().left,
                                           e.clientY - mapEl.getBoundingClientRect().top]);
    const lat = pt.lat, lon = pt.lng;
    const latDir = lat >= 0 ? 'N' : 'S';
    const lonDir = lon >= 0 ? 'E' : 'W';
    const absLat = Math.abs(lat);
    const absLon = Math.abs(lon);
    const latDeg = Math.floor(absLat).toString().padStart(2, '0');
    const latMin = Math.round((absLat % 1) * 60).toString().padStart(2, '0');
    const lonDeg = Math.floor(absLon).toString().padStart(3, '0');
    const lonMin = Math.round((absLon % 1) * 60).toString().padStart(2, '0');
    let locStr = `${latDeg}${latMin}${latDir}/${lonDeg}${lonMin}${lonDir}`;
    // For LF commands, prepend // automatically
    if (mca.text.trim().toUpperCase().startsWith('LF')) {
        locStr = '//' + locStr;
    }
    if (mca.text[mca.text.length - 1] !== ' ') mca.text += ' ';
    mca.text += locStr;
    mca.cursor = mca.text.length;
    mcaExecute();
});

// ════════════════════════════════════════════════════════════════════════════
// MCA (Message Composition Area)
// ════════════════════════════════════════════════════════════════════════════
const mca = {
    text: '',
    cursor: 0,
    overstrike: true,   // true = overstrike (_), false = insert (|)
    feedback: [],       // array of { type: 'ok'|'err'|'info', text: string }
    lastCommand: '',
    maxChars: 120,      // max total characters in preview area
    targetFlids: [],    // FLIDs/locations for ▽ characters in preview, in insertion order
};

// Get the best FLID for a flight: CID (if facility selected) or callsign
function getFlid(f) {
    if (!f) return '';
    const cid = getCid(f);
    if (cid) return cid;
    return f.callsign || '';
}

function mcaInsertChar(ch) {
    if (mca.text.length >= mca.maxChars && !mca.overstrike) {
        mca.feedback = [{ type: 'err', text: 'MESSAGE TOO LONG' }];
        mcaRender();
        return;
    }
    if (mca.overstrike && mca.cursor < mca.text.length) {
        mca.text = mca.text.substring(0, mca.cursor) + ch + mca.text.substring(mca.cursor + 1);
    } else {
        if (mca.text.length >= mca.maxChars) {
            mca.feedback = [{ type: 'err', text: 'MESSAGE TOO LONG' }];
            mcaRender();
            return;
        }
        mca.text = mca.text.substring(0, mca.cursor) + ch + mca.text.substring(mca.cursor);
    }
    mca.cursor++;
    mcaRender();
}

// Insert a target/location ▽ into MCA, storing the FLID or location string
function mcaInsertTarget(flid) {
    // Add space separator if needed (not at start, and last char isn't space)
    if (mca.text.length > 0 && mca.cursor > 0 && mca.text[mca.cursor - 1] !== ' ') {
        mca.text = mca.text.substring(0, mca.cursor) + ' ' + mca.text.substring(mca.cursor);
        mca.cursor++;
    }
    mca.text = mca.text.substring(0, mca.cursor) + '\u25bd' + mca.text.substring(mca.cursor);
    mca.targetFlids.push(flid);
    mca.cursor++;
    mcaRender();
}

function mcaBackspace() {
    if (mca.cursor > 0) {
        const ch = mca.text[mca.cursor - 1];
        mca.text = mca.text.substring(0, mca.cursor - 1) + mca.text.substring(mca.cursor);
        mca.cursor--;
        // Remove the corresponding FLID if a ▽ was deleted
        if (ch === '\u25bd') {
            // Count how many ▼ are before (and including) this position to find the right index
            let idx = 0;
            for (let i = 0; i < mca.cursor; i++) {
                if (mca.text[i] === '\u25bd') idx++;
            }
            mca.targetFlids.splice(idx, 1);
        }
        mcaRender();
    }
}

function mcaDelete() {
    if (mca.cursor < mca.text.length) {
        const ch = mca.text[mca.cursor];
        mca.text = mca.text.substring(0, mca.cursor) + mca.text.substring(mca.cursor + 1);
        if (ch === '\u25bd') {
            let idx = 0;
            for (let i = 0; i < mca.cursor; i++) {
                if (mca.text[i] === '\u25bd') idx++;
            }
            mca.targetFlids.splice(idx, 1);
        }
        mcaRender();
    }
}

function mcaExecute() {
    // Resolve ▽ target/location placeholders to actual FLIDs or coordinates
    let resolved = mca.text;
    const flids = [...mca.targetFlids];
    let flidIdx = 0;
    resolved = resolved.replace(/\u25bd/g, () => flids[flidIdx++] || '');
    const cmd = resolved.trim();
    mca.lastCommand = mca.text;
    mca.text = '';
    mca.cursor = 0;
    mca.targetFlids = [];
    if (!cmd) { mcaRender(); return; }
    const result = processCommand(cmd);
    if (result instanceof Promise) {
        // Async command (e.g., QU) — show pending then update when done
        mca.feedback = [{ type: 'info', text: 'PROCESSING...' }];
        mcaRender();
        result.then(r => { mca.feedback = r.feedback || []; mcaRender(); });
    } else {
        mca.feedback = result.feedback || [];
        mcaRender();
    }
}

function mcaClear() {
    mca.text = '';
    mca.cursor = 0;
    mca.feedback = [];
    mca.targetFlids = [];
    mcaRender();
}

function mcaRecall() {
    mca.text = mca.lastCommand;
    mca.cursor = mca.text.length;
    mcaRender();
}

function mcaRender() {
    const previewEl = document.getElementById('mca-preview');
    const feedbackEl = document.getElementById('mca-feedback');

    // Preview: text with blinking cursor (backtick → ⵔ︎ display)
    const mcaDisp = t => esc(t).replace(/`/g, '\u2D54\uFE0E');
    const before = mcaDisp(mca.text.substring(0, mca.cursor));
    if (mca.overstrike) {
        // Overstrike: cursor replaces character at position (or shows _ at end)
        const after = mca.cursor < mca.text.length ? mcaDisp(mca.text.substring(mca.cursor + 1)) : '';
        previewEl.innerHTML = before + '<span class="mca-cursor">_</span>' + after;
    } else {
        // Insert: cursor between characters (thin bar)
        const after = mcaDisp(mca.text.substring(mca.cursor));
        previewEl.innerHTML = before + '<span class="mca-cursor">|</span>' + after;
    }

    // Feedback area
    if (mca.feedback.length === 0) {
        feedbackEl.innerHTML = '';
    } else {
        feedbackEl.innerHTML = mca.feedback.map(f => {
            if (f.type === 'ok') return '<span style="color:#44cc44;">\u2713</span> ' + esc(f.text);
            if (f.type === 'err') return '<span style="color:#cc4444;">\u2717</span> ' + esc(f.text);
            return esc(f.text);
        }).join('\n');
    }
}

// ════════════════════════════════════════════════════════════════════════════
// Command processor
// ════════════════════════════════════════════════════════════════════════════

// Find flight by FLID: CID (facility-specific only), callsign, or squawk
function findFlight(id) {
    const needle = id.toUpperCase();
    // CID match — matches the CID shown in the FDB (getCid logic)
    // Priority: 1) own-facility + visible, 2) visible, 3) ACTIVE, 4) any
    // "Own-facility" = controllingFacility or reportingFacility matches selected.
    // This prevents recycled CIDs from matching the wrong flight after handoff.
    if (myFacility) {
        let ownFacMatch = null;   // controlled by our facility + visible
        let visibleMatch = null;  // visible but not our facility
        let activeFallback = null;
        let anyFallback = null;
        for (const [gufi, f] of flights) {
            // Match by displayed CID (same logic as getCid)
            const displayedCid = getCid(f);
            if (displayedCid && displayedCid.toUpperCase() === needle) {
                const active = !f.flightStatus || f.flightStatus === 'ACTIVE';
                const visible = active && isVisible(f) && !isDedupHidden(gufi, f) && !isCidRecycled(gufi, f);
                const ownFac = f.controllingFacility === myFacility || f.reportingFacility === myFacility;
                if (visible && ownFac && !ownFacMatch) ownFacMatch = f;
                else if (visible && !visibleMatch) visibleMatch = f;
                else if (active && !activeFallback) activeFallback = f;
                if (!anyFallback) anyFallback = f;
            }
        }
        if (ownFacMatch) return ownFacMatch;
        if (visibleMatch) return visibleMatch;
        if (activeFallback) return activeFallback;
        if (anyFallback) return anyFallback;
    } else {
        for (const f of flights.values()) {
            if (f.computerId && f.computerId.toUpperCase() === needle) return f;
        }
    }
    // Then callsign match — prefer visible
    let csFallback = null;
    for (const [gufi, f] of flights) {
        if (f.callsign?.toUpperCase() === needle) {
            if (isVisible(f) && !isDedupHidden(gufi, f)) return f;
            if (!csFallback) csFallback = f;
        }
    }
    if (csFallback) return csFallback;
    // Then squawk (beacon code) match — prefer visible, per CRC "beacon codes are FLIDs"
    let sqFallback = null;
    for (const [gufi, f] of flights) {
        if (f.squawk === needle) {
            if (isVisible(f) && !isDedupHidden(gufi, f)) return f;
            if (!sqFallback) sqFallback = f;
        }
    }
    if (sqFallback) return sqFallback;
    return null;
}

// Parse altitude string (2-3 digit FL) → feet, returns null if invalid
function parseAltitude(s) {
    if (!s || !/^\d{2,3}$/.test(s)) return null;
    return parseInt(s) * 100;
}

// Resolve multiple FLIDs (split by /) → { found: [flight...], notFound: [string...] }
function resolveFlids(flids) {
    const found = [], notFound = [];
    for (const flid of flids) {
        const f = findFlight(flid);
        if (f) found.push(f);
        else notFound.push(flid);
    }
    return { found, notFound };
}

// Check if a flight is owned by our position (own or handoff to us)
function isOwnTrack(f) {
    const cls = classifyTrack(f);
    return cls === 'own' || cls === 'ho';
}

// Standard rejection for commands requiring track ownership
function rejectNotOwned(cmdName, f) {
    return { feedback: [
        { type: 'err', text: 'REJECT - NOT YOUR TRACK' },
        { type: 'info', text: cmdName },
        { type: 'info', text: `${f.callsign || '???'}/${getCid(f) || '???'}` }
    ]};
}

// Invalidate a single marker's hash to force rebuild on next render
function invalidateMarker(gufi) {
    const m = markers.get(gufi);
    if (m) { const el = m.getElement(); if (el) el._lastHash = ''; }
    lastRenderTime = 0;
}

function processCommand(cmd) {
    const parts = cmd.trim().split(/\s+/);
    const verb = parts[0]?.toUpperCase();

    // <1-9>/<0-3> <FLID> — Combined position + leader length (CRC spec)
    if (/^[1-9]\/[0-3]$/.test(verb) && parts.length >= 2) {
        const pos = numpadPos(parseInt(verb.charAt(0)));
        const level = parseInt(verb.charAt(2));
        const flid = parts.slice(1).join('').toUpperCase();
        const f = findFlight(flid);
        if (f) {
            dbPositions.set(f.gufi, pos);
            ldrLenOverrides.set(f.gufi, level);
            const m = markers.get(f.gufi);
            if (m) { const el = m.getElement(); if (el) el._lastHash = ''; }
            lastRenderTime = 0;
            return { feedback: [
                { type: 'ok', text: 'ACCEPT' },
                { type: 'info', text: `OFFSET DATA BLK LDR ${level}` },
                { type: 'info', text: `${f.callsign}/${getCid(f) || '???'}` }
            ]};
        }
        return { feedback: [{ type: 'err', text: 'FLIGHT NOT FOUND' }] };
    }

    // <1-9> <FLID> — Position data block (numpad layout)
    if (/^[1-9]$/.test(verb) && parts.length >= 2) {
        const pos = numpadPos(parseInt(verb));
        const flid = parts.slice(1).join('').toUpperCase();
        const f = findFlight(flid);
        if (f) {
            dbPositions.set(f.gufi, pos);
            // Invalidate marker hash so it rebuilds immediately
            const m = markers.get(f.gufi);
            if (m) { const el = m.getElement(); if (el) el._lastHash = ''; }
            lastRenderTime = 0;
            return { feedback: [
                { type: 'ok', text: 'ACCEPT' },
                { type: 'info', text: 'OFFSET DATA BLK' },
                { type: 'info', text: `${f.callsign}/${getCid(f) || '???'}` }
            ]};
        }
        return { feedback: [{ type: 'err', text: 'FLIGHT NOT FOUND' }] };
    }

    // //<FLID> or // <FLID> — Toggle VCI (Visual Communications Indicator)
    {
        let vciFlid = null;
        if (verb === '//' && parts.length >= 2) vciFlid = parts.slice(1).join('').toUpperCase();
        else if (verb.startsWith('//') && verb.length > 2) vciFlid = verb.substring(2).toUpperCase();
        if (vciFlid) {
            const f = findFlight(vciFlid);
            if (f) {
                const cls = classifyTrack(f);
                if (!shouldShowFdb(f.gufi, cls)) {
                    return { feedback: [{ type: 'err', text: 'NOT IN FDB' }] };
                }
                if (vciActive.has(f.gufi)) vciActive.delete(f.gufi);
                else vciActive.add(f.gufi);
                const m4 = markers.get(f.gufi);
                if (m4) { const el = m4.getElement(); if (el) el._lastHash = ''; }
                lastRenderTime = 0;
                return { feedback: [
                    { type: 'ok', text: 'ACCEPT' },
                    { type: 'info', text: 'TOGGLE ON-FREQUENCY' },
                    { type: 'info', text: `${f.callsign}/${getCid(f) || '???'}` }
                ]};
            }
            return { feedback: [{ type: 'err', text: 'FLIGHT NOT FOUND' }] };
        }
    }

    // /<0-3> <FLID> — Set individual leader line length
    if (/^\/[0-3]$/.test(verb) && parts.length >= 2) {
        const level = parseInt(verb.charAt(1));
        const flid = parts.slice(1).join('').toUpperCase();
        const f = findFlight(flid);
        if (f) {
            ldrLenOverrides.set(f.gufi, level);
            const m3 = markers.get(f.gufi);
            if (m3) { const el = m3.getElement(); if (el) el._lastHash = ''; }
            lastRenderTime = 0;
            return { feedback: [
                { type: 'ok', text: 'ACCEPT' },
                { type: 'info', text: `LDR LEN ${level}` },
                { type: 'info', text: `${f.callsign}/${getCid(f) || '???'}` }
            ]};
        }
        return { feedback: [{ type: 'err', text: 'FLIGHT NOT FOUND' }] };
    }

    // QU [minutes] [FLID...] — Route display
    // QU alone clears all route lines
    // QU <FLID> clears route for that flight
    // QU <minutes> <FLID> shows route for N minutes (default 20, /M = max)
    // Multiple FLIDs: QU 30 JBU123/429/AAL924
    if (verb === 'QU') {
        if (parts.length === 1) {
            // QU alone — clear all QU route displays
            clearAllRoutes();
            return { feedback: [
                { type: 'ok', text: 'ACCEPT' },
                { type: 'info', text: 'ROUTE DISPLAY' }
            ]};
        }

        // Parse: first non-verb token might be minutes or /M, rest are FLIDs
        // Minutes: 1-99 (1-2 digit number). CID: always 3 alphanumeric chars.
        let minutes = 20;  // default
        let flidStart = 1;
        const arg1 = parts[1].toUpperCase();
        if (arg1 === '/M') {
            minutes = 0;  // 0 = max/full route
            flidStart = 2;
        } else if (/^\d{1,2}$/.test(arg1) && parts.length > 2) {
            // 1-2 digit number with more args — treat as minutes
            minutes = parseInt(arg1);
            flidStart = 2;
        }
        // 3+ char tokens (including 3-digit CIDs) treated as FLIDs

        // Remaining parts are FLIDs — may contain slashes for multiple (QU 30 JBU123/429/AAL924)
        const flidStr = parts.slice(flidStart).join(' ').toUpperCase();
        if (!flidStr) {
            // QU <minutes> with no FLID — error
            return { feedback: [{ type: 'err', text: 'MESSAGE TOO SHORT' }] };
        }

        // Split on / to get individual FLIDs
        const flids = flidStr.split('/').map(s => s.trim()).filter(s => s);

        // If single FLID with no minutes specified and arg1 is the FLID itself
        if (flidStart === 1) {
            // QU <FLID> — if flight has active route, clear it; else show default 20 min
            if (flids.length === 1) {
                const f = findFlight(flids[0]);
                if (!f) {
                    return { feedback: [
                        { type: 'err', text: 'REJECT - FLID NOT STORED' },
                        { type: 'info', text: 'REROUTE' },
                        { type: 'info', text: cmd }
                    ]};
                }
                if (activeRoutes.has(f.gufi)) {
                    removeRoute(f.gufi);
                    return { feedback: [
                        { type: 'ok', text: 'ACCEPT' },
                        { type: 'info', text: 'ROUTE DISPLAY' },
                        { type: 'info', text: `${f.callsign}/${getCid(f) || '???'}` }
                    ]};
                }
            }
        }

        // Show route for each FLID
        const found = [];
        const notFound = [];
        for (const flid of flids) {
            const f = findFlight(flid);
            if (f) found.push(f);
            else notFound.push(flid);
        }
        if (found.length === 0) {
            return { feedback: [
                { type: 'err', text: 'REJECT - FLID NOT STORED' },
                { type: 'info', text: 'REROUTE' },
                { type: 'info', text: cmd }
            ]};
        }

        // Async: fetch routes for all found flights
        return (async () => {
            const feedback = [{ type: 'ok', text: 'ACCEPT' }];
            for (const f of found) {
                const err = await showRouteForFlight(f.gufi, minutes, false);
                if (err) {
                    feedback.push({ type: 'err', text: `${f.callsign}: ${err}` });
                } else {
                    feedback.push({ type: 'info', text: 'ROUTE DISPLAY' });
                    feedback.push({ type: 'info', text: `${f.callsign}/${getCid(f) || '???'}` });
                }
            }
            if (notFound.length > 0) {
                for (const nf of notFound) {
                    feedback.push({ type: 'err', text: `REJECT - FLID NOT STORED` });
                    feedback.push({ type: 'info', text: `QU ${nf}` });
                }
            }
            return { feedback };
        })();
    }

    // QF <callsign> — Query Flight plan → show in RA
    if (verb === 'QF' && parts.length >= 2) {
        const cs = parts.slice(1).join('').toUpperCase();
        const f = findFlight(cs);
        if (f) {
            showFlightInRA(f);
            return { feedback: [{ type: 'ok', text: 'ACCEPT' }] };
        }
        return { feedback: [{ type: 'err', text: 'FLIGHT NOT FOUND' }] };
    }

    // QD — clear Response Area
    if (verb === 'QD') {
        document.getElementById('ra-content').textContent = '';
        return { feedback: [{ type: 'ok', text: 'ACCEPT' }] };
    }

    // ═══════════════════════════════════════════════════════════════════════
    // WR R <station>        — weather request: display METAR in Response Area
    // ═══════════════════════════════════════════════════════════════════════
    if (verb === 'WR' && parts.length >= 3 && parts[1].toUpperCase() === 'R') {
        const station = parts.slice(2).join('').toUpperCase();
        if (!station) return { feedback: [{ type: 'err', text: 'WR R REQUIRES STATION ID' }] };
        const icao = station.length === 3 ? 'K' + station : station;
        return (async () => {
            try {
                const resp = await fetch(`/api/metar/${encodeURIComponent(station)}`);
                if (resp.status === 404) {
                    return { feedback: [{ type: 'err', text: `NO METAR FOR ${icao}` }] };
                }
                if (!resp.ok) {
                    return { feedback: [{ type: 'err', text: `WX REQ FAILED (${resp.status})` }] };
                }
                const text = (await resp.text()).trim();
                if (!text) {
                    return { feedback: [{ type: 'err', text: `NO METAR FOR ${icao}` }] };
                }
                const ra = document.getElementById('ra-content');
                ra.textContent = text;
                return { feedback: [
                    { type: 'ok', text: 'ACCEPT' },
                    { type: 'info', text: `METAR ${icao}` }
                ]};
            } catch {
                return { feedback: [{ type: 'err', text: 'WX REQ FAILED' }] };
            }
        })();
    }

    // ═══════════════════════════════════════════════════════════════════════
    // AR <station>           — add/remove altimeter setting for station (toggle)
    // ═══════════════════════════════════════════════════════════════════════
    if (verb === 'AR' && parts.length >= 2) {
        let stationInput = parts.slice(1).join('').toUpperCase();
        if (stationInput.startsWith('K')) {
            stationInput = stationInput.substring(1);
        }
        if (!stationInput) return { feedback: [{ type: 'err', text: 'AR REQUIRES STATION ID' }] };

        // Check if already exists — toggle remove
        if (altimeterStations.has(stationInput)) {
            removeAltimeterStation(stationInput);
            altimeterSelectedStation = null;
            return { feedback: [
                { type: 'ok', text: 'ACCEPT' },
                { type: 'info', text: `ALTIMETER ${stationInput}` },
                { type: 'info', text: 'REMOVED' }
            ]};
        }

        // Otherwise add
        return addAltimeterStation(stationInput);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // WR <station>           — add/remove weather report for station (toggle)
    // ═══════════════════════════════════════════════════════════════════════
    if (verb === 'WR' && parts.length >= 2 && parts[1].toUpperCase() !== 'R') {
        let stationInput = parts.slice(1).join('').toUpperCase();
        if (stationInput.startsWith('K')) {
            stationInput = stationInput.substring(1);
        }
        if (!stationInput) return { feedback: [{ type: 'err', text: 'WR REQUIRES STATION ID' }] };

        // Check if already exists — toggle remove
        if (weatherStations.has(stationInput)) {
            removeWeatherStation(stationInput);
            weatherSelectedStation = null;
            return { feedback: [
                { type: 'ok', text: 'ACCEPT' },
                { type: 'info', text: `WEATHER ${stationInput}` },
                { type: 'info', text: 'REMOVED' }
            ]};
        }

        // Otherwise add and open menu
        return (async () => {
            const result = await addWeatherStation(stationInput);
            if (result.feedback && result.feedback.some(f => f.type === 'ok')) {
                if (!weatherMenuOpen) openWeatherMenu();
            }
            return result;
        })();
    }

    // ═══════════════════════════════════════════════════════════════════════
    // LA <loc1> <loc2> [/<speed>|T/<speed>|T]  — range/bearing between two locations
    // LB <fix> <loc> | LB <fix>/<speed> <track> — range/bearing from fix to location
    // LC <fix>/<time> <track>                   — speed adjustment to reach fix at time
    // ═══════════════════════════════════════════════════════════════════════
    if (verb === 'LA' || verb === 'LB' || verb === 'LC') {
        const ra = document.getElementById('ra-content');
        return (async () => {
            try {
                if (verb === 'LA') {
                    // LA <loc1> <loc2> [/<speed> | T/<speed> | T]
                    if (parts.length < 3) return { feedback: [{ type: 'err', text: 'LA REQUIRES 2 LOCATIONS' }] };
                    const loc1Str = parts[1].toUpperCase();
                    const loc2Str = parts[2].toUpperCase();
                    // Optional 3rd param: /<speed>, T/<speed>, or T
                    let overrideSpeed = null, useTrueBearing = false;
                    if (parts.length >= 4) {
                        const opt = parts[3].toUpperCase();
                        if (opt === 'T') {
                            useTrueBearing = true;
                        } else if (opt.startsWith('T/')) {
                            useTrueBearing = true;
                            overrideSpeed = parseInt(opt.substring(2));
                        } else if (opt.startsWith('/')) {
                            overrideSpeed = parseInt(opt.substring(1));
                        }
                    }

                    const loc1 = await resolveLocation(loc1Str);
                    const loc2 = await resolveLocation(loc2Str);
                    if (!loc1) return { feedback: [{ type: 'err', text: `${loc1Str} NOT FOUND` }] };
                    if (!loc2) return { feedback: [{ type: 'err', text: `${loc2Str} NOT FOUND` }] };

                    const dist = gcDistNm(loc1.lat, loc1.lon, loc2.lat, loc2.lon);
                    const trueBrg = gcBearing(loc1.lat, loc1.lon, loc2.lat, loc2.lon);
                    const speed = overrideSpeed || (loc1.isTrack ? loc1.gs : null);
                    ra.textContent = formatRangeResult(dist, trueBrg, !useTrueBearing, loc1.lat, loc1.lon, speed, loc1.name, loc2.name);
                    return { feedback: [{ type: 'ok', text: 'ACCEPT' }] };
                }

                if (verb === 'LB') {
                    // LB <fix>[/<speed>] <loc|track>
                    if (parts.length < 3) return { feedback: [{ type: 'err', text: 'LB REQUIRES FIX AND LOCATION' }] };
                    let fixStr = parts[1].toUpperCase();
                    const loc2Str = parts[2].toUpperCase();
                    let overrideSpeed = null;
                    // Check for /<speed> appended to fix
                    const slashIdx = fixStr.indexOf('/');
                    if (slashIdx > 0) {
                        overrideSpeed = parseInt(fixStr.substring(slashIdx + 1));
                        fixStr = fixStr.substring(0, slashIdx);
                    }

                    const fix = await resolveLocation(fixStr);
                    const loc2 = await resolveLocation(loc2Str);
                    if (!fix) return { feedback: [{ type: 'err', text: `${fixStr} NOT FOUND` }] };
                    if (!loc2) return { feedback: [{ type: 'err', text: `${loc2Str} NOT FOUND` }] };

                    const dist = gcDistNm(fix.lat, fix.lon, loc2.lat, loc2.lon);
                    const trueBrg = gcBearing(fix.lat, fix.lon, loc2.lat, loc2.lon);
                    const speed = overrideSpeed || (loc2.isTrack ? loc2.gs : null);
                    ra.textContent = formatRangeResult(dist, trueBrg, true, fix.lat, fix.lon, speed, fix.name, loc2.name);
                    return { feedback: [{ type: 'ok', text: 'ACCEPT' }] };
                }

                if (verb === 'LC') {
                    // LC <fix>/<time> <track>
                    if (parts.length < 3) return { feedback: [{ type: 'err', text: 'LC REQUIRES FIX/TIME AND TRACK' }] };
                    let fixStr = parts[1].toUpperCase();
                    const trackStr = parts[2].toUpperCase();
                    const slashIdx = fixStr.indexOf('/');
                    if (slashIdx <= 0) return { feedback: [{ type: 'err', text: 'FORMAT: LC <FIX>/<TIME> <TRACK>' }] };
                    const timeStr = fixStr.substring(slashIdx + 1);
                    fixStr = fixStr.substring(0, slashIdx);
                    // Parse time as HHMM zulu
                    if (!/^\d{4}$/.test(timeStr)) return { feedback: [{ type: 'err', text: `INVALID TIME ${timeStr}` }] };
                    const tgtHours = parseInt(timeStr.substring(0, 2));
                    const tgtMinutes = parseInt(timeStr.substring(2, 4));

                    const fix = await resolveLocation(fixStr);
                    const track = await resolveLocation(trackStr);
                    if (!fix) return { feedback: [{ type: 'err', text: `${fixStr} NOT FOUND` }] };
                    if (!track || !track.isTrack) return { feedback: [{ type: 'err', text: `${trackStr} NOT A TRACK` }] };

                    const dist = gcDistNm(track.lat, track.lon, fix.lat, fix.lon);
                    const trueBrg = gcBearing(track.lat, track.lon, fix.lat, fix.lon);
                    // Time until target time
                    const now = new Date();
                    const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
                    let tgtMin = tgtHours * 60 + tgtMinutes;
                    if (tgtMin <= nowMin) tgtMin += 1440; // next day
                    const minutesLeft = tgtMin - nowMin;
                    if (minutesLeft <= 0) return { feedback: [{ type: 'err', text: 'TIME ALREADY PASSED' }] };
                    const reqSpeed = Math.round(dist / (minutesLeft / 60));
                    const magBrg = (trueBrg - magDeclination(track.lat, track.lon) + 360) % 360;
                    let text = `${track.name} - ${fix.name}\n`;
                    text += `${String(Math.round(magBrg)).padStart(3, '0')}M  ${dist.toFixed(1)} NM\n`;
                    text += `REQ SPD ${reqSpeed} KT  AT ${timeStr}Z (${minutesLeft} MIN)`;
                    if (track.gs != null) text += `\nCUR GS${Math.round(track.gs)}  ADJ ${reqSpeed - Math.round(track.gs) >= 0 ? '+' : ''}${reqSpeed - Math.round(track.gs)}`;
                    ra.textContent = text;
                    return { feedback: [{ type: 'ok', text: 'ACCEPT' }] };
                }
            } catch {
                return { feedback: [{ type: 'err', text: 'RANGE CALC FAILED' }] };
            }
        })();
    }

    // LF <location> [<label>] [<aircraft>] — Create CRR group
    // LF <label> <aircraft> — Add aircraft to existing CRR group
    if (verb === 'LF') {
        return (async () => {
            try {
                if (parts.length < 2) {
                    return { feedback: [{ type: 'err', text: 'LF REQUIRES LOCATION AND/OR LABEL' }] };
                }

                const arg1 = parts[1].toUpperCase();
                const isLocationPrefix = arg1.startsWith('//');

                // If arg1 doesn't have //, treat it as a group label (existing or to be added to)
                if (!isLocationPrefix && parts.length >= 3) {
                    // LF <label> <aircraft> — Add or remove from existing group (toggle)
                    const label = arg1;
                    if (!crrGroups.has(label)) {
                        return { feedback: [{ type: 'err', text: `GROUP ${label} NOT FOUND` }] };
                    }

                    const group = crrGroups.get(label);
                    const acParts = parts.slice(2).join('/').split('/');
                    let addedCount = 0, removedCount = 0;

                    for (const acStr of acParts) {
                        const f = findFlight(acStr.toUpperCase());
                        if (!f || !f.latitude || !f.longitude) {
                            return { feedback: [{ type: 'err', text: `${acStr} NOT FOUND OR NO POS` }] };
                        }

                        const existingIdx = group.aircraft.findIndex(a => a.gufi === f.gufi);
                        if (existingIdx >= 0) {
                            // Aircraft already in group — remove it
                            group.aircraft.splice(existingIdx, 1);
                            removedCount++;
                            // Invalidate marker to update RDB visibility
                            invalidateMarker(f.gufi);
                        } else {
                            // Aircraft not in group — add it
                            const distance = calculateNmDistance(group.lat, group.lon, f.latitude, f.longitude);
                            group.aircraft.push({
                                gufi: f.gufi,
                                callsign: f.callsign,
                                cid: getCid(f),
                                distance: distance
                            });
                            addedCount++;
                            // Invalidate marker to update RDB visibility
                            invalidateMarker(f.gufi);
                        }
                    }

                    updateCrrMenuBody();
                    lastRenderTime = 0;  // Force immediate render
                    let msg = '';
                    if (addedCount > 0) msg += `${addedCount} AC ADDED `;
                    if (removedCount > 0) msg += `${removedCount} AC REMOVED`;
                    return { feedback: [
                        { type: 'ok', text: 'ACCEPT' },
                        { type: 'info', text: `CRR ${label} ${msg}` }
                    ]};
                }

                // Try to resolve arg1 as a location (must have // prefix)
                const loc = isLocationPrefix ? await resolveLocation(arg1.substring(2)) : null;

                if (loc) {
                    // LF <location> [<label>] [<aircraft>]
                    // Label is optional if location is a fix/navaid
                    let label = loc.name || arg1;  // Use location name as default label
                    let aircraftStartIdx = 2;

                    // If second arg looks like a label (1-5 chars), use it as label
                    if (parts.length >= 3 && /^[A-Z0-9]{1,5}$/.test(parts[2].toUpperCase())) {
                        label = parts[2].toUpperCase();
                        aircraftStartIdx = 3;
                    }

                    // Validate label: 1-5 alphanumeric characters
                    if (!/^[A-Z0-9]{1,5}$/.test(label)) {
                        return { feedback: [{ type: 'err', text: 'LABEL MUST BE 1-5 ALPHANUMERIC' }] };
                    }

                    if (crrGroups.has(label)) {
                        return { feedback: [{ type: 'err', text: `GROUP ${label} EXISTS` }] };
                    }

                    // Create the group with selected color
                    crrGroups.set(label, { lat: loc.lat, lon: loc.lon, aircraft: [], color: crrColor });

                    // If aircraft specified, add them
                    if (parts.length >= aircraftStartIdx + 1) {
                        const acParts = parts.slice(aircraftStartIdx).join('/').split('/');
                        for (const acStr of acParts) {
                            const f = findFlight(acStr.toUpperCase());
                            if (!f || !f.latitude || !f.longitude) {
                                crrGroups.delete(label);
                                return { feedback: [{ type: 'err', text: `${acStr} NOT FOUND OR NO POS` }] };
                            }
                            const distance = calculateNmDistance(loc.lat, loc.lon, f.latitude, f.longitude);
                            crrGroups.get(label).aircraft.push({
                                gufi: f.gufi,
                                callsign: f.callsign,
                                cid: getCid(f),
                                distance: distance
                            });
                            // Invalidate marker to update RDB visibility
                            invalidateMarker(f.gufi);
                        }
                    }

                    updateCrrMenuBody();
                    lastRenderTime = 0;  // Force immediate render
                    return { feedback: [
                        { type: 'ok', text: 'ACCEPT' },
                        { type: 'info', text: `CRR ${label}` }
                    ]};
                } else {
                    return { feedback: [{ type: 'err', text: 'LF FORMAT ERROR' }] };
                }
            } catch (e) {
                console.warn('[LF] Error:', e);
                return { feedback: [{ type: 'err', text: 'LF COMMAND FAILED' }] };
            }
        })();
    }

    // QL [sector/dest ...] — Quick Look: force FDB on specific sectors or destinations; QL alone clears all
    // Sectors are numeric-only (e.g. 32, 05); destinations contain letters (e.g. KCLT, DCA)
    if (verb === 'QL') {
        const args = parts.slice(1).map(s => s.toUpperCase());
        quickLookSectors.clear();
        quickLookDests.clear();
        for (const a of args) {
            if (/^\d+$/.test(a)) {
                quickLookSectors.add(a);
            } else {
                // SFDPS stores ICAO (KDCA); accept both KDCA and DCA
                quickLookDests.add(a);
                if (a.length === 3) quickLookDests.add('K' + a);
            }
        }
        invalidateAllMarkers();
        lastRenderTime = 0;
        const feedback = [
            { type: 'ok', text: 'ACCEPT' },
            { type: 'info', text: 'QUICK LOOK' },
        ];
        if (args.length > 0) feedback.push({ type: 'info', text: args.join(' ') });
        return { feedback };
    }

    // QP J <FLID>          — toggle standard DRI (5nm halo)
    // QP T <FLID>          — toggle reduced DRI (3nm halo)
    // QP A [sector] <FLID> — acknowledge a pending point out (P→A)
    // QP <FLID>            — clear point-out + FDB→LDB
    if (verb === 'QP') {
        if (parts.length < 2) {
            return { feedback: [{ type: 'err', text: 'MESSAGE TOO SHORT' }] };
        }
        const sub = parts[1].toUpperCase();

        // DRI: QP J / QP T
        if ((sub === 'J' || sub === 'T') && parts.length >= 3) {
            const flid = parts.slice(2).join('').toUpperCase();
            const f = findFlight(flid);
            if (f) {
                const cid = getCid(f) || '???';
                if (sub === 'T') {
                    const alt = f.reportedAltitude ?? f.assignedAltitude;
                    if (alt != null && alt > 23000) {
                        return { feedback: [
                            { type: 'err', text: `REJECT - ${cid} NOT ELIGIBLE` },
                            { type: 'err', text: 'FOR REDUCED SEPARATION' },
                            { type: 'info', text: `REQ/DELETE DRI ${f.callsign}` }
                        ]};
                    }
                }
                const existing = driActive.get(f.gufi);
                if (existing === sub) {
                    driActive.delete(f.gufi);
                } else {
                    driActive.set(f.gufi, sub);
                }
                lastRenderTime = 0;
                return { feedback: [
                    { type: 'ok', text: 'ACCEPT' },
                    { type: 'info', text: 'REQ/DELETE DRI' },
                    { type: 'info', text: `${f.callsign}/${cid}` }
                ]};
            }
            return { feedback: [{ type: 'err', text: 'FLIGHT NOT FOUND' }] };
        }

        // Point-out acknowledge: QP A [sector] <FLID>
        if (sub === 'A' && parts.length >= 3) {
            const flidStr = parts[parts.length - 1].toUpperCase();
            const f = findFlight(flidStr);
            if (!f) return { feedback: [{ type: 'err', text: 'FLID NOT STORED' }] };
            const poInfo = getPointoutIndicator(f);
            if (!poInfo) {
                return { feedback: [{ type: 'err', text: 'NO POINT OUT' }] };
            }
            if (poInfo.role === 'receiver') {
                f.pointoutOriginatingUnit = null;
                f.pointoutReceivingUnit = null;
                pointoutAcked.delete(f.gufi);
            } else {
                pointoutAcked.add(f.gufi);
            }
            closePointoutMenu();
            invalidateMarker(f.gufi);
            return { feedback: [
                { type: 'ok', text: 'ACCEPT \u2014 ACKNOWLEDGE PO' },
                { type: 'info', text: f.callsign || '???' }
            ]};
        }

        // Clear point-out + FDB→LDB: QP <FLID>
        {
            const flidStr = parts.slice(1).join('').toUpperCase();
            const f = findFlight(flidStr);
            if (!f) return { feedback: [{ type: 'err', text: 'FLID NOT STORED' }] };
            pointoutAcked.delete(f.gufi);
            pointoutBlocked.delete(f.gufi);  // only QP <FLID> unblocks the FLID toggle
            f.pointoutOriginatingUnit = null;
            f.pointoutReceivingUnit = null;
            pointoutFirstSeen.delete(f.gufi);
            closePointoutMenu();
            const cls = classifyTrack(f);
            if (cls !== 'own' && cls !== 'ho' && cls !== 'emrg') {
                fdbOverrides.set(f.gufi, false);
            }
            invalidateMarker(f.gufi);
            return { feedback: [
                { type: 'ok', text: 'ACCEPT' },
                { type: 'info', text: `PO CLR ${f.callsign || '???'}` }
            ]};
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // QZ <altitude> <FLID> — Set assigned (flight plan) altitude
    // QZ VFR <FLID> | QZ VFR/<alt> <FLID> | QZ OTP <FLID>
    // QZ <floor>B<ceiling> <FLID> — Block altitude
    // ═══════════════════════════════════════════════════════════════════════
    if (verb === 'QZ') {
        if (parts.length < 2) {
            return { feedback: [{ type: 'err', text: 'FLID NOT STORED' }] };
        }

        const arg1 = parts[1].toUpperCase();

        // QZ VFR <FLID> or QZ VFR/<alt> <FLID> or QZ OTP <FLID>
        if (arg1 === 'VFR' || arg1.startsWith('VFR/') || arg1 === 'OTP') {
            let rules, altFeet = null;
            if (arg1 === 'OTP') {
                rules = 'OTP';
            } else if (arg1.startsWith('VFR/')) {
                rules = 'VFR';
                const altStr = arg1.substring(4);
                altFeet = parseAltitude(altStr);
                if (altFeet == null) return { feedback: [{ type: 'err', text: 'INVALID ALTITUDE' }] };
            } else {
                rules = 'VFR';
            }
            const flidStr = parts.slice(2).join('').toUpperCase();
            if (!flidStr) return { feedback: [{ type: 'err', text: 'FLID NOT STORED' }] };
            const f = findFlight(flidStr);
            if (!f) return { feedback: [{ type: 'err', text: 'FLID NOT STORED' }] };
            if (!isOwnTrack(f)) return rejectNotOwned('ASSIGNED ALT', f);
            localAssignedAlt.set(f.gufi, { feet: altFeet, rules, block: null, serverVal: f.assignedAltitude ?? null });
            invalidateMarker(f.gufi);
            const altDisp = altFeet != null ? '/' + String(Math.round(altFeet / 100)).padStart(3, '0') : '';
            return { feedback: [
                { type: 'ok', text: 'ACCEPT' },
                { type: 'info', text: 'ASSIGNED ALT' },
                { type: 'info', text: `${f.callsign || '???'}/${rules}${altDisp}` }
            ]};
        }

        // QZ <floor>B<ceiling> <FLID> — Block altitude
        const blockMatch = arg1.match(/^(\d{2,3})B(\d{2,3})$/);
        if (blockMatch) {
            const flidStr = parts.slice(2).join('').toUpperCase();
            if (!flidStr) return { feedback: [{ type: 'err', text: 'FLID NOT STORED' }] };
            const f = findFlight(flidStr);
            if (!f) return { feedback: [{ type: 'err', text: 'FLID NOT STORED' }] };
            if (!isOwnTrack(f)) return rejectNotOwned('ASSIGNED ALT', f);
            const floor = parseInt(blockMatch[1]) * 100;
            const ceil = parseInt(blockMatch[2]) * 100;
            const blockDisp = blockMatch[1].padStart(3, '0') + 'B' + blockMatch[2].padStart(3, '0');
            localAssignedAlt.set(f.gufi, { feet: floor, rules: null, block: blockDisp, serverVal: f.assignedAltitude ?? null });
            invalidateMarker(f.gufi);
            return { feedback: [
                { type: 'ok', text: 'ACCEPT' },
                { type: 'info', text: 'ASSIGNED ALT' },
                { type: 'info', text: `${f.callsign || '???'}/${blockDisp}` }
            ]};
        }

        // QZ <altitude> <FLID> — Normal assigned altitude
        const altFeet = parseAltitude(arg1);
        if (altFeet != null) {
            const flidStr = parts.slice(2).join('').toUpperCase();
            if (!flidStr) return { feedback: [{ type: 'err', text: 'FLID NOT STORED' }] };
            const f = findFlight(flidStr);
            if (!f) return { feedback: [{ type: 'err', text: 'FLID NOT STORED' }] };
            if (!isOwnTrack(f)) return rejectNotOwned('ASSIGNED ALT', f);
            localAssignedAlt.set(f.gufi, { feet: altFeet, rules: null, block: null, serverVal: f.assignedAltitude ?? null });
            invalidateMarker(f.gufi);
            const altDisp = String(Math.round(altFeet / 100)).padStart(3, '0');
            return { feedback: [
                { type: 'ok', text: 'ACCEPT' },
                { type: 'info', text: 'ASSIGNED ALT' },
                { type: 'info', text: `${f.callsign || '???'}/${altDisp}` }
            ]};
        }

        // QZ <FLID> with no altitude — error
        return { feedback: [{ type: 'err', text: 'FLID NOT STORED' }] };
    }

    // ═══════════════════════════════════════════════════════════════════════
    // QQ <altitude> <FLID...> — Set interim altitude
    // QQ R<alt> <FLID> — Set interim + reported altitude
    // QQ L<alt> <FLID> — Set local interim altitude
    // QQ P<alt> <FLID> — Set procedure altitude
    // QQ <FLID> — Clear interim/procedure altitude
    // QQ L <FLID> — Clear local interim altitude
    // Multiple FLIDs: QQ 110 JBU123/429/AAL924
    // Override: QQ /TT P150 JBU123
    // ═══════════════════════════════════════════════════════════════════════
    if (verb === 'QQ') {
        if (parts.length < 2) {
            return { feedback: [{ type: 'err', text: 'MESSAGE TOO SHORT' }] };
        }

        // Check for /TT override prefix (skip logic checks)
        let argStart = 1;
        if (parts[1].toUpperCase() === '/TT' || parts[1] === '///') {
            argStart = 2;
            if (parts.length < 3) return { feedback: [{ type: 'err', text: 'MESSAGE TOO SHORT' }] };
        }

        const qqArg1 = parts[argStart].toUpperCase();

        // QQ L <FLID> — Clear local interim altitude (L followed by space then FLID)
        if (qqArg1 === 'L' && parts.length > argStart + 1) {
            const qqFlids = parts.slice(argStart + 1).join('').toUpperCase().split('/').filter(s => s);
            const qqRes = resolveFlids(qqFlids);
            if (qqRes.found.length === 0) {
                return { feedback: [
                    { type: 'err', text: 'REJECT - CID NOT STORED' },
                    { type: 'info', text: 'INTERIM ALT' },
                    { type: 'info', text: `QQ ${parts.slice(1).join(' ')}` }
                ]};
            }
            const qqFb = [{ type: 'ok', text: 'ACCEPT' }, { type: 'info', text: 'INTERIM ALT' }];
            for (const f of qqRes.found) {
                const li = localInterimAlt.get(f.gufi);
                if (li && li.type === 'L') {
                    localInterimAlt.delete(f.gufi);
                    invalidateMarker(f.gufi);
                    qqFb.push({ type: 'info', text: `${f.callsign || '???'}/CLR` });
                } else {
                    qqFb.push({ type: 'err', text: 'REJECT - NO INTERIM ALTITUDE' });
                    qqFb.push({ type: 'info', text: `QQ ${getCid(f) || f.callsign || '???'}` });
                }
            }
            return { feedback: qqFb };
        }

        // Parse altitude prefix: R, L, P, or plain
        let qqAltPrefix = '';
        let qqAltArg = qqArg1;
        if (/^[RLP]\d/.test(qqArg1)) {
            qqAltPrefix = qqArg1.charAt(0);
            qqAltArg = qqArg1.substring(1);
        }

        const qqAltFeet = parseAltitude(qqAltArg);
        const qqFlidAfter = parts.slice(argStart + 1).join('').toUpperCase();

        // QQ [R|L|P]<altitude> <FLID...> — Set interim/procedure/local altitude
        if (qqAltFeet != null && qqFlidAfter) {
            const qqFlids = qqFlidAfter.split('/').filter(s => s);
            const qqRes = resolveFlids(qqFlids);
            if (qqRes.found.length === 0) {
                return { feedback: [
                    { type: 'err', text: 'REJECT - CID NOT STORED' },
                    { type: 'info', text: 'INTERIM ALT' },
                    { type: 'info', text: `QQ ${parts.slice(1).join(' ')}` }
                ]};
            }
            const qqAltDisp = String(Math.round(qqAltFeet / 100)).padStart(3, '0');
            const qqFb = [];
            let qqAnyOk = false;
            for (const f of qqRes.found) {
                // Ownership check: QQ L (local interim) exempt; all others require ownership
                if (qqAltPrefix !== 'L' && !isOwnTrack(f)) {
                    qqFb.push({ type: 'err', text: 'REJECT - NOT YOUR TRACK' });
                    qqFb.push({ type: 'info', text: `INTERIM ALT ${f.callsign || '???'}` });
                    continue;
                }
                const itype = qqAltPrefix === 'P' ? 'P' : qqAltPrefix === 'L' ? 'L' : 'I';
                localInterimAlt.set(f.gufi, { feet: qqAltFeet, type: itype, serverVal: f.interimAltitude ?? null });
                if (qqAltPrefix === 'R') localReportedAlt.set(f.gufi, { feet: qqAltFeet, serverVal: f.reportedAltitude ?? null });
                invalidateMarker(f.gufi);
                qqFb.push({ type: 'info', text: `${f.callsign || '???'}/${qqAltDisp}` });
                qqAnyOk = true;
            }
            if (qqAnyOk) qqFb.unshift({ type: 'ok', text: 'ACCEPT' }, { type: 'info', text: 'INTERIM ALT' });
            for (const nf of qqRes.notFound) {
                qqFb.push({ type: 'err', text: 'REJECT - CID NOT STORED' });
                qqFb.push({ type: 'info', text: `QQ ${nf}` });
            }
            return { feedback: qqFb };
        }

        // QQ P<alt> or QQ R<alt> with no FLID — error (prefixed altitudes require a FLID)
        if (qqAltFeet != null && qqAltPrefix) {
            return { feedback: [
                { type: 'err', text: 'REJECT - CID NOT STORED' },
                { type: 'info', text: 'INTERIM ALT' },
                { type: 'info', text: `QQ ${parts.slice(1).join(' ')}` }
            ]};
        }

        // QQ <FLID> — Clear interim/procedure altitude
        // (includes bare numbers like QQ 046 where 046 is a CID, not an altitude)
        const qqClearStr = parts.slice(argStart).join('').toUpperCase();
        const qqClearFlids = qqClearStr.split('/').filter(s => s);
        const qqClearRes = resolveFlids(qqClearFlids);
        if (qqClearRes.found.length === 0) {
            return { feedback: [
                { type: 'err', text: 'REJECT - CID NOT STORED' },
                { type: 'info', text: 'INTERIM ALT' },
                { type: 'info', text: `QQ ${parts.slice(1).join(' ')}` }
            ]};
        }
        const qqClearFb = [];
        let qqClearAnyOk = false;
        for (const f of qqClearRes.found) {
            if (!isOwnTrack(f)) {
                qqClearFb.push({ type: 'err', text: 'REJECT - NOT YOUR TRACK' });
                qqClearFb.push({ type: 'info', text: `INTERIM ALT ${f.callsign || '???'}` });
                continue;
            }
            const li = localInterimAlt.get(f.gufi);
            const hasSwimInterim = f.interimAltitude != null;
            if (li || hasSwimInterim) {
                // Set null sentinel to suppress stale server interim (local wins = null = no interim)
                // Auto-clear will remove this when server sends genuinely new data
                if (hasSwimInterim) {
                    localInterimAlt.set(f.gufi, { feet: null, type: null, serverVal: f.interimAltitude });
                } else {
                    localInterimAlt.delete(f.gufi);
                }
                invalidateMarker(f.gufi);
                qqClearFb.push({ type: 'info', text: `${f.callsign || '???'}/CLR` });
                qqClearAnyOk = true;
            } else {
                qqClearFb.push({ type: 'err', text: 'REJECT - NO INTERIM ALTITUDE' });
                qqClearFb.push({ type: 'info', text: 'INTERIM ALT' });
                qqClearFb.push({ type: 'info', text: `QQ ${getCid(f) || f.callsign || '???'}` });
            }
        }
        if (qqClearAnyOk) qqClearFb.unshift({ type: 'ok', text: 'ACCEPT' }, { type: 'info', text: 'INTERIM ALT' });
        return { feedback: qqClearFb };
    }

    // ═══════════════════════════════════════════════════════════════════════
    // QR <altitude> <FLID> — Set controller-entered reported altitude (CERA)
    // ═══════════════════════════════════════════════════════════════════════
    if (verb === 'QR') {
        if (parts.length < 3) {
            return { feedback: [{ type: 'err', text: 'MESSAGE TOO SHORT' }] };
        }
        const altFeet = parseAltitude(parts[1].toUpperCase());
        if (altFeet == null) {
            return { feedback: [{ type: 'err', text: 'INVALID ALTITUDE' }] };
        }
        const flidStr = parts.slice(2).join('').toUpperCase();
        const f = findFlight(flidStr);
        if (!f) return { feedback: [{ type: 'err', text: 'FLID NOT STORED' }] };
        if (!isOwnTrack(f)) return rejectNotOwned('REPORTED ALT', f);
        localReportedAlt.set(f.gufi, { feet: altFeet, serverVal: f.reportedAltitude ?? null });
        invalidateMarker(f.gufi);
        const altDisp = String(Math.round(altFeet / 100)).padStart(3, '0');
        return { feedback: [
            { type: 'ok', text: 'ACCEPT' },
            { type: 'info', text: 'REPORTED ALT' },
            { type: 'info', text: `${f.callsign || '???'}/${altDisp}` }
        ]};
    }

    // ═══════════════════════════════════════════════════════════════════════
    // QS — Heading/Speed/Free text (HSF) data
    // QS `<text> <FLID>   — set free text (backtick = ⵔ clear weather symbol)
    // QS <heading> <FLID>  — set heading (3-digit, 001-360)
    // QS /<speed> <FLID>   — set speed
    // QS */ <FLID>         — delete heading
    // QS /* <FLID>         — delete speed
    // QS * <FLID>          — delete all HSF
    // QS <FLID>            — toggle HSF display on line 4
    // ═══════════════════════════════════════════════════════════════════════
    if (verb === 'QS') {
        if (parts.length < 2) {
            return { feedback: [{ type: 'err', text: 'MESSAGE TOO SHORT' }] };
        }

        const qsArg1 = parts[1];
        const qsArg1Up = qsArg1.toUpperCase();

        // QS * <FLID> — delete all HSF
        if (qsArg1 === '*' && parts.length >= 3) {
            const flidStr = parts.slice(2).join('').toUpperCase();
            const f = findFlight(flidStr);
            if (!f) return { feedback: [{ type: 'err', text: 'FLID NOT STORED' }] };
            if (!isOwnTrack(f)) return rejectNotOwned('HSF', f);
            hsfData.delete(f.gufi);
            hsfShowMap.delete(f.gufi);
            // Suppress server clearance data — record what we're hiding so incoming
            // updates with the SAME values don't re-apply. New/different values will show.
            hsfClrSuppressed.set(f.gufi, {
                h: f.clearanceHeading || null, s: f.clearanceSpeed || null, t: f.clearanceText || null
            });
            f.clearanceHeading = null;
            f.clearanceSpeed = null;
            f.clearanceText = null;
            invalidateMarker(f.gufi);
            return { feedback: [
                { type: 'ok', text: 'ACCEPT' },
                { type: 'info', text: 'CLR ALL HSF' },
                { type: 'info', text: `${f.callsign || '???'}/${getCid(f) || '???'}` }
            ]};
        }

        // QS */ <FLID> — delete heading
        if (qsArg1 === '*/' && parts.length >= 3) {
            const flidStr = parts.slice(2).join('').toUpperCase();
            const f = findFlight(flidStr);
            if (!f) return { feedback: [{ type: 'err', text: 'FLID NOT STORED' }] };
            if (!isOwnTrack(f)) return rejectNotOwned('HSF', f);
            const hsf = hsfData.get(f.gufi);
            if (hsf) { hsf.heading = null; if (!hsf.speed && !hsf.freeText) { hsfData.delete(f.gufi); hsfShowMap.delete(f.gufi); } }
            const sup = hsfClrSuppressed.get(f.gufi) || { h: null, s: null, t: null };
            sup.h = f.clearanceHeading || null;
            hsfClrSuppressed.set(f.gufi, sup);
            f.clearanceHeading = null;
            invalidateMarker(f.gufi);
            return { feedback: [
                { type: 'ok', text: 'ACCEPT' },
                { type: 'info', text: 'CLR HEADING' },
                { type: 'info', text: `${f.callsign || '???'}/${getCid(f) || '???'}` }
            ]};
        }

        // QS /* <FLID> — delete speed
        if (qsArg1 === '/*' && parts.length >= 3) {
            const flidStr = parts.slice(2).join('').toUpperCase();
            const f = findFlight(flidStr);
            if (!f) return { feedback: [{ type: 'err', text: 'FLID NOT STORED' }] };
            if (!isOwnTrack(f)) return rejectNotOwned('HSF', f);
            const hsf = hsfData.get(f.gufi);
            if (hsf) { hsf.speed = null; if (!hsf.heading && !hsf.freeText) { hsfData.delete(f.gufi); hsfShowMap.delete(f.gufi); } }
            const sup2 = hsfClrSuppressed.get(f.gufi) || { h: null, s: null, t: null };
            sup2.s = f.clearanceSpeed || null;
            hsfClrSuppressed.set(f.gufi, sup2);
            f.clearanceSpeed = null;
            invalidateMarker(f.gufi);
            return { feedback: [
                { type: 'ok', text: 'ACCEPT' },
                { type: 'info', text: 'CLR SPEED' },
                { type: 'info', text: `${f.callsign || '???'}/${getCid(f) || '???'}` }
            ]};
        }

        // QS `<text> <FLID> — set free text (backtick prefix)
        if (qsArg1.startsWith('`') && parts.length >= 3) {
            const text = qsArg1.substring(1) + (parts.length > 3 ? ' ' + parts.slice(2, -1).join(' ') : '');
            const flidStr = parts[parts.length - 1].toUpperCase();
            const f = findFlight(flidStr);
            if (!f) return { feedback: [{ type: 'err', text: 'FLID NOT STORED' }] };
            if (!isOwnTrack(f)) return rejectNotOwned('HSF', f);
            const hsf = hsfData.get(f.gufi) || {};
            hsf.freeText = text.toUpperCase();
            hsf.heading = null;
            hsf.speed = null;
            hsfData.set(f.gufi, hsf);
            hsfShowMap.add(f.gufi);
            invalidateMarker(f.gufi);
            return { feedback: [
                { type: 'ok', text: 'ACCEPT' },
                { type: 'info', text: 'FDB DATA' },
                { type: 'info', text: `${f.callsign || '???'}/${getCid(f) || '???'}` }
            ]};
        }

        // QS /<speed> <FLID> — set speed (/ prefix required)
        // Speed formats: /S<knots>, /M<mach>, /M<mach>+, /M<mach>-, /<knots>+, /<knots>-
        if (qsArg1.startsWith('/') && qsArg1.length > 1 && parts.length >= 3) {
            const spdVal = qsArg1.substring(1).toUpperCase();
            let qsSpeed = null;
            // S<knots>
            const sMatch = /^S(\d{1,4})$/i.exec(spdVal);
            if (sMatch) qsSpeed = 'S' + sMatch[1];
            // M<digits>[+/-]
            if (!qsSpeed) {
                const mMatch = /^M(\d{1,3})([+-]?)$/i.exec(spdVal);
                if (mMatch) qsSpeed = 'M' + mMatch[1] + mMatch[2];
            }
            // <digits>+/-
            if (!qsSpeed) {
                const kMatch = /^(\d{1,4})([+-])$/.exec(spdVal);
                if (kMatch) qsSpeed = kMatch[1] + kMatch[2];
            }
            if (!qsSpeed) return { feedback: [{ type: 'err', text: 'INVALID SPEED FORMAT' }] };
            const flidStr = parts.slice(2).join('').toUpperCase();
            const f = findFlight(flidStr);
            if (!f) return { feedback: [{ type: 'err', text: 'FLID NOT STORED' }] };
            if (!isOwnTrack(f)) return rejectNotOwned('HSF', f);
            const hsf = hsfData.get(f.gufi) || { heading: null, speed: null, freeText: null };
            hsf.speed = qsSpeed;
            hsf.freeText = null;
            hsfData.set(f.gufi, hsf);
            hsfShowMap.add(f.gufi);
            invalidateMarker(f.gufi);
            return { feedback: [
                { type: 'ok', text: 'ACCEPT' },
                { type: 'info', text: 'FDB DATA' },
                { type: 'info', text: `${f.callsign || '???'}/${getCid(f) || '???'}` }
            ]};
        }

        // QS <heading> <FLID> — set heading
        // Heading formats: H<degrees 001-360>, <degrees>L, <degrees>R (deviation)
        if (parts.length >= 3) {
            const val = qsArg1Up;
            let qsHeading = null;
            // H<degrees>
            const hMatch = /^H(\d{1,3})$/i.exec(val);
            if (hMatch) {
                const deg = parseInt(hMatch[1]);
                if (deg >= 1 && deg <= 360) qsHeading = 'H' + String(deg).padStart(3, '0');
            }
            // Heading deviation: <digits>L or <digits>R
            if (!qsHeading) {
                const devMatch = /^(\d{1,3})([LR])$/i.exec(val);
                if (devMatch) {
                    const deg = parseInt(devMatch[1]);
                    if (deg >= 1 && deg <= 180) qsHeading = String(deg) + devMatch[2].toUpperCase();
                }
            }
            if (qsHeading) {
                const flidStr = parts.slice(2).join('').toUpperCase();
                const f = findFlight(flidStr);
                if (!f) return { feedback: [{ type: 'err', text: 'FLID NOT STORED' }] };
                if (!isOwnTrack(f)) return rejectNotOwned('HSF', f);
                const hsf = hsfData.get(f.gufi) || { heading: null, speed: null, freeText: null };
                hsf.heading = qsHeading;
                hsf.freeText = null;
                hsfData.set(f.gufi, hsf);
                hsfShowMap.add(f.gufi);
                invalidateMarker(f.gufi);
                return { feedback: [
                    { type: 'ok', text: 'ACCEPT' },
                    { type: 'info', text: 'FDB DATA' },
                    { type: 'info', text: `${f.callsign || '???'}/${getCid(f) || '???'}` }
                ]};
            }
            // Invalid heading format if it looks like a heading attempt
            if (/^H/i.test(val) || /\d[LR]$/i.test(val)) {
                return { feedback: [{ type: 'err', text: 'INVALID HEADING FORMAT' }] };
            }
        }

        // QS <FLID> — toggle HSF display (single argument, not a heading)
        {
            const flidStr = parts.slice(1).join('').toUpperCase();
            const f = findFlight(flidStr);
            if (f) {
                if (hsfShowMap.has(f.gufi)) hsfShowMap.delete(f.gufi);
                else hsfShowMap.add(f.gufi);
                invalidateMarker(f.gufi);
                return { feedback: [
                    { type: 'ok', text: 'ACCEPT' },
                    { type: 'info', text: hsfShowMap.has(f.gufi) ? 'SHOW HSF' : 'HIDE HSF' },
                    { type: 'info', text: `${f.callsign || '???'}/${getCid(f) || '???'}` }
                ]};
            }
        }

        return { feedback: [{ type: 'err', text: 'FLID NOT STORED' }] };
    }

    // (QP handler consolidated above with DRI + point-out + clear)

    // ═══════════════════════════════════════════════════════════════════════
    // QX <FLID>            — drop a track from display (instant timeout)
    // ═══════════════════════════════════════════════════════════════════════
    if (verb === 'QX') {
        if (parts.length < 2) return { feedback: [{ type: 'err', text: 'QX REQUIRES FLID' }] };
        const flid = parts.slice(1).join('').toUpperCase();
        const f = findFlight(flid);
        if (!f) return { feedback: [{ type: 'err', text: `${flid} NOT FOUND` }] };
        manuallyHidden.add(f.gufi);
        wasOwnOrHo.delete(f.gufi);
        fdbOverrides.delete(f.gufi);
        const m = markers.get(f.gufi);
        if (m) { const el = m.getElement(); if (el) el.style.display = 'none'; }
        return { feedback: [
            { type: 'ok', text: 'ACCEPT' },
            { type: 'info', text: `DROP ${f.callsign || '???'}` }
        ]};
    }

    // .FIND <ident> — highlight a fix/navaid/airport on the scope
    if ((verb === '.FIND' || verb === '.F') && parts.length >= 2) {
        const ident = parts.slice(1).join('').toUpperCase();
        return (async () => {
            try {
                const resp = await fetch(`/api/nasr/find/${encodeURIComponent(ident)}`);
                if (!resp.ok) {
                    return { feedback: [{ type: 'err', text: `${ident} NOT FOUND` }] };
                }
                const data = await resp.json();
                setFindMarker(data.ident, data.lat, data.lon);
                return { feedback: [
                    { type: 'ok', text: 'ACCEPT' },
                    { type: 'info', text: `FIND ${data.ident}` }
                ]};
            } catch {
                return { feedback: [{ type: 'err', text: 'NASR DATA UNAVAILABLE' }] };
            }
        })();
    }

    // .SID/.STAR/.PROC — toggle procedure overlays on the map
    if (verb === '.SID' || verb === '.STAR' || verb === '.PROC') {
        const apiType = verb === '.SID' ? 'DP' : verb === '.STAR' ? 'STAR' : '';
        const displayType = verb === '.SID' ? 'SID' : verb === '.STAR' ? 'STAR' : 'PROC';
        const args = parts.slice(1).map(a => a.toUpperCase());

        // No args: show active procedures in Response Area
        if (args.length === 0) {
            const relevant = [...activeProcedures.entries()]
                .filter(([k]) => displayType === 'PROC' || k.startsWith(displayType + ':'));
            if (relevant.length === 0) return { feedback: [{ type: 'info', text: `NO ACTIVE ${displayType}` }] };
            const ra = document.getElementById('ra-content');
            let text = `ACTIVE ${displayType}\n`;
            for (const [k, v] of relevant) {
                const names = v.procs.map(p => `${p.airport}/${p.id}`).join(' ');
                text += `${k}: ${names}\n`;
            }
            ra.textContent = text.trimEnd();
            return { feedback: [{ type: 'ok', text: 'ACCEPT' }] };
        }

        // Ensure PROC slider brightness > 0
        if (nasrBrightness.proc <= 0) {
            nasrBrightness.proc = 60;
            document.getElementById('rng-proc').value = 60;
            document.getElementById('lbl-proc').textContent = 60;
        }

        return (async () => {
            const feedback = [];
            for (const arg of args) {
                const key = `${displayType}:${arg}`;
                // Toggle: if already active, remove
                if (activeProcedures.has(key)) {
                    const entry = activeProcedures.get(key);
                    if (map.hasLayer(entry.layer)) map.removeLayer(entry.layer);
                    activeProcedures.delete(key);
                    feedback.push({ type: 'info', text: `${key} REMOVED` });
                    continue;
                }
                // Fetch from server
                try {
                    const typeParam = apiType ? `&type=${apiType}` : '';
                    const resp = await fetch(`/api/nasr/procgeo?q=${encodeURIComponent(arg)}${typeParam}`);
                    if (!resp.ok) { feedback.push({ type: 'err', text: `${arg} NOT FOUND` }); continue; }
                    const data = await resp.json();
                    if (!data || data.length === 0) { feedback.push({ type: 'err', text: `${arg} NOT FOUND` }); continue; }
                    const group = L.layerGroup();
                    renderProcedureLegs(data, group, nasrBrightness.proc);
                    group.addTo(map);
                    activeProcedures.set(key, { layer: group, procs: data, query: arg });
                    const names = data.map(p => `${p.airport}/${p.id}`).join(' ');
                    feedback.push({ type: 'info', text: `${key}: ${names}` });
                } catch {
                    feedback.push({ type: 'err', text: 'NASR DATA UNAVAILABLE' });
                }
            }
            if (feedback.length === 0) return { feedback: [{ type: 'ok', text: 'ACCEPT' }] };
            return { feedback: [{ type: 'ok', text: 'ACCEPT' }, ...feedback] };
        })();
    }

    // .NOPROC — clear all procedure overlays
    if (verb === '.NOPROC') {
        clearProcOverlay();
        return { feedback: [{ type: 'ok', text: 'ACCEPT' }, { type: 'info', text: 'CLEAR PROCEDURES' }] };
    }

    // <FLID> — toggle FDB/LDB (single argument, not a known verb)
    if (parts.length === 1 && verb) {
        const f = findFlight(verb);
        if (f) {
            // If manually hidden, restore it first
            if (manuallyHidden.has(f.gufi)) {
                manuallyHidden.delete(f.gufi);
                fdbOverrides.set(f.gufi, true);
                invalidateMarker(f.gufi);
                lastRenderTime = 0;
                return { feedback: [
                    { type: 'ok', text: 'ACCEPT' },
                    { type: 'info', text: `RESTORE ${f.callsign || '???'}` }
                ]};
            }
            const cls = classifyTrack(f);
            const currentlyFdb = shouldShowFdb(f.gufi, cls);
            // Controlled flights (own/ho) cannot be toggled to LDB
            if (currentlyFdb && (cls === 'own' || cls === 'ho')) {
                return { feedback: [
                    { type: 'err', text: 'USER ACTION NOT ALLOWED ON A\nCONTROLLED FLIGHT' },
                    { type: 'info', text: `FORCED DATA BLK ${f.callsign}` }
                ]};
            }
            // Point-out tracks cannot be toggled to LDB — use QP <FLID> instead (CRC spec:
            // "even if the point out has been accepted and cleared")
            if (currentlyFdb && (getPointoutIndicator(f) || pointoutBlocked.has(f.gufi))) {
                return { feedback: [
                    { type: 'err', text: 'POINT OUT ACTIVE \u2014 USE QP' },
                    { type: 'info', text: `${f.callsign}/${getCid(f) || '???'}` }
                ]};
            }
            fdbOverrides.set(f.gufi, !currentlyFdb);
            // FDB → LDB: clear dwell emphasis
            if (currentlyFdb) {
                dwellLocked.delete(f.gufi);
                const mel = markers.get(f.gufi)?.getElement();
                if (mel) removeDwell(mel, f.gufi);
            }
            // Invalidate marker hash so it rebuilds immediately
            const m2 = markers.get(f.gufi);
            if (m2) { const el = m2.getElement(); if (el) el._lastHash = ''; }
            lastRenderTime = 0;
            return { feedback: [
                { type: 'ok', text: 'ACCEPT' },
                { type: 'info', text: currentlyFdb ? 'SUPPRESS DATA BLK' : 'FORCE DATA BLK' },
                { type: 'info', text: `${f.callsign}/${getCid(f) || '???'}` }
            ]};
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // XX — Facility/sector selection
    // XX FAC ZDC — select facility
    // XX SEC 01 02 — select sectors
    // XX FAC ZDC SEC 03 05 — select facility + sectors
    // XX SEC +02 — add sector
    // XX SEC -03 — remove sector
    // XX SEC NONE — deselect all sectors
    // XX SEC ALL — select all sectors
    // ═══════════════════════════════════════════════════════════════════════
    if (verb === 'XX') {
        const args = parts.slice(1).map(s => s.toUpperCase());
        if (args.length === 0) return { feedback: [{ type: 'err', text: 'XX FAC <id> | XX SEC <sectors>' }] };

        let newFacility = null;
        let secArgs = null;
        const secIdx = args.indexOf('SEC');
        const facIdx = args.indexOf('FAC');

        if (facIdx >= 0) {
            if (facIdx + 1 >= args.length || args[facIdx + 1] === 'SEC')
                return { feedback: [{ type: 'err', text: 'XX FAC REQUIRES FACILITY ID' }] };
            newFacility = args[facIdx + 1];
        }
        if (secIdx >= 0) {
            secArgs = args.slice(secIdx + 1).filter(s => s !== 'FAC' && s !== newFacility);
        }
        if (facIdx < 0 && secIdx < 0) {
            return { feedback: [{ type: 'err', text: 'XX FAC <id> | XX SEC <sectors>' }] };
        }

        // Apply facility change
        if (newFacility !== null) {
            // Check if facility exists in known facilities or the dropdown
            const facSelect = document.getElementById('sel-facility');
            const facOptions = [...facSelect.options].map(o => o.value.toUpperCase());
            if (!facOptions.includes(newFacility) && !knownFacilities.has(newFacility)) {
                return { feedback: [{ type: 'err', text: `FACILITY ${newFacility} NOT FOUND` }] };
            }
            facSelect.value = newFacility;
            myFacility = newFacility;
            mySectors.clear();
            fdbOverrides.clear();
            quickLookSectors.clear();
            quickLookDests.clear();
            wasOwnOrHo.clear();
            manuallyHidden.clear();
            pointoutBlocked.clear();
            closePointoutMenu();
            rebuildSectorCheckboxes();
            showBoundariesForFacility(myFacility);
            zoomToFacility(myFacility);
        }

        // Apply sector selection
        const feedback = [];
        if (secArgs !== null && secArgs.length > 0) {
            if (!myFacility) {
                return { feedback: [{ type: 'err', text: 'SELECT FACILITY FIRST' }] };
            }
            const knownSecs = knownFacilities.has(myFacility) ? knownFacilities.get(myFacility) : new Set();

            if (secArgs[0] === 'NONE') {
                mySectors.clear();
                feedback.push({ type: 'info', text: 'SECTORS: NONE' });
            } else if (secArgs[0] === 'ALL') {
                mySectors.clear();
                for (const s of knownSecs) mySectors.add(s);
                feedback.push({ type: 'info', text: `SECTORS: ALL (${mySectors.size})` });
            } else {
                // If any arg uses +/- prefix, keep existing sectors and modify; otherwise replace all
                const isIncremental = secArgs.some(s => s.startsWith('+') || s.startsWith('-'));
                if (!isIncremental) mySectors.clear();
                for (const s of secArgs) {
                    if (s.startsWith('+')) {
                        mySectors.add(s.slice(1));
                    } else if (s.startsWith('-')) {
                        const sec = s.slice(1);
                        mySectors.delete(sec);
                        demoteSectorFlights(sec);
                    } else {
                        mySectors.add(s);
                    }
                }
                feedback.push({ type: 'info', text: `SECTORS: ${[...mySectors].sort().join(' ') || 'NONE'}` });
            }
            rebuildSectorCheckboxes();
        } else if (secArgs !== null) {
            // XX SEC with no args
            feedback.push({ type: 'info', text: `SECTORS: ${[...mySectors].sort().join(' ') || 'NONE'}` });
        }

        invalidateAllMarkers();
        saveSettingsToLocalStorage();

        feedback.unshift({ type: 'ok', text: 'ACCEPT' });
        if (myFacility) feedback.splice(1, 0, { type: 'info', text: `FAC: ${myFacility}` });
        return { feedback };
    }

    return { feedback: [{ type: 'err', text: 'INVALID ENTRY' }] };
}

function showFlightInRA(f) {
    const ra = document.getElementById('ra-content');
    const now = new Date();
    const zulu = String(now.getUTCHours()).padStart(2, '0') + String(now.getUTCMinutes()).padStart(2, '0');
    // getCid() already returns a normalized 3-char CID — pad to 3 (not 4, which re-added a leading 0).
    const cidVal = getCid(f);
    const cid = cidVal ? String(cidVal).padStart(3, '0') : '???';
    // Sector display: prefix with ARTCC handoff code if different facility
    const ctrlFac = f.controllingFacility || '';
    const ctrlSec = f.controllingSector || '??';
    const sector = (ctrlFac && myFacility && ctrlFac !== myFacility)
        ? getHandoffCode(ctrlFac) + ctrlSec
        : ctrlSec;
    const cs = f.callsign || '???';
    const type = f.aircraftType || '????';
    const equip = f.equipmentQualifier ? '/' + f.equipmentQualifier : '';
    const bcn = f.squawk || '????';
    const spd = f.groundSpeed != null ? String(Math.round(f.groundSpeed)).padStart(4, ' ') : '    ';
    const aalt = f.blockFloor != null && f.blockCeiling != null
        ? `${String(Math.round(f.blockFloor / 100)).padStart(3, '0')}B${String(Math.round(f.blockCeiling / 100)).padStart(3, '0')}`
        : f.assignedVfr
            ? (f.assignedAltitude != null ? `VFR/${String(Math.round(f.assignedAltitude / 100)).padStart(3, '0')}` : 'VFR')
            : f.assignedAltitude != null ? String(Math.round(f.assignedAltitude / 100)).padStart(3, '0') : '???';
    const origin = f.origin || '????';
    const dest = f.destination || '????';
    const route = f.route || '';
    const star = f.star || '';
    const remarks = f.remarks || '';

    // Build route line: route + STAR, append destination if not already present
    let routeStr = route;
    if (star) routeStr += (routeStr ? '.' : '') + star;
    const destUp = dest.toUpperCase();
    // Check if route already contains destination near the end
    // Handles: ...KCHO, ...KCHO/2025, ..KCHO (with time/ETA suffixes)
    const routeUp = routeStr.toUpperCase();
    const lastToken = routeUp.split(/[.\s]/).filter(Boolean).pop() || '';
    const containsDest = lastToken === destUp || lastToken.startsWith(destUp + '/');
    if (routeStr && !containsDest) {
        routeStr += '.' + dest;
    } else if (!routeStr) {
        routeStr = dest;
    }

    let text = `${zulu}\n`;
    text += `${cid} ${cs}(${sector}) ${type}${equip}\n`;
    text += `${bcn} ${spd} ${aalt} ${origin}..\n`;
    text += `${routeStr}\n`;
    if (remarks) text += `${remarks}`;
    ra.textContent = text;
}

// ════════════════════════════════════════════════════════════════════════════
// Global keyboard capture → MCA
// ════════════════════════════════════════════════════════════════════════════
// ── Mobile keyboard bridge ──
const mcaMobileInput = document.getElementById('mca-mobile-input');
document.getElementById('mca-kb-btn').addEventListener('click', e => {
    e.stopPropagation();
    mcaMobileInput.value = '';
    mcaMobileInput.focus();
});
mcaMobileInput.addEventListener('input', () => {
    const val = mcaMobileInput.value.toUpperCase();
    mcaMobileInput.value = '';
    for (const ch of val) mcaInsertChar(ch);
});

document.addEventListener('keydown', e => {
    // Don't capture when focused on sidebar form elements (but allow our mobile input)
    const ae = document.activeElement;
    const tag = ae?.tagName;
    if ((tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') && ae !== mcaMobileInput) return;

    // Escape → clear MCA
    if (e.key === 'Escape') { clearFindMarker(); mcaClear(); closeFieldMenu(); e.preventDefault(); return; }

    // Ctrl+R → recall last command
    if (e.ctrlKey && (e.key === 'r' || e.key === 'R')) { mcaRecall(); e.preventDefault(); return; }

    // Ctrl+Delete → clear RA
    if (e.ctrlKey && e.key === 'Delete') {
        document.getElementById('ra-content').textContent = '';
        e.preventDefault(); return;
    }

    // Ctrl+Shift+O → cycle CRR RDB offset
    if (e.ctrlKey && e.shiftKey && (e.key === 'o' || e.key === 'O')) {
        if (crrRdbEnabled) {
            crrRdbOffset = (crrRdbOffset + 1) % 4;
            invalidateAllMarkers();
        }
        e.preventDefault(); return;
    }

    // PageUp / PageDown → cycle vector line minutes (0,1,2,4,8)
    const vectorSteps = [0, 1, 2, 4, 8];
    if (e.key === 'PageUp' && !e.ctrlKey) {
        const idx = vectorSteps.indexOf(vectorMinutes);
        const next = idx < vectorSteps.length - 1 ? vectorSteps[idx + 1] : vectorSteps[vectorSteps.length - 1];
        vectorMinutes = next;
        document.getElementById('sel-vector').value = vectorMinutes;
        saveSettingsToLocalStorage();
        e.preventDefault(); return;
    }
    if (e.key === 'PageDown' && !e.ctrlKey) {
        const idx = vectorSteps.indexOf(vectorMinutes);
        const next = idx > 0 ? vectorSteps[idx - 1] : vectorSteps[0];
        vectorMinutes = next;
        document.getElementById('sel-vector').value = vectorMinutes;
        saveSettingsToLocalStorage();
        e.preventDefault(); return;
    }

    // Enter → execute command
    if (e.key === 'Enter' && !e.ctrlKey) { mcaExecute(); e.preventDefault(); return; }

    // Ctrl+Enter → newline in preview
    if (e.key === 'Enter' && e.ctrlKey) { mcaInsertChar('\n'); e.preventDefault(); return; }

    // Arrow keys
    if (e.key === 'ArrowLeft') {
        if (mca.cursor > 0) mca.cursor--;
        mcaRender(); e.preventDefault(); return;
    }
    if (e.key === 'ArrowRight') {
        if (mca.cursor < mca.text.length) mca.cursor++;
        mcaRender(); e.preventDefault(); return;
    }

    // Home / End / Ctrl+PgUp / Ctrl+PgDn
    if (e.key === 'Home' || (e.ctrlKey && e.key === 'PageUp')) {
        mca.cursor = 0; mcaRender(); e.preventDefault(); return;
    }
    if (e.key === 'End' || (e.ctrlKey && e.key === 'PageDown')) {
        mca.cursor = mca.text.length; mcaRender(); e.preventDefault(); return;
    }

    // Backspace / Delete
    if (e.key === 'Backspace') { mcaBackspace(); e.preventDefault(); return; }
    if (e.key === 'Delete') { mcaDelete(); e.preventDefault(); return; }

    // Insert → toggle overstrike/insert mode
    if (e.key === 'Insert') { mca.overstrike = !mca.overstrike; mcaRender(); e.preventDefault(); return; }

    // F-key shortcuts: initiate commands in MCA (CRC spec)
    const fKeyMap = {
        'F1':  'QF ', 'F2':  'QP ', 'F4': 'QX ', 'F5': 'QZ ',
        'F6':  'QU ', 'F7':  'QL ', 'F8': 'QQ ', 'F9': 'QB '
    };
    const fKeyShiftMap = {
        'F2': 'QD ', 'F7': 'WR ', 'F8': 'QR '
    };
    if (e.shiftKey && fKeyShiftMap[e.key]) {
        mcaClear();
        for (const ch of fKeyShiftMap[e.key]) mcaInsertChar(ch);
        e.preventDefault(); return;
    }
    if (!e.shiftKey && !e.ctrlKey && fKeyMap[e.key]) {
        mcaClear();
        for (const ch of fKeyMap[e.key]) mcaInsertChar(ch);
        e.preventDefault(); return;
    }

    // Printable characters → type into MCA (uppercase)
    if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
        mcaInsertChar(e.key.toUpperCase());
        e.preventDefault();
        return;
    }
});

// ════════════════════════════════════════════════════════════════════════════
// MCA & RA box drag/drop (click to pick up, click to drop)
// ════════════════════════════════════════════════════════════════════════════
let _boxDragging = null;
let _boxDragOffset = { x: 0, y: 0 };

function clampBox(el) {
    const container = el.parentElement;
    if (!container) return;
    const cRect = container.getBoundingClientRect();
    const eRect = el.getBoundingClientRect();
    let left = eRect.left - cRect.left;
    let top = eRect.top - cRect.top;
    left = Math.max(0, Math.min(left, cRect.width - eRect.width));
    top = Math.max(0, Math.min(top, cRect.height - eRect.height));
    el.style.left = left + 'px';
    el.style.top = top + 'px';
    el.style.bottom = 'auto';
    el.style.right = 'auto';
}

function saveBoxPosition(el) {
    const key = 'boxPos_' + el.id;
    localStorage.setItem(key, JSON.stringify({ left: el.style.left, top: el.style.top }));
}

function restoreBoxPosition(el) {
    const key = 'boxPos_' + el.id;
    const saved = localStorage.getItem(key);
    if (saved) {
        try {
            const pos = JSON.parse(saved);
            if (pos.left) el.style.left = pos.left;
            if (pos.top) { el.style.top = pos.top; el.style.bottom = 'auto'; el.style.right = 'auto'; }
        } catch(e) {}
    }
    // Clamp to viewport on restore (handles window resize since last save)
    requestAnimationFrame(() => clampBox(el));
}

function dropBox() {
    if (!_boxDragging) return;
    clampBox(_boxDragging);
    saveBoxPosition(_boxDragging);
    _boxDragging.classList.remove('box-dragging');
    _boxDragging = null;
}

function setupBoxDrag(el, handleEl) {
    restoreBoxPosition(el);
    (handleEl || el).addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        e.stopPropagation();

        if (_boxDragging === el) {
            // Already dragging this box → drop it
            dropBox();
            return;
        }
        // Drop any currently dragged box
        if (_boxDragging) dropBox();
        // Pick up this box
        _boxDragging = el;
        el.classList.add('box-dragging');
        const rect = el.getBoundingClientRect();
        _boxDragOffset = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    });
}

document.addEventListener('mousemove', e => {
    if (!_boxDragging) return;
    const container = _boxDragging.parentElement;
    const cRect = container.getBoundingClientRect();
    const eRect = _boxDragging.getBoundingClientRect();
    let left = e.clientX - cRect.left - _boxDragOffset.x;
    let top = e.clientY - cRect.top - _boxDragOffset.y;
    left = Math.max(0, Math.min(left, cRect.width - eRect.width));
    top = Math.max(0, Math.min(top, cRect.height - eRect.height));
    _boxDragging.style.left = left + 'px';
    _boxDragging.style.top = top + 'px';
    _boxDragging.style.bottom = 'auto';
    _boxDragging.style.right = 'auto';
});

// Click outside the dragged box → drop it
document.addEventListener('mousedown', e => {
    if (_boxDragging && e.button === 0 && !_boxDragging.contains(e.target)) {
        dropBox();
    }
});

// Re-clamp on window resize
window.addEventListener('resize', () => {
    const poMenu = document.getElementById('po-menu');
    if (poMenu.style.display !== 'none') clampBox(poMenu);
    const altimMenu = document.getElementById('altim-menu');
    if (altimMenu.style.display !== 'none') clampBox(altimMenu);
    clampBox(document.getElementById('time-view'));
    const fm = document.getElementById('field-menu');
    if (fm.style.display !== 'none') clampBox(fm);
    // Skip mca-ra-stack to prevent shifting its bottom/right positioned element
});

setupBoxDrag(document.getElementById('mca-ra-stack'));
setupBoxDrag(document.getElementById('po-menu'), document.getElementById('po-menu-title'));
setupBoxDrag(document.getElementById('altim-menu'), document.getElementById('altim-menu-title'));
setupBoxDrag(document.getElementById('wx-menu'), document.getElementById('wx-menu-title'));
setupBoxDrag(document.getElementById('crr-menu'), document.getElementById('crr-menu-title'));

// Point-out menu: close button (left + middle click)
document.getElementById('po-menu-close').addEventListener('click', (e) => {
    e.stopPropagation();
    closePointoutMenu();
});
document.getElementById('po-menu-close').addEventListener('auxclick', (e) => {
    if (e.button === 1) { e.preventDefault(); e.stopPropagation(); closePointoutMenu(); }
});
// Point-out menu: middle-click title bar → close menu
document.getElementById('po-menu-title').addEventListener('auxclick', (e) => {
    if (e.button === 1) { e.preventDefault(); e.stopPropagation(); closePointoutMenu(); }
});

// Altimeter menu: close button (left + middle click)
document.getElementById('altim-menu-close').addEventListener('mousedown', (e) => {
    e.stopPropagation();  // Prevent drag initiation
});
document.getElementById('altim-menu-close').addEventListener('click', (e) => {
    e.stopPropagation();
    closeAltimeterMenu();
});
document.getElementById('altim-menu-close').addEventListener('auxclick', (e) => {
    if (e.button === 1) { e.preventDefault(); e.stopPropagation(); closeAltimeterMenu(); }
});
// Altimeter menu: middle-click title bar → close menu
document.getElementById('altim-menu-title').addEventListener('auxclick', (e) => {
    if (e.button === 1) { e.preventDefault(); e.stopPropagation(); closeAltimeterMenu(); }
});

// Weather menu: close button (left + middle click)
document.getElementById('wx-menu-close').addEventListener('mousedown', (e) => {
    e.stopPropagation();  // Prevent drag initiation
});
document.getElementById('wx-menu-close').addEventListener('click', (e) => {
    e.stopPropagation();
    closeWeatherMenu();
});
document.getElementById('wx-menu-close').addEventListener('auxclick', (e) => {
    if (e.button === 1) { e.preventDefault(); e.stopPropagation(); closeWeatherMenu(); }
});
// Weather menu: middle-click title bar → open rows popup
document.getElementById('wx-menu-title').addEventListener('auxclick', (e) => {
    if (e.button === 1) {
        e.preventDefault();
        e.stopPropagation();
        openWxRowsPopup(e);
    }
});

// Weather menu: rows popup
let wxRowsPopupOpen = false;
let wxVisibleRows = 8;  // Default 8 rows

function openWxRowsPopup(event) {
    if (wxRowsPopupOpen) {
        closeWxRowsPopup();
        return;
    }

    const popup = document.getElementById('wx-rows-popup');
    document.getElementById('wx-rows-display').textContent = wxVisibleRows;

    // Position popup below the title
    const menu = document.getElementById('wx-menu');
    const title = document.getElementById('wx-menu-title');
    popup.style.left = menu.offsetLeft + 'px';
    popup.style.top = (menu.offsetTop + title.offsetHeight) + 'px';
    popup.style.display = 'block';
    wxRowsPopupOpen = true;
}

function setWxVisibleRows(rows) {
    wxVisibleRows = Math.max(2, Math.min(15, rows));
    const body = document.getElementById('wx-menu-body');
    body.style.maxHeight = (wxVisibleRows * 18) + 'px';
    document.getElementById('wx-rows-display').textContent = wxVisibleRows;
}

function closeWxRowsPopup() {
    document.getElementById('wx-rows-popup').style.display = 'none';
    wxRowsPopupOpen = false;
}

// Rows popup buttons
document.getElementById('wx-rows-minus').addEventListener('click', (e) => {
    e.stopPropagation();
    setWxVisibleRows(wxVisibleRows - 1);
});

document.getElementById('wx-rows-plus').addEventListener('click', (e) => {
    e.stopPropagation();
    setWxVisibleRows(wxVisibleRows + 1);
});

// Close popup on outside click
document.addEventListener('click', (e) => {
    if (wxRowsPopupOpen && !e.target.closest('#wx-rows-popup') && !e.target.closest('#wx-menu-title')) {
        closeWxRowsPopup();
    }
});

// Weather menu: custom scroll controls
document.getElementById('wx-scroll-up').addEventListener('click', (e) => {
    e.stopPropagation();
    const body = document.getElementById('wx-menu-body');
    body.scrollTop = Math.max(0, body.scrollTop - 16);
});

document.getElementById('wx-scroll-down').addEventListener('click', (e) => {
    e.stopPropagation();
    const body = document.getElementById('wx-menu-body');
    body.scrollTop = Math.min(body.scrollHeight - body.clientHeight, body.scrollTop + 16);
});

// CRR menu: close button
document.getElementById('crr-menu-close').addEventListener('mousedown', (e) => {
    e.stopPropagation();
});
document.getElementById('crr-menu-close').addEventListener('click', (e) => {
    e.stopPropagation();
    closeCrrMenu();
});
document.getElementById('crr-menu-close').addEventListener('auxclick', (e) => {
    if (e.button === 1) { e.preventDefault(); e.stopPropagation(); closeCrrMenu(); }
});
// CRR menu: middle-click title bar → toggle color selector
document.getElementById('crr-menu-title').addEventListener('auxclick', (e) => {
    if (e.button === 1) { e.preventDefault(); e.stopPropagation(); toggleCrrColorSelector(); }
});

// Close CRR popups on outside click
document.addEventListener('click', (e) => {
    if (crrGroupDeletePopupOpen && !e.target.closest('#crr-group-delete-popup')) {
        closeCrrGroupDeletePopup();
    }
    if (crrAircraftDeletePopupOpen && !e.target.closest('#crr-aircraft-delete-popup')) {
        closeCrrAircraftDeletePopup();
    }
});

// CRR menu body event delegation
document.addEventListener('click', (e) => {
    const labelEl = e.target.closest('[data-group]');
    if (labelEl && labelEl.closest('#crr-menu-body')) {
        const label = labelEl.dataset.group;
        e.stopPropagation();
        const mcaInput = document.getElementById('mca-mobile-input');
        if (mcaInput) {
            mcaInput.value = `LF ${label} `;
            mcaInput.focus();
            mcaInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }
});

document.addEventListener('auxclick', (e) => {
    const labelEl = e.target.closest('[data-group]');
    if (labelEl && labelEl.closest('#crr-menu-body') && e.button === 1) {
        // Check if it's an aircraft row or group label
        if (labelEl.classList.contains('crr-aircraft')) {
            // Aircraft middle-click
            e.preventDefault();
            e.stopPropagation();
            const label = labelEl.dataset.group;
            const gufi = labelEl.dataset.gufi;
            const callsign = labelEl.dataset.callsign;
            openCrrAircraftDeletePopup(label, gufi, callsign, e);
        } else if (labelEl.classList.contains('crr-group-label')) {
            // Group label middle-click
            const label = labelEl.dataset.group;
            e.preventDefault();
            e.stopPropagation();
            openCrrGroupDeletePopup(label, e);
        }
    }
});

// Aircraft left/middle-click handler
document.addEventListener('click', (e) => {
    const aircraftEl = e.target.closest('.crr-aircraft');
    if (aircraftEl && aircraftEl.closest('#crr-menu-body')) {
        const label = aircraftEl.dataset.group;
        const gufi = aircraftEl.dataset.gufi;
        const callsign = aircraftEl.dataset.callsign;
        e.stopPropagation();
        openCrrAircraftDeletePopup(label, gufi, callsign, e);
    }
});

// CRR group delete button (X) click handler
document.addEventListener('click', (e) => {
    const deleteBtn = e.target.closest('.crr-group-label-delete');
    if (deleteBtn && deleteBtn.closest('#crr-menu-body')) {
        const label = deleteBtn.dataset.delete;
        e.stopPropagation();
        deleteCrrGroup(label, e);
    }
});

// Point-out menu: sector row click handler (shared for left + middle click)
function handlePoSectorClick(e) {
    const row = e.target.closest('.po-sector-row');
    if (!row) return;
    e.stopPropagation();
    const gufi = row.dataset.gufi;
    const role = row.dataset.role;
    const f = flights.get(gufi);
    if (!f) return;
    const isAcked = pointoutAcked.has(gufi);

    if (role === 'receiver' && !isAcked) {
        // CRC spec: click sector → cyan/boxed changes to white/unboxed → then P removed
        // Brief visual transition before clearing (all sectors acked = P removed from FDB)
        pointoutAcked.add(gufi);
        invalidateMarker(gufi);
        const poInfo2 = getPointoutIndicator(f);
        if (poInfo2) updatePointoutMenuBody(f, poInfo2);
        mca.feedback = [
            { type: 'ok', text: 'ACCEPT \u2014 ACKNOWLEDGE PO' },
            { type: 'info', text: f.callsign || '???' }
        ];
        mcaRender();
        setTimeout(() => {
            f.pointoutOriginatingUnit = null;
            f.pointoutReceivingUnit = null;
            pointoutAcked.delete(gufi);
            invalidateMarker(gufi);
            closePointoutMenu();
        }, 300);
    } else if (role === 'receiver' && isAcked) {
        // Already acked → remove from display, clear PO
        f.pointoutOriginatingUnit = null;
        f.pointoutReceivingUnit = null;
        pointoutAcked.delete(gufi);
        invalidateMarker(gufi);
        closePointoutMenu();
    } else if (role === 'originator' && !isAcked) {
        // Originator clicks pending sector → simulate remote ack (P→A on line 0)
        pointoutAcked.add(gufi);
        invalidateMarker(gufi);
        // Update menu in place (stays open, now shows white/unboxed)
        const poInfo = getPointoutIndicator(f);
        if (poInfo) updatePointoutMenuBody(f, poInfo);
    } else if (role === 'originator' && isAcked) {
        // Originator clicks acked sector → clear PO, close menu
        pointoutAcked.delete(gufi);
        f.pointoutOriginatingUnit = null;
        f.pointoutReceivingUnit = null;
        invalidateMarker(gufi);
        closePointoutMenu();
    }
}
document.getElementById('po-menu-body').addEventListener('click', handlePoSectorClick);
document.getElementById('po-menu-body').addEventListener('auxclick', (e) => {
    if (e.button === 1) { e.preventDefault(); handlePoSectorClick(e); }
});

// ════════════════════════════════════════════════════════════════════════════
// Checklist Menus (POS CHECK, EMERG CHECK)
// ════════════════════════════════════════════════════════════════════════════
const CHECKLISTS = {
    'pos': {
        title: 'POS CHECK',
        items: [
            'SIAS',
            'TRAFFIC MANAGEMENT INITIATIVES',
            'SPECIAL USE AIRSPACE/SPECIAL ACTIVITIES',
            'WEATHER/RIDES/ALTIMETERS',
            'SURROUNDING AIRSPACE CONFIGURATIONS',
            'TRAFFIC AND COMMUNICATION STATUS',
        ]
    },
    'emerg': {
        title: 'EMERG CHECK',
        items: [
            'AIRCRAFT CALLSIGN AND TYPE',
            'NATURE OF EMERGENCY',
            'PILOTS INTENTIONS',
            '',  // separator line
            'FUEL REMAINING IN TIME',
            'NUMBER OF PEOPLE ON BOARD',
            'POINT OF DEPARTURE AND DESTINATION',
            '',  // separator line
            'OTHER PERTINENT INFORMATION',
        ]
    }
};

let checklistState = {};  // type → Set of checked item indices
let currentChecklistOpen = null;  // track which checklist is currently open

function openChecklist(type, clientX, clientY) {
    const checklist = CHECKLISTS[type];
    if (!checklist) return;

    // Initialize checked state if needed
    if (!checklistState[type]) {
        checklistState[type] = new Set();
    }

    const menu = document.getElementById('checklist-menu');
    document.getElementById('checklist-menu-title-text').textContent = checklist.title;
    currentChecklistOpen = type;

    let html = '';
    for (let i = 0; i < checklist.items.length; i++) {
        const item = checklist.items[i];
        if (item === '') {
            // Separator line
            html += `<div class="checklist-separator"></div>`;
        } else {
            const isChecked = checklistState[type].has(i);
            html += `<div class="checklist-item${isChecked ? ' checked' : ''}" data-type="${type}" data-index="${i}">${item}</div>`;
        }
    }
    document.getElementById('checklist-menu-body').innerHTML = html;

    // Try to restore saved position, otherwise use provided coordinates
    const container = document.getElementById('map-container');
    const cRect = container.getBoundingClientRect();
    const savedPos = localStorage.getItem(`checklist-pos-${type}`);

    if (savedPos) {
        const pos = JSON.parse(savedPos);
        menu.style.left = pos.left + 'px';
        menu.style.top = pos.top + 'px';
    } else {
        menu.style.left = (clientX - cRect.left + 10) + 'px';
        menu.style.top = (clientY - cRect.top - 10) + 'px';
    }

    menu.style.right = 'auto';
    menu.style.bottom = 'auto';
    menu.style.display = 'block';
    requestAnimationFrame(() => clampBox(menu));
}

function closeChecklist() {
    const menu = document.getElementById('checklist-menu');

    // Save current position
    if (currentChecklistOpen && menu.style.display !== 'none') {
        const left = parseInt(menu.style.left);
        const top = parseInt(menu.style.top);
        localStorage.setItem(`checklist-pos-${currentChecklistOpen}`, JSON.stringify({ left, top }));
    }

    menu.style.display = 'none';
    currentChecklistOpen = null;

    // Update toolbar button state immediately and persistently
    const updateChecklistButtons = () => {
        const allButtons = document.querySelectorAll('.tb-btn');
        allButtons.forEach(btn => {
            const labels = btn.querySelectorAll('.tb-label');
            labels.forEach(label => {
                const text = label.textContent || '';
                if ((text.includes('POS') && text.includes('CHECK')) ||
                    (text.includes('EMERG') && text.includes('CHECK'))) {
                    btn.classList.remove('tb-toggle-on');
                }
            });
        });
    };

    // Update immediately
    updateChecklistButtons();

    // Also update on next frame to ensure it sticks
    requestAnimationFrame(updateChecklistButtons);
}

document.getElementById('checklist-menu-close').addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    closeChecklist();
});

document.getElementById('checklist-menu-close').addEventListener('mousedown', (e) => {
    e.stopPropagation();
    e.preventDefault();
});

document.getElementById('checklist-menu-body').addEventListener('click', (e) => {
    const item = e.target.closest('.checklist-item');
    if (!item) return;

    const type = item.dataset.type;
    const index = parseInt(item.dataset.index);

    if (!checklistState[type]) checklistState[type] = new Set();

    if (checklistState[type].has(index)) {
        checklistState[type].delete(index);
        item.classList.remove('checked');
    } else {
        checklistState[type].add(index);
        item.classList.add('checked');
    }
});

setupBoxDrag(document.getElementById('checklist-menu'), document.getElementById('checklist-menu-title'));

// Close checklist when clicking outside
document.addEventListener('mousedown', e => {
    const cm = document.getElementById('checklist-menu');
    if (cm.style.display !== 'none' && !cm.contains(e.target)) closeChecklist();
});

// ════════════════════════════════════════════════════════════════════════════
// Zulu Time View
// ════════════════════════════════════════════════════════════════════════════
setupBoxDrag(document.getElementById('time-view'));
setInterval(() => {
    const now = new Date();
    const hh = String(now.getUTCHours()).padStart(2, '0');
    const mm = String(now.getUTCMinutes()).padStart(2, '0');
    const ss = String(now.getUTCSeconds()).padStart(2, '0');
    document.getElementById('time-view').textContent = `${hh}${mm} ${ss}`;
}, 1000);
// Trigger immediately
{
    const now = new Date();
    document.getElementById('time-view').textContent =
        `${String(now.getUTCHours()).padStart(2,'0')}${String(now.getUTCMinutes()).padStart(2,'0')} ${String(now.getUTCSeconds()).padStart(2,'0')}`;
}
// Middle-click toggles border
document.getElementById('time-view').addEventListener('auxclick', e => {
    if (e.button === 1) { e.preventDefault(); e.currentTarget.classList.toggle('bordered'); }
});

// ════════════════════════════════════════════════════════════════════════════
// Field Menus (Altitude, Heading, Speed, Free Text)
// ════════════════════════════════════════════════════════════════════════════
let fieldMenuGufi = null;
let fieldMenuType = null;  // 'alt' | 'hdg' | 'spd' | 'txt'

function closeFieldMenu() {
    fieldMenuGufi = null;
    fieldMenuType = null;
    document.getElementById('field-menu').style.display = 'none';
}

function openFieldMenu(gufi, type, clientX, clientY, bodyHtml) {
    closeFieldMenu();
    closePointoutMenu();
    const f = flights.get(gufi);
    if (!f) return;
    fieldMenuGufi = gufi;
    fieldMenuType = type;
    const menu = document.getElementById('field-menu');
    document.getElementById('fm-cs').textContent = f.callsign || '???';
    document.getElementById('fm-body').innerHTML = bodyHtml;
    // Position near click
    const container = document.getElementById('map-container');
    const cRect = container.getBoundingClientRect();
    menu.style.left = (clientX - cRect.left + 10) + 'px';
    menu.style.top = (clientY - cRect.top - 10) + 'px';
    menu.style.right = 'auto';
    menu.style.bottom = 'auto';
    menu.style.display = 'block';
    requestAnimationFrame(() => clampBox(menu));
}

setupBoxDrag(document.getElementById('field-menu'), document.getElementById('fm-title'));
document.getElementById('fm-close').addEventListener('click', e => { e.stopPropagation(); closeFieldMenu(); });
document.getElementById('fm-close').addEventListener('auxclick', e => {
    if (e.button === 1) { e.preventDefault(); e.stopPropagation(); closeFieldMenu(); }
});
document.getElementById('fm-title').addEventListener('auxclick', e => {
    if (e.button === 1) { e.preventDefault(); e.stopPropagation(); closeFieldMenu(); }
});
// Close field menu when clicking anywhere outside it
document.addEventListener('mousedown', e => {
    const fm = document.getElementById('field-menu');
    if (fm.style.display !== 'none' && !fm.contains(e.target)) closeFieldMenu();
});

// ── Helpers: directly set local state (bypass ownership checks) ──
function menuSetAlt(gufi, fl) {
    const f = flights.get(gufi);
    if (!f) return;
    const feet = parseInt(fl) * 100;
    localAssignedAlt.set(gufi, { feet, rules: null, block: null, serverVal: f.assignedAltitude ?? null });
    invalidateMarker(gufi);
}
function menuSetInterim(gufi, fl, type) {
    const f = flights.get(gufi);
    if (!f) return;
    const feet = parseInt(fl) * 100;
    localInterimAlt.set(gufi, { feet, type: type || 'I', serverVal: f.interimAltitude ?? null });
    invalidateMarker(gufi);
}
function menuClearInterim(gufi) {
    localInterimAlt.delete(gufi);
    invalidateMarker(gufi);
}
function menuSetHsf(gufi, field, value) {
    const entry = hsfData.get(gufi) || {};
    entry[field] = value;
    hsfData.set(gufi, entry);
    invalidateMarker(gufi);
}
function menuClearHsf(gufi, field) {
    const entry = hsfData.get(gufi);
    if (entry) { delete entry[field]; if (!entry.heading && !entry.speed && !entry.freeText) hsfData.delete(gufi); }
    hsfShowMap.delete(gufi);
    invalidateMarker(gufi);
}
function menuClearAllHsf(gufi) {
    hsfData.delete(gufi);
    hsfShowMap.delete(gufi);
    invalidateMarker(gufi);
}

// ── Altitude Menu ──
let altMenuPage = 0;
let altMenuLocalTalt = false;
let altMenuProcedure = false;

function openAltMenu(gufi, clientX, clientY) {
    const f = flights.get(gufi);
    if (!f) return;
    altMenuPage = 0;
    altMenuLocalTalt = false;
    altMenuProcedure = false;
    const localA = localAssignedAlt.get(gufi);
    const assigned = localA ? localA.feet : (f.assignedAltitude ?? null);
    if (assigned != null) {
        const fl = Math.round(assigned / 100);
        altMenuPage = Math.max(0, Math.floor((fl - 10) / 70));
    }
    openFieldMenu(gufi, 'alt', clientX, clientY, buildAltMenuBody(gufi));
}

function buildAltMenuBody(gufi) {
    const f = flights.get(gufi);
    if (!f) return '';
    const localA = localAssignedAlt.get(gufi);
    const localI = localInterimAlt.get(gufi);
    const assigned = localA ? localA.feet : (f.assignedAltitude ?? null);
    const interim = localI ? localI.feet : (f.interimAltitude ?? null);
    const interimType = localI ? localI.type : 'I';
    const assignedFL = assigned != null ? Math.round(assigned / 100) : null;
    const interimFL = interim != null ? Math.round(interim / 100) : null;

    let html = '';
    // FP assigned row — shown when interim is active; click clears interim
    if (interim != null && assigned != null) {
        html += `<div class="field-menu-row fm-toggle" data-action="clear-interim">\u00a0\u00a0FP\u00a0\u00a0${String(assignedFL).padStart(3,'0')}</div>`;
    }
    // Current interim row (if interim set, show its value + type letter)
    if (interim != null) {
        const ifl = String(interimFL).padStart(3, '0');
        const letter = interimType === 'L' ? 'L' : interimType === 'P' ? 'P' : 'T';
        html += `<div class="field-menu-row fm-toggle">\u00a0\u00a0${ifl}\u00a0\u00a0${letter}</div>`;
    }
    // LOCAL TALT / PROCEDURE toggles
    html += `<div class="field-menu-row fm-toggle${altMenuLocalTalt ? ' toggle-active' : ''}" data-action="toggle-local">LOCAL\u00a0\u00a0TALT</div>`;
    html += `<div class="field-menu-row fm-toggle${altMenuProcedure ? ' toggle-active' : ''}" data-action="toggle-proc">PROCEDURE</div>`;
    html += `<div class="field-menu-divider"></div>`;

    // 7 altitude values per page with right-side scrollbar
    // Always show a full page; if near the end, shift back so last item is 600
    let startFL = (altMenuPage * 7 + 1) * 10;
    const minStartFL = 10;
    const maxStartFL = 600 - 60;  // Last item shown will be 600
    startFL = Math.max(minStartFL, Math.min(maxStartFL, startFL));
    // Calculate which page we're actually on (for scrollbar position)
    const actualPage = Math.max(0, (startFL - minStartFL) / 70);
    const maxPage = (maxStartFL - minStartFL) / 70;
    const thumbPct = 1 / (maxPage + 1) * 100;
    const thumbTop = (maxPage - actualPage) / (maxPage + 1) * 100;
    html += '<div class="field-menu-values">';
    html += '<div class="field-menu-values-col">';
    for (let i = 6; i >= 0; i--) {
        const fl = startFL + i * 10;
        if (fl > 600) continue;
        const flStr = String(fl).padStart(3, '0');
        const isCurrent = (assignedFL === fl);
        const isInterim = (interimFL === fl);
        // Letter reflects toggle mode: L if LOCAL TALT active, P if PROCEDURE active, else T
        const tLetter = altMenuLocalTalt ? 'L' : altMenuProcedure ? 'P' : 'T';
        const cls = isCurrent ? ' current' : '';
        const isInterimHl = isInterim && (
            (interimType === 'L' && altMenuLocalTalt) ||
            (interimType === 'P' && altMenuProcedure) ||
            (interimType === 'I' && !altMenuLocalTalt && !altMenuProcedure)
        );
        html += `<div class="field-menu-row${cls}" data-action="set-alt" data-fl="${fl}">\u00a0\u00a0${flStr}\u00a0\u00a0<span data-action="set-interim" data-fl="${fl}"${isInterimHl ? ' style="background:#cd5c5c"' : ''}>${tLetter}</span></div>`;
    }
    html += '</div>';
    html += `<div class="field-menu-scrollbar"><div class="sb-arrow" data-action="scroll-up">\u25B2</div><div class="sb-track"><div class="sb-thumb" style="top:${thumbTop}%;height:${thumbPct}%"></div></div><div class="sb-arrow" data-action="scroll-down">\u25BC</div></div>`;
    html += '</div>';
    return html;
}

function refreshAltMenu() {
    if (fieldMenuType !== 'alt' || !fieldMenuGufi) return;
    document.getElementById('fm-body').innerHTML = buildAltMenuBody(fieldMenuGufi);
}

// ── Heading Menu ──
let hdgMenuPage = 0;
let hdgMenuLT = false;
let hdgMenuRT = false;

function openHdgMenu(gufi, clientX, clientY) {
    const f = flights.get(gufi);
    if (!f) return;
    hdgMenuPage = 0;
    hdgMenuLT = false;
    hdgMenuRT = false;
    const hsf = getEffectiveHsf(f);
    if (hsf && hsf.heading) {
        const h = parseInt(String(hsf.heading).replace(/^H/, ''));
        if (!isNaN(h)) hdgMenuPage = Math.max(0, Math.floor((h - 5) / 70));
    }
    openFieldMenu(gufi, 'hdg', clientX, clientY, buildHdgMenuBody(gufi));
}

function buildHdgMenuBody(gufi) {
    const f = flights.get(gufi);
    if (!f) return '';
    const hsf = getEffectiveHsf(f);
    const rawHdg = String(hsf?.heading || '').replace(/^H/, '');
    const curHdg = /^\d+$/.test(rawHdg) ? parseInt(rawHdg) : null;

    let html = '<div class="field-menu-hdr">';
    html += `<span data-action="hdg-lt"${hdgMenuLT ? ' class="active"' : ''}>LT</span>`;
    html += `<span data-action="hdg-ph">PH</span>`;
    html += `<span data-action="hdg-rt"${hdgMenuRT ? ' class="active"' : ''}>RT</span>`;
    html += '</div><div class="field-menu-divider"></div>';

    // 14 heading values per page (2 columns × 7 rows) with right-side scrollbar
    // Always show a full page; if near the end, shift back so last item is 360
    let startH = hdgMenuPage * 70 + 5;
    const minStartH = 5;
    const maxStartH = 360 - 70;  // Last item shown will be 360
    startH = Math.max(minStartH, Math.min(maxStartH, startH));
    // Calculate which page we're actually on (for scrollbar position)
    const hdgActualPage = Math.max(0, (startH - minStartH) / 70);
    const hdgMaxPageCalc = (maxStartH - minStartH) / 70;
    const hdgThumbPct = 1 / (hdgMaxPageCalc + 1) * 100;
    const hdgThumbTop = (hdgMaxPageCalc - hdgActualPage) / (hdgMaxPageCalc + 1) * 100;
    html += '<div class="field-menu-values">';
    html += '<div class="field-menu-values-col">';
    for (let row = 6; row >= 0; row--) {
        const h1 = startH + row * 10;
        const h2 = startH + row * 10 + 5;
        let rowHtml = '<div style="display:flex;gap:8px;padding:1px 4px;">';
        for (const h of [h1, h2]) {
            if (h > 360) { rowHtml += '<span style="width:4ch">\u00a0</span>'; continue; }
            const suffix = hdgMenuLT ? 'L' : hdgMenuRT ? 'R' : '';
            const display = String(h).padStart(3, '0') + suffix;
            const cls = (curHdg === h) ? ' current' : '';
            rowHtml += `<span class="field-menu-row${cls}" data-action="set-hdg" data-hdg="${h}" style="cursor:pointer;padding:0 2px">${display}</span>`;
        }
        rowHtml += '</div>';
        html += rowHtml;
    }
    html += '</div>';
    html += `<div class="field-menu-scrollbar"><div class="sb-arrow" data-action="scroll-up">\u25B2</div><div class="sb-track"><div class="sb-thumb" style="top:${hdgThumbTop}%;height:${hdgThumbPct}%"></div></div><div class="sb-arrow" data-action="scroll-down">\u25BC</div></div>`;
    html += '</div>';
    if (curHdg != null) html += `<div class="field-menu-row field-menu-footer" data-action="delete-hdg" style="color:#aaa">DELETE</div>`;
    return html;
}

function refreshHdgMenu() {
    if (fieldMenuType !== 'hdg' || !fieldMenuGufi) return;
    document.getElementById('fm-body').innerHTML = buildHdgMenuBody(fieldMenuGufi);
}

// ── Speed Menu ──
let spdMenuPage = 0;
let spdMenuMach = false;
let spdMenuPlus = false;
let spdMenuMinus = false;

function openSpdMenu(gufi, clientX, clientY) {
    const f = flights.get(gufi);
    if (!f) return;
    spdMenuPage = 0;
    const hsf = getEffectiveHsf(f);
    spdMenuMach = !!(hsf && hsf.speed && /^M/i.test(hsf.speed));
    spdMenuPlus = !!(hsf && hsf.speed && /\+$/.test(hsf.speed));
    spdMenuMinus = !!(hsf && hsf.speed && /-$/.test(hsf.speed));
    openFieldMenu(gufi, 'spd', clientX, clientY, buildSpdMenuBody(gufi));
}

function buildSpdMenuBody(gufi) {
    const f = flights.get(gufi);
    if (!f) return '';
    const hsf = getEffectiveHsf(f);
    const curSpd = hsf ? hsf.speed : null;

    let html = '<div class="field-menu-hdr">';
    html += `<span data-action="spd-mach"${spdMenuMach ? ' class="active"' : ''}>${spdMenuMach ? 'M' : 'KT'}</span>`;
    html += `<span data-action="spd-plus"${spdMenuPlus ? ' class="active"' : ''}>+</span>`;
    html += `<span data-action="spd-minus"${spdMenuMinus ? ' class="active"' : ''}>-</span>`;
    html += '</div><div class="field-menu-divider"></div>';

    // Speed values with right-side scrollbar
    // Always show a full page; if near the end, shift back so last item is max
    let startM, startK, spdActualPage, spdMaxPageCalc;
    if (spdMenuMach) {
        startM = 92 - spdMenuPage * 7;
        const minStartM = 66;  // Show down to 60
        startM = Math.max(minStartM, Math.min(92, startM));
        spdActualPage = (92 - startM) / 7;
        spdMaxPageCalc = (92 - minStartM) / 7;
    } else {
        startK = 500 - spdMenuPage * 70;
        const minStartK = 160;  // Show down to 100
        startK = Math.max(minStartK, Math.min(500, startK));
        spdActualPage = (500 - startK) / 70;
        spdMaxPageCalc = (500 - minStartK) / 70;
    }
    const spdThumbPct = 1 / (spdMaxPageCalc + 1) * 100;
    const spdThumbTop = spdActualPage / (spdMaxPageCalc + 1) * 100;
    html += '<div class="field-menu-values">';
    html += '<div class="field-menu-values-col">';
    if (spdMenuMach) {
        for (let i = 0; i < 7; i++) {
            const m = startM - i;
            if (m < 60) continue;
            const suffix = spdMenuPlus ? '+' : spdMenuMinus ? '-' : '';
            const display = `.${m}${suffix}`;
            const isCurrent = curSpd && curSpd.replace(/[+-]/g, '').toUpperCase() === `M${m}`;
            const cls = isCurrent ? ' current' : '';
            html += `<div class="field-menu-row${cls}" data-action="set-spd" data-spd="M${m}">\u00a0\u00a0${display}</div>`;
        }
    } else {
        const startK = 500 - spdMenuPage * 70;
        for (let i = 0; i < 7; i++) {
            const k = startK - i * 10;
            if (k < 100) continue;
            const suffix = spdMenuPlus ? '+' : spdMenuMinus ? '-' : '';
            const display = `${k}${suffix}`;
            const isCurrent = curSpd && parseInt(String(curSpd).replace(/^S/, '').replace(/[+-]/g, '')) === k;
            const cls = isCurrent ? ' current' : '';
            html += `<div class="field-menu-row${cls}" data-action="set-spd" data-spd="${k}">\u00a0\u00a0${display}</div>`;
        }
    }
    html += '</div>';
    html += `<div class="field-menu-scrollbar"><div class="sb-arrow" data-action="scroll-up">\u25B2</div><div class="sb-track"><div class="sb-thumb" style="top:${spdThumbTop}%;height:${spdThumbPct}%"></div></div><div class="sb-arrow" data-action="scroll-down">\u25BC</div></div>`;
    html += '</div>';
    if (curSpd) {
        html += `<div class="field-menu-footer" style="display:flex;justify-content:space-between;">`;
        html += `<span class="field-menu-row" data-action="delete-spd" style="padding:0;color:#aaa">DEL</span>`;
        html += `<span style="color:#aaa">${curSpd}</span></div>`;
    }
    return html;
}

function refreshSpdMenu() {
    if (fieldMenuType !== 'spd' || !fieldMenuGufi) return;
    document.getElementById('fm-body').innerHTML = buildSpdMenuBody(fieldMenuGufi);
}

// ── Free Text Menu ──
function openTxtMenu(gufi, clientX, clientY) {
    const f = flights.get(gufi);
    if (!f) return;
    const hsf = getEffectiveHsf(f);
    const curText = hsf ? (hsf.freeText || '') : '';
    let html = `<input class="field-menu-input" id="fm-txt-input" value="${curText.replace(/"/g, '&quot;')}" maxlength="20">`;
    if (curText) {
        html += `<div class="field-menu-row field-menu-footer" data-action="delete-txt" style="color:#aaa">DELETE</div>`;
    }
    openFieldMenu(gufi, 'txt', clientX, clientY, html);
    const inp = document.getElementById('fm-txt-input');
    if (inp) {
        inp.focus();
        inp.addEventListener('keydown', e => {
            e.stopPropagation();
            if (e.key === 'Enter') {
                const text = inp.value.trim().toUpperCase();
                if (text && fieldMenuGufi) {
                    menuSetHsf(fieldMenuGufi, 'freeText', text);
                    hsfShowMap.add(fieldMenuGufi);
                }
                closeFieldMenu();
            } else if (e.key === 'Escape') {
                closeFieldMenu();
            }
        });
    }
}

// ── Field menu body click handler (directly sets local state — no ownership check) ──
function handleFieldMenuClick(e) {
    const el = e.target.closest('[data-action]');
    const action = el?.dataset?.action;
    if (!action) return;
    e.stopPropagation();
    const gufi = fieldMenuGufi;
    if (!gufi) return;
    const f = flights.get(gufi);
    if (!f) return;

    // Altitude menu actions
    if (fieldMenuType === 'alt') {
        if (action === 'clear-interim') {
            menuClearInterim(gufi);
            closeFieldMenu();
        } else if (action === 'toggle-local') {
            altMenuLocalTalt = !altMenuLocalTalt;
            if (altMenuLocalTalt) altMenuProcedure = false;
            refreshAltMenu();
        } else if (action === 'toggle-proc') {
            altMenuProcedure = !altMenuProcedure;
            if (altMenuProcedure) altMenuLocalTalt = false;
            refreshAltMenu();
        } else if (action === 'set-alt') {
            const fl = el.closest('[data-fl]')?.dataset?.fl;
            if (!fl) return;
            if (altMenuLocalTalt) menuSetInterim(gufi, fl, 'L');
            else if (altMenuProcedure) menuSetInterim(gufi, fl, 'P');
            else menuSetAlt(gufi, fl);
            closeFieldMenu();
        } else if (action === 'set-interim') {
            const fl = el.closest('[data-fl]')?.dataset?.fl;
            if (!fl) return;
            menuSetInterim(gufi, fl, 'I');
            closeFieldMenu();
        } else if (action === 'scroll-up') {
            const maxPage = Math.floor((600 - 10) / 70);
            altMenuPage = Math.min(maxPage, altMenuPage + 1);
            refreshAltMenu();
        } else if (action === 'scroll-down') {
            altMenuPage = Math.max(0, altMenuPage - 1);
            refreshAltMenu();
        }
    }

    // Heading menu actions
    if (fieldMenuType === 'hdg') {
        if (action === 'hdg-lt') {
            hdgMenuLT = !hdgMenuLT; if (hdgMenuLT) hdgMenuRT = false;
            refreshHdgMenu();
        } else if (action === 'hdg-rt') {
            hdgMenuRT = !hdgMenuRT; if (hdgMenuRT) hdgMenuLT = false;
            refreshHdgMenu();
        } else if (action === 'hdg-ph') {
            const hdg = f.trackVelocityX != null && f.trackVelocityY != null
                ? Math.round(((Math.atan2(f.trackVelocityX, f.trackVelocityY) * 180 / Math.PI + 360) % 360) / 5) * 5 || 360
                : null;
            if (hdg) menuSetHsf(gufi, 'heading', String(hdg).padStart(3, '0'));
            closeFieldMenu();
        } else if (action === 'set-hdg') {
            const hdg = el.closest('[data-hdg]')?.dataset?.hdg;
            if (!hdg) return;
            menuSetHsf(gufi, 'heading', String(hdg).padStart(3, '0'));
            closeFieldMenu();
        } else if (action === 'delete-hdg') {
            menuClearHsf(gufi, 'heading');
            closeFieldMenu();
        } else if (action === 'scroll-up') {
            const hdgMaxPage = Math.floor((360 - 5) / 70);
            hdgMenuPage = Math.min(hdgMaxPage, hdgMenuPage + 1); refreshHdgMenu();
        } else if (action === 'scroll-down') {
            hdgMenuPage = Math.max(0, hdgMenuPage - 1); refreshHdgMenu();
        }
    }

    // Speed menu actions
    if (fieldMenuType === 'spd') {
        if (action === 'spd-mach') {
            spdMenuMach = !spdMenuMach; spdMenuPage = 0; refreshSpdMenu();
        } else if (action === 'spd-plus') {
            spdMenuPlus = !spdMenuPlus; if (spdMenuPlus) spdMenuMinus = false; refreshSpdMenu();
        } else if (action === 'spd-minus') {
            spdMenuMinus = !spdMenuMinus; if (spdMenuMinus) spdMenuPlus = false; refreshSpdMenu();
        } else if (action === 'set-spd') {
            let spd = el.closest('[data-spd]')?.dataset?.spd;
            if (!spd) return;
            const suffix = spdMenuPlus ? '+' : spdMenuMinus ? '-' : '';
            menuSetHsf(gufi, 'speed', spd + suffix);
            closeFieldMenu();
        } else if (action === 'delete-spd') {
            menuClearHsf(gufi, 'speed');
            closeFieldMenu();
        } else if (action === 'scroll-up') {
            spdMenuPage = Math.max(0, spdMenuPage - 1); refreshSpdMenu();
        } else if (action === 'scroll-down') {
            const spdMaxPage = spdMenuMach ? Math.floor((92 - 60) / 7) : Math.floor((500 - 100) / 70);
            spdMenuPage = Math.min(spdMaxPage, spdMenuPage + 1); refreshSpdMenu();
        }
    }

    // Free text menu actions
    if (fieldMenuType === 'txt') {
        if (action === 'delete-txt') {
            menuClearAllHsf(gufi);
            closeFieldMenu();
        }
    }
}

document.getElementById('fm-body').addEventListener('click', handleFieldMenuClick);
document.getElementById('fm-body').addEventListener('auxclick', e => {
    if (e.button === 1) { e.preventDefault(); handleFieldMenuClick(e); }
});

// ════════════════════════════════════════════════════════════════════════════
// Toolbar state (must be global for updateToolbarBrightness access, and BEFORE loadSettingsFromLocalStorage)
// ════════════════════════════════════════════════════════════════════════════
const tbState = {
    masterVisible: false,
    openMenu: null,       // currently open sub-menu id string
    openSubMenu: null,    // nested sub-menu id (e.g. 'weather' under 'atc-tools')
    // Brightness values (0-100) for buttons not yet wired
    bright: {
        bckgrd: 40, cursor: 100, text: 100, prTgtr: 80, unpTgt: 80,
        prHist: 80, unpHist: 80, ldb: 70, bcklght: 80, button: 70,
        border: 30, toolbar: 40, tbBrdr: 30, fdb: 80, portal: 50,
        onFreq: 70, line4b: 50, dwell: 50, fence: 80, sldb: 50,
    },
    // Cursor sub-menu
    cursorSize: 1,
};

// Restore toolbar brightness state from localStorage (must be AFTER tbState is defined)
try {
    const saved = localStorage.getItem('eram-settings');
    if (saved) {
        const settings = JSON.parse(saved);
        if (settings.tbState && settings.tbState.bright) {
            Object.assign(tbState.bright, settings.tbState.bright);
        }
    }
} catch (e) {
    console.warn('Failed to restore toolbar brightness state:', e);
}

// ════════════════════════════════════════════════════════════════════════════
// Init
// ════════════════════════════════════════════════════════════════════════════
loadSettingsFromLocalStorage();
rebuildFacilityDropdown();
rebuildSectorCheckboxes();

// Save map position/zoom on pan/zoom (debounced)
let _mapSaveTimer = null;
map.on('moveend', () => {
    clearTimeout(_mapSaveTimer);
    _mapSaveTimer = setTimeout(saveSettingsToLocalStorage, 500);
});

window.idleOnPause = () => { if (_ws) { _ws.onclose = null; _ws.close(); _ws = null; } };
window.idleOnResume = () => { connectWs(); };

document.getElementById('cmd-help-btn').onclick = () => {
    const p = document.getElementById('cmd-help-popup');
    p.style.display = p.style.display === 'block' ? 'none' : 'block';
};
document.getElementById('numpad-inverted').addEventListener('change', saveSettingsToLocalStorage);

// ════════════════════════════════════════════════════════════════════════════
// Master Toolbar System
// ════════════════════════════════════════════════════════════════════════════
(function () {

// ── Helper: approximate range NM from zoom ──
function zoomToRange(z) {
    // At zoom 6 ~300nm, zoom 10 ~20nm. Rough: 40000 / 2^zoom
    return Math.round(40000 / Math.pow(2, z));
}

// ── Helper: get current value from an existing control ──
function getSelectVal(id) {
    const el = document.getElementById(id);
    return el ? el.value : '';
}
function getRangeVal(id) {
    const el = document.getElementById(id);
    return el ? parseInt(el.value) : 0;
}
function setSelectVal(id, val) {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = val;
    el.dispatchEvent(new Event('change'));
}
function setRangeVal(id, val) {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = val;
    el.dispatchEvent(new Event('input'));
}

// ── Vector cycle values ──
const VECTOR_STEPS = [0, 1, 2, 4, 8];

// ── NX LVL cycle: select option values ──
const NXLVL_STEPS = ['0', '3', '23', '123'];
function nxlvlLabel(val) {
    if (val === '0') return 'OFF';
    return val;
}

// ── Font size steps ──
const FONT_STEPS = [8, 9, 10, 11, 12, 14];

// ── Button spec builder helpers ──
function nosim(label, opts) { return { label, type: 'nosim', ...opts }; }
function menu(label, menuId, opts) { return { label, type: 'menu', menu: menuId, ...opts }; }
function toggle(label, opts) { return { label, type: 'toggle', ...opts }; }
function incdec(label, opts) { return { label, type: 'incdec', ...opts }; }
function cmd(label, opts) { return { label, type: 'cmd', ...opts }; }

// ════════════════════════════════════════════════════════════════════════════
// Button definitions — Master Toolbar
// ════════════════════════════════════════════════════════════════════════════
const TB_MASTER = {
    id: 'master',
    rows: [
        [
            toggle('DRAW', {
                isOn: () => false,
                onToggle: () => {},
            }),
            menu('ATC\nTOOLS', 'atc-tools'),
            toggle('AB\nSETTING', {
                isOn: () => false,
                onToggle: () => {},
            }),
            incdec('RANGE', {
                cls: 'tb-dark',
                getValue: () => zoomToRange(map.getZoom()),
                formatValue: v => String(v),
                onDec: () => map.zoomOut(1),  // left-click = zoom out (more range)
                onInc: () => map.zoomIn(1),   // middle-click = zoom in (less range)
            }),
            menu('CURSOR', 'cursor'),
            menu('BRIGHT', 'bright'),
            menu('FONT', 'font'),
            menu('DB\nFIELDS', 'db-fields'),
            incdec('VECTOR', {
                cls: 'tb-green',
                getValue: () => parseInt(getSelectVal('sel-vector')),
                formatValue: v => String(v),
                onDec: () => {
                    const cur = parseInt(getSelectVal('sel-vector'));
                    const idx = VECTOR_STEPS.indexOf(cur);
                    const next = idx > 0 ? VECTOR_STEPS[idx - 1] : VECTOR_STEPS[VECTOR_STEPS.length - 1];
                    setSelectVal('sel-vector', next);
                },
                onInc: () => {
                    const cur = parseInt(getSelectVal('sel-vector'));
                    const idx = VECTOR_STEPS.indexOf(cur);
                    const next = idx < VECTOR_STEPS.length - 1 ? VECTOR_STEPS[idx + 1] : VECTOR_STEPS[0];
                    setSelectVal('sel-vector', next);
                },
            }),
        ],
        [
            menu('VIEWS', 'views'),
            menu('CHECK\nLISTS', 'check-lists'),
            toggle('COMMAND\nMENUS', {
                isOn: () => false,
                onToggle: () => {},
            }),
            menu('MAP', 'geomap'),
            incdec('ALT LIM', {
                cls: 'tb-dark',
                getValue: () => {
                    const lo = document.getElementById('inp-alt-low')?.value || '0';
                    const hi = document.getElementById('inp-alt-high')?.value || '999';
                    return lo.padStart(3, '0') + 'B' + hi.padStart(3, '0');
                },
                formatValue: v => v,
                onDec: () => {},
                onInc: () => {},
            }),
            menu('RADAR\nFILTER', 'radar-filter'),
            toggle('PREFSET', {
                isOn: () => false,
                onToggle: () => {},
            }),
            cmd('DELETE\nTEAROFF', {
                cls: 'tb-teal',
                onCmd: () => {
                    // If exiting delete mode, clear any marked selections
                    if (tearoffDeleteMode) {
                        for (const key of selectedTearoffsForDeletion) {
                            const tearoff = activeTearoffs.get(key);
                            if (tearoff && tearoff.buttonClone) {
                                tearoff.buttonClone.classList.remove('tb-delete-selected');
                            }
                        }
                        selectedTearoffsForDeletion.clear();
                    }
                    tearoffDeleteMode = !tearoffDeleteMode;
                    closeAllSubMenus();
                    refreshAllButtons();
                },
            }),
        ],
    ],
};

// ════════════════════════════════════════════════════════════════════════════
// Sub-menu definitions
// ════════════════════════════════════════════════════════════════════════════

const TB_ATC_TOOLS = {
    id: 'atc-tools',
    rows: [
        [
            toggle('CRR FIX', {
                cls: 'tb-toggle-grey',
                isOn: () => false,
                onToggle: () => {},
            }),
            toggle('SPEED\nADVSRY', {
                cls: 'tb-toggle-grey',
                isOn: () => false,
                onToggle: () => {},
            }),
            menu('WX', 'weather'),
        ],
    ],
};

const TB_WEATHER = {
    id: 'weather',
    parentMenu: 'atc-tools',
    rows: [
        [
            incdec('NX 000', { cls: 'tb-green', getValue: () => '600', formatValue: v => v, onDec: () => {}, onInc: () => {} }),
            incdec('NX LVL', {
                cls: 'tb-green',
                getValue: () => nxlvlLabel(getSelectVal('sel-nxlvl')),
                formatValue: v => v,
                onDec: () => {
                    const cur = getSelectVal('sel-nxlvl');
                    const idx = NXLVL_STEPS.indexOf(cur);
                    const next = idx > 0 ? NXLVL_STEPS[idx - 1] : NXLVL_STEPS[NXLVL_STEPS.length - 1];
                    setSelectVal('sel-nxlvl', next);
                },
                onInc: () => {
                    const cur = getSelectVal('sel-nxlvl');
                    const idx = NXLVL_STEPS.indexOf(cur);
                    const next = idx < NXLVL_STEPS.length - 1 ? NXLVL_STEPS[idx + 1] : NXLVL_STEPS[0];
                    setSelectVal('sel-nxlvl', next);
                },
            }),
        ],
        [
            toggle('WX1', {
                cls: 'tb-toggle-grey',
                isOn: () => false,
                onToggle: () => {},
            }),
            toggle('WX2', {
                cls: 'tb-toggle-grey',
                isOn: () => false,
                onToggle: () => {},
            }),
            toggle('WX3', {
                cls: 'tb-toggle-grey',
                isOn: () => false,
                onToggle: () => {},
            }),
        ],
    ],
};

const TB_VIEWS = {
    id: 'views',
    rows: [
        [
            toggle('ALTIM\nSET', {
                cls: 'tb-toggle-grey',
                isOn: () => altimeterMenuOpen,
                onToggle: () => {
                    if (altimeterMenuOpen) {
                        closeAltimeterMenu();
                    } else {
                        openAltimeterMenu();
                    }
                },
            }),
            toggle('AUTO HO\nINHIB', {
                cls: 'tb-toggle-grey',
                isOn: () => false,
                onToggle: () => {},
            }),
            toggle('CFR', {
                cls: 'tb-toggle-grey',
                isOn: () => false,
                onToggle: () => {},
            }),
            toggle('CODE', {
                cls: 'tb-toggle-grey',
                isOn: () => false,
                onToggle: () => {},
            }),
            toggle('CONFLCT\nALERT', {
                cls: 'tb-toggle-grey',
                isOn: () => false,
                onToggle: () => {},
            }),
            toggle('CPDLC\nADV', {
                cls: 'tb-toggle-grey',
                isOn: () => false,
                onToggle: () => {},
            }),
            toggle('CPDLC\nHIST', {
                cls: 'tb-toggle-grey',
                isOn: () => false,
                onToggle: () => {},
            }),
            toggle('CPDLC\nTOC SET', {
                cls: 'tb-toggle-grey',
                isOn: () => false,
                onToggle: () => {},
            }),
            toggle('CRR', {
                cls: 'tb-toggle-grey',
                isOn: () => crrMenuOpen,
                onToggle: () => {
                    if (crrMenuOpen) {
                        closeCrrMenu();
                    } else {
                        openCrrMenu();
                    }
                },
            }),
        ],
        [
            toggle('DEPT\nLIST', {
                cls: 'tb-toggle-grey',
                isOn: () => false,
                onToggle: () => {},
            }),
            toggle('FLIGHT\nEVENT', {
                cls: 'tb-toggle-grey',
                isOn: () => false,
                onToggle: () => {},
            }),
            toggle('GROUP\nSUP', {
                cls: 'tb-toggle-grey',
                isOn: () => false,
                onToggle: () => {},
            }),
            toggle('HOLD\nLIST', {
                cls: 'tb-toggle-grey',
                isOn: () => false,
                onToggle: () => {},
            }),
            toggle('INBND\nLIST', {
                cls: 'tb-toggle-grey',
                isOn: () => false,
                onToggle: () => {},
            }),
            toggle('MRP\nLIST', {
                cls: 'tb-toggle-grey',
                isOn: () => false,
                onToggle: () => {},
            }),
            toggle('SSA\nFILTER', {
                cls: 'tb-toggle-grey',
                isOn: () => false,
                onToggle: () => {},
            }),
            toggle('UA', {
                cls: 'tb-toggle-grey',
                isOn: () => false,
                onToggle: () => {},
            }),
            toggle('WX\nREPORT', {
                cls: 'tb-toggle-grey',
                isOn: () => weatherMenuOpen,
                onToggle: () => {
                    if (weatherMenuOpen) {
                        closeWeatherMenu();
                    } else {
                        openWeatherMenu();
                    }
                },
            }),
        ],
    ],
};

const TB_CHECK_LISTS = {
    id: 'check-lists',
    rows: [
        [
            toggle('POS\nCHECK', {
                cls: 'tb-toggle-grey',
                isOn: () => document.getElementById('checklist-menu').style.display !== 'none' && document.getElementById('checklist-menu-title-text').textContent === 'POS CHECK',
                onToggle: () => {
                    const menu = document.getElementById('checklist-menu');
                    const isOpen = menu.style.display !== 'none';
                    const isPosOpen = isOpen && document.getElementById('checklist-menu-title-text').textContent === 'POS CHECK';

                    if (isPosOpen) {
                        closeChecklist();
                    } else {
                        openChecklist('pos', window.innerWidth / 2, window.innerHeight / 2);
                    }
                },
            }),
            toggle('EMERG\nCHECK', {
                cls: 'tb-toggle-grey',
                isOn: () => document.getElementById('checklist-menu').style.display !== 'none' && document.getElementById('checklist-menu-title-text').textContent === 'EMERG CHECK',
                onToggle: () => {
                    const menu = document.getElementById('checklist-menu');
                    const isOpen = menu.style.display !== 'none';
                    const isEmergOpen = isOpen && document.getElementById('checklist-menu-title-text').textContent === 'EMERG CHECK';

                    if (isEmergOpen) {
                        closeChecklist();
                    } else {
                        openChecklist('emerg', window.innerWidth / 2, window.innerHeight / 2);
                    }
                },
            }),
        ],
    ],
};

const TB_CURSOR = {
    id: 'cursor',
    rows: [
        [
            incdec('SPEED', {
                cls: 'tb-green',
                getValue: () => 0,
                formatValue: v => v,
                onDec: () => {},
                onInc: () => {},
            }),
            incdec('SIZE', {
                cls: 'tb-green',
                getValue: () => tbState.cursorSize,
                formatValue: v => String(v),
                onDec: () => { tbState.cursorSize = Math.max(1, tbState.cursorSize - 1); },
                onInc: () => { tbState.cursorSize = Math.min(5, tbState.cursorSize + 1); },
            }),
            incdec('VOLUME', {
                cls: 'tb-green',
                getValue: () => 0,
                formatValue: v => v,
                onDec: () => {},
                onInc: () => {},
            }),
        ],
    ],
};

const TB_GEOMAP = {
    id: 'geomap',
    rows: [
        [
            toggle('UHI', {
                cls: 'tb-toggle-grey',
                isOn: () => getRangeVal('rng-bnd-uhi') > 0,
                onToggle: (on) => setRangeVal('rng-bnd-uhi', on ? 60 : 0),
            }),
            toggle('HI', {
                cls: 'tb-toggle-grey',
                isOn: () => getRangeVal('rng-bnd-hi') > 0,
                onToggle: (on) => setRangeVal('rng-bnd-hi', on ? 60 : 0),
            }),
            toggle('LO', {
                cls: 'tb-toggle-grey',
                isOn: () => getRangeVal('rng-bnd-lo') > 0,
                onToggle: (on) => setRangeVal('rng-bnd-lo', on ? 60 : 0),
            }),
            toggle('APP', {
                cls: 'tb-toggle-grey',
                isOn: () => getRangeVal('rng-bnd-app') > 0,
                onToggle: (on) => setRangeVal('rng-bnd-app', on ? 60 : 0),
            }),
        ],
        [
            toggle('HI AWY', {
                cls: 'tb-toggle-grey',
                isOn: () => getRangeVal('rng-jroutes') > 0,
                onToggle: (on) => setRangeVal('rng-jroutes', on ? 60 : 0),
            }),
            toggle('LO AWY', {
                cls: 'tb-toggle-grey',
                isOn: () => getRangeVal('rng-vroutes') > 0,
                onToggle: (on) => setRangeVal('rng-vroutes', on ? 60 : 0),
            }),
            toggle('VORs', {
                cls: 'tb-toggle-grey',
                isOn: () => getRangeVal('rng-vors') > 0,
                onToggle: (on) => setRangeVal('rng-vors', on ? 60 : 0),
            }),
            toggle('APTs', {
                cls: 'tb-toggle-grey',
                isOn: () => getRangeVal('rng-airports') > 0,
                onToggle: (on) => setRangeVal('rng-airports', on ? 60 : 0),
            }),
        ],
    ],
};

const TB_BRIGHT = {
    id: 'bright',
    rows: [
        [
            menu('MAP\nBRIGHT', 'map-bright', { cls: 'tb-blue' }),
            nosim('CPDLC', { cls: 'tb-blue' }),
            incdec('BCKGRD', { cls: 'tb-green', getValue: () => tbState.bright.bckgrd, formatValue: v => v, onDec: () => { scopeBckgrd = Math.max(0, scopeBckgrd - 10); tbState.bright.bckgrd = scopeBckgrd; updateScopeBackground(); saveSettingsToLocalStorage(); }, onInc: () => { scopeBckgrd = Math.min(100, scopeBckgrd + 10); tbState.bright.bckgrd = scopeBckgrd; updateScopeBackground(); saveSettingsToLocalStorage(); } }),
            incdec('CURSOR', { cls: 'tb-green', getValue: () => tbState.bright.cursor, formatValue: v => v, onDec: () => { tbState.bright.cursor = Math.max(0, tbState.bright.cursor - 10); updateCursorBrightness(); saveSettingsToLocalStorage(); }, onInc: () => { tbState.bright.cursor = Math.min(100, tbState.bright.cursor + 10); updateCursorBrightness(); saveSettingsToLocalStorage(); } }),
            incdec('TEXT', { cls: 'tb-green', getValue: () => tbState.bright.text, formatValue: v => v, onDec: () => { tbState.bright.text = Math.max(0, tbState.bright.text - 10); updateTextBrightness(); saveSettingsToLocalStorage(); }, onInc: () => { tbState.bright.text = Math.min(100, tbState.bright.text + 10); updateTextBrightness(); saveSettingsToLocalStorage(); } }),
            incdec('PR TGT', { cls: 'tb-green', getValue: () => tbState.bright.prTgtr, formatValue: v => v, onDec: () => { tbState.bright.prTgtr = Math.max(0, tbState.bright.prTgtr - 10); updatePrTgtBrightness(); saveSettingsToLocalStorage(); }, onInc: () => { tbState.bright.prTgtr = Math.min(100, tbState.bright.prTgtr + 10); updatePrTgtBrightness(); saveSettingsToLocalStorage(); } }),
            incdec('UNP TGT', { cls: 'tb-green', getValue: () => tbState.bright.unpTgt, formatValue: v => v, onDec: () => { tbState.bright.unpTgt = Math.max(0, tbState.bright.unpTgt - 10); updateUnpTgtBrightness(); saveSettingsToLocalStorage(); }, onInc: () => { tbState.bright.unpTgt = Math.min(100, tbState.bright.unpTgt + 10); updateUnpTgtBrightness(); saveSettingsToLocalStorage(); } }),
            incdec('PR HST', { cls: 'tb-green', getValue: () => tbState.bright.prHist, formatValue: v => v, onDec: () => { tbState.bright.prHist = Math.max(0, tbState.bright.prHist - 10); updatePrHistBrightness(); saveSettingsToLocalStorage(); }, onInc: () => { tbState.bright.prHist = Math.min(100, tbState.bright.prHist + 10); updatePrHistBrightness(); saveSettingsToLocalStorage(); } }),
            incdec('UNP HST', { cls: 'tb-green', getValue: () => tbState.bright.unpHist, formatValue: v => v, onDec: () => { tbState.bright.unpHist = Math.max(0, tbState.bright.unpHist - 10); updateUnpHistBrightness(); saveSettingsToLocalStorage(); }, onInc: () => { tbState.bright.unpHist = Math.min(100, tbState.bright.unpHist + 10); updateUnpHistBrightness(); saveSettingsToLocalStorage(); } }),
            incdec('LDB', {
                cls: 'tb-green',
                getValue: () => tbState.bright.ldb,
                formatValue: v => v,
                onDec: () => { tbState.bright.ldb = Math.max(0, tbState.bright.ldb - 10); updateLdbBrightness(); saveSettingsToLocalStorage(); },
                onInc: () => { tbState.bright.ldb = Math.min(100, tbState.bright.ldb + 10); updateLdbBrightness(); saveSettingsToLocalStorage(); },
            }),
            nosim('SLDB'),
            nosim('WX'),
            incdec('NEXRAD', {
                cls: 'tb-green',
                getValue: () => getRangeVal('rng-nx'),
                formatValue: v => v,
                onDec: () => setRangeVal('rng-nx', Math.max(0, getRangeVal('rng-nx') - 10)),
                onInc: () => setRangeVal('rng-nx', Math.min(100, getRangeVal('rng-nx') + 10)),
            }),
        ],
        [
            incdec('BCKLGHT', { cls: 'tb-green', getValue: () => tbState.bright.bcklght, formatValue: v => v, onDec: () => { scopeBcklght = Math.max(0, scopeBcklght - 10); tbState.bright.bcklght = scopeBcklght; updateScopeBackground(); saveSettingsToLocalStorage(); }, onInc: () => { scopeBcklght = Math.min(100, scopeBcklght + 10); tbState.bright.bcklght = scopeBcklght; updateScopeBackground(); saveSettingsToLocalStorage(); } }),
            incdec('BUTTON', { cls: 'tb-green', getValue: () => tbState.bright.button, formatValue: v => v, onDec: () => { tbState.bright.button = Math.max(0, tbState.bright.button - 10); updateButtonBrightness(); saveSettingsToLocalStorage(); }, onInc: () => { tbState.bright.button = Math.min(100, tbState.bright.button + 10); updateButtonBrightness(); saveSettingsToLocalStorage(); } }),
            incdec('BORDER', { cls: 'tb-green', getValue: () => tbState.bright.border, formatValue: v => v, onDec: () => { tbState.bright.border = Math.max(0, tbState.bright.border - 10); updateBorderBrightness(); saveSettingsToLocalStorage(); }, onInc: () => { tbState.bright.border = Math.min(100, tbState.bright.border + 10); updateBorderBrightness(); saveSettingsToLocalStorage(); } }),
            incdec('TOOLBAR', { cls: 'tb-green', getValue: () => tbState.bright.toolbar, formatValue: v => v, onDec: () => { tbState.bright.toolbar = Math.max(0, tbState.bright.toolbar - 10); updateToolbarBackgroundBrightness(); saveSettingsToLocalStorage(); }, onInc: () => { tbState.bright.toolbar = Math.min(100, tbState.bright.toolbar + 10); updateToolbarBackgroundBrightness(); saveSettingsToLocalStorage(); } }),
            incdec('TB BRDR', { cls: 'tb-green', getValue: () => tbState.bright.tbBrdr, formatValue: v => v, onDec: () => { tbState.bright.tbBrdr = Math.max(0, tbState.bright.tbBrdr - 10); updateToolbarBorderColor(); saveSettingsToLocalStorage(); }, onInc: () => { tbState.bright.tbBrdr = Math.min(100, tbState.bright.tbBrdr + 10); updateToolbarBorderColor(); saveSettingsToLocalStorage(); } }),
            nosim('AB BRDR'),
            incdec('FDB', { cls: 'tb-green', getValue: () => tbState.bright.fdb, formatValue: v => v, onDec: () => { tbState.bright.fdb = Math.max(0, tbState.bright.fdb - 10); updateFdbBrightness(); saveSettingsToLocalStorage(); }, onInc: () => { tbState.bright.fdb = Math.min(100, tbState.bright.fdb + 10); updateFdbBrightness(); saveSettingsToLocalStorage(); } }),
            nosim('PORTAL'),
            nosim('SATCOMM'),
            incdec('ON-FREQ', { cls: 'tb-green', getValue: () => tbState.bright.onFreq, formatValue: v => v, onDec: () => { tbState.bright.onFreq = Math.max(0, tbState.bright.onFreq - 10); updateOnFreqBrightness(); saveSettingsToLocalStorage(); }, onInc: () => { tbState.bright.onFreq = Math.min(100, tbState.bright.onFreq + 10); updateOnFreqBrightness(); saveSettingsToLocalStorage(); } }),
            nosim('LINE 4'),
            nosim('DWELL'),
            incdec('FENCE', { cls: 'tb-green', getValue: () => tbState.bright.fence, formatValue: v => v, onDec: () => { tbState.bright.fence = Math.max(0, tbState.bright.fence - 10); invalidateAllMarkers(); saveSettingsToLocalStorage(); }, onInc: () => { tbState.bright.fence = Math.min(100, tbState.bright.fence + 10); invalidateAllMarkers(); saveSettingsToLocalStorage(); } }),
            nosim('DBFEL'),
            nosim('OUTAGE'),
        ],
    ],
};

const TB_MAP_BRIGHT = {
    id: 'map-bright',
    parentMenu: 'bright',
    rows: [
        [
            incdec('UHI', {
                cls: 'tb-green',
                getValue: () => getRangeVal('rng-bnd-uhi'),
                formatValue: v => v,
                onDec: () => setRangeVal('rng-bnd-uhi', Math.max(0, getRangeVal('rng-bnd-uhi') - 10)),
                onInc: () => setRangeVal('rng-bnd-uhi', Math.min(100, getRangeVal('rng-bnd-uhi') + 10)),
            }),
            incdec('HI', {
                cls: 'tb-green',
                getValue: () => getRangeVal('rng-bnd-hi'),
                formatValue: v => v,
                onDec: () => setRangeVal('rng-bnd-hi', Math.max(0, getRangeVal('rng-bnd-hi') - 10)),
                onInc: () => setRangeVal('rng-bnd-hi', Math.min(100, getRangeVal('rng-bnd-hi') + 10)),
            }),
            incdec('LO', {
                cls: 'tb-green',
                getValue: () => getRangeVal('rng-bnd-lo'),
                formatValue: v => v,
                onDec: () => setRangeVal('rng-bnd-lo', Math.max(0, getRangeVal('rng-bnd-lo') - 10)),
                onInc: () => setRangeVal('rng-bnd-lo', Math.min(100, getRangeVal('rng-bnd-lo') + 10)),
            }),
            incdec('APP', {
                cls: 'tb-green',
                getValue: () => getRangeVal('rng-bnd-app'),
                formatValue: v => v,
                onDec: () => setRangeVal('rng-bnd-app', Math.max(0, getRangeVal('rng-bnd-app') - 10)),
                onInc: () => setRangeVal('rng-bnd-app', Math.min(100, getRangeVal('rng-bnd-app') + 10)),
            }),
            incdec('HI AWY', {
                cls: 'tb-green',
                getValue: () => getRangeVal('rng-jroutes'),
                formatValue: v => v,
                onDec: () => setRangeVal('rng-jroutes', Math.max(0, getRangeVal('rng-jroutes') - 10)),
                onInc: () => setRangeVal('rng-jroutes', Math.min(100, getRangeVal('rng-jroutes') + 10)),
            }),
            incdec('LO AWY', {
                cls: 'tb-green',
                getValue: () => getRangeVal('rng-vroutes'),
                formatValue: v => v,
                onDec: () => setRangeVal('rng-vroutes', Math.max(0, getRangeVal('rng-vroutes') - 10)),
                onInc: () => setRangeVal('rng-vroutes', Math.min(100, getRangeVal('rng-vroutes') + 10)),
            }),
            incdec('VORS', {
                cls: 'tb-green',
                getValue: () => getRangeVal('rng-vors'),
                formatValue: v => v,
                onDec: () => setRangeVal('rng-vors', Math.max(0, getRangeVal('rng-vors') - 10)),
                onInc: () => setRangeVal('rng-vors', Math.min(100, getRangeVal('rng-vors') + 10)),
            }),
            incdec('APTS', {
                cls: 'tb-green',
                getValue: () => getRangeVal('rng-airports'),
                formatValue: v => v,
                onDec: () => setRangeVal('rng-airports', Math.max(0, getRangeVal('rng-airports') - 10)),
                onInc: () => setRangeVal('rng-airports', Math.min(100, getRangeVal('rng-airports') + 10)),
            }),
        ],
    ],
};

const TB_FONT = {
    id: 'font',
    rows: [
        [
            incdec('LINE 4', {
                cls: 'tb-green',
                getValue: () => 10,
                formatValue: v => v,
                onDec: () => {},
                onInc: () => {},
            }),
            incdec('FDB', {
                cls: 'tb-green',
                getValue: () => parseInt(getSelectVal('sel-fontsize')),
                formatValue: v => v,
                onDec: () => {
                    const cur = parseInt(getSelectVal('sel-fontsize'));
                    const idx = FONT_STEPS.indexOf(cur);
                    if (idx > 0) setSelectVal('sel-fontsize', FONT_STEPS[idx - 1]);
                },
                onInc: () => {
                    const cur = parseInt(getSelectVal('sel-fontsize'));
                    const idx = FONT_STEPS.indexOf(cur);
                    if (idx < FONT_STEPS.length - 1) setSelectVal('sel-fontsize', FONT_STEPS[idx + 1]);
                },
            }),
            incdec('TOOLBAR', {
                cls: 'tb-green',
                getValue: () => 10,
                formatValue: v => v,
                onDec: () => {},
                onInc: () => {},
            }),
            incdec('LDB', {
                cls: 'tb-green',
                getValue: () => 10,
                formatValue: v => v,
                onDec: () => {},
                onInc: () => {},
            }),
            incdec('RDB', {
                cls: 'tb-green',
                getValue: () => 10,
                formatValue: v => v,
                onDec: () => {},
                onInc: () => {},
            }),
            incdec('OUTAGE', {
                cls: 'tb-green',
                getValue: () => 10,
                formatValue: v => v,
                onDec: () => {},
                onInc: () => {},
            }),
        ],
    ],
};

// DB Fields sub-menu — DEST and TYPE are mutually exclusive toggles wired to sel-line4
const TB_DB_FIELDS = {
    id: 'db-fields',
    rows: [
        [
            toggle('NON-\nRVSM', {
                cls: 'tb-toggle-grey',
                isOn: () => true,
                onToggle: () => {},
            }),
            toggle('VRI', {
                cls: 'tb-toggle-grey',
                isOn: () => false,
                onToggle: () => {},
                isMomentary: true,
            }),
            toggle('CODE', {
                cls: 'tb-toggle-grey',
                isOn: () => false,
                onToggle: () => {},
                isMomentary: true,
            }),
            toggle('SPEED', {
                cls: 'tb-toggle-grey',
                isOn: () => false,
                onToggle: () => {},
                isMomentary: true,
            }),
            toggle('DEST', {
                cls: 'tb-toggle-grey',
                isOn: () => getSelectVal('sel-line4') === 'DEST',
                onToggle: (on) => {
                    setSelectVal('sel-line4', on ? 'DEST' : 'OFF');
                    refreshAllSubMenus();
                },
            }),
            toggle('TYPE', {
                cls: 'tb-toggle-grey',
                isOn: () => getSelectVal('sel-line4') === 'TYPE',
                onToggle: (on) => {
                    setSelectVal('sel-line4', on ? 'TYPE' : 'OFF');
                    refreshAllSubMenus();
                },
            }),
            incdec('FDB LDR', {
                cls: 'tb-green',
                getValue: () => 1,
                formatValue: v => v,
                onDec: () => {},
                onInc: () => {},
            }),
            toggle('BCAST\nFLID', {
                cls: 'tb-toggle-grey',
                isOn: () => false,
                onToggle: () => {},
            }),
            toggle('PORTAL\nFENCE', {
                cls: 'tb-toggle-grey',
                isOn: () => showPortalFence,
                onToggle: (on) => { showPortalFence = on; invalidateAllMarkers(); },
            }),
        ],
        [
            incdec('NON-\nADS-B', {
                cls: 'tb-green',
                getValue: () => 1,
                formatValue: v => v,
                onDec: () => {},
                onInc: () => {},
            }),
            toggle('NONADSB', {
                cls: 'tb-toggle-grey',
                isOn: () => false,
                onToggle: () => {},
            }),
            toggle('SAT\nCOMM', {
                cls: 'tb-toggle-grey',
                isOn: () => false,
                onToggle: () => {},
            }),
            toggle('TFM\nREROUTE', {
                cls: 'tb-toggle-grey',
                isOn: () => false,
                onToggle: () => {},
            }),
            toggle('CRR\nRDB', {
                cls: 'tb-toggle-grey',
                isOn: () => crrRdbEnabled,
                onToggle: (on) => {
                    crrRdbEnabled = on;
                    crrRdbOffset = 3;  // Reset offset to bottom-left when toggling on
                    invalidateAllMarkers();
                },
            }),
            toggle('STA RDB', {
                cls: 'tb-toggle-grey',
                isOn: () => false,
                onToggle: () => {},
            }),
            toggle('DELAY\nRDB', {
                cls: 'tb-toggle-grey',
                isOn: () => false,
                onToggle: () => {},
            }),
            toggle('DELAY\nFORMAT', {
                cls: 'tb-toggle-grey',
                isOn: () => false,
                onToggle: () => {},
            }),
        ],
    ],
};

const TB_RADAR_FILTER = {
    id: 'radar-filter',
    rows: [
        [
            toggle('ALL\nLDBS', {
                cls: 'tb-toggle-grey',
                isOn: () => false,
                onToggle: () => {},
            }),
            toggle('PR LDB', {
                cls: 'tb-toggle-grey',
                isOn: () => false,
                onToggle: () => {},
            }),
            toggle('UNP\nLDB', {
                cls: 'tb-toggle-grey',
                isOn: () => false,
                onToggle: () => {},
            }),
            toggle('ALL\nPRIM', {
                cls: 'tb-toggle-grey',
                isOn: () => false,
                onToggle: () => {},
            }),
            toggle('NON\nMODE C', {
                cls: 'tb-toggle-grey',
                isOn: () => false,
                onToggle: () => {},
            }),
        ],
        [
            toggle('SELECT\nBEACON', {
                cls: 'tb-toggle-grey',
                isOn: () => false,
                onToggle: () => {},
            }),
            toggle('PERM\nECHO', {
                cls: 'tb-toggle-grey',
                isOn: () => false,
                onToggle: () => {},
            }),
            toggle('STROBE\nLINES', {
                cls: 'tb-toggle-grey',
                isOn: () => false,
                onToggle: () => {},
            }),
            incdec('HISTORY', {
                cls: 'tb-green',
                getValue: () => parseInt(getSelectVal('sel-histcount')),
                formatValue: v => v,
                onDec: () => {
                    const cur = parseInt(getSelectVal('sel-histcount'));
                    if (cur > 0) setSelectVal('sel-histcount', cur - 1);
                },
                onInc: () => {
                    const cur = parseInt(getSelectVal('sel-histcount'));
                    if (cur < 10) setSelectVal('sel-histcount', cur + 1);
                },
            }),
        ],
    ],
};

// Registry of all sub-menus
const SUB_MENUS = {
    'atc-tools': TB_ATC_TOOLS,
    'weather': TB_WEATHER,
    'views': TB_VIEWS,
    'check-lists': TB_CHECK_LISTS,
    'cursor': TB_CURSOR,
    'geomap': TB_GEOMAP,
    'bright': TB_BRIGHT,
    'map-bright': TB_MAP_BRIGHT,
    'font': TB_FONT,
    'db-fields': TB_DB_FIELDS,
    'radar-filter': TB_RADAR_FILTER,
};

// ════════════════════════════════════════════════════════════════════════════
// Rendering
// ════════════════════════════════════════════════════════════════════════════

// Active DOM references for refresh
const tbElements = new Map();  // btnKey → { el, spec }
let masterPanelEl = null;
let subMenuContainerEl = null;
let subSubMenuContainerEl = null;

function btnKey(panelId, rowIdx, colIdx) {
    return panelId + ':' + rowIdx + ':' + colIdx;
}

function updateTearoffColors() {
    // Update all tearoff strips: tan if no active tearoff, grey if one exists for this button
    for (const [key, entry] of tbElements) {
        const tear = entry.el.querySelector('.tb-tear');
        if (!tear) continue;

        const hasActiveTearoff = activeTearoffs.has(key);

        if (hasActiveTearoff) {
            // Grey (#C7C7C7) + disabled
            tear.classList.add('tb-tear-disabled');
            tear.style.cursor = 'default';
            tear.dataset.disabled = 'true';
        } else {
            // Tan (#FFFFA1) + enabled
            tear.classList.remove('tb-tear-disabled');
            tear.style.cursor = 'var(--eram-cursor)';
            tear.dataset.disabled = 'false';
        }
    }
}

function createFloatingTearoff(btnKey, spec) {
    // Create floating container (just wraps the button)
    const container = document.createElement('div');
    container.className = 'tb-floating-tearoff';
    container.style.cssText = `
        position: fixed;
        z-index: 970;
        user-select: none;
    `;

    // Clone the button
    let buttonClone = null;
    const sourceEntry = tbElements.get(btnKey);
    if (sourceEntry) {
        buttonClone = sourceEntry.el.cloneNode(true);

        // Re-attach event listeners to the clone
        if (!spec.nosim && spec.type !== 'nosim') {
            // Left click (skip if on tearoff strip)
            buttonClone.addEventListener('click', (e) => {
                if (!e.target.closest('.tb-tear')) {
                    e.stopPropagation();
                    // Skip normal toggle for momentary buttons (they only respond to hold, not click)
                    if (!(spec.type === 'toggle' && spec.isMomentary)) {
                        // In delete mode, left-click marks tearoff for deletion
                        if (tearoffDeleteMode) {
                            if (selectedTearoffsForDeletion.has(btnKey)) {
                                selectedTearoffsForDeletion.delete(btnKey);
                                buttonClone.classList.remove('tb-delete-selected');
                            } else {
                                selectedTearoffsForDeletion.add(btnKey);
                                buttonClone.classList.add('tb-delete-selected');
                            }
                        } else {
                            // For menu buttons, pass the buttonClone as the anchor so menu opens next to floating button
                            handleBtnAction(spec, btnKey, false, spec.type === 'menu' ? buttonClone : undefined);
                        }
                    }
                }
            });

            // Mousedown: handle momentary toggle and middle-click
            buttonClone.addEventListener('mousedown', (e) => {
                const isTearoff = e.target.closest('.tb-tear');

                // Momentary toggle: left-click shows "on" state while held
                if (e.button === 0 && !isTearoff && spec.type === 'toggle' && spec.isMomentary) {
                    e.preventDefault();
                    e.stopPropagation();

                    // Check delete mode first (allow marking for deletion)
                    if (tearoffDeleteMode) {
                        if (selectedTearoffsForDeletion.has(btnKey)) {
                            selectedTearoffsForDeletion.delete(btnKey);
                            buttonClone.classList.remove('tb-delete-selected');
                        } else {
                            selectedTearoffsForDeletion.add(btnKey);
                            buttonClone.classList.add('tb-delete-selected');
                        }
                        return;
                    }

                    buttonClone.classList.add('tb-toggle-on');
                    updateMomentaryIndicator(buttonClone, spec, true);
                    // Track momentary button state
                    if (spec.label === 'CODE') {
                        codeButtonPressed = true;
                        invalidateAllMarkers();
                    } else if (spec.label === 'SPEED') {
                        speedButtonPressed = true;
                        invalidateAllMarkers();
                    }
                    return;
                }

                // Middle click
                if (e.button === 1 && !isTearoff) {
                    e.preventDefault();
                    e.stopPropagation();
                    // Check if in delete mode and delete the floating tearoff
                    if (tearoffDeleteMode) {
                        // Delete the middle-clicked tearoff plus all selected ones
                        selectedTearoffsForDeletion.add(btnKey);

                        for (const key of selectedTearoffsForDeletion) {
                            const tearoff = activeTearoffs.get(key);
                            if (tearoff) {
                                tearoff.floatingEl.remove();
                                activeTearoffs.delete(key);
                            }
                        }

                        selectedTearoffsForDeletion.clear();
                        updateTearoffColors();
                        // Turn off delete mode after deleting
                        tearoffDeleteMode = false;
                        refreshAllButtons();
                        console.log('Tearoffs deleted');
                    } else {
                        handleBtnAction(spec, btnKey, true, spec.type === 'menu' ? buttonClone : undefined);
                    }
                }
            });

            // Mouseup: revert momentary toggle to off state
            buttonClone.addEventListener('mouseup', (e) => {
                if (spec.type === 'toggle' && spec.isMomentary) {
                    e.stopPropagation();
                    buttonClone.classList.remove('tb-toggle-on');
                    updateMomentaryIndicator(buttonClone, spec, false);
                    // Track momentary button state
                    if (spec.label === 'CODE') {
                        codeButtonPressed = false;
                        invalidateAllMarkers();
                    } else if (spec.label === 'SPEED') {
                        speedButtonPressed = false;
                        invalidateAllMarkers();
                    }
                }
            });

            // Mouseleave: revert momentary toggle if mouse leaves button while held
            buttonClone.addEventListener('mouseleave', (e) => {
                if (spec.type === 'toggle' && spec.isMomentary) {
                    buttonClone.classList.remove('tb-toggle-on');
                    updateMomentaryIndicator(buttonClone, spec, false);
                    // Track momentary button state
                    if (spec.label === 'CODE') {
                        codeButtonPressed = false;
                        invalidateAllMarkers();
                    } else if (spec.label === 'SPEED') {
                        speedButtonPressed = false;
                        invalidateAllMarkers();
                    }
                }
            });

            // Context menu prevention
            buttonClone.addEventListener('contextmenu', (e) => e.preventDefault());
        }

        container.appendChild(buttonClone);
    }

    // Add middle-click handler to delete tearoff when delete mode is active (BEFORE Leaflet event disabling)
    container.addEventListener('mousedown', (e) => {
        if (e.button === 1) {  // middle click
            e.preventDefault();
            e.stopPropagation();
            if (tearoffDeleteMode) {
                // Delete the middle-clicked tearoff plus all selected ones
                selectedTearoffsForDeletion.add(btnKey);

                for (const key of selectedTearoffsForDeletion) {
                    const tearoff = activeTearoffs.get(key);
                    if (tearoff) {
                        tearoff.floatingEl.remove();
                        activeTearoffs.delete(key);
                    }
                }

                selectedTearoffsForDeletion.clear();
                updateTearoffColors();
                // Turn off delete mode after deleting
                tearoffDeleteMode = false;
                refreshAllButtons();
                console.log('Tearoffs deleted');
            }
        }
    });

    // Add to page
    document.body.appendChild(container);

    // Prevent Leaflet from capturing events
    L.DomEvent.disableClickPropagation(container);
    L.DomEvent.disableScrollPropagation(container);

    // Setup dragging via the tearoff strip (use standard setupBoxDrag)
    const tearStrip = container.querySelector('.tb-tear');
    setupBoxDrag(container, tearStrip);

    // Position at the source button's location
    const sourceBtn = sourceEntry?.el;
    if (sourceBtn) {
        const rect = sourceBtn.getBoundingClientRect();
        container.style.left = rect.left + 'px';
        container.style.top = rect.top + 'px';
    } else {
        // Fallback position
        container.style.left = '100px';
        container.style.top = '100px';
    }

    // Start drag mode immediately after creation
    setTimeout(() => {
        const tearStrip = container.querySelector('.tb-tear');
        if (tearStrip && document.elementFromPoint(tearStrip.getBoundingClientRect().left + 5, tearStrip.getBoundingClientRect().top + 5) === tearStrip) {
            // Simulate mousedown on tearoff strip to start dragging
            const event = new MouseEvent('mousedown', {
                bubbles: true,
                cancelable: true,
                clientX: tearStrip.getBoundingClientRect().left + 5,
                clientY: tearStrip.getBoundingClientRect().top + 5,
            });
            tearStrip.dispatchEvent(event);
        }
    }, 0);

    return { container, buttonClone };
}

function setupTearoffDrag(tearEl, spec, btnKey) {
    tearEl.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;

        e.preventDefault();
        e.stopPropagation();

        // Grey tearoff strip (disabled) is non-functional - don't create tearoffs when one already exists
        if (tearEl.dataset.disabled === 'true') {
            return;
        }

        // Create new floating tearoff (only if one doesn't exist)
        if (!activeTearoffs.has(btnKey)) {
            const result = createFloatingTearoff(btnKey, spec);
            activeTearoffs.set(btnKey, { floatingEl: result.container, buttonClone: result.buttonClone });
            updateTearoffColors();

            // Apply current backlight brightness to the new tearoff immediately
            const l = scopeBcklght / 100;
            const backlightFactor = 0.6 + (l * 0.5);
            result.container.style.filter = `brightness(${backlightFactor})`;
        }
    });
}

function updateFloatingMenuButton(clickedEl, spec) {
    // Find which floating menu this button is in (if any)
    const isInToolbarMenu = (subMenuContainerEl && subMenuContainerEl.contains(clickedEl)) ||
                            (subSubMenuContainerEl && subSubMenuContainerEl.contains(clickedEl));
    const floatingMenuEl = clickedEl.closest('.tb-floating-menu');
    const isInFloatingMenu = !!floatingMenuEl;

    // If button was clicked in toolbar menu, update corresponding button in floating menu
    if (isInToolbarMenu) {
        const floatingMenus = document.querySelectorAll('.tb-floating-menu');
        for (const floatingMenu of floatingMenus) {
            const buttons = floatingMenu.querySelectorAll('.tb-btn');
            const clickedRow = clickedEl.closest('.tb-row');
            const rowIndex = Array.from(clickedRow.parentElement.children).indexOf(clickedRow);
            const colIndex = Array.from(clickedRow.children).indexOf(clickedEl);

            // For nested submenus, subtract 1 from rowIndex to account for parent button row in toolbar
            const isNestedSubmenu = subSubMenuContainerEl && subSubMenuContainerEl.contains(clickedEl);
            const adjustedRowIndex = isNestedSubmenu ? Math.max(0, rowIndex - 1) : rowIndex;
            const clickedBtnPosition = adjustedRowIndex * 10 + colIndex;

            if (buttons[clickedBtnPosition]) {
                const correspondingBtn = buttons[clickedBtnPosition];
                if (spec.type === 'toggle' && spec.isOn) {
                    const shouldBeOn = spec.isOn();
                    correspondingBtn.classList.toggle('tb-toggle-on', shouldBeOn);
                } else if (spec.type === 'incdec' && spec.getValue) {
                    const valDiv = correspondingBtn.querySelector('.tb-value');
                    if (valDiv) {
                        valDiv.textContent = spec.formatValue(spec.getValue());
                    }
                }
            }
        }
    }
    // If button was clicked in floating menu, update corresponding button in toolbar menu
    else if (isInFloatingMenu) {
        // Get position of clicked button
        const buttons = floatingMenuEl.querySelectorAll('.tb-btn');
        const clickedBtnIndex = Array.from(buttons).indexOf(clickedEl);

        // Find corresponding toolbar menu container and button
        let toolbarMenuContainer = null;
        if (subMenuContainerEl && subMenuContainerEl.style.display !== 'none') {
            toolbarMenuContainer = subMenuContainerEl;
        } else if (subSubMenuContainerEl && subSubMenuContainerEl.style.display !== 'none') {
            toolbarMenuContainer = subSubMenuContainerEl;
        }

        if (toolbarMenuContainer) {
            const toolbarButtons = toolbarMenuContainer.querySelectorAll('.tb-btn');
            if (toolbarButtons[clickedBtnIndex]) {
                const correspondingBtn = toolbarButtons[clickedBtnIndex];
                if (spec.type === 'toggle' && spec.isOn) {
                    const shouldBeOn = spec.isOn();
                    correspondingBtn.classList.toggle('tb-toggle-on', shouldBeOn);
                } else if (spec.type === 'incdec' && spec.getValue) {
                    const valDiv = correspondingBtn.querySelector('.tb-value');
                    if (valDiv) {
                        valDiv.textContent = spec.formatValue(spec.getValue());
                    }
                }
            }
        }
    }
}

function updateMomentaryIndicator(el, spec, isPressed) {
    const ind = el.querySelector('.tb-momentary-ind');
    if (!ind) return;

    // For momentary buttons, determine color based on whether button is currently pressed
    // When pressed (isPressed=true): button is ON (gray), so show BLACK triangle
    // When not pressed (isPressed=false): button is OFF (black), so show GRAY triangle
    const triangleColor = isPressed ? '#000000' : '#C7C7C7';

    // Set triangle color
    ind.style.color = triangleColor;
}

function createButton(spec, panelId, rowIdx, colIdx) {
    const el = document.createElement('div');
    el.className = 'tb-btn';
    const key = btnKey(panelId, rowIdx, colIdx);
    el.dataset.tbKey = key;

    const isNosim = spec.type === 'nosim' || spec.nosim;

    if (isNosim) el.classList.add('tb-nosim');
    if (spec.cls) el.classList.add(spec.cls);

    // Gold tearoff strip (every button has one, per CRC spec)
    const tear = document.createElement('div');
    tear.className = 'tb-tear';
    el.appendChild(tear);

    // Content area (label + value + indicator)
    const content = document.createElement('div');
    content.className = 'tb-content';

    // Label
    const labelDiv = document.createElement('div');
    labelDiv.className = 'tb-label';
    labelDiv.textContent = spec.label;
    content.appendChild(labelDiv);

    // Value (for incdec)
    let valDiv = null;
    if (spec.type === 'incdec' && spec.getValue) {
        valDiv = document.createElement('div');
        valDiv.className = 'tb-value';
        valDiv.textContent = spec.formatValue(spec.getValue());
        content.appendChild(valDiv);
    }

    // Menu indicator
    if (spec.type === 'menu') {
        const ind = document.createElement('div');
        ind.className = 'tb-menu-ind';
        ind.textContent = '\u25BC';
        content.appendChild(ind);
    }

    // Momentary toggle indicator triangle
    if (spec.type === 'toggle' && spec.isMomentary) {
        const momInd = document.createElement('div');
        momInd.className = 'tb-momentary-ind';
        momInd.textContent = '◀';
        el.appendChild(momInd);
        updateMomentaryIndicator(el, spec, false);
    }

    el.appendChild(content);

    // Toggle state
    if (spec.type === 'toggle' && !isNosim && spec.isOn && spec.isOn()) {
        el.classList.add('tb-toggle-on');
    }

    // Store reference (include valDiv for incdec buttons to avoid query overhead)
    tbElements.set(key, { el, spec, valDiv });

    // Setup tearoff drag for the strip
    setupTearoffDrag(tear, spec, key);

    // Event handling
    if (!isNosim) {
        // Left click
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            // Ignore clicks on the tearoff strip
            if (!e.target.closest('.tb-tear')) {
                // Skip normal toggle for momentary buttons (they only respond to hold, not click)
                if (!(spec.type === 'toggle' && spec.isMomentary)) {
                    // For menu buttons in floating menus, pass the button element as anchor
                    const isInFloatingMenu = el.closest('.tb-floating-menu');
                    const anchorForMenu = (spec.type === 'menu' && isInFloatingMenu) ? el : undefined;
                    handleBtnAction(spec, key, false, anchorForMenu);
                    // Update this button's visual state immediately (for menu buttons and floating menu buttons)
                    if (spec.type === 'toggle' && spec.isOn) {
                        const shouldBeOn = spec.isOn();
                        el.classList.toggle('tb-toggle-on', shouldBeOn);
                        // Also update floating menu button if in a floating menu
                        updateFloatingMenuButton(el, spec);
                    } else if (spec.type === 'incdec' && spec.getValue) {
                        const valDiv = el.querySelector('.tb-value');
                        if (valDiv) {
                            valDiv.textContent = spec.formatValue(spec.getValue());
                        }
                        // Also update floating menu button if in a floating menu
                        updateFloatingMenuButton(el, spec);
                    }
                }
            }
        });

        // Mousedown: handle momentary toggle and middle-click
        el.addEventListener('mousedown', (e) => {
            const isTearoff = e.target.closest('.tb-tear');

            // Momentary toggle: left-click shows "on" state while held
            if (e.button === 0 && !isTearoff && spec.type === 'toggle' && spec.isMomentary) {
                e.preventDefault();
                e.stopPropagation();

                // Check delete mode first (allow marking for deletion)
                if (tearoffDeleteMode) {
                    if (selectedTearoffsForDeletion.has(key)) {
                        selectedTearoffsForDeletion.delete(key);
                        el.classList.remove('tb-delete-selected');
                    } else {
                        selectedTearoffsForDeletion.add(key);
                        el.classList.add('tb-delete-selected');
                    }
                    return;
                }

                el.classList.add('tb-toggle-on');
                updateMomentaryIndicator(el, spec, true);
                // Track momentary button state
                if (spec.label === 'CODE') {
                    codeButtonPressed = true;
                    invalidateAllMarkers();
                } else if (spec.label === 'SPEED') {
                    speedButtonPressed = true;
                    invalidateAllMarkers();
                }
                return;
            }

            // Middle click
            if (e.button === 1) {
                e.preventDefault();
                e.stopPropagation();
                // Ignore middle-clicks on the tearoff strip
                if (!isTearoff) {
                    handleBtnAction(spec, key, true);
                    // Update this button's visual state immediately
                    if (spec.type === 'incdec' && spec.getValue) {
                        const valDiv = el.querySelector('.tb-value');
                        if (valDiv) {
                            valDiv.textContent = spec.formatValue(spec.getValue());
                        }
                        // Also update floating menu button if in a floating menu
                        updateFloatingMenuButton(el, spec);
                    }
                }
            }
        });

        // Mouseup: revert momentary toggle to off state
        el.addEventListener('mouseup', (e) => {
            if (spec.type === 'toggle' && spec.isMomentary) {
                e.stopPropagation();
                el.classList.remove('tb-toggle-on');
                updateMomentaryIndicator(el, spec, false);
                // Track momentary button state
                if (spec.label === 'CODE') {
                    codeButtonPressed = false;
                    invalidateAllMarkers();
                } else if (spec.label === 'SPEED') {
                    speedButtonPressed = false;
                    invalidateAllMarkers();
                }
            }
        });

        // Mouseleave: revert momentary toggle if mouse leaves button while held
        el.addEventListener('mouseleave', (e) => {
            if (spec.type === 'toggle' && spec.isMomentary) {
                el.classList.remove('tb-toggle-on');
                updateMomentaryIndicator(el, spec, false);
                // Track momentary button state
                if (spec.label === 'CODE') {
                    codeButtonPressed = false;
                    invalidateAllMarkers();
                } else if (spec.label === 'SPEED') {
                    speedButtonPressed = false;
                    invalidateAllMarkers();
                }
            }
        });

        // Prevent context menu on right-click
        el.addEventListener('contextmenu', (e) => e.preventDefault());
    } else {
        // nosim: prevent map interaction but no action
        el.addEventListener('click', (e) => e.stopPropagation());
        el.addEventListener('mousedown', (e) => {
            if (e.button === 1) { e.preventDefault(); e.stopPropagation(); }
        });
        el.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    return el;
}

function renderPanel(spec, container) {
    const panel = document.createElement('div');
    panel.className = 'tb-panel';
    panel.dataset.tbPanel = spec.id;

    for (let ri = 0; ri < spec.rows.length; ri++) {
        const row = spec.rows[ri];
        const rowEl = document.createElement('div');
        rowEl.className = 'tb-row';
        for (let ci = 0; ci < row.length; ci++) {
            const btnEl = createButton(row[ci], spec.id, ri, ci);
            rowEl.appendChild(btnEl);
        }
        panel.appendChild(rowEl);
    }

    container.appendChild(panel);
    return panel;
}

function refreshButton(key) {
    const entry = tbElements.get(key);
    if (!entry) return;
    const { el, spec, valDiv } = entry;
    const isNosim = spec.type === 'nosim' || spec.nosim;

    // Update value display (if valDiv exists and getValue is defined)
    if (valDiv && spec.getValue) {
        const newValue = String(spec.formatValue(spec.getValue()));
        valDiv.textContent = newValue;
        // Force browser repaint of the entire button
        if (el && el.offsetHeight) {
            void el.offsetHeight;
        }
    }

    // Update toggle state
    if (spec.type === 'toggle' && !isNosim && spec.isOn) {
        el.classList.toggle('tb-toggle-on', spec.isOn());
        // Update momentary indicator if it's a momentary button (only if not currently pressed)
        if (spec.isMomentary && !el.classList.contains('tb-toggle-on')) {
            updateMomentaryIndicator(el, spec, false);
        }
    }

    // Update menu-open state
    if (spec.type === 'menu') {
        const isOpen = tbState.openMenu === spec.menu || tbState.openSubMenu === spec.menu;
        el.classList.toggle('tb-menu-open', isOpen);
    }

    // Sync floating tearoff button clone if one exists
    const tearoff = activeTearoffs.get(key);
    if (tearoff && tearoff.buttonClone) {
        // Update clone's value display
        const cloneValDiv = tearoff.buttonClone.querySelector('.tb-value');
        if (cloneValDiv && spec.getValue) {
            const newValue = String(spec.formatValue(spec.getValue()));
            cloneValDiv.textContent = newValue;
        }

        // Update clone's toggle state (match original button exactly)
        if (spec.type === 'toggle' && !isNosim && spec.isOn) {
            const shouldBeOn = spec.isOn();
            if (shouldBeOn) {
                tearoff.buttonClone.classList.add('tb-toggle-on');
            } else {
                tearoff.buttonClone.classList.remove('tb-toggle-on');
            }
        }

        // Don't sync menu-open state to floating tearoff buttons — they remain independent
    }

    // Handle DELETE TEAROFF button styling when in delete mode
    if (spec.label && spec.label.includes('DELETE')) {
        if (tearoffDeleteMode) {
            el.classList.add('tb-menu-open');
        } else {
            el.classList.remove('tb-menu-open');
        }
        // Sync to floating tearoff if one exists
        const tearoff = activeTearoffs.get(key);
        if (tearoff && tearoff.buttonClone) {
            if (tearoffDeleteMode) {
                tearoff.buttonClone.classList.add('tb-menu-open');
            } else {
                tearoff.buttonClone.classList.remove('tb-menu-open');
            }
        }
    }
}

function refreshAllButtons() {
    for (const key of tbElements.keys()) {
        refreshButton(key);
    }
}

function refreshAllSubMenus() {
    refreshAllButtons();
}

// ── Sub-menu management ──
// CRC behavior: when a menu opens, the master toolbar disappears and is replaced
// by a new toolbar: [pink parent button] + [sub-menu items extending right]

function cleanupMenuScrolling(containerEl) {
    if (!containerEl) return;
    if (containerEl._wheelHandler) { containerEl.removeEventListener('wheel', containerEl._wheelHandler); delete containerEl._wheelHandler; }
    if (containerEl._dragDown) { containerEl.removeEventListener('mousedown', containerEl._dragDown); window.removeEventListener('mousemove', containerEl._dragMove); window.removeEventListener('mouseup', containerEl._dragUp); delete containerEl._dragDown; delete containerEl._dragMove; delete containerEl._dragUp; }
    containerEl.style.cursor = '';
}

function setupMenuScrolling(containerEl) {
    if (!containerEl) return;
    cleanupMenuScrolling(containerEl);
    // Check if menu needs scrolling
    const menuRect = containerEl.getBoundingClientRect();
    if (menuRect.right > window.innerWidth - 4) {
        containerEl.style.maxWidth = (window.innerWidth - menuRect.left - 4) + 'px';
        containerEl.style.overflowX = 'auto';
        containerEl._wheelHandler = (e) => {
            if (e.deltaY !== 0) { e.preventDefault(); containerEl.scrollLeft += e.deltaY; }
        };
        containerEl.addEventListener('wheel', containerEl._wheelHandler, { passive: false });
        // Drag-to-scroll
        let _dragX = null, _dragScroll = 0;
        containerEl._dragDown = (e) => {
            if (e.button !== 0) return;
            _dragX = e.clientX; _dragScroll = containerEl.scrollLeft;
            containerEl.style.cursor = 'grabbing';
            e.preventDefault();
        };
        containerEl._dragMove = (e) => {
            if (_dragX === null) return;
            containerEl.scrollLeft = _dragScroll - (e.clientX - _dragX);
        };
        containerEl._dragUp = () => {
            _dragX = null; containerEl.style.cursor = 'grab';
        };
        containerEl.style.cursor = 'grab';
        containerEl.addEventListener('mousedown', containerEl._dragDown);
        window.addEventListener('mousemove', containerEl._dragMove);
        window.addEventListener('mouseup', containerEl._dragUp);
    }
}

function closeAllSubMenus() {
    tbState.openMenu = null;
    tbState.openSubMenu = null;
    if (subMenuContainerEl) {
        cleanupMenuScrolling(subMenuContainerEl);
        subMenuContainerEl.innerHTML = ''; subMenuContainerEl.style.display = 'none'; subMenuContainerEl.style.left = ''; subMenuContainerEl.style.top = ''; subMenuContainerEl.style.maxWidth = ''; subMenuContainerEl.style.overflowX = ''; subMenuContainerEl.scrollLeft = 0;
    }
    if (subSubMenuContainerEl) {
        cleanupMenuScrolling(subSubMenuContainerEl);
        subSubMenuContainerEl.innerHTML = ''; subSubMenuContainerEl.style.display = 'none'; subSubMenuContainerEl.style.left = ''; subSubMenuContainerEl.style.top = ''; subSubMenuContainerEl.style.maxWidth = ''; subSubMenuContainerEl.style.overflowX = ''; subSubMenuContainerEl.scrollLeft = 0;
    }
    // Restore all master buttons visibility and remove pink state
    if (masterPanelEl) {
        masterPanelEl.querySelectorAll('.tb-btn').forEach(btn => {
            btn.style.visibility = '';
            btn.classList.remove('tb-menu-open');
        });
    }
    refreshAllButtons();
}

function openFloatingMenu(menuId, anchorEl) {
    const menuSpec = SUB_MENUS[menuId];
    if (!menuSpec) return;

    // Get the button key from the anchor element
    const btnKey = anchorEl.dataset.tbKey;

    // Check if menu already open for this button — close it (toggle)
    if (activeFloatingMenus.has(btnKey)) {
        const existing = activeFloatingMenus.get(btnKey);
        if (existing.floatingMenuEl) {
            existing.floatingMenuEl.remove();
        }
        // Remove menu-open class from the button
        anchorEl.classList.remove('tb-menu-open');
        activeFloatingMenus.delete(btnKey);
        return;
    }

    // Create floating menu container
    const floatingMenu = document.createElement('div');
    floatingMenu.className = 'tb-floating-menu';

    // Check if this is a nested menu (parent menu is already floating)
    const parentFloatingMenu = anchorEl.closest('.tb-floating-menu');
    const isNestedMenu = !!parentFloatingMenu;

    if (isNestedMenu) {
        // Nested menu: position absolutely relative to viewport
        const anchorRect = anchorEl.getBoundingClientRect();
        floatingMenu.style.cssText = `
            position: fixed;
            left: ${anchorRect.right + 4}px;
            top: ${anchorRect.top}px;
            z-index: 972;
            user-select: none;
            background: #0000D4;
            border: 1px solid #FFFFFF;
        `;
    } else {
        // Top-level floating menu: position relative to parent container
        floatingMenu.style.cssText = `
            position: absolute;
            top: 0;
            left: 100%;
            margin-left: 4px;
            z-index: 971;
            user-select: none;
            background: #0000D4;
            border: 1px solid #FFFFFF;
        `;
    }

    // Build menu items into the floating container (don't force 2 rows for floating menus)
    buildSubMenuItems(menuSpec, menuId, floatingMenu, 0, false);

    // Append to the floating tearoff container so it moves with the button (for top-level menus)
    // or to the body (for nested menus that need fixed positioning)
    if (isNestedMenu) {
        document.body.appendChild(floatingMenu);
    } else {
        const floatingTearoff = anchorEl.closest('.tb-floating-tearoff');
        if (floatingTearoff) {
            floatingTearoff.appendChild(floatingMenu);
        } else {
            // Fallback: append to body if not in a floating tearoff (shouldn't happen)
            document.body.appendChild(floatingMenu);
        }
    }

    // Apply current backlight brightness to the floating menu
    const l = scopeBcklght / 100;
    const backlightFactor = 0.6 + (l * 0.5);
    floatingMenu.style.filter = `brightness(${backlightFactor})`;

    // Add menu-open class to the button for visual feedback
    anchorEl.classList.add('tb-menu-open');

    // Store in active menus map
    activeFloatingMenus.set(btnKey, { floatingMenuEl: floatingMenu, anchorEl: anchorEl });

    // Prevent Leaflet from capturing events
    L.DomEvent.disableClickPropagation(floatingMenu);
    L.DomEvent.disableScrollPropagation(floatingMenu);

    // Close menu when clicking outside (but not on the anchor button itself, toolbar buttons, or inside toolbar menus)
    const closeHandler = (e) => {
        // Check if click is on a toolbar menu button or inside a toolbar menu container
        const clickedBtn = e.target.closest('.tb-btn');
        const isToolbarBtn = clickedBtn && tbElements.has(clickedBtn.dataset.tbKey);
        const isInsideToolbarMenu = (subMenuContainerEl && subMenuContainerEl.contains(e.target)) ||
                                     (subSubMenuContainerEl && subSubMenuContainerEl.contains(e.target));

        if (!floatingMenu.contains(e.target) && !anchorEl.contains(e.target) && !isToolbarBtn && !isInsideToolbarMenu) {
            floatingMenu.remove();
            anchorEl.classList.remove('tb-menu-open');
            activeFloatingMenus.delete(btnKey);
            document.removeEventListener('mousedown', closeHandler);
        }
    };
    document.addEventListener('mousedown', closeHandler);

    // Close menu when an item is clicked
    floatingMenu.addEventListener('click', (e) => {
        if (e.target.closest('.tb-btn')) {
            setTimeout(() => {
                floatingMenu.remove();
                anchorEl.classList.remove('tb-menu-open');
                activeFloatingMenus.delete(btnKey);
            }, 10);
            document.removeEventListener('mousedown', closeHandler);
        }
    });
}

function openSubMenu(menuId, anchorEl) {
    const menuSpec = SUB_MENUS[menuId];
    if (!menuSpec) return;

    if (menuSpec.parentMenu) {
        // Nested sub-menu (e.g. weather under atc-tools, map-bright under bright)
        if (tbState.openSubMenu === menuId) {
            tbState.openSubMenu = null;
            if (subSubMenuContainerEl) {
                cleanupMenuScrolling(subSubMenuContainerEl);
                subSubMenuContainerEl.innerHTML = ''; subSubMenuContainerEl.style.display = 'none';
                subSubMenuContainerEl.style.maxWidth = ''; subSubMenuContainerEl.style.overflowX = ''; subSubMenuContainerEl.scrollLeft = 0;
            }
            refreshAllButtons();
            return;
        }
        tbState.openSubMenu = menuId;
        if (subSubMenuContainerEl) {
            cleanupMenuScrolling(subSubMenuContainerEl);
            subSubMenuContainerEl.innerHTML = '';
            subSubMenuContainerEl.style.display = 'block';
            subSubMenuContainerEl.style.maxWidth = '';
            subSubMenuContainerEl.style.overflowX = '';
            subSubMenuContainerEl.scrollLeft = 0;
            // Position at nested button's left edge within masterGrid
            const gridRect = subSubMenuContainerEl.parentElement.getBoundingClientRect();
            const anchorRect = anchorEl.getBoundingClientRect();
            subSubMenuContainerEl.style.left = (anchorRect.left - gridRect.left) + 'px';
            subSubMenuContainerEl.style.top = '0';
            buildInlineSubMenu(menuSpec, menuId, subSubMenuContainerEl);
            // Setup scrolling for nested submenu (was missing before)
            setupMenuScrolling(subSubMenuContainerEl);
        }
        refreshAllButtons();
        return;
    }

    // Top-level sub-menu
    if (tbState.openMenu === menuId) {
        closeAllSubMenus();
        return;
    }

    // Open new menu: keep clicked button in place (turn pink), hide others,
    // sub-menu items extend to the right of the clicked button.
    tbState.openMenu = menuId;
    tbState.openSubMenu = null;
    if (subSubMenuContainerEl) {
        cleanupMenuScrolling(subSubMenuContainerEl);
        subSubMenuContainerEl.innerHTML = ''; subSubMenuContainerEl.style.display = 'none'; subSubMenuContainerEl.style.left = '';
    }

    // Hide all master buttons except the clicked one (it stays in place, turns pink)
    masterPanelEl.querySelectorAll('.tb-btn').forEach(btn => {
        if (btn === anchorEl) {
            btn.classList.add('tb-menu-open');
        } else {
            btn.style.visibility = 'hidden';
        }
    });

    if (subMenuContainerEl) {
        subMenuContainerEl.innerHTML = '';
        subMenuContainerEl.style.display = 'block';
        const desiredLeft = anchorEl.offsetLeft + anchorEl.offsetWidth;
        subMenuContainerEl.style.left = desiredLeft + 'px';
        subMenuContainerEl.style.top = '0';
        const anchorRow = anchorEl.closest('.tb-row');
        const parentRowIdx = anchorRow ? Array.from(anchorRow.parentElement.children).indexOf(anchorRow) : 0;
        buildSubMenuItems(menuSpec, menuId, subMenuContainerEl, parentRowIdx);
        // Setup scrolling for top-level submenu
        setupMenuScrolling(subMenuContainerEl);
    }
    refreshAllButtons();
}

// Menu label lookup (maps menu ID → display label for the pink parent button)
const MENU_LABELS = {
    'atc-tools': 'ATC\nTOOLS', 'weather': 'WX', 'views': 'VIEWS',
    'check-lists': 'CHECK\nLISTS', 'cursor': 'CURSOR', 'geomap': 'MAP',
    'bright': 'BRIGHT', 'map-bright': 'MAP\nBRIGHT', 'font': 'FONT',
    'db-fields': 'DB\nFIELDS', 'radar-filter': 'RADAR\nFILTER',
};

// Build sub-menu items only (no parent button — the real one stays in the master panel).
// parentRow = which visual row the parent is on. Data row 0 goes on parentRow, row 1 on parentRow+1, etc.
// forceMinRows = if true, render at least 2 rows (for toolbar); if false, render only needed rows (for floating menus)
function buildSubMenuItems(menuSpec, menuId, container, parentRow, forceMinRows = true) {
    if (parentRow === undefined) parentRow = 0;
    // For toolbar menus, always render at least 2 rows. For floating menus, render only what's needed.
    const totalRows = forceMinRows ? Math.max(2, menuSpec.rows.length) : menuSpec.rows.length;

    for (let vi = 0; vi < totalRows; vi++) {
        const rowEl = document.createElement('div');
        rowEl.className = 'tb-row';
        rowEl.style.height = '34px';

        if (vi < menuSpec.rows.length) {
            const rowData = menuSpec.rows[vi];
            for (let ci = 0; ci < rowData.length; ci++) {
                rowEl.appendChild(createButton(rowData[ci], menuSpec.id, vi, ci));
            }
        }

        container.appendChild(rowEl);
    }
}

// Legacy wrapper for nested sub-menus (still creates a pink parent button)
function buildInlineSubMenu(menuSpec, menuId, container, parentRow) {
    if (parentRow === undefined) parentRow = 0;
    const totalRows = Math.max(2, menuSpec.rows.length);

    for (let ri = 0; ri < totalRows; ri++) {
        const rowEl = document.createElement('div');
        rowEl.className = 'tb-row';
        rowEl.style.height = '34px';

        if (ri === 0) {
            const parentLabel = MENU_LABELS[menuId] || menuId.toUpperCase();
            const parentSpec = { label: parentLabel, type: 'menu', menu: menuId, cls: 'tb-tan' };
            const parentBtn = createButton(parentSpec, menuSpec.id + '-parent', 0, 0);
            parentBtn.classList.add('tb-menu-open');
            rowEl.appendChild(parentBtn);
        }

        const rowData = menuSpec.rows[ri];
        if (rowData) {
            for (let ci = 0; ci < rowData.length; ci++) {
                rowEl.appendChild(createButton(rowData[ci], menuSpec.id, ri, ci));
            }
        }
        container.appendChild(rowEl);
    }
}

function handleBtnAction(spec, key, isMiddle, anchorEl) {
    if (spec.type === 'menu') {
        // If anchorEl is provided (from floating tearoff), create a floating menu
        if (anchorEl && anchorEl.closest('.tb-floating-tearoff')) {
            openFloatingMenu(spec.menu, anchorEl);
        } else if (anchorEl && anchorEl.closest('.tb-floating-menu')) {
            // Menu button clicked in a floating menu - open nested menu as floating
            openFloatingMenu(spec.menu, anchorEl);
        } else {
            // Otherwise, use toolbar menu system
            const anchor = anchorEl || tbElements.get(key)?.el;
            if (anchor) openSubMenu(spec.menu, anchor);
        }
    } else if (spec.type === 'toggle') {
        if (spec.isOn && spec.onToggle) {
            spec.onToggle(!spec.isOn());
        }
        refreshAllButtons();
    } else if (spec.type === 'incdec') {
        if (isMiddle) {
            if (spec.onInc) spec.onInc();
        } else {
            if (spec.onDec) spec.onDec();
        }
        refreshButton(key);
        refreshAllButtons();
    } else if (spec.type === 'cmd') {
        if (spec.onCmd) spec.onCmd();
    }
}

// ════════════════════════════════════════════════════════════════════════════
// Build the toolbar DOM
// ════════════════════════════════════════════════════════════════════════════

function buildToolbar() {
    const tearoffContainer = document.getElementById('tb-tearoff');
    const masterContainer = document.getElementById('master-toolbar-container');

    // ── Tearoff button ──
    const tearoffBtn = document.createElement('div');
    tearoffBtn.id = 'tb-tearoff-btn';
    const goldStrip = document.createElement('div');
    goldStrip.className = 'tb-gold-strip';
    const tearLabel = document.createElement('div');
    tearLabel.className = 'tb-tearoff-label';
    tearLabel.textContent = 'TOOLBAR';
    tearoffBtn.appendChild(goldStrip);
    tearoffBtn.appendChild(tearLabel);
    tearoffContainer.appendChild(tearoffBtn);

    L.DomEvent.disableClickPropagation(tearoffContainer);
    L.DomEvent.disableScrollPropagation(tearoffContainer);

    // Gold strip = reposition; label area = toggle toolbar
    setupBoxDrag(tearoffContainer, goldStrip);

    tearLabel.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleMasterToolbar();
    });
    tearLabel.addEventListener('mousedown', (e) => {
        if (e.button === 1) {
            e.preventDefault();
            e.stopPropagation();
            toggleMasterToolbar();
        }
    });
    tearoffBtn.addEventListener('contextmenu', (e) => e.preventDefault());

    // ── Master toolbar container (fixed at top, not draggable) ──
    // Layout: [left grey bar + arrow] [button grid] [right grey bar]
    const masterRow = document.createElement('div');
    masterRow.className = 'tb-master-row';

    // Left grey bar with down arrow (toggles sidebar below toolbar)
    const leftBar = document.createElement('div');
    leftBar.className = 'tb-side-bar';
    const arrowBtn = document.createElement('div');
    arrowBtn.className = 'tb-arrow-btn';
    arrowBtn.innerHTML = '<svg viewBox="0 0 10 18"><line x1="5" y1="2" x2="5" y2="14" stroke="#fff" stroke-width="1.5"/><polygon points="1,11 5,17 9,11" fill="#fff"/></svg>';
    arrowBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const sidebar = document.getElementById('sidebar');
        if (sidebar) sidebar.classList.toggle('collapsed');
    });
    arrowBtn.addEventListener('mousedown', (e) => {
        if (e.button === 1) { e.preventDefault(); e.stopPropagation(); }
    });
    leftBar.appendChild(arrowBtn);
    masterRow.appendChild(leftBar);

    // Button grid — master panel + sub-menus live here (same vertical position)
    const masterGrid = document.createElement('div');
    masterGrid.className = 'tb-master-grid';
    masterPanelEl = renderPanel(TB_MASTER, masterGrid);

    // Sub-menu container (replaces master panel in-place when menu is open)
    subMenuContainerEl = document.createElement('div');
    subMenuContainerEl.className = 'tb-submenu';
    subMenuContainerEl.style.display = 'none';
    masterGrid.appendChild(subMenuContainerEl);

    // Sub-sub-menu container (for nested menus like weather)
    subSubMenuContainerEl = document.createElement('div');
    subSubMenuContainerEl.className = 'tb-submenu';
    subSubMenuContainerEl.style.display = 'none';
    masterGrid.appendChild(subSubMenuContainerEl);

    masterRow.appendChild(masterGrid);

    // Right grey bar (extends to window edge)
    const rightBar = document.createElement('div');
    rightBar.className = 'tb-side-bar tb-right';
    masterRow.appendChild(rightBar);

    masterContainer.appendChild(masterRow);

    // Prevent map interactions
    L.DomEvent.disableClickPropagation(masterContainer);
    L.DomEvent.disableScrollPropagation(masterContainer);

    // Update RANGE display when map zooms
    map.on('zoomend', () => {
        refreshAllButtons();
    });
}

function toggleMasterToolbar() {
    tbState.masterVisible = !tbState.masterVisible;
    const container = document.getElementById('master-toolbar-container');
    container.classList.toggle('tb-visible', tbState.masterVisible);
    document.getElementById('tb-tearoff-btn').classList.toggle('tb-active', tbState.masterVisible);
    document.body.classList.toggle('tb-active', tbState.masterVisible);

    if (!tbState.masterVisible) {
        closeAllSubMenus();
    } else {
        refreshAllButtons();
    }
    window._tbVisible = tbState.masterVisible;
    saveSettingsToLocalStorage();
}

// ── URL persistence for toolbar visibility ──
// Default to on; tb=0 in URL to hide
const _tbInitParams = new URLSearchParams(window.location.hash.slice(1));
if (_tbInitParams.get('tb') !== '0') {
    tbState.masterVisible = true;
    window._tbVisible = true;
}

// ── Initialize ──
buildToolbar();
refreshAllButtons();  // Refresh button displays to show correct initial values
updateTearoffColors();  // Initialize tearoff strip colors
updateBorderBrightness();  // Initialize border brightness
updateToolbarBackgroundBrightness();  // Initialize toolbar background brightness
updateTextBrightness();  // Initialize text brightness
updateFdbBrightness();  // Initialize FDB brightness
updateLdbBrightness();  // Initialize LDB brightness
updateOnFreqBrightness();  // Initialize ON-FREQ brightness
updatePrTgtBrightness();  // Initialize PR TGT brightness
updatePrHistBrightness();  // Initialize PR HIST brightness
updateUnpTgtBrightness();  // Initialize UNP TGT brightness
updateUnpHistBrightness();  // Initialize UNP HIST brightness
updateToolbarBorderColor();  // Initialize toolbar border color
updateCursorBrightness();  // Initialize cursor brightness

// Apply initial visibility from URL
if (tbState.masterVisible) {
    document.getElementById('master-toolbar-container').classList.add('tb-visible');
    document.body.classList.add('tb-active');
    document.getElementById('tb-tearoff-btn').classList.add('tb-active');
}

})();  // end toolbar IIFE

// ════════════════════════════════════════════════════════════════════════════
// Replay system
// ════════════════════════════════════════════════════════════════════════════
(function() {

const replaySection = document.getElementById('replay-section');
const replayToggleBtn = document.getElementById('replay-toggle-btn');
const replayGoBtn = document.getElementById('replay-go');
const replayStartInput = document.getElementById('replay-start');
const replayBar = document.getElementById('replay-bar');
const replayPauseBtn = document.getElementById('replay-pause');
const replaySpeedSel = document.getElementById('replay-speed');
const replayTimeEl = document.getElementById('replay-time');
const replayStatusEl = document.getElementById('replay-status');
const replayStopBtn = document.getElementById('replay-stop');
const replayRangeEl = document.getElementById('replay-range');

let replayWs = null;
let replayPaused = false;
let replayPendingFlights = new Map(); // gufi → latest flight object (merged across batches)
let replayPendingRemoves = []; // gufi list
let replayRafId = null;
let _vpTimer = null;

// Current map bounds expanded by a 50% buffer, as the server's viewport filter expects.
// The buffer keeps edge tracks (and their leaders/vectors) present and absorbs small pans.
function paddedBounds() {
    const b = map.getBounds().pad(0.5);
    return {
        minLat: b.getSouth(), minLon: b.getWest(),
        maxLat: b.getNorth(), maxLon: b.getEast()
    };
}

// Push the current viewport to the replay server (it responds with a region snapshot).
function sendViewport() {
    if (!replayActive || !replayWs || replayWs.readyState !== WebSocket.OPEN) return;
    replayWs.send(JSON.stringify(Object.assign({ cmd: 'viewport' }, paddedBounds())));
}

// Debounce viewport updates so a drag/zoom only sends once it settles.
function scheduleViewport() {
    if (!replayActive) return;
    if (_vpTimer) clearTimeout(_vpTimer);
    _vpTimer = setTimeout(sendViewport, 300);
}
map.on('moveend zoomend', scheduleViewport);

function replayFlush() {
    replayRafId = null;
    // Apply pending removes
    for (const gufi of replayPendingRemoves) {
        replayPendingFlights.delete(gufi);
        flights.delete(gufi);
        flightHistory.delete(gufi);
        const m = markers.get(gufi);
        if (m) { map.removeLayer(m); markers.delete(gufi); }
    }
    replayPendingRemoves = [];
    // Apply merged flights — each gufi processed exactly once with its latest state
    if (replayPendingFlights.size > 0) {
        for (const [, f] of replayPendingFlights) {
            processFlightUpdate(f);
        }
        replayStatusEl.textContent = `Playing — ${flights.size} flights`;
        replayPendingFlights.clear();
    }
}

// Toggle replay section visibility
replayToggleBtn.addEventListener('click', () => {
    const vis = replaySection.style.display === 'none';
    replaySection.style.display = vis ? '' : 'none';
    replayToggleBtn.style.color = vis ? '#cccc44' : '';
    if (vis) fetchReplayRange();
});

// Fetch available replay range
async function fetchReplayRange() {
    try {
        const resp = await fetch('/api/replay/range');
        const data = await resp.json();
        if (data.eram) {
            const s = new Date(data.eram.start);
            const e = new Date(data.eram.end);
            replayRangeEl.textContent = `Available: ${fmtDt(s)} — ${fmtDt(e)} (${data.eram.hours}h, ${data.eram.totalSizeMB.toFixed(1)} MB)`;
            // Default start input to 1 hour ago, in Zulu (24-hour, UTC).
            replayStartInput.value = fmtZuluInput(new Date(Date.now() - 3600000));
        } else {
            replayRangeEl.textContent = 'No replay data yet (recording...)';
        }
    } catch(e) {
        replayRangeEl.textContent = 'Error fetching replay range';
    }
}

// All replay times are Zulu (UTC), 24-hour clock — no local time, no AM/PM.
function fmtDt(d) {
    return d.toISOString().replace('T', ' ').slice(0, 16) + 'Z';
}

// Format a Date as the Zulu text the start input expects: "YYYY-MM-DD HH:MM:SS".
function fmtZuluInput(d) {
    return d.toISOString().replace('T', ' ').slice(0, 19);
}

// Parse a Zulu start-time string entered by the user. Accepts "YYYY-MM-DD HH:MM[:SS]"
// (space or T separator, optional trailing Z), and ALWAYS interprets it as UTC.
function parseZulu(s) {
    if (!s) return null;
    s = s.trim().replace(/\s*[zZ]$/, '').replace(' ', 'T');
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) return null;
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}Z`);
    return isNaN(d.getTime()) ? null : d;
}

// Start replay
replayGoBtn.addEventListener('click', () => {
    const d = parseZulu(replayStartInput.value);
    if (!d) {
        replayRangeEl.textContent = 'Enter Zulu start time as YYYY-MM-DD HH:MM:SS';
        replayRangeEl.style.color = '#ff8c00';
        return;
    }
    replayRangeEl.style.color = '';
    startReplay(d.toISOString());
});

function startReplay(startTime) {
    // Close any existing replay connection first
    if (replayWs) { replayWs.onclose = null; replayWs.close(); replayWs = null; }
    // Disconnect live WS
    if (_ws) { _ws.onclose = null; _ws.close(); _ws = null; }
    wsConnected = false;

    // Clear current state
    for (const [, m] of markers) map.removeLayer(m);
    markers.clear();
    flights.clear();
    flightHistory.clear();

    replayActive = true;
    replayPaused = false;
    replayPauseBtn.textContent = '\u23F8'; // pause icon
    replayBar.style.display = '';
    replayStatusEl.textContent = 'Connecting...';

    document.getElementById('connection-status').textContent = 'REPLAY';
    document.getElementById('connection-status').style.color = '#ff8c00';

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const speed = replaySpeedSel.value || '1';
    // Viewport filtering: stream only tracks within the visible area (+ buffer) so the
    // client isn't parsing/processing thousands of off-screen NAS tracks. Bounds are sent
    // at connect (URL) and on every pan/zoom (viewport command); the server re-snapshots
    // the new region so panning never reveals blank areas.
    const vp = paddedBounds();
    const vpQuery = `&minLat=${vp.minLat}&minLon=${vp.minLon}&maxLat=${vp.maxLat}&maxLon=${vp.maxLon}`;
    replayWs = new WebSocket(`${proto}//${location.host}/replay/ws?start=${encodeURIComponent(startTime)}&speed=${speed}${vpQuery}`);

    replayWs.onopen = () => {
        replayStatusEl.textContent = 'Loading...';
    };

    replayWs.onclose = () => {
        if (replayActive) {
            replayStatusEl.textContent = 'Disconnected';
        }
    };

    replayWs.onmessage = (evt) => {
        const msg = JSON.parse(evt.data);

        // Update replay time display + URL
        if (msg.replayTime) {
            replayCurrentTime = msg.replayTime;
            const t = new Date(msg.replayTime);
            replayTimeEl.textContent = t.toISOString().replace('T', ' ').slice(0, 19) + 'Z';
            replayThrottleSave();
        }

        if (msg.type === 'snapshot') {
            for (const [, m] of markers) map.removeLayer(m);
            markers.clear();
            flights.clear();
            flightHistory.clear();
            for (const f of msg.data) {
                f._clientLastUpdate = performance.now();
                if (f.assignedAltitude != null && f.reportedAltitude != null) {
                    const aAlt = Math.round(f.assignedAltitude / 100);
                    const rAlt = Math.round(f.reportedAltitude / 100);
                    const d = rAlt - aAlt;
                    f._altInitialSide = Math.abs(d) <= 2 ? 0 : (d < 0 ? -1 : 1);
                }
                flights.set(f.gufi, f);
                trackFacility(f);
                if (f.clearanceHeading || f.clearanceSpeed || f.clearanceText) {
                    hsfShowMap.add(f.gufi);
                }
            }
            replayStatusEl.textContent = `Playing — ${flights.size} flights`;
        } else if (msg.type === 'batch') {
            // Merge into pending map — latest update per gufi wins
            for (const f of msg.data) {
                if (f.gufi) replayPendingFlights.set(f.gufi, f);
            }
            if (!replayRafId) replayRafId = requestAnimationFrame(replayFlush);
        } else if (msg.type === 'remove') {
            replayPendingRemoves.push(msg.data.gufi);
            if (!replayRafId) replayRafId = requestAnimationFrame(replayFlush);
        } else if (msg.type === 'replay_start') {
            replayStatusEl.textContent = 'Seeking...';
        } else if (msg.type === 'replay_seek') {
            // Clear state on seek
            for (const [, m] of markers) map.removeLayer(m);
            markers.clear();
            flights.clear();
            flightHistory.clear();
            replayStatusEl.textContent = 'Seeking...';
        } else if (msg.type === 'replay_gap') {
            replayStatusEl.textContent = `Gap: ${msg.from?.slice(11,19) || ''} — ${msg.to?.slice(11,19) || ''}`;
        } else if (msg.type === 'replay_end') {
            replayStatusEl.textContent = 'End of replay data';
        } else if (msg.type === 'replay_error') {
            replayStatusEl.textContent = msg.message || 'Error';
        }
    };
}

// Pause/resume
replayPauseBtn.addEventListener('click', () => {
    if (!replayWs || replayWs.readyState !== WebSocket.OPEN) return;
    replayPaused = !replayPaused;
    replayWs.send(JSON.stringify({ cmd: replayPaused ? 'pause' : 'resume' }));
    replayPauseBtn.textContent = replayPaused ? '\u25B6' : '\u23F8';
    replayStatusEl.textContent = replayPaused ? 'Paused' : `Playing — ${flights.size} flights`;
});

// Speed change
replaySpeedSel.addEventListener('change', () => {
    if (!replayWs || replayWs.readyState !== WebSocket.OPEN) return;
    replayWs.send(JSON.stringify({ cmd: 'speed', value: parseFloat(replaySpeedSel.value) }));
});

// Stop replay → back to live
replayStopBtn.addEventListener('click', stopReplay);

function stopReplay() {
    replayActive = false;
    replayCurrentTime = null;
    replayPendingFlights.clear();
    replayPendingRemoves = [];
    if (replayRafId) { cancelAnimationFrame(replayRafId); replayRafId = null; }
    if (replayWs) { replayWs.onclose = null; replayWs.close(); replayWs = null; }
    replayBar.style.display = 'none';
    replayStatusEl.textContent = '';
    replayTimeEl.textContent = '';
    saveSettingsToLocalStorage();

    // Reconnect to live
    connectWs();
}

// Throttled URL save during replay (every 3 seconds)
let _replaySaveTimer = null;
function replayThrottleSave() {
    if (_replaySaveTimer) return;
    _replaySaveTimer = setTimeout(() => {
        _replaySaveTimer = null;
        saveSettingsToLocalStorage();
    }, 3000);
}

// Auto-start replay from URL params
{
    const initParams = new URLSearchParams(window.location.hash.slice(1));
    const replayParam = initParams.get('replay');
    if (replayParam) {
        const rspd = initParams.get('rspd');
        if (rspd) replaySpeedSel.value = rspd;
        replaySection.style.display = '';
        replayToggleBtn.style.color = '#cccc44';
        // Delay slightly to let the live WS connect first, then override
        setTimeout(() => startReplay(replayParam), 500);
    }
}

})();  // end replay IIFE
