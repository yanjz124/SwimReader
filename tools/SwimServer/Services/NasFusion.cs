using System.Collections.Concurrent;
using System.Diagnostics;
using SwimReader.Server.AdsbFi;

namespace SwimServer;

/// <summary>
/// One airplane, once — the fused NAS picture across SFDPS (en route), TAIS/STARS (terminal)
/// and ASDE-X (surface).
///
/// <para><b>Why this is not just "draw SFDPS".</b> Measured on the live feed at the overnight
/// trough: 739 fresh SFDPS flights, 3,808 TAIS tracks of which <b>3,483 carry no callsign</b>,
/// and 1,499 ASDE-X tracks of which 1,240 are unknown. The population a NAS map has to draw is
/// dominated by targets only ONE source has, not by airliners three sources all publish — the
/// measured duplication factor across all three is only <b>1.05x</b>. So the hard part of fusion
/// here is not de-duplication; it is giving every target a <i>stable identity</i> so history
/// trails and leader lines don't break, and classifying the uncorrelated ones honestly.</para>
///
/// <para><b>Identity is a key ladder, not a per-pass match.</b> Each source record contributes
/// the keys it can prove — Mode S hex, callsign, its own facility/track number, a GUFI — and
/// <see cref="ResolveId"/> reuses the entity id any of them already resolves to. That is what
/// makes an id survive a target going from untagged (reachable only by its track key) to tagged
/// (now also reachable by callsign and Mode S) to airborne under a different facility: the keys
/// overlap even though no single key is present throughout. When two keys resolve to different
/// ids the <b>lower (older) id wins</b> and every key is re-pointed at it, so the map converges
/// instead of oscillating.</para>
///
/// <para><b>Position precedence is by source, not by arrival.</b> ASDE-X reports every second,
/// TAIS every ~5, SFDPS every ~12, so a surface target's position must come from ASDE-X even
/// though SFDPS may have written later. Flight-plan fields go the other way: SFDPS is written
/// first and the others only fill nulls.</para>
///
/// <para><b>A stale position is worse than none</b> — SFDPS keeps a flight 60 minutes past its
/// last update, and the TBFM maps drew an aircraft from a 55-minute-old fix before this rule was
/// added. SFDPS positions older than <see cref="MaxPosAgeSec"/> are not drawn; the record is still
/// used for its flight plan, and the count is reported separately from "no position at all".</para>
///
/// <para><b>LADD-blocked aircraft are omitted entirely</b>, not masked. Fusion's whole product is
/// a position paired with an identity, which is exactly what the list exists to prevent — the
/// same reasoning as <c>/api/enrich/aircraft</c>.</para>
///
/// <para><b>It costs nothing until something asks.</b> The pass is demand-driven: the timer skips
/// it unless a snapshot was requested in the last <see cref="IdleSeconds"/>. On a 4-core Pi where
/// CPU is the scarce resource, an index nobody is looking at should not be built.</para>
/// </summary>
class NasFusion
{
    /// <summary>An SFDPS position older than this is not drawn (it may be up to 60 min old).</summary>
    public const int MaxPosAgeSec = 120;
    /// <summary>Stop running passes when nothing has asked for a snapshot this recently.</summary>
    public const int IdleSeconds = 60;
    /// <summary>
    /// How long an IDENTITY key is kept — a Mode S hex, a callsign, a GUFI. These name the
    /// aircraft, so holding one across a gap in reporting is exactly right.
    /// </summary>
    public const int IdentityKeyTtlSeconds = 600;

    /// <summary>
    /// How long a TRACK key is kept — a facility/track-number or airport/track-id. Much shorter,
    /// and the difference is correctness, not housekeeping.
    ///
    /// <para>A track number is <b>not</b> an identity: it is a slot a facility assigns and then
    /// RECYCLES. Measured on the live feed, terminal track churn mints ~130 new entities per pass
    /// — ~65 targets a second, average track life about three minutes — so at a ten-minute TTL a
    /// busy TRACON will routinely reissue a number this index is still holding, and the next
    /// aircraft to get it inherits the previous one's entity id. Nothing errors; the client just
    /// draws one history trail leaping across the screen from one aeroplane to another.</para>
    ///
    /// <para>Sixty seconds is what the key is actually FOR: covering a scan or two of silence
    /// from one source so a trail doesn't break. Beyond that the track is gone, and a number
    /// that comes back is a different airplane.</para>
    /// </summary>
    public const int TrackKeyTtlSeconds = 60;

    // Tier 3: a discrete beacon code plus this gate is a positive correlation (the rule
    // CallsignEnrichmentService already uses). Non-discrete codes are never matched on.
    private const double BeaconGateNm = 5.0;
    private const int BeaconGateFt = 1000;
    // Tier 4 is MEASURED, NOT MERGED. A position-only match has no identifier to break a tie, so
    // it is only safe when exactly one candidate is in the gate — and whether that is worth doing
    // at all is a question for the numbers, not for a first build.
    private const double PosGateNm = 1.5;
    private const int PosGateFt = 500;

    // The three sources as delegates rather than a ServerContext field, so the index can be
    // driven from hand-built records in a test. Every rule below - position precedence, the
    // DROPPED penalty, the non-discrete beacon refusal, the noise-floor classification - is
    // invisible to a browser and to a curl against a live feed: each one produces a perfectly
    // plausible-looking target either way. A unit test is the only thing that can see them.
    private readonly Func<IEnumerable<FlightState>> _sfdps;
    private readonly Func<IEnumerable<(string facility, TaisTrack track)>> _tais;
    private readonly Func<IEnumerable<AsdexTrack>> _asdex;
    // Injectable only so a test can cross a TTL boundary without sleeping for it. The two key
    // lifetimes are the rule most worth pinning here and are untestable against a real clock.
    private readonly Func<DateTime> _now;

    // ── Persistent identity map (survives passes; this is what makes ids stable) ────────
    //
    // Keyed by the prefixed key string; the value carries when it was last seen, because the two
    // kinds of key expire on completely different schedules (see the TTL constants above).
    private readonly ConcurrentDictionary<NasKey, KeyRef> _idByKey = new();
    private long _nextId;

