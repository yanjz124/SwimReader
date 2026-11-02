// ─────────────────────────────────────────────────────────────────────────
// Airport display names that keep up with the real world.
//
// The directory pages each carry a curated AIRPORT_NAMES table, which reads far better in a card
// than a full legal name does ("CHICAGO O'HARE", not "Chicago O'Hare International Airport"). But a
// hand-written table can't follow a rename: when PBI became DJT the new identifier simply wasn't in
// it, so the card went blank.
//
// So: curated label first, server lookup for anything it doesn't cover. /api/airports/find is
// backed by OurAirports (refreshed monthly) plus NASR (28-day cycle), and it resolves the retired
// identifier as well as the new one — so a future rename fills itself in, from either direction,
// with nobody editing a table.
//
// Filling happens AFTER render, so a slow or failed lookup can never hold up the page; the card
// just keeps whatever the table gave it.
// ─────────────────────────────────────────────────────────────────────────
window.AirportNames = (function () {
  const cache = new Map();          // code → short display name ('' = looked up, nothing useful)

  // Card labels are short and uppercase. Drop the boilerplate every airport name carries so the
  // distinguishing part is what survives.
  const BOILERPLATE =
    /\b(international|intl|regional|rgnl|municipal|muni|metropolitan|county|field|airport|airfield|air\s+park|airpark|air\s+force\s+base|afb)\b/gi;

  function shorten(name, city) {
    let s = String(name || '').replace(BOILERPLATE, ' ').replace(/[\s,\-]{2,}/g, ' ').trim();
    s = s.replace(/[\s,\-]+$/, '');
    if (s.length < 3) s = city || name || '';
    return s.toUpperCase();
  }

  async function lookup(codes) {
    const want = [...new Set(codes)].filter(c => c && !cache.has(c));
    if (!want.length) return;
    // Mark them resolved up front so a second fill() for the same page doesn't re-request.
    for (const c of want) cache.set(c, '');
    try {
      const r = await fetch('/api/airports/find?codes=' + encodeURIComponent(want.join(',')));
      if (!r.ok) return;
      const d = await r.json();
      for (const a of (d.airports || [])) {
        if (a && a.code && a.name) cache.set(a.code, shorten(a.name, a.city));
      }
    } catch { /* offline → cards keep their curated label */ }
  }

  // Fill in any .card-name left empty by the curated table. Cards opt in with data-icao.
  async function fill(root) {
    const scope = root || document;
    const blanks = [...scope.querySelectorAll('[data-icao]')].filter(el => {
      const n = el.querySelector('.card-name');
      return n && !n.textContent.trim();
    });
    if (!blanks.length) return;
    await lookup(blanks.map(el => el.getAttribute('data-icao')));
    for (const el of blanks) {
      const name = cache.get(el.getAttribute('data-icao'));
      if (!name) continue;
      const n = el.querySelector('.card-name');
      if (n && !n.textContent.trim()) n.textContent = name;
    }
  }

  return { fill, lookup, shorten, get: (code, table) => (table && table[code]) || cache.get(code) || '' };
})();
