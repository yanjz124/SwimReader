using System.Collections.Concurrent;
using System.Text.Json;

namespace SwimServer;

/// <summary>
/// Per-sector track-count history + handoff transition aggregator. Powers the
/// /sectors page so closed sectors still show on the timeline, and adds a
/// lightweight Markov-style summary of where a sector's flights typically come
/// from / go to.
///
/// Two stores:
///   • <see cref="History"/>  FAC|SEC → ring buffer of last 60 snapshots
///                            (1 sample / minute = 1 hour window).
///   • <see cref="Transitions"/> "FAC|SEC → FAC|SEC" → count, accumulated
///                            since process start. Updated by
///                            <see cref="RecordTransition"/> whenever a
///                            flight's controlling sector changes.
///
/// Snapshot() is called once per minute by Program.cs. RecordTransition() is
/// invoked from ProcessFlight() right before the new sector is committed.
/// </summary>
sealed class SectorTracker
{
    // 24 hours of per-minute samples. Memory cost: ~5.6 KB per sector × a
    // few thousand observed sectors = under 15 MB resident. The full array
    // is queryable via /api/sectors/{fac}/{sec}/history; the main /sectors
    // poll downsamples to a much smaller bucket count to keep payload tiny.
    public const int HistorySamples = 60 * 24;

    // FAC|SEC → ring buffer of recent counts. We keep zero entries so a sector
    // that was active and is now empty still has a non-empty timeline (which
    // is the whole point of letting closed sectors show up on the page).
    readonly ConcurrentDictionary<string, int[]> _history = new();
    int _writePos = 0;                // shared write index — all rings advance together

    // "FROM_KEY → TO_KEY" → observed transition count.
    readonly ConcurrentDictionary<(string from, string to), int> _trans = new();

    static string Key(string fac, string sec) => $"{fac}|{sec}";

    /// <summary>
    /// Snapshot current per-sector counts derived from the live flight map and
    /// append them to each sector's ring buffer. Sectors not present this tick
    /// still get a 0 appended so the timeline stays continuous; the same is
    /// true for sectors that have been zero for a while (kept until they fall
    /// out the back of the ring).
    /// </summary>
    public void Snapshot(ConcurrentDictionary<string, FlightState> flights)
    {
        // Aggregate
        var counts = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        foreach (var f in flights.Values)
        {
            if (f.FlightStatus is "CANCELLED" or "COMPLETED") continue;
            var fac = (f.ControllingFacility ?? "").Trim().ToUpperInvariant();
            var sec = (f.ControllingSector ?? "").Trim().ToUpperInvariant();
            if (string.IsNullOrEmpty(fac)) continue;
            if (string.IsNullOrEmpty(sec)) sec = "(none)";
            counts.TryGetValue(Key(fac, sec), out var prev);
            counts[Key(fac, sec)] = prev + 1;
        }

        var slot = _writePos % HistorySamples;
        _writePos++;

        // Write current counts. Add zero entries for any previously-seen
        // sector that didn't get a count this tick.
        var allKeys = new HashSet<string>(_history.Keys, StringComparer.OrdinalIgnoreCase);
        foreach (var k in counts.Keys) allKeys.Add(k);
        foreach (var k in allKeys)
        {
            var buf = _history.GetOrAdd(k, _ => new int[HistorySamples]);
            buf[slot] = counts.TryGetValue(k, out var v) ? v : 0;
        }
    }

    /// <summary>Return the ring buffer rotated so the OLDEST sample is at index 0.</summary>
    public int[] GetHistory(string fac, string sec)
    {
        if (!_history.TryGetValue(Key(fac, sec), out var buf)) return Array.Empty<int>();
        var rotated = new int[buf.Length];
        // The next slot we'd write is the oldest one.
        var oldest = _writePos % HistorySamples;
        for (int i = 0; i < buf.Length; i++)
            rotated[i] = buf[(oldest + i) % buf.Length];
        return rotated;
    }

    /// <summary>
    /// Same as <see cref="GetHistory"/> but max-pooled into <paramref name="buckets"/>
    /// equal-size slices, so a 24h window can be shipped to the page as a
    /// small sparkline-sized array. Max-pool (not average) keeps peaks
    /// visible — a sector that pinned at 8 tracks for one minute still
    /// stands out on the timeline.
    /// </summary>
    public int[] GetDownsampledHistory(string fac, string sec, int buckets = 60)
    {
        var full = GetHistory(fac, sec);
        if (full.Length == 0) return Array.Empty<int>();
        if (buckets >= full.Length) return full;
        var step = (double)full.Length / buckets;
        var outArr = new int[buckets];
        for (int b = 0; b < buckets; b++)
        {
            int start = (int)(b * step);
            int end   = (int)((b + 1) * step);
            if (end > full.Length) end = full.Length;
            int m = 0;
            for (int i = start; i < end; i++) if (full[i] > m) m = full[i];
            outArr[b] = m;
        }
        return outArr;
    }

    /// <summary>True if the sector had ≥1 track in any of the last `withinSamples` samples.</summary>
    public bool WasRecentlyActive(string fac, string sec, int withinSamples = HistorySamples)
    {
        if (!_history.TryGetValue(Key(fac, sec), out var buf)) return false;
        var n = Math.Min(withinSamples, buf.Length);
        for (int i = 0; i < n; i++) if (buf[i] > 0) return true;
        return false;
    }