    private readonly struct KeyRef
    {
        public readonly long Id;
        public readonly DateTime Seen;
        public KeyRef(long id, DateTime seen) { Id = id; Seen = seen; }
    }

    /// <summary>
    /// How often a key's timestamp is rewritten, as a fraction of its own lifetime. Rewriting it
    /// every pass is what a dictionary update costs: <see cref="ConcurrentDictionary{K,V}"/>
    /// cannot write a value type this large atomically, so it ALLOCATES A FRESH NODE for every
    /// update — ~68,000 of them a pass here, for timestamps that had barely moved.
    /// </summary>
    private const int RefreshFraction = 3;

    private static int TtlSeconds(byte kind) =>
        kind is (byte)'H' or (byte)'C' or (byte)'G' ? IdentityKeyTtlSeconds : TrackKeyTtlSeconds;

    private readonly object _gate = new();
    private volatile NasSnapshot _snap = NasSnapshot.Empty;
    // A single CPU reading is one clock tick of resolution (10 ms), so a pass is quoted as the
    // mean over a window rather than as a sample - the same reason feed lag is read over a
    // window and not glanced at. Guarded by _gate, like the pass itself.
    private readonly Queue<double> _cpuSamples = new();
    private const int CpuWindow = 32;
    private long _lastDemandTicks = 0;
    private DateTime _lastEvict = DateTime.MinValue;
    private int _lastEntityCount;

    public NasFusion(ServerContext ctx)
        : this(() => ctx.Flights.Values, () => ctx.Tais.AllTracks(), () => ctx.Asdex.AllTracks()) { }

    internal NasFusion(Func<IEnumerable<FlightState>> sfdps,
                       Func<IEnumerable<(string facility, TaisTrack track)>> tais,
                       Func<IEnumerable<AsdexTrack>> asdex,
                       Func<DateTime>? now = null)
    {
        _sfdps = sfdps; _tais = tais; _asdex = asdex;
        _now = now ?? (() => DateTime.UtcNow);
    }

    /// <summary>Force a pass and return it, ignoring demand gating. For tests.</summary>
    internal NasSnapshot Rebuild() { lock (_gate) return _snap = Pass(); }

    /// <summary>True when something has asked for a snapshot recently enough to keep passing.</summary>
    public bool InDemand =>
        (DateTime.UtcNow - new DateTime(Interlocked.Read(ref _lastDemandTicks), DateTimeKind.Utc))
            .TotalSeconds < IdleSeconds;

    /// <summary>
    /// The current fused picture. Registers demand, and rebuilds synchronously when the held
    /// snapshot is older than <paramref name="maxAgeMs"/> so the first caller after an idle
    /// period gets a current answer rather than a stale or empty one.
    /// </summary>
    public NasSnapshot Snapshot(int maxAgeMs = 2000)
    {
        Interlocked.Exchange(ref _lastDemandTicks, DateTime.UtcNow.Ticks);
        var s = _snap;
        if ((DateTime.UtcNow - s.Built).TotalMilliseconds <= maxAgeMs) return s;
        lock (_gate)
        {
            if ((DateTime.UtcNow - _snap.Built).TotalMilliseconds <= maxAgeMs) return _snap;
            return _snap = Pass();
        }
    }

    /// <summary>Timer entry point. No-ops unless a snapshot has been asked for recently.</summary>
    public void Tick()
    {
        if (!InDemand) return;
        lock (_gate) _snap = Pass();
    }

    // ────────────────────────────────────────────────────────────────────────────────────

    private NasSnapshot Pass()
    {
        var cpu0 = ThreadCpu.Ms();
        // The exact analogue of ThreadCpu, and exact rather than sampled: per-thread, so it
        // needs no baseline and the feed's own allocations cannot contaminate it. Worth having
        // beside CPU on a box whose memory growth is documented as unsolved and whose GC pause
        // time already sits at ~17% -- a pass that is cheap in CPU can still be expensive in
        // garbage, and nothing else here would show that.
        var alloc0 = GC.GetAllocatedBytesForCurrentThread();
        var sw = Stopwatch.StartNew();
        var now = _now();
        var st = new NasFusionStats();
        // Pre-sized from the last pass rather than from a guess: a dictionary that grows from
        // 8,192 to ~21,000 rehashes three times, and the discarded bucket arrays are pure
        // garbage on a process already spending ~17% of its time in GC.
        var ents = new Dictionary<long, NasEntity>(Math.Max(8192, _lastEntityCount + _lastEntityCount / 8));

        // Timed per phase, because "the pass costs 250 ms" is not actionable and the first
        // guess about WHICH phase is usually wrong. Measured on the live daytime feed, the
        // answer was not the 26,000 source records - it was the proximity scan.
        var ph = Stopwatch.StartNew();
        var pa = alloc0;
        AddSfdps(ents, now, st); st.SfdpsMs = Lap(ph); st.SfdpsKB = LapAlloc(ref pa);
        AddTais(ents, now, st); st.TaisMs = Lap(ph); st.TaisKB = LapAlloc(ref pa);
        AddAsdex(ents, now, st); st.AsdexMs = Lap(ph); st.AsdexKB = LapAlloc(ref pa);

        // Everything above is exact-identity work. The tier below is the only one that reasons
        // about proximity, and it runs once over the finished set rather than per source - so a
        // candidate is weighed against every other candidate, which is what makes the
        // decline-on-ambiguity rule mean anything.
        CorrelateUnidentified(ents, now, st); st.CorrelateMs = Lap(ph); st.CorrelateKB = LapAlloc(ref pa);

        foreach (var e in ents.Values)
        {
            e.Classify();
            if (e.Positioned) st.Count(e.Cls); else st.Unpositioned++;
        }
        st.ClassifyMs = Lap(ph); st.ClassifyKB = LapAlloc(ref pa);

        // Every 30 s, so a 60 s track key is swept within half its own lifetime. ResolveId
        // refuses an expired key regardless, so the sweep is only about memory.
        if ((now - _lastEvict).TotalSeconds >= 30) { Evict(now); _lastEvict = now; }

        st.PassMs = sw.Elapsed.TotalMilliseconds;
        // THE number. On a box at load 5-10 the wall time above is mostly contention: measured,
        // the same pass read 295 ms wall / 75 ms CPU on one occasion and 416 / 433 on another.
        // Only this one is work.
        st.CpuMs = ThreadCpu.Since(cpu0);
        if (st.CpuMs is { } c)
        {
            _cpuSamples.Enqueue(c);
            while (_cpuSamples.Count > CpuWindow) _cpuSamples.Dequeue();
            double sum = 0;
            foreach (var v in _cpuSamples) sum += v;
            st.CpuMeanMs = Math.Round(sum / _cpuSamples.Count, 1);
            st.CpuSamples = _cpuSamples.Count;
        }
        st.AllocBytes = GC.GetAllocatedBytesForCurrentThread() - alloc0;
        st.KeyCount = _idByKey.Count;
        _lastEntityCount = ents.Count;
        return new NasSnapshot(now, ents, st);
    }

