namespace SwimServer.Tests;

/// <summary>
/// The STARS pages stamp a cache-buster derived from the newest asset mtime. The original pattern
/// required the closing quote immediately after <c>.js</c>, so a tag that already carried a
/// hand-written version (<c>scope.js?v=68</c>, which every tag in scope.html did) matched nothing
/// and the rewrite silently did nothing. That URL then never changed, so a warm browser cache kept
/// serving old JavaScript and shipped fixes appeared not to work.
///
/// A fresh headless browser cannot catch this — it has no cache, so it loads whatever the HTML
/// says and the page behaves correctly. Hence a unit test on the emitted tag.
/// </summary>
public class AssetVersionTests
{
    [Fact]
    public void RestampsATagThatAlreadyHasAVersion()
    {
        var html = "<script src=\"scope.js?v=68\"></script>";
        Assert.Equal("<script src=\"scope.js?v=999\"></script>", AssetVersion.Stamp(html, 999));
    }

    [Fact]
    public void StampsATagWithNoVersion()
    {
        var html = "<script src=\"scope.js\"></script>";
        Assert.Equal("<script src=\"scope.js?v=999\"></script>", AssetVersion.Stamp(html, 999));
    }

    /// <summary>`[\w.-]` has no slash, so rooted shared assets were never stamped at all.</summary>
    [Fact]
    public void StampsRootedAndNestedPaths()
    {
        var html = "<link rel=\"stylesheet\" href=\"/shared/replay-bar.css?v=4\" />"
                 + "<script src=\"/shared/disclaimer.js\"></script>";
        var outp = AssetVersion.Stamp(html, 7);
        Assert.Contains("/shared/replay-bar.css?v=7", outp);
        Assert.Contains("/shared/disclaimer.js?v=7", outp);
    }

    /// <summary>
    /// An absolute URL must be left alone — rewriting a CDN link would break it. The character
    /// class excludes ':' so "https://…" cannot match.
    /// </summary>
    [Fact]
    public void LeavesAbsoluteUrlsAlone()
    {
        var html = "<script src=\"https://cdn.example.com/lib/thing.js\"></script>";
        Assert.Equal(html, AssetVersion.Stamp(html, 999));
    }

    [Fact]
    public void LeavesNonAssetReferencesAlone()
    {
        var html = "<a href=\"/stars/zma/pbi\">x</a><img src=\"logo.png\">";
        Assert.Equal(html, AssetVersion.Stamp(html, 999));
    }

    /// <summary>
    /// The real page, as shipped: every tag carries a hand-written version. Each must come back
    /// stamped with the server's number, since that is the exact case the old pattern missed.
    /// </summary>
    [Fact]
    public void StampsEveryAssetInTheRealScopeHtml()
    {
        var dir = AppContext.BaseDirectory;
        while (dir is not null && !File.Exists(Path.Combine(dir, "SwimReader.sln")))
            dir = Path.GetDirectoryName(dir);
        Assert.NotNull(dir);
        var path = Path.Combine(dir!, "tools", "SwimServer", "wwwroot", "stars", "scope.html");
        Assert.True(File.Exists(path), $"scope.html not found at {path}");

        var stamped = AssetVersion.Stamp(File.ReadAllText(path), 12345);

        // Nothing may keep an old version, and scope.js in particular must be re-stamped.
        Assert.DoesNotContain("scope.js?v=68", stamped);
        Assert.Contains("scope.js?v=12345", stamped);
        Assert.Contains("dcb.js?v=12345", stamped);
        Assert.Contains("nexrad.js?v=12345", stamped);
        Assert.Contains("scope.css?v=12345", stamped);
        Assert.Contains("/shared/replay-bar.css?v=12345", stamped);
    }
}
