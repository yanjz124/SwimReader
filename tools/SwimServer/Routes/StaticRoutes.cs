namespace SwimServer;

/// <summary>
/// Static page handlers and legacy ".html → clean URL" redirects.
///
/// The feature pages that share routes with WebSocket endpoints (asdex, tdls, tais)
/// stay in their feature-specific Routes file because route registration order
/// matters (literal "/foo/ws/{x}" must register before parameter "/foo/{x}" so
/// ASP.NET Core gives the literal segment priority).
/// </summary>
static class StaticRoutes
{
    public static void Register(WebApplication app, ServerContext ctx)
    {
        // Legacy .html redirects — old bookmarks/links still work
        app.MapGet("/eram.html", (HttpContext c) => Results.Redirect($"/eram{c.Request.QueryString}", permanent: true));
        app.MapGet("/asdex.html", (HttpContext c) => Results.Redirect($"/asdex{c.Request.QueryString}", permanent: true));
        app.MapGet("/asdex-airport.html", (HttpContext c) => Results.Redirect($"/asdex{c.Request.QueryString}", permanent: true));
        app.MapGet("/tdls.html", (HttpContext c) => Results.Redirect($"/tdls{c.Request.QueryString}", permanent: true));
        app.MapGet("/tdls-airport.html", (HttpContext c) => Results.Redirect($"/tdls{c.Request.QueryString}", permanent: true));
        app.MapGet("/tais.html", (HttpContext c) => Results.Redirect($"/tais{c.Request.QueryString}", permanent: true));
        app.MapGet("/tais-facility.html", (HttpContext c) => Results.Redirect($"/tais{c.Request.QueryString}", permanent: true));
        app.MapGet("/dstars.html", (HttpContext c) => Results.Redirect($"/dstars{c.Request.QueryString}", permanent: true));
        app.MapGet("/tfm.html", (HttpContext c) => Results.Redirect($"/tfm{c.Request.QueryString}", permanent: true));
        app.MapGet("/tfm-flow.html", (HttpContext c) => Results.Redirect($"/tfm/flow{c.Request.QueryString}", permanent: true));
        app.MapGet("/tfm-route.html", (HttpContext c) => Results.Redirect($"/tfm/route{c.Request.QueryString}", permanent: true));
        app.MapGet("/tfm-sectors.html", (HttpContext c) => Results.Redirect($"/tfm/sectors{c.Request.QueryString}", permanent: true));
        app.MapGet("/flight-table.html", (HttpContext c) => Results.Redirect($"/flight-table{c.Request.QueryString}", permanent: true));
        app.MapGet("/home.html", (HttpContext c) => Results.Redirect($"/{c.Request.QueryString}", permanent: true));
        app.MapGet("/index.html", (HttpContext c) => Results.Redirect($"/flight-table{c.Request.QueryString}", permanent: true));

        // Home page
        app.MapGet("/", async (HttpContext c) =>
        {
            c.Response.ContentType = "text/html";
            await c.Response.SendFileAsync(Path.Combine(ctx.WebRootPath, "home", "index.html"));
        });

        // ERAM clean URLs: /eram is the facility+sector picker landing page;
        // /eram/scope is the actual radar scope. Landing writes the picked
        // facility + sectors to localStorage "eram-settings" before
        // navigating, so the scope picks them up via its existing load path.
        app.MapGet("/eram", async (HttpContext c) =>
        {
            c.Response.ContentType = "text/html";
            await c.Response.SendFileAsync(Path.Combine(ctx.WebRootPath, "eram", "index.html"));
        });
        app.MapGet("/eram/scope", async (HttpContext c) =>
        {
            c.Response.ContentType = "text/html";
            await c.Response.SendFileAsync(Path.Combine(ctx.WebRootPath, "eram", "scope.html"));
        });

        // Flight table & TFM clean URLs (non-parameterized — safe to register here)
        app.MapGet("/flight-table", async (HttpContext c) =>
        {
            c.Response.ContentType = "text/html";
            await c.Response.SendFileAsync(Path.Combine(ctx.WebRootPath, "flight-table", "index.html"));
        });

        // Flight-sim route finder (dispatch)
        app.MapGet("/dispatch", async (HttpContext c) =>
        {
            c.Response.ContentType = "text/html";
            await c.Response.SendFileAsync(Path.Combine(ctx.WebRootPath, "dispatch", "index.html"));
        });

        // Track a single flight (mobile) — /track and /track/{callsign}
        app.MapGet("/track", async (HttpContext c) =>
        {
            c.Response.ContentType = "text/html";
            await c.Response.SendFileAsync(Path.Combine(ctx.WebRootPath, "track", "index.html"));
        });
        // Constrain to alphanumeric so static assets like /track/track.js (has a dot) are NOT
        // swallowed by this deep-link route and are served as files instead.
        app.MapGet("/track/{callsign:regex(^[A-Za-z0-9]+$)}", async (HttpContext c) =>
        {
            c.Response.ContentType = "text/html";
            await c.Response.SendFileAsync(Path.Combine(ctx.WebRootPath, "track", "index.html"));
        });

        // SFDPS sector activity page
        app.MapGet("/sectors", async (HttpContext c) =>
        {
            c.Response.ContentType = "text/html";
            await c.Response.SendFileAsync(Path.Combine(ctx.WebRootPath, "sectors", "index.html"));
        });

        app.MapGet("/tfm", async (HttpContext c) =>
        {
            c.Response.ContentType = "text/html";
            await c.Response.SendFileAsync(Path.Combine(ctx.WebRootPath, "tfm", "index.html"));
        });

        app.MapGet("/tfm/route", async (HttpContext c) =>
        {
            c.Response.ContentType = "text/html";
            await c.Response.SendFileAsync(Path.Combine(ctx.WebRootPath, "tfm", "route.html"));
        });

        app.MapGet("/tfm/sectors", async (HttpContext c) =>
        {
            c.Response.ContentType = "text/html";
            await c.Response.SendFileAsync(Path.Combine(ctx.WebRootPath, "tfm", "sectors.html"));
        });

        // FIDO page intentionally unwired — keep files in wwwroot/tfm/fido.* for future work
        // app.MapGet("/tfm/fido", async (HttpContext c) =>
        // {
        //     c.Response.ContentType = "text/html";
        //     await c.Response.SendFileAsync(Path.Combine(ctx.WebRootPath, "tfm", "fido.html"));
        // });

        app.MapGet("/tfm/aptc", async (HttpContext c) =>
        {
            c.Response.ContentType = "text/html";
            await c.Response.SendFileAsync(Path.Combine(ctx.WebRootPath, "tfm", "aptc.html"));
        });

        // EDCT (Expected Departure Clearance Times) page
        app.MapGet("/edct", async (HttpContext c) =>
        {
            c.Response.ContentType = "text/html";
            await c.Response.SendFileAsync(Path.Combine(ctx.WebRootPath, "edct", "index.html"));
        });

        app.MapGet("/tfm/flow", async (HttpContext c) =>
        {
            c.Response.ContentType = "text/html";
            await c.Response.SendFileAsync(Path.Combine(ctx.WebRootPath, "tfm", "flow.html"));
        });
    }
}