    // Allocation per phase, for the same reason as time per phase: 20.8 MB a pass is not
    // actionable, and the guess about which phase makes the garbage is no better than the guess
    // about which one burns the CPU was.
    private static double LapAlloc(ref long prev)
    {
        var now = GC.GetAllocatedBytesForCurrentThread();
        var kb = (now - prev) / 1024.0;
        prev = now;
        return Math.Round(kb, 0);
    }

    private static double Lap(Stopwatch sw)
    {
        var ms = sw.Elapsed.TotalMilliseconds;
        sw.Restart();
        return Math.Round(ms, 1);
    }

    // ── SFDPS: lowest position precedence, highest flight-plan precedence ───────────────
    private void AddSfdps(Dictionary<long, NasEntity> ents, DateTime now, NasFusionStats st)
    {
        // CURRENT LEG FIRST, and the reason is measured. One airframe flies two legs inside
        // SFDPS's 60-minute retention, so both records are live at once with the SAME Mode S and
        // often the same beacon code - which is correct, it IS one aeroplane, and the Mode S key
        // merges them into one entity as it should. But `Fill` keeps the FIRST non-null value,
        // and iterating a ConcurrentDictionary gave an arbitrary order, so WHICH LEG'S CALLSIGN
        // SURVIVED WAS A COIN FLIP.
        //
        // Measured on the live feed: 112 of 115 named SFDPS flights absent from the index were
        // present under the other leg's callsign - SWA519/SWA3872, JBU203/JBU204, ACA1322/
        // ACA1323, CNS333/N702NF. Consecutive leg numbers, same hex, same squawk, same position.
        // Nothing errors and the target count is right; a flight simply wears yesterday's name.
        //
        // TrackRoutes.CurrentLegFirst is the ordering that already exists for exactly this, and
        // it is reused rather than reimplemented: this repo has paid three times for two copies
        // of one rule.
        foreach (var f in TrackRoutes.CurrentLegFirst(_sfdps()))
        {
            if (f.FlightStatus == "CANCELLED") continue;
            if (LaddService.IsBlocked(f.Callsign, f.Registration, f.ModeSCode)) { st.LaddOmitted++; continue; }
            st.SfdpsRecords++;

            var keys = _keyScratch; keys.Clear();
            if (!string.IsNullOrEmpty(f.ModeSCode)) keys.Add(NasKey.Hex(f.ModeSCode!));
            if (!string.IsNullOrEmpty(f.Callsign)) keys.Add(NasKey.Cs(f.Callsign!));
            if (!string.IsNullOrEmpty(f.Gufi)) keys.Add(NasKey.Gufi(f.Gufi));
            if (!string.IsNullOrEmpty(f.FdpsGufi)) keys.Add(NasKey.Gufi(f.FdpsGufi!));
            if (keys.Count == 0) continue;

            var e = Get(ents, keys, now, st);
            e.Sources |= NasSource.Sfdps;

            Fill(ref e.Callsign, f.Callsign);
            Fill(ref e.ModeS, f.ModeSCode);
            Fill(ref e.Squawk, f.Squawk);
            Fill(ref e.Type, f.AircraftType);
            Fill(ref e.Origin, f.Origin);
            Fill(ref e.Dest, f.Destination);
            Fill(ref e.Wake, f.WakeCategory);
            Fill(ref e.Registration, f.Registration);
            Fill(ref e.Status, f.FlightStatus);
            if (e.Owner is null && !string.IsNullOrEmpty(f.ControllingFacility))
                e.Owner = f.ControllingSector is { Length: > 0 } s
                    ? f.ControllingFacility + "/" + s : f.ControllingFacility;

            if (f.Latitude is null || f.Longitude is null) { st.SfdpsNoPos++; continue; }
            var age = (now - f.LastPositionTime).TotalSeconds;
            if (f.LastPositionTime == default) age = (now - f.LastSeen).TotalSeconds;
            if (age > MaxPosAgeSec) { st.SfdpsStale++; continue; }

            // A DROPPED record is the losing center's dead leg; it loses to a live sibling of the
            // same callsign whatever the timestamps say. Same rule as TrackRoutes.CurrentLegFirst,
            // which exists because /track's hero once led with a 495-second-old DROPPED record.
            var penalty = f.FlightStatus == "DROPPED" ? 1 : 0;
            if (!e.TakePosition(NasPosRank.Sfdps, penalty, f.LastSeen)) continue;
            e.Lat = f.Latitude.Value; e.Lon = f.Longitude.Value;
            e.AltFt = f.ReportedAltitude is { } ra ? (int)ra : null;
            e.Gs = f.GroundSpeed is { } gs ? (int)gs : null;
            e.Trk = Heading(f.TrackVelocityX, f.TrackVelocityY);
            e.PosAgeSec = (int)age;
            st.SfdpsPositions++;
        }
    }

