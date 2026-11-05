using Microsoft.AspNetCore.Http;

namespace SwimServer.Tests;

/// <summary>
/// The operator gate: who may read <c>/api/feed</c>, <c>/api/feed/stdds</c>, <c>/api/system</c>
/// and <c>/api/storage</c>, and therefore who sees the home page's SYSTEM group.
///
/// <para>The case worth a test is the <b>loopback</b> one. This process runs behind a Cloudflare
/// tunnel whose connector dials 127.0.0.1 and there is no <c>UseForwardedHeaders</c> in the
/// pipeline, so <c>RemoteIpAddress</c> is loopback for every public request. A gate written as
/// "reveal cookie OR loopback" would therefore let the entire internet through while reading as
/// a careful local-access carve-out, and nothing about the deployment would look wrong. Requiring
/// the absence of the proxy's own headers is what makes "local" mean local, and it is the half
/// that a future refactor is most likely to drop.</para>
/// </summary>
public class OperatorViewTests
{
    private const string Key = "test-bypass-key";

    private static HttpContext Req(string ip, params string[] headers)
    {
        var c = new DefaultHttpContext();
        c.Connection.RemoteIpAddress = System.Net.IPAddress.Parse(ip);
        for (var i = 0; i + 1 < headers.Length; i += 2) c.Request.Headers[headers[i]] = headers[i + 1];
        return c;
    }

    /// <summary>Signed in — the cookie <c>/login</c> sets. Location is then irrelevant.</summary>
    [Fact]
    public void RevealCookieIsTheOperator()
    {
        Assert.True(LaddService.OperatorView(CookieCtx(Key, "203.0.113.9", "CF-Connecting-IP"), Key));
    }

    /// <summary>
    /// No LADD_BYPASS_KEY means there is no way to sign in at all, so gating on the sign-in would
    /// hide this from the owner of a local or LAN deployment with no route back in. Unset = open,
    /// the same convention <c>SWIM_FEED_HOST</c> and <c>SWIM_GATE_HOST</c> use.
    /// </summary>
    [Fact]
    public void NoKeyConfiguredMeansOpen()
    {
        Assert.True(LaddService.OperatorView(Req("203.0.113.9", "CF-Connecting-IP", "203.0.113.9"), null));
        Assert.True(LaddService.OperatorView(Req("203.0.113.9"), ""));
    }

    /// <summary>A plain remote visitor, key configured: the whole point of the change.</summary>
    [Fact]
    public void RemoteVisitorIsNotTheOperator()
    {
        Assert.False(LaddService.OperatorView(Req("203.0.113.9"), Key));
    }

    /// <summary>
    /// On the box, unproxied: open, because <c>curl</c> against these endpoints is the documented
    /// way to check feed health and anyone who can run it can already read <c>.env</c>.
    /// </summary>
    [Fact]
    public void LoopbackUnproxiedIsTheOperator()
    {
        Assert.True(LaddService.OperatorView(Req("127.0.0.1"), Key));
        Assert.True(LaddService.OperatorView(Req("::1"), Key));
    }

    /// <summary>
    /// THE one that matters: a tunneled public request arrives from 127.0.0.1. Any header that
    /// says a proxy forwarded it disqualifies the loopback carve-out — otherwise the gate is a
    /// no-op for every visitor and looks fine.
    /// </summary>
    [Theory]
    [InlineData("CF-Connecting-IP", "203.0.113.9")]
    [InlineData("CF-Ray", "8b0c0000000000-IAD")]
    [InlineData("CF-Visitor", "{\"scheme\":\"https\"}")]
    [InlineData("X-Forwarded-For", "203.0.113.9")]
    [InlineData("X-Forwarded-Proto", "https")]
    [InlineData("X-Forwarded-Host", "swim.example.org")]
    [InlineData("X-Real-IP", "203.0.113.9")]
    [InlineData("Forwarded", "for=203.0.113.9")]
    public void LoopbackViaAProxyIsNotTheOperator(string header, string value)
    {
        Assert.False(LaddService.OperatorView(Req("127.0.0.1", header, value), Key));
    }

