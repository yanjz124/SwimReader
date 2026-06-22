/* ─────────────────────────────────────────────────────────────────────────
 * Shared Replay Bar — drop-in floating control bar for any scope page.
 *
 * Mounts a single bottom-center hover box, talks to the server's existing
 * replay WebSocket protocol (/replay/ws, /replay/asdex/ws/{airport}, etc.),
 * and dispatches incoming messages back to the host scope via callbacks.
 *
 * Server WS protocol (matches ReplayServer.cs):
 *   client → server: { cmd: "pause" | "resume" }
 *                    { cmd: "speed", value: <number> }
 *                    { cmd: "seek",  time: <ISO8601> }
 *                    { cmd: "viewport", minLat, minLon, maxLat, maxLon }
 *   server → client: { type: "snapshot" | "batch" | "remove" | ... }
 *                    { type: "replay_start" | "replay_seek" | "replay_gap"
 *                            | "replay_end" | "replay_error" }
 *                    All scope-data messages carry { replayTime: <ISO> }.
 *
 * Public API: window.ReplayBar = { init, isActive, seek, currentTime,
 *                                   open, close, minimize, stop }
 * ───────────────────────────────────────────────────────────────────────── */
(function () {
  let cfg = null;
  let bar = null;       // root element
  let ws = null;
  let active = false;
  let paused = false;
  let currentTime = null;     // ISO string of latest server-reported time
  let startMs = null, endMs = null;  // available range, from /api/replay/range
  let _vpTimer = null;
  let _saveTimer = null;

  // ── DOM ───────────────────────────────────────────────────────────────
  function ensureCss() {
    if (document.getElementById("rb-css")) return;
    const link = document.createElement("link");
    link.id = "rb-css";
    link.rel = "stylesheet";
    link.href = "/shared/replay-bar.css";
    document.head.appendChild(link);
  }

  function buildBar() {
    if (bar) return;
    bar = document.createElement("div");
    bar.id = "rb-bar";
    bar.className = "rb-hidden";   // start hidden; open() to show
    bar.innerHTML = `
      <div class="rb-handle">
        <span>REPLAY</span>
        <span class="rb-status" id="rb-status"></span>
        <span class="rb-btns">
          <button id="rb-toggle" title="Minimize">▾</button>
          <button id="rb-closebtn" title="Hide bar">×</button>
        </span>
      </div>
      <div class="rb-body">
        <div class="rb-pickrow" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;width:100%;">
          <input type="date" id="rb-date" title="Date (Zulu)">
          <input type="text" id="rb-tin" inputmode="numeric" maxlength="6"
                 placeholder="HHMM"
                 title="Time in Zulu (UTC) 24-hour clock — HHMM or HHMMSS"
                 style="width:74px;text-align:center;font-variant-numeric:tabular-nums;">
          <span class="rb-zlabel">Z</span>
          <button id="rb-go" class="rb-go">GO</button>
          <span id="rb-range"></span>
        </div>
        <div class="rb-playback">
          <button id="rb-pause" title="Pause/Play">⏸</button>
          <button id="rb-back-1m"  title="-1 min">«1m</button>
          <button id="rb-back-10s" title="-10 s">«10s</button>
          <button id="rb-fwd-10s"  title="+10 s">10s»</button>
          <button id="rb-fwd-1m"   title="+1 min">1m»</button>
          <select id="rb-speed" title="Playback speed">
            <option value="0.5">0.5×</option>
            <option value="1" selected>1×</option>
            <option value="2">2×</option>
            <option value="4">4×</option>
            <option value="8">8×</option>
            <option value="16">16×</option>
            <option value="60">60×</option>
          </select>
          <input type="range" id="rb-scrub" min="0" max="1000" value="0" step="1" title="Scrub">
          <span id="rb-time">— : — : —</span>
          <button id="rb-share" title="Copy share link">🔗</button>
          <button id="rb-stop" class="rb-stop">LIVE</button>
        </div>
      </div>`;
    document.body.appendChild(bar);

    // Single toggle button: minimize when expanded, restore when minimized.
    bar.querySelector("#rb-toggle").onclick = (e) => {
      e.stopPropagation();
      minimize();   // toggle
    };
    bar.querySelector("#rb-closebtn").onclick = (e) => { e.stopPropagation(); close(); };
    // Clicking anywhere on the minimized pill expands it.
    bar.addEventListener("click", (e) => {
      if (bar.classList.contains("rb-min")) { minimize(false); e.stopPropagation(); }
    });

    // Restrict time input to digits.
    const tin = bar.querySelector("#rb-tin");
    tin.addEventListener("input", () => {
      const cleaned = tin.value.replace(/\D/g, "").slice(0, 6);
      if (cleaned !== tin.value) tin.value = cleaned;
    });

    bar.querySelector("#rb-go").onclick = () => {
      const d = parseDateTime(bar.querySelector("#rb-date").value, tin.value);
      if (!d) { setStatus("Pick a date and time (HHMM Zulu)", "warn"); return; }
      startReplay(d.toISOString());
    };
    for (const el of [bar.querySelector("#rb-date"), tin]) {
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") bar.querySelector("#rb-go").click();
      });
    }

    bar.querySelector("#rb-pause").onclick = () => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      paused = !paused;
      ws.send(JSON.stringify({ cmd: paused ? "pause" : "resume" }));
      bar.querySelector("#rb-pause").textContent = paused ? "▶" : "⏸";
    };
    bar.querySelector("#rb-speed").onchange = (e) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ cmd: "speed", value: parseFloat(e.target.value) }));
    };
    bar.querySelector("#rb-stop").onclick = stop;
    bar.querySelector("#rb-share").onclick = copyLink;

    bar.querySelector("#rb-back-1m").onclick  = () => relSeek(-60);
    bar.querySelector("#rb-back-10s").onclick = () => relSeek(-10);
    bar.querySelector("#rb-fwd-10s").onclick  = () => relSeek(+10);
    bar.querySelector("#rb-fwd-1m").onclick   = () => relSeek(+60);

    // Scrub - debounce so we don't spam seeks while dragging
    let _scrubTimer = null;
    bar.querySelector("#rb-scrub").addEventListener("input", (e) => {
      if (!startMs || !endMs) return;
      const frac = parseFloat(e.target.value) / 1000;
      const t = new Date(startMs + frac * (endMs - startMs));
      bar.querySelector("#rb-time").textContent = fmtClock(t);
      if (_scrubTimer) clearTimeout(_scrubTimer);
      _scrubTimer = setTimeout(() => seek(t.toISOString()), 120);
    });
  }

  // ── helpers ───────────────────────────────────────────────────────────
  function fmtClock(d) {
    return d.toISOString().replace("T", " ").slice(0, 19) + "Z";
  }
  function fmtZuluInput(d) { return d.toISOString().replace("T", " ").slice(0, 19); }

  // Format a UTC Date as "YYYY-MM-DD" — used to populate the date <input>.
  function fmtZuluDate(d) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`;
  }
  // Format a UTC Date as "HHMM" — used to populate the time text <input>.
  function fmtZuluHHMM(d) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
  }
  // Combine a "YYYY-MM-DD" date string + an "HHMM"/"HHMMSS" time string,
  // both Zulu, into a UTC Date. Returns null on bad input.
  function parseDateTime(dateStr, timeStr) {
    if (!dateStr) return null;
    const dm = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!dm) return null;
    const tDigits = String(timeStr || "").replace(/\D/g, "");
    if (tDigits.length !== 4 && tDigits.length !== 6) return null;
    const hh = parseInt(tDigits.slice(0,2), 10);
    const mm = parseInt(tDigits.slice(2,4), 10);
    const ss = tDigits.length === 6 ? parseInt(tDigits.slice(4,6), 10) : 0;
    if (hh > 23 || mm > 59 || ss > 59) return null;
    const d = new Date(Date.UTC(+dm[1], +dm[2]-1, +dm[3], hh, mm, ss));
    return isNaN(d) ? null : d;
  }

  // Accept many formats — used by the bar's text input AND the ERAM
  // XX REPLAY command. Returns Date (UTC) or null.
  //   "YYYY-MM-DD HH:MM[:SS]"
  //   "YYYY-MM-DDTHH:MM[:SS][Z]"
  //   "HHMMSSMMDDYYYY"  (14 digits, packed)
  //   "HHMMSS"          (today UTC; if it's in the future, treat as yesterday)
  //   "HHMM"            (today UTC; same rule)
  //   "HHMM DDMMMYYYY"  (e.g., "2359 22JUN2026")
  //   "HHMMZ DDMMMYYYY"
  function parseZulu(s) {
    if (!s) return null;
    s = String(s).trim();
    if (!s) return null;

    // ISO-ish with date
    let m = s.replace(/\s*[zZ]$/, "").replace(" ", "T").match(
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (m) {
      const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || "00"}Z`);
      return isNaN(d) ? null : d;
    }

    // Packed digits: HHMMSSMMDDYYYY (14) or HHMMMMDDYYYY (12)
    const digits = s.replace(/\D/g, "");
    if (digits.length === 14) {
      const [hh, mm, ss, MM, DD, YYYY] = [
        digits.slice(0,2), digits.slice(2,4), digits.slice(4,6),
        digits.slice(6,8), digits.slice(8,10), digits.slice(10,14)
      ];
      const d = new Date(`${YYYY}-${MM}-${DD}T${hh}:${mm}:${ss}Z`);
      return isNaN(d) ? null : d;
    }
    if (digits.length === 12) {
      const [hh, mm, MM, DD, YYYY] = [
        digits.slice(0,2), digits.slice(2,4),
        digits.slice(4,6), digits.slice(6,8), digits.slice(8,12)
      ];
      const d = new Date(`${YYYY}-${MM}-${DD}T${hh}:${mm}:00Z`);
      return isNaN(d) ? null : d;
    }

    // "HHMM DDMMMYYYY" / "HHMMZ DDMMMYYYY"
    m = s.replace(/[Zz]/g, " ").trim().match(
      /^(\d{2})(\d{2})(?:(\d{2}))?\s+(\d{1,2})([A-Za-z]{3})(\d{4})$/);
    if (m) {
      const months = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
      const mi = months.indexOf(m[5].toUpperCase());
      if (mi < 0) return null;
      const MM = String(mi + 1).padStart(2, "0");
      const DD = String(parseInt(m[4], 10)).padStart(2, "0");
      const d = new Date(`${m[6]}-${MM}-${DD}T${m[1]}:${m[2]}:${m[3] || "00"}Z`);
      return isNaN(d) ? null : d;
    }

    // Bare HHMM(SS) -> today UTC, sliding to yesterday if in the future
    if (/^\d{4,6}$/.test(digits)) {
      const now = new Date();
      const hh = parseInt(digits.slice(0, 2), 10);
      const mm = parseInt(digits.slice(2, 4), 10);
      const ss = digits.length === 6 ? parseInt(digits.slice(4, 6), 10) : 0;
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hh, mm, ss));
      if (d.getTime() > now.getTime()) d.setUTCDate(d.getUTCDate() - 1);
      return isNaN(d) ? null : d;
    }
    return null;
  }

  function setStatus(text, kind) {
    const el = bar?.querySelector("#rb-status");
    if (!el) return;
    el.textContent = text;
    el.style.color =
      kind === "warn" ? "var(--rb-warn)" :
      kind === "err"  ? "var(--rb-stop)" :
      kind === "ok"   ? "var(--rb-good)" : "";
  }

  function paddedBoundsFromCfg() {
    try { return cfg.viewport?.() || null; } catch { return null; }
  }

  function sendViewport() {
    if (!active || !ws || ws.readyState !== WebSocket.OPEN) return;
    const b = paddedBoundsFromCfg();
    if (!b) return;
    ws.send(JSON.stringify(Object.assign({ cmd: "viewport" }, b)));
  }

  function scheduleViewport() {
    if (!active) return;
    if (_vpTimer) clearTimeout(_vpTimer);
    _vpTimer = setTimeout(sendViewport, 300);
  }

  // ── public API ────────────────────────────────────────────────────────
  async function init(opts) {
    cfg = Object.assign({
      wsPath:    "/replay/ws",
      rangeKey:  "eram",            // which sub-object of /api/replay/range to read
      viewport:  null,              // optional () => { minLat, minLon, maxLat, maxLon }
      onSnapshot: () => {},
      onBatch:    () => {},
      onRemove:   () => {},
      onTime:     () => {},
      onStart:    () => {},
      onSeek:     () => {},
      onStop:     () => {},
      onMessage:  () => {},         // catch-all for non-data types (holdbar, replay_end, …)
    }, opts || {});
    ensureCss();
    buildBar();
    await fetchRange();
    // Bind viewport-change broadcaster if host wires its map listeners through us
    if (cfg.viewport && cfg.bindViewportEvents) cfg.bindViewportEvents(scheduleViewport);

    // Auto-start from #replay=... hash param
    const params = new URLSearchParams(location.hash.slice(1));
    const rp = params.get("replay");
    if (rp) {
      const spd = params.get("rspd");
      if (spd) bar.querySelector("#rb-speed").value = spd;
      open();
      setTimeout(() => startReplay(rp), 500);
    }
    return ReplayBar;
  }

  async function fetchRange() {
    try {
      const r = await fetch("/api/replay/range");
      const d = await r.json();
      let info = d?.[cfg.rangeKey];
      if (info && typeof info === "object" && !info.start && cfg.rangeSubKey) info = info[cfg.rangeSubKey];
      const dateEl = bar.querySelector("#rb-date");
      const tEl = bar.querySelector("#rb-tin");
      // Default the picker to "1 hour ago" in Zulu.
      const defaultD = new Date(Date.now() - 3600000);
      if (info?.start && info?.end) {
        startMs = new Date(info.start).getTime();
        endMs = new Date(info.end).getTime();
        bar.querySelector("#rb-range").textContent =
          `Available: ${fmtClock(new Date(startMs))} — ${fmtClock(new Date(endMs))}  ` +
          `(${info.hours || ""}h${info.totalSizeMB ? ", " + info.totalSizeMB.toFixed(1) + " MB" : ""})`;
        dateEl.min = fmtZuluDate(new Date(startMs));
        dateEl.max = fmtZuluDate(new Date(endMs));
      } else {
        bar.querySelector("#rb-range").textContent = "No replay data yet (recording…)";
      }
      if (!dateEl.value) dateEl.value = fmtZuluDate(defaultD);
      if (!tEl.value)    tEl.value    = fmtZuluHHMM(defaultD);
    } catch {
      bar.querySelector("#rb-range").textContent = "Error fetching replay range";
    }
  }

  function open()   { bar?.classList.remove("rb-hidden"); minimize(false); fetchRange(); }
  function close()  { if (active) stop(); bar?.classList.add("rb-hidden"); }
  function minimize(v) {
    if (!bar) return;
    if (v == null) v = !bar.classList.contains("rb-min");
    bar.classList.toggle("rb-min", !!v);
    const btn = bar.querySelector("#rb-toggle");
    if (btn) {
      btn.textContent = v ? "▴" : "▾";
      btn.title = v ? "Restore" : "Minimize";
    }
  }

  function startReplay(startISO) {
    if (ws) { ws.onclose = null; try { ws.close(); } catch {} ws = null; }
    active = true; paused = false;
    bar.classList.remove("rb-hidden");
    bar.classList.add("rb-playing");
    bar.querySelector("#rb-pause").textContent = "⏸";
    setStatus("Connecting…");
    cfg.onStart?.(startISO);

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const speed = bar.querySelector("#rb-speed").value || "1";
    let url = `${proto}//${location.host}${cfg.wsPath}?start=${encodeURIComponent(startISO)}&speed=${speed}`;
    const vp = paddedBoundsFromCfg();
    if (vp) url += `&minLat=${vp.minLat}&minLon=${vp.minLon}&maxLat=${vp.maxLat}&maxLon=${vp.maxLon}`;
    ws = new WebSocket(url);

    ws.onopen = () => setStatus("Loading…");
    ws.onclose = () => { if (active) setStatus("Disconnected"); };
    ws.onerror = () => setStatus("WS error", "err");
    ws.onmessage = (evt) => {
      let msg; try { msg = JSON.parse(evt.data); } catch { return; }
      if (msg.replayTime) {
        currentTime = msg.replayTime;
        bar.querySelector("#rb-time").textContent = fmtClock(new Date(msg.replayTime));
        if (startMs && endMs && endMs > startMs) {
          const frac = (new Date(msg.replayTime).getTime() - startMs) / (endMs - startMs);
          bar.querySelector("#rb-scrub").value = Math.max(0, Math.min(1000, Math.round(frac * 1000)));
        }
        cfg.onTime?.(msg.replayTime);
        throttleSaveUrl();
      }
      switch (msg.type) {
        case "snapshot":     cfg.onSnapshot?.(msg.data || [], msg); break;
        case "batch":        cfg.onBatch?.(msg.data || [], msg);    break;
        case "remove":       cfg.onRemove?.(msg.data, msg);          break;
        case "replay_seek":  cfg.onSeek?.(msg);                       setStatus("Seeking…"); break;
        case "replay_start": setStatus("Buffering…");                  break;
        case "replay_gap":   setStatus(`Gap: ${(msg.from||"").slice(11,19)}–${(msg.to||"").slice(11,19)}`); break;
        case "replay_end":   setStatus("End of data", "warn");        break;
        case "replay_error": setStatus(msg.message || "Error", "err"); break;
        default:             cfg.onMessage?.(msg);
      }
    };
  }

  function stop() {
    active = false; paused = false;
    currentTime = null;
    if (ws) { ws.onclose = null; try { ws.close(); } catch {} ws = null; }
    bar.classList.remove("rb-playing");
    bar.querySelector("#rb-time").textContent = "— : — : —";
    setStatus("Live");
    saveUrl();
    cfg.onStop?.();
  }

  function seek(timeISO) {
    if (!active || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ cmd: "seek", time: timeISO }));
  }

  function relSeek(seconds) {
    if (!currentTime) return;
    const t = new Date(new Date(currentTime).getTime() + seconds * 1000);
    seek(t.toISOString());
  }

  function copyLink() {
    saveUrl();
    const url = location.href;
    const done = () => setStatus("Link copied", "ok");
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(done, done);
    else done();
  }

  function saveUrl() {
    try {
      const p = new URLSearchParams(location.hash.slice(1));
      if (active && currentTime) {
        p.set("replay", currentTime);
        p.set("rspd", bar.querySelector("#rb-speed").value || "1");
      } else {
        p.delete("replay");
        p.delete("rspd");
      }
      const h = p.toString();
      history.replaceState(null, "", h ? "#" + h : location.pathname + location.search);
    } catch {}
  }
  function throttleSaveUrl() {
    if (_saveTimer) return;
    _saveTimer = setTimeout(() => { _saveTimer = null; saveUrl(); }, 3000);
  }

  window.ReplayBar = {
    init,
    open, close, minimize, stop,
    startAt(isoOrAny) {
      const d = (isoOrAny instanceof Date) ? isoOrAny
              : (typeof isoOrAny === "string" && isoOrAny.includes("T")) ? new Date(isoOrAny)
              : parseZulu(isoOrAny);
      if (!d || isNaN(d)) return false;
      open();
      startReplay(d.toISOString());
      return true;
    },
    seek,
    relSeek,
    setSpeed(v) { if (bar) { bar.querySelector("#rb-speed").value = String(v); bar.querySelector("#rb-speed").dispatchEvent(new Event("change")); } },
    toggle()    { if (bar?.classList.contains("rb-hidden")) open(); else close(); },
    isActive()  { return active; },
    isOpen()    { return bar && !bar.classList.contains("rb-hidden"); },
    currentTime() { return currentTime; },
    parseZulu,
    scheduleViewportSend: scheduleViewport,
  };
})();