    // ── TAIS / STARS: the terminal picture, and where the uncorrelated targets live ─────
    private void AddTais(Dictionary<long, NasEntity> ents, DateTime now, NasFusionStats st)
    {
        foreach (var (facility, t) in _tais())
        {
            if (LaddService.IsBlocked(t.Callsign, null, t.ModeSCode)) { st.LaddOmitted++; continue; }
            st.TaisRecords++;
            if (t.Latitude == 0 && t.Longitude == 0) continue;

            var keys = _keyScratch; keys.Clear();
            keys.Add(NasKey.Track(facility, t.TrackNum));
            if (!string.IsNullOrEmpty(t.ModeSCode)) keys.Add(NasKey.Hex(t.ModeSCode!));
            if (!string.IsNullOrEmpty(t.Callsign)) keys.Add(NasKey.Cs(t.Callsign!));

            var e = Get(ents, keys, now, st);
            e.Sources |= NasSource.Tais;
            e.Facility ??= facility;
            if (t.IsPseudo) e.Pseudo = true;

            Fill(ref e.Callsign, t.Callsign);
            Fill(ref e.ModeS, t.ModeSCode);
            Fill(ref e.Squawk, t.ReportedSquawk ?? t.AssignedSquawk);
            Fill(ref e.Type, t.AircraftType);
            Fill(ref e.Origin, t.Origin);
            Fill(ref e.Dest, t.Destination);
            Fill(ref e.Wake, t.WakeCategory);
            if (e.Owner is null && !string.IsNullOrEmpty(t.Owner)) e.Owner = facility + "/" + t.Owner;

            var age = (now - t.LastSeen).TotalSeconds;
            if (!e.TakePosition(NasPosRank.Tais, 0, t.LastSeen)) continue;
            e.Lat = t.Latitude; e.Lon = t.Longitude;
            e.AltFt = t.AltitudeFeet;
            e.Gs = t.GroundSpeedKnots;
            e.Trk = t.GroundTrackDegrees;
            e.PosAgeSec = (int)age;
            st.TaisPositions++;
        }
    }

    // ── ASDE-X: highest position precedence (1 s updates), and the only surface truth ───
    private void AddAsdex(Dictionary<long, NasEntity> ents, DateTime now, NasFusionStats st)
    {
        foreach (var t in _asdex())
        {
            if (LaddService.IsBlocked(t.Callsign, null, null)) { st.LaddOmitted++; continue; }
            st.AsdexRecords++;
            if (t.Latitude == 0 && t.Longitude == 0) continue;

            var keys = _keyScratch; keys.Clear();
            keys.Add(NasKey.Surface(t.Airport, t.TrackId));
            if (!string.IsNullOrEmpty(t.Callsign)) keys.Add(NasKey.Cs(t.Callsign!));
            if (!string.IsNullOrEmpty(t.SfdpsGufi)) keys.Add(NasKey.Gufi(t.SfdpsGufi!));

            var e = Get(ents, keys, now, st);
            e.Sources |= NasSource.Asdex;
            e.Airport ??= t.Airport;
            if (string.Equals(t.TargetType, "vehicle", StringComparison.OrdinalIgnoreCase))
                e.Vehicle = true;

            Fill(ref e.Callsign, t.Callsign);
            Fill(ref e.Squawk, t.Squawk);
            Fill(ref e.Type, t.AircraftType);
            Fill(ref e.Origin, t.FpOrigin ?? t.AdDeparture);
            Fill(ref e.Dest, t.FpDestination ?? t.AdDestination);
            Fill(ref e.Wake, t.WakeCategory);

            var age = (now - t.LastSeen).TotalSeconds;
            if (!e.TakePosition(NasPosRank.Asdex, 0, t.LastSeen)) continue;
            e.Lat = t.Latitude; e.Lon = t.Longitude;
            e.AltFt = t.AltitudeFeet is { } a ? (int)a : null;
            e.Gs = t.SpeedKts;
            e.Trk = t.HeadingDegrees is { } h ? (int)h : null;
            e.PosAgeSec = (int)age;
            st.AsdexPositions++;
        }
    }

    // ── The proximity tier: the only place in the index that reasons about distance ─────
    //
    // Tier 3 (discrete beacon + 5 NM/1,000 ft) MERGES: a discrete code identifies one aircraft,
    // so agreement inside the gate is a positive correlation, and this is the rule the STARS
    // enrichment service already runs on the other side of the house.
    //
    // TIER 4 (POSITION ONLY) IS MEASURED ON A SAMPLE AND NEVER APPLIED. With no identifier there
    // is no tiebreaker, so "nearest wins" produces a confidently wrong answer rather than a weak
    // one. It was built to be counted so the numbers could decide whether it was worth doing, and
    // on the live daytime feed they said no: of 10,655 unidentified targets it would have named
    // 106 - ONE PERCENT - while 9,650 had no candidate within 1.5 NM at all, because an
    // uncorrelated primary return is overwhelmingly not an aircraft SFDPS is also tracking. It
    // stays as a sampled counter so that answer can be re-checked rather than assumed.
    //
    // AND THAT SCAN WAS THE WHOLE COST OF THE PASS. Running the 9-cell grid probe for every
    // unidentified target measured 196 of 245 ms - 80% of the CPU this index spends, on a tier
    // that is deliberately inert. Tier 3 needs the probe only for targets carrying a DISCRETE
    // beacon code, which is a few hundred rather than ten thousand.
    private const int PosSampleEvery = 8;

