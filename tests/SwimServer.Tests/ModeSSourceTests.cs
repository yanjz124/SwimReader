namespace SwimServer.Tests;

/// <summary>
/// Pins where SFDPS's Mode S address actually comes from.
///
/// FIXM documents it as <c>aircraftDescription/@aircraftAddress</c>, and that is what this parser
/// read for its whole life. On the live NAS feed that attribute is simply never populated:
/// measured 0 of 8,863 positioned flights carrying a ModeSCode, while the supplementalData
/// nameValue <c>ADSB_02M_52B</c> — the hex prefixed with a hyphen, "-AD9003" — was the single most
/// common key in the entire feed at 399,198 occurrences.
///
/// Nothing failed. The field was in the model, in the WS payload and in the LADD masking call;
/// it was just always null, which reads identically to "this aircraft has no Mode S code". The
/// cost was correlation: an exact Mode S match needs no distance gate and cannot be ambiguous,
/// and 21.7% of untagged TRACON targets carry a Mode S code with a non-discrete squawk, so
/// nothing else can name them at all.
///
/// Source-text assertions, for the same reason as FixmContractTests: ProcessFlight is a local
/// function in top-level Program.cs. Crude, but aimed squarely at what breaks this — someone
/// tidying away a parse that looks redundant next to the documented one.
/// </summary>
public class ModeSSourceTests
{
    private static string ProgramSource()
    {
        var dir = AppContext.BaseDirectory;
        while (dir is not null && !File.Exists(Path.Combine(dir, "SwimReader.sln")))
            dir = Path.GetDirectoryName(dir);
        Assert.NotNull(dir);
        var path = Path.Combine(dir!, "tools", "SwimServer", "Program.cs");
        Assert.True(File.Exists(path), $"Program.cs not found at {path}");
        return File.ReadAllText(path);
    }

    [Fact]
    public void ModeSIsReadFromTheAdsbNameValue()
    {
        var src = ProgramSource();
        // Anchor on the CODE, not the first mention: the explanatory comment above the parse
        // names the key too, so a plain IndexOf finds the prose and proves nothing.
        var i = src.IndexOf("name == \"ADSB_02M_52B\"", StringComparison.Ordinal);
        Assert.True(i > 0, "no `name == \"ADSB_02M_52B\"` branch in ProcessFlight");
        // ...and it must still assign ModeSCode, not merely be counted as a seen key.
        var window = src.Substring(i, Math.Min(600, src.Length - i));
        Assert.Contains("state.ModeSCode", window);
    }

    [Fact]
    public void TheDocumentedButEmptyAttributeIsStillReadAsAFallback()
    {
        // Keep it: it costs nothing and it is what the standard says. The bug was never that
        // reading it was wrong, only that it was the ONLY thing read.
        Assert.Contains("aircraftAddress", ProgramSource());
    }

    [Theory]
    [InlineData("-AD9003", "AD9003")]   // the live shape: hyphen-prefixed hex
    [InlineData("AD9003", "AD9003")]    // tolerate the same value unprefixed
    [InlineData("-a1b2c3", "A1B2C3")]   // normalized upper, so hex keys compare
    [InlineData("-D9003", "0D9003")]    // short values left-padded to the full 24 bits
    public void HexNormalization(string raw, string expected)
    {
        Assert.Equal(expected, Normalize(raw));
    }

    [Theory]
    [InlineData("-")]            // prefix with nothing after it
    [InlineData("")]
    [InlineData("-ZZZZZZ")]      // not hex
    [InlineData("-AD90034")]     // too long for a 24-bit address
    [InlineData("-123")]         // too short to be a real address
    public void JunkIsRejectedRatherThanStored(string raw)
    {
        Assert.Null(Normalize(raw));
    }

    /// <summary>Mirror of the parse in ProcessFlight. Kept in step by the two tests above, which
    /// assert the real one still exists and still writes ModeSCode.</summary>
    private static string? Normalize(string val)
    {
        var hex = val.TrimStart('-').Trim();
        if (hex.Length is >= 5 and <= 6 && hex.All(char.IsAsciiHexDigit))
            return hex.ToUpperInvariant().PadLeft(6, '0');
        return null;
    }
}
