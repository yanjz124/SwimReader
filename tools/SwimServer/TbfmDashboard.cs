using SwimServer;

/// <summary>
/// Dashboard projections over the TBFM state, for the <c>/tbfm</c> pages. Ingestion, the state
/// model and the ERAM scope's own snapshot live in TbfmBridge.cs; this file only reads.
///
/// <para><b>The feed is per-center, the question is per-airport.</b> TBFM meters a flight once in
/// every ARTCC it crosses on the way to the field — each center schedules it across its own
/// boundary gate, and only the last one in the chain (the one adjacent to the arrival TRACON)
/// carries a runway STA. Measured live: 5,612 schedule records were 2,638 distinct flights, chains
/// 1 to 8 centers long, and PHX arrivals were being metered by all 20 CONUS centers at once. So
/// everything here groups records into flights by (callsign, destination) first.</para>
///
/// <para><b>Delay is STA − ETA at one point, and it does not add up along the chain.</b> TBFM
/// distributes a hold upstream, so once a center has absorbed it the next point downstream reads
/// ~0 — live, AAL1754/PHX took +5.8 min at ZDV/GUP and 0.0 at ZAB/ZDVPHXX one point later. A
/// flight's governing delay is therefore the <b>maximum</b> over its chain, never the sum, which
/// would double-count. A <b>meter point's</b> delay, by contrast, is its own record's delay,
/// because that is what the sector working that point actually sees. Two different aggregations of
/// the same number, each right for its own question — don't "fix" one into the other.</para>
///
/// <para><b>Negative delay is real and is not clamped.</b> ~4% of records have STA earlier than
/// ETA, which TBFM cannot deliver. It comes out of this bridge's merge-on-non-null semantics: when
/// a schedule's scheduled point changes (live: DAL348/PHX, <c>sfx</c> moved PINNG←BRDEY) the older
/// <c>sta_sfx</c> survives against the new <c>eta_sfx</c>. Showing it beats hiding it — a big
/// negative is the signal that a record's times are from two different schedules.</para>
/// </summary>
partial class TbfmBridge
{
    // ── Shared liveness test ─────────────────────────────────────────────────

    /// <summary>
    /// Whether a record is a schedule worth showing: not LADD-blocked, not landed, and with at
    /// least one STA the flight has not reached yet. Shared with <see cref="EramSnapshot"/> so the
    /// scope and the dashboards can't drift apart on what counts as live.
    /// </summary>
    private bool IsLive(TbfmFlight f, DateTime now, out bool mfxDone, out bool rwyDone)
    {
        mfxDone = Passed(f.StaMeterFix, f.StaMeterFixSeen, now);
        rwyDone = Passed(f.StaRunway, f.StaRunwaySeen, now);
        if (LaddService.IsBlocked(f.Aid, null)) return false;
        // TBFM's track status says when it's over (live: JBU190 acs=LANDED with a runway STA).
        if (f.Flt.TryGetValue("acs", out var acs) && acs == "LANDED") return false;
        return (f.StaMeterFix.HasValue && !mfxDone) || (f.StaRunway.HasValue && !rwyDone);
    }

    /// <summary>One flight's schedules, one per center metering it, nearest point last.</summary>
    private sealed class MeteredFlight
    {
        public string Aid = "", Apt = "";
        public string? Dep, Type, Status, Beacon, TrackedBy, Route, CruiseAlt;
        public List<TbfmFlight> Chain = new();
        /// <summary>The one record carrying a runway STA. Verified live: never more than one.</summary>
        public TbfmFlight? Terminal;
        public double? DelayMin, RwyDelayMin;
        public bool Frozen, Suspended, Manual;
        public DateTime? NextSta;
    }

    private static double? DelayOf(DateTime? sta, DateTime? eta) =>
        sta.HasValue && eta.HasValue ? Math.Round((sta.Value - eta.Value).TotalMinutes, 1) : null;

    private static string? Fl(TbfmFlight f, string k) => f.Flt.TryGetValue(k, out var v) ? v : null;
    private static string? Mr(TbfmFlight f, string k) => f.Mrp.TryGetValue(k, out var v) ? v : null;
    private static bool Yes(TbfmFlight f, string k) => f.Sch.TryGetValue(k, out var v) && v == "YES";

