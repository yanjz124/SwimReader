// Track a single flight — aggregates /api/track/{callsign} across all sources, mobile-first.
(function () {
  const $ = id => document.getElementById(id);
  const esc = s => (s == null ? '' : String(s)).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const out = $('out'), statusText = $('statusText'), dot = $('dot');
  let current = '', timer = null, lastData = null, selFac = null, fails = 0;
  function goText() { location.replace(current ? '/t/' + encodeURIComponent(current) : '/t'); }

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
    current = cs; selFac = null; lastData = null; fails = 0;
    const tl = $('txtlink'); if (tl) tl.href = '/t/' + encodeURIComponent(cs);
    // Data Saver / 2g connection → go straight to the light text version.
    try { const c = navigator.connection; if (c && (c.saveData || /2g/.test(c.effectiveType || ''))) { goText(); return; } } catch (e) { }
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
    const ctl = new AbortController();
    const to = setTimeout(function () { ctl.abort(); }, 9000);
    fetch('/api/track/' + encodeURIComponent(current), { signal: ctl.signal }).then(function (r) {
      clearTimeout(to);
      if (!r.ok) { dot.className = 'dot'; statusText.textContent = 'Error ' + r.status; return null; }
      dot.className = 'dot live'; fails = 0; return r.json();
    }).then(function (d) { if (d) { try { render(d); } catch (e) { statusText.textContent = 'Render error: ' + e.message; } } })
      .catch(function () {
        clearTimeout(to);
        dot.className = 'dot'; fails++;
        statusText.textContent = 'Slow / offline — retrying (' + fails + ')…';
        if (fails >= 3) goText();   // auto-fall back to the light text version
      });
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
    h += handoffHistoryCard(d.handoffHistory);
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
    const freq = f && f.sectorFreq;
    const ctrl = f ? (f.controllingFacility || '') + (f.controllingSector ? '/' + f.controllingSector : '') : '';
    return `<div class="hero">
      <div class="cs">${esc(d.callsign)}</div>
      <div class="od">${esc(org || '????')} <span class="arrow">▸</span> ${esc(dst || '????')}</div>
      <div class="sub">${esc(sub)}</div>
      ${freq ? `<div class="freq">&#9673; <b>${esc(freq)}</b> MHz <span>${esc(ctrl)}</span></div>` : ''}
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
  const pad = (s, w) => { s = String(s); return s + ' '.repeat(Math.max(0, w - s.length)); };
  // Field E as HTML: emergency, or a FLASHING handoff indicator (H|O + sector) alternating with
  // groundspeed (like a real ERAM block), or just groundspeed. Flash is driven by body.fp toggle.
  function eramFieldEHtml(f) {
    const gs = f.gs != null ? String(Math.round(f.gs)) : '';
    if (f.squawk === '7700') return '<span class="emrg">EMRG</span>';
    if (f.squawk === '7600') return '<span class="emrg">RDOF</span>';
    if (f.squawk === '7500') return '<span class="emrg">HIJK</span>';
    if (f.handoffEvent && f.handoffReceiving) {
      const ind = (/ACCEPT|OK/i.test(f.handoffEvent) ? 'O' : 'H') + extractSec(f.handoffReceiving);
      const w = Math.max(ind.length, gs.length);
      return `<span class="feflash"><span class="fa">${esc(pad(ind, w))}</span><span class="fb">${esc(pad(gs, w))}</span></span>`;
    }
    return esc(gs);
  }
  function eramLine4(f) {
    if (f.clrText) return f.clrText;
    const hs = []; if (f.clrHeading) hs.push('H' + f.clrHeading); if (f.clrSpeed) hs.push(f.clrSpeed);
    if (hs.length) return hs.join(' ');
    return lid(f.dest);
  }
  function eramBlockHtml(f) {
    if (!f) return null;
    const cid = (f.cids && f.controllingFacility && f.cids[f.controllingFacility]) || f.cid || '----';
    const L = [];
    if (f.pointoutOrig || f.pointoutRecv) L.push('  <span class="po">P</span>');  // line 0: point-out (flashes via .po)
    L.push('◇ ' + esc(f.callsign || '???'));           // line 1
    L.push('   ' + esc(altLine(f)));                        // line 2
    L.push('   ' + esc(cid) + ' ' + eramFieldEHtml(f));     // line 3: CID + Field E
    const l4 = eramLine4(f); if (l4) L.push('   ' + esc(l4));  // line 4: HSF or destination
    return L.join('\n');
  }
  function starsBlockHtml(t) {
    if (!t) return null;
    const alt = t.altFt != null ? String(Math.round(t.altFt / 100)).padStart(3, '0') : '---';
    const trend = t.vs > 200 ? '↑' : (t.vs < -200 ? '↓' : ' ');
    const gs = t.gs != null ? String(Math.round(t.gs / 10)).padStart(2, '0') : '';
    const L = [esc(t.callsign || '???'), esc(`${alt}${trend}  ${gs}`)];
    const sp = [t.sp1, t.sp2].filter(Boolean).join(' '); if (sp) L.push(esc(sp));
    const own = [];
    if (t.owner) own.push(esc('OWN ' + t.owner));
    if (t.handoff) own.push('<span class="blink">' + esc('→' + t.handoff) + '</span>');  // handoff flashes
    if (t.exitFix) own.push(esc('X:' + t.exitFix));
    if (own.length) L.push(own.join('  '));
    return L.join('\n');
  }
  function blocksCard(flights, taisList) {
    let f = flights.find(function (x) { return (x.controllingFacility || x.reportingFacility) === selFac; }) || flights[0] || null;
    const tais = taisList[0] || null;
    const e = eramBlockHtml(f);
    const s = tais ? starsBlockHtml(tais) : (f ? starsBlockHtml({ callsign: f.callsign, altFt: f.reportedAlt, gs: f.gs, sp1: lid(f.dest), vs: 0, exitFix: f.star, handoff: f.handoffReceiving ? extractSec(f.handoffReceiving) : null }) : null);
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
    if (e) inner += `<div class="db"><div class="lbl">ERAM · ${esc((f && (f.controllingFacility || f.reportingFacility)) || 'EN ROUTE')}</div><div class="eram-db">${e}</div></div>`;
    if (s) inner += `<div class="db"><div class="lbl">STARS · ${esc((tais && tais.facility) || 'TERMINAL')}</div><div class="stars-db">${s}</div></div>`;
    return `<div class="card"><h2>DATA BLOCK <span class="tag">live — handoff flashes</span></h2>${sel}<div class="blocks">${inner}</div></div>`;
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
    const e = f.handoffEvent.toUpperCase();
    let st = e;
    if (/ACCEPT/.test(e)) st = 'ACCEPTED — control transferring';
    else if (/INITIAT|PROPOS/.test(e)) st = 'PENDING — proposed';
    else if (/EXECUT/.test(e)) st = 'EXECUTING';
    else if (/RETRACT/.test(e)) st = 'RETRACTED';
    else if (/FAIL/.test(e)) st = 'FAILED';
    return `${st}  ·  ${f.handoffTransferring || '?'} ▸ ${f.handoffReceiving || '?'}`;
  }
  // All ARTCCs that touch this callsign (controlling + reporting + every facility with a CID) —
  // shown as a stable set instead of a single reportingFacility that flip-flops between centres.
  function reportingArtccs(flights) {
    const s = [];
    const add = x => { if (x && s.indexOf(x) < 0) s.push(x); };
    flights.forEach(function (f) { add(f.controllingFacility); add(f.reportingFacility); if (f.cids) Object.keys(f.cids).forEach(add); });
    return s.length ? s.join('  ') : null;
  }

  function ownershipCard(flights) {
    if (!flights.length) return '';
    let rows = grid([['Tracked by', reportingArtccs(flights), 'hl']]);
    flights.forEach(function (f, i) {
      rows += `<div class="subhdr">${esc(f.controllingFacility || f.reportingFacility || '?')}${i > 0 ? ' (also tracking)' : ''}</div>`;
      const ho = handoffStr(f);
      rows += grid([
        ['Controlling', f.controllingFacility ? f.controllingFacility + (f.controllingSector ? '/' + f.controllingSector : '') : '—', 'hl'],
        ['Frequency', f.sectorFreq ? f.sectorFreq + ' MHz' : null, 'hl'],
        ['CIDs', cidsStr(f)],
        ['Handoff', ho ? (ho + (f.handoffFreq ? '  ·  ' + f.handoffFreq + ' MHz' : '')) : 'none pending', ho ? 'warn' : ''],
        ['Point-out', f.pointoutOrig ? `${f.pointoutOrig} ▸ ${f.pointoutRecv || '?'}` : null],
        ['Altitude', altSummary(f), 'hl'],
        ['Line 4 (HSF)', hsf(f), 'warn'],
        ['Ground Spd', f.gs != null ? Math.round(f.gs) + ' kt' : null],
        ['Squawk', f.squawk], ['Assigned Sqk', f.assignedSquawk],
        ['Position', f.lat != null ? `${f.lat.toFixed(3)}, ${f.lon.toFixed(3)}` : null],
        ['Pos age', f.posAgeSec != null ? f.posAgeSec + 's' : null],
        ['Coast', f.coast ? 'YES' : null, 'warn'],
        ['Status', f.status],
      ]);
    });
    return `<div class="card"><h2>POSITION / OWNERSHIP</h2>${rows}</div>`;
  }

  function handoffHistoryCard(hist) {
    if (!hist || !hist.length) return '';
    const rows = hist.map(function (h) {
      return `<div class="tmsg"><div class="th"><span class="badge">${esc(h.source)}${h.centre ? ' · ' + esc(h.centre) : ''}</span><span>${esc(hhmm(h.time) || h.time)}</span></div><div class="body">${esc(h.summary || '')}</div></div>`;
    }).join('');
    return `<div class="card"><h2>HANDOFF / POINT-OUT HISTORY</h2>${rows}</div>`;
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
  setInterval(function () { document.body.classList.toggle('fp'); }, 500);  // drives handoff/point-out flash
  const initial = initialCallsign();
  if (initial) { $('cs').value = initial; startTrack(initial); } else { try { $('cs').focus(); } catch (e) { } }
})();
