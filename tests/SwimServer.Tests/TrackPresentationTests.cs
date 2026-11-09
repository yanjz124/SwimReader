using Xunit;

namespace SwimServer.Tests;

/// <summary>
/// What /track and the Telegram bot SAY about a flight, as opposed to what they fetch.
///
/// <para>Both of these shipped wrong and neither threw, logged, or moved a counter. An altitude
/// renders as a plausible-looking string whatever the unit, and a phase label is one word that
/// reads fine until you check it against the flight — so a browser or a hand-read of the bot text
/// confirms nothing. Same lesson as AssetVersionTests and AdsbBeaconReaderTests.</para>
/// </summary>
public class TrackPresentationTests
{
    // ── altitude: flight level at or above the transition altitude, feet below it ──

    [Theory]
    // At or above 18,000 ft it is a flight level, zero-padded to three digits.
    [InlineData(37000, "FL370")]
    [InlineData(32000, "FL320")]
    [InlineData(24000, "FL240")]
    [InlineData(18000, "FL180")]
    // Below it, plain feet with a thousands separator. Every one of these used to print as a
    // bogus flight level: 3,800 ft as "FL38", 1,000 ft as "FL10", 9,000 ft as "FL90".
    [InlineData(17900, "17,900 ft")]
    [InlineData(16600, "16,600 ft")]
    [InlineData(9000, "9,000 ft")]
    [InlineData(3800, "3,800 ft")]
    [InlineData(1000, "1,000 ft")]
    [InlineData(0, "0 ft")]
    public void AltitudeUsesFlightLevelsOnlyAboveTheTransitionAltitude(double feet, string expected)
        => Assert.Equal(expected, TrackRoutes.FmtAlt(feet));

    [Fact]
    public void FlightLevelIsPaddedSoItReadsAsThreeDigits()
    {
        // FL50 is not a flight level anyone writes, and an unpadded form also collides visually
        // with the feet case. Anything that IS a flight level is >= 180, so padding is about the
        // format being fixed-width rather than about reaching three digits.
        Assert.Equal("FL180", TrackRoutes.FmtAlt(18000));
        Assert.StartsWith("FL", TrackRoutes.FmtAlt(45000));
        Assert.Equal(5, TrackRoutes.FmtAlt(45000).Length);
    }

    [Fact]
    public void AltitudeRoundsToTheNearestHundredFeet()
    {
        Assert.Equal("3,800 ft", TrackRoutes.FmtAlt(3775));
        Assert.Equal("FL320", TrackRoutes.FmtAlt(32040));
    }

    // ── phase ──

    private static FlightState Flight(string status, double? lat, double? gs, int posAgeSec)
        => new()
        {
            FlightStatus = status,
            Latitude = lat,
            GroundSpeed = gs,
            LastPositionTime = DateTime.UtcNow.AddSeconds(-posAgeSec),
        };

    [Fact]
    public void DroppedWithALivePositionIsStillAirborne()
    {
        // The reported case: FL320, 477 kt, position 1 second old, labelled DROPPED. SFDPS marks a
        // flight DROPPED when the LOSING center drops the track during a handoff, before the
        // receiving center reports — so it says nothing about the flight while radar is current.
        var f = Flight("DROPPED", 35.4, 477, posAgeSec: 1);
        Assert.Equal("AIRBORNE", TrackRoutes.PhaseOf(f, null, null).label);
    }

    [Fact]
    public void DroppedWithNoRecentPositionStillReadsDropped()
    {
        // The freshness test is what separates the artifact from a real loss of track; without it
        // this would silently become "DROPPED is never shown".
        var f = Flight("DROPPED", 35.4, 477, posAgeSec: 600);
        Assert.Equal("DROPPED", TrackRoutes.PhaseOf(f, null, null).label);
    }

