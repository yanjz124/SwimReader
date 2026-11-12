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

    /// <summary>First non-blank value of <paramref name="get"/> over the chain, nearest the field
    /// last — so a field only an upstream center published is still reported.</summary>
    private static string? Pick(IEnumerable<TbfmLink> chain, Func<TbfmLink, string?> get)
    {
        string? found = null;
        foreach (var l in chain)
            if (get(l) is { Length: > 0 } v) found = v;
        return found;
    }

    /// <summary>
    /// A link's TRACON, or null for "EDC". Every upstream link reports <c>tra</c> as <b>EDC</b> —
    /// Extended Metering, not a facility — so taking it literally would tell a reader their flight
    /// is being worked by a TRACON called EDC. Only the terminal link names a real one.
    /// </summary>
    private static string? RealTracon(TbfmLink? l) =>
        l?.Tracon is { Length: > 0 } t && t != "EDC" ? t : null;

    private static double? DelayOf(DateTime? sta, DateTime? eta) =>
        sta.HasValue && eta.HasValue ? Math.Round((sta.Value - eta.Value).TotalMinutes, 1) : null;

    private static string? Fl(TbfmFlight f, string k) => f.Flt.TryGetValue(k, out var v) ? v : null;
    private static string? Mr(TbfmFlight f, string k) => f.Mrp.TryGetValue(k, out var v) ? v : null;
    private static bool Yes(TbfmFlight f, string k) => f.Sch.TryGetValue(k, out var v) && v == "YES";

    /// <summary>Live schedules grouped into flights by (callsign, destination).</summary>
    private List<MeteredFlight> GroupFlights(DateTime now, string? apt = null, string? ctr = null,
                                             string? aid = null)
    {
        var by = new Dictionary<(string, string), MeteredFlight>();
        foreach (var f in _flights.Values)
        {
            // Callsign filter first: /track asks about ONE flight, and neither the liveness test
            // nor the per-flight sort below is worth paying across several thousand records for it.
            if (aid != null && f.Aid != aid) continue;
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

    // ── /api/track and the Telegram bot ──────────────────────────────────

    /// <summary>
    /// One center's link in a flight's metering chain — and the structure it is metered under.
    ///
    /// <para><c>Point</c> is what this center schedules to; <c>MeterFix</c> is the airport's meter
    /// fix, which is <b>not always the same point</b> (live: ZAU schedules AAL1614 with mfx MOTRR
    /// but sfx FYTTEMF, and their ETAs differ). <c>Gate</c>, <c>StreamClass</c>, <c>Cfg</c> and
    /// <c>Cat</c> are the rest of what TBFM is sequencing it within: the arrival gate, the stream
    /// class the schedule belongs to, the runway configuration in force, and whether it is an
    /// ARRIVAL, a SATELLITE_ARRIVAL or an OVERFLIGHT. All four come straight off <c>mrp</c> and
    /// were parsed long before anything displayed them.</para>
    ///
    /// <para><c>Arcs</c> is the ladder ahead of the fix: a flight crosses the outer arcs (OMA, OOA,
    /// O3A, O4A) before the meter fix, each with its own STA, and TBFM names them in adaptation
    /// (MOXEE/T). Past arcs are dropped by <see cref="ArcsJson"/>, per the per-time expiry rule —
    /// a record kept alive by its fix and runway times can carry a long-dead arc STA.</para>
    /// </summary>
    public sealed record TbfmLink(
        string? Ctr, string? Point, string? PointType, string? Tracon, string? Gate, string? Cat,
        DateTime? Sta, DateTime? Eta, double? DelayMin, bool Passed, bool Frozen, bool Suspended,
        int? AgeSec, string? MeterFix = null, string? StreamClass = null, string? Cfg = null,
        string? Rwy = null, DateTime? StaRwy = null, Dictionary<string, object>? Arcs = null);

    /// <summary>
    /// One flight's metering.
    ///
    /// <para><b><c>Ctr</c>/<c>Point</c> and <c>HoldCtr</c>/<c>HoldPoint</c> are usually different
    /// points and must not be conflated.</b> The first is the next point the aircraft reaches; the
    /// second is where the governing hold is actually taken, which is wherever along the chain the
    /// delay is largest. Live: SKW6450/PHX was next at CORKR (ZLC) with zero delay while its
    /// 1.3 min came from BRUSR (ZAB) two links later — printing the hold against the next point
    /// put the delay at a fix that had none.
    ///
    /// A typed record rather than an anonymous object because the Telegram
    /// bot reads the fields in C# while <c>/api/track</c> serializes the same instance — one shape,
    /// so the page and the bot cannot drift apart on what TBFM says about a flight.
    /// </summary>
    public sealed record TbfmTrack(
        string? Dep, string? Dest, int Centers, double? DelayMin, double? RwyDelayMin,
        DateTime? NextSta, bool Frozen, bool Suspended, bool Manual, string? Status,
        string? Ctr, string? Point, DateTime? StaPoint, DateTime? EtaPoint,
        string? HoldCtr, string? HoldPoint,
        string? Rwy, DateTime? StaRwy, DateTime? EtaRwy,
        IReadOnlyList<string> Remaining, IReadOnlyList<TbfmLink> Chain,
        // What the flight is being metered UNDER, taken from the terminal link where there is one
        // (it is the only link that names a real TRACON, a gate, a runway config and a stream
        // class — every upstream link reports TRACON "EDC", Extended Metering) and from the next
        // link otherwise, so a flight still six centers out says something rather than nothing.
        string? MeterFix = null, string? Gate = null, string? StreamClass = null,
        string? Tracon = null, string? Cfg = null, string? Cat = null,
        Dictionary<string, object>? Arcs = null);

    /// <summary>
    /// One flight's metering: the chain of centers working it, nearest the field last, plus the
    /// roll-up that answers "is it being held, and by how much".
    ///
    /// <para>Deliberately not <see cref="FlightDetail"/>, which dumps every raw block for debugging.
    /// This goes through <see cref="GroupFlights"/> so it inherits the three rules that are each
    /// easy to get wrong alone: liveness (landed, LADD and past-STA records dropped), grouping by
    /// (callsign, destination), and <b>delay as the MAXIMUM over the chain, never the sum</b> —
    /// TBFM distributes a hold upstream, so a center that has absorbed it reads ~0 one point down.</para>
    /// </summary>
    public TbfmTrack? TrackSummary(string callsign)
    {
        var cs = (callsign ?? "").Trim().ToUpperInvariant();
        if (cs.Length == 0 || LaddService.IsBlocked(cs, null)) return null;
        var now = DateTime.UtcNow;
        var flights = GroupFlights(now, aid: cs);
        if (flights.Count == 0) return null;
        // A callsign can carry chains for two destinations when a previous leg's records have not
        // aged out. The one with the nearest STA is the leg being flown now.
        var m = flights.OrderBy(x => x.NextSta ?? DateTime.MaxValue).First();

        var chain = m.Chain.Select(f => new TbfmLink(
            Ctr: CenterOf(f.Source),
            Point: ScheduledPoint(f),
            PointType: PointType(f),        // MFX / MFA / OMA / OOA; null until adaptation arrives
            Tracon: Mr(f, "tra"),           // "EDC" upstream; only the last link names a real TRACON
            Gate: Mr(f, "gat"),
            Cat: Mr(f, "cat"),              // ARRIVAL / OVERFLIGHT / SATELLITE_*
            Sta: f.StaMeterFix,
            Eta: f.EtaMeterFix,
            DelayMin: DelayOf(f.StaMeterFix, f.EtaMeterFix),
            // Kept once the point is behind the aircraft: the chain reads as a route, and dropping
            // the passed links hides where the hold was actually taken.
            Passed: Passed(f.StaMeterFix, f.StaMeterFixSeen, now),
            Frozen: Yes(f, "sfz") || Yes(f, "rfz"),
            Suspended: Yes(f, "sus"),
            AgeSec: f.TimesSeen == default ? null : (int)(now - f.TimesSeen).TotalSeconds,
            // The structure this center is metering it within. Already parsed; nothing rendered it.
            MeterFix: f.MeterFix,
            StreamClass: Mr(f, "scn"),
            Cfg: Mr(f, "cfg"),
            Rwy: f.Runway,
            StaRwy: f.StaRunway,
            Arcs: ArcsJson(f, now))).ToList();

        // The link the aircraft is working toward: the first whose point it has not reached.
        var next = chain.FirstOrDefault(l => !l.Passed) ?? chain.LastOrDefault();
        // ...and the link the governing hold comes from, which is a different question. DelayMin
        // is the chain maximum, so the point it belongs to is the link holding that maximum.
        var hold = m.DelayMin is { } dm
            ? chain.FirstOrDefault(l => l.DelayMin is { } v && Math.Abs(v - dm) < 0.001) : null;
        // The link carrying the runway STA — the one adjacent to the arrival TRACON.
        var term = chain.LastOrDefault(l => l.StaRwy.HasValue);

        return new TbfmTrack(
            Dep: m.Dep, Dest: m.Apt, Centers: m.Chain.Count,
            DelayMin: m.DelayMin,           // the governing hold: max over the chain, not the sum
            RwyDelayMin: m.RwyDelayMin,
            NextSta: m.NextSta, Frozen: m.Frozen, Suspended: m.Suspended, Manual: m.Manual,
            Status: m.Status,
            Ctr: next?.Ctr, Point: next?.Point, StaPoint: next?.Sta, EtaPoint: next?.Eta,
            HoldCtr: hold?.Ctr, HoldPoint: hold?.Point,
            // Exactly 0 or 1 record per flight carries a runway STA (verified across a whole live
            // snapshot), so "the terminal schedule" is unambiguous.
            Rwy: m.Terminal?.Runway, StaRwy: m.Terminal?.StaRunway, EtaRwy: m.Terminal?.EtaRunway,
            Remaining: chain.Where(l => !l.Passed && l.Ctr != null).Select(l => l.Ctr!).Distinct().ToList(),
            Chain: chain,
            // The terminal link is where the real structure lives — it is the one adjacent to the
            // arrival TRACON, so it is the only one whose `tra` is a TRACON rather than "EDC" and
            // the only one carrying a runway config. Fall back to the next link (then any link
            // that has the field at all) so an inbound TBFM has only started metering upstream
            // still reports its gate and stream class instead of a row of dashes.
            MeterFix: term?.MeterFix ?? Pick(chain, l => l.MeterFix),
            Gate: term?.Gate ?? Pick(chain, l => l.Gate),
            StreamClass: term?.StreamClass ?? Pick(chain, l => l.StreamClass),
            Tracon: RealTracon(term) ?? Pick(chain, l => RealTracon(l)),
            Cfg: term?.Cfg ?? Pick(chain, l => l.Cfg),
            Cat: term?.Cat ?? next?.Cat ?? Pick(chain, l => l.Cat),
            Arcs: next?.Arcs ?? term?.Arcs);
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
                ctr = x.c.Id, kind = x.r.Kind, id = x.r.Id, point = x.r.Point, tracon = x.r.Tracon,
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
                    ctr = c.Id, kind = r.Kind, id = r.Id, point = r.Point, tracon = r.Tracon,
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

    // ── /api/tbfm/center/{ctr}/traffic — the metered flights themselves ─────

    /// <summary>
    /// One metered flight as this center schedules it, ready to be joined to a position.
    ///
    /// <para><b>TBFM publishes no position of any kind</b> — not on <c>&lt;air&gt;</c>, not in
    /// <c>flt</c>. The only lat/lon anywhere in the feed is adaptation geometry (a meter point's
    /// fix, or an arc's CENTER). So a target on the map is this record joined to SFDPS by
    /// <b>callsign</b>, which is the same join <see cref="TrackSummary"/> and the arrival board
    /// already use and for the same reason: TBFM's <c>gufi</c> is ERAM's short form and SFDPS
    /// doesn't publish it, so there is no id to join on.</para>
    ///
    /// <para>Measured at ZLA: 215 of 249 metered callsigns (86%) had an SFDPS position, median age
    /// 6 s. <b>All 33 misses were oceanic or international inbounds</b> — HNL, ZSPD, MMMX, VHHH,
    /// RCTP — which TBFM has as <c>TRACKED</c> and is already metering while they are outside
    /// domestic radar. TFMS fills only 2 of those 33, so that gap is a coverage boundary, not
    /// something a second source closes. The count of unlocated flights travels in the response so
    /// the page can say so rather than silently drawing fewer targets than it reports scheduled.</para>
    /// </summary>
    public sealed record TbfmTarget(
        string Aid, string? Apt, string? Dep, string? Type, string? Status,
        string? Point, string? PointType, DateTime? Sta, DateTime? Eta, double? DelayMin,
        double? PointLat, double? PointLon,
        string? HoldCtr, string? HoldPoint, double? HoldMin,
        string? Rwy, DateTime? StaRwy, int Centers, bool Frozen, bool Suspended);

    /// <summary>
    /// Every flight this center is metering, with the link this center owns.
    ///
    /// <para>Goes through <see cref="GroupFlights"/>, so it inherits liveness, grouping by
    /// (callsign, destination) and <b>hold as the chain maximum, never the sum</b>. The link shown
    /// is deliberately <b>this center's own</b> — what its controllers are scheduling — while the
    /// governing hold is reported separately, because they are usually different points: a flight
    /// next at a ZLA fix with no delay may be carrying its whole hold from a ZAB fix two links
    /// later.</para>
    /// </summary>
    public List<TbfmTarget> CenterTraffic(string center)
    {
        var ctr = (center ?? "").Trim().ToUpperInvariant();
        var out_ = new List<TbfmTarget>();
        if (ctr.Length == 0 || !_centers.TryGetValue(ctr, out var c)) return out_;
        var now = DateTime.UtcNow;

        foreach (var m in GroupFlights(now, ctr: ctr))
        {
            // This center's link. A center can hold more than one record for a flight (a
            // re-schedule to a different point); the freshest is the one being worked.
            var f = m.Chain.Where(x => CenterOf(x.Source) == ctr)
                           .OrderByDescending(x => x.LastSeen).FirstOrDefault();
            if (f is null) continue;

            var name = ScheduledPoint(f);
            // The arc/fix this center schedules to, so the page can draw a leader to it without a
            // second lookup. Adaptation names arcs with a trailing dot (HELNS. beside fix HELNS).
            var adapted = name is null ? null
                : c.Points.Values.FirstOrDefault(p => p.Name == name)
                  ?? c.Points.Values.FirstOrDefault(p => p.Name == name + ".");

            // Where the governing hold is actually taken — wherever along the chain it is largest,
            // which is usually NOT the next point. See TbfmTrack's note.
            TbfmFlight? hold = null;
            double? holdMin = null;
            foreach (var x in m.Chain)
            {
                var d = DelayOf(x.StaMeterFix, x.EtaMeterFix);
                if (d.HasValue && (!holdMin.HasValue || d > holdMin)) { holdMin = d; hold = x; }
            }

            out_.Add(new TbfmTarget(
                Aid: m.Aid, Apt: m.Apt, Dep: m.Dep, Type: m.Type, Status: m.Status,
                Point: name, PointType: PointType(f),
                Sta: f.StaMeterFix, Eta: f.EtaMeterFix,
                DelayMin: DelayOf(f.StaMeterFix, f.EtaMeterFix),
                PointLat: adapted?.Lat, PointLon: adapted?.Lon,
                HoldCtr: hold is null ? null : CenterOf(hold.Source),
                HoldPoint: hold is null ? null : ScheduledPoint(hold),
                HoldMin: holdMin,
                Rwy: m.Terminal?.Runway, StaRwy: m.Terminal?.StaRunway,
                Centers: m.Chain.Count, Frozen: m.Frozen, Suspended: m.Suspended));
        }
        return out_;
    }
}
