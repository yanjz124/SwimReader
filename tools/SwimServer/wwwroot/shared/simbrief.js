/* ─────────────────────────────────────────────────────────────────────────────
 * SimBrief / VATSIM hand-off — shared by the route finder (/dispatch) and the
 * flight table. Both pages let you pick a real airframe, override the ICAO type
 * and choose a SimBrief variant, then open SimBrief pre-filled.
 *
 * WHY THIS IS SHARED. It was implemented twice, and the two copies drifted:
 *   - The same bug had to be fixed twice on the same day — overriding TYPE
 *     reloaded the VARIANT list but not the AIRFRAME list, so SimBrief could be
 *     handed a tail whose real type contradicted the chosen type.
 *   - The two URL builders disagreed about where Mode-S goes, and only one of
 *     them sent equipment/PBN/remarks at all, although the route finder's API
 *     has returned those fields all along.
 * Anything that decides WHAT SimBrief receives belongs here. Page-specific
 * things — how a row is rendered, how a NAS route string is cleaned — stay on
 * the page; each one normalizes its own record into the `flight` shape below.
 *
 * THE DOCUMENTED CONTRACT (developers.navigraph.com/docs/simbrief/using-the-api).
 * Getting these wrong fails silently — SimBrief just ignores the parameter and
 * opens with the field blank, which is why the drift went unnoticed:
 *   - `hexcode` is an **acdata** field, NOT a top-level parameter.
 *   - `extrarmk` is an **acdata** field too. The top-level spelling does
 *     nothing (`manualrmk` is the unrelated top-level remarks option).
 *   - `cat`, `equip` and `transponder` must be given **all three together or
 *     all three are ignored**. Partial sets are silently dropped.
 *   - Top-level: airline, fltnum, callsign, type, orig, dest, altn, route, fl,
 *     reg, selcal, units, flightrules, acdata (URL-encoded JSON).
 *
 * `flight` shape — every field optional, pass what the page knows:
 *   callsign fltnum airline type reg modeS
 *   orig dest altn route        (route already cleaned by the caller)
 *   flLevel                     (altitude in HUNDREDS of feet, e.g. 360)
 *   vfr                         (bool)
 *   wake transponder pbn        (ICAO field 10 bits)
 *   comCode navCode datalinkCode equipQualifier   (assembled into acdata.equip)
 *   comOther datOther surOther  (→ COM/ DAT/ SUR/ in acdata.extrarmk)
 *   remarks                     (→ RMK/ in acdata.extrarmk)
 * `af` — the chosen airframe: null = generic (send no tail), undefined = "use
 * the flight's own", or an aircraft-DB record {registration, type, selcal, icao24}.
 * ───────────────────────────────────────────────────────────────────────────── */
