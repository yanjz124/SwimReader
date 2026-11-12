namespace SwimServer.Tests;

/// <summary>
/// The fused NAS index. Every rule here is one a browser and a live <c>curl</c> are both blind
/// to: a target drawn from the wrong source, from a dead leg, from a 50-minute-old fix, or given
/// a neighbour's callsign all render as a perfectly plausible airplane in the right part of the
/// country. The repo has already paid for exactly this class of bug twice — the ADS-B callsign
/// landing in fields nothing read (every counter healthy, scope correctly blank) and the
/// cache-busting no-op (every clean-browser check passing regardless).
/// </summary>
public class NasFusionTests
{
    private static NasFusion Fuse(
        IEnumerable<FlightState>? sfdps = null,
        IEnumerable<(string, TaisTrack)>? tais = null,
        IEnumerable<AsdexTrack>? asdex = null,
        Func<DateTime>? now = null) =>
        new(() => sfdps ?? Array.Empty<FlightState>(),
            () => tais ?? Array.Empty<(string, TaisTrack)>(),
            () => asdex ?? Array.Empty<AsdexTrack>(),
            now);

    private static FlightState Flight(string gufi, string? cs = null, string? hex = null,
        double lat = 39, double lon = -77, int alt = 35000, int ageSec = 5,
        string? status = "ACTIVE", string? sq = null, double? vx = null, double? vy = null)
    {
        var now = DateTime.UtcNow.AddSeconds(-ageSec);
        return new FlightState
        {
            Gufi = gufi, Callsign = cs, ModeSCode = hex, Squawk = sq,
            Latitude = lat, Longitude = lon, ReportedAltitude = alt,
            FlightStatus = status, LastSeen = now, LastPositionTime = now,
            TrackVelocityX = vx, TrackVelocityY = vy,
        };
    }

    private static TaisTrack Tais(string fac, string num, string? cs = null, string? hex = null,
        double lat = 39, double lon = -77, int? alt = 6000, int? gs = 250, string? sq = null) =>
        new()
        {
            Facility = fac, TrackNum = num, Callsign = cs, ModeSCode = hex,
            Latitude = lat, Longitude = lon, AltitudeFeet = alt, GroundSpeedKnots = gs,
            ReportedSquawk = sq, LastSeen = DateTime.UtcNow,
        };

    private static AsdexTrack Asdex(string apt, string id, string? cs = null,
        double lat = 39, double lon = -77, string? tgt = "aircraft") =>
        new()
        {
            Airport = apt, TrackId = id, Callsign = cs, TargetType = tgt,
            Latitude = lat, Longitude = lon, AltitudeFeet = 20, SpeedKts = 8,
            LastSeen = DateTime.UtcNow,
        };

    private static NasEntity One(NasSnapshot s) => Assert.Single(s.Entities.Values);

    // ── Identity ────────────────────────────────────────────────────────────────────────

    /// <summary>
    /// The whole reason identity is a key ladder. A primary target is reachable only by its
    /// facility/track number; when the facility correlates it, a callsign and a Mode S code
    /// appear and the track number stays. If identity were keyed on "best available id" the
    /// entity would be reborn at that moment and its history trail and leader line would snap —
    /// visibly, and only for the targets a controller is least able to identify by other means.
    /// </summary>
    [Fact]
    public void AnEntityIdSurvivesATargetBecomingCorrelated()
    {
        var t = Tais("PCT", "0421");
        var f = Fuse(tais: new[] { ("PCT", t) });

        var before = One(f.Rebuild());
        Assert.Equal(NasClass.Untagged, before.Cls);

        t.Callsign = "N123AB";
        t.ModeSCode = "a1b2c3";
        var after = One(f.Rebuild());

        Assert.Equal(before.Id, after.Id);
        Assert.Equal("N123AB", after.Callsign);
    }

