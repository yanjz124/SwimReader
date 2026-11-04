using System.Text;
using System.Text.RegularExpressions;

namespace SwimServer.Tests;

/// <summary>
/// The frontends are classic scripts sharing one global object, and that has produced the same
/// bug three times: an identifier declared with <c>const</c>/<c>let</c>/<c>class</c> at the top
/// level of one script, read as <c>window.X</c> from another.
///
/// <para>A top-level <c>function</c> or <c>var</c> DOES become a property of the global object.
/// <c>const</c>, <c>let</c> and <c>class</c> do not — they live in the script's lexical scope. So
/// the two spellings silently refer to different things: unqualified <c>X</c> finds the
/// declaration (it shadows the global), <c>window.X</c> finds <c>undefined</c>.</para>
///
/// <para>What that cost, each time with no error and nothing in the log:</para>
/// <list type="bullet">
/// <item><c>starsState</c> — the six WX buttons did nothing and NEXRAD painted every intensity
/// level, because <c>nexrad.js</c> read <c>window.starsState?.wxLevels</c> and took its
/// <c>prefSet</c> fallback every frame.</item>
/// <item><c>mapButtonAssignments</c> — bound once at module load to an array both writers later
/// reassign, so <c>?profile=NAME</c> never applied its DCB map buttons at all.</item>
/// <item><c>dcb</c> — <c>preview.js</c> and <c>profile.js</c> reach it as <c>window.dcb</c> behind
/// truthiness guards, so the preview area's open-maps/open-brite actions never opened those
/// popouts and the DCB never re-rendered after a pref change.</item>
/// </list>
///
/// <para>A browser check cannot find these: the page loads, nothing throws, and the feature is
/// simply absent. ESLint cannot either — <c>window.dcb</c> is a valid member access on a declared
/// global. A scan is the only thing that sees it, so it is a test.</para>
///
/// <para>To satisfy it, publish the value deliberately: <c>window.X = X</c>, or
/// <c>Object.assign(window.X, {…})</c> when a pre-seeded container must stay the same object.</para>
/// </summary>
public class GlobalScopeContractTests
{
    // Anchored at line start: only top-level declarations shadow a global. An indented
    // `const` inside a function body is scoped to it and cannot collide.
    private static readonly Regex Lexical = new(
        @"^(?:const|let|class)\s+([A-Za-z_$][\w$]*)", RegexOptions.Multiline | RegexOptions.Compiled);

    private static readonly Regex WindowRead = new(
        @"window\.([A-Za-z_$][\w$]*)", RegexOptions.Compiled);

    // Every way the codebase puts a name on the global object.
    private static readonly Regex WindowWrite = new(
        """
        window\.([A-Za-z_$][\w$]*)\s*(?:=[^=]|\|\|=|\?\?=)
        |Object\.assign\(\s*window\.([A-Za-z_$][\w$]*)
        |Object\.defineProperty\(\s*window\s*,\s*["']([A-Za-z_$][\w$]*)["']
        """,
        RegexOptions.IgnorePatternWhitespace | RegexOptions.Compiled);

