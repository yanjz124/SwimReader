/* Shared menu-page frame. Two jobs:
 *   1) Universal font-size (UI scale) control in the header — persisted across
 *      pages via localStorage, applied with document zoom so it scales the
 *      px-based layouts these pages use. Excluded on the radar simulators
 *      (they have their own font controls and don't load this frame).
 *   2) An "up one level" link next to HOME on nested pages (e.g. /tais/RDU →
 *      ↑ TAIS, in addition to ← HOME). Top-level directory pages keep just HOME.
 * Pairs with frame.css. */
(function () {
    // ── Universal font-size / UI scale ──────────────────────────────────────
    const SCALE_KEY = 'uiScale';
    const MIN = 0.8, MAX = 1.6, STEP = 0.1;
    let scale = parseFloat(localStorage.getItem(SCALE_KEY)) || 1;
    let fsLbl = null;
    function applyScale() {
        scale = Math.min(MAX, Math.max(MIN, Math.round(scale * 10) / 10));
        // zoom scales the whole UI (fonts + layout) uniformly — works even though
        // these pages size text in px. Empty string clears it at 100%.
        document.documentElement.style.zoom = scale === 1 ? '' : String(scale);
        try { localStorage.setItem(SCALE_KEY, String(scale)); } catch (e) {}
        if (fsLbl) fsLbl.textContent = Math.round(scale * 100) + '%';
    }
    applyScale();   // apply the saved scale as early as possible

    // Build the A− / % / A+ control and drop it at the right end of the header.
    const bar = document.querySelector('header, .topbar');
    if (bar) {
        const fs = document.createElement('div');
        fs.className = 'nav-fontsize';
        const mk = (txt, title, cls) => {
            const b = document.createElement('button');
            b.type = 'button'; b.className = 'fs-btn' + (cls ? ' ' + cls : '');
            b.textContent = txt; b.title = title;
            return b;
        };
        const dn = mk('A−', 'Smaller text');
        const lb = mk('100%', 'Reset text size', 'fs-lbl');
        const up = mk('A+', 'Larger text');
        fsLbl = lb;
        dn.addEventListener('click', function () { scale -= STEP; applyScale(); });
        up.addEventListener('click', function () { scale += STEP; applyScale(); });
        lb.addEventListener('click', function () { scale = 1; applyScale(); });
        fs.appendChild(dn); fs.appendChild(lb); fs.appendChild(up);
        bar.appendChild(fs);
        applyScale();   // now that fsLbl exists, set the % label
    }

    // ── HOME + up-one-level breadcrumb cluster ──────────────────────────────
    const home = document.querySelector('.nav-home');
    if (!home) return;

    const segs = location.pathname.replace(/\/+$/, '').split('/').filter(Boolean);

    // Cluster HOME (and, when nested, an UP link) so they never overlap.
    const cluster = document.createElement('div');
    cluster.className = 'nav-cluster';
    home.parentNode.insertBefore(cluster, home);
    cluster.appendChild(home);

    if (segs.length >= 2) {
        const up = document.createElement('a');
        up.className = 'nav-up';
        up.href = '/' + segs.slice(0, -1).join('/');
        up.innerHTML = '&uarr; ' + decodeURIComponent(segs[segs.length - 2]).toUpperCase();
        cluster.appendChild(up);
        document.body.classList.add('has-up');
    }
})();


// ── Operator view toggle (private) ──────────────────────────────────────────
// Deliberately unlabeled: a 5-tap gesture on the footer (or the bottom-right hotspot
// on footer-less pages) navigates to the browser's own native sign-in. Nothing on
// screen says what it is for. Works with mouse and touch (click fires on tap).
(function () {
    function hasCookie(n) {
        return document.cookie.split('; ').some(function (r) { return r.indexOf(n + '=') === 0; });
    }
    var signedIn = hasCookie('sv');

    var css = document.createElement('style');
    css.textContent =
        '#op-hot{position:fixed;right:0;bottom:0;width:34px;height:34px;z-index:99998;' +
        'background:transparent;-webkit-tap-highlight-color:transparent;user-select:none;-webkit-user-select:none;touch-action:manipulation}' +
        '#op-badge{position:fixed;left:8px;bottom:6px;z-index:99998;font-family:ui-monospace,Consolas,monospace;' +
        'font-size:11px;color:#e0b050;background:rgba(0,0,0,.7);border:1px solid #5a4a14;border-radius:3px;' +
        'padding:4px 9px;cursor:pointer;letter-spacing:.5px;-webkit-tap-highlight-color:transparent}' +
        // Signed-in indicator: the build/updated footer goes green (from its default grey).
        '.op-signed #buildFooter{color:#5ed05e!important}';
    document.head.appendChild(css);

    // When signed in, a small unlabeled "exit" chip returns to the normal view.
    if (signedIn) {
        document.documentElement.classList.add('op-signed');
        var badge = document.createElement('div');
        badge.id = 'op-badge';
        badge.textContent = '● exit';
        badge.addEventListener('click', function () {
            fetch('/api/logout', { method: 'POST' }).then(function () { location.reload(); });
        });
        document.body.appendChild(badge);
    }

    // 5 taps within 5 s → native browser sign-in for this page.
    var taps = [];
    function tap(e) {
        if (e) e.preventDefault();
        var now = Date.now();
        taps.push(now);
        taps = taps.filter(function (t) { return now - t <= 5000; });
        if (taps.length >= 5) {
            taps = [];
            if (signedIn) return;
            location.href = '/api/login?r=' + encodeURIComponent(location.pathname + location.search);
        }
    }
    var footer = document.querySelector('footer');
    if (footer) footer.addEventListener('click', tap);
    var hot = document.createElement('div');
    hot.id = 'op-hot';
    hot.addEventListener('click', tap);
    document.body.appendChild(hot);
})();
