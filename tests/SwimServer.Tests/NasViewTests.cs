namespace SwimServer.Tests;

/// <summary>
/// One client's viewport and diff over the fused picture.
///
/// <para>Everything here fails <i>quietly</i>. A viewport that matches nothing across the
/// antimeridian looks like a quiet Pacific. A truncation that returns a different subset each
/// tick looks like a broken renderer. An identity update that never reaches the client leaves an
/// airplane permanently unlabeled. A hash over the un-rounded position makes the delta stream
/// send everything, every tick, while appearing to work perfectly. None of it throws, and a
/// browser shows a plausible map in every case.</para>
/// </summary>
public class NasViewTests
{
    // ── The antimeridian ───────────────────────────────────────────────────────────────

    /// <summary>
    /// Leaflet reports a viewport spanning the date line as west &gt; east (170 → −170), and the
    /// obvious <c>lon &gt;= w &amp;&amp; lon &lt;= e</c> then matches nothing whatsoever. The one
    /// stretch of map where a NAS view legitimately wraps is the Pacific — which is exactly where
    /// Anchorage and Honolulu traffic is, and an empty Pacific is indistinguishable from a quiet
    /// one.
    /// </summary>
    [Theory]
    // ordinary box: inside, and outside on both sides
    [InlineData(-100, -120, -80, true)]
    [InlineData(-130, -120, -80, false)]
    [InlineData(-70, -120, -80, false)]
    // wrapped box 170 .. -170: both lobes are inside, the middle of the map is not
    [InlineData(175, 170, -170, true)]
    [InlineData(-175, 170, -170, true)]
    [InlineData(180, 170, -170, true)]
    [InlineData(-180, 170, -170, true)]
    [InlineData(0, 170, -170, false)]
    [InlineData(100, 170, -170, false)]
    [InlineData(-100, 170, -170, false)]
    public void LongitudeRangesWrap(double lon, double west, double east, bool inside)
        => Assert.Equal(inside, NasView.LonInRange(lon, west, east));

    [Fact]
    public void AWrappedViewportActuallyReturnsPacificTraffic()
    {
        var v = new NasView();
        // 170 E round to 140 W: the box Leaflet reports for a Pacific view, west > east.
        Assert.True(v.Apply("""{"cmd":"view","bbox":[15,170,65,-140]}"""));

        var snap = Snap(
            E(1, lat: 61.2, lon: -149.9, cs: "ASA100"),   // Anchorage        — east lobe
            E(2, lat: 21.3, lon: -157.9, cs: "HAL200"),   // Honolulu         — east lobe
            E(3, lat: 51.9, lon: -176.6, cs: "ASA51"),    // Adak             — east lobe
            E(4, lat: 52.0, lon: 175.0, cs: "KAL1"),      // west of the line — west lobe
            E(5, lat: 35.5, lon: 139.8, cs: "JAL1"),      // Tokyo            — outside, west
            E(6, lat: 40.0, lon: -75.0, cs: "AAL1"));     // Philadelphia     — outside, east

        var p = v.Compute(snap);
        Assert.NotNull(p);
        var got = p!.Add!.Select(a => (long)a[0]).ToHashSet();
        Assert.Equal(new HashSet<long> { 1, 2, 3, 4 }, got);
        Assert.Equal(4, p.Matched);
    }

    // ── The diff ───────────────────────────────────────────────────────────────────────

    /// <summary>
    /// A still viewport over a still sky must produce <b>nothing</b> after the first message.
    /// This is the entire justification for the design: if an unchanged target still costs
    /// bytes, the stream is a snapshot feed wearing a delta's clothes.
    /// </summary>
    [Fact]
    public void AnUnchangedTargetIsSentOnceAndThenNotAgain()
    {
        var v = new NasView();
        var e = E(1, cs: "AAL1");
        var snap = Snap(e);

        var first = v.Compute(snap);
        Assert.NotNull(first);
        Assert.Equal("snapshot", first!.Type);
        Assert.Single(first.Add!);

        Assert.Null(v.Compute(Snap(e)));
        Assert.Null(v.Compute(Snap(e)));
    }

