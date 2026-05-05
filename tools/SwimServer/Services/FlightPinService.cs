using System.Collections.Concurrent;
using System.Text.Json;

namespace SwimServer;

/// <summary>
/// Server-side flight pinning. A "pinned" flight is preserved in a separate
/// JSONL file that is NOT subject to the regular history-cleanup 85% disk cap.
///
/// Pin/unpin lifecycle:
///   pin    → record copied into pinned.jsonl (or refreshed if already there);
///            entry added to pins.json with pinned=true, pinnedAt set
///   unpin  → entry marked pinned=false, unpinnedAt set; record stays for at
///            least 24 hours, and up to 4 days if disk usage permits, then
///            CleanupExpired() removes it from pinned.jsonl and pins.json
///
/// Files:
///   flight-history/pins.json       — index: gufi → {pinned, pinnedAt, unpinnedAt, callsign, lastSeen}
///   flight-history/pinned.jsonl    — full flight records (one JSON line per pin)
/// </summary>
static class FlightPinService
{
    public record PinRecord
    {
        public bool Pinned { get; set; }
        public DateTime PinnedAt { get; set; }
        public DateTime? UnpinnedAt { get; set; }
        public string? Callsign { get; set; }
        public string? Origin { get; set; }
        public string? Destination { get; set; }
        public DateTime? LastSeen { get; set; }
    }

    private static readonly object _lock = new();
    private static ConcurrentDictionary<string, PinRecord> _pins = new();
    private static string _historyDir = "";
    private static JsonSerializerOptions _jsonOpts =
        new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    private static string PinsJsonPath => Path.Combine(_historyDir, "pins.json");
    private static string PinnedJsonlPath => Path.Combine(_historyDir, "pinned.jsonl");

    private const long GraceMinHours = 24;        // never delete within first 24h after unpin
    private const long GraceMaxDays = 4;           // keep up to 4 days if disk allows
    private const long DiskPressureThreshold = 80; // % disk used; above this, drop unpinned past grace_min

    public static void Initialize(string historyDir, JsonSerializerOptions jsonOpts)
    {
        _historyDir = historyDir;
        _jsonOpts = jsonOpts;
        Directory.CreateDirectory(historyDir);
        LoadIndex();
    }

    private static void LoadIndex()
    {
        try
        {
            if (!File.Exists(PinsJsonPath)) return;
            var json = File.ReadAllText(PinsJsonPath);
            var loaded = JsonSerializer.Deserialize<Dictionary<string, PinRecord>>(json, _jsonOpts);
            if (loaded is null) return;
            _pins = new ConcurrentDictionary<string, PinRecord>(loaded);
        }
        catch (Exception ex) { Console.Error.WriteLine($"[Pin] LoadIndex error: {ex.Message}"); }
    }

    private static void SaveIndex()
    {
        try
        {
            var dict = new Dictionary<string, PinRecord>(_pins);
            File.WriteAllText(PinsJsonPath, JsonSerializer.Serialize(dict, _jsonOpts));
        }
        catch (Exception ex) { Console.Error.WriteLine($"[Pin] SaveIndex error: {ex.Message}"); }
    }

    /// <summary>List all pin records (active + within grace) for the frontend.</summary>
    public static IEnumerable<KeyValuePair<string, PinRecord>> GetAll() => _pins.ToArray();

    /// <summary>True if this GUFI is currently pinned (not just within grace).</summary>
    public static bool IsPinned(string gufi) =>
        _pins.TryGetValue(gufi, out var r) && r.Pinned;

    /// <summary>Pin a flight. Idempotent — if already pinned, just refreshes the record.
    /// recordJson should be a complete flight JSON line (same shape as flight-history/*.jsonl).</summary>
    public static void Pin(string gufi, string recordJson, string? callsign,
        string? origin, string? destination, DateTime? lastSeen)
    {
        lock (_lock)
        {
            var existing = _pins.GetValueOrDefault(gufi);
            var rec = new PinRecord
            {
                Pinned = true,
                PinnedAt = existing?.PinnedAt ?? DateTime.UtcNow,
                UnpinnedAt = null,
                Callsign = callsign ?? existing?.Callsign,
                Origin = origin ?? existing?.Origin,
                Destination = destination ?? existing?.Destination,
                LastSeen = lastSeen ?? existing?.LastSeen
            };
            _pins[gufi] = rec;

            // Append the record to pinned.jsonl. We don't dedupe here — the file
            // can have multiple lines per GUFI (latest snapshot wins on read).
            try
            {
                Directory.CreateDirectory(_historyDir);
                File.AppendAllText(PinnedJsonlPath, recordJson.TrimEnd('\r', '\n') + "\n");
            }
            catch (Exception ex) { Console.Error.WriteLine($"[Pin] AppendPinned error: {ex.Message}"); }

            SaveIndex();
        }
    }

