namespace SwimServer.Tests;

/// <summary>
/// LADD matching across the forms an identifier actually arrives in.
///
/// <para>These exist because <c>Normalize</c> gained a fast path that returns the caller's string
/// unchanged when there is no punctuation to strip — which is only correct because every set it
/// is looked up in uses <c>OrdinalIgnoreCase</c>, so the uppercasing it skips was redundant. If
/// that ever stops being true, a lower-case Mode S hex (which is how SFDPS publishes them) stops
/// matching the list and a blocked aircraft is published. Nothing would error.</para>
/// </summary>
public class LaddNormalizeTests
{
    private static void WithList(IEnumerable<string> ids, Action body)
    {
        LaddService.SetBlockedForTest(ids);
        try { body(); }
        finally { LaddService.SetBlockedForTest(Array.Empty<string>()); }
    }

    /// <summary>The case the fast path takes: no punctuation, so the string is passed straight
    /// through. It must still match a differently-cased list entry.</summary>
    [Theory]
    [InlineData("N123AB", "n123ab")]
    [InlineData("n123ab", "N123AB")]
    [InlineData("AD9003", "ad9003")]   // SFDPS publishes Mode S hex lower-case
    [InlineData("ad9003", "AD9003")]
    public void CaseNeverDecidesAMatch(string listed, string queried)
        => WithList(new[] { listed }, () => Assert.True(LaddService.IsBlocked(queried, null, null)));

    /// <summary>And the slow path still strips, in both directions.</summary>
    [Theory]
    [InlineData("N123-AB", "N123AB")]
    [InlineData("N123AB", "N123-AB")]
    [InlineData("N 123.AB", "n123ab")]
    public void PunctuationNeverDecidesAMatch(string listed, string queried)
        => WithList(new[] { listed }, () => Assert.True(LaddService.IsBlocked(queried, null, null)));

    [Fact]
    public void AnUnlistedAircraftIsNotBlocked()
        => WithList(new[] { "N123AB" }, () =>
        {
            Assert.False(LaddService.IsBlocked("N999ZZ", null, null));
            Assert.False(LaddService.IsBlocked(null, null, null));
        });

    /// <summary>Any of the three identifiers is enough — ~2/3 of the IndustryLADD file is hex.</summary>
    [Fact]
    public void CallsignRegistrationOrModeSEachMatch()
        => WithList(new[] { "ABCDEF" }, () =>
        {
            Assert.True(LaddService.IsBlocked("abcdef", null, null));
            Assert.True(LaddService.IsBlocked(null, "ab-cd-ef", null));
            Assert.True(LaddService.IsBlocked(null, null, "AbCdEf"));
        });

    [Fact]
    public void WithNoListLoadedNothingIsBlocked()
    {
        LaddService.SetBlockedForTest(Array.Empty<string>());
        Assert.False(LaddService.IsBlocked("N123AB", "N123AB", "ABCDEF"));
    }
}
