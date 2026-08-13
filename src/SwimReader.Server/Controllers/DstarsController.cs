using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using SwimReader.Server.Adapters;
using SwimReader.Server.Streaming;

namespace SwimReader.Server.Controllers;

/// <summary>
/// Implements the Dstars ScopeServer protocol endpoint.
/// DGScope connects to GET /dstars/{facility}/updates for streaming JSON updates.
/// Supports both HTTP streaming and WebSocket upgrade.
/// </summary>
[ApiController]
[Route("dstars")]
public sealed class DstarsController : ControllerBase
{
    private readonly ClientConnectionManager _clients;
    private readonly ILogger<DstarsController> _logger;
    private readonly DgScopeAdapter _adapter;
    private readonly SwimReader.Server.Profile.ProfileStore _profiles;

    public DstarsController(ClientConnectionManager clients, ILogger<DstarsController> logger,
        DgScopeAdapter adapter, SwimReader.Server.Profile.ProfileStore profiles)
    {
        _clients = clients;
        _logger = logger;
        _adapter = adapter;
        _profiles = profiles;
    }

    private static readonly JsonSerializerOptions ProfileJson = new()
    {
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.Never,
    };

    /// <summary>
    /// Web profile-manager read path. Returns the full editable RadarWindow-subset profile for a
    /// facility as JSON (empty skeleton if none exists yet). Reached from the scope origin via the
    /// SwimServer /dstars/* proxy.
    /// </summary>
    [HttpGet("profile/{facility}")]
    public IActionResult GetProfile(string facility)
    {
        var p = _profiles.Get(facility) ?? new SwimReader.Server.Profile.RadarWindowProfile();
        return new JsonResult(p, ProfileJson);
    }

    /// <summary>
    /// Profile upload. Accepts a raw DGScope RadarWindow XML file (from the desktop profile-manager),
    /// stores it verbatim at stars-profiles/{FAC}.xml, and reloads so the CA/MSAW/ATPA engines pick up
    /// the volumes on the next 1 s pass. Every element is preserved (we only parse the subset we use).
    /// </summary>
    [HttpPost("profile/{facility}")]
    public async Task<IActionResult> UploadProfile(string facility, CancellationToken ct)
    {
        using var sr = new StreamReader(Request.Body);
        var xml = await sr.ReadToEndAsync(ct);
        if (string.IsNullOrWhiteSpace(xml)) return BadRequest("empty body");
        try
        {
            var (file, parsed) = _profiles.SaveRawXml(facility, xml);
            return Ok(new
            {
                saved = true,
                file = Path.GetFileName(file),
                ca = parsed.ConflictAlertSuppressionVolumes.Count,
                msaw = parsed.MSAWVolumes.Count,
                atpa = parsed.ATPAVolumes.Count,
            });
        }
        catch (Exception ex)
        {
            return BadRequest("not a valid RadarWindow XML: " + ex.Message);
        }
    }

    /// <summary>
    /// Video-map catalog from a facility's profile — the &lt;VideoMapFiles&gt; entries plus whether each
    /// map's geojson is present on the server and whether it's displayed by default. The scope injects
    /// these into its videoMaps[] and renders them like vNAS maps.
    /// </summary>
    [HttpGet("profile/{facility}/maps")]
    public IActionResult ProfileMaps(string facility)
    {
        var p = _profiles.Get(facility);
        if (p is null) return Ok(Array.Empty<object>());
        var dir = _profiles.MapsDir;
        var displayed = p.CurrentPrefSet?.DisplayedMaps ?? new List<int>();
        var maps = p.VideoMapFiles.Select(m => new
        {
            number = m.MapNumber,
            shortName = m.ShortName,
            fullName = m.FullName,
            category = m.BrightnessGroup == "B" ? "B" : "A",
            dcbButton = m.DCBButton,
            visible = displayed.Contains(m.MapNumber),
            available = dir != null && m.BaseName != null && System.IO.File.Exists(Path.Combine(dir, m.BaseName)),
        }).ToArray();
        return Ok(maps);
    }