    private void CorrelateUnidentified(Dictionary<long, NasEntity> ents, DateTime now, NasFusionStats st)
    {
        // Candidates: entities SFDPS has positioned and named. Bucketed at 0.5 degrees (~30 NM),
        // so both gates are satisfied by probing the 3x3 neighbourhood.
        var grid = new Dictionary<long, List<NasEntity>>();
        foreach (var e in ents.Values)
        {
            if ((e.Sources & NasSource.Sfdps) == 0) continue;
            if (e.PosRank != NasPosRank.Sfdps || e.Callsign is null) continue;
            var c = Cell(e.Lat, e.Lon);
            if (!grid.TryGetValue(c, out var l)) grid[c] = l = new();
            l.Add(e);
        }
        st.CandidateCells = grid.Count;

        // Only unidentified, positioned, non-surface targets are worth correlating - a parked
        // vehicle at ORD is not an SFDPS flight, and a named target needs nothing.
        var pending = new List<NasEntity>();
        foreach (var e in ents.Values)
            if (e.Callsign is null && e.ModeS is null && !e.Vehicle && e.PosRank != NasPosRank.None)
                pending.Add(e);
        st.Unidentified = pending.Count;

        int n = 0;
        foreach (var e in pending)
        {
            var discrete = BeaconCodes.IsDiscrete(e.Squawk);
            var sampled = (n++ % PosSampleEvery) == 0;
            // A target with no discrete code that is not in the sample costs nothing at all,
            // which is the point: that is nine in ten of them.
            if (!discrete && !sampled) continue;
            if (sampled) st.PositionSampled++;

            NasEntity? beaconHit = null; int beaconN = 0;
            int posN = 0;
            for (int dy = -1; dy <= 1; dy++)
                for (int dx = -1; dx <= 1; dx++)
                {
                    if (!grid.TryGetValue(Cell(e.Lat + dy * 0.5, e.Lon + dx * 0.5), out var l)) continue;
                    foreach (var c in l)
                    {
                        var d = Nm(e.Lat, e.Lon, c.Lat, c.Lon);
                        var dz = e.AltFt is { } a && c.AltFt is { } b ? Math.Abs(a - b) : int.MaxValue;
                        if (discrete && e.Squawk == c.Squawk && d <= BeaconGateNm && dz <= BeaconGateFt)
                        { beaconHit = c; beaconN++; }
                        if (sampled && d <= PosGateNm && dz <= PosGateFt) posN++;
                    }
                }

            if (beaconN == 1) { Merge(ents, e, beaconHit!, now); st.MatchedByBeacon++; continue; }
            if (beaconN > 1) st.BeaconAmbiguous++;

            if (!sampled) continue;
            if (posN == 1) st.WouldMatchByPosition++;
            else if (posN > 1) st.PositionAmbiguous++;
            else st.PositionNoCandidate++;
        }
    }

    /// <summary>
    /// Folds <paramref name="from"/> into <paramref name="into"/> and re-points every key the
    /// loser answered to, so the next pass resolves straight to the winner and the merge is
    /// remembered rather than recomputed. The loser's position wins when its rank is higher
    /// (a terminal fix beats an en-route one), which is the whole point of correlating it.
    /// </summary>
    private void Merge(Dictionary<long, NasEntity> ents, NasEntity from, NasEntity into, DateTime now)
    {
        if (from.Id == into.Id) return;
        into.Sources |= from.Sources;
        into.Facility ??= from.Facility;
        into.Airport ??= from.Airport;
        Fill(ref into.Squawk, from.Squawk);
        if (from.PosRank > into.PosRank)
        {
            into.Lat = from.Lat; into.Lon = from.Lon; into.PosRank = from.PosRank;
            into.AltFt = from.AltFt ?? into.AltFt;
            into.Gs = from.Gs ?? into.Gs;
            into.Trk = from.Trk ?? into.Trk;
            into.PosAgeSec = from.PosAgeSec;
        }
        ents.Remove(from.Id);
        foreach (var k in from.Keys) _idByKey[k] = new KeyRef(into.Id, now);
        into.Keys.AddRange(from.Keys);
    }

    // ── Identity ───────────────────────────────────────────────────────────────────────

    // One scratch list, cleared per record rather than allocated per record. 26,000 records a
    // pass is 26,000 list-plus-array allocations for something that lives three statements.
    // Safe because the whole pass runs under _gate on one thread.
    private readonly List<NasKey> _keyScratch = new(4);

    private NasEntity Get(Dictionary<long, NasEntity> ents, List<NasKey> keys, DateTime now, NasFusionStats st)
    {
        var id = ResolveId(keys, now, st);
        if (!ents.TryGetValue(id, out var e)) ents[id] = e = new NasEntity { Id = id };
        foreach (var k in keys) if (!e.Keys.Contains(k)) e.Keys.Add(k);
        return e;
    }

    /// <summary>
    /// The lowest id any of these keys already resolves to, or a fresh one. Every key is then
    /// pointed at the winner — which is both how a new key joins an existing entity and how two
    /// entities that turn out to be one converge instead of alternating.
    /// </summary>
    private long ResolveId(List<NasKey> keys, DateTime now, NasFusionStats st)
    {
        long id = 0; int hits = 0;
        foreach (var k in keys)
        {
            if (!_idByKey.TryGetValue(k, out var r)) continue;
            // An expired key is treated as absent rather than deleted here: eviction is a
            // separate sweep, and a stale TRACK key must stop answering the moment it is stale,
            // not at the next sweep. Otherwise the recycled-track-number bug survives in the
            // window between the two.
            if ((now - r.Seen).TotalSeconds > TtlSeconds(k.Kind)) { st.KeysExpired++; continue; }
            hits++;
            if (id == 0 || r.Id < id) id = r.Id;
        }
        if (id == 0) { id = Interlocked.Increment(ref _nextId); st.NewIds++; }
        else if (hits > 1) st.KeyAgreements++;

        foreach (var k in keys)
        {
            // Only write when the answer changed or the timestamp is getting old. See
            // RefreshFraction: an unconditional write allocates a dictionary node per key per
            // pass, which was ~3 MB of the garbage for no new information.
            if (_idByKey.TryGetValue(k, out var cur) && cur.Id == id
                && (now - cur.Seen).TotalSeconds < TtlSeconds(k.Kind) / (double)RefreshFraction)
            { st.KeyWritesSkipped++; continue; }
            _idByKey[k] = new KeyRef(id, now);
        }
        return id;
    }