    // Inline <script> blocks only (a src= tag is a file we read separately).
    private static readonly Regex InlineScript = new(
        @"<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>",
        RegexOptions.Singleline | RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private static string WwwRoot()
    {
        var dir = AppContext.BaseDirectory;
        while (dir is not null && !File.Exists(Path.Combine(dir, "SwimReader.sln")))
            dir = Path.GetDirectoryName(dir);
        Assert.NotNull(dir);
        var root = Path.Combine(dir!, "tools", "SwimServer", "wwwroot");
        Assert.True(Directory.Exists(root), $"wwwroot not found at {root}");
        return root;
    }

    /// <summary>
    /// One page's global scope: its own scripts, the shared scripts every page loads, and the
    /// inline blocks in its HTML. Grouping per page matters — two pages may each declare
    /// <c>const state</c> without ever sharing a window.
    /// </summary>
    private static List<(string Name, string Source)> PageSources(string root, string page)
    {
        var sources = new List<(string, string)>();

        foreach (var dir in new[] { Path.Combine(root, page), Path.Combine(root, "shared") })
            if (Directory.Exists(dir))
                foreach (var f in Directory.GetFiles(dir, "*.js").OrderBy(f => f))
                    sources.Add((Path.GetFileName(f), File.ReadAllText(f)));

        var pageDir = Path.Combine(root, page);
        if (Directory.Exists(pageDir))
            foreach (var f in Directory.GetFiles(pageDir, "*.html").OrderBy(f => f))
                foreach (Match m in InlineScript.Matches(File.ReadAllText(f)))
                    sources.Add(($"{Path.GetFileName(f)} (inline)", m.Groups[1].Value));

        return sources;
    }

    [Fact]
    public void NoLexicalDeclarationIsReadThroughWindowWithoutBeingPublished()
    {
        var root = WwwRoot();
        var pages = Directory.GetDirectories(root)
            .Select(Path.GetFileName)
            .Where(d => d is not null && d != "shared")
            .OrderBy(d => d)
            .ToList();
        Assert.NotEmpty(pages);

        var failures = new StringBuilder();
        var scanned = 0;

        foreach (var page in pages)
        {
            var sources = PageSources(root, page!);
            if (sources.Count == 0) continue;

            var declaredIn = new Dictionary<string, string>(StringComparer.Ordinal);
            var readIn = new Dictionary<string, SortedSet<string>>(StringComparer.Ordinal);
            var published = new HashSet<string>(StringComparer.Ordinal);

            foreach (var (name, src) in sources)
            {
                scanned++;
                foreach (Match m in Lexical.Matches(src))
                    declaredIn.TryAdd(m.Groups[1].Value, name);

                foreach (Match m in WindowRead.Matches(src))
                {
                    if (!readIn.TryGetValue(m.Groups[1].Value, out var set))
                        readIn[m.Groups[1].Value] = set = new SortedSet<string>(StringComparer.Ordinal);
                    set.Add(name);
                }

                foreach (Match m in WindowWrite.Matches(src))
                    for (var g = 1; g <= 3; g++)
                        if (m.Groups[g].Success) published.Add(m.Groups[g].Value);
            }

            foreach (var (name, file) in declaredIn.OrderBy(kv => kv.Key, StringComparer.Ordinal))
            {
                if (published.Contains(name)) continue;
                if (!readIn.TryGetValue(name, out var readers)) continue;

                failures.AppendLine(
                    $"  {page}: '{name}' is declared top-level in {file} (const/let/class, so NOT a " +
                    $"window property) but read as window.{name} in {string.Join(", ", readers)} — " +
                    $"those are two different values. Publish it: window.{name} = {name};");
            }
        }

        Assert.True(scanned > 0, "scanned no sources — the layout must have moved");
        Assert.True(failures.Length == 0,
            $"Global-scope collisions (see GlobalScopeContractTests for why this is a test):\n{failures}");
    }

    /// <summary>
    /// Guards the scanner itself: it has to still flag the bug it was written for. Without this a
    /// regex typo turns the whole check into a no-op that passes forever — the same way the
    /// cache-buster quietly stopped matching anything.
    /// </summary>
    [Fact]
    public void ScannerStillCatchesTheKnownBugShape()
    {
        const string declaring = "const starsState = { wxLevels: [] };\n";
        const string reading = "if (window.starsState.wxLevels) draw();\n";

        var declared = Lexical.Matches(declaring).Select(m => m.Groups[1].Value).ToList();
        Assert.Contains("starsState", declared);
        Assert.Contains("starsState", WindowRead.Matches(reading).Select(m => m.Groups[1].Value));
        Assert.Empty(WindowWrite.Matches(declaring + reading));

        // And the two accepted ways of publishing must register as a fix.
        Assert.Contains("starsState", WindowWrite.Matches("window.starsState = starsState;")
            .Select(m => m.Groups[1].Value));
        Assert.Contains("starsState", WindowWrite.Matches("const s = Object.assign(window.starsState, {});")
            .Select(m => m.Groups[2].Value));

        // An equality test is a read, not a publication.
        Assert.Empty(WindowWrite.Matches("if (window.starsState == null) init();"));
        // An indented declaration is function-scoped and must not be collected.
        Assert.Empty(Lexical.Matches("  const starsState = 1;"));
    }
}
