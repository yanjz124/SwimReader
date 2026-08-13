// ─────────────────────────────────────────────────────────────────────────
// STARS v2 — DGScope profile upload/manager. Mounted only on /starsv2.
// Profiles are authored in the desktop DGScope profile-manager; this panel just
// uploads the RadarWindow XML to the server (POST /dstars/profile/{fac}, proxied to
// SwimReader.Server), which stores it verbatim and reloads the CA/MSAW/ATPA engines.
// It also draws the loaded profile's volumes on the scope so you can eyeball them.
// ─────────────────────────────────────────────────────────────────────────
(function () {
  if (!window.STARSV2) return;
  const FAC = window.FACILITY || (location.pathname.match(/^\/starsv2\/[^/]+\/([^/]+)/) || [])[1] || "";

  let profile = null;          // parsed profile for the current facility (for the overlay + status)
  let showVolumes = true;
  const NM_PER_FT = 1 / 6076.12;
  const S = g => geoToScreen(g);   // scope global

  // ── status / current-facility profile ────────────────────────────────────
  async function loadStatus() {
    try {
      const r = await fetch(`/dstars/profile/${encodeURIComponent(FAC)}`, { credentials: "omit" });
      profile = r.ok ? await r.json() : null;
    } catch (e) { profile = null; }
    render();
  }
  async function loadList() {
    try {
      const r = await fetch(`/dstars/profiles`, { credentials: "omit" });
      return r.ok ? await r.json() : [];
    } catch (e) { return []; }
  }

  async function upload() {
    const f = panel.querySelector("#pe-file").files[0];
    const target = (panel.querySelector("#pe-fac").value || FAC).trim().toUpperCase();
    if (!f) return status("choose a .xml profile first");
    status(`uploading ${f.name} → ${target}…`);
    try {
      const xml = await f.text();
      const r = await fetch(`/dstars/profile/${encodeURIComponent(target)}`, {
        method: "POST", headers: { "Content-Type": "application/xml" }, body: xml, credentials: "omit",
      });
      const body = await r.json().catch(() => ({}));
      if (r.ok) {
        status(`uploaded ${target}: ${body.ca} CA · ${body.msaw} MSAW · ${body.atpa} ATPA — engines reload ~1s`);
        if (target === FAC.toUpperCase()) await loadStatus();
        refreshList();
      } else {
        status(`upload failed: ${body || r.status}`);
      }
    } catch (e) { status("upload failed: " + e); }
  }

  // ── panel ─────────────────────────────────────────────────────────────────
  let panel, statusEl;
  function status(t) { if (statusEl) statusEl.textContent = t || ""; }
  function esc(s) { return (s == null ? "" : String(s)).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

  function counts(p) {
    if (!p) return "no profile loaded";
    const ca = (p.ConflictAlertSuppressionVolumes || []).length;
    const ms = (p.MSAWVolumes || []).length, at = (p.ATPAVolumes || []).length;
    return (ca + ms + at) ? `${ca} CA · ${ms} MSAW · ${at} ATPA` : "loaded (no CA/MSAW/ATPA volumes)";
  }

  function render() {
    if (!panel) return;
    panel.innerHTML = `
      <h2>PROFILE · ${esc(FAC)}</h2>
      <div class="pe-hint" id="pe-cur">current: ${esc(counts(profile))}</div>

      <h3>Upload profile</h3>
      <div class="pe-hint">Author in the DGScope profile-manager, then upload its RadarWindow XML here. Stored verbatim; the CA/MSAW/ATPA engines reload within ~1s.</div>
      <div class="pe-row"><label>Facility</label><input id="pe-fac" value="${esc(FAC)}"></div>
      <div class="pe-row"><input type="file" id="pe-file" accept=".xml,application/xml,text/xml"></div>
      <div class="pe-row"><button class="pe-btn save" id="pe-upload">⤒ UPLOAD</button>
        <button class="pe-btn" id="pe-refresh">REFRESH</button></div>

      <h3><label class="pe-toggle-inline"><input type="checkbox" id="pe-show" ${showVolumes ? "checked" : ""}> show volumes on scope</label></h3>
      <div class="pe-hint">CA corridors <span style="color:#78c8ff">▭</span> · ATPA <span style="color:#a878ff">▭</span> · MSAW <span style="color:#ffb450">⬟</span> · MSAW-sup <span style="color:#888">⬟</span></div>

      <h3>Stored profiles</h3>
      <ul class="pe-list" id="pe-list"><li>…</li></ul>`;
    panel.querySelector("#pe-upload").onclick = upload;
    panel.querySelector("#pe-refresh").onclick = () => { loadStatus(); refreshList(); };
    panel.querySelector("#pe-show").onchange = e => { showVolumes = e.target.checked; };
    refreshList();
  }
  async function refreshList() {
    const list = await loadList();
    const el = panel && panel.querySelector("#pe-list");
    if (!el) return;
    el.innerHTML = list.length
      ? list.map(p => `<li><span class="nm">${esc(p.name)}</span><span style="color:#7a9">${p.ca}·${p.msaw}·${p.atpa}</span></li>`).join("")
      : "<li>(none uploaded yet)</li>";
  }

  // ── overlay (called from scope.js frame()) ────────────────────────────────
  function projGeo(lat, lon, distNM, brgDeg) {
    const t = brgDeg * Math.PI / 180;
    return { Latitude: lat + (distNM * Math.cos(t)) / 60,
             Longitude: lon + (distNM * Math.sin(t)) / (60 * Math.cos(lat * Math.PI / 180)) };
  }
  function corridor(ctx, thr, hdg, lenNM, halfNM, color) {
    const recip = (hdg + 180) % 360, pL = (recip + 270) % 360, pR = (recip + 90) % 360;
    const far = projGeo(thr.Latitude, thr.Longitude, lenNM, recip);
    const pts = [
      projGeo(thr.Latitude, thr.Longitude, halfNM, pL),
      projGeo(far.Latitude, far.Longitude, halfNM, pL),
      projGeo(far.Latitude, far.Longitude, halfNM, pR),
      projGeo(thr.Latitude, thr.Longitude, halfNM, pR),
    ].map(S);
    ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.beginPath();
    pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
    ctx.closePath(); ctx.stroke();
  }
  function poly(ctx, points, color) {
    if (!points || points.length < 2) return;
    ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.beginPath();
    points.forEach((p, i) => { const s = S(p); i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y); });
    ctx.closePath(); ctx.stroke();
  }
  window.__editorDraw = function (ctx) {
    if (!profile || !showVolumes) return;
    ctx.save();
    for (const v of (profile.ConflictAlertSuppressionVolumes || []))
      if (v.RunwayThreshold) corridor(ctx, v.RunwayThreshold, v.TrueHeading || 0, v.Length || 30, v.HalfWidth || 2, "rgba(120,200,255,.5)");
    for (const v of (profile.ATPAVolumes || []))
      if (v.RunwayThreshold) corridor(ctx, v.RunwayThreshold, v.TrueHeading || 0, v.Length || 10, ((v.WidthLeft || 0) + (v.WidthRight || 0)) / 2 * NM_PER_FT, "rgba(168,120,255,.55)");
    const msaw = (arr, col) => { for (const v of (arr || [])) {
      if (v.Radius > 0 && v.Center) { const c = S(v.Center); ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(c.x, c.y, v.Radius / view.scale, 0, Math.PI * 2); ctx.stroke(); }
      else poly(ctx, v.Points, col);
    } };
    msaw(profile.MSAWVolumes, "rgba(255,180,80,.55)");
    msaw(profile.MSAWSuppressionVolumes, "rgba(130,130,130,.45)");
    ctx.restore();
  };

  // ── mount ────────────────────────────────────────────────────────────────
  function mount() {
    const btn = document.createElement("button");
    btn.id = "pe-toggle"; btn.textContent = "⚙ PROFILE";
    panel = document.createElement("div"); panel.id = "pe-panel";
    statusEl = document.createElement("div"); statusEl.id = "pe-status";
    document.body.appendChild(btn); document.body.appendChild(panel); document.body.appendChild(statusEl);
    render();
    btn.onclick = () => { panel.classList.toggle("open"); if (panel.classList.contains("open")) loadStatus(); };
    loadStatus();   // load overlay data even before opening the panel
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();