    /// <summary>
    /// Bound the key map. Without this it is a permanent record of every target ever seen —
    /// the same unbounded-cache shape that cost this repo 8 MB of retained heap per day searched
    /// in <c>FlightHistoryIndex</c>.
    /// </summary>
    private void Evict(DateTime now)
    {
        foreach (var (k, r) in _idByKey)
            if ((now - r.Seen).TotalSeconds > TtlSeconds(k.Kind)) _idByKey.TryRemove(k, out _);
    }

    // ── Geometry / small helpers ───────────────────────────────────────────────────────

    private static long Cell(double lat, double lon) =>
        (long)Math.Floor((lat + 90) * 2) * 2000 + (long)Math.Floor((lon + 180) * 2);

    private static double Nm(double lat1, double lon1, double lat2, double lon2)
    {
        var dLat = (lat2 - lat1) * 60.0;
        var dLon = (lon2 - lon1) * 60.0 * Math.Cos((lat1 + lat2) * 0.5 * Math.PI / 180.0);
        return Math.Sqrt(dLat * dLat + dLon * dLon);
    }

    /// <summary>
    /// Track from the ERAM velocity components. These are KNOTS of north/east travel, so the
    /// heading is atan2(x, y) with x east — the same convention eram.js draws vectors with, and
    /// the one the TBFM map got wrong by a factor of 60 by treating them as degrees per hour.
    /// </summary>
    internal static int? Heading(double? vx, double? vy)
    {
        if (vx is not { } x || vy is not { } y) return null;
        if (Math.Abs(x) < 0.01 && Math.Abs(y) < 0.01) return null;
        var deg = Math.Atan2(x, y) * 180.0 / Math.PI;
        return (int)Math.Round((deg + 360) % 360);
    }

    private static void Fill(ref string? field, string? value)
    {
        if (field is null && !string.IsNullOrWhiteSpace(value)) field = value;
    }
}

/// <summary>
/// One identity key: a kind plus one or two strings it ALREADY HAS.
///
/// <para><b>This replaced string keys, and the reason is measured.</b> Building them as
/// <c>"H:" + hex</c> made the two main source loops 94% of the index's garbage — <b>1,349 bytes
/// per SFDPS record and 847 per TAIS record</b>, 29 MB a pass, 36 GB an hour, landing on a
/// process already spending ~17% of its time in GC. Most of it was concatenation: an SFDPS flight
/// builds four keys and two of them prefix a ~40-character GUFI, and the facility/track keys
/// concatenated three strings each. None of that produced any information the parts didn't
/// already carry.</para>
///
/// <para>Two string slots rather than one so <c>T:</c> and <c>A:</c> can hold
/// (facility, track) without joining them. Equality is ORDINAL-IGNORE-CASE, which also removed
/// the <c>ToUpperInvariant()</c> that was allocating once per callsign per pass.</para>
/// </summary>
readonly struct NasKey : IEquatable<NasKey>
{
    /// <summary>'H' Mode S, 'C' callsign, 'G' GUFI, 'T' facility track, 'A' airport track.</summary>
    public readonly byte Kind;
    public readonly string A;
    public readonly string? B;

    private NasKey(byte kind, string a, string? b) { Kind = kind; A = a; B = b; }

    public static NasKey Hex(string hex) => new((byte)'H', hex, null);
    public static NasKey Cs(string callsign) => new((byte)'C', callsign, null);
    public static NasKey Gufi(string gufi) => new((byte)'G', gufi, null);
    public static NasKey Track(string facility, string trackNum) => new((byte)'T', facility, trackNum);
    public static NasKey Surface(string airport, string trackId) => new((byte)'A', airport, trackId);

    public bool Equals(NasKey o) =>
        Kind == o.Kind
        && StringComparer.OrdinalIgnoreCase.Equals(A, o.A)
        && StringComparer.OrdinalIgnoreCase.Equals(B, o.B);

    public override bool Equals(object? o) => o is NasKey k && Equals(k);

    public override int GetHashCode() => HashCode.Combine(
        Kind,
        StringComparer.OrdinalIgnoreCase.GetHashCode(A),
        B is null ? 0 : StringComparer.OrdinalIgnoreCase.GetHashCode(B));

    public override string ToString() => B is null ? $"{(char)Kind}:{A}" : $"{(char)Kind}:{A}/{B}";
}

[Flags]
enum NasSource : byte { None = 0, Sfdps = 1, Tais = 2, Asdex = 4 }

/// <summary>Which source a position came from. Higher wins — ASDE-X reports every second.</summary>
enum NasPosRank : byte { None = 0, Sfdps = 1, Tais = 2, Asdex = 3 }

/// <summary>
/// What a target IS, which the map needs because half the uncorrelated population is not aircraft.
/// Measured: 1,725 of 3,483 untagged TAIS tracks report altitude 0 AND under 100 kt, clustered at
/// plains TRACONs (DSM/SUX/ACT/FSD/ICT) at local midnight in November — live returns, p50 age
/// 15-30 s, so they are real radar, just not airplanes. Drawing them unlabelled would make the
/// NAS view ~30% clutter; dropping them silently would be a lie about what the radar sees.
/// </summary>
enum NasClass : byte
{
    EnRoute = 0, Terminal = 1, Surface = 2, Vehicle = 3,
    /// <summary>No identity, but plausibly an aircraft (above 500 ft or at/over 100 kt).</summary>
    Untagged = 4,
    /// <summary>No identity, no Mode C, slow — the primary-only noise floor.</summary>
    Primary = 5,
}

class NasEntity
{
    public long Id;
    public List<NasKey> Keys = new(4);
    public NasSource Sources;
    public NasPosRank PosRank;
    private int _posPenalty = int.MaxValue;
    private DateTime _posTime = DateTime.MinValue;

    public string? Callsign, ModeS, Squawk, Type, Origin, Dest, Wake, Registration, Status;
    public string? Owner, Facility, Airport;
    public bool Vehicle, Pseudo;
    public double Lat, Lon;
    public int? AltFt, Gs, Trk;
    public int PosAgeSec;
    public NasClass Cls;

