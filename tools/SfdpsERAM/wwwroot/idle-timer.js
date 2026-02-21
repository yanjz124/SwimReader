// ── Idle Timer — pauses all network activity after 30 minutes of inactivity ──
// Usage: include <script src="/idle-timer.js"></script> in any page.
// The page must set window.idleOnPause = function() { ... } to close WS / clear intervals
// and window.idleOnResume = function() { ... } to reconnect.
(function () {
    const IDLE_MS = 30 * 60 * 1000; // 30 minutes
    let timer = null;
    let paused = false;

    // Overlay DOM
    const overlay = document.createElement('div');
    overlay.id = 'idle-overlay';
    overlay.innerHTML = `
        <div style="text-align:center">
            <div style="font-size:18px;color:#cccc44;margin-bottom:12px">SESSION PAUSED</div>
            <div style="font-size:12px;color:#aaa;margin-bottom:20px">Inactive for 30 minutes — connections paused to reduce server load.</div>
            <button id="idle-resume-btn">RESUME</button>
        </div>`;

    // Styles (injected once)
    const style = document.createElement('style');
    style.textContent = `
        #idle-overlay {
            display: none; position: fixed; inset: 0; z-index: 99999;
            background: rgba(0,0,0,0.85); backdrop-filter: blur(4px);
            justify-content: center; align-items: center;
            font-family: 'ERAM', 'Consolas', monospace;
        }
        #idle-overlay.active { display: flex; }
        #idle-resume-btn {
            background: #222; border: 1px solid #cccc44; color: #cccc44;
            font-family: inherit; font-size: 14px; padding: 10px 32px;
            cursor: pointer; letter-spacing: 1px;
        }
        #idle-resume-btn:hover { background: #333; }
    `;
    document.head.appendChild(style);
    document.body.appendChild(overlay);

    function resetTimer() {
        if (paused) return; // don't reset while paused — user must click resume
        clearTimeout(timer);
        timer = setTimeout(goPause, IDLE_MS);
    }

    function goPause() {
        if (paused) return;
        paused = true;
        overlay.classList.add('active');
        if (typeof window.idleOnPause === 'function') {
            try { window.idleOnPause(); } catch (e) { console.error('[idle] pause error:', e); }
        }
    }

    function goResume() {
        if (!paused) return;
        paused = false;
        overlay.classList.remove('active');
        if (typeof window.idleOnResume === 'function') {
            try { window.idleOnResume(); } catch (e) { console.error('[idle] resume error:', e); }
        }
        resetTimer();
    }

    // Activity events
    const EVENTS = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'wheel'];
    for (const ev of EVENTS) document.addEventListener(ev, resetTimer, { passive: true });
    // Also reset on visibility change (tab becomes visible)
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && !paused) resetTimer();
    });

    // Resume button
    overlay.querySelector('#idle-resume-btn').addEventListener('click', goResume);

    // Start timer
    resetTimer();

    // Expose for pages that need to check state
    window.idlePaused = () => paused;
})();