    /// <summary>
    /// Identity rides the ADD, position rides the UPD. A moved target must cost seven numbers,
    /// not twelve — identity is what almost never changes and is the bulk of the row.
    /// </summary>
    [Fact]
    public void MovementSendsTheShortRowAndIdentitySendsTheLongOne()
    {
        var v = new NasView();
        var e = E(1, cs: "AAL1");
        v.Compute(Snap(e));

        e.Lat += 0.05;
        var moved = v.Compute(Snap(e));
        Assert.NotNull(moved);
        Assert.Null(moved!.Add);
        Assert.Equal(7, Assert.Single(moved.Upd!).Length);

        // Now the facility correlates it under a different callsign: the client has to be told
        // who it is, so this is an add (an upsert), not an update.
        e.Callsign = "AAL2";
        var renamed = v.Compute(Snap(e));
        Assert.NotNull(renamed);
        Assert.Null(renamed!.Upd);
        var row = Assert.Single(renamed.Add!);
        Assert.Equal(12, row.Length);
        Assert.Equal("AAL2", row[7]);
    }

    /// <summary>
    /// An untagged return that GAINS a callsign is the case this matters for — it happens
    /// constantly as facilities correlate primary targets, and without the identity-hash check
    /// the client would hold the target forever with no name while the server considered it
    /// perfectly up to date.
    /// </summary>
    [Fact]
    public void AnUntaggedTargetGainingACallsignReachesTheClient()
    {
        var v = new NasView();
        var e = E(1);                       // no callsign
        var first = v.Compute(Snap(e));
        Assert.Equal("", Assert.Single(first!.Add!)[7]);

        e.Callsign = "N123AB";
        var upd = v.Compute(Snap(e));
        Assert.NotNull(upd);
        Assert.Equal("N123AB", Assert.Single(upd!.Add!)[7]);
    }

    [Fact]
    public void ATargetLeavingTheViewportIsRemovedOnceAndThenForgotten()
    {
        var v = new NasView();
        Assert.True(v.Apply("""{"cmd":"view","bbox":[30,-100,50,-70]}"""));
        var e = E(1, lat: 40, lon: -80, cs: "AAL1");
        v.Compute(Snap(e));

        e.Lat = 10;                              // flown out of the box
        var gone = v.Compute(Snap(e));
        Assert.Equal(new[] { 1L }, gone!.Del);

        // ...and not deleted again on the next tick, which would be a growing del list forever.
        Assert.Null(v.Compute(Snap(e)));
    }

    /// <summary>
    /// <b>The hash must be over the ROUNDED position.</b> The wire form sends five decimal
    /// places; hashing the raw double marks a target changed on movement far below what is
    /// actually transmitted, so every target is re-sent every tick — a delta stream that behaves
    /// exactly like a snapshot stream while every counter says it is working.
    /// </summary>
    [Fact]
    public void MovementBelowTheTransmittedPrecisionIsNotAnUpdate()
    {
        var v = new NasView();
        var e = E(1, lat: 40.123456, lon: -80.123456, cs: "AAL1");
        v.Compute(Snap(e));

        e.Lat += 0.0000001;      // seventh decimal: ~1 cm, and not in the wire form at all
        e.Lon -= 0.0000002;
        Assert.Null(v.Compute(Snap(e)));

        e.Lat += 0.0001;         // fourth decimal: ~11 m, genuinely different
        Assert.NotNull(v.Compute(Snap(e)));
    }

    // ── Truncation ─────────────────────────────────────────────────────────────────────

    /// <summary>
    /// Over the cap, consecutive ticks must keep the <b>same</b> targets. An arbitrary subset —
    /// whatever the dictionary happened to yield — would make a third of the screen blink at the
    /// tick rate, which reads as a broken renderer rather than as a limit being applied.
    /// </summary>
    [Fact]
    public void TruncationIsStableAcrossTicks()
    {
        var v = new NasView();
        Assert.True(v.Apply("""{"cmd":"view","cap":100}"""));

        var ents = new List<NasEntity>();
        for (int i = 1; i <= 500; i++) ents.Add(E(i, cs: "N" + i));

        var first = v.Compute(Snap(ents.ToArray()));
        Assert.Equal(100, first!.Shown);
        Assert.Equal(500, first.Matched);
        Assert.True(first.Truncated);

        // Second tick, same sky, deliberately enumerated the other way round.
        ents.Reverse();
        var second = v.Compute(Snap(ents.ToArray()));
        // Nothing changed, so there is nothing to send at all — which only holds if the SAME
        // hundred survived. A different hundred would produce adds and dels.
        Assert.Null(second);
    }

