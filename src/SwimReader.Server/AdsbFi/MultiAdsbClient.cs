using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace SwimReader.Server.AdsbFi;

/// <summary>
/// Round-robin ADS-B client that queries adsb.fi, adsb.lol, and airplanes.live.
/// All three APIs share the same v2 response format.
/// Each API is rate-limited to 1 req/sec independently, giving ~3 req/sec aggregate.
/// On failure, the next API in rotation is tried.
/// </summary>
public sealed class MultiAdsbClient
{
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILogger<MultiAdsbClient> _logger;
    private readonly AdsbSource[] _sources;
    private int _nextSource;

    public MultiAdsbClient(
        IHttpClientFactory httpClientFactory,
        ILogger<MultiAdsbClient> logger)
    {
        _httpClientFactory = httpClientFactory;
        _logger = logger;

        _sources =
        [
            new AdsbSource("AdsbFi",         "https://opendata.adsb.fi/api/"),
            new AdsbSource("AdsbLol",         "https://api.adsb.lol/"),
            new AdsbSource("AirplanesLive",   "https://api.airplanes.live/"),
        ];
    }

    /// <summary>
    /// Query by ICAO hex address (Mode S code). Tries current source, falls back to others.
    /// </summary>
    public Task<AdsbFiAircraft?> GetByHexAsync(string hex, CancellationToken ct)
        => QuerySingleAsync($"v2/hex/{hex}", ct);

    /// <summary>
    /// Query by callsign. Tries current source, falls back to others.
    /// </summary>
    public Task<AdsbFiAircraft?> GetByCallsignAsync(string callsign, CancellationToken ct)
        => QuerySingleAsync($"v2/callsign/{callsign}", ct);

    /// <summary>
    /// Query by squawk code. Returns all matching aircraft.
    /// </summary>
    public Task<IReadOnlyList<AdsbFiAircraft>> GetBySquawkAsync(string squawk, CancellationToken ct)
        => QueryListAsync($"v2/sqk/{squawk}", ct);

    /// <summary>
    /// Query by geographic location (lat/lon/radius). Uses adsb.fi v3 endpoint (others don't support geo).
    /// Falls back through sources that support it.
    /// </summary>
    public async Task<IReadOnlyList<AdsbFiAircraft>> GetByLocationAsync(
        double lat, double lon, int radiusNm, CancellationToken ct)
    {
        // Only adsb.fi supports v3 geo queries; adsb.lol and airplanes.live use v2 point format
        var paths = new[]
        {
            ("AdsbFi", $"v3/lat/{lat:F6}/lon/{lon:F6}/dist/{radiusNm}"),
            ("AirplanesLive", $"v2/point/{lat:F6}/{lon:F6}/{radiusNm}"),
            ("AdsbLol", $"v2/lat/{lat:F6}/lon/{lon:F6}/dist/{radiusNm}"),
        };

        foreach (var (sourceName, path) in paths)
        {
            var source = _sources.First(s => s.Name == sourceName);
            var result = await FetchListAsync(source, path, ct);
            if (result is not null)
                return result;
        }

        return [];
    }

    private async Task<AdsbFiAircraft?> QuerySingleAsync(string path, CancellationToken ct)
    {
        // Try up to all 3 sources
        for (var attempt = 0; attempt < _sources.Length; attempt++)
        {
            var source = NextSource();
            var result = await FetchAsync(source, path, ct);
            if (result is not null)
                return result.Aircraft?.FirstOrDefault();
        }
        return null;
    }

    private async Task<IReadOnlyList<AdsbFiAircraft>> QueryListAsync(string path, CancellationToken ct)
    {
        for (var attempt = 0; attempt < _sources.Length; attempt++)
        {
            var source = NextSource();
            var result = await FetchListAsync(source, path, ct);
            if (result is not null)
                return result;
        }
        return [];
    }

    private async Task<IReadOnlyList<AdsbFiAircraft>?> FetchListAsync(
        AdsbSource source, string path, CancellationToken ct)
    {
        var result = await FetchAsync(source, path, ct);
        return result?.Aircraft;
    }

    private async Task<AdsbFiResponse?> FetchAsync(AdsbSource source, string path, CancellationToken ct)
    {
        await source.RateLimiter.WaitAsync(ct);
        try
        {
            var elapsed = DateTime.UtcNow - source.LastRequest;
            if (elapsed < TimeSpan.FromMilliseconds(1100))
                await Task.Delay(TimeSpan.FromMilliseconds(1100) - elapsed, ct);

            var client = _httpClientFactory.CreateClient(source.Name);
            var response = await client.GetAsync(path, ct);
            source.LastRequest = DateTime.UtcNow;

            if (!response.IsSuccessStatusCode)
            {
                _logger.LogDebug("{Source} returned {Status} for {Path}",
                    source.Name, response.StatusCode, path);
                return null;
            }

            var stream = await response.Content.ReadAsStreamAsync(ct);
            return await JsonSerializer.DeserializeAsync<AdsbFiResponse>(stream, cancellationToken: ct);
        }
        catch (TaskCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "{Source} request failed for {Path}", source.Name, path);
            return null;
        }
        finally
        {
            source.RateLimiter.Release();
        }
    }

    private AdsbSource NextSource()
    {
        var idx = Interlocked.Increment(ref _nextSource);
        return _sources[((idx - 1) % _sources.Length + _sources.Length) % _sources.Length];
    }

    private sealed class AdsbSource(string name, string baseUrl)
    {
        public string Name { get; } = name;
        public string BaseUrl { get; } = baseUrl;
        public SemaphoreSlim RateLimiter { get; } = new(1, 1);
        public DateTime LastRequest { get; set; } = DateTime.MinValue;
    }
}
