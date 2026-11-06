using SwimServer;

namespace SwimServer.Tests;

/// <summary>
/// "1x means 1x" is the one contract replay pacing has, and it broke silently: the old rule
/// skipped any inter-record gap longer than five seconds of scaled wait, which is most of a quiet
/// TRACON's gaps, so STARS replay for small facilities ran at 5-120x, overtook the recorder, hit
/// what the engine treats as end-of-archive, and blanked the scope 30 s later. Nothing threw and
/// the busy facilities everyone checks against (A80, PCT) looked right at 1.1x -- so only a test
/// over a realistic timestamp sequence can see it.
/// </summary>
public class ReplayPacingTests
{
    // Far enough ahead that nothing in these sequences counts as being at the live edge; a replay
    // of recorded history is always in this case.
    private const long HistoricalEdge = long.MaxValue / 2;

    /// <summary>Total wait a whole sequence of record times earns, in seconds.</summary>
    private static double WaitSecondsFor(IEnumerable<long> recordTimesMs, double speed,
        long liveEdgeMs = HistoricalEdge)
    {
        double total = 0;
        long? prev = null;
        foreach (var t in recordTimesMs)
        {
            if (prev is { } p && t > p)
                total += ReplayServer.PacingWaitMs(t - p, speed, t, liveEdgeMs);
            prev = t;
        }
        return total / 1000.0;
    }

    private static List<long> EvenlySpaced(long startMs, long stepMs, int count)
    {
        var l = new List<long>(count);
        for (int i = 0; i < count; i++) l.Add(startMs + i * stepMs);
        return l;
    }

    [Theory]
    // A busy TRACON updates several times a second; this always worked.
    [InlineData(500)]
    [InlineData(1_000)]
    // Above the old 5 s rule. These are a quiet facility's NORMAL reporting cadence -- GTF had 41
    // gaps of 15-60 s in a single recorded hour, every one of them real quiet time -- and each was
    // previously served with zero wait.
    [InlineData(6_000)]
    [InlineData(12_000)]
    [InlineData(30_000)]
    [InlineData(55_000)]
    public void OneTimesPlaysOneSecondPerRecordedSecond(long stepMs)
    {
        var times = EvenlySpaced(1_000_000_000_000, stepMs, 200);
        var span = (times[^1] - times[0]) / 1000.0;

        var wait = WaitSecondsFor(times, speed: 1.0);

        // Within 1%: real time, not a multiple of it.
        Assert.InRange(wait, span * 0.99, span * 1.01);
    }

    [Theory]
    [InlineData(0.5)]
    [InlineData(2)]
    [InlineData(60)]
    [InlineData(300)]
    public void SpeedDividesTheWaitAndTheGapThresholdDoesNotMoveWithIt(double speed)
    {
        // 20 s spacing: under the old rule this was skipped at 1x-4x but paced at 60x+, so the
        // same recording played at a different *shape* depending on speed. The threshold is now
        // measured against real recorded time, so it is speed-independent.
        var times = EvenlySpaced(1_000_000_000_000, 20_000, 100);
        var span = (times[^1] - times[0]) / 1000.0;

        var wait = WaitSecondsFor(times, speed);

        Assert.InRange(wait, span / speed * 0.99, span / speed * 1.01);
    }

    [Fact]
    public void GenuineRecordingOutageIsStillSkipped()
    {
        // The skip exists for real outages -- a restart leaves minutes of nothing, and sitting
        // through it at 1x would look like a hung session. A ten-minute hole must stay free.
        var t0 = 1_000_000_000_000;
        var times = new List<long> { t0, t0 + 1_000, t0 + 601_000, t0 + 602_000 };

        var wait = WaitSecondsFor(times, speed: 1.0);

        Assert.InRange(wait, 1.9, 2.1);   // the two 1 s steps, and nothing for the 600 s hole
    }

    [Fact]
    public void SkippingNeverAdvancesPastTheLiveEdge()
    {
        // A near-empty facility (FAI: 2.9 KB recorded in an hour) is almost all skippable gap, so
        // even with the threshold fixed it races -- straight through the live edge, off the end of
        // the newest hour file, and into end-of-archive. The overshoot has to be waited out.
        var edge = 1_000_000_000_000;
        var times = new List<long> { edge - 600_000, edge + 120_000 };

        var wait = WaitSecondsFor(times, speed: 1.0, liveEdgeMs: edge);

        // Not free: the record sits 120 s past what is readable, so that is the wait.
        Assert.InRange(wait, 119.0, 121.0);
    }

    [Fact]
    public void AGapThatEndsBehindTheLiveEdgeIsStillFree()
    {
        // The converse, and the case that must not regress: replaying history is entirely behind
        // the live edge, so outages there cost nothing.
        var edge = 1_000_000_000_000;
        var times = new List<long> { edge - 7_200_000, edge - 3_600_000 };

        Assert.Equal(0, WaitSecondsFor(times, speed: 1.0, liveEdgeMs: edge));
    }

    [Fact]
    public void SimultaneousAndOutOfOrderRecordsEarnNoWait()
    {
        Assert.Equal(0, ReplayServer.PacingWaitMs(0, 1.0, 1_000, HistoricalEdge));
        Assert.Equal(0, ReplayServer.PacingWaitMs(-5_000, 1.0, 1_000, HistoricalEdge));
        Assert.Equal(0, ReplayServer.PacingWaitMs(1_000, 0, 1_000, HistoricalEdge));
    }
}