    /// <summary>
    /// Two entities that turn out to be one must CONVERGE on a single id, and specifically on the
    /// OLDER one — otherwise a correlation that arrives from the terminal side renames an aircraft
    /// the en-route side has been tracking for an hour, and every history trail and leader line
    /// attached to it snaps.
    ///
    /// <para>The conflict has to be built across two passes to exist at all: pass one mints
    /// separate ids (SFDPS is added first, so it gets the lower one), and only in pass two does
    /// the TAIS track gain the Mode S code that makes both keys resolve. A single-pass version of
    /// this test cannot tell "lowest wins" from "highest wins" — measured: that mutation left all
    /// 171 tests green.</para>
    /// </summary>
    [Fact]
    public void TwoKeysResolvingToDifferentIdsConvergeOnTheOlderId()
    {
        var t = Tais("PCT", "0500", lat: 39.1, lon: -77.1, alt: 9000);
        var fl = Flight("g1", cs: "AAL100", hex: "abc123", lat: 39.1, lon: -77.1, alt: 9000);
        var f = Fuse(sfdps: new[] { fl }, tais: new[] { ("PCT", t) });

        // Pass 1: two aircraft as far as the index can tell — one named, one a bare track number.
        var first = f.Rebuild();
        Assert.Equal(2, first.Entities.Count);
        var enRouteId = first.Entities.Values.Single(e => e.Callsign == "AAL100").Id;
        var trackId = first.Entities.Values.Single(e => e.Callsign is null).Id;
        Assert.True(enRouteId < trackId, "SFDPS is added first, so it should hold the older id");

        // Pass 2: the facility correlates it. Now the track key and the Mode S key disagree about
        // which entity this is, and the older id must win.
        t.ModeSCode = "abc123";
        t.Callsign = "AAL100";
        var merged = f.Rebuild();

        Assert.Single(merged.Entities);
        Assert.Equal(enRouteId, One(merged).Id);

        // And it stays there — convergence, not alternation.
        Assert.Equal(enRouteId, One(f.Rebuild()).Id);
        Assert.Equal(enRouteId, One(f.Rebuild()).Id);

        // Now the facility DROPS the correlation, which happens routinely — SMES and TAIS both
        // reclassify an identified track as unknown for a few cycles. The track key is all that
        // is left, and it must not drag the entity back to the id it was minted with. This is
        // the case re-pointing every key at the winner exists for, and the ONLY one that can see
        // it: "lowest id wins" is deterministic on its own, so without this the rule can be
        // deleted with all 171 tests still green (measured).
        t.ModeSCode = null;
        t.Callsign = null;
        var uncorrelatedAgain = f.Rebuild();
        Assert.Equal(enRouteId, uncorrelatedAgain.Entities.Values
            .Single(e => e.Facility == "PCT").Id);
    }

    /// <summary>
    /// SFDPS publishes one record per ARTCC tracking a flight, so a single airplane routinely
    /// arrives as several GUFIs. Those must be one entity or the map draws the same airliner
    /// three times — this is the dedup half of fusion, small though it measures (1.05x).
    /// </summary>
    [Fact]
    public void SeveralGufisOfOneCallsignAreOneEntity()
    {
        var s = Fuse(sfdps: new[]
        {
            Flight("g-zdc", cs: "UAL55", lat: 39.0, lon: -77.0),
            Flight("g-zny", cs: "UAL55", lat: 39.0, lon: -77.0),
        }).Rebuild();

        Assert.Single(s.Entities);
        Assert.Equal(2, s.Stats.SfdpsRecords);
    }