    /// <summary>
    /// And the cap keeps the useful traffic. The primary-only noise floor is ~20% of a
    /// continental view and the least informative thing on it, so it is the first to go.
    /// </summary>
    [Fact]
    public void TheCapKeepsIdentifiedTrafficAndDropsTheNoiseFloorFirst()
    {
        var v = new NasView();
        // 100 is the floor the cap clamps to, so a smaller number here would silently not
        // truncate at all and the test would pass for the wrong reason.
        Assert.True(v.Apply("""{"cmd":"view","cap":100}"""));
        Assert.Equal(100, v.Cap);

        var ents = new List<NasEntity>();
        for (int i = 1; i <= 400; i++) ents.Add(E(i, cls: NasClass.Primary));
        for (int i = 401; i <= 500; i++) ents.Add(E(i, cs: "AAL" + i));   // EnRoute

        var p = v.Compute(Snap(ents.ToArray()));
        Assert.Equal(100, p!.Shown);
        Assert.True(p.Truncated);
        Assert.All(p.Add!, row => Assert.Equal((int)NasClass.EnRoute, row[6]));
    }

    [Fact]
    public void ClassPriorityPutsIdentifiedTrafficFirstAndPrimaryLast()
    {
        Assert.True(NasView.Priority(NasClass.EnRoute) < NasView.Priority(NasClass.Untagged));
        Assert.True(NasView.Priority(NasClass.Terminal) < NasView.Priority(NasClass.Untagged));
        Assert.True(NasView.Priority(NasClass.Surface) < NasView.Priority(NasClass.Untagged));
        Assert.True(NasView.Priority(NasClass.Untagged) < NasView.Priority(NasClass.Primary));
        Assert.True(NasView.Priority(NasClass.Vehicle) < NasView.Priority(NasClass.Primary));
    }

    // ── Filters ────────────────────────────────────────────────────────────────────────

    /// <summary>
    /// A bare token matches an airport in either direction — someone typing KJFK wants both
    /// arrivals and departures. A dash or chevron asks a different question, and must not be
    /// answered with "any flight touching either airport".
    /// </summary>
    [Fact]
    public void ACityPairIsADifferentQuestionFromAnAirport()
    {
        var jfkLax = E(1, cs: "AAL1"); jfkLax.Origin = "KJFK"; jfkLax.Dest = "KLAX";
        var laxJfk = E(2, cs: "AAL2"); laxJfk.Origin = "KLAX"; laxJfk.Dest = "KJFK";
        var jfkBos = E(3, cs: "AAL3"); jfkBos.Origin = "KJFK"; jfkBos.Dest = "KBOS";

        Assert.True(NasView.Matches(jfkLax, "KJFK"));
        Assert.True(NasView.Matches(laxJfk, "KJFK"));
        Assert.True(NasView.Matches(jfkBos, "KJFK"));

        Assert.True(NasView.Matches(jfkLax, "KJFK-KLAX"));
        Assert.False(NasView.Matches(laxJfk, "KJFK-KLAX"));
        Assert.False(NasView.Matches(jfkBos, "KJFK-KLAX"));
        Assert.True(NasView.Matches(laxJfk, "KLAX>KJFK"));
    }

    [Fact]
    public void TheTextFilterCoversWhatSomeoneWouldActuallyType()
    {
        var e = E(1, cs: "SWA1234");
        e.Type = "B38M"; e.Registration = "N8765Q"; e.Owner = "ZDC/32";
        e.Squawk = "4523"; e.ModeS = "ac536c"; e.Airport = "KBWI";

        foreach (var q in new[] { "swa", "SWA1234", "b38m", "n8765", "zdc", "4523", "AC536C", "kbwi" })
            Assert.True(NasView.Matches(e, q), q);
        Assert.False(NasView.Matches(e, "UAL"));
    }

    /// <summary>
    /// A trailing separator is a half-typed city pair, not a filter that should match nothing:
    /// "KJFK-" arrives on the way to "KJFK-KLAX" and would otherwise blank the map mid-keystroke.
    /// </summary>
    [Fact]
    public void AHalfTypedCityPairFallsBackToAPlainMatch()
    {
        var e = E(1, cs: "AAL1"); e.Origin = "KJFK"; e.Dest = "KLAX";
        Assert.True(NasView.Matches(e, "KJFK-"));
        Assert.True(NasView.Matches(e, "KJFK"));
    }

    // ── Commands ───────────────────────────────────────────────────────────────────────

