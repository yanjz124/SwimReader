namespace SwimServer.Tests;

/// <summary>
/// Parsing one <c>/proc/.../stat</c> line. Small, and worth pinning for two reasons: the file
/// does not exist on the Windows machine this is developed on, so nothing else can exercise the
/// parse at all; and the field layout has a trap that produces a plausible wrong number instead
/// of an error.
/// </summary>
public class ThreadCpuTests
{
    // Real shape, captured from the Pi: pid, (comm), state, then 11 more fields before utime.
    private static string Stat(string comm, long utime, long stime) =>
        $"41062 ({comm}) R 41058 41058 41058 0 -1 4194304 65 0 0 0 {utime} {stime} 0 0 20 0 1 0 6270076 5455872 96";

    [Fact]
    public void UserAndSystemTicksBecomeMilliseconds()
    {
        // CLK_TCK is 100, so one tick is 10 ms: 30 + 13 ticks = 430 ms.
        Assert.Equal(430, ThreadCpu.Parse(Stat("SwimServer", 30, 13)));
        Assert.Equal(0, ThreadCpu.Parse(Stat("SwimServer", 0, 0)));
    }

    /// <summary>
    /// The trap. A thread name can contain spaces AND parentheses — .NET names threads things
    /// like ".NET Long Running Task", and anything the app sets goes straight through. Splitting
    /// the whole line on spaces, or anchoring on the FIRST ')', shifts every field after it and
    /// returns a number that looks like a perfectly ordinary CPU reading. Only the LAST ')'
    /// works.
    /// </summary>
    [Theory]
    [InlineData("SwimServer")]
    [InlineData(".NET Long Running Task")]
    [InlineData("odd (nested) name")]
    [InlineData("trailing )")]
    [InlineData("")]
    public void TheThreadNameNeverShiftsTheFields(string comm)
        => Assert.Equal(430, ThreadCpu.Parse(Stat(comm, 30, 13)));

    /// <summary>A malformed line returns null rather than a fabricated reading.</summary>
    [Theory]
    [InlineData("")]
    [InlineData("41062 (x) R 1 2 3")]
    [InlineData("no parenthesis at all")]
    [InlineData("41062 (x) R 0 0 0 0 0 0 0 0 0 0 notanumber 13 0")]
    public void AMalformedLineIsNullNotAGuess(string stat)
        => Assert.Null(ThreadCpu.Parse(stat));
}