    /// <summary>
    /// <b>A track number is not an identity.</b> It is a slot a facility assigns and then
    /// RECYCLES, so it must stop answering long before a Mode S code or a callsign does.
    ///
    /// <para>This was found by measuring the key map rather than by reading the code: under
    /// continuous demand it settled at ~110,000 keys against only ~19,000 live entities, because
    /// terminal churn mints ~130 new entities per pass (~65 targets a second, average track life
    /// about three minutes) and every key was held for ten minutes. The memory was affordable;
    /// the correctness was not. At a busy TRACON, ten minutes is long enough to reissue a number
    /// this index still holds — and the next aircraft to get it would inherit the previous one's
    /// entity id, so the client draws a single history trail leaping between two aeroplanes.
    /// Nothing errors, and no counter moves.</para>
    ///
    /// <para>Sixty seconds is what a track key is actually for: covering a scan or two of silence
    /// so a trail does not break. An identity key keeps the full ten minutes, because a Mode S
    /// hex still names the same aircraft after a gap.</para>
    /// </summary>
    [Fact]
    public void ATrackNumberExpiresFastAndAnIdentityDoesNot()
    {
        var clock = DateTime.UtcNow;
        var track = Tais("PCT", "0421");                       // no callsign, no Mode S
        var named = Flight("g1", cs: "AAL100", hex: "abc123");
        var live = new List<FlightState> { named };
        var tracks = new List<(string, TaisTrack)> { ("PCT", track) };
        var f = Fuse(sfdps: live, tais: tracks, now: () => clock);

        void Advance(int sec)
        {
            clock = clock.AddSeconds(sec);
            // The sources restamp as they would on the wire.
            track.LastSeen = clock;
            named.LastSeen = named.LastPositionTime = clock;
        }

        var first = f.Rebuild();
        var trackId = first.Entities.Values.Single(e => e.Facility == "PCT").Id;
        var namedId = first.Entities.Values.Single(e => e.Callsign == "AAL100").Id;

        // A short gap must NOT break the track: this is what the key is for.
        Advance(30);
        var soon = f.Rebuild();
        Assert.Equal(trackId, soon.Entities.Values.Single(e => e.Facility == "PCT").Id);

        // Now the facility stops reporting it for longer than a track key lives, and reissues
        // the number to something else. It must be a NEW entity.
        clock = clock.AddSeconds(NasFusion.TrackKeyTtlSeconds + 30);
        track.LastSeen = clock;
        named.LastSeen = named.LastPositionTime = clock;
        var recycled = f.Rebuild();
        var recycledId = recycled.Entities.Values.Single(e => e.Facility == "PCT").Id;
        Assert.NotEqual(trackId, recycledId);

        // ...while the identity key survived the very same gap, because a Mode S code still
        // names the same aeroplane.
        Assert.Equal(namedId, recycled.Entities.Values.Single(e => e.Callsign == "AAL100").Id);
    }

    /// <summary>
    /// And the long end of it: an identity key outlives a gap far longer than any track key, so
    /// an aircraft that drops out of every source for minutes comes back as itself.
    /// </summary>
    [Fact]
    public void AnIdentityKeySurvivesAGapThatWouldKillATrackKeyManyTimesOver()
    {
        var clock = DateTime.UtcNow;
        var fl = Flight("g1", cs: "UAL7", hex: "ddeeff");
        var f = Fuse(sfdps: new[] { fl }, now: () => clock);

        var id = One(f.Rebuild()).Id;
        clock = clock.AddSeconds(NasFusion.IdentityKeyTtlSeconds - 30);
        fl.LastSeen = fl.LastPositionTime = clock;
        Assert.Equal(id, One(f.Rebuild()).Id);

        // Past its own lifetime it is a new entity, which is correct — at that point nothing
        // on screen is still showing the old one.
        clock = clock.AddSeconds(NasFusion.IdentityKeyTtlSeconds + 60);
        fl.LastSeen = fl.LastPositionTime = clock;
        Assert.NotEqual(id, One(f.Rebuild()).Id);
    }

    /// <summary>
    /// <b>A target that keeps reporting keeps its id, however long it reports for.</b> This is
    /// what refreshing a key's timestamp is for, and the TTL tests above cannot see it: they
    /// check that a short gap is survived and a long one is not, which both pass even if the
    /// timestamp is written once and never updated. With no refresh, every track in the country
    /// would be reborn on a fixed 60-second cycle while sitting plainly on the scope — and the
    /// only symptom would be history trails that all reset together. (Measured: that mutation
    /// left all 194 other tests green.)
    /// </summary>
    [Fact]
    public void AContinuouslyReportingTargetKeepsItsIdPastEveryTtl()
    {
        var clock = DateTime.UtcNow;
        var t = Tais("PCT", "0421");
        var fl = Flight("g1", cs: "AAL100", hex: "abc123");
        var f = Fuse(sfdps: new[] { fl }, tais: new[] { ("PCT", t) }, now: () => clock);

        var first = f.Rebuild();
        var trackId = first.Entities.Values.Single(e => e.Facility == "PCT").Id;
        var namedId = first.Entities.Values.Single(e => e.Callsign == "AAL100").Id;

        // Well past three times the track TTL, in steps shorter than it — i.e. exactly the
        // normal case of a target simply being there.
        for (int step = 0; step < 12; step++)
        {
            clock = clock.AddSeconds(NasFusion.TrackKeyTtlSeconds / 2);
            t.LastSeen = clock;
            fl.LastSeen = fl.LastPositionTime = clock;
            var snap = f.Rebuild();
            Assert.Equal(trackId, snap.Entities.Values.Single(e => e.Facility == "PCT").Id);
            Assert.Equal(namedId, snap.Entities.Values.Single(e => e.Callsign == "AAL100").Id);
        }
    }

