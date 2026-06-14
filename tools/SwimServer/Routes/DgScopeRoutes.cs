namespace SwimServer;

/// <summary>
/// Reverse proxy: /dstars/* → SwimReader.Server (port 5000) for DGScope clients.
/// SwimServer fronts DGScope's HTTP-stream/WebSocket interface so external users only
/// need one Cloudflare tunnel hostname for both feeds.
/// </summary>
static class DgScopeRoutes
{
    public static void Register(WebApplication app, ServerContext ctx)
    {
        // Landing/directory page for DGScope users. The literal "/dstars" route is more
        // specific than the "/dstars/{**rest}" proxy below, so it wins for the bare path.
        app.MapGet("/dstars", async (HttpContext c) =>
        {
            c.Response.ContentType = "text/html";
            await c.Response.SendFileAsync(Path.Combine(ctx.WebRootPath, "dstars", "directory.html"));
        });

        app.Map("/dstars/{**rest}", async (HttpContext c, string rest) =>
        {
            var targetUrl = $"http://127.0.0.1:5000/dstars/{rest}";
            if (c.Request.QueryString.HasValue)
                targetUrl += c.Request.QueryString.Value;

            using var httpClient = new HttpClient();
            var request = new HttpRequestMessage(HttpMethod.Get, targetUrl);

            var response = await httpClient.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, c.RequestAborted);

            c.Response.StatusCode = (int)response.StatusCode;
            foreach (var header in response.Content.Headers)
                c.Response.Headers[header.Key] = header.Value.ToArray();
            c.Response.Headers.Remove("transfer-encoding");
            c.Response.ContentType = response.Content.Headers.ContentType?.ToString() ?? "application/json";

            // Stream the response body through (supports HTTP streaming / chunked)
            await using var stream = await response.Content.ReadAsStreamAsync(c.RequestAborted);
            await stream.CopyToAsync(c.Response.Body, c.RequestAborted);
        });
    }
}
