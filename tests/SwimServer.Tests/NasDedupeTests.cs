namespace SwimServer.Tests;

/// <summary>
/// Cross-facility dedupe: one airplane that two or more facilities each publish as their own
/// uncorrelated track.
///
/// <para><b>Nothing here is visible from a browser, and the failure mode is worse than usual.</b>
/// Merging too eagerly does not produce an error or an odd-looking target — it DELETES an
/// airplane. A two-ship that gets collapsed renders as one perfectly normal aircraft, in the
/// right place, at the right altitude, with the right squawk. The only evidence that the second
/// one ever existed is a counter nobody is reading.</para>
///
/// <para>So the tests that matter most are the ones that assert a merge did <b>not</b> happen.
/// Every one of them was checked by mutation: the formation rule, the discrete-code rule, the
/// conflicting-callsign rule and the altitude gate each fail at least one test below when
/// removed.</para>
/// </summary>
public class NasDedupeTests
{
    private static NasFusion Fuse(
        IEnumerable<FlightState>? sfdps = null,
        IEnumerable<(string, TaisTrack)>? tais = null,
        IEnumerable<AsdexTrack>? asdex = null) =>
        new(() => sfdps ?? Array.Empty<FlightState>(),
            () => tais ?? Array.Empty<(string, TaisTrack)>(),
            () => asdex ?? Array.Empty<AsdexTrack>(),
            null);

    /// <summary>An uncorrelated terminal return: a position, a beacon code and nothing else.
    /// This is the population the whole feature exists for — ~48% of the index.</summary>
    private static TaisTrack Blip(string fac, string num, string sq,
        double lat = 39.5, double lon = -84.0, int alt = 8000) =>
        new()
        {
            Facility = fac, TrackNum = num, ReportedSquawk = sq,
            Latitude = lat, Longitude = lon, AltitudeFeet = alt, GroundSpeedKnots = 220,
            LastSeen = DateTime.UtcNow,
        };

    private static FlightState Flight(string gufi, string cs, string sq,
        double lat = 39.5, double lon = -84.0, int alt = 8000, string? hex = null) =>
        new()
        {
            Gufi = gufi, Callsign = cs, Squawk = sq, ModeSCode = hex,
            Latitude = lat, Longitude = lon, ReportedAltitude = alt,
            FlightStatus = "ACTIVE",
            LastSeen = DateTime.UtcNow, LastPositionTime = DateTime.UtcNow,
        };

    private static List<NasEntity> Leaders(NasSnapshot s) =>
        s.Entities.Values.Where(e => !e.DupFollower).ToList();

    // ── What it is for ──────────────────────────────────────────────────────────────────

    /// <summary>
    /// The case measured on the live feed: 468 co-located groups reported by different
    /// facilities, several of them three-way — CLE, IND and SDF all publishing one target
    /// squawking 0513 at the same place. With no Mode S and no callsign on any copy, nothing
    /// else in the index can join them, so they arrive as three anonymous dots stacked on each
    /// other.
    /// </summary>
    [Fact]
    public void ThreeFacilitiesReportingOneTargetBecomeOne()
    {
        var f = Fuse(tais: new[]
        {
            ("CLE", Blip("CLE", "101", "0513")),
            ("IND", Blip("IND", "202", "0513", lat: 39.51)),
            ("SDF", Blip("SDF", "303", "0513", lat: 39.49)),
        });
        f.Rebuild();
        var snap = f.Rebuild();

        Assert.Equal(3, snap.Entities.Count);          // the index still holds all three
        var lead = Assert.Single(Leaders(snap));       // a deduping viewer draws one
        Assert.Equal(3, lead.DupN);
        Assert.Equal("CLE+IND+SDF", lead.DupFacility); // ...and is told who all three were
        Assert.Equal(1, snap.Stats.DupGroups);
        Assert.Equal(2, snap.Stats.DupMerged);
    }