    // ── Position precedence ─────────────────────────────────────────────────────────────

    /// <summary>
    /// <b>The precedence rule itself</b>, tested on <see cref="NasEntity.TakePosition"/> rather
    /// than through the pipeline — because through the pipeline it cannot be tested at all.
    /// Sources are added SFDPS → TAIS → ASDE-X, so ASDE-X writes last and wins on arrival order
    /// alone; a version of this test driven through <c>Rebuild()</c> passes identically with the
    /// rank comparison deleted. (Measured: that mutation left all 170 tests green.) What the rule
    /// is actually for is the day someone reorders those calls, or a source starts arriving
    /// out of order — and then a taxiing aircraft gets drawn from its last airborne radar fix,
    /// a plausible-looking position on a runway nobody is on.
    /// </summary>
    [Fact]
    public void ALowerRankedSourceCannotOverwriteAHigherRankedPositionHoweverLateItWrites()
    {
        var e = new NasEntity();
        var t0 = DateTime.UtcNow;

        Assert.True(e.TakePosition(NasPosRank.Asdex, 0, t0));
        // Both of these are LATER writes from LOWER-ranked sources. Both must be refused.
        Assert.False(e.TakePosition(NasPosRank.Tais, 0, t0.AddSeconds(30)));
        Assert.False(e.TakePosition(NasPosRank.Sfdps, 0, t0.AddSeconds(60)));
        Assert.Equal(NasPosRank.Asdex, e.PosRank);

        // Within one rank, the fresher fix wins and a stale one is refused.
        var f = new NasEntity();
        Assert.True(f.TakePosition(NasPosRank.Sfdps, 0, t0));
        Assert.False(f.TakePosition(NasPosRank.Sfdps, 0, t0.AddSeconds(-10)));
        Assert.True(f.TakePosition(NasPosRank.Sfdps, 0, t0.AddSeconds(10)));

        // A higher rank always takes over, even from an older fix.
        Assert.True(f.TakePosition(NasPosRank.Tais, 0, t0.AddSeconds(-60)));
        Assert.Equal(NasPosRank.Tais, f.PosRank);
    }

    /// <summary>
    /// The wiring: all three sources contribute to one entity, the surface fix is the one drawn,
    /// and the flight-plan fields only SFDPS knew survive onto it.
    /// </summary>
    [Fact]
    public void SurfacePositionWinsOverEnRouteForTheSameAircraft()
    {
        var s = Fuse(
            sfdps: new[] { Flight("g1", cs: "DAL20", lat: 33.70, lon: -84.40, alt: 1200) },
            tais: new[] { ("A80", Tais("A80", "1", cs: "DAL20", lat: 33.64, lon: -84.42, alt: 400)) },
            asdex: new[] { Asdex("KATL", "77", cs: "DAL20", lat: 33.6367, lon: -84.4281) }
        ).Rebuild();

        var e = One(s);
        Assert.Equal(NasPosRank.Asdex, e.PosRank);
        Assert.Equal(33.6367, e.Lat, 4);
        Assert.Equal(NasClass.Surface, e.Cls);
        // and it still carries what only SFDPS knew
        Assert.Equal("DAL20", e.Callsign);
    }

    /// <summary>
    /// Within SFDPS, a DROPPED record is the losing center's dead leg: SFDPS marks a flight
    /// DROPPED when the handing-off center drops the track, before the receiving center reports.
    /// /track's hero once led with one of these at a 495-second-old position while the live
    /// record sat behind it — the same mistake, in a different renderer.
    /// </summary>
    [Fact]
    public void ALiveLegBeatsADroppedOneEvenWhenTheDroppedOneIsFresher()
    {
        var s = Fuse(sfdps: new[]
        {
            Flight("g-dead", cs: "NJZ196", lat: 30.0, lon: -95.0, alt: 34000, ageSec: 1, status: "DROPPED"),
            Flight("g-live", cs: "NJZ196", lat: 31.0, lon: -96.0, alt: 20500, ageSec: 20, status: "ACTIVE"),
        }).Rebuild();

        var e = One(s);
        Assert.Equal(31.0, e.Lat, 3);
        Assert.Equal(20500, e.AltFt);
    }