    /// <summary>
    /// A malformed command must leave the view alone and be reported as unusable, never throw —
    /// a socket that dies on bad input looks exactly like a server that stopped responding.
    /// </summary>
    [Theory]
    [InlineData("")]
    [InlineData("not json")]
    [InlineData("[]")]
    [InlineData("{}")]
    [InlineData("""{"cmd":"something-else"}""")]
    [InlineData("""{"cmd":"view","bbox":"nonsense"}""")]
    [InlineData("""{"cmd":"view","bbox":[1,2,3]}""")]
    public void AMalformedCommandIsRefusedWithoutThrowing(string json)
    {
        var v = new NasView();
        var before = (v.South, v.West, v.North, v.East, v.Cap);
        var ok = v.Apply(json);
        Assert.Equal(before, (v.South, v.West, v.North, v.East, v.Cap));
        if (json is """{"cmd":"view","bbox":"nonsense"}""" or """{"cmd":"view","bbox":[1,2,3]}""")
            Assert.True(ok);     // a usable command with an unusable box: box ignored, rest kept
        else
            Assert.False(ok);
    }

    /// <summary>
    /// An inverted or non-finite box keeps the previous viewport rather than blanking the map —
    /// the failure mode of accepting it is a screen with nothing on it and no explanation.
    /// </summary>
    [Theory]
    [InlineData("""{"cmd":"view","bbox":[50,-100,30,-70]}""")]   // north below south
    public void AnUnusableBoxIsIgnoredRatherThanApplied(string json)
    {
        var v = new NasView();
        v.Apply("""{"cmd":"view","bbox":[30,-100,50,-70]}""");
        v.Apply(json);
        Assert.Equal(30, v.South);
        Assert.Equal(50, v.North);
    }

    [Fact]
    public void TheCapIsClampedToSomethingSurvivable()
    {
        var v = new NasView();
        v.Apply("""{"cmd":"view","cap":99999999}""");
        Assert.Equal(NasView.MaxCap, v.Cap);
        v.Apply("""{"cmd":"view","cap":0}""");
        Assert.Equal(100, v.Cap);
    }

    /// <summary>
    /// Unchecking every class means "no filter", not "show nothing". A blank screen the user
    /// cannot explain is worse than an unfiltered one.
    /// </summary>
    [Fact]
    public void AnEmptyClassListMeansNoFilter()
    {
        var v = new NasView();
        v.Apply("""{"cmd":"view","cls":["EnRoute"]}""");
        Assert.NotNull(v.Classes);
        v.Apply("""{"cmd":"view","cls":[]}""");
        Assert.Null(v.Classes);
    }

    [Fact]
    public void AClassFilterIsApplied()
    {
        var v = new NasView();
        v.Apply("""{"cmd":"view","cls":["EnRoute"]}""");
        var p = v.Compute(Snap(
            E(1, cs: "AAL1"),
            E(2, cls: NasClass.Primary),
            E(3, cls: NasClass.Untagged)));
        Assert.Equal(1, p!.Matched);
    }

    /// <summary>An entity with no position is a flight plan, and must never reach a map.</summary>
    [Fact]
    public void AnUnpositionedEntityIsNeverStreamed()
    {
        var plan = new NasEntity { Id = 9, Callsign = "UAL900" };   // PosRank stays None
        plan.Classify();
        var p = new NasView().Compute(Snap(E(1, cs: "AAL1"), plan));
        Assert.Equal(1, p!.Matched);
        Assert.Equal(1L, Assert.Single(p.Add!)[0]);
    }

    // ── Helpers ────────────────────────────────────────────────────────────────────────

    private static NasEntity E(long id, double lat = 40, double lon = -80,
                               string? cs = null, NasClass cls = NasClass.EnRoute)
    {
        // Sources matters: Classify() reads it to tell EnRoute from Terminal, so a fixture that
        // leaves it unset silently produces Terminal targets and a class filter test then
        // "fails" against perfectly correct code. It did.
        var e = new NasEntity
        {
            Id = id, Callsign = cs, Lat = lat, Lon = lon,
            AltFt = 35000, Gs = 450, Trk = 90, Sources = NasSource.Sfdps,
        };
        e.TakePosition(NasPosRank.Sfdps, 0, DateTime.UtcNow);
        // Classify() derives the class, so force the ones a test asks for directly.
        e.Classify();
        if (cls == NasClass.Primary) { e.AltFt = 0; e.Gs = 0; e.Callsign = null; e.Classify(); }
        else if (cls == NasClass.Untagged) { e.Callsign = null; e.Classify(); }
        return e;
    }

    private static NasSnapshot Snap(params NasEntity[] ents)
    {
        var d = new Dictionary<long, NasEntity>();
        var st = new NasFusionStats();
        foreach (var e in ents) { d[e.Id] = e; if (e.Positioned) st.Count(e.Cls); }
        return new NasSnapshot(DateTime.UtcNow, d, st);
    }
}