    /// <summary>
    /// The ERAM half of the request, and the gap tier 3 genuinely cannot reach.
    ///
    /// <para>Tier 3 already merges an uncorrelated return into a named SFDPS flight — but its
    /// candidate grid only holds entities still positioned BY SFDPS. The moment any facility
    /// correlates the flight, the entity's position comes from TAIS instead and it drops out of
    /// that grid, so a second facility's uncorrelated copy of the same airplane has nothing left
    /// to match against and stays a separate target for the rest of the flight.</para>
    ///
    /// <para>Here CLE has the flight correlated (so it merges on callsign and takes the
    /// position), and IND is publishing the same airplane as an anonymous blip. The facility
    /// test counts SFDPS as one national source, so CLE+ERAM against IND is still
    /// one-per-facility and still merges.</para>
    /// </summary>
    [Fact]
    public void AnEramFlightCorrelatedAtOneTraconMergesWithAnotherTraconsBlip()
    {
        var correlated = new TaisTrack
        {
            Facility = "CLE", TrackNum = "101", Callsign = "DAL123", ReportedSquawk = "4512",
            Latitude = 39.5, Longitude = -84.0, AltitudeFeet = 8000,
            LastSeen = DateTime.UtcNow,
        };
        var f = Fuse(sfdps: new[] { Flight("g1", "DAL123", "4512") },
                     tais: new[] { ("CLE", correlated), ("IND", Blip("IND", "202", "4512", lat: 39.52)) });
        var snap = f.Rebuild();

        Assert.Equal(2, snap.Entities.Count);
        var lead = Assert.Single(Leaders(snap));
        Assert.Equal(2, lead.DupN);
        Assert.Equal("CLE+ERAM+IND", lead.DupFacility);
        // The surviving target is the NAMED one, so collapsing the pair does not cost the
        // callsign that made it worth collapsing.
        Assert.Equal("DAL123", lead.Callsign);
    }

    // ── What it must refuse ─────────────────────────────────────────────────────────────

    /// <summary>
    /// <b>The formation test.</b> Two aircraft a quarter-mile apart are geometrically identical
    /// to one aircraft seen twice, so no distance gate can tell them apart. What can is that a
    /// facility assigns one track per radar target: CLE reporting TWO tracks here means CLE is
    /// looking at two airplanes, and the whole cluster is declined — including the third member
    /// from a different facility, because the cluster's membership is no longer knowable.
    ///
    /// <para>Delete the collision check and this test fails by returning one target where three
    /// aircraft-worth of radar data exists. Nothing else would notice.</para>
    /// </summary>
    [Fact]
    public void TwoTracksFromOneFacilityAreAFormationAndNeverMerge()
    {
        var f = Fuse(tais: new[]
        {
            ("CLE", Blip("CLE", "101", "0513")),
            ("CLE", Blip("CLE", "102", "0513", lat: 39.503)),   // wingman, ~0.2 NM
            ("IND", Blip("IND", "202", "0513", lat: 39.501)),
        });
        f.Rebuild();
        var snap = f.Rebuild();

        Assert.Equal(3, Leaders(snap).Count);          // all three still drawn
        Assert.Equal(0, snap.Stats.DupGroups);
        Assert.True(snap.Stats.DupFormations > 0);
        Assert.All(snap.Entities.Values, e => Assert.Equal(0, e.DupOf));
    }

    /// <summary>
    /// A non-discrete code identifies nobody. Several 1200 targets legitimately sit inside one
    /// gate in busy VFR airspace, and 7700/7600/7500 are shared by definition — so co-location
    /// under one of those is not evidence of anything. Same rule the enrichment service and
    /// tier 3 already apply; this is the third place it is load-bearing.
    /// </summary>
    [Theory]
    [InlineData("1200")]   // VFR conspicuity
    [InlineData("7700")]   // emergency
    [InlineData("4000")]   // block boundary - octal, and ending in 00
    public void ANonDiscreteCodeNeverMerges(string sq)
    {
        var f = Fuse(tais: new[]
        {
            ("CLE", Blip("CLE", "101", sq)),
            ("IND", Blip("IND", "202", sq, lat: 39.501)),
        });
        f.Rebuild();
        Assert.Equal(2, Leaders(f.Rebuild()).Count);
    }

    /// <summary>
    /// Two named targets with different names are two airplanes whatever their geometry. This
    /// catches what the facility test cannot: one TRACON record and one ERAM record that
    /// genuinely belong to different flights which happen to share a recycled code.
    /// </summary>
    [Fact]
    public void ConflictingCallsignsNeverMerge()
    {
        var f = Fuse(sfdps: new[] { Flight("g1", "DAL123", "4512") },
                     tais: new[]
                     {
                         ("CLE", new TaisTrack
                         {
                             Facility = "CLE", TrackNum = "101", Callsign = "UAL456",
                             ReportedSquawk = "4512", Latitude = 39.501, Longitude = -84.0,
                             AltitudeFeet = 8000, LastSeen = DateTime.UtcNow,
                         }),
                     });
        f.Rebuild();
        var snap = f.Rebuild();
        Assert.Equal(2, Leaders(snap).Count);
        Assert.True(snap.Stats.DupConflicts > 0);
    }