    /// <summary>
    /// SFDPS keeps a flight 60 minutes past its last update. Drawing that is worse than drawing
    /// nothing — the TBFM map plotted SKW3759 from a 55-minute-old fix, hundreds of miles from
    /// the aircraft. The record is still used for its flight plan, and the two cases are counted
    /// apart because "we have no position" and "we have a position we refuse to trust" look
    /// identical on a map and have nothing to do with each other.
    /// </summary>
    [Fact]
    public void AStaleSfdpsPositionIsNotDrawnButItsIdentityIsKept()
    {
        var s = Fuse(sfdps: new[] { Flight("g1", cs: "SKW3759", ageSec: 3300) }).Rebuild();

        var e = One(s);
        Assert.Equal(NasPosRank.None, e.PosRank);
        Assert.Equal("SKW3759", e.Callsign);
        Assert.Equal(1, s.Stats.SfdpsStale);
        Assert.Equal(0, s.Stats.SfdpsNoPos);
        Assert.Equal(0, s.Stats.SfdpsPositions);
    }

    // ── Correlating the uncorrelated ────────────────────────────────────────────────────

    /// <summary>
    /// A discrete beacon code identifies one aircraft, so agreement inside the gate is a
    /// positive correlation — the rule the STARS enrichment service already runs.
    /// </summary>
    [Fact]
    public void ADiscreteBeaconInsideTheGateCorrelatesAnUntaggedTarget()
    {
        var s = Fuse(
            sfdps: new[] { Flight("g1", cs: "N9000X", sq: "4523", lat: 39.00, lon: -77.00, alt: 6000) },
            tais: new[] { ("PCT", Tais("PCT", "0300", sq: "4523", lat: 39.02, lon: -77.01, alt: 6100)) }
        ).Rebuild();

        Assert.Single(s.Entities);
        Assert.Equal(1, s.Stats.MatchedByBeacon);
        Assert.Equal("N9000X", One(s).Callsign);
    }

    /// <summary>
    /// <b>1200 must never correlate.</b> In busy VFR airspace several 1200 targets sit inside a
    /// 5 NM / 1,000 ft box, so "nearest wins" hands a track somebody else's callsign — a WRONG
    /// answer, not a weak one. 7700/7600/7500 are non-discrete too, so the same bug would give
    /// an emergency aircraft a bystander's identity.
    /// </summary>
    [Theory]
    [InlineData("1200")]
    [InlineData("7700")]
    [InlineData("2000")]
    [InlineData("4000")]
    public void ANonDiscreteBeaconNeverCorrelates(string squawk)
    {
        var s = Fuse(
            sfdps: new[] { Flight("g1", cs: "N9000X", sq: squawk, lat: 39.00, lon: -77.00, alt: 6000) },
            tais: new[] { ("PCT", Tais("PCT", "0300", sq: squawk, lat: 39.01, lon: -77.00, alt: 6050)) }
        ).Rebuild();

        Assert.Equal(2, s.Entities.Count);
        Assert.Equal(0, s.Stats.MatchedByBeacon);
        Assert.Null(s.Entities.Values.Single(e => e.Cls != NasClass.EnRoute).Callsign);
    }

    /// <summary>
    /// Two candidates in the gate means there is no tiebreaker, so the honest answer is
    /// untagged. Picking the closer one is a coin flip that produces a confidently wrong
    /// callsign — and leaves no trace, which is why the refusal is counted.
    /// </summary>
    [Fact]
    public void AnAmbiguousBeaconMatchIsDeclinedAndCounted()
    {
        var s = Fuse(
            sfdps: new[]
            {
                Flight("g1", cs: "N111AA", sq: "4523", lat: 39.00, lon: -77.00, alt: 6000),
                Flight("g2", cs: "N222BB", sq: "4523", lat: 39.02, lon: -77.02, alt: 6000),
            },
            tais: new[] { ("PCT", Tais("PCT", "0300", sq: "4523", lat: 39.01, lon: -77.01, alt: 6000)) }
        ).Rebuild();

        Assert.Equal(3, s.Entities.Count);
        Assert.Equal(0, s.Stats.MatchedByBeacon);
        Assert.Equal(1, s.Stats.BeaconAmbiguous);
    }

