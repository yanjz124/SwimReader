// ─────────────────────────────────────────────────────────────────────────────
// The TBFM adaptation map, shared by the center board and the airport board.
//
// Both pages draw the same things — meter fixes and arcs, ARTCC boundaries, and the metered
// traffic joined to SFDPS positions — and differ only in WHICH points and which flights. Keeping
// one implementation is deliberate: this file holds the geometry that is easy to get wrong
// (arc_direction, the point ON an arc rather than its center, knots-to-degrees) and the repo has
// already paid twice for two copies of one rule drifting apart.
//
// A TBFM meter point is either a FIX (MFX, a named point with a position) or an ARC
// (MFA / OMA / OOA / O3A / O4A — a segment of a circle at a given radius from the TRACON
// reference, spanning bearings `lan` → `ran` clockwise). The arc geometry is published in full,
// so these draw as the real thing rather than a sketch: **lat/lon is the arc's CENTER, not a
// point on it.**
// ─────────────────────────────────────────────────────────────────────────────
(function () {
    'use strict';

    const R_NM = 3440.065;   // earth radius in nautical miles

    // Arc / fix colors by point type. Meter fixes are the ERAM yellow the rest of the site uses;
    // the arcs step outward through cooler colors so nested rings read at a glance.
    const TYPE_COLOR = {
        MFX: '#cccc44', MFA: '#ff9944', OMA: '#44bbdd',
        OOA: '#6688ff', O3A: '#aa66dd', O4A: '#dd66aa',
    };

    /** Point at `distNm` on bearing `brg` (degrees true) from lat/lon. */
    function dest(lat, lon, brg, distNm) {
        const d = distNm / R_NM, t = brg * Math.PI / 180;
        const p1 = lat * Math.PI / 180, l1 = lon * Math.PI / 180;
        const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(t));
        const l2 = l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(p1),
            Math.cos(d) - Math.sin(p1) * Math.sin(p2));
        return [p2 * 180 / Math.PI, ((l2 * 180 / Math.PI + 540) % 360) - 180];
    }

    /** Bearing from (lat,lon) to (lat2,lon2), degrees true. */
    function bearing(lat, lon, lat2, lon2) {
        const p1 = lat * Math.PI / 180, p2 = lat2 * Math.PI / 180, dl = (lon2 - lon) * Math.PI / 180;
        const y = Math.sin(dl) * Math.cos(p2);
        const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
        return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    }

    /** The arc from `lan` to `ran`, clockwise, as a polyline. */
    function arcPath(lat, lon, radiusNm, lan, ran) {
        let span = (ran - lan + 360) % 360;
        if (span === 0) span = 360;                   // a full ring, not a zero-length line
        const steps = Math.max(8, Math.ceil(span / 3));
        const pts = [];
        for (let i = 0; i <= steps; i++) pts.push(dest(lat, lon, lan + span * i / steps, radiusNm));
        return pts;
    }

    /**
     * Where on a meter point a flight is actually heading.
     *
     * For a FIX that is the fix. For an ARC it is NOT the published lat/lon — that is the arc's
     * CENTER (the TRACON reference), so a leader drawn to it would point at a spot the aircraft is
     * never cleared to and, on a 50 nm arc, be wrong by 50 nm. The real target is the point on the
     * arc nearest the aircraft: the bearing from the center, clamped into the arc's clockwise span.
     */
    function pointTarget(p, lat, lon) {
        if (!p || p.lat == null || p.lon == null) return null;
        if (!p.radiusNm || p.leftAngle == null || p.rightAngle == null) return [p.lat, p.lon];
        let span = (p.rightAngle - p.leftAngle + 360) % 360;
        if (span === 0) span = 360;
        let off = (bearing(p.lat, p.lon, lat, lon) - p.leftAngle + 360) % 360;
        // Outside the arc: clamp to whichever end is nearer, rather than wrapping to the far one.
        if (off > span) off = (off - span) < (360 - off) ? span : 0;
        return dest(p.lat, p.lon, p.leftAngle + off, p.radiusNm);
    }

    /** `to`, pulled back along the line from `from` so the segment is at most `maxNm` long. */
    function clip(from, to, maxNm) {
        if (!to || !(maxNm > 0)) return null;
        if (!isFinite(maxNm)) return to;
        const dLat = to[0] - from[0];
        const dLon = (to[1] - from[1]) * Math.cos(from[0] * Math.PI / 180);
        const nm = Math.hypot(dLat, dLon) * 60;
        if (nm <= maxNm) return to;
        const k = maxNm / nm;
        return [from[0] + dLat * k, from[1] + (to[1] - from[1]) * k];
    }

    // Hold severity, warm as it gets worse. Deliberately NOT the adaptation palette: a target's
    // color has to mean "how much hold", not "what kind of point", or the two readings compete.
    function holdColor(min) {
        if (min == null || min < 1) return '#9fb0c0';
        if (min < 5) return '#ffcc44';
        if (min < 10) return '#ff8844';
        return '#ff4444';
    }

    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const hhmm = iso => iso ? String(iso).slice(11, 16) : '';

    // ── ARTCC boundaries ────────────────────────────────────────────────────
    // Whole-center outlines, so a meter point reads against the airspace it belongs to and
    // extended metering is visible as points sitting in somebody else's center.
    //
    // Deliberately NOT the FAVs: those are per-sector, per-altitude-slab volumes (2,641
    // nationally) and drawing them here would bury the adaptation these pages exist to show.
    // vNAS's ArtccBoundaries.geojson is one polygon per ARTCC and publishes no high/low variants,
    // so it IS already the high-altitude outline — there is no altitude choice to expose.
    //
    // Fetched ONCE into its own layer and its own pane. The adaptation layer is torn down and
    // rebuilt on every refresh; boundaries must not ride on that (24 polygons re-added six times
    // a minute), and the pane pins them under the adaptation instead of relying on add order
    // surviving each rebuild.
    const BND_PANE = 'artccBnd';
    let bndGeo = null;

    async function drawBoundaries(state) {
        if (!state.map || state.bndLayer) return;
        if (!bndGeo) {
            try {
                const r = await fetch('/api/airspace/artcc-boundaries');
                if (!r.ok) return;          // not fetched yet — the map is still fine without it
                bndGeo = await r.json();
            } catch { return; }
        }
        if (!state.map.getPane(BND_PANE)) {
            state.map.createPane(BND_PANE).style.zIndex = 350;   // tiles 200, overlays 400
        }
        const own = new Set(state.highlight || []);
        state.bndLayer = L.geoJSON(bndGeo, {
            pane: BND_PANE,
            style: f => {
                const mine = own.has(String(f.properties && f.properties.id || '').toUpperCase());
                return {
                    // The centers in play solid and brighter, the rest dashed and dim, so they
                    // read as context rather than competing with the meter points for attention.
                    color: mine ? '#6f7f8f' : '#44515c',
                    weight: mine ? 1.6 : 0.8,
                    opacity: mine ? 0.95 : 0.5,
                    dashArray: mine ? null : '2 6',
                    fill: false,
                    interactive: false,     // never steal a tooltip from a meter point
                };
            },
        }).addTo(state.map);
    }

    // ── adaptation geometry ─────────────────────────────────────────────────
    /**
     * Draw meter fixes and arcs into `layer`. `load(p)` returns {scheduled, delayed, delayMin} for
     * a point, or null when it is adapted but idle. Returns {bounds, busyBounds} so the caller can
     * decide what to fit — which is a page decision, not this function's.
     */
    function drawPoints(layer, points, load) {
        const bounds = [], busyBounds = [];
        for (const p of points) {
            if (p.lat == null || p.lon == null) continue;
            const col = TYPE_COLOR[p.type] || '#888';
            const l = load ? load(p) : null;
            const busy = !!(l && l.scheduled > 0);
            const held = !!(l && l.delayed > 0);
            const tip = `<b style="color:${col}">${esc(p.name)}</b> ${esc(p.type || '')}`
                + (p.ctr ? ` &middot; ${esc(p.ctr)}` : '')
                + (p.gate ? `<br>gate ${esc(p.gate)}` : '')
                + (p.tracon ? `<br>${esc(p.tracon)}` : '')
                + (p.radiusNm ? `<br>${p.radiusNm} nm, ${p.leftAngle}&deg;&ndash;${p.rightAngle}&deg;` : '')
                + (p.altLow != null || p.altHigh != null
                    ? `<br>${p.altLow == null ? '?' : p.altLow}&ndash;${p.altHigh == null ? '?' : p.altHigh} ft` : '')
                + (l ? `<br><b>${l.scheduled}</b> scheduled`
                    + (l.delayed ? `, ${l.delayed} held ${l.delayMin} min` : '')
                    : '<br>not in use');

            if (p.radiusNm && p.leftAngle != null && p.rightAngle != null) {
                const path = arcPath(p.lat, p.lon, p.radiusNm, p.leftAngle, p.rightAngle);
                L.polyline(path, {
                    color: col, weight: held ? 3.5 : busy ? 2.5 : 1,
                    opacity: busy ? 0.9 : 0.35, dashArray: busy ? null : '3 5',
                }).bindTooltip(tip, { className: 'tt', sticky: true }).addTo(layer);
                bounds.push(...path);
                if (busy) busyBounds.push(...path);
            } else {
                L.circleMarker([p.lat, p.lon], {
                    radius: busy ? 4 : 2.5, color: col, weight: 1,
                    fillColor: col, fillOpacity: busy ? 0.9 : 0.3, opacity: busy ? 0.9 : 0.4,
                }).bindTooltip(tip, { className: 'tt', sticky: true }).addTo(layer);
                bounds.push([p.lat, p.lon]);
                if (busy) busyBounds.push([p.lat, p.lon]);
            }
        }
        return { bounds, busyBounds };
    }

    // ── metered traffic ─────────────────────────────────────────────────────
    // The aircraft being metered to these points, which is what turns the adaptation from a
    // diagram into a picture of what is actually happening.
    //
    // TBFM publishes NO position — the only lat/lon in the whole feed is adaptation geometry — so
    // each target is a TBFM schedule joined to SFDPS by callsign, server-side. Measured at ZLA:
    // 86% of metered callsigns have a position, median age 6 s; every miss was an oceanic or
    // international inbound TBFM is metering while it is still outside domestic radar. Those are
    // counted in the legend rather than silently dropped.
    const TRAFFIC_PANE = 'tbfmTraffic';

    /**
     * A traffic layer over `state.map`, with its own fetch timer and its own controls.
     *
     * Refreshed on its OWN timer: positions move on SFDPS's ~12 s cadence while a board's
     * aggregates barely do, so moving a dot must not re-render the tables and the adaptation.
     */
    function Traffic(opts) {
        const self = {
            url: opts.url,                 // () => the traffic endpoint for this page
            getMap: opts.getMap,           // () => the Leaflet map, or null before first draw
            geometry: opts.geometry,       // () => adapted points, for aiming the leaders
            legendEl: opts.legendEl,
            onData: opts.onData || function () { },
            data: null,
            layer: null,
        };

        // Both lengths are persisted per browser, and both need a control: this is a map that can
        // span the whole country, where a leader to a meter point is legitimately 1,500 nm long.
        let show = localStorage.getItem('tbfm-traffic') !== '0';
        let allLinks = localStorage.getItem('tbfm-links') === '1';
        let vecMin = parseFloat(localStorage.getItem('tbfm-vec'));
        if (!(vecMin >= 0)) vecMin = 2;
        let leaderNm = parseFloat(localStorage.getItem('tbfm-leader'));
        if (!(leaderNm >= 0)) leaderNm = 40;      // 0 = off, Infinity = all the way to the point

        self.draw = function () {
            const map = self.getMap();
            if (!map) return;
            if (self.layer) { self.layer.remove(); self.layer = null; }
            if (!show || !self.data) { self.renderLegend(); return; }
            if (!map.getPane(TRAFFIC_PANE)) map.createPane(TRAFFIC_PANE).style.zIndex = 450;
            self.layer = L.layerGroup([], { pane: TRAFFIC_PANE }).addTo(map);

            // Adaptation by name, so a leader can be aimed at the real geometry. Arc names carry
            // a trailing dot in adaptation (HELNS. beside the fix HELNS), so both are indexed.
            // Keyed by center too: two centers can adapt points of the same name, and an airport
            // map draws points from several at once.
            const geo = {};
            for (const p of (self.geometry() || [])) {
                const bare = p.name.replace(/\.$/, '');
                geo[p.name] = geo[bare] = p;
                if (p.ctr) geo[p.ctr + '|' + p.name] = geo[p.ctr + '|' + bare] = p;
            }

            for (const t of (self.data.flights || [])) {
                if (t.lat == null || t.lon == null) continue;
                const hold = t.holdMin;
                const col = holdColor(hold);
                const held = hold != null && hold >= 1;

                // Leader to the point this flight is being sequenced to. Held flights only by
                // default: 215 lines at ZLA bury the adaptation underneath them, and an unheld
                // flight's leader carries nothing the point's own load count doesn't already give.
                const p = geo[(t.ctr || '') + '|' + t.point] || geo[t.point];
                if (p && leaderNm > 0 && (held || allLinks)) {
                    // Capped at leaderNm: a stub still says which fix the flight is going to,
                    // which is the whole content of the line, without drawing the 1,500 nm of it
                    // that only crosses everything else on the way.
                    const to = clip([t.lat, t.lon], pointTarget(p, t.lat, t.lon), leaderNm);
                    if (to) L.polyline([[t.lat, t.lon], to], {
                        pane: TRAFFIC_PANE, color: col, weight: 0.8,
                        opacity: held ? 0.45 : 0.2, dashArray: '2 4', interactive: false,
                    }).addTo(self.layer);
                }

                // Velocity vector, the same idiom as the ERAM scope: direction of flight reads
                // instantly and costs one canvas polyline, where a rotated symbol would cost a
                // DOM marker each. vx/vy are KNOTS, so a minute of travel is v/3600 degrees —
                // NOT v/60, which is an hour and is what shipped first: at 450 kt every target
                // grew a 450 nm spike and the CONUS view turned into a starburst.
                if (vecMin > 0 && t.vx != null && t.vy != null && (t.vx || t.vy)) {
                    const dLat = t.vy * vecMin / 3600;
                    const dLon = t.vx * vecMin / (3600 * Math.cos(t.lat * Math.PI / 180));
                    L.polyline([[t.lat, t.lon], [t.lat + dLat, t.lon + dLon]], {
                        pane: TRAFFIC_PANE, color: col, weight: 1.2, opacity: 0.8,
                        interactive: false,
                    }).addTo(self.layer);
                }

                L.circleMarker([t.lat, t.lon], {
                    pane: TRAFFIC_PANE, radius: held ? 4 : 2.8, color: col, weight: 1,
                    fillColor: col, fillOpacity: held ? 0.95 : 0.6, opacity: 0.95,
                }).bindTooltip(tooltip(t, col, held, hold), { className: 'tt', sticky: true })
                    .on('click', () => window.open('/track/' + encodeURIComponent(t.aid), '_blank'))
                    .addTo(self.layer);
            }
            self.renderLegend();
        };

        function tooltip(t, col, held, hold) {
            const fl = t.alt == null ? ''
                : t.alt >= 18000 ? 'FL' + Math.round(t.alt / 100)
                : Math.round(t.alt).toLocaleString() + ' ft';
            return `<b style="color:${col}">${esc(t.aid)}</b>`
                + (t.type ? ' ' + esc(t.type) : '')
                + `<br>${esc(t.dep || '?')} &rarr; <b>${esc(t.apt || '?')}</b>`
                + (fl ? '<br>' + fl : '') + (t.gs ? ' &middot; ' + Math.round(t.gs) + ' kt' : '')
                + (t.ctrl ? '<br>' + esc(t.ctrl) + (t.sector ? '/' + esc(t.sector) : '') : '')
                + (t.point ? `<br>next <b>${esc(t.point)}</b>`
                    + (t.pointType ? ' ' + esc(t.pointType) : '')
                    + (t.ctr ? ' (' + esc(t.ctr) + ')' : '')
                    + (t.sta ? ' STA ' + hhmm(t.sta) : '')
                    + (t.eta ? ' ETA ' + hhmm(t.eta) : '') : '')
                // The governing hold is usually NOT at the next point — TBFM distributes it
                // upstream, so a flight next at a ZLA fix with no delay can be carrying its whole
                // hold from a ZAB fix two links later. Naming where it is taken is the point of
                // showing it at all.
                + (held
                    ? `<br><b style="color:${col}">hold ${hold.toFixed(1)} min</b>`
                      + (t.holdPoint && (t.holdPoint !== t.point || t.holdCtr !== t.ctr)
                          ? ' at ' + esc(t.holdPoint)
                            + (t.holdCtr ? ' (' + esc(t.holdCtr) + ')' : '')
                          : '')
                    : '<br>no hold')
                + (t.rwy || t.staRwy ? '<br>rwy ' + esc(t.rwy || '?')
                    + (t.staRwy ? ' STA ' + hhmm(t.staRwy) : '') : '')
                + (t.centers > 1 ? `<br>metered by ${t.centers} centers` : '')
                + (t.frozen ? '<br>frozen' : '') + (t.suspended ? '<br>suspended' : '')
                + (t.posAgeSec != null && t.posAgeSec > 60
                    ? `<br><i>position ${t.posAgeSec}s old</i>` : '');
        }

        self.renderLegend = function () {
            const el = document.getElementById(self.legendEl);
            if (!el) return;
            if (!show) { el.innerHTML = 'Traffic hidden.'; return; }
            if (!self.data) { el.innerHTML = 'Loading metered traffic&hellip;'; return; }
            const d = self.data;
            const held = (d.flights || [])
                .filter(t => t.lat != null && t.holdMin != null && t.holdMin >= 1).length;
            el.innerHTML = '<i style="background:#9fb0c0"></i>no hold'
                + '<i style="background:#ffcc44"></i>1&ndash;5 min'
                + '<i style="background:#ff8844"></i>5&ndash;10'
                + '<i style="background:#ff4444"></i>10+ &nbsp; '
                + `<b>${d.located}</b> of ${d.scheduled} metered flights drawn, ${held} held. `
                + (vecMin > 0 ? `Vector is ${vecMin} min of travel. ` : '')
                + (leaderNm > 0
                    ? 'The dashed leader points at the fix &mdash; or the nearest point <i>on</i> '
                      + 'the arc, never the arc&rsquo;s center &mdash; it is sequenced to'
                      + (isFinite(leaderNm) ? `, clipped to ${leaderNm} nm. ` : '. ')
                    : '')
                + (d.unlocated
                    ? `<b>${d.unlocated}</b> not drawn: TBFM is metering them but SFDPS has no `
                      + 'position &mdash; oceanic and international traffic outside domestic radar. '
                    : '')
                + (d.stale ? `${d.stale} dropped as a stale fix (over 120 s old). ` : '')
                + 'Click a target for its full cross-source status.';
        };

        self.load = async function () {
            if (!show) { self.renderLegend(); return; }
            try {
                const r = await fetch(self.url());
                if (!r.ok) return;
                self.data = await r.json();
                self.onData(self.data);
                self.draw();
            } catch { /* a missed poll is a stale dot, not a broken page */ }
        };

        /** Wire the control bar. Markup lives in each page so the bar can sit where it belongs. */
        self.bindControls = function () {
            const g = id => document.getElementById(id);
            if (g('tf-traffic')) {
                g('tf-traffic').checked = show;
                g('tf-traffic').onchange = e => {
                    show = e.target.checked;
                    localStorage.setItem('tbfm-traffic', show ? '1' : '0');
                    if (show && !self.data) self.load(); else self.draw();
                };
            }
            if (g('tf-links')) {
                g('tf-links').checked = allLinks;
                g('tf-links').onchange = e => {
                    allLinks = e.target.checked;
                    localStorage.setItem('tbfm-links', allLinks ? '1' : '0');
                    self.draw();
                };
            }
            // `Infinity` survives a round trip through localStorage as the string "Infinity",
            // which parseFloat reads back correctly — so a select's value can be what it means.
            if (g('tf-vec')) {
                g('tf-vec').value = String(vecMin);
                g('tf-vec').onchange = e => {
                    vecMin = parseFloat(e.target.value);
                    localStorage.setItem('tbfm-vec', e.target.value);
                    self.draw();
                };
            }
            if (g('tf-leader')) {
                g('tf-leader').value = isFinite(leaderNm) ? String(leaderNm) : 'Infinity';
                g('tf-leader').onchange = e => {
                    leaderNm = parseFloat(e.target.value);
                    localStorage.setItem('tbfm-leader', e.target.value);
                    self.draw();
                };
            }
        };

        return self;
    }

    // Published on window explicitly. A top-level `const` in a classic script is NOT a window
    // property, and this repo has already lost a day to two objects of the same name — one a
    // module-scope const, one a window property — being silently different values.
    window.TbfmMap = {
        TYPE_COLOR, dest, bearing, arcPath, pointTarget, clip, holdColor,
        drawBoundaries, drawPoints, Traffic, BND_PANE, TRAFFIC_PANE,
    };
})();
