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


// ── Operator view toggle (private, unlabeled) ───────────────────────────────
// When signed in, the build/updated footer turns green and a small "exit" chip
// shows. To sign in: 5 clicks/taps within 4s in the very BOTTOM-RIGHT CORNER of
// the window (coordinate-based, so it works on every page and over any content),
// or 5 on the page footer → the browser's native sign-in. Nothing is labeled.
(function () {
    function hasCookie(n) {
        return document.cookie.split('; ').some(function (r) { return r.indexOf(n + '=') === 0; });
    }
    var signedIn = hasCookie('sv');

    var css = document.createElement('style');
    css.textContent =
        '#op-badge{position:fixed;left:8px;bottom:6px;z-index:2147483000;font-family:ui-monospace,Consolas,monospace;' +
        'font-size:11px;color:#e0b050;background:rgba(0,0,0,.7);border:1px solid #5a4a14;border-radius:3px;' +
        'padding:4px 9px;cursor:pointer;letter-spacing:.5px;-webkit-tap-highlight-color:transparent}' +
        // Signed-in indicator: the build/updated footer goes green (from its default grey).
        '.op-signed #buildFooter{color:#5ed05e!important}';
    (document.head || document.documentElement).appendChild(css);

    if (signedIn) {
        document.documentElement.classList.add('op-signed');
        var mkBadge = function () {
            if (!document.body || document.getElementById('op-badge')) return;
            var badge = document.createElement('div');
            badge.id = 'op-badge';
            badge.textContent = '\u25CF exit';
            badge.addEventListener('click', function () {
                fetch('/api/logout', { method: 'POST' }).then(function () { location.reload(); });
            });
            document.body.appendChild(badge);
        };
        if (document.body) mkBadge(); else document.addEventListener('DOMContentLoaded', mkBadge);
    }

    // 5 hits within 4s → native browser sign-in for this page.
    var taps = [];
    function hit() {
        if (signedIn) return;
        var now = Date.now();
        taps.push(now);
        taps = taps.filter(function (t) { return now - t <= 4000; });
        if (taps.length >= 5) {
            taps = [];
            location.href = '/api/login?r=' + encodeURIComponent(location.pathname + location.search);
        }
    }

    // Primary trigger: bottom-right corner, by coordinates, on the capture phase so it
    // fires no matter what element is there or whether it stops propagation.
    document.addEventListener('click', function (e) {
        if (e.clientX >= window.innerWidth - 64 && e.clientY >= window.innerHeight - 64) hit();
    }, true);

    // Secondary: the page footer, when a page has one.
    var attachFooter = function () {
        var f = document.querySelector('footer');
        if (f) f.addEventListener('click', hit, true);
    };
    if (document.body) attachFooter(); else document.addEventListener('DOMContentLoaded', attachFooter);
})();
