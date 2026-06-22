using System.Collections.Concurrent;

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
    const int HistorySamples = 60;   // 60 × 1 min = 1 hour

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
}