    /// <summary>
    /// The altitude gate. Two aircraft under one code 4,000 ft apart are stacked traffic, not a
    /// duplicate — Mode C is the SAME transponder reply read by two sensors, so real duplicates
    /// agree to within the seconds between the two reports.
    /// </summary>
    [Fact]
    public void AltitudeSeparationDefeatsTheMerge()
    {
        var f = Fuse(tais: new[]
        {
            ("CLE", Blip("CLE", "101", "0513", alt: 8000)),
            ("IND", Blip("IND", "202", "0513", alt: 12000)),
        });
        f.Rebuild();
        Assert.Equal(2, Leaders(f.Rebuild()).Count);
    }

    /// <summary>A target with no Mode C cannot be confirmed, so it is left alone. Refusing is
    /// the conservative direction here: an unmerged pair is visible and explicable, a wrongly
    /// merged pair is an airplane that silently is not on the map.</summary>
    [Fact]
    public void AMissingModeCRefusesTheMerge()
    {
        var f = Fuse(tais: new[]
        {
            ("CLE", new TaisTrack { Facility = "CLE", TrackNum = "101", ReportedSquawk = "0513",
                                    Latitude = 39.5, Longitude = -84.0, AltitudeFeet = null,
                                    LastSeen = DateTime.UtcNow }),
            ("IND", Blip("IND", "202", "0513")),
        });
        f.Rebuild();
        Assert.Equal(2, Leaders(f.Rebuild()).Count);
    }

    /// <summary>Same code, opposite sides of the country. A discrete code is unique within a
    /// facility and reused everywhere else, so the code alone proves nothing without the
    /// position.</summary>
    [Fact]
    public void TheSameCodeFarApartIsTwoAircraft()
    {
        var f = Fuse(tais: new[]
        {
            ("CLE", Blip("CLE", "101", "0513", lat: 41.4, lon: -81.8)),
            ("SCT", Blip("SCT", "202", "0513", lat: 33.9, lon: -118.4)),
        });
        f.Rebuild();
        Assert.Equal(2, Leaders(f.Rebuild()).Count);
    }

    // ── Stability ───────────────────────────────────────────────────────────────────────

    /// <summary>
    /// Leadership is by position RANK then id, never by freshness. Two equally live feeds would
    /// trade a freshness tie-break back and forth, and because leadership decides which entity
    /// is drawn at all, each flip is a delete plus an add — the group would blink at the tick
    /// rate while every counter reported a healthy delta stream.
    /// </summary>
    [Fact]
    public void LeadershipIsStableAcrossPasses()
    {
        var f = Fuse(tais: new[]
        {
            ("CLE", Blip("CLE", "101", "0513")),
            ("IND", Blip("IND", "202", "0513", lat: 39.501)),
        });
        f.Rebuild();
        var first = Assert.Single(Leaders(f.Rebuild())).Id;
        for (var i = 0; i < 5; i++) f.Rebuild();
        Assert.Equal(first, Assert.Single(Leaders(f.Rebuild())).Id);
    }

    /// <summary>
    /// The grouping is evidence, not an identity, so it is recomputed every pass and never
    /// written to the key map. Two targets that drift apart stop being one aircraft on the next
    /// pass — if this were remembered like a tier 3 merge, a code reassigned to another aircraft
    /// would inherit the group and one of the two would vanish for as long as the key lived.
    /// </summary>
    [Fact]
    public void AGroupDissolvesWhenTheTargetsSeparate()
    {
        var near = new[]
        {
            ("CLE", Blip("CLE", "101", "0513")),
            ("IND", Blip("IND", "202", "0513", lat: 39.501)),
        };
        var far = new[]
        {
            ("CLE", Blip("CLE", "101", "0513")),
            ("IND", Blip("IND", "202", "0513", lat: 41.0)),
        };
        var which = near;
        var f = new NasFusion(() => Array.Empty<FlightState>(), () => which,
                              () => Array.Empty<AsdexTrack>(), null);

        f.Rebuild();
        Assert.Single(Leaders(f.Rebuild()));

        which = far;
        f.Rebuild();
        Assert.Equal(2, Leaders(f.Rebuild()).Count);
        Assert.All(f.Rebuild().Entities.Values, e => Assert.Equal(0, e.DupOf));
    }

