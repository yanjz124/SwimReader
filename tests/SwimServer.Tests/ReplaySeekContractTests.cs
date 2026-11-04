namespace SwimServer.Tests;

/// <summary>
/// Guards the replay seek plumbing against the "destructive read used as a boolean test" bug.
///
/// The seek target lives in one captured local in RunReplaySession. Several nested loops
/// (PlaybackLoop's file loop, PlayFile, PlayRemainingLines, and the pause spin) need to ask
/// "is a seek pending?" so they can unwind, but only PlaybackLoop's top can actually act on the
/// value — it owns `currentTime`.
///
/// The original accessor both read AND cleared. So the first nested loop to ask the question
/// consumed the answer: the target was thrown away, every outer check then saw null, and instead
/// of jumping to the requested time playback fell through to "move to the next hour". Seeking
/// near the end of a recording therefore ran out of files and reported "End of data" — which is
/// exactly what it looked like from the UI, and why it got blamed on the recordings being
/// compressed. Seeking while paused lost the target the same way.
///
/// Driving the real loop needs a live WebSocket and an hour of recorded data, so this asserts on
/// the shape of the source instead. It is narrow on purpose: it pins the one invariant that makes
/// the design work — exactly one site clears the seek, and nothing tests it destructively.
/// </summary>
public class ReplaySeekContractTests
{
    private static string Source()
    {
        var dir = AppContext.BaseDirectory;
        while (dir is not null && !File.Exists(Path.Combine(dir, "SwimReader.sln")))
            dir = Path.GetDirectoryName(dir);
        Assert.NotNull(dir);
        var path = Path.Combine(dir!, "tools", "SwimServer", "ReplayServer.cs");
        Assert.True(File.Exists(path), $"ReplayServer.cs not found at {path}");
        return File.ReadAllText(path);
    }

    [Fact]
    public void SeekIsClearedInExactlyOnePlace()
    {
        var src = Source();

        // One call to the clearing action, in PlaybackLoop where currentTime is actually moved.
        var clears = src.Split("clearSeek()").Length - 1;
        Assert.Equal(1, clears);
    }

    [Fact]
    public void NestedLoopsPeekRatherThanConsume()
    {
        var src = Source();

        // The old destructive accessor must not come back under its old name...
        Assert.DoesNotContain("consumeSeek", src);

        // ...and the unwind checks must use the non-destructive peek.
        Assert.Contains("if (peekSeek() != null)", src);
    }
}
