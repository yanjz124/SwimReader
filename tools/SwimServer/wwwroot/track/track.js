// Track a single flight — aggregates /api/track/{callsign} across all sources, mobile-first.
(function () {
  const $ = id => document.getElementById(id);
  const esc = s => (s == null ? '' : String(s)).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const out = $('out'), statusText = $('statusText'), dot = $('dot');
  let current = '', timer = null;

  // ── format helpers ──
  const fl = a => (a == null ? null : String(Math.round(a / 100)).padStart(3, '0'));
  const lid = a => (a && a.length === 4 && a[0] === 'K') ? a.slice(1) : (a || '');
  function agoStr(iso) { if (!iso) return ''; const s = Math.round((Date.now() - new Date(iso)) / 1000); if (s < 1) return 'now'; if (s < 60) return s + 's ago'; if (s < 3600) return Math.round(s / 60) + 'm ago'; return Math.round(s / 3600) + 'h ago'; }
  function hhmm(iso) { if (!iso) return ''; const d = new Date(iso); if (isNaN(d)) return ''; return String(d.getUTCHours()).padStart(2, '0') + String(d.getUTCMinutes()).padStart(2, '0') + 'Z'; }
  // grid() escapes values — pass RAW strings/numbers (▸ → etc. are fine, not HTML-special).
  function grid(rows) {
    const r = rows.filter(x => x[1] != null && x[1] !== '');
    if (!r.length) return '';
    return `<div class="grid">${r.map(([k, v, c]) => `<span class="k">${esc(k)}</span><span class="v${c ? ' ' + c : ''}">${esc(v)}</span>`).join('')}</div>`;
  }

  // ── routing / search ──
  function initialCallsign() { const m = location.pathname.match(/^\/track\/([A-Za-z0-9]+)/); return m ? m[1].toUpperCase() : ''; }
  $('f').addEventListener('submit', e => {
    e.preventDefault();
    const cs = $('cs').value.trim().toUpperCase();
    if (!cs) return;
    history.pushState({}, '', '/track/' + encodeURIComponent(cs));
    $('cs').blur();
    startTrack(cs);
  });
  window.addEventListener('popstate', () => { const cs = initialCallsign(); if (cs) { $('cs').value = cs; startTrack(cs); } });

  function startTrack(cs) {
    current = cs;
    if (timer) clearInterval(timer);
    out.innerHTML = '';
    statusText.textContent = 'Loading ' + cs + '…';
    poll();
    timer = setInterval(poll, 4000);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (timer) { clearInterval(timer); timer = null; } }
    else if (current && !timer) { poll(); timer = setInterval(poll, 4000); }
  });

  async function poll() {
    if (!current) return;
    try {
      const r = await fetch('/api/track/' + encodeURIComponent(current));
      if (!r.ok) { dot.className = 'dot'; statusText.textContent = 'Error ' + r.status; return; }
      dot.className = 'dot live';
      render(await r.json());
    } catch (e) { dot.className = 'dot'; statusText.textContent = 'Offline — retrying…'; }
  }

  // ── render ──
  function render(d) {
    if (!d.found) {
      statusText.textContent = 'No live data for ' + d.callsign;
      out.innerHTML = `<div class="msg">Nothing is tracking <b>${esc(d.callsign)}</b> right now.<br>It may not be airborne or filed yet. Use the exact callsign (e.g. AAL123, not AA123).</div>`;
      return;
    }
    statusText.textContent = `Tracking ${d.callsign} · updated ${agoStr(d.ts) || 'now'}`;
    const flights = (d.sfdps || []).slice().sort((a, b) => {
      const ap = a.lat != null ? 0 : 1, bp = b.lat != null ? 0 : 1;
      return ap !== bp ? ap - bp : (a.posAgeSec ?? 9999) - (b.posAgeSec ?? 9999);
    });
    const f = flights[0] || null;
    const tais = (d.tais || [])[0] || null;
    const asd = (d.asdex || [])[0] || null;

    let h = '';
    h += heroCard(d, f, tais, asd);
    h += blocksCard(f, tais);
    h += ownershipCard(flights);
    if (d.edct) h += `<div class="card"><h2>EDCT <span class="tag">departure slot</span></h2>${grid([['Controlled Departure', hhmm(d.edct), 'hl'], ['Slot', d.edct.slice(0, 16).replace('T', ' ') + 'Z']])}</div>`;
    if (f) h += flightPlanCard(f);
    if (d.tdls && d.tdls.length) h += tdlsCard(d.tdls);
    if (d.asdex && d.asdex.length) h += asdexCard(d.asdex);
    if (d.tais && d.tais.length) h += taisCard(d.tais);
    if (d.tfms) h += tfmsCard(d.tfms);
    out.innerHTML = h;
  }

  function phaseOf(d, f, tais, asd) {
    if (asd) return (asd.track.spdKts || 0) < 40 ? ['ON SURFACE', '#39ff62'] : ['DEPARTING', '#ff8c00'];
    if (f) {
      if (f.status === 'DROPPED') return ['DROPPED', '#ff4444'];
      if (f.lat != null && (f.gs || 0) > 40) return ['AIRBORNE', '#44cc44'];
      if (f.status === 'PROPOSED' || f.lat == null) return ['PRE-DEPARTURE', '#8a8a3a'];
    }
    if (tais) return ['TERMINAL', '#39ff62'];
    return ['TRACKED', '#cccc44'];
  }

  function heroCard(d, f, tais, asd) {
    const type = f?.acType || tais?.acType || asd?.track.acType || (d.tfms && d.tfms.acType) || '';
    const wake = f?.wake ? '/' + f.wake : '';
    const org = f?.origin || tais?.origin || asd?.track.origin || (d.tfms && d.tfms.depArpt) || '';
    const dst = f?.dest || tais?.dest || asd?.track.dest || (d.tfms && d.tfms.arrArpt) || '';
    const [ph, phc] = phaseOf(d, f, tais, asd);
    const chips = [['SFDPS', (d.sfdps || []).length > 0], ['TFMS', !!d.tfms], ['TDLS', (d.tdls || []).length > 0],
      ['STARS', (d.tais || []).length > 0], ['ASDE-X', (d.asdex || []).length > 0], ['EDCT', !!d.edct]]
      .map(([n, on]) => `<span class="chip${on ? ' on' : ''}">${n}</span>`).join('');
    const sub = [type + wake, f ? 'CID ' + (f.cid || '—') : '', f?.registration].filter(Boolean).join(' · ');
    return `<div class="hero">
      <div class="cs">${esc(d.callsign)}</div>
      <div class="od">${esc(org || '????')} <span class="arrow">▸</span> ${esc(dst || '????')}</div>
      <div class="sub">${esc(sub)}</div>
      <div class="phase" style="background:#111;color:${phc};border-color:${phc}66">${ph}</div>
      <div class="chips">${chips}</div>
    </div>`;
  }

  // ── mock data blocks ──
  function eramBlock(f) {
    if (!f) return null;
    const aFL = fl(f.assignedAlt), rFL = fl(f.reportedAlt), iFL = fl(f.interimAlt);
    let l2;
    if (f.blockFloor != null && f.blockCeil != null) l2 = `${fl(f.blockFloor)}B${fl(f.blockCeil)}`;
    else if (f.assignedVfr) l2 = 'VFR' + (rFL ? '/' + rFL : '');
    else if (iFL) l2 = `${iFL}T${rFL || '---'}`;
    else if (aFL) { if (rFL == null) l2 = aFL; else { const dd = parseInt(rFL) - parseInt(aFL); l2 = Math.abs(dd) <= 2 ? `${aFL}C` : `${aFL}${dd < 0 ? '↑' : '↓'}${rFL}`; } }
    else l2 = rFL || '---';
    const gs = f.gs != null ? Math.round(f.gs) : '';
    return `◇ ${f.callsign || '???'}\n   ${l2}\n   ${(f.cid || '----')} ${gs}\n   ${lid(f.dest)}`;
  }
  function starsBlock(f, tais) {
    const src = tais || (f ? { callsign: f.callsign, altFt: f.reportedAlt, gs: f.gs, sp1: lid(f.dest) } : null);
    if (!src) return null;
    const a = src.altFt != null ? String(Math.round(src.altFt / 100)).padStart(3, '0') : '---';
    const gs = src.gs != null ? String(Math.round(src.gs / 10)).padStart(2, '0') : '';
    const sp = src.sp1 || src.sp2 || lid(f && f.dest) || '';
    return `${src.callsign || '???'}\n${a}\n${gs} ${sp}`.trimEnd();
  }
  function blocksCard(f, tais) {
    const e = eramBlock(f), s = starsBlock(f, tais);
    if (!e && !s) return '';
    let inner = '';
    if (e) inner += `<div class="db eram"><div class="lbl">ERAM · EN ROUTE</div><pre>${esc(e)}</pre></div>`;
    if (s) inner += `<div class="db stars"><div class="lbl">STARS · TERMINAL</div><pre>${esc(s)}</pre></div>`;
    return `<div class="card"><h2>DATA BLOCK <span class="tag">how a controller sees it</span></h2><div class="blocks">${inner}</div></div>`;
  }

  function altSummary(f) {
    if (f.assignedVfr) return 'VFR' + (f.reportedAlt ? ' / at FL' + Math.round(f.reportedAlt / 100) : '');
    if (f.blockFloor != null && f.blockCeil != null) return `block FL${Math.round(f.blockFloor / 100)}-${Math.round(f.blockCeil / 100)}`;
    const p = [];
    if (f.assignedAlt != null) p.push('assigned FL' + Math.round(f.assignedAlt / 100));
    if (f.interimAlt != null) p.push('interim FL' + Math.round(f.interimAlt / 100));
    if (f.reportedAlt != null) p.push('at FL' + Math.round(f.reportedAlt / 100));
    return p.join(' · ') || null;
  }
  function hsf(f) { const p = []; if (f.clrHeading) p.push('H' + f.clrHeading); if (f.clrSpeed) p.push('S' + f.clrSpeed); if (f.clrText) p.push(f.clrText); return p.join(' ') || null; }

  function ownershipCard(flights) {
    if (!flights.length) return '';
    let rows = '';
    flights.forEach((f, i) => {
      if (i > 0) rows += `<div class="subhdr">ALSO TRACKED BY ${esc(f.reportingFacility || f.controllingFacility || '?')}</div>`;
      rows += grid([
        ['Controlling', f.controllingFacility ? f.controllingFacility + (f.controllingSector ? '/' + f.controllingSector : '') : '—', 'hl'],
        ['Reporting', f.reportingFacility],
        ['Handoff', f.handoffEvent ? `${f.handoffEvent}: ${f.handoffTransferring || '?'} ▸ ${f.handoffReceiving || '?'}` : null, 'warn'],
        ['Point-out', f.pointoutOrig ? `${f.pointoutOrig} ▸ ${f.pointoutRecv || '?'}` : null],
        ['Altitude', altSummary(f), 'hl'],
        ['Ground Spd', f.gs != null ? Math.round(f.gs) + ' kt' : null],
        ['Squawk', f.squawk],
        ['Assigned Sqk', f.assignedSquawk],
        ['Clearance', hsf(f), 'warn'],
        ['Position', f.lat != null ? `${f.lat.toFixed(3)}, ${f.lon.toFixed(3)}` : null],
        ['Pos age', f.posAgeSec != null ? f.posAgeSec + 's' : null],
        ['Coast', f.coast ? 'YES' : null, 'warn'],
        ['Status', f.status],
      ]);
    });
    return `<div class="card"><h2>POSITION / OWNERSHIP</h2>${rows}</div>`;
  }

  function flightPlanCard(f) {
    const plan = grid([
      ['Origin', f.origin], ['Destination', f.dest], ['Alternate', f.alternate],
      ['Rules', f.rules], ['Type', f.flightType], ['STAR', f.star],
      ['Req. Alt', f.reqAlt ? 'FL' + Math.round(f.reqAlt / 100) : null],
      ['Req. Speed', f.reqSpeed ? Math.round(f.reqSpeed) + ' kt' : null],
      ['EET (FIR)', f.eet], ['Operator', f.oper], ['Originator', f.originator], ['Remarks', f.remarks],
    ]);
    const cap = grid([
      ['Equipment', f.equip], ['PBN', f.pbn],
      ['Navigation', [f.nav, f.otherNav].filter(Boolean).join('  ')],
      ['Comm', [f.comm, f.otherComm].filter(Boolean).join('  ')],
      ['Data Link', [f.dataLink, f.otherDataLink].filter(Boolean).join('  ')],
      ['Surveillance', [f.surv, f.otherSurv].filter(Boolean).join('  ')],
      ['SELCAL', f.selcal], ['Performance', f.perf],
    ]);
    const route = (f.originalRoute || f.route) ? `<div class="subhdr">ROUTE</div><div class="route">${esc(f.originalRoute || f.route)}</div>` : '';
    return `<div class="card"><h2>FLIGHT PLAN <span class="tag">ICAO</span></h2>${plan}${route}<div class="subhdr">EQUIPMENT / CAPABILITIES</div>${cap}</div>`;
  }

  function tdlsCard(tdls) {
    let inner = '';
    tdls.forEach(entry => {
      const ac = entry.aircraft;
      inner += `<div class="subhdr">${esc(entry.airport)} · ${esc(ac.acType || '')}${ac.destination ? ' → ' + esc(ac.destination) : ''}</div>`;
      (ac.messages || []).slice().reverse().forEach(m => {
        if (m.type === 'DEPART') {
          const parts = [];
          if (m.gate) parts.push('Gate ' + m.gate);
          if (m.clearanceTime) parts.push('CLR ' + hhmm(m.clearanceTime));
          if (m.taxiTime) parts.push('TAXI ' + hhmm(m.taxiTime));
          if (m.takeoffTime) parts.push('T/O ' + hhmm(m.takeoffTime));
          if (m.runway) parts.push('RWY ' + m.runway);
          inner += `<div class="tmsg"><div class="th"><span class="badge dep">DEPARTURE</span><span>${hhmm(m.time)}</span></div><div class="body depline">${esc(parts.join('  ·  ') || '—')}</div></div>`;
        } else {
          const body = (m.dataBody || '').replace(/^\d{3}\s*/, '');
          inner += `<div class="tmsg"><div class="th"><span class="badge">CPDLC${m.destination ? ' → ' + esc(m.destination) : ''}</span><span>${hhmm(m.time)}</span></div><div class="body">${esc(body)}</div></div>`;
        }
      });
    });
    return `<div class="card"><h2>TDLS <span class="tag">clearance / departure</span></h2>${inner}</div>`;
  }

  function asdexCard(asdex) {
    let inner = '';
    asdex.forEach(e => {
      const t = e.track;
      inner += `<div class="subhdr">${esc(e.airport)} · SURFACE</div>`;
      inner += grid([
        ['Type', t.tgtType], ['Gate', t.gate || t.gateCode], ['Runway', t.runway],
        ['Speed', t.spdKts != null ? t.spdKts + ' kt' : null],
        ['Heading', t.hdg != null ? Math.round(t.hdg) + '°' : null],
        ['Altitude', t.altFt != null ? Math.round(t.altFt) + ' ft' : null],
        ['Squawk', t.squawk],
        ['Position', t.lat != null ? `${t.lat.toFixed(4)}, ${t.lon.toFixed(4)}` : null],
        ['Age', t.ageSec != null ? t.ageSec + 's' : null],
      ]);
    });
    return `<div class="card"><h2>SURFACE (ASDE-X)</h2>${inner}</div>`;
  }

  function taisCard(tais) {
    let inner = '';
    tais.forEach(t => {
      inner += `<div class="subhdr">${esc(t.facility)} · STARS</div>`;
      inner += grid([
        ['Track #', t.trackNum], ['Scratchpad', [t.sp1, t.sp2].filter(Boolean).join(' / ')],
        ['Runway', t.runway], ['Owner', t.owner], ['Handoff', t.handoff],
        ['Sqk (asgn)', t.assignedSqk], ['Sqk (rcvd)', t.reportedSqk],
        ['Altitude', t.altFt != null ? 'FL' + Math.round(t.altFt / 100) : null],
        ['Ground Spd', t.gs != null ? Math.round(t.gs) + ' kt' : null],
        ['Entry/Exit', [t.entryFix, t.exitFix].filter(Boolean).join(' → ')],
      ]);
    });
    return `<div class="card"><h2>TERMINAL (STARS / TAIS)</h2>${inner}</div>`;
  }

  function tfmsCard(t) {
    return `<div class="card"><h2>TRAFFIC FLOW (TFMS)</h2>${grid([
      ['Departure', t.depArpt], ['Arrival', t.arrArpt], ['Status', t.status], ['ETA', hhmm(t.eta)],
      ['STAR', t.star], ['Type', t.acType || t.acModel],
      ['Altitude', t.altitude ? Math.round(t.altitude) + ' ft' : null],
      ['Speed', t.speed ? Math.round(t.speed) + ' kt' : null],
    ])}</div>`;
  }

  // ── boot ──
  const initial = initialCallsign();
  if (initial) { $('cs').value = initial; startTrack(initial); } else { $('cs').focus(); }
})();