    /// <summary>
    /// Upload one video-map geojson into the shared stars-profiles/VideoMaps store (keyed by basename,
    /// matching the profile's VideoMapFile references). Raw geojson body; the client POSTs each file.
    /// </summary>
    [HttpPost("map/{name}")]
    public async Task<IActionResult> UploadMap(string name, CancellationToken ct)
    {
        // basename only, must be a .geojson — no path traversal.
        var baseName = System.IO.Path.GetFileName(name.Replace('\\', '/'));
        if (string.IsNullOrEmpty(baseName) || !baseName.EndsWith(".geojson", StringComparison.OrdinalIgnoreCase))
            return BadRequest("name must be a .geojson basename");
        var dir = _profiles.MapsDir;
        if (dir is null) return BadRequest("no profiles root");
        using var srdr = new StreamReader(Request.Body);
        var body = await srdr.ReadToEndAsync(ct);
        if (string.IsNullOrWhiteSpace(body)) return BadRequest("empty body");
        try { using var _ = System.Text.Json.JsonDocument.Parse(body); }   // reject non-JSON
        catch (JsonException) { return BadRequest("not valid geojson/JSON"); }
        Directory.CreateDirectory(dir);
        await System.IO.File.WriteAllTextAsync(System.IO.Path.Combine(dir, baseName), body, ct);
        return Ok(new { saved = true, name = baseName });
    }

    /// <summary>Serve one profile video-map's geojson (resolved from stars-profiles/VideoMaps by basename).</summary>
    [HttpGet("profile/{facility}/map/{number:int}")]
    public IActionResult ProfileMap(string facility, int number)
    {
        var p = _profiles.Get(facility);
        var m = p?.VideoMapFiles.FirstOrDefault(x => x.MapNumber == number);
        var dir = _profiles.MapsDir;
        if (m?.BaseName is null || dir is null) return NotFound();
        var file = Path.Combine(dir, m.BaseName);
        if (!System.IO.File.Exists(file)) return NotFound();
        return PhysicalFile(file, "application/geo+json");
    }

    /// <summary>List stored profiles with parsed volume counts (for the manager UI).</summary>
    [HttpGet("profiles")]
    public IActionResult ListProfiles()
    {
        var items = _profiles.List().Select(p =>
        {
            var prof = _profiles.Get(p.Name);
            return new
            {
                name = p.Name,
                ca = prof?.ConflictAlertSuppressionVolumes.Count ?? 0,
                msaw = prof?.MSAWVolumes.Count ?? 0,
                atpa = prof?.ATPAVolumes.Count ?? 0,
            };
        }).ToArray();
        return Ok(items);
    }

    /// <summary>
    /// Streaming endpoint for DGScope clients.
    /// GET /dstars/{facility}/updates — streams newline-delimited JSON
    /// WS  /dstars/{facility}/updates — WebSocket with same format
    /// </summary>
    private static readonly JsonSerializerOptions InOpts = new() { PropertyNameCaseInsensitive = true };

    /// <summary>
    /// Command channel. A scope client POSTs a partial FlightPlanUpdate/DeletionUpdate here
    /// (scratchpad/type/owner/pending-handoff) — the same message DGScope's ScopeServerClient sends
    /// to <c>{baseUrl}update</c>. The server records it as a controller override and rebroadcasts the
    /// merged flight plan to every client of the facility, so the edit persists over the live feed
    /// and is shared. This is what makes STARS commands actually take effect.
    /// </summary>
    [HttpPost("{facility}/update")]
    public async Task<IActionResult> PostUpdate(string facility, CancellationToken ct)
    {
        ClientFpUpdate? u;
        try
        {
            u = await JsonSerializer.DeserializeAsync<ClientFpUpdate>(Request.Body, InOpts, ct);
        }
        catch (JsonException)
        {
            return BadRequest("malformed update");
        }
        if (u is null || u.Guid == Guid.Empty)
            return BadRequest("missing guid");

        _adapter.ApplyClientUpdate(facility, u);
        return Ok();
    }