    /// <summary>
    /// Tier 4 is MEASURED AND NOT APPLIED. A position-only match with no identifier at all is
    /// counted so the numbers can say whether it is worth doing, but it must not silently start
    /// merging — this test is what stops the counter quietly becoming an action.
    /// </summary>
    [Fact]
    public void APositionOnlyMatchIsCountedButNeverMerged()
    {
        var s = Fuse(
            sfdps: new[] { Flight("g1", cs: "N9000X", lat: 39.000, lon: -77.000, alt: 6000) },
            tais: new[] { ("PCT", Tais("PCT", "0300", lat: 39.005, lon: -77.000, alt: 6050)) }
        ).Rebuild();

        Assert.Equal(2, s.Entities.Count);
        Assert.Equal(1, s.Stats.WouldMatchByPosition);
        Assert.Equal(0, s.Stats.MatchedByBeacon);
    }

    /// <summary>
    /// The proximity scan was 80% of the pass cost (196 of 245 ms live), almost all of it spent
    /// on tier 4 — a tier that is deliberately inert and, measured, would have named 1% of
    /// targets. So tier 4 is now sampled 1-in-8.
    ///
    /// <para><b>Tier 3 must not inherit that sampling.</b> It is a real correlation that really
    /// merges, and writing the sample check one line earlier would silently reduce beacon
    /// matching to an eighth with nothing to show for it — the match count would fall, which
    /// reads exactly like a quiet day. This drives more than 8 correlatable targets through at
    /// once and requires every one of them to be named.</para>
    /// </summary>
    [Fact]
    public void SamplingTierFourMustNotSampleTierThree()
    {
        var sfdps = new List<FlightState>();
        var tais = new List<(string, TaisTrack)>();
        for (int i = 0; i < 20; i++)
        {
            // Discrete codes, well separated so no pair can be ambiguous with another. Built
            // digit-wise rather than as 4000+i: beacon codes are OCTAL, and 4000 itself is
            // non-discrete (military VFR), so the obvious arithmetic range yields 19 of 20
            // correlatable targets and this test fails for the wrong reason. It did.
            var sq = $"4{1 + i / 8}{i % 8}1";
            var lat = 35.0 + i * 0.5;
            sfdps.Add(Flight($"g{i}", cs: $"N{i:000}XX", sq: sq, lat: lat, lon: -95.0, alt: 7000));
            tais.Add(("ZZZ", Tais("ZZZ", $"{i:0000}", sq: sq, lat: lat + 0.01, lon: -95.0, alt: 7050)));
        }

        var snap = Fuse(sfdps: sfdps, tais: tais).Rebuild();

        Assert.Equal(20, snap.Stats.MatchedByBeacon);
        Assert.Equal(20, snap.Entities.Count);
        // ...while tier 4 saw only its sample. Reading these as totals would understate by 8x,
        // which is why the sample size travels with them.
        Assert.True(snap.Stats.PositionSampled < 20,
            $"tier 4 should be sampled, saw {snap.Stats.PositionSampled} of 20");
    }

    // ── Classification ──────────────────────────────────────────────────────────────────

    /// <summary>
    /// Half the uncorrelated terminal population is not aircraft: measured, 1,725 of 3,483
    /// untagged TAIS tracks report altitude 0 AND under 100 kt, clustered at plains TRACONs at
    /// local midnight in November. They are live radar, so dropping them would misrepresent what
    /// the sensor sees; drawing them unlabelled makes the NAS view ~30% clutter. They get their
    /// own class so the map can offer a filter and an honest label.
    /// </summary>
    [Fact]
    public void TheNoiseFloorIsClassifiedApartFromPlausibleAircraft()
    {
        var s = Fuse(tais: new[]
        {
            ("DSM", Tais("DSM", "1", alt: 0, gs: 40)),      // noise floor
            ("DSM", Tais("DSM", "2", alt: 0, gs: 130)),     // fast, so plausibly real
            ("DSM", Tais("DSM", "3", alt: 4500, gs: 20)),   // high, so plausibly real
        }).Rebuild();

        Assert.Equal(1, s.Stats.Of(NasClass.Primary));
        Assert.Equal(2, s.Stats.Of(NasClass.Untagged));
    }

    [Fact]
    public void AnAsdexVehicleIsNeverAnAircraftAndIsNeverCorrelated()
    {
        var s = Fuse(
            sfdps: new[] { Flight("g1", cs: "UAL9", sq: "4523", lat: 41.98, lon: -87.90, alt: 600) },
            asdex: new[] { Asdex("KORD", "v1", lat: 41.98, lon: -87.90, tgt: "vehicle") }
        ).Rebuild();

        Assert.Equal(2, s.Entities.Count);
        Assert.Equal(1, s.Stats.Of(NasClass.Vehicle));
        Assert.Equal(0, s.Stats.MatchedByBeacon);
    }