    /// <summary>
    /// Whether this source may write the position. A higher-ranked source always wins; within a
    /// rank, an un-penalised record beats a penalised one (a live leg beats a DROPPED one) and
    /// then the fresher fix wins.
    /// </summary>
    public bool TakePosition(NasPosRank rank, int penalty, DateTime t)
    {
        if (rank < PosRank) return false;
        if (rank == PosRank)
        {
            if (penalty > _posPenalty) return false;
            if (penalty == _posPenalty && t <= _posTime) return false;
        }
        PosRank = rank; _posPenalty = penalty; _posTime = t;
        return true;
    }

    /// <summary>
    /// <b>Surface means ON the surface, not "ASDE-X positioned it".</b> The first version keyed
    /// this on the positioning source, and the source cross-check caught it immediately: ASDE-X
    /// covers the approach and departure corridors, so it was labelling UCA4347 at 3,387 ft and
    /// 221 kt a surface target, along with ~200 others. A map draws the class, so those would
    /// have been taxiing symbols several thousand feet up.
    ///
    /// <para>The gate is ground speed under <see cref="SurfaceMaxKts"/>, which is the same 40 kt
    /// rule <c>/track</c>'s phase label already uses to tell a taxiing aircraft from a rollout —
    /// measured there over 290 ASDE-X callsigns. A fast target in surface coverage falls through
    /// to whatever else knows about it, which is what it is.</para>
    /// </summary>
    public void Classify()
    {
        if (Vehicle) { Cls = NasClass.Vehicle; return; }

        var onSurface = PosRank == NasPosRank.Asdex && (Gs ?? 0) < SurfaceMaxKts;
        if (Callsign is not null || ModeS is not null)
        {
            Cls = onSurface ? NasClass.Surface
                : (Sources & NasSource.Sfdps) != 0 ? NasClass.EnRoute
                : NasClass.Terminal;
            return;
        }
        // Unidentified. On the surface it is a primary return whatever its Mode C says (an
        // airport's altitude is not zero); airborne, the noise floor is no Mode C and slow.
        if (onSurface) { Cls = NasClass.Primary; return; }
        Cls = (AltFt ?? 0) > 500 || (Gs ?? 0) >= 100 ? NasClass.Untagged : NasClass.Primary;
    }

    /// <summary>
    /// Above this, a target in surface coverage is flying, not taxiing. Same threshold
    /// <c>/track</c> uses to separate a taxiing aircraft from a rollout.
    /// </summary>
    public const int SurfaceMaxKts = 40;

    /// <summary>
    /// Whether this entity can be DRAWN. False for a flight plan with no radar position — 14% of
    /// SFDPS is PROPOSED and not yet departed, and those records legitimately belong in the index
    /// (they carry identity, so the id survives into the flight) but have no lat/lon at all.
    ///
    /// <para>Found by cross-checking the output: 4,008 entities sat at exactly (0, 0), which on a
    /// map is a tight cluster in the Gulf of Guinea. It would have read as a projection or
    /// rendering fault rather than as the index emitting things it has no position for.</para>
    /// </summary>
    public bool Positioned => PosRank != NasPosRank.None;

    /// <summary>
    /// The streaming form: a positional array, no field names. That encoding is what makes a
    /// whole-NAS update affordable — ~30 bytes/target, so ~170 kB uncompressed at 5,710 targets
    /// and ~24 kB after the permessage-deflate every socket here already negotiates.
    ///
    /// <para><b>Five decimal places, not four.</b> One rounding has to serve a view that spans
    /// the continent and a view of one airport, and those want opposite things. 4 dp is 11 m —
    /// about a thousandth of a pixel at CONUS zoom, but a visible quantisation on the surface,
    /// where ASDE-X reports to roughly a metre and a pixel is a couple of metres. 5 dp is 1.1 m,
    /// costs one character per coordinate, and is the only one of the two that is right in both
    /// places.</para>
    ///
    /// <para>A field added here goes on the END — clients decode by index.</para>
    /// </summary>
    public object[] ToDelta() => new object[]
    {
        Id, Math.Round(Lat, 5), Math.Round(Lon, 5),
        AltFt ?? 0, Trk ?? 0, Gs ?? 0, (int)Cls,
    };

    /// <summary>
    /// The form sent when a target FIRST enters a client's view: the volatile fields plus the
    /// identity, in one array.
    ///
    /// <para>Identity is what hover, labels and client-side highlighting all need, and it is also
    /// what almost never changes — so sending it on every tick would pay for it hundreds of times
    /// over. It rides the add instead, and <see cref="ToDelta"/> stays at seven fields for the
    /// updates, which are the overwhelming majority of what crosses the wire. A target whose
    /// identity DOES change (an untagged return the facility correlates) is re-sent as an add,
    /// which the client treats as an upsert.</para>
    ///
    /// <para>Same rule as ToDelta: a new field goes on the END.</para>
    /// </summary>
    public object[] ToAdd() => new object[]
    {
        Id, Math.Round(Lat, 5), Math.Round(Lon, 5),
        AltFt ?? 0, Trk ?? 0, Gs ?? 0, (int)Cls,
        Callsign ?? "", Type ?? "", Origin ?? "", Dest ?? "", Owner ?? "",
    };

    /// <summary>Hash of just the identity fields, so the stream can tell an ordinary position
    /// update from one that has to re-send who the target is.</summary>
    public int IdentityHash() => HashCode.Combine(Callsign, Type, Origin, Dest, Owner);

    public object ToJson() => new
    {
        id = Id,
        cs = Callsign,
        hex = ModeS,
        sq = Squawk,
        type = Type,
        wake = Wake,
        reg = Registration,
        origin = Origin,
        dest = Dest,
        owner = Owner,
        facility = Facility,
        airport = Airport,
        lat = Math.Round(Lat, 5),
        lon = Math.Round(Lon, 5),
        altFt = AltFt,
        gs = Gs,
        trk = Trk,
        ageSec = PosAgeSec,
        cls = Cls.ToString().ToLowerInvariant(),
        src = Sources.ToString().Replace(" ", "").ToLowerInvariant(),
        posSrc = PosRank.ToString().ToLowerInvariant(),
        status = Status,
        pseudo = Pseudo ? true : (bool?)null,
    };
}