    /// <summary>
    /// <b>Leadership is by estimated ERROR, not by source rank</b>, and the leader is the target
    /// that gets drawn — so this decides which report the map shows.
    ///
    /// <para>Rank alone was the first rule here and it is too coarse. A terminal fix outranks an
    /// en-route one because TAIS reports every five seconds against SFDPS's twelve — but that is
    /// a statement about CADENCE, not about this particular report. A 60-second-old terminal fix
    /// at 450 kt is 7.5 NM stale, and preferring it over a three-second-old en-route one draws
    /// the merged target seven miles from where the aircraft is.</para>
    ///
    /// <para>This is the only arrangement where the two rules disagree, which is why a test built
    /// from same-source members — or from members that are both fresh — cannot see it at all.</para>
    /// </summary>
    [Fact]
    public void TheLeaderIsTheMostAccuratePositionNotTheBestSource()
    {
        // A minute-old terminal report of a fast aircraft: high rank, badly stale.
        var blip = Blip("IND", "202", "4512", lat: 39.5);
        blip.ModeSCode = "A1B2C3";   // keeps tier 3 out: its pending list is unidentified only
        blip.GroundSpeedKnots = 450;
        blip.GroundTrackDegrees = 90;
        blip.LastSeen = DateTime.UtcNow.AddSeconds(-60);

        // ...against a three-second-old en-route one of the same airplane.
        var fl = Flight("g1", "DAL123", "4512", lat: 39.5, lon: -83.86);
        fl.LastPositionTime = DateTime.UtcNow.AddSeconds(-3);
        fl.LastSeen = fl.LastPositionTime;
        fl.TrackVelocityX = 450; fl.TrackVelocityY = 0;   // Trk comes from the velocity pair...
        fl.GroundSpeed = 450;                             // ...and Gs from its own field.

        var f = Fuse(sfdps: new[] { fl }, tais: new[] { ("IND", blip) });
        var snap = f.Rebuild();

        var lead = Assert.Single(Leaders(snap));
        Assert.Equal(NasPosRank.Sfdps, lead.PosRank);
        Assert.True(lead.PosAgeSec < 10, $"led with a {lead.PosAgeSec}s fix");
    }

    /// <summary>
    /// The error estimate itself. Delay dominates and is exactly known; the source floor only
    /// decides between reports that are equally fresh.
    /// </summary>
    [Fact]
    public void DelayDominatesTheErrorEstimate()
    {
        var f = Fuse();
        var fresh = new NasEntity { Id = 1, Lat = 39, Lon = -84, Gs = 450, Trk = 90, PosAgeSec = 2 };
        fresh.TakePosition(NasPosRank.Tais, 0, DateTime.UtcNow);
        var stale = new NasEntity { Id = 2, Lat = 39, Lon = -84, Gs = 450, Trk = 90, PosAgeSec = 60 };
        stale.TakePosition(NasPosRank.Asdex, 0, DateTime.UtcNow);

        // 60 s at 450 kt is 7.5 NM of staleness - an order of magnitude past any sensor's own
        // error, so the BEST source with an old fix still loses to a worse source with a new one.
        Assert.True(f.PosSigmaNm(stale) > 7, $"{f.PosSigmaNm(stale):F2}");
        Assert.True(f.PosSigmaNm(fresh) < 1, $"{f.PosSigmaNm(fresh):F2}");
        Assert.True(f.PosSigmaBand(fresh) < f.PosSigmaBand(stale));
    }