    [Fact]
    public void CompletedIsLandedEvenWhileTheLastRadarSpeedIsHigh()
    {
        // SFDPS publishes COMPLETED with an actual arrival time. This status was not consulted at
        // all, so a flight that had landed at ATL read AIRBORNE off a 132 kt rollout fix.
        var f = Flight("COMPLETED", 33.6, 132, posAgeSec: 267);
        Assert.Equal("LANDED", TrackRoutes.PhaseOf(f, null, null).label);
    }

    [Fact]
    public void AirborneDoesNotDependOnPositionFreshness()
    {
        // A coasting flight is still airborne. Gating this on freshness would make the label flip
        // back and forth across a single missed radar scan.
        var f = Flight("ACTIVE", 35.4, 450, posAgeSec: 300);
        Assert.Equal("AIRBORNE", TrackRoutes.PhaseOf(f, null, null).label);
    }

    [Fact]
    public void NoPositionIsPreDeparture()
    {
        Assert.Equal("PRE-DEPARTURE", TrackRoutes.PhaseOf(Flight("ACTIVE", null, null, 0), null, null).label);
        Assert.Equal("PRE-DEPARTURE", TrackRoutes.PhaseOf(Flight("PROPOSED", null, null, 0), null, null).label);
    }

    [Fact]
    public void CancelledIsReported()
        => Assert.Equal("CANCELLED", TrackRoutes.PhaseOf(Flight("CANCELLED", null, null, 0), null, null).label);

    [Fact]
    public void AsdexOutranksAStaleSfdpsSpeedForAnAircraftThatHasLanded()
    {
        // The measured case: SFDPS still reporting 147 kt from its last fix on the rollout, while
        // the surface radar has the aircraft taxiing at 6 kt. SFDPS stops updating on touchdown;
        // ASDE-X reports every second, so it is the better source here.
        var f = Flight("ACTIVE", 33.95, 147, posAgeSec: 159);
        f.ReportedAltitude = 100;
        Assert.Equal("ON SURFACE", TrackRoutes.PhaseOf(f, new AsdexTrack { SpeedKts = 6 }, null).label);
    }

    [Fact]
    public void AGenuineRolloutIsNotCalledSurface()
    {
        // ASDE-X reports the rollout fast too, which is what separates it from a taxiing aircraft.
        var f = Flight("ACTIVE", 33.95, 147, posAgeSec: 2);
        f.ReportedAltitude = 100;
        Assert.Equal("AIRBORNE", TrackRoutes.PhaseOf(f, new AsdexTrack { SpeedKts = 138 }, null).label);
    }

    [Fact]
    public void AMidflightAircraftInSurfaceDataIsNeverCalledSurface()
    {
        // The case the original ordering existed to guard against: an airborne flight briefly
        // appearing in ASDE-X data must not be relabelled off it. The Mode C gate is what holds.
        var f = Flight("ACTIVE", 33.95, 450, posAgeSec: 2);
        f.ReportedAltitude = 35000;
        Assert.Equal("AIRBORNE", TrackRoutes.PhaseOf(f, new AsdexTrack { SpeedKts = 3 }, null).label);
    }

    [Fact]
    public void UnknownModeCDoesNotLetSurfaceDataWin()
    {
        // With no reported altitude there is no sanity check on the cross-source match, so the
        // conservative answer is to leave SFDPS in charge.
        var f = Flight("ACTIVE", 33.95, 450, posAgeSec: 2);
        Assert.Null(f.ReportedAltitude);
        Assert.Equal("AIRBORNE", TrackRoutes.PhaseOf(f, new AsdexTrack { SpeedKts = 3 }, null).label);
    }

    [Fact]
    public void SurfaceAndTerminalRemainTheFallbacks()
    {
        Assert.Equal("ON SURFACE",
            TrackRoutes.PhaseOf(null, new AsdexTrack { SpeedKts = 12 }, null).label);
        Assert.Equal("TERMINAL", TrackRoutes.PhaseOf(null, null, new TaisTrack()).label);
        Assert.Equal("TRACKED", TrackRoutes.PhaseOf(null, null, null).label);
    }
}
