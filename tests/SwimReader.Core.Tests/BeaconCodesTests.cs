using SwimReader.Server.AdsbFi;

namespace SwimReader.Core.Tests;

/// <summary>
/// Pins which beacon codes may be used to correlate a radar track with an ADS-B target.
///
/// This is the guard on a wrong-answer bug rather than a missing-answer one. Callsign enrichment
/// used to match on any squawk inside a 5 NM / 1,000 ft gate, so in busy VFR airspace — where
/// several <c>1200</c> targets are routinely inside that box — "nearest wins" handed a radar track
/// a callsign belonging to a different aeroplane. The emergency codes are non-discrete too, so an
/// aircraft squawking 7700 could be labelled with a bystander's callsign.
/// </summary>
public class BeaconCodesTests
{
    [Theory]
    // Conspicuity and special-purpose codes (FAA JO 7110.65 Ch.5 S.2).
    [InlineData("1200")]  // VFR — the one that actually caused mismatches
    [InlineData("1202")]
    [InlineData("1203")]
    [InlineData("1255")]
    [InlineData("1277")]
    [InlineData("2000")]
    [InlineData("4000")]
    // Emergencies. Non-discrete, and the worst possible target for a wrong callsign.
    [InlineData("7400")]
    [InlineData("7500")]
    [InlineData("7600")]
    [InlineData("7700")]
    [InlineData("7777")]
    // DC SFRA / FRZ allocations — shared within the SFRA.
    [InlineData("1226")]
    [InlineData("5100")]
    [InlineData("5200")]
    // Block-boundary codes: anything ending in 00.
    [InlineData("0000")]
    [InlineData("0100")]
    [InlineData("3400")]
    [InlineData("7000")]
    public void NonDiscreteCodes_AreNotCorrelatable(string squawk)
        => Assert.False(BeaconCodes.IsDiscrete(squawk));

    [Theory]
    [InlineData("1234")]
    [InlineData("4521")]
    [InlineData("0001")]
    [InlineData("7701")]  // adjacent to 7700 but discrete — must NOT be swept up with it
    [InlineData("1201")]  // adjacent to 1200, likewise
    [InlineData("7677")]
    public void DiscreteCodes_AreCorrelatable(string squawk)
        => Assert.True(BeaconCodes.IsDiscrete(squawk));

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    public void MissingCode_IsNotCorrelatable(string? squawk)
        => Assert.False(BeaconCodes.IsDiscrete(squawk));

    /// <summary>
    /// 64 block-boundary codes (octal, so 8x8 combinations of the first two digits) plus the
    /// conspicuity/special/SFRA codes that don't already end in 00. Fixing the count means an
    /// accidental deletion from the table shows up here rather than as a wrong callsign.
    /// </summary>
    [Fact]
    public void TableCoversTheBlockBoundariesPlusTheNamedCodes()
    {
        // 64 x "dd00", plus 1202 1203 1255 1277 7777 1226 — the six named codes not ending in 00.
        Assert.Equal(64 + 6, BeaconCodes.NonDiscreteCount);
    }
}