    /// <summary>
    /// Banding is what keeps leadership from flapping. Sigma creeps every second as a position
    /// ages, so comparing it raw would trade leadership between two near-equal members on almost
    /// every pass — and each flip is a delete plus an add, so the group blinks at the tick rate
    /// while every counter reports a healthy delta stream.
    /// </summary>
    [Fact]
    public void NearEqualErrorsLandInOneBandSoLeadershipCannotFlap()
    {
        var f = Fuse();
        var a = new NasEntity { Id = 1, Lat = 39, Lon = -84, Gs = 200, Trk = 90, PosAgeSec = 3 };
        a.TakePosition(NasPosRank.Tais, 0, DateTime.UtcNow);
        var b = new NasEntity { Id = 2, Lat = 39, Lon = -84, Gs = 200, Trk = 90, PosAgeSec = 4 };
        b.TakePosition(NasPosRank.Tais, 0, DateTime.UtcNow);

        Assert.NotEqual(f.PosSigmaNm(a), f.PosSigmaNm(b));      // raw sigma does differ...
        Assert.Equal(f.PosSigmaBand(a), f.PosSigmaBand(b));     // ...and the band does not
    }

    /// <summary>
    /// The per-source floor: at equal freshness a surface multilateration fix is intrinsically
    /// better than an en-route radar one. It is deliberately SMALL - 0.03 against 0.25 NM - which
    /// is why it can never outvote delay and why, at the half-mile band the comparison uses, it
    /// only ever breaks a tie. A mutation deleting it proved that: at that resolution the numeric
    /// floor alone changed no decision at all, so rank is now the explicit in-band tie-break and
    /// the floor is what makes the reported sigma mean something.
    /// </summary>
    [Fact]
    public void ASurfaceFixIsRatedBetterThanAnEnRouteFixAtEqualAge()
    {
        var f = Fuse();
        var surface = new NasEntity { Id = 1, Lat = 39, Lon = -84, Gs = 0, PosAgeSec = 1 };
        surface.TakePosition(NasPosRank.Asdex, 0, DateTime.UtcNow);
        var enroute = new NasEntity { Id = 2, Lat = 39, Lon = -84, Gs = 0, PosAgeSec = 1 };
        enroute.TakePosition(NasPosRank.Sfdps, 0, DateTime.UtcNow);

        Assert.True(f.PosSigmaNm(surface) < f.PosSigmaNm(enroute));
    }

    /// <summary>
    /// Leadership must be able to move to a member that is not the cluster HEAD.
    ///
    /// <para>Written because a mutation proved the previous test could not see this: it put the
    /// fresher record first, so "pick the best band" and "keep whoever you started with" gave the
    /// same answer and the band comparison could be deleted outright. Here the stale report is
    /// inserted first and the fresh one second, which is the only arrangement that tells the two
    /// rules apart.</para>
    ///
    /// <para>They are 7.5 NM apart as reported and on top of each other once each is advanced to
    /// a common instant, so this pins the compensation as well.</para>
    /// </summary>
    [Fact]
    public void LeadershipMovesOffTheClusterHeadWhenAnotherMemberIsBetter()
    {
        var stale = Blip("CLE", "101", "0513", lat: 39.5, lon: -84.0);
        stale.GroundSpeedKnots = 450; stale.GroundTrackDegrees = 90;
        stale.LastSeen = DateTime.UtcNow.AddSeconds(-60);

        var fresh = Blip("IND", "202", "0513",
                         lat: 39.5, lon: -84.0 + 7.5 / 60 / Math.Cos(39.5 * Math.PI / 180));
        fresh.GroundSpeedKnots = 450; fresh.GroundTrackDegrees = 90;

        // Stale FIRST, so it is the cluster head and owns the lower id.
        var f = Fuse(tais: new[] { ("CLE", stale), ("IND", fresh) });
        var snap = f.Rebuild();

        var lead = Assert.Single(Leaders(snap));
        Assert.True(lead.PosAgeSec < 10, $"led with a {lead.PosAgeSec}s fix");
        Assert.True(lead.Id > snap.Entities.Values.Min(e => e.Id),
                    "the stale record holds the lower id, so this only passes on the error band");
    }

    /// <summary>Within one band, the better SENSOR wins - stably, because rank cannot creep the
    /// way a raw sigma does.</summary>
    [Fact]
    public void WithinOneBandTheBetterSensorLeads()
    {
        var blip = Blip("IND", "202", "4512", lat: 39.5, lon: -84.0);
        blip.ModeSCode = "A1B2C3";
        blip.GroundSpeedKnots = 0; blip.GroundTrackDegrees = 0;

        // Same place, same freshness, worse sensor - and the LOWER id, so an id rule picks it.
        var fl = Flight("g1", "DAL123", "4512", lat: 39.5, lon: -84.0);
        fl.GroundSpeed = 0; fl.TrackVelocityX = 0; fl.TrackVelocityY = 0;

        var f = Fuse(sfdps: new[] { fl }, tais: new[] { ("IND", blip) });
        var lead = Assert.Single(Leaders(f.Rebuild()));
        Assert.Equal(NasPosRank.Tais, lead.PosRank);
    }

