namespace SwimServer.Tests;

/// <summary>
/// The <c>+</c>-joined source list on a fused entity — which facilities are reporting a target.
///
/// <para>It matters most for the targets that have nothing else: an uncorrelated primary return
/// near a TRACON boundary is published by both facilities, and with no Mode S and no callsign
/// nothing in the index merges them, so they arrive as two entities sitting on top of each other.
/// The reporting facility is the only thing that explains the pair.</para>
/// </summary>
public class NasTokenTests
{
    /// <summary>
    /// <b>Ordinal order is not cosmetic.</b> Entities are rebuilt every pass from sources
    /// iterated out of a <c>ConcurrentDictionary</c>, so an unsorted list comes out "PCT+N90"
    /// one pass and "N90+PCT" the next. That changes the identity hash, which makes the stream
    /// re-send every multi-facility target in full on every tick — forever, while every counter
    /// says the delta stream is working.
    /// </summary>
    [Fact]
    public void TheListIsOrderIndependent()
    {
        var a = NasEntity.AddToken(NasEntity.AddToken(null, "PCT"), "N90");
        var b = NasEntity.AddToken(NasEntity.AddToken(null, "N90"), "PCT");
        Assert.Equal(a, b);
        Assert.Equal("N90+PCT", a);
    }

    /// <summary>
    /// <b>Membership is token-by-token, not <c>Contains</c>.</b> "N9" is a substring of "N90",
    /// so a substring test silently drops a real second facility — and the symptom is simply
    /// that one of them never appears, which looks like that facility not reporting.
    /// </summary>
    [Fact]
    public void ASubstringIsNotAMember()
    {
        var list = NasEntity.AddToken(null, "N90");
        Assert.Equal("N9+N90", NasEntity.AddToken(list, "N9"));

        var rev = NasEntity.AddToken(null, "N9");
        Assert.Equal("N9+N90", NasEntity.AddToken(rev, "N90"));
    }

    [Fact]
    public void TheSameSourceTwiceChangesNothing()
    {
        var once = NasEntity.AddToken(null, "PCT");
        Assert.Same(once, NasEntity.AddToken(once, "PCT"));

        var two = NasEntity.AddToken(once, "A80");
        Assert.Same(two, NasEntity.AddToken(two, "PCT"));
        Assert.Same(two, NasEntity.AddToken(two, "A80"));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    public void NothingToAddLeavesTheListAlone(string? token)
    {
        Assert.Null(NasEntity.AddToken(null, token));
        Assert.Equal("PCT", NasEntity.AddToken("PCT", token));
    }

    [Fact]
    public void TheFirstSourceCostsNoAllocation()
        => Assert.Same("PCT", NasEntity.AddToken(null, "PCT"));

    /// <summary>Bounded, so a target drifting along a boundary cannot grow an unreadable label.</summary>
    [Fact]
    public void TheListIsCapped()
    {
        string? l = null;
        foreach (var f in new[] { "A80", "D10", "N90", "PCT", "S46", "U90" })
            l = NasEntity.AddToken(l, f);
        Assert.Equal(NasEntity.MaxTokens, l!.Split('+').Length);
    }

    /// <summary>The entity-level wrappers for facility and airport use it, and stay apart.</summary>
    [Fact]
    public void FacilityAndAirportAreSeparateLists()
    {
        var e = new NasEntity();
        e.AddFacility("PCT");
        e.AddFacility("N90");
        e.AddAirport("KEWR");
        Assert.Equal("N90+PCT", e.Facility);
        Assert.Equal("KEWR", e.Airport);
    }
}
