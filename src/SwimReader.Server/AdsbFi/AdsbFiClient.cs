using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace SwimReader.Server.AdsbFi;

public sealed class AdsbFiClient
{
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly IOptions<AdsbFiOptions> _options;
    private readonly ILogger<AdsbFiClient> _logger;
    private readonly SemaphoreSlim _rateLimiter = new(1, 1);
    private DateTime _lastRequestTime = DateTime.MinValue;

    public AdsbFiClient(
        IHttpClientFactory httpClientFactory,
        IOptions<AdsbFiOptions> options,
        ILogger<AdsbFiClient> logger)
    {
        _httpClientFactory = httpClientFactory;
        _options = options;
        _logger = logger;
    }

    public async Task<AdsbFiAircraft?> GetByHexAsync(string hex, CancellationToken ct)
    {
        var response = await GetAsync<AdsbFiResponse>($"v2/hex/{hex}", ct);
        return response?.Aircraft?.FirstOrDefault();
    }

    public async Task<IReadOnlyList<AdsbFiAircraft>> GetByLocationAsync(
        double lat, double lon, int radiusNm, CancellationToken ct)
    {
        var response = await GetAsync<AdsbFiResponse>(
            $"v3/lat/{lat:F6}/lon/{lon:F6}/dist/{radiusNm}", ct);
        return response?.Aircraft ?? (IReadOnlyList<AdsbFiAircraft>)[];
    }

    /// <summary>
    /// Get a global snapshot of all aircraft. Refreshed by adsb.fi twice per minute.
    /// </summary>
    public async Task<IReadOnlyList<AdsbFiAircraft>> GetSnapshotAsync(CancellationToken ct)
    {
        var response = await GetAsync<AdsbFiResponse>("v2/snapshot", ct);
        return response?.Aircraft ?? (IReadOnlyList<AdsbFiAircraft>)[];
    }

    private async Task<T?> GetAsync<T>(string path, CancellationToken ct) where T : class
    {
        await _rateLimiter.WaitAsync(ct);
        try
        {
            var elapsed = DateTime.UtcNow - _lastRequestTime;
            var minInterval = _options.Value.MinRequestInterval;
            if (elapsed < minInterval)
            {
                await Task.Delay(minInterval - elapsed, ct);
            }

            var client = _httpClientFactory.CreateClient("AdsbFi");
            _logger.LogDebug("adsb.fi request: {Path}", path);

            var response = await client.GetAsync(path, ct);
            _lastRequestTime = DateTime.UtcNow;

            if (!response.IsSuccessStatusCode)
            {
                _logger.LogWarning("adsb.fi API returned {StatusCode} for {Path}",
                    response.StatusCode, path);
                return null;
            }

            var stream = await response.Content.ReadAsStreamAsync(ct);
            return await JsonSerializer.DeserializeAsync<T>(stream, cancellationToken: ct);
        }
        catch (TaskCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "adsb.fi API request failed for {Path}", path);
            return null;
        }
        finally
        {
            _rateLimiter.Release();
        }
    }
}
