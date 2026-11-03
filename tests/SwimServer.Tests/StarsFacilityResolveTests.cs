using System.Text.Json;

namespace SwimServer.Tests;

/// <summary>
/// StarsBridge.Resolve — deciding whether a facility can be displayed at all.
///
/// The bug these pin: /stars/{artcc}/{facility} served the scope shell for ANY two strings, so a
/// facility with no starsConfiguration drew a blank screen and said nothing. Shapes here follow
/// the live vNAS tree (ZMA: DJT is the Atct with no config, PBI the Tracon with 160 maps, and
/// both are named "Palm Beach ATCT" — which is what makes the alias possible).
/// </summary>
public class StarsFacilityResolveTests
{
    private static string Fac(string id, string name, string type, bool stars, string children = "") =>
        $@"{{""id"":""{id}"",""name"":""{name}"",""type"":""{type}"",
            ""starsConfiguration"":{(stars ? @"{""areas"":[]}" : "null")},
            ""childFacilities"":[{children}]}}";

    /// <summary>ZMA as vNAS actually publishes it, trimmed to what Resolve reads.</summary>
    private static JsonElement Zma()
    {
        var kids = string.Join(",", new[]
        {
            Fac("PBI", "Palm Beach ATCT", "Tracon", true),    // the TRACON — has the maps
            Fac("DJT", "Palm Beach ATCT", "Atct", false),     // the ATCT — same name, no config
            Fac("MIA", "Miami ATCT", "AtctTracon", true),
            Fac("FLL", "Fort Lauderdale ATCT", "Atct", false),
        });
        return JsonDocument.Parse(Fac("ZMA", "Miami ARTCC", "Artcc", false, kids)).RootElement;
    }

    [Fact]
    public void FacilityWithAConfig_IsServed()
    {
        var r = StarsBridge.Resolve(Zma(), "PBI");
        Assert.Equal(StarsBridge.StarsFacilityStatus.Ok, r.Status);
        Assert.Equal("PBI", r.FacilityId);
    }

    [Theory]
    [InlineData("pbi")]
    [InlineData("PbI")]
    [InlineData(" PBI ")]
    public void FacilityId_IsCaseInsensitive_AndCanonicalised(string typed)
    {
        // `/stars/zma/pbi` used to 404 inside FindFacility and hand the scope a 404 body where it
        // expected a facility — the same blank screen, reached a different way.
        var r = StarsBridge.Resolve(Zma(), typed);
        Assert.Equal(StarsBridge.StarsFacilityStatus.Ok, r.Status);
        Assert.Equal("PBI", r.FacilityId);   // canonical spelling, whatever was typed
    }

    [Fact]
    public void NonStarsFacility_WithOneSameNamedStarsSibling_Aliases()
    {
        // The DJT case. Name-based rather than a hardcoded table: over 306 non-STARS facilities
        // across 10 ARTCCs this fires exactly once and is never ambiguous.
        var r = StarsBridge.Resolve(Zma(), "DJT");
        Assert.Equal(StarsBridge.StarsFacilityStatus.Aliased, r.Status);
        Assert.Equal("DJT", r.FacilityId);
        Assert.Equal("PBI", r.AliasOf);
    }

    [Fact]
    public void NonStarsFacility_WithNoNameTwin_SaysSo()
    {
        // 305 of those 306 land here — the common case, and the one the blank scope hid.
        var r = StarsBridge.Resolve(Zma(), "FLL");
        Assert.Equal(StarsBridge.StarsFacilityStatus.NoStarsConfig, r.Status);
        Assert.Equal("Atct", r.Type);
        Assert.Null(r.AliasOf);
    }

    [Fact]
    public void AmbiguousName_DoesNotAlias()
    {
        // Two STARS facilities sharing the ATCT's name: guessing between them would be worse than
        // saying nothing, so uniqueness is required. This is what keeps the name rule safe.
        var kids = string.Join(",", new[]
        {
            Fac("AAA", "Twin Name ATCT", "Tracon", true),
            Fac("BBB", "Twin Name ATCT", "Tracon", true),
            Fac("CCC", "Twin Name ATCT", "Atct", false),
        });
        var tree = JsonDocument.Parse(Fac("ZZZ", "Test ARTCC", "Artcc", false, kids)).RootElement;

        var r = StarsBridge.Resolve(tree, "CCC");
        Assert.Equal(StarsBridge.StarsFacilityStatus.NoStarsConfig, r.Status);
        Assert.Null(r.AliasOf);
    }

    [Fact]
    public void UnknownId_IsNotFound()
    {
        var r = StarsBridge.Resolve(Zma(), "nope");
        Assert.Equal(StarsBridge.StarsFacilityStatus.NotFound, r.Status);
        Assert.Equal("NOPE", r.FacilityId);
    }

    [Fact]
    public void TheArtccItself_HasNoStarsDisplay()
    {
        var r = StarsBridge.Resolve(Zma(), "ZMA");
        Assert.Equal(StarsBridge.StarsFacilityStatus.NoStarsConfig, r.Status);
    }

    [Fact]
    public void AvailableList_IsTheStarsFacilitiesOnly_Sorted()
    {
        // What the picker offers, and what the ?notice= sends people back to.
        var r = StarsBridge.Resolve(Zma(), "FLL");
        Assert.Equal(new[] { "MIA", "PBI" }, r.Available);
    }
}
