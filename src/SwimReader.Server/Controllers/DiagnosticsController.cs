using Microsoft.AspNetCore.Mvc;
using SwimReader.Server.Adapters;
using SwimReader.Server.Streaming;

namespace SwimReader.Server.Controllers;

/// <summary>
/// Diagnostics and health check endpoints.
/// </summary>
[ApiController]
public sealed class DiagnosticsController : ControllerBase
{
    private readonly TrackStateManager _trackState;
    private readonly ClientConnectionManager _clients;

    public DiagnosticsController(TrackStateManager trackState, ClientConnectionManager clients)
    {
        _trackState = trackState;
        _clients = clients;
    }

    [HttpGet("health")]
    public IActionResult Health()
    {
        return Ok(new { Status = "healthy", Timestamp = DateTime.UtcNow });
    }

    [HttpGet("diag")]
    public IActionResult Diagnostics()
    {
        return Ok(new
        {
            ActiveTracks = _trackState.ActiveTrackCount,
            ConnectedClients = _clients.ClientCount,
            Uptime = Environment.TickCount64 / 1000,
            Timestamp = DateTime.UtcNow
        });
    }
}