    [HttpGet("{facility}/updates")]
    public async Task GetUpdates(string facility, CancellationToken ct)
    {
        var clientId = Guid.NewGuid().ToString("N");
        var client = _clients.AddClient(clientId, facility);

        // Seed the new client's channel with the adapter's current snapshot
        // (FPs first, then Tracks - so callsigns are present before symbols
        // render). This means a freshly-loaded scope sees the full state on
        // connect instead of waiting for the next sweep / TAIS batch.
        int seedCount = 0;
        foreach (var (guid, jsonLine) in _adapter.GetSnapshot(facility))
        {
            // Tracked write so the per-client guid set is populated — any
            // later UT=2 deletion for this guid gets delivered. Without
            // this, the deletion filter would reject ALL UT=2 since the
            // client has only seen snapshot writes, not "tracked" writes.
            client.TryWriteTracked(jsonLine, guid);
            seedCount++;
        }
        if (seedCount > 0)
            _logger.LogInformation("Seeded client {Id} with {N} snapshot updates", clientId, seedCount);

        if (HttpContext.WebSockets.IsWebSocketRequest)
        {
            var ws = await HttpContext.WebSockets.AcceptWebSocketAsync();

            _logger.LogInformation("WebSocket client {Id} streaming for facility {Facility}",
                clientId, facility);

            try
            {
                // Start a background task to read (and discard) incoming WS frames
                // so we detect client disconnect
                var receiveTask = Task.Run(async () =>
                {
                    var buffer = new byte[256];
                    try
                    {
                        while (ws.State == System.Net.WebSockets.WebSocketState.Open && !ct.IsCancellationRequested)
                        {
                            var result = await ws.ReceiveAsync(buffer, ct);
                            if (result.MessageType == System.Net.WebSockets.WebSocketMessageType.Close)
                                break;
                        }
                    }
                    catch { }
                }, ct);

                // Read from channel and send to WebSocket
                await foreach (var jsonLine in client.ReadAllAsync(ct))
                {
                    if (ws.State != System.Net.WebSockets.WebSocketState.Open)
                        break;

                    var bytes = Encoding.UTF8.GetBytes(jsonLine + "\n");
                    await ws.SendAsync(bytes, System.Net.WebSockets.WebSocketMessageType.Text, true, ct);
                }
            }
            catch (OperationCanceledException) { }
            catch (Exception ex)
            {
                _logger.LogDebug(ex, "WebSocket client {Id} error", clientId);
            }
            finally
            {
                _clients.RemoveClient(clientId);
                if (ws.State == System.Net.WebSockets.WebSocketState.Open)
                {
                    try
                    {
                        await ws.CloseAsync(
                            System.Net.WebSockets.WebSocketCloseStatus.NormalClosure,
                            "Server closing", CancellationToken.None);
                    }
                    catch { }
                }
            }
        }
        else
        {
            // HTTP streaming response (newline-delimited JSON)
            Response.ContentType = "application/json";

            await Response.StartAsync(ct);

            _logger.LogInformation("HTTP stream client {Id} streaming for facility {Facility}",
                clientId, facility);

            try
            {
                // Read from channel and write to response body on the request thread
                await foreach (var jsonLine in client.ReadAllAsync(ct))
                {
                    var bytes = Encoding.UTF8.GetBytes(jsonLine + "\n");
                    await Response.Body.WriteAsync(bytes, ct);
                    await Response.Body.FlushAsync(ct);
                }
            }
            catch (OperationCanceledException) { }
            catch (Exception ex)
            {
                _logger.LogDebug(ex, "HTTP stream client {Id} error", clientId);
            }
            finally
            {
                _clients.RemoveClient(clientId);
            }
        }
    }
}