    /// <summary>
    /// <b>A flight plan is not a target.</b> 14% of SFDPS is PROPOSED and has no radar position
    /// at all, and those records belong in the index — they carry identity, so the entity id
    /// survives into the flight when it departs — but they have no lat/lon.
    ///
    /// <para>Found by cross-checking the live output against its sources: <b>4,008 entities sat
    /// at exactly (0, 0)</b>, which on a map is a tight cluster in the Gulf of Guinea. It would
    /// have read as a projection or renderer fault, not as the index emitting things it cannot
    /// place — and 4,008 is a fifth of everything.</para>
    /// </summary>
    [Fact]
    public void AFlightWithNoPositionIsHeldButNotDrawable()
    {
        var proposed = Flight("g1", cs: "UAL900", status: "PROPOSED");
        proposed.Latitude = null;
        proposed.Longitude = null;
        var s = Fuse(sfdps: new[] { proposed, Flight("g2", cs: "UAL901", lat: 40, lon: -75) }).Rebuild();

        Assert.Equal(2, s.Entities.Count);                 // both held
        var p = s.Entities.Values.Single(e => e.Callsign == "UAL900");
        Assert.False(p.Positioned);
        Assert.True(s.Entities.Values.Single(e => e.Callsign == "UAL901").Positioned);

        // Counted apart from the drawable classes, so the totals cannot quietly include it.
        Assert.Equal(1, s.Stats.Unpositioned);
        Assert.Equal(1, s.Stats.Total);
    }

    /// <summary>
    /// And the id survives the transition, which is why the unpositioned record is held at all
    /// rather than skipped: a flight that has been sitting as a flight plan must not be reborn
    /// the moment radar picks it up.
    /// </summary>
    [Fact]
    public void AProposedFlightKeepsItsIdWhenItDeparts()
    {
        var f = Flight("g1", cs: "UAL900", status: "PROPOSED");
        f.Latitude = null; f.Longitude = null;
        var fuse = Fuse(sfdps: new[] { f });

        var before = One(fuse.Rebuild());
        Assert.False(before.Positioned);

        f.Latitude = 40.1; f.Longitude = -75.2; f.FlightStatus = "ACTIVE";
        f.LastSeen = f.LastPositionTime = DateTime.UtcNow;
        var after = One(fuse.Rebuild());

        Assert.Equal(before.Id, after.Id);
        Assert.True(after.Positioned);
    }

    /// <summary>
    /// <b>Surface means on the surface, not "ASDE-X positioned it".</b> ASDE-X covers the
    /// approach and departure corridors, so keying the class on the positioning source labelled
    /// UCA4347 at 3,387 ft and 221 kt a surface target — live, along with ~200 others. The map
    /// draws the class, so those are taxiing symbols several thousand feet up: entirely plausible
    /// to look at, and wrong.
    /// </summary>
    [Theory]
    [InlineData(8, 20, "Surface")]        // taxiing
    [InlineData(39, 30, "Surface")]       // fast taxi / pushing back
    [InlineData(140, 1200, "EnRoute")]    // climbing out, still inside surface coverage
    [InlineData(221, 3387, "EnRoute")]    // the real case this was found on, live
    public void SurfaceIsAboutGroundSpeedNotAboutWhoPositionedIt(int kts, int altFt, string expectedClass)
    {
        var expected = Enum.Parse<NasClass>(expectedClass);
        var a = Asdex("KIAH", "1", cs: "UCA4347", lat: 29.98, lon: -95.34);
        a.SpeedKts = kts;
        a.AltitudeFeet = altFt;
        var s = Fuse(
            sfdps: new[] { Flight("g1", cs: "UCA4347", lat: 29.98, lon: -95.34, alt: altFt) },
            asdex: new[] { a }).Rebuild();

        var e = One(s);
        Assert.Equal(NasPosRank.Asdex, e.PosRank);   // ASDE-X still owns the position
        Assert.Equal(expected, e.Cls);               // ...but not the classification
    }