    /// <summary>Enumerate every (fac, sec) we've ever recorded.</summary>
    public IEnumerable<(string Fac, string Sec)> AllKnownSectors()
    {
        foreach (var k in _history.Keys)
        {
            var slash = k.IndexOf('|');
            if (slash > 0) yield return (k[..slash], k[(slash + 1)..]);
        }
    }

    /// <summary>
    /// Record a sector→sector transition. Called when ProcessFlight observes
    /// the controlling sector flip on an existing flight. fac/sec are
    /// trimmed+uppercased here; empty pieces collapse to "(none)" so the
    /// "no sector yet" boundary still counts as a node in the chain.
    /// </summary>
    public void RecordTransition(string? fromFac, string? fromSec, string? toFac, string? toSec)
    {
        var f = $"{(fromFac ?? "").Trim().ToUpperInvariant()}|{(string.IsNullOrEmpty(fromSec) ? "(none)" : fromSec.Trim().ToUpperInvariant())}";
        var t = $"{(toFac ?? "").Trim().ToUpperInvariant()}|{(string.IsNullOrEmpty(toSec) ? "(none)" : toSec.Trim().ToUpperInvariant())}";
        if (f == t) return;
        if (f.StartsWith("|") && t.StartsWith("|")) return;  // no facility on either side — nothing useful
        _trans.AddOrUpdate((f, t), 1, (_, v) => v + 1);
    }

    /// <summary>
    /// Top destinations FROM the given sector. Returns (toFac, toSec, count).
    /// </summary>
    public IEnumerable<(string Fac, string Sec, int Count)> TopOut(string fac, string sec, int n = 10)
    {
        var key = Key(fac.ToUpperInvariant(), sec.ToUpperInvariant());
        return _trans
            .Where(kv => kv.Key.from == key)
            .OrderByDescending(kv => kv.Value)
            .Take(n)
            .Select(kv =>
            {
                var slash = kv.Key.to.IndexOf('|');
                return (kv.Key.to[..slash], kv.Key.to[(slash + 1)..], kv.Value);
            });
    }

    /// <summary>
    /// Top sources INTO the given sector. Returns (fromFac, fromSec, count).
    /// </summary>
    public IEnumerable<(string Fac, string Sec, int Count)> TopIn(string fac, string sec, int n = 10)
    {
        var key = Key(fac.ToUpperInvariant(), sec.ToUpperInvariant());
        return _trans
            .Where(kv => kv.Key.to == key)
            .OrderByDescending(kv => kv.Value)
            .Take(n)
            .Select(kv =>
            {
                var slash = kv.Key.from.IndexOf('|');
                return (kv.Key.from[..slash], kv.Key.from[(slash + 1)..], kv.Value);
            });
    }

    // ── Persistence ──────────────────────────────────────────────────────────
    // The ring is in-memory only by default, so a sfdps-eram restart (from
    // auto-deploy or otherwise) wipes the timeline. Save() writes the live
    // ring buffers + transition counts to disk; Load() restores them on
    // startup so the /sectors page survives restarts. JSON wire format kept
    // small via short field names.
    sealed class Persisted
    {
        public int WritePos { get; set; }
        public Dictionary<string, int[]> History { get; set; } = new();
        // Flatten the transition tuple key as "FROM>>TO" — JSON dict keys
        // must be strings.
        public Dictionary<string, int> Trans { get; set; } = new();
    }

    public void Save(string dir)
    {
        try
        {
            Directory.CreateDirectory(dir);
            var p = new Persisted { WritePos = _writePos };
            foreach (var kv in _history) p.History[kv.Key] = kv.Value;
            foreach (var kv in _trans)   p.Trans[$"{kv.Key.from}>>{kv.Key.to}"] = kv.Value;
            var path = Path.Combine(dir, "sectors.json");
            var tmp  = path + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(p));
            File.Move(tmp, path, overwrite: true);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[SectorTracker] save failed: {ex.GetType().Name}: {ex.Message}");
        }
    }

    public void Load(string dir)
    {
        try
        {
            var path = Path.Combine(dir, "sectors.json");
            if (!File.Exists(path)) return;
            var p = JsonSerializer.Deserialize<Persisted>(File.ReadAllText(path));
            if (p is null) return;
            _writePos = p.WritePos;
            foreach (var kv in p.History)
            {
                // Defensive: clamp to expected buffer length so a stale file
                // from a different HistorySamples value doesn't crash.
                if (kv.Value is null) continue;
                var buf = new int[HistorySamples];
                Array.Copy(kv.Value, 0, buf, 0, Math.Min(kv.Value.Length, HistorySamples));
                _history[kv.Key] = buf;
            }
            foreach (var kv in p.Trans)
            {
                var sep = kv.Key.IndexOf(">>", StringComparison.Ordinal);
                if (sep <= 0) continue;
                _trans[(kv.Key[..sep], kv.Key[(sep + 2)..])] = kv.Value;
            }
            Console.WriteLine($"[SectorTracker] loaded {_history.Count} sectors, {_trans.Count} transitions, writePos={_writePos}");
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[SectorTracker] load failed: {ex.GetType().Name}: {ex.Message}");
        }
    }
}