    /// <summary>Live schedules grouped into flights by (callsign, destination).</summary>
    private List<MeteredFlight> GroupFlights(DateTime now, string? apt = null, string? ctr = null)
    {
        var by = new Dictionary<(string, string), MeteredFlight>();
        foreach (var f in _flights.Values)
        {
            if (!IsLive(f, now, out _, out _)) continue;
            var a = f.Arrival ?? "?";
            if (apt != null && a != apt) continue;
            var key = (f.Aid, a);
            if (!by.TryGetValue(key, out var m))
                by[key] = m = new MeteredFlight { Aid = f.Aid, Apt = a };
            m.Chain.Add(f);
        }
        var list = new List<MeteredFlight>(by.Count);
        foreach (var m in by.Values)
        {
            // Nearest-the-field last: the chain is a route, so STA order is geographic order.
            m.Chain.Sort((x, y) => Nullable.Compare(x.StaMeterFix ?? x.StaRunway, y.StaMeterFix ?? y.StaRunway));
            if (ctr != null && !m.Chain.Any(f => CenterOf(f.Source) == ctr)) continue;
            m.Terminal = m.Chain.LastOrDefault(f => f.StaRunway.HasValue);
            // Identity/flight-plan fields repeat on every record; take the freshest that has them.
            foreach (var f in m.Chain.OrderByDescending(f => f.LastSeen))
            {
                m.Dep ??= f.Departure; m.Type ??= Fl(f, "typ"); m.Status ??= Fl(f, "acs");
                m.Beacon ??= Fl(f, "bcn"); m.TrackedBy ??= Fl(f, "tds");
                m.Route ??= Fl(f, "a10"); m.CruiseAlt ??= Fl(f, "ara");
            }
            foreach (var f in m.Chain)
            {
                var d = DelayOf(f.StaMeterFix, f.EtaMeterFix);
                if (d.HasValue && (!m.DelayMin.HasValue || d > m.DelayMin)) m.DelayMin = d;
                if (Yes(f, "sfz") || Yes(f, "rfz")) m.Frozen = true;
                if (Yes(f, "sus")) m.Suspended = true;
                if (Yes(f, "man")) m.Manual = true;
                var sta = f.StaRunway ?? f.StaMeterFix;
                if (sta.HasValue && sta > now && (!m.NextSta.HasValue || sta < m.NextSta)) m.NextSta = sta;
            }
            if (m.Terminal != null) m.RwyDelayMin = DelayOf(m.Terminal.StaRunway, m.Terminal.EtaRunway);
            list.Add(m);
        }
        return list;
    }

    // ── Rates ────────────────────────────────────────────────────────────────

    /// <summary>
    /// A rate of 3600/hr is TBFM's "no restriction" default, not a real acceptance rate: 53 of 57
    /// published AARs sat at exactly 3600 — including fields like DVT and SDL that could not take
    /// one an hour — with effective times days old, while the four real ones (ORD 100, FLL 56,
    /// MIA 40, MDW 28) had been set that day. So pages show 3600 as unrestricted, and
    /// <c>restricted</c> is what makes an airport card interesting.
    /// </summary>
    private const double UnrestrictedRate = 3600;

    private object[] RatesFor(Func<TbfmRate, bool> match) =>
        _centers.Values
            .SelectMany(c => c.Rates.Values.Where(match).Select(r => (c, r)))
            .OrderBy(x => x.r.Kind).ThenBy(x => x.r.Id)
            .Select(x => (object)new
            {
                ctr = x.c.Id, kind = x.r.Kind, id = x.r.Id, tracon = x.r.Tracon,
                rate = x.r.Rate, restricted = x.r.Rate is { } v && v < UnrestrictedRate,
                effective = x.r.EffectiveTime, type = x.r.Type,
            })
            .ToArray();

    // ── /api/tbfm/airports — the directory ───────────────────────────────────

    /// <summary>One row per airport TBFM is metering arrivals into.</summary>
    public object[] AirportsSnapshot()
    {
        var now = DateTime.UtcNow;
        var aars = _centers.Values
            .SelectMany(c => c.Rates.Values.Where(r => r.Kind == "aar"))
            .GroupBy(r => r.Id)
            .ToDictionary(g => g.Key, g => g.OrderByDescending(r => r.Received).First());

