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
        IEnumerable<AsdexTrack>? asdex = null) =>
        new(() => sfdps ?? Array.Empty<FlightState>(),
            () => tais ?? Array.Empty<(string, TaisTrack)>(),
            () => asdex ?? Array.Empty<AsdexTrack>());

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