    /// <summary>
    /// <b>Latency, not disagreement.</b> Two facilities report where the aircraft WAS at their
    /// own fix times, and at 450 kt a 40-second difference is 5 NM of pure bookkeeping. Advancing
    /// each report along its own track to a common instant is what lets the gate be tight: these
    /// two are 4.5 NM apart as reported, which no sensible raw gate would accept, and on top of
    /// each other once the delay is taken out.
    ///
    /// <para>Measured over 1,562 live groups, compensation takes the within-group spread from
    /// p50 1.07 / p90 3.32 NM to p50 0.28 / p90 1.30.</para>
    /// </summary>
    [Fact]
    public void LatencyIsCompensatedBeforeTheDistanceGate()
    {
        var old = Blip("CLE", "101", "0513", lat: 39.5, lon: -84.0);
        old.GroundSpeedKnots = 450; old.GroundTrackDegrees = 90;
        old.LastSeen = DateTime.UtcNow.AddSeconds(-40);

        // 4.5 NM east - where the first aircraft will be in 36 s, reported fresh by the neighbor.
        var now = Blip("IND", "202", "0513", lat: 39.5, lon: -84.0 + 4.5 / 60 / Math.Cos(39.5 * Math.PI / 180));
        now.GroundSpeedKnots = 450; now.GroundTrackDegrees = 90;

        var f = Fuse(tais: new[] { ("CLE", old), ("IND", now) });
        Assert.Single(Leaders(f.Rebuild()));
    }

    /// <summary>
    /// The facility label is capped at four tokens, so a group that grows past the cap changes
    /// its SIZE without changing its LABEL. Leave the count out of the identity hash and such a
    /// group is never re-sent: the client keeps saying "4 facilities" about a target six are
    /// reporting, with nothing anywhere to indicate it.
    ///
    /// <para>And the label itself must be the four ordinal-lowest facilities, not the first four
    /// the sources happened to be iterated in — an order-dependent label flips between passes,
    /// which moves the hash and re-sends every oversized group on every tick forever.</para>
    /// </summary>
    [Fact]
    public void AGroupPastTheLabelCapStillMovesTheIdentityHash()
    {
        var five = new[]
        {
            ("CLE", Blip("CLE", "1", "0513", lat: 39.500)),
            ("CMH", Blip("CMH", "2", "0513", lat: 39.501)),
            ("CVG", Blip("CVG", "3", "0513", lat: 39.502)),
            ("HTS", Blip("HTS", "4", "0513", lat: 39.503)),
            ("LEX", Blip("LEX", "5", "0513", lat: 39.504)),
        };
        var six = five.Append(("IND", Blip("IND", "6", "0513", lat: 39.505))).ToArray();

        var which = five;
        var f = new NasFusion(() => Array.Empty<FlightState>(), () => which,
                              () => Array.Empty<AsdexTrack>(), null);

        f.Rebuild();
        var lead5 = Assert.Single(Leaders(f.Rebuild()));
        Assert.Equal(5, lead5.DupN);
        Assert.Equal("CLE+CMH+CVG+HTS", lead5.DupFacility);   // ordinal-lowest four, not "first"
        var h5 = lead5.IdentityHash(dedupe: true);

        which = six;
        f.Rebuild();
        var lead6 = Assert.Single(Leaders(f.Rebuild()));
        Assert.Equal(6, lead6.DupN);
        Assert.Equal("CLE+CMH+CVG+HTS", lead6.DupFacility);   // label genuinely unchanged...
        Assert.NotEqual(h5, lead6.IdentityHash(dedupe: true)); // ...so only the count can say so
    }

    // ── The wire ────────────────────────────────────────────────────────────────────────