        return GroupFlights(now)
            .GroupBy(m => m.Apt)
            .Select(g =>
            {
                var l = g.ToList();
                var delays = l.Select(m => m.DelayMin ?? 0).ToList();
                aars.TryGetValue(g.Key, out var aar);
                var links = l.SelectMany(m => m.Chain).ToList();
                return new
                {
                    apt = g.Key,
                    metered = l.Count,
                    arriving = l.Count(m => m.Terminal != null),   // has a runway schedule
                    delayed = delays.Count(d => d >= 1),
                    delayMin = (int)Math.Round(delays.Where(d => d >= 1).Sum()),
                    maxDelayMin = delays.Count == 0 ? 0 : Math.Round(delays.Max(), 1),
                    frozen = l.Count(m => m.Frozen),
                    centers = links.Select(f => CenterOf(f.Source)).Distinct().Count(),
                    points = links.Select(ScheduledPoint).Where(p => p != null).Distinct().Count(),
                    tracon = l.Select(m => m.Terminal is { } t ? Mr(t, "tra") : null)
                              .FirstOrDefault(t => t != null && t != "EDC"),
                    aar = aar?.Rate, aarRestricted = aar?.Rate is { } v && v < UnrestrictedRate,
                    nextSta = l.Select(m => m.NextSta).Min(),
                };
            })
            .OrderByDescending(r => r.metered)
            .ThenBy(r => r.apt)
            .Cast<object>()
            .ToArray();
    }

    // ── /api/tbfm/airport/{apt} — one airport's arrival metering board ───────

    public object AirportBoard(string airport)
    {
        var now = DateTime.UtcNow;
        var apt = airport.Trim().ToUpperInvariant();
        if (apt.Length == 4 && apt[0] == 'K') apt = apt[1..];
        var flights = GroupFlights(now, apt: apt);

        // Order by the time the flight reaches the field where that is known, then by its nearest
        // scheduled point — a flight metered only upstream has no runway STA to sort on.
        flights.Sort((a, b) =>
        {
            var ka = a.Terminal?.StaRunway ?? a.NextSta;
            var kb = b.Terminal?.StaRunway ?? b.NextSta;
            return Nullable.Compare(ka, kb);
        });

        var delays = flights.Select(m => m.DelayMin ?? 0).ToList();
        var tracon = flights.Select(m => m.Terminal is { } t ? Mr(t, "tra") : null)
                            .FirstOrDefault(t => t != null && t != "EDC");

        return new
        {
            apt,
            tracon,
            metered = flights.Count,
            arriving = flights.Count(m => m.Terminal != null),
            delayed = delays.Count(d => d >= 1),
            delayMin = (int)Math.Round(delays.Where(d => d >= 1).Sum()),
            maxDelayMin = delays.Count == 0 ? 0 : Math.Round(delays.Max(), 1),
            frozen = flights.Count(m => m.Frozen),
            suspended = flights.Count(m => m.Suspended),
            centers = flights.SelectMany(m => m.Chain).Select(f => CenterOf(f.Source))
                             .Where(c => c != null).Distinct().OrderBy(c => c).ToArray(),
            // Only the rates that name this airport, plus its TRACON's, so a board isn't padded
            // with 300 unrelated rows.
            rates = RatesFor(r => r.Id == apt || (tracon != null && r.Id == tracon)),
            // Runway configuration comes from whichever center adapted this airport.
            configs = _centers.Values
                .Select(c => c.Airports.TryGetValue(apt, out var a) ? (c.Id, a) : default)
                .Where(x => x.a != null)
                .Select(x => (object)new
                {
                    ctr = x.Id, tracon = x.a!.Tracon, runways = x.a.Runways,
                    configs = new SortedDictionary<string, string[]>(x.a.Configs),
                })
                .ToArray(),
            // Which config the schedules themselves say is running (mrp/cfg on the terminal record).
            activeConfigs = flights.Select(m => m.Terminal is { } t ? Mr(t, "cfg") : null)
                                   .Where(c => c != null).GroupBy(c => c!)
                                   .OrderByDescending(g => g.Count())
                                   .Select(g => (object)new { cfg = g.Key, flights = g.Count() }).ToArray(),
            ts = now,
            flights = flights.Select(m => FlightJson(m, now)).ToArray(),
        };
    }

