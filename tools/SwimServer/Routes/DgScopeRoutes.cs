using System.Net.WebSockets;
using Microsoft.AspNetCore.StaticFiles;

namespace SwimServer;

/// <summary>
/// Reverse proxy: /dstars/* → SwimReader.Server (port 5000) for DGScope clients.
/// SwimServer fronts DGScope's HTTP-stream/WebSocket interface so external users only
/// need one Cloudflare tunnel hostname for both feeds. Both transports are proxied:
/// plain HTTP streaming and WebSocket upgrades. The landing page's own static assets
/// (under wwwroot/dstars/) are served locally so the catch-all doesn't swallow them.
/// </summary>
static class DgScopeRoutes
{
    static readonly FileExtensionContentTypeProvider ContentTypes = new();

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
            var query = c.Request.QueryString.HasValue ? c.Request.QueryString.Value : "";

            // Landing-page static assets (directory.css/js, fonts, images) live under
            // wwwroot/dstars/ and must be served locally — the proxy below would otherwise
            // forward them to the upstream feed and 404. Feed paths like "{facility}/updates"
            // don't exist on disk, so they fall through to the proxy.
            if (!c.WebSockets.IsWebSocketRequest && !rest.Contains(".."))
            {
                var localPath = Path.GetFullPath(Path.Combine(ctx.WebRootPath, "dstars", rest));
                var dstarsRoot = Path.GetFullPath(Path.Combine(ctx.WebRootPath, "dstars"));
                if (localPath.StartsWith(dstarsRoot, StringComparison.Ordinal) && File.Exists(localPath))
                {
                    c.Response.ContentType = ContentTypes.TryGetContentType(localPath, out var ct)
                        ? ct : "application/octet-stream";
                    await c.Response.SendFileAsync(localPath);
                    return;
                }
            }

            // WebSocket transport: bridge the client socket to an upstream socket on port 5000.
            if (c.WebSockets.IsWebSocketRequest)
            {
                await ProxyWebSocket(c, $"ws://127.0.0.1:5000/dstars/{rest}{query}");
                return;
            }

            // HTTP streaming transport (newline-delimited JSON / chunked).
            var targetUrl = $"http://127.0.0.1:5000/dstars/{rest}{query}";

            using var httpClient = new HttpClient();
            // Preserve the request method + body so client→server commands (POST
            // /dstars/{fac}/update) and profile saves (POST /dstars/profile/{fac}) proxy
            // correctly — not just the GET streaming feed.
            var request = new HttpRequestMessage(new HttpMethod(c.Request.Method), targetUrl);
            if (!HttpMethods.IsGet(c.Request.Method) && !HttpMethods.IsHead(c.Request.Method))
            {
                request.Content = new StreamContent(c.Request.Body);
                if (!string.IsNullOrEmpty(c.Request.ContentType))
                    request.Content.Headers.TryAddWithoutValidation("Content-Type", c.Request.ContentType);
            }

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

    /// <summary>
    /// Accept the client WebSocket, dial the upstream DGScope WebSocket, and pump frames
    /// in both directions until either side closes or the request is aborted.
    /// </summary>
    static async Task ProxyWebSocket(HttpContext c, string upstreamUrl)
    {
        using var upstream = new ClientWebSocket();
        try
        {
            await upstream.ConnectAsync(new Uri(upstreamUrl), c.RequestAborted);
        }
        catch
        {
            // Upstream feed unavailable — fail the upgrade with a Bad Gateway before accepting.
            c.Response.StatusCode = StatusCodes.Status502BadGateway;
            return;
        }

        using var client = await c.WebSockets.AcceptWebSocketAsync();

        // Either direction completing (close or drop) tears down the pair.
        var clientToUpstream = Pump(client, upstream, c.RequestAborted);
        var upstreamToClient = Pump(upstream, client, c.RequestAborted);
        await Task.WhenAny(clientToUpstream, upstreamToClient);

        // Best-effort close of both ends so the surviving side doesn't hang.
        await CloseQuietly(client);
        await CloseQuietly(upstream);
        await Task.WhenAll(clientToUpstream, upstreamToClient);
    }

    static async Task Pump(WebSocket from, WebSocket to, CancellationToken ct)
    {
        var buffer = new byte[8192];
        try
        {
            while (from.State == WebSocketState.Open && to.State == WebSocketState.Open)
            {
                var result = await from.ReceiveAsync(buffer, ct);
                if (result.MessageType == WebSocketMessageType.Close)
                    break;

                // Preserve frame type and fragmentation as received.
                await to.SendAsync(new ArraySegment<byte>(buffer, 0, result.Count),
                    result.MessageType, result.EndOfMessage, ct);
            }
        }
        catch (OperationCanceledException) { }
        catch (WebSocketException) { }
    }

    static async Task CloseQuietly(WebSocket ws)
    {
        if (ws.State is WebSocketState.Open or WebSocketState.CloseReceived)
        {
            try
            {
                await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "proxy closing", CancellationToken.None);
            }
            catch { }
        }
    }
}
