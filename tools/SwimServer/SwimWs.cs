using System.Net.WebSockets;

namespace SwimServer;

/// <summary>
/// WebSocket accept helper. Every socket in this server broadcasts the same public SWIM telemetry
/// to whoever is connected, and the payloads are large, repetitive JSON — which is exactly what
/// deflate is good at. Measured on the ERAM snapshot: 17.8 MB to 2.08 MB, 7.2x.
/// </summary>
internal static class SwimWs
{
    /// <summary>
    /// Accept with permessage-deflate offered.
    ///
    /// Compression is negotiated by the client, so this is safe for third-party consumers too
    /// (the DGScope socket among them): a client that doesn't offer the extension simply gets an
    /// uncompressed session, exactly as before. Browsers offer it by default.
    ///
    /// On the name: <c>DangerousEnableCompression</c> warns about CRIME/BREACH, where a secret
    /// shares a compression stream with attacker-chosen data and the compressed length leaks the
    /// secret. That threat needs a secret in the stream. These sockets carry public flight
    /// telemetry, identical for every client, with no per-client token in the payload, and the
    /// deployment is gated by HTTP Basic at the edge.
    ///
    /// Do NOT reuse this on a socket that echoes caller-supplied input back alongside anything
    /// sensitive — that is the shape the warning is about.
    /// </summary>
    public static Task<WebSocket> AcceptAsync(HttpContext ctx) =>
        ctx.WebSockets.AcceptWebSocketAsync(new WebSocketAcceptContext
        {
            DangerousEnableCompression = true,
        });
}