    private object FlightJson(MeteredFlight m, DateTime now) => new
    {
        aid = m.Aid, apt = m.Apt, dep = m.Dep, type = m.Type, status = m.Status,
        beacon = m.Beacon, trackedBy = m.TrackedBy, cruiseAlt = m.CruiseAlt, route = m.Route,
        delayMin = m.DelayMin, rwyDelayMin = m.RwyDelayMin,
        frozen = m.Frozen, suspended = m.Suspended, manual = m.Manual,
        rwy = m.Terminal is { } t0 ? t0.Runway : null,
        cfg = m.Terminal is { } t1 ? Mr(t1, "cfg") : null,
        tracon = m.Terminal is { } t2 ? Mr(t2, "tra") : null,
        cat = m.Terminal is { } t3 ? Mr(t3, "cat") : m.Chain.LastOrDefault() is { } tl ? Mr(tl, "cat") : null,
        staRwy = m.Terminal?.StaRunway, etaRwy = m.Terminal?.EtaRunway,
        terminalCtr = m.Terminal is { } t4 ? CenterOf(t4.Source) : null,
        chain = m.Chain.Select(f => LinkJson(f, now)).ToArray(),
    };

    /// <summary>One center's schedule for the flight — one link of the metering chain.</summary>
    private object LinkJson(TbfmFlight f, DateTime now) => new
    {
        ctr = CenterOf(f.Source),
        point = ScheduledPoint(f), pointType = PointType(f), meterFix = f.MeterFix,
        gate = Mr(f, "gat"), streamClass = Mr(f, "scn"), cat = Mr(f, "cat"), tracon = Mr(f, "tra"),
        sta = f.StaMeterFix, eta = f.EtaMeterFix, delayMin = DelayOf(f.StaMeterFix, f.EtaMeterFix),
        rwy = f.Runway, staRwy = f.StaRunway, etaRwy = f.EtaRunway,
        rwyDelayMin = DelayOf(f.StaRunway, f.EtaRunway),
        frozen = Yes(f, "sfz"), rwyFrozen = Yes(f, "rfz"),
        suspended = Yes(f, "sus"), manual = Yes(f, "man"),
        arcs = ArcsJson(f, now),
        tmaId = f.TmaId, gufi = f.Gufi,
        ageSec = f.TimesSeen == default ? (int?)null : (int)(now - f.TimesSeen).TotalSeconds,
    };

    // ── /api/tbfm/center/{ctr} — one center's meter-point board ──────────────

    public object? CenterBoard(string center)
    {
        var ctr = center.Trim().ToUpperInvariant();
        if (!_centers.TryGetValue(ctr, out var c)) return null;
        var now = DateTime.UtcNow;

        // This center's own records, which is what its controllers are metering to.
        var mine = _flights.Values.Where(f => IsLive(f, now, out _, out _) && CenterOf(f.Source) == ctr).ToList();

        var points = mine
            .GroupBy(f => (name: ScheduledPoint(f) ?? "?", type: PointType(f)))
            .Select(g =>
            {
                var l = g.ToList();
                var ds = l.Select(f => DelayOf(f.StaMeterFix, f.EtaMeterFix)).Where(d => d.HasValue)
                          .Select(d => d!.Value).ToList();
                var adapted = c.Points.Values.FirstOrDefault(p => p.Name == g.Key.name)
                           ?? c.Points.Values.FirstOrDefault(p => p.Name == g.Key.name + ".");
                return new
                {
                    name = g.Key.name, type = g.Key.type ?? adapted?.Type,
                    gate = l.Select(f => Mr(f, "gat")).FirstOrDefault(x => x != null) ?? adapted?.Gate,
                    tracon = l.Select(f => Mr(f, "tra")).FirstOrDefault(x => x != null) ?? adapted?.Tracon,
                    scheduled = l.Count,
                    delayed = ds.Count(d => d >= 1),
                    // Per point, its OWN delay — what the sector working it sees (see class note).
                    delayMin = (int)Math.Round(ds.Where(d => d >= 1).Sum()),
                    maxDelayMin = ds.Count == 0 ? 0 : Math.Round(ds.Max(), 1),
                    frozen = l.Count(f => Yes(f, "sfz") || Yes(f, "rfz")),
                    airports = l.GroupBy(f => f.Arrival ?? "?").OrderByDescending(x => x.Count())
                                .Take(4).Select(x => new { apt = x.Key, n = x.Count() }).ToArray(),
                    nextSta = l.Select(f => f.StaMeterFix).Where(t => t > now).Min(),
                    lat = adapted?.Lat, lon = adapted?.Lon, radiusNm = adapted?.RadiusNm,
                    leftAngle = adapted?.LeftAngle, rightAngle = adapted?.RightAngle,
                    altLow = adapted?.AltLow, altHigh = adapted?.AltHigh,
                };
            })
            .OrderByDescending(r => r.scheduled)
            .ThenBy(r => r.name)
            .Cast<object>()
            .ToArray();

