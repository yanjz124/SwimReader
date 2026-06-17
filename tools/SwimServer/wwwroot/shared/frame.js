/* Shared menu-page frame: adds an "up one level" link next to the HOME button
 * on nested pages (e.g. /tais/RDU → ↑ TAIS, in addition to ← HOME). Top-level
 * directory pages keep just HOME (their parent IS home). Pairs with frame.css.
 * Not used on the radar simulators. */
(function () {
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
