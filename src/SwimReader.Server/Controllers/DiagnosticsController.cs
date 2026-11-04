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
    private readonly SwimReader.Server.Profile.ProfileStore _profiles;
    private readonly SwimReader.Scds.ScdsHostedService _scds;

    public DiagnosticsController(TrackStateManager trackState, ClientConnectionManager clients,
        SwimReader.Server.Profile.ProfileStore profiles, SwimReader.Scds.ScdsHostedService scds)
    {
        _trackState = trackState;
        _clients = clients;
        _profiles = profiles;
        _scds = scds;
    }

    /// <summary>Report the loaded STARS profile for a facility — for verifying profile XML loading.</summary>
    [HttpGet("api/stars/profile/{facility}")]
    public IActionResult Profile(string facility, [FromQuery] bool reload = false)
    {
        if (reload) _profiles.Invalidate();
        var p = _profiles.Get(facility);
        if (p is null)
            return Ok(new { facility, loaded = false, root = _profiles.Root });
        return Ok(new
        {
            facility,
            loaded = true,
            root = _profiles.Root,
            ca = new
            {
                p.ConflictAlertActive,
                p.ConflictAlertHorizontalSeparation,
                p.ConflictAlertVerticalSeparation,
                p.ConflictAlertLookAheadSeconds,
                suppressionVolumes = p.ConflictAlertSuppressionVolumes.Count,
                sample = p.ConflictAlertSuppressionVolumes.Take(3).Select(v => v.Name)
            },
            msaw = new
            {
                p.MSAWActive,
                volumes = p.MSAWVolumes.Count,
                suppressionVolumes = p.MSAWSuppressionVolumes.Count,
                sample = p.MSAWVolumes.Take(3).Select(v => new { v.Name, v.Floor, v.Ceiling, pts = v.Points.Count })
            },
            atpa = new
            {
                p.ATPAActive,
                volumes = p.ATPAVolumes.Count,
                sample = p.ATPAVolumes.Take(3).Select(v => new { v.Name, v.TrueHeading, v.Length, v.Destination })
            }
        });
    }

    [HttpGet("health")]
    public IActionResult Health()
    {
        return Ok(new { Status = "healthy", Timestamp = DateTime.UtcNow });
    }

    /// <summary>
    /// Per-sub-service STDDS throughput, broker discards and our own drop count.
    ///
    /// Proxied by SwimServer at /api/feed/stdds so the dashboard can show both consumers of the
    /// STDDS queue. That pairing is the point: the queue is competing-consumers, so this
    /// service's rate plus SwimServer's STDDS rate is the real queue rate, and either one alone
    /// looks like a healthy feed at half volume.
    /// </summary>
    [HttpGet("feed")]
    public IActionResult Feed() => Ok(SwimReader.Scds.StddsFeedHealth.Snapshot(
        _scds.InboundDropped, _scds.Connected, _scds.QueueName));

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