    /// <summary>Mark a pin as unpinned. Record stays for grace period.</summary>
    public static bool Unpin(string gufi)
    {
        lock (_lock)
        {
            if (!_pins.TryGetValue(gufi, out var rec) || !rec.Pinned) return false;
            rec.Pinned = false;
            rec.UnpinnedAt = DateTime.UtcNow;
            _pins[gufi] = rec;
            SaveIndex();
            return true;
        }
    }

    /// <summary>Remove pin records that are past the grace window. Called from the
    /// hourly history cleanup timer.</summary>
    public static void CleanupExpired()
    {
        try
        {
            // Compute disk pressure so 'soft' grace can be shortened when full
            double diskUsedPct = 0;
            try
            {
                var drv = new DriveInfo(Path.GetPathRoot(Path.GetFullPath(_historyDir)) ?? "/");
                if (drv.TotalSize > 0)
                    diskUsedPct = 100.0 * (drv.TotalSize - drv.TotalFreeSpace) / drv.TotalSize;
            }
            catch { /* ignore */ }

            var now = DateTime.UtcNow;
            bool diskTight = diskUsedPct > DiskPressureThreshold;
            var toRemove = new List<string>();
            foreach (var (gufi, rec) in _pins)
            {
                if (rec.Pinned) continue; // never expire active pins
                if (rec.UnpinnedAt is null) continue;
                var age = now - rec.UnpinnedAt.Value;
                if (age.TotalHours < GraceMinHours) continue;     // 24h hard floor
                if (!diskTight && age.TotalDays < GraceMaxDays) continue; // 4-day soft retention if disk OK
                toRemove.Add(gufi);
            }

            if (toRemove.Count == 0) return;

            lock (_lock)
            {
                foreach (var gufi in toRemove) _pins.TryRemove(gufi, out _);
                SaveIndex();
                CompactPinnedJsonl();
            }
            Console.WriteLine($"[Pin] Expired {toRemove.Count} pins (diskUsed={diskUsedPct:F0}%)");
        }
        catch (Exception ex) { Console.Error.WriteLine($"[Pin] CleanupExpired error: {ex.Message}"); }
    }

    /// <summary>Rewrite pinned.jsonl keeping only records whose GUFI is still in the index.
    /// Also dedupes — keeps the LAST line per GUFI (most recent snapshot).</summary>
    private static void CompactPinnedJsonl()
    {
        if (!File.Exists(PinnedJsonlPath)) return;
        try
        {
            // Read all, keep last record per GUFI that's still in the index
            var keep = new Dictionary<string, string>();
            foreach (var line in File.ReadAllLines(PinnedJsonlPath))
            {
                if (string.IsNullOrWhiteSpace(line)) continue;
                try
                {
                    var el = JsonSerializer.Deserialize<JsonElement>(line);
                    if (el.TryGetProperty("gufi", out var g) && g.ValueKind == JsonValueKind.String)
                    {
                        var gufi = g.GetString();
                        if (gufi is not null && _pins.ContainsKey(gufi))
                            keep[gufi] = line;
                    }
                }
                catch { /* skip malformed */ }
            }
            File.WriteAllLines(PinnedJsonlPath, keep.Values);
        }
        catch (Exception ex) { Console.Error.WriteLine($"[Pin] Compact error: {ex.Message}"); }
    }

    /// <summary>Read all pinned-flight content (full JSON records) for frontend
    /// to merge into the flight table. Returns an array of JsonElement.</summary>
    public static List<JsonElement> ReadAllRecords()
    {
        var result = new List<JsonElement>();
        if (!File.Exists(PinnedJsonlPath)) return result;
        var seen = new Dictionary<string, JsonElement>();
        try
        {
            foreach (var line in File.ReadLines(PinnedJsonlPath))
            {
                if (string.IsNullOrWhiteSpace(line)) continue;
                try
                {
                    var el = JsonSerializer.Deserialize<JsonElement>(line);
                    if (el.TryGetProperty("gufi", out var g) && g.ValueKind == JsonValueKind.String)
                    {
                        var gufi = g.GetString();
                        if (gufi is null) continue;
                        // Only include if still tracked (pinned OR within grace)
                        if (!_pins.ContainsKey(gufi)) continue;
                        seen[gufi] = el;  // keep last (latest snapshot)
                    }
                }
                catch { }
            }
        }
        catch { }
        result.AddRange(seen.Values);
        return result;
    }
}