    /// <summary>An unidentified return on the surface is a primary return whatever its Mode C
    /// claims — an airport is not at sea level, so the airborne noise-floor test does not
    /// apply to it.</summary>
    [Fact]
    public void AnUnidentifiedSurfaceReturnIsPrimaryRegardlessOfItsModeC()
    {
        var a = Asdex("KDEN", "9", lat: 39.86, lon: -104.67, tgt: "unknown");
        a.AltitudeFeet = 5430;     // Denver's field elevation, not an altitude
        a.SpeedKts = 6;
        var s = Fuse(asdex: new[] { a }).Rebuild();
        Assert.Equal(NasClass.Primary, One(s).Cls);
    }

    // ── LADD ────────────────────────────────────────────────────────────────────────────

    /// <summary>
    /// A blocked aircraft is omitted, not masked. Fusion's whole product is a position paired
    /// with an identity, and a masked row still pairs a position with a beacon code — which is
    /// exactly what the list exists to prevent. Same reasoning as <c>/api/enrich/aircraft</c>.
    /// </summary>
    [Fact]
    public void ALaddBlockedAircraftIsOmittedEntirely()
    {
        LaddService.SetBlockedForTest(new[] { "N456ZZ" });
        try
        {
            var s = Fuse(
                sfdps: new[] { Flight("g1", cs: "N456ZZ"), Flight("g2", cs: "N999YY") }
            ).Rebuild();

            Assert.Single(s.Entities);
            Assert.Equal("N999YY", One(s).Callsign);
            Assert.Equal(1, s.Stats.LaddOmitted);
        }
        finally { LaddService.SetBlockedForTest(Array.Empty<string>()); }
    }

    // ── Geometry ────────────────────────────────────────────────────────────────────────

    /// <summary>
    /// <c>trackVelocityX/Y</c> are KNOTS of east/north travel, so the track is
    /// <c>atan2(east, north)</c>. This is the units trap that made the TBFM map's velocity
    /// vectors sixty times too long, and here it would silently point every delta the wrong way:
    /// a triangle rendered at a plausible heading is indistinguishable from a correct one.
    /// </summary>
    [Theory]
    [InlineData(0, 400, 0)]       // due north
    [InlineData(400, 0, 90)]      // due east
    [InlineData(0, -400, 180)]    // due south
    [InlineData(-400, 0, 270)]    // due west
    [InlineData(300, 300, 45)]
    public void TrackComesFromTheVelocityComponentsInTheRightOrder(double vx, double vy, int expected)
        => Assert.Equal(expected, NasFusion.Heading(vx, vy));

    [Fact]
    public void AStationaryOrAbsentVelocityGivesNoTrack()
    {
        Assert.Null(NasFusion.Heading(null, 400));
        Assert.Null(NasFusion.Heading(0, 0));
    }

    // ── The wire form ───────────────────────────────────────────────────────────────────

    /// <summary>
    /// The streaming delta is a positional array with no field names, which is what keeps a
    /// whole-NAS update affordable (~30 bytes/target → ~170 kB uncompressed at 5,710 targets,
    /// ~24 kB after the permessage-deflate every socket here already negotiates). If a field is
    /// ever added it must go on the END, or every client's index-based decode shifts.
    ///
    /// <para>The precision is pinned at FIVE decimal places (1.1 m) because one rounding serves
    /// both a continental view and a single airport. 4 dp is 11 m: invisible at CONUS zoom, a
    /// visible quantisation on an ASDE-X surface view where a pixel is a couple of metres. The
    /// cheaper rounding is the one that is wrong in the place that can see it.</para>
    /// </summary>
    [Fact]
    public void TheDeltaIsSevenPositionalFieldsAtMetrePrecision()
    {
        var s = Fuse(sfdps: new[]
        {
            Flight("g1", cs: "AAL1", lat: 39.1234567, lon: -77.5432112, alt: 35000, vx: 400, vy: 0),
        }).Rebuild();

        var d = One(s).ToDelta();
        Assert.Equal(7, d.Length);
        Assert.Equal(39.12346, (double)d[1], 5);
        Assert.Equal(-77.54321, (double)d[2], 5);
        // and not the 11 m rounding: the 6th decimal must have been kept to 5, not dropped to 4
        Assert.NotEqual(Math.Round(39.1234567, 4), (double)d[1]);
        Assert.Equal(35000, d[3]);
        Assert.Equal(90, d[4]);
        Assert.Equal((int)NasClass.EnRoute, d[6]);
    }
}
