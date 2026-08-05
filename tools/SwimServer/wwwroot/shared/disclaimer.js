/* First-launch data-source & use disclaimer.
 *
 * Shows once per browser (remembered with a cookie). Acknowledge → dismiss and
 * continue; Decline → leave for the FAA SWIM Portal. Self-contained: no deps,
 * injects its own styles. Include on any page with:
 *   <script src="/shared/disclaimer.js?v=1"></script>
 */
(function () {
    var COOKIE = 'swimAck';
    var PORTAL = 'https://portal.swim.faa.gov/';

    function hasAck() {
        return document.cookie.split(';').some(function (c) {
            return c.trim().indexOf(COOKIE + '=1') === 0;
        });
    }
    function setAck() {
        var d = new Date();
        d.setFullYear(d.getFullYear() + 1);
        document.cookie = COOKIE + '=1; path=/; expires=' + d.toUTCString() + '; SameSite=Lax';
    }

    function build() {
        var style = document.createElement('style');
        style.textContent =
            '#swim-dsc-ov{position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.88);' +
            'display:flex;align-items:center;justify-content:center;padding:20px;' +
            "font-family:ui-monospace,'Consolas','Cascadia Mono',monospace;-webkit-font-smoothing:antialiased;}" +
            '#swim-dsc{max-width:560px;width:100%;background:#0e0e0e;border:1px solid #cccc44;border-radius:12px;' +
            'box-shadow:0 12px 48px rgba(0,0,0,.6);color:#d8d8b0;padding:22px 22px 18px;}' +
            '#swim-dsc h2{margin:0 0 12px;font-size:16px;letter-spacing:1px;color:#cccc44;font-weight:bold;}' +
            '#swim-dsc p{margin:0 0 11px;font-size:13.5px;line-height:1.6;}' +
            '#swim-dsc a{color:#6cc0ff;}' +
            '#swim-dsc .warn{color:#ff8c00;font-weight:bold;}' +
            '#swim-dsc .fine{color:#888;font-size:12px;}' +
            '#swim-dsc .btns{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px;}' +
            '#swim-dsc button{flex:1;min-width:150px;font:inherit;font-size:13px;font-weight:bold;' +
            'padding:11px 14px;border-radius:8px;cursor:pointer;letter-spacing:.5px;}' +
            '#swim-dsc .ack{background:#1e2e1e;color:#bfe6bf;border:1px solid #3a5a3a;}' +
            '#swim-dsc .ack:hover{background:#294029;}' +
            '#swim-dsc .dec{background:#241414;color:#e0a0a0;border:1px solid #5a2a2a;}' +
            '#swim-dsc .dec:hover{background:#3a1c1c;}';
        document.head.appendChild(style);

        var ov = document.createElement('div');
        ov.id = 'swim-dsc-ov';
        ov.setAttribute('role', 'dialog');
        ov.setAttribute('aria-modal', 'true');
        ov.innerHTML =
            '<div id="swim-dsc">' +
              '<h2>DATA SOURCE &amp; USE</h2>' +
              '<p>All data shown here is publicly accessible from the FAA <b>SWIM Portal</b> ' +
                '(<a href="https://portal.swim.faa.gov/" target="_blank" rel="noopener">portal.swim.faa.gov</a>) ' +
                'and has been pre-approved for public release by the <b>NAS Data Release Board (NDRB)</b>.</p>' +
              '<p class="warn">Data obtained via the SWIM Cloud Distribution Service (SCDS) is NOT for operational use.</p>' +
              '<p>This is an unofficial tool that visualizes publicly-released SWIM data to recreate ' +
                'situational awareness for <b>personal use only</b>. It is not FAA data and is not ' +
                'affiliated with, or endorsed by, the FAA.</p>' +
              '<p class="fine">Acknowledging continues to the tool. Declining returns you to the FAA SWIM Portal.</p>' +
              '<div class="btns">' +
                '<button class="ack" type="button">I ACKNOWLEDGE</button>' +
                '<button class="dec" type="button">DECLINE &amp; EXIT</button>' +
              '</div>' +
            '</div>';
        document.body.appendChild(ov);

        var prevOverflow = document.documentElement.style.overflow;
        document.documentElement.style.overflow = 'hidden';

        ov.querySelector('.ack').addEventListener('click', function () {
            setAck();
            ov.remove();
            style.remove();
            document.documentElement.style.overflow = prevOverflow;
        });
        ov.querySelector('.dec').addEventListener('click', function () {
            window.location.href = PORTAL;
        });
    }

    function ready() {
        if (hasAck()) return;
        build();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', ready);
    } else {
        ready();
    }
})();
