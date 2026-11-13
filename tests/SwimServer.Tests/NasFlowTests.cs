namespace SwimServer.Tests;

/// <summary>
/// The airport identifier the flow overlay joins on.
///
/// <para>TFDM publishes ICAO (<c>KLAS</c>) and TBFM the FAA LID (<c>LAS</c>), so joining them raw
/// matched almost nothing: LAS appeared twice — once with metering and no field data, once with
/// field data and no metering — which reads as two different airports rather than as a failed
/// join. Nothing errors, and both rows look perfectly plausible.</para>
/// </summary>
public class NasFlowTests
{
    [Theory]
    [InlineData("KLAS", "LAS")]
    [InlineData("klas", "LAS")]
    [InlineData(" KTEB ", "TEB")]
    [InlineData("LAS", "LAS")]
    public void AUsIcaoIdentifierBecomesItsFaaLid(string input, string expected)
        => Assert.Equal(expected, NasRoutes.Lid(input));

    /// <summary>
    /// <b>Only a leading K is stripped.</b> Taking the first letter off any four-character
    /// identifier would turn PANC into ANC and PHNL into HNL — Alaska and Hawaii use a different
    /// prefix and their LID is not the last three characters. Same rule TbfmDashboard applies.
    /// </summary>
    [Theory]
    [InlineData("PANC")]
    [InlineData("PHNL")]
    [InlineData("TJSJ")]
    [InlineData("CYYZ")]
    [InlineData("SBGL")]
    public void ANonKPrefixedIdentifierIsLeftAlone(string icao)
        => Assert.Equal(icao, NasRoutes.Lid(icao));

    [Theory]
    [InlineData("")]
    [InlineData("K")]
    [InlineData("KOA")]      // three letters: a LID that merely starts with K
    public void ShortIdentifiersAreNotMangled(string input)
        => Assert.Equal(input.Trim().ToUpperInvariant(), NasRoutes.Lid(input));
}
