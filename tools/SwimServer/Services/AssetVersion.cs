using System.Text.RegularExpressions;

namespace SwimServer;

/// <summary>
/// Rewrites the <c>?v=</c> cache-buster on a page's own script/style tags so a deployed asset
/// change actually reaches a returning browser.
///
/// <para><b>Why this is its own class with a test.</b> The STARS pages computed a version from the
/// newest asset mtime and stamped it in with this pattern:</para>
/// <code>(src|href)="([\w.-]+\.(?:js|css))"</code>
/// <para>which requires the closing quote <i>immediately</i> after <c>.js</c>/<c>.css</c>. Every
/// tag in <c>scope.html</c> already carried a hand-maintained version — <c>scope.js?v=68</c> — so
/// the pattern matched nothing and the rewrite was a no-op. The page kept serving the literal
/// <c>?v=68</c>, and because that URL never changed, **every edit to scope.js was invisible to any
/// browser that had already loaded it.** Fixes shipped, verified, and then "didn't work" for the
/// one person whose cache was warm.</para>
///
/// <para>It also missed <c>/shared/replay-bar.css</c> and friends outright: <c>[\w.-]</c> has no
/// <c>/</c>, so rooted paths were never stamped at all.</para>
///
/// <para><b>The trap worth naming:</b> a fresh headless browser has an empty cache, so it fetches
/// whatever the HTML says and shows the new behavior. Browser-based verification therefore
/// *cannot* detect this class of bug — it looks like a pass every time. Check the emitted tag, not
/// just the rendered result.</para>
/// </summary>
internal static class AssetVersion
{
    // Local assets only, with or without an existing query string:
    //   src="scope.js"            href="scope.css?v=4"       src="/shared/disclaimer.js?v=2"
    // The class excludes ':' so an absolute https:// URL can never match, and the optional
    // (\?[^"]*)? is what lets an already-stamped tag be re-stamped instead of skipped.
    private static readonly Regex Tag = new(
        "(src|href)=\"(/?(?:[\\w.-]+/)*[\\w.-]+\\.(?:js|css))(\\?[^\"]*)?\"",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    /// <summary>
    /// Replace every local .js/.css version in <paramref name="html"/> with <paramref name="ver"/>,
    /// discarding whatever query the tag carried. The served version is therefore always the
    /// newest asset mtime, and the numbers written in the HTML are inert — which is the point:
    /// nobody has to remember to bump them, and forgetting can no longer serve stale code.
    /// </summary>
    public static string Stamp(string html, long ver) =>
        Tag.Replace(html, m => $"{m.Groups[1].Value}=\"{m.Groups[2].Value}?v={ver}\"");
}
