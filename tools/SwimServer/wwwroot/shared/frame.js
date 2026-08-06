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

// ── LADD reveal — secret operator un-mask gesture ───────────────────────────
// Click the page footer (or the bottom-right hotspot on footer-less pages) 5×
// within 5 seconds to open a private login. On success the server un-masks LADD
// aircraft for this browser (via an HttpOnly cookie, so the key is never in JS).
// Purely additive: does nothing visible unless the gesture is performed.
(function () {
    function cookie(n) {
        return document.cookie.split('; ').find(r => r.indexOf(n + '=') === 0);
    }
    var revealed = !!cookie('laddRevealed');

    var css = document.createElement('style');
    css.textContent = [
        '#ladd-hot{position:fixed;right:0;bottom:0;width:22px;height:22px;z-index:99998;cursor:default}',
        '#ladd-modal{position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.8);display:none;align-items:center;justify-content:center;font-family:ui-monospace,Consolas,monospace}',
        '#ladd-modal.on{display:flex}',
        '#ladd-box{background:#0c0c0c;border:1px solid #3a3a14;border-radius:6px;padding:20px 22px;width:280px;color:#cccc44}',
        '#ladd-box h3{margin:0 0 4px;font-size:13px;letter-spacing:1px}',
        '#ladd-box p{margin:0 0 14px;color:#888835;font-size:11px}',
        '#ladd-box input{width:100%;box-sizing:border-box;background:#000;border:1px solid #3a3a14;color:#eee;padding:8px 10px;font-family:inherit;font-size:13px;margin-bottom:8px}',
        '#ladd-box input:focus{outline:none;border-color:#cccc44}',
        '#ladd-box .row{display:flex;gap:8px;margin-top:6px}',
        '#ladd-box button{flex:1;background:#1a1a05;color:#cccc44;border:1px solid #3a3a14;padding:8px;font-family:inherit;font-size:12px;cursor:pointer;letter-spacing:1px}',
        '#ladd-box button.primary{background:#3a3a0a;color:#fff;border-color:#6a6a14}',
        '#ladd-box .err{color:#e06666;font-size:11px;min-height:14px;margin-top:6px}',
        '#ladd-badge{position:fixed;left:8px;bottom:6px;z-index:99998;font-family:ui-monospace,Consolas,monospace;font-size:10px;color:#e0b050;background:rgba(0,0,0,.7);border:1px solid #5a4a14;border-radius:3px;padding:2px 7px;cursor:pointer;letter-spacing:.5px}'
    ].join('');
    document.head.appendChild(css);

    // When already revealed, show a low-key badge that exits reveal on click.
    if (revealed) {
        var badge = document.createElement('div');
        badge.id = 'ladd-badge';
        badge.textContent = '◉ LADD REVEALED — exit';
        badge.title = 'Showing un-masked data. Click to re-enable LADD masking.';
        badge.addEventListener('click', function () {
            fetch('/api/ladd/hide', { method: 'POST' }).then(function () { location.reload(); });
        });
        document.body.appendChild(badge);
    }

    // Modal (built lazily on first trigger).
    var modal = null;
    function buildModal() {
        modal = document.createElement('div');
        modal.id = 'ladd-modal';
        modal.innerHTML =
            '<div id="ladd-box">' +
            '<h3>RESTRICTED VIEW</h3>' +
            '<p>Sign in to view unfiltered data.</p>' +
            '<input id="ladd-u" placeholder="username" autocomplete="off" autocapitalize="off" spellcheck="false">' +
            '<input id="ladd-p" type="password" placeholder="password" autocomplete="off">' +
            '<div class="err" id="ladd-err"></div>' +
            '<div class="row"><button id="ladd-cancel">CANCEL</button><button id="ladd-go" class="primary">UNLOCK</button></div>' +
            '</div>';
        document.body.appendChild(modal);
        modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
        modal.querySelector('#ladd-cancel').addEventListener('click', close);
        modal.querySelector('#ladd-go').addEventListener('click', submit);
        modal.querySelector('#ladd-p').addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
    }
    function open() {
        if (!modal) buildModal();
        modal.classList.add('on');
        modal.querySelector('#ladd-err').textContent = '';
        modal.querySelector('#ladd-u').value = '';
        modal.querySelector('#ladd-p').value = '';
        setTimeout(function () { modal.querySelector('#ladd-u').focus(); }, 0);
    }
    function close() { if (modal) modal.classList.remove('on'); }
    function submit() {
        var u = modal.querySelector('#ladd-u').value;
        var p = modal.querySelector('#ladd-p').value;
        var err = modal.querySelector('#ladd-err');
        err.textContent = '';
        fetch('/api/ladd/reveal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user: u, pass: p })
        }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
          .then(function (res) {
              if (res.ok && res.d.ok) location.reload();
              else err.textContent = (res.d && res.d.error) || 'invalid login';
          }).catch(function () { err.textContent = 'error'; });
    }

    // 5 clicks within 5 s on the footer (or the corner hotspot) → open.
    var clicks = [];
    function tap() {
        var now = Date.now();
        clicks.push(now);
        clicks = clicks.filter(function (t) { return now - t <= 5000; });
        if (clicks.length >= 5) { clicks = []; if (revealed) return; open(); }
    }
    var footer = document.querySelector('footer');
    if (footer) { footer.style.cursor = 'default'; footer.addEventListener('click', tap); }
    var hot = document.createElement('div');
    hot.id = 'ladd-hot';
    hot.addEventListener('click', tap);
    document.body.appendChild(hot);
})();