(function () {
    'use strict';

    const BASE = 'https://dispatch.simbrief.com/options/custom?';

    // ── caches, shared by every picker on a page ─────────────────────────────
    const _tails = new Map(), _fleets = new Map(), _variants = new Map();
    let _types = null;

    const j = (r) => r.ok ? r.json() : null;

    function tail(reg) {
        reg = (reg || '').trim().toUpperCase();
        // 'LADD' is the masking label a blocked flight carries in place of a registration, not a
        // tail — looking it up would be meaningless and would cache a null under a fake reg.
        if (!reg || reg === 'LADD') return Promise.resolve(null);
        if (!_tails.has(reg)) _tails.set(reg,
            fetch('/api/aircraft/' + encodeURIComponent(reg)).then(j).catch(() => null));
        return _tails.get(reg);
    }

    function fleet(type, operator) {
        if (!type || !operator) return Promise.resolve([]);
        const k = type + '|' + operator;
        if (!_fleets.has(k)) _fleets.set(k,
            fetch(`/api/aircraft/list?type=${encodeURIComponent(type)}&operator=${encodeURIComponent(operator)}&sort=lastSeen&limit=500`)
                .then(r => r.ok ? r.json() : { results: [] })
                .then(d => (d && d.results) || []).catch(() => []));
        return _fleets.get(k);
    }

    function variants(type) {
        type = (type || '').toUpperCase();
        if (!type) return Promise.resolve([]);
        if (!_variants.has(type)) _variants.set(type,
            fetch('/api/simbrief/airframes/' + encodeURIComponent(type))
                .then(r => r.ok ? r.json() : []).catch(() => []));
        return _variants.get(type);
    }

    // Every ICAO type SimBrief has an airframe for — the TYPE field's datalist.
    function types() {
        if (!_types) _types = fetch('/api/simbrief/types')
            .then(r => r.ok ? r.json() : []).catch(() => []);
        return _types;
    }

    // The remembered variant is keyed by SimBrief's family head, so one choice
    // covers E175/E75L/E75S. The 'dispatch.' prefix predates the flight table
    // using it; both pages share the key deliberately, so don't rename it.
    const variantKey = (t) => 'dispatch.sbVariant.' + t;

    // ── what SimBrief receives ───────────────────────────────────────────────
    /**
     * ICAO field-10a equipment string: COM + NAV, plus any datalink J-codes,
     * falling back to the filed equipment qualifier, always including S.
     * Assembled here so both pages produce the same string from whichever bits
     * their source happens to carry (the route finder's history records have no
     * communicationCode, for instance).
     */
    function equipString(flight) {
        let e = '';
        if (flight.comCode) e += String(flight.comCode).replace(/\s+/g, '');
        if (flight.navCode) e += String(flight.navCode).replace(/\s+/g, '');
        if (flight.datalinkCode) {
            for (const jc of (String(flight.datalinkCode).match(/J\d/g) || []))
                if (!e.includes(jc)) e += jc;
        }
        if (!e) e = flight.equipQualifier || 'S';
        if (!e.includes('S')) e = 'S' + e;
        return e;
    }

    function acdata(flight, af) {
        const ac = {};
        const hex = af === undefined ? flight.modeS : (af && af.icao24);
        if (hex) ac.hexcode = hex;

        // All three or none — a partial set is discarded by SimBrief, so there
        // is nothing to gain by sending one. Note we do not invent a missing
        // transponder: it is a real capability field, not a formatting detail.
        const xpdr = flight.transponder ? String(flight.transponder).replace(/\s+/g, '') : '';
        if (flight.wake && xpdr) {
            ac.cat = flight.wake;
            ac.equip = equipString(flight);
            ac.transponder = xpdr;
        }
        if (flight.pbn) ac.pbn = 'PBN/' + String(flight.pbn).replace(/\s+/g, '');

        const extra = [];
        if (flight.comOther) extra.push('COM/' + String(flight.comOther).trim());
        if (flight.datOther) extra.push('DAT/' + String(flight.datOther).trim());
        if (flight.surOther) extra.push('SUR/' + String(flight.surOther).trim());
        if (flight.remarks) extra.push('RMK/' + String(flight.remarks).replace(/\|/g, '').trim());
        if (extra.length) ac.extrarmk = extra.join(' ');

        return ac;
    }

    /**
     * Build the SimBrief dispatch URL.
     * Type precedence: chosen VARIANT → explicit TYPE override → the chosen
     * tail's own type → what was filed. The override exists because the filed
     * ICAO often has no SimBrief airframe (E75L) or isn't what you want to fly
     * (B738 filed, B38M add-on).
     */
    function url(flight, af, variant, typeOverride) {
        const p = new URLSearchParams();
        if (flight.airline) p.set('airline', flight.airline);
        if (flight.fltnum) p.set('fltnum', flight.fltnum);
        if (flight.callsign) p.set('callsign', flight.callsign);

        const type = variant || typeOverride || (af && af.type) || flight.type;
        if (type) p.set('type', type);

        if (flight.orig) p.set('orig', flight.orig);
        if (flight.dest) p.set('dest', flight.dest);
        if (flight.altn) p.set('altn', flight.altn);
        if (flight.route) p.set('route', flight.route);

        if (flight.flLevel) p.set('fl', String(flight.flLevel));
        if (flight.vfr) p.set('flightrules', 'v');

        const reg = af === undefined ? flight.reg : (af && af.registration);
        if (reg) p.set('reg', reg);
        const selcal = af === undefined ? null : (af && af.selcal);
        if (selcal) p.set('selcal', selcal);

        const ac = acdata(flight, af);
        if (Object.keys(ac).length) p.set('acdata', JSON.stringify(ac));

        p.set('units', 'LBS');
        return BASE + p.toString();
    }

    // ── airframe selection policy ────────────────────────────────────────────
    const label = (a) =>
        `${a.registration}${a.selcal ? '  ·  SEL ' + a.selcal : ''}${a.icao24 ? '  ·  ' + a.icao24 : ''}`;

    /**
     * Which tail to select after the TYPE was overridden by hand.
     *
     * Keep the current one only if it actually IS the new type. The flight's own
     * registration stays listed under "This flight" whatever TYPE says, so a
     * plain "keep whatever is still offered" rule left a B738 selected while
     * TYPE read B38M — the mismatch the fleet reload exists to remove. A tail we
     * hold no DB record for is kept: it was typed in by hand, so it was asked
     * for by name.
     *
     * `offered` says whether `prev` still appears in the rebuilt list.
     */
    function chooseTailForType(prev, recs, fleetList, type, offered) {
        const rec = prev && recs ? recs.get(prev) : null;
        if (offered && (!rec || !rec.type || rec.type.toUpperCase() === type)) return prev;
        // Not simply "the first option" — that is the flight's own tail, the one
        // just rejected.
        const first = (fleetList || []).find(a =>
            a.registration && (!a.type || a.type.toUpperCase() === type));
        if (first) return first.registration;
        return offered ? prev : '';
    }

    window.SimBrief = { tail, fleet, variants, types, variantKey, url, acdata, equipString, label, chooseTailForType };
})();
