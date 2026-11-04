using System.Text.RegularExpressions;

namespace SwimServer.Tests;

/// <summary>
/// Guards the FIXM attribute names SFDPS puts on the wire against well-meaning edits.
///
/// These are an external contract. FIXM is an international standard and spells the publishing
/// ARTCC attribute <c>centre</c>; our house style is American and spells the word "center"
/// everywhere else. That collision is not hypothetical: commit 6fa43a6 swept the repo for British
/// spellings and renamed <c>flight.Attribute("centre")</c> to <c>"center"</c> — and rewrote the
/// comment that warned against exactly that, so the warning deleted itself.
///
/// Nothing threw. <c>XElement.Attribute</c> returns null for a name that isn't there, the code
/// coalesced to "", <c>ComputerIds</c> was never populated for any flight, and every CID
/// disappeared from the ERAM scope whenever a facility was selected (the normal way to use it).
/// The scalar <c>ComputerId</c> kept working, so "All" looked fine and the failure read like a
/// display bug.
///
/// ProcessFlight is a local function inside top-level Program.cs and can't be called from here,
/// so this asserts on the source text. That is crude but it is aimed at the thing that actually
/// breaks this — a blanket find/replace — and it fails loudly in CI instead of silently on the
/// scope.
/// </summary>
public class FixmContractTests
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
    public void PublishingCentre_UsesFixmBritishSpelling()
    {
        var src = ProgramSource();

        Assert.Contains("flight.Attribute(\"centre\")", src);

        // The American spelling as a FIXM attribute name never matches anything on the wire.
        Assert.DoesNotContain("flight.Attribute(\"center\")", src);
    }

    /// <summary>
    /// The per-ARTCC CID map is keyed by that attribute, so if the read above ever yields "" the
    /// map stays empty and the scope shows no CIDs. Pin the two lines together: a change that
    /// stops keying on the publishing centre should have to acknowledge this test.
    /// </summary>
    [Fact]
    public void ComputerIds_AreKeyedByPublishingCentre()
    {
        var src = ProgramSource();
        Assert.Matches(new Regex(@"state\.ComputerIds\[\s*center\s*\]\s*=\s*cid", RegexOptions.None), src);
    }
}