    /// <summary>But a signed-in request through the tunnel still gets through.</summary>
    [Fact]
    public void SignedInThroughTheTunnelIsTheOperator()
    {
        Assert.True(LaddService.OperatorView(CookieCtx(Key, "127.0.0.1", "CF-Connecting-IP"), Key));
    }

    /// <summary>A wrong key is not a key.</summary>
    [Fact]
    public void WrongCookieValueIsNotTheOperator()
    {
        Assert.False(LaddService.OperatorView(CookieCtx("nope", "203.0.113.9"), Key));
    }

    /// <summary>
    /// A request with the <c>laddKey</c> cookie set, optionally marked as proxied. Built through
    /// the Cookie header because that is how <c>Request.Cookies</c> is populated.
    /// </summary>
    private static HttpContext CookieCtx(string cookieValue, string ip, string? proxyHeader = null)
    {
        var c = new DefaultHttpContext();
        c.Connection.RemoteIpAddress = System.Net.IPAddress.Parse(ip);
        c.Request.Headers["Cookie"] = $"laddKey={cookieValue}";
        if (proxyHeader is not null) c.Request.Headers[proxyHeader] = "203.0.113.9";
        return c;
    }
}

/// <summary>
/// The presentation half. The server gate above is what protects the data; this pins that the
/// home page actually hides the cards, because a visitor seeing three cards that only ever 403
/// would read as the site being broken rather than as a private section.
/// </summary>
public class HomeOperatorSectionTests
{
    private static string Www()
    {
        var dir = AppContext.BaseDirectory;
        while (dir is not null && !File.Exists(Path.Combine(dir, "SwimReader.sln")))
            dir = Path.GetDirectoryName(dir);
        Assert.NotNull(dir);
        return Path.Combine(dir!, "tools", "SwimServer", "wwwroot");
    }

    [Fact]
    public void SystemGroupCarriesTheIdTheCssHidesOn()
    {
        var html = File.ReadAllText(Path.Combine(Www(), "home", "index.html"));
        Assert.Contains("id=\"systemGroup\"", html);
        // The three cards it holds, so renaming one does not quietly leave it outside the group.
        foreach (var id in new[] { "throughputCard", "storageCard", "serverCard" })
            Assert.Contains($"id=\"{id}\"", html);
    }

    /// <summary>
    /// Written as <c>html:not(.op-signed)</c> rather than hide-then-restore so that neither rule
    /// has to know what display value these elements would otherwise have — and so a visitor is
    /// never shown the group for a frame while the deferred frame.js runs.
    /// </summary>
    [Fact]
    public void CssHidesTheGroupAndTheServerChipWithoutTheSignedInClass()
    {
        var css = File.ReadAllText(Path.Combine(Www(), "home", "home.css"));
        Assert.Matches(@"html:not\(\.op-signed\)\s*#systemGroup", css);
        Assert.Matches(@"html:not\(\.op-signed\)\s*#serverStat", css);
    }

    /// <summary>
    /// frame.js is the only thing that sets <c>.op-signed</c>, from the non-secret <c>sv</c>
    /// cookie. If that disappears the CSS above hides the group from everyone, permanently.
    /// </summary>
    [Fact]
    public void FrameJsStillPublishesTheSignedInClass()
    {
        var js = File.ReadAllText(Path.Combine(Www(), "shared", "frame.js"));
        Assert.Contains("op-signed", js);
        Assert.Contains("hasCookie('sv')", js);
    }

    /// <summary>
    /// The home page must load frame.js, or nothing ever adds the class. Serving home/index.html
    /// is a raw SendFileAsync with no stamping, so the query version here is the real cache key —
    /// a stale one is how a shipped change fails to arrive (see AssetVersionTests).
    /// </summary>
    [Fact]
    public void HomeLoadsFrameJs()
    {
        var html = File.ReadAllText(Path.Combine(Www(), "home", "index.html"));
        Assert.Matches(@"src=""/shared/frame\.js\?v=\d+""", html);
    }
}
