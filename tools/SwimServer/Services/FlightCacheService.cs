using System.Collections.Concurrent;
using System.Text.Json;

namespace SwimServer;

/// <summary>
/// Persists the in-memory FlightState dictionary to disk so flights survive
/// process restarts. Saves to {cacheDir}/flights.json (atomic via temp + rename),
/// and loads on startup if the cache is fresh (less than 60 minutes old).
/// </summary>
static class FlightCacheService
{
    public static void Save(
        ConcurrentDictionary<string, FlightState> flights,
        string cacheDir,
        JsonSerializerOptions cacheJsonOpts)
    {
        try
        {
            Directory.CreateDirectory(cacheDir);
            // Backfill fields from stored event XML before snapshotting
            foreach (var f in flights.Values) f.BackfillFromEvents();
            var cache = new FlightCache
            {
                SavedAt = DateTime.UtcNow,
                Flights = flights.Values
                    .Where(f => f.FlightStatus != "CANCELLED")
                    .Select(f => f.ToSnapshot())
                    .ToList()
            };
            var tmpPath = Path.Combine(cacheDir, "flights.json.tmp");
            var finalPath = Path.Combine(cacheDir, "flights.json");
            using (var fs = File.Create(tmpPath))
                JsonSerializer.Serialize(fs, cache, cacheJsonOpts);
            File.Move(tmpPath, finalPath, overwrite: true);
            Console.WriteLine($"[Cache] Saved {cache.Flights.Count} flights ({new FileInfo(finalPath).Length / 1024}KB)");
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[Cache] Save error: {ex.Message}");
        }
    }

    public static void Load(
        ConcurrentDictionary<string, FlightState> flights,
        string cacheDir,
        JsonSerializerOptions cacheJsonOpts)
    {
        try
        {
            var cachePath = Path.Combine(cacheDir, "flights.json");
            if (!File.Exists(cachePath))
            {
                Console.WriteLine("[Cache] No cached flight data found");
                return;
            }
            var ageMinutes = (DateTime.UtcNow - File.GetLastWriteTimeUtc(cachePath)).TotalMinutes;
            if (ageMinutes > 60)
            {
                Console.WriteLine($"[Cache] Cache is {ageMinutes:F0} min old, skipping (stale)");
                return;
            }
            using var fs = File.OpenRead(cachePath);
            var cache = JsonSerializer.Deserialize<FlightCache>(fs, cacheJsonOpts);
            if (cache?.Flights is null || cache.Flights.Count == 0)
            {
                Console.WriteLine("[Cache] Cache file empty");
                return;
            }
            int loaded = 0;
            foreach (var snapshot in cache.Flights)
            {
                if (string.IsNullOrEmpty(snapshot.Gufi)) continue;
                flights[snapshot.Gufi] = FlightState.FromSnapshot(snapshot);
                loaded++;
            }
            // Backfill FlightType from event summaries (survives cache via [TYPE] in summary text)
            int backfilled = 0;
            foreach (var f in flights.Values)
            {
                if (f.FlightType is null) { f.BackfillFromEvents(); if (f.FlightType is not null) backfilled++; }
            }
            Console.WriteLine($"[Cache] Restored {loaded} flights (saved {ageMinutes:F0} min ago){(backfilled > 0 ? $", backfilled {backfilled} flight types" : "")}");
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[Cache] Load error: {ex.Message}");
        }
    }
}