        var allDelays = mine.Select(f => DelayOf(f.StaMeterFix, f.EtaMeterFix))
                            .Where(d => d.HasValue).Select(d => d!.Value).ToList();

        return new
        {
            ctr = c.Id,
            heartbeatSec = c.LastHeartbeat is { } h ? (int)(now - h).TotalSeconds : (int?)null,
            lastMessageSec = c.LastMessage is { } lm ? (int)(now - lm).TotalSeconds : (int?)null,
            tracons = c.Tracons.Keys.OrderBy(k => k).ToArray(),
            scheduled = mine.Count,
            delayed = allDelays.Count(d => d >= 1),
            delayMin = (int)Math.Round(allDelays.Where(d => d >= 1).Sum()),
            maxDelayMin = allDelays.Count == 0 ? 0 : Math.Round(allDelays.Max(), 1),
            adaptedPoints = c.Points.Count,
            adaptedAirports = c.Airports.Count,
            points,
            // THIS center's rates only. RatesFor scans every center, which is right for an
            // airport (any center may publish its AAR) and wrong here — it put ZNY's EWR rates on
            // ZLA's page. Only the kinds that carry a rate: aac / sac / scc are published with no
            // <rat> at all (their payload is stream-class and scheduling-constraint data this
            // bridge doesn't model yet), so listing them would be rows of blank rates.
            rates = c.Rates.Values.Where(r => r.Rate.HasValue)
                .OrderBy(r => r.Kind).ThenBy(r => r.Id)
                .Select(r => (object)new
                {
                    ctr = c.Id, kind = r.Kind, id = r.Id, tracon = r.Tracon,
                    rate = r.Rate, restricted = r.Rate is { } v2 && v2 < UnrestrictedRate,
                    effective = r.EffectiveTime, type = r.Type,
                }).ToArray(),
            otherConfigKinds = c.Rates.Values.Where(r => !r.Rate.HasValue)
                .GroupBy(r => r.Kind).OrderBy(g => g.Key)
                .Select(g => (object)new { kind = g.Key, n = g.Count() }).ToArray(),
            airports = c.Airports.Values.OrderBy(a => a.Name).Select(a => (object)new
            {
                name = a.Name, tracon = a.Tracon, runways = a.Runways,
                configs = new SortedDictionary<string, string[]>(a.Configs),
                metered = _flights.Values.Count(f => f.Arrival == a.Name && CenterOf(f.Source) == ctr
                                                     && IsLive(f, now, out _, out _)),
            }).ToArray(),
            gates = new SortedDictionary<string, string>(c.Gates),
            // Geometry for the map: every adapted point, arcs included. Points with no coordinates
            // (nothing in adaptation yet) are left out rather than drawn at 0/0.
            geometry = c.Points.Values.Where(p => p.Lat.HasValue && p.Lon.HasValue)
                .OrderBy(p => p.Name).Select(p => (object)new
                {
                    name = p.Name, type = p.Type, gate = p.Gate, tracon = p.Tracon,
                    meterFix = p.MeterFix, lat = p.Lat, lon = p.Lon, radiusNm = p.RadiusNm,
                    leftAngle = p.LeftAngle, rightAngle = p.RightAngle,
                    altLow = p.AltLow, altHigh = p.AltHigh,
                }).ToArray(),
            streamClasses = c.StreamClasses.Count,
            ts = now,
        };
    }

    /// <summary>Totals for the home page card and the directory's header strip.</summary>
    public object Stats()
    {
        var now = DateTime.UtcNow;
        var flights = GroupFlights(now);
        var delays = flights.Select(m => m.DelayMin ?? 0).ToList();
        return new
        {
            configured = Configured,
            centers = _centers.Count,
            live = _centers.Values.Count(c => c.LastMessage is { } m && (now - m).TotalMinutes < 5),
            records = _flights.Count,
            flights = flights.Count,
            airports = flights.Select(m => m.Apt).Distinct().Count(),
            delayed = delays.Count(d => d >= 1),
            delayMin = (int)Math.Round(delays.Where(d => d >= 1).Sum()),
            messages = MessageCount,
        };
    }
}