    /// <summary>
    /// Both add-row forms must have the same LENGTH. The client decodes by index, so a row that
    /// is one field shorter in one mode shifts every field after it — the squawk would render as
    /// the airport and the facility as the destination, which looks like bad data rather than
    /// like a toggle.
    /// </summary>
    [Fact]
    public void BothAddRowFormsHaveTheSameShape()
    {
        var f = Fuse(tais: new[]
        {
            ("CLE", Blip("CLE", "101", "0513")),
            ("IND", Blip("IND", "202", "0513", lat: 39.501)),
        });
        f.Rebuild();
        var lead = Assert.Single(Leaders(f.Rebuild()));

        var deduped = lead.ToAddDeduped();
        var raw = lead.ToAddRaw();
        Assert.Equal(raw.Length, deduped.Length);
        Assert.Equal(2, deduped[^1]);                              // group count travels
        Assert.Equal(0, raw[^1]);
        Assert.Equal("CLE+IND", deduped[NasEntity.FacilityField]);  // union in dedupe mode
        Assert.Equal("CLE", raw[NasEntity.FacilityField]);          // its own, raw
    }

    /// <summary>
    /// A target that GAINS a second reporting facility has changed identity as surely as one
    /// that gains a callsign — the label it draws is different. Leave the group out of the
    /// identity hash and the add is never re-sent, so the client keeps the one-facility label
    /// forever while the server has the right answer the whole time.
    /// </summary>
    [Fact]
    public void GainingAFacilityChangesTheDedupedIdentityHash()
    {
        var alone = new[] { ("CLE", Blip("CLE", "101", "0513")) };
        var pair = new[]
        {
            ("CLE", Blip("CLE", "101", "0513")),
            ("IND", Blip("IND", "202", "0513", lat: 39.501)),
        };
        var which = alone;
        var f = new NasFusion(() => Array.Empty<FlightState>(), () => which,
                              () => Array.Empty<AsdexTrack>(), null);

        f.Rebuild();
        var before = Assert.Single(Leaders(f.Rebuild()));
        var h0 = before.IdentityHash(dedupe: true);

        which = pair;
        f.Rebuild();
        var after = f.Rebuild().Entities[before.Id];
        Assert.NotEqual(h0, after.IdentityHash(dedupe: true));
    }

    /// <summary>
    /// The viewer-side half: one client collapsing its map must not change what another sees.
    /// Both views are computed from the SAME snapshot here, which is the thing that would break
    /// if the index merged instead of grouping.
    /// </summary>
    [Fact]
    public void TwoViewersOfOneSnapshotCanDisagree()
    {
        var f = Fuse(tais: new[]
        {
            ("CLE", Blip("CLE", "101", "0513")),
            ("IND", Blip("IND", "202", "0513", lat: 39.501)),
        });
        f.Rebuild();
        var snap = f.Rebuild();

        var collapsed = new NasView { Dedupe = true };
        var raw = new NasView { Dedupe = false };

        Assert.Equal(1, collapsed.Compute(snap)!.Shown);
        Assert.Equal(2, raw.Compute(snap)!.Shown);
    }

    /// <summary>A viewer that turns dedupe OFF mid-session must be sent the follower it was
    /// never told about. The add/delete bookkeeping is per client and keyed on what that client
    /// holds, so this is the one path where a stale <c>_sent</c> entry would leave a target
    /// permanently missing from one browser and present in every other.</summary>
    [Fact]
    public void TogglingDedupeOffDeliversTheHiddenTarget()
    {
        var f = Fuse(tais: new[]
        {
            ("CLE", Blip("CLE", "101", "0513")),
            ("IND", Blip("IND", "202", "0513", lat: 39.501)),
        });
        f.Rebuild();
        var snap = f.Rebuild();

        var v = new NasView();
        Assert.Equal(1, v.Compute(snap)!.Shown);

        Assert.True(v.Apply("""{"cmd":"view","dedupe":false}"""));
        var next = v.Compute(snap)!;
        Assert.Equal(2, next.Shown);

        // BOTH are adds, and the second one is the point: the leader's label changes from the
        // group union back to its own facility, so leaving it alone would show "CLE+IND" on a
        // map that is now drawing CLE and IND as separate targets - a label contradicting the
        // picture it sits on. The identity hash carries the group for exactly this reason.
        Assert.Equal(2, next.Add!.Count);
        var ids = next.Add!.Select(r => (long)r[0]).ToHashSet();
        Assert.Equal(snap.Entities.Keys.ToHashSet(), ids);
    }
}
