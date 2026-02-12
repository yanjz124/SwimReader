using System.Collections.Concurrent;
using Microsoft.Extensions.Options;

namespace SwimReader.Server.AdsbFi;

public sealed class AdsbFiCache
{
    private readonly IOptions<AdsbFiOptions> _options;
    private readonly ConcurrentDictionary<string, CacheEntry<AdsbFiAircraft?>> _hexCache = new();
    private readonly ConcurrentDictionary<string, CacheEntry<IReadOnlyList<AdsbFiAircraft>>> _geoCache = new();

    public AdsbFiCache(IOptions<AdsbFiOptions> options)
    {
        _options = options;
    }

    public bool TryGetHex(string hex, out AdsbFiAircraft? aircraft)
    {
        aircraft = null;
        if (_hexCache.TryGetValue(hex.ToLowerInvariant(), out var entry) && !entry.IsExpired)
        {
            aircraft = entry.Value;
            return true;
        }
        return false;
    }

    public void SetHex(string hex, AdsbFiAircraft? aircraft)
    {
        _hexCache[hex.ToLowerInvariant()] = new CacheEntry<AdsbFiAircraft?>(
            aircraft, _options.Value.HexCacheDuration);
    }

    public bool TryGetGeo(string facilityId, out IReadOnlyList<AdsbFiAircraft>? aircraft)
    {
        aircraft = null;
        if (_geoCache.TryGetValue(facilityId, out var entry) && !entry.IsExpired)
        {
            aircraft = entry.Value;
            return true;
        }
        return false;
    }

    public void SetGeo(string facilityId, IReadOnlyList<AdsbFiAircraft> aircraft)
    {
        _geoCache[facilityId] = new CacheEntry<IReadOnlyList<AdsbFiAircraft>>(
            aircraft, _options.Value.GeoCacheDuration);

        // Cross-populate hex cache from area response
        foreach (var ac in aircraft)
        {
            if (ac.Hex is not null)
                SetHex(ac.Hex, ac);
        }
    }

    public bool WasRecentlyQueried(string hex)
    {
        return _hexCache.TryGetValue(hex.ToLowerInvariant(), out var entry) && !entry.IsExpired;
    }

    public void PurgeExpired()
    {
        foreach (var kvp in _hexCache)
        {
            if (kvp.Value.IsExpired)
                _hexCache.TryRemove(kvp.Key, out _);
        }
        foreach (var kvp in _geoCache)
        {
            if (kvp.Value.IsExpired)
                _geoCache.TryRemove(kvp.Key, out _);
        }
    }

    private sealed class CacheEntry<T>(T value, TimeSpan ttl)
    {
        public T Value { get; } = value;
        private DateTime ExpiresAt { get; } = DateTime.UtcNow + ttl;
        public bool IsExpired => DateTime.UtcNow >= ExpiresAt;
    }
}
