// Track a single flight — aggregates /api/track/{callsign} across all sources, mobile-first.
(function () {
  const $ = id => document.getElementById(id);
  const esc = s => (s == null ? '' : String(s)).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const out = $('out'), statusText = $('statusText'), dot = $('dot');
  let current = '', timer = null, lastData = null, selFac = null;

  // ── format helpers ──
  const fl = a => (a == null ? null : String(Math.round(a / 100)).padStart(3, '0'));
  const lid = a => (a && a.length === 4 && a[0] === 'K') ? a.slice(1) : (a || '');
  const stripRmk = s => (s == null ? '' : String(s).replace(/\|/g, ' ').replace(/\s+/g, ' ').trim());
  const extractSec = s => { if (!s) return ''; const i = String(s).indexOf('/'); return i >= 0 ? s.slice(i + 1) : s; };
  // iOS Safari is strict about ISO strings with >3 fractional-second digits — parse defensively.
  function pd(iso) { if (!iso) return null; let d = new Date(iso); if (!isNaN(d.getTime())) return d; d = new Date(String(iso).replace(/(\.\d{3})\d+/, '$1').replace(' ', 'T')); return isNaN(d.getTime()) ? null : d; }
  function agoStr(iso) { const d = pd(iso); if (!d) return ''; const s = Math.round((Date.now() - d.getTime()) / 1000); if (s < 1) return 'now'; if (s < 60) return s + 's ago'; if (s < 3600) return Math.round(s / 60) + 'm ago'; return Math.round(s / 3600) + 'h ago'; }
  function hhmm(iso) { const d = pd(iso); if (!d) return ''; return String(d.getUTCHours()).padStart(2, '0') + String(d.getUTCMinutes()).padStart(2, '0') + 'Z'; }
  function grid(rows) {
    const r = rows.filter(x => x[1] != null && x[1] !== '');
    if (!r.length) return '';
    return `<div class="grid">${r.map(([k, v, c]) => `<span class="k">${esc(k)}</span><span class="v${c ? ' ' + c : ''}">${esc(v)}</span>`).join('')}</div>`;
  }

  // ── routing / search ──
  function initialCallsign() { const m = location.pathname.match(/^\/track\/([A-Za-z0-9]+)/); return m ? m[1].toUpperCase() : ''; }
  $('f').addEventListener('submit', function (e) {
    e.preventDefault();
    const cs = $('cs').value.trim().toUpperCase();
    if (!cs) return;
    history.pushState({}, '', '/track/' + encodeURIComponent(cs));
    $('cs').blur();
    startTrack(cs);
  });
  window.addEventListener('popstate', function () { const cs = initialCallsign(); if (cs) { $('cs').value = cs; startTrack(cs); } });
  window.trackSelFac = function (fac) { selFac = fac; if (lastData) render(lastData); };

  function startTrack(cs) {
    current = cs; selFac = null; lastData = null;
    if (timer) clearInterval(timer);
    out.innerHTML = '';
    statusText.textContent = 'Loading ' + cs + '…';
    poll();
    timer = setInterval(poll, 4000);
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { if (timer) { clearInterval(timer); timer = null; } }
    else if (current && !timer) { poll(); timer = setInterval(poll, 4000); }
  });

  function poll() {
    if (!current) return;
    fetch('/api/track/' + encodeURIComponent(current)).then(function (r) {
      if (!r.ok) { dot.className = 'dot'; statusText.textContent = 'Error ' + r.status; return null; }
      dot.className = 'dot live'; return r.json();
    }).then(function (d) { if (d) { try { render(d); } catch (e) { statusText.textContent = 'Render error: ' + e.message; } } })
      .catch(function () { dot.className = 'dot'; statusText.textContent = 'Offline — retrying…'; });
  }

  // ── render ──
  function render(d) {
    lastData = d;
    if (!d.found) {
      statusText.textContent = 'No live data for ' + d.callsign;
      out.innerHTML = `<div class="msg">Nothing is tracking <b>${esc(d.callsign)}</b> right now.<br>It may not be airborne or filed yet. Use the exact callsign (e.g. AAL123, not AA123).</div>`;
      return;
    }
    statusText.textContent = `Tracking ${d.callsign} · updated ${agoStr(d.ts) || 'now'}`;
    const flights = (d.sfdps || []).slice().sort(function (a, b) {
      const ap = a.lat != null ? 0 : 1, bp = b.lat != null ? 0 : 1;
      return ap !== bp ? ap - bp : (a.posAgeSec == null ? 9999 : a.posAgeSec) - (b.posAgeSec == null ? 9999 : b.posAgeSec);
    });
    const taisList = d.tais || [];
    const asd = (d.asdex || [])[0] || null;

    let h = '';
    h += heroCard(d, flights[0] || null, taisList[0] || null, asd);
    h += blocksCard(flights, taisList);
    h += ownershipCard(flights);
    if (d.edct) h += `<div class="card"><h2>EDCT <span class="tag">departure slot</span></h2>${grid([['Controlled Departure', hhmm(d.edct), 'hl'], ['Slot', String(d.edct).slice(0, 16).replace('T', ' ') + 'Z']])}</div>`;
    if (flights[0]) h += flightPlanCard(flights[0]);
    if (d.tdls && d.tdls.length) h += tdlsCard(d.tdls);
    if (d.asdex && d.asdex.length) h += asdexCard(d.asdex);
    if (taisList.length) h += taisCard(taisList);
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
    const type = (f && f.acType) || (tais && tais.acType) || (asd && asd.track.acType) || (d.tfms && d.tfms.acType) || '';
    const wake = (f && f.wake) ? '/' + f.wake : '';
    const org = (f && f.origin) || (tais && tais.origin) || (asd && asd.track.origin) || (d.tfms && d.tfms.depArpt) || '';
    const dst = (f && f.dest) || (tais && tais.dest) || (asd && asd.track.dest) || (d.tfms && d.tfms.arrArpt) || '';
    const ph = phaseOf(d, f, tais, asd);
    const chips = [['SFDPS', (d.sfdps || []).length > 0], ['TFMS', !!d.tfms], ['TDLS', (d.tdls || []).length > 0],
      ['STARS', (d.tais || []).length > 0], ['ASDE-X', (d.asdex || []).length > 0], ['EDCT', !!d.edct]]
      .map(function (x) { return `<span class="chip${x[1] ? ' on' : ''}">${x[0]}</span>`; }).join('');
    const sub = [type + wake, (f && f.registration) || ''].filter(Boolean).join(' · ');
    return `<div class="hero">
      <div class="cs">${esc(d.callsign)}</div>
      <div class="od">${esc(org || '????')} <span class="arrow">▸</span> ${esc(dst || '????')}</div>
      <div class="sub">${esc(sub)}</div>
      <div class="phase" style="background:#111;color:${ph[1]};border-color:${ph[1]}66">${ph[0]}</div>
      <div class="chips">${chips}</div>
    </div>`;
  }

  // ── mock data blocks ──
  function altLine(f) {
    const aFL = fl(f.assignedAlt), rFL = fl(f.reportedAlt), iFL = fl(f.interimAlt);
    if (f.blockFloor != null && f.blockCeil != null) return `${fl(f.blockFloor)}B${fl(f.blockCeil)}`;
    if (f.assignedVfr) return 'VFR' + (rFL ? '/' + rFL : '');
    if (iFL) return `${iFL}T${rFL || '---'}`;
    if (aFL) { if (rFL == null) return aFL; const dd = parseInt(rFL) - parseInt(aFL); return Math.abs(dd) <= 2 ? `${aFL}C` : `${aFL}${dd < 0 ? '↑' : '↓'}${rFL}`; }
    return rFL || '---';
  }
  function eramFieldE(f) {
    if (f.squawk === '7700') return 'EMRG'; if (f.squawk === '7600') return 'RDOF'; if (f.squawk === '7500') return 'HIJK';
    if (f.handoffEvent && f.handoffReceiving) return (/ACCEPT|OK/i.test(f.handoffEvent) ? 'O' : 'H') + extractSec(f.handoffReceiving);
    return f.gs != null ? String(Math.round(f.gs)) : '';
  }
  function eramLine4(f) {
    if (f.clrText) return f.clrText;
    const hs = []; if (f.clrHeading) hs.push('H' + f.clrHeading); if (f.clrSpeed) hs.push(f.clrSpeed);
    if (hs.length) return hs.join(' ');
    return lid(f.dest);
  }
  function eramBlock(f) {
    if (!f) return null;
    const cid = (f.cids && f.controllingFacility && f.cids[f.controllingFacility]) || f.cid || '----';
    const lines = [];
    if (f.pointoutOrig || f.pointoutRecv) lines.push('  P');   // line 0: point-out
    lines.push('◇ ' + (f.callsign || '???'));             // line 1: ◇ callsign
    lines.push('   ' + altLine(f));                            // line 2: altitude
    lines.push('   ' + cid + ' ' + eramFieldE(f));             // line 3: CID + Field E (handoff/GS)
    const l4 = eramLine4(f); if (l4) lines.push('   ' + l4);   // line 4: HSF or destination
    return lines.join('\n');
  }
  function starsBlock(t) {
    if (!t) return null;
    const alt = t.altFt != null ? String(Math.round(t.altFt / 100)).padStart(3, '0') : '---';
    const trend = t.vs > 200 ? '↑' : (t.vs < -200 ? '↓' : ' ');
    const gs = t.gs != null ? String(Math.round(t.gs / 10)).padStart(2, '0') : '';
    const lines = [t.callsign || '???', `${alt}${trend}  ${gs}`];
    const sp = [t.sp1, t.sp2].filter(Boolean).join(' '); if (sp) lines.push(sp);
    const own = [];
    if (t.owner) own.push('OWN ' + t.owner);
    if (t.handoff) own.push('→' + t.handoff);
    if (t.exitFix) own.push('X:' + t.exitFix);
    if (own.length) lines.push(own.join('  '));
    return lines.join('\n');
  }
  function blocksCard(flights, taisList) {
    let f = flights.find(function (x) { return (x.controllingFacility || x.reportingFacility) === selFac; }) || flights[0] || null;
    const tais = taisList[0] || null;
    const e = eramBlock(f);
    const s = tais ? starsBlock(tais) : (f ? starsBlock({ callsign: f.callsign, altFt: f.reportedAlt, gs: f.gs, sp1: lid(f.dest), vs: 0, exitFix: f.star }) : null);
    if (!e && !s) return '';
    let sel = '';
    if (flights.length > 1) {
      sel = '<div class="facsel">' + flights.map(function (x) {
        const fc = x.controllingFacility || x.reportingFacility || '?';
        const c = (x.cids && x.cids[fc]) ? ' · ' + x.cids[fc] : '';
        return `<button class="facbtn${x === f ? ' on' : ''}" onclick="trackSelFac('${esc(fc)}')">${esc(fc)}${esc(c)}</button>`;
      }).join('') + '</div>';
    }
    let inner = '';
    if (e) inner += `<div class="db eram"><div class="lbl">ERAM · ${esc((f && (f.controllingFacility || f.reportingFacility)) || 'EN ROUTE')}</div><pre>${esc(e)}</pre></div>`;
    if (s) inner += `<div class="db stars"><div class="lbl">STARS · ${esc((tais && tais.facility) || 'TERMINAL')}</div><pre>${esc(s)}</pre></div>`;
    return `<div class="card"><h2>DATA BLOCK <span class="tag">as a controller sees it</span></h2>${sel}<div class="blocks">${inner}</div></div>`;
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
  function cidsStr(f) { if (!f.cids) return null; return Object.keys(f.cids).map(function (k) { return k + ':' + f.cids[k]; }).join('   '); }
  function handoffStr(f) {
    if (!f.handoffEvent) return null;
    const accepted = /ACCEPT|OK/i.test(f.handoffEvent);
    return `${accepted ? 'ACCEPTED' : 'PROPOSED'}  ${f.handoffTransferring || '?'} ▸ ${f.handoffReceiving || '?'}`;
  }

  function ownershipCard(flights) {
    if (!flights.length) return '';
    let rows = '';
    flights.forEach(function (f, i) {
      if (i > 0) rows += `<div class="subhdr">ALSO TRACKED BY ${esc(f.reportingFacility || f.controllingFacility || '?')}</div>`;
      rows += grid([
        ['Controlling', f.controllingFacility ? f.controllingFacility + (f.controllingSector ? '/' + f.controllingSector : '') : '—', 'hl'],
        ['Reporting', f.reportingFacility],
        ['CIDs', cidsStr(f)],
        ['Handoff', handoffStr(f), 'warn'],
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
      ['EET (FIR)', f.eet], ['Operator', f.oper], ['Originator', f.originator], ['Remarks', stripRmk(f.remarks) || null],
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
    tdls.forEach(function (entry) {
      const ac = entry.aircraft;
      inner += `<div class="subhdr">${esc(entry.airport)} · ${esc(ac.acType || '')}${ac.destination ? ' → ' + esc(ac.destination) : ''}</div>`;
      (ac.messages || []).slice().reverse().forEach(function (m) {
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
    asdex.forEach(function (e) {
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
    tais.forEach(function (t) {
      inner += `<div class="subhdr">${esc(t.facility)} · STARS</div>`;
      inner += grid([
        ['Track #', t.trackNum], ['Scratchpad', [t.sp1, t.sp2].filter(Boolean).join(' / ')],
        ['Runway', t.runway], ['Owner', t.owner], ['Handoff', t.handoff, 'warn'],
        ['Entry Fix', t.entryFix], ['Exit Fix', t.exitFix],
        ['Sqk (asgn)', t.assignedSqk], ['Sqk (rcvd)', t.reportedSqk],
        ['Altitude', t.altFt != null ? 'FL' + Math.round(t.altFt / 100) : null],
        ['Ground Spd', t.gs != null ? Math.round(t.gs) + ' kt' : null],
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
  if (initial) { $('cs').value = initial; startTrack(initial); } else { try { $('cs').focus(); } catch (e) { } }
})();