class NasSnapshot
{
    public static readonly NasSnapshot Empty =
        new(DateTime.MinValue, new Dictionary<long, NasEntity>(), new NasFusionStats());

    public DateTime Built { get; }
    public IReadOnlyDictionary<long, NasEntity> Entities { get; }
    public NasFusionStats Stats { get; }

    public NasSnapshot(DateTime built, Dictionary<long, NasEntity> ents, NasFusionStats stats)
    {
        Built = built; Entities = ents; Stats = stats;
    }
}

/// <summary>
/// What the pass did, which is the entire product of step one. Match counts split by TIER because
/// a single "matched" number cannot distinguish "ADS-B-style coverage improved" from "we started
/// reading a source we already had" — the same split that made the STARS enrichment gap findable.
/// </summary>
class NasFusionStats
{
    public double PassMs;
    public long AllocBytes;
    public double? CpuMs;
    public double CpuMeanMs;
    public int CpuSamples;
    public double SfdpsMs, TaisMs, AsdexMs, CorrelateMs, ClassifyMs;
    public double SfdpsKB, TaisKB, AsdexKB, CorrelateKB, ClassifyKB;
    public int SfdpsRecords, SfdpsPositions, SfdpsStale, SfdpsNoPos;
    public int TaisRecords, TaisPositions;
    public int AsdexRecords, AsdexPositions;
    public int LaddOmitted;

    public int NewIds, KeyAgreements, KeysExpired, KeyWritesSkipped, KeyCount;

    public int Unidentified, CandidateCells, PositionSampled;
    public int Unpositioned;
    public int MatchedByBeacon, BeaconAmbiguous;
    public int WouldMatchByPosition, PositionAmbiguous, PositionNoCandidate;

    private readonly int[] _cls = new int[6];
    public void Count(NasClass c) => _cls[(int)c]++;
    public int Of(NasClass c) => _cls[(int)c];
    public int Total { get { int n = 0; foreach (var v in _cls) n += v; return n; } }

    public object ToJson(int rawRecords) => new
    {
        // cpuMs is the cost; passMs is cost PLUS whatever else the box was doing. Quote the
        // mean, not a sample: one CPU reading is a single 10 ms clock tick of resolution.
        cpuMs = CpuMs is { } c ? Math.Round(c, 1) : (double?)null,
        cpuMeanMs = CpuSamples > 0 ? CpuMeanMs : (double?)null,
        cpuSamples = CpuSamples,
        // ...and what that mean costs at the 2 s cadence, as a share of ONE core.
        corePctAt2s = CpuSamples > 0 ? Math.Round(CpuMeanMs / 2000.0 * 100, 1) : (double?)null,
        passMs = Math.Round(PassMs, 1),
        // Garbage made per pass, and what that is per hour at the 2 s cadence. The second
        // number is the one that matters: this process already spends ~17% of its time in GC.
        allocMB = Math.Round(AllocBytes / 1048576.0, 1),
        allocGBPerHourAt2s = Math.Round(AllocBytes / 1073741824.0 * 1800, 2),
        // Per phase: the total is not actionable, and the first guess about which
        // phase dominates was wrong here by a factor of four.
        phaseMs = new { sfdps = SfdpsMs, tais = TaisMs, asdex = AsdexMs, correlate = CorrelateMs, classify = ClassifyMs },
        phaseKB = new { sfdps = SfdpsKB, tais = TaisKB, asdex = AsdexKB, correlate = CorrelateKB, classify = ClassifyKB },
        // Drawable entities. `unpositioned` above are held but cannot be placed.
        entities = Total,
        entitiesHeld = Total + Unpositioned,
        rawRecords,
        // 1.00 means every record was a distinct airplane. Measured 1.05x at the overnight
        // trough, which is why fusion here is an identity problem and not a dedup one.
        duplication = Total == 0 ? 0 : Math.Round((double)rawRecords / Total, 3),
        // Entities held but NOT drawable: a flight plan with no radar position. They stay in
        // the index because they carry identity, so the id survives into the flight once it
        // departs - but emitting them would put them at (0, 0).
        unpositioned = Unpositioned,
        classes = new
        {
            enroute = Of(NasClass.EnRoute),
            terminal = Of(NasClass.Terminal),
            surface = Of(NasClass.Surface),
            vehicle = Of(NasClass.Vehicle),
            untagged = Of(NasClass.Untagged),
            primary = Of(NasClass.Primary),
        },
        sources = new
        {
            sfdps = new { records = SfdpsRecords, positions = SfdpsPositions, stale = SfdpsStale, noPosition = SfdpsNoPos },
            tais = new { records = TaisRecords, positions = TaisPositions },
            asdex = new { records = AsdexRecords, positions = AsdexPositions },
            laddOmitted = LaddOmitted,
        },
        identity = new
        {
            newIds = NewIds,
            keyAgreements = KeyAgreements,
            // Keys that answered too late to be trusted. Overwhelmingly recycled TRACK numbers,
            // which is the whole reason the two kinds of key have different lifetimes.
            keysExpired = KeysExpired,
            // Key writes avoided because the answer had not changed. Each one would have been a
            // fresh dictionary node; this is the difference between ~68,000 node allocations a
            // pass and a few thousand.
            keyWritesSkipped = KeyWritesSkipped,
            keys = KeyCount,
        },
        correlation = new
        {
            unidentified = Unidentified,
            candidateCells = CandidateCells,
            matchedByBeacon = MatchedByBeacon,
            beaconAmbiguous = BeaconAmbiguous,
            // Tier 4 is measured on a 1-in-8 sample and NEVER applied. The three counts below
            // are over positionSampled, not over unidentified - they are a rate, not a total,
            // and reading them as totals understates by 8x.
            positionSampled = PositionSampled,
            wouldMatchByPosition = WouldMatchByPosition,
            positionAmbiguous = PositionAmbiguous,
            positionNoCandidate = PositionNoCandidate,
        },
    };
}
