using System.Text.RegularExpressions;

namespace SwimServer.Tests;

/// <summary>
/// Two replay rules a browser cannot check, both of which shipped broken and neither of which
/// threw, logged, or moved a counter.
///
/// <para><b>1. Track ageing must measure RECORDED time, not wall-clock.</b> The scope hides a
/// track that has not reported for <c>LOST_TARGET_MS</c> (30 s), coasts it at 24 s, ticks its
/// history and purges it at 120 s. Live, wall-clock is the right clock. During a replay it is
/// not: the replay clock runs at the chosen speed and stops dead on a pause. Measured against
/// <c>Date.now()</c>, pausing a replay blanked the entire scope exactly 30 s later — reported as
/// "the replay only plays 30 seconds" — and a 10x replay held dead targets ten times too long.
/// A clean browser reproduces this only if you happen to pause and then wait half a minute.</para>
///
/// <para><b>2. <c>history.replaceState</c> under a <c>&lt;base&gt;</c> tag must be given an
/// ABSOLUTE path.</b> <c>scope.html</c> carries <c>&lt;base href="/stars/"&gt;</c>, and
/// replaceState resolves a relative URL against the BASE, not the document. So the replay bar
/// parking its position as a bare <c>"#replay=…"</c> rewrote
/// <c>/stars/ZNY/N90?r=20&amp;tcp=2A</c> to <c>/stars/#replay=…</c> — facility and every display
/// param gone. The running page carried on (it had already read them), so nothing looked wrong
/// until a reload landed on the picker.</para>
/// </summary>
public class ReplayClockContractTests
{
    private static string WwwRoot()
    {
        var dir = AppContext.BaseDirectory;
        while (dir is not null && !File.Exists(Path.Combine(dir, "SwimReader.sln")))
            dir = Path.GetDirectoryName(dir);
        Assert.NotNull(dir);
        return Path.Combine(dir!, "tools", "SwimServer", "wwwroot");
    }

    private static string Read(params string[] parts) => File.ReadAllText(Path.Combine(WwwRoot(), Path.Combine(parts)));

    // Line comments only — a commented-out `t._lastHistoryT = Date.now()` is not a live site.
    private static string StripLineComments(string src) =>
        Regex.Replace(src, @"^\s*//.*$", "", RegexOptions.Multiline);

    /// <summary>Anything that ages a track reads <c>scopeNow()</c>, which is <c>Date.now()</c> only when live.</summary>
    [Fact]
    public void TrackAgeingNeverReadsTheWallClock()
    {
        var lines = StripLineComments(Read("stars", "scope.js")).Split('\n');
        // The identifiers that mean "how long since this track reported".
        var ageing = new Regex(@"lastUpdate|lastPosUpdate|lastMoveT|_lastHistoryT|LOST_TARGET_MS");
        var offenders = new List<string>();

        for (var i = 0; i < lines.Length; i++)
        {
            if (!lines[i].Contains("Date.now()")) continue;
            // `const now = Date.now()` is three lines above the comparison that uses it, so the
            // window has to reach past the declaration itself.
            var from = Math.Max(0, i - 2);
            var to = Math.Min(lines.Length - 1, i + 4);
            var window = string.Join('\n', lines[from..(to + 1)]);
            if (ageing.IsMatch(window)) offenders.Add($"scope.js:{i + 1}: {lines[i].Trim()}");
        }

        Assert.True(offenders.Count == 0,
            "Track ageing must use scopeNow(), not Date.now() — during a replay the two are different "
            + "clocks and the wall one blanks the scope 30 s after a pause:\n  " + string.Join("\n  ", offenders));
    }

    [Fact]
    public void ScopeDefinesTheRadarClockAndTheBarExposesIt()
    {
        // Both halves, because either one alone silently degrades to the wall clock: scopeNow()
        // falls back to Date.now() when clockMs() is absent, which is exactly the old behaviour.
        Assert.Matches(@"function scopeNow\(\)", Read("stars", "scope.js"));
        Assert.Contains("window.ReplayBar?.clockMs?.()", Read("stars", "scope.js"));
        Assert.Matches(@"clockMs\(\)\s*\{", Read("shared", "replay-bar.js"));
    }

    /// <summary>A page with <c>&lt;base&gt;</c> makes every relative URL resolve somewhere else.</summary>
    [Fact]
    public void ReplaceStateIsNeverGivenARelativeUrlOnAPageWithABase()
    {
        var root = WwwRoot();
        // Only pages carrying <base> are affected, so scan exactly the scripts they load: their
        // own directory, plus shared/ which every page pulls in.
        var dirs = Directory.EnumerateFiles(root, "*.html", SearchOption.AllDirectories)
            .Where(f => File.ReadAllText(f).Contains("<base "))
            .Select(f => Path.GetDirectoryName(f)!)
            .Append(Path.Combine(root, "shared"))
            .Distinct().ToList();
        Assert.Contains(dirs, d => Path.GetFileName(d) == "stars");   // the page this bit

        var call = new Regex(@"history\.(?:replace|push)State\s*\([^,]*,[^,]*,\s*([^;]*?)\)\s*;");
        var ident = new Regex(@"^[A-Za-z_$][\w$]*$");
        var offenders = new List<string>();
        foreach (var dir in dirs)
        foreach (var f in Directory.EnumerateFiles(dir, "*.js"))
        {
            var src = StripLineComments(File.ReadAllText(f));
            foreach (Match m in call.Matches(src))
            {
                var arg = m.Groups[1].Value.Trim();
                // A bare identifier is the common shape — resolve it to its assignment.
                if (ident.IsMatch(arg))
                {
                    var decl = Regex.Match(src, @"(?:const|let|var)\s+" + Regex.Escape(arg) + @"\s*=\s*([^;]*);");
                    if (decl.Success) arg = decl.Groups[1].Value.Trim();
                }
                var ok = arg.StartsWith("location.pathname") || arg.StartsWith("location.href")
                      || arg.StartsWith("location.origin") || arg.StartsWith("u.pathname")
                      || arg.StartsWith("\"/") || arg.StartsWith("'/") || arg.StartsWith("`/");
                if (!ok) offenders.Add(Path.GetRelativePath(root, f) + ": " + arg);
            }
        }

        Assert.True(offenders.Count == 0,
            "replaceState/pushState resolves a RELATIVE url against the page's <base>, so a bare "
            + "\"#...\" throws the facility and every display param out of the URL. Build it from "
            + "location.pathname:\n  " + string.Join("\n  ", offenders));
    }
}
