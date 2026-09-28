using System.Collections.Concurrent;
using System.Text.Json;

namespace SwimServer;

/// <summary>
/// Gate lookups from the persisted TDLS history (tdls-history/YYYY-MM-DD.jsonl): for each airport +
/// callsign, the tower departure events of that day with their parking gate and times. Live TDLS state
/// starts empty on every restart, so the Route Finder reads the day files instead.
///
/// A day file is ~7 MB with ~5k DEPART lines; only those lines are parsed. Past days never change and
/// stay cached; today's file is re-read when it has grown and the cached copy is over two minutes old.
/// </summary>
static class TdlsGateIndex
{
    public readonly record struct Dep(DateTime Time, string Gate, string? Runway);

    private sealed record Day(Dictionary<string, List<Dep>> ByKey, long Length, DateTime BuiltAt);
    private static readonly ConcurrentDictionary<string, Day> Cache = new();
    private const int MaxDays = 20;

    private static string Apt(string a)
    {
        a = a.ToUpperInvariant();
        return a.Length == 4 && (a[0] == 'K' || a[0] == 'P') ? a[1..] : a;
    }
    private static string Key(string airport, string callsign) => Apt(airport) + "|" + callsign.ToUpperInvariant();

    /// <summary>The departure of <paramref name="callsign"/> from <paramref name="airport"/> closest to
    /// <paramref name="near"/> within <paramref name="window"/>, searching that UTC day and its neighbours.</summary>
    public static Dep? Find(string dir, string airport, string callsign, DateTime near, TimeSpan window)
    {
        if (string.IsNullOrEmpty(airport) || string.IsNullOrEmpty(callsign)) return null;
        var key = Key(airport, callsign);
        Dep? best = null; double bestGap = double.MaxValue;
        foreach (var d in new[] { near.Date.AddDays(-1), near.Date, near.Date.AddDays(1) })
        {
            var day = Load(dir, d.ToString("yyyy-MM-dd"));
            if (day is null || !day.ByKey.TryGetValue(key, out var list)) continue;
            foreach (var dep in list)
            {
                var gap = Math.Abs((dep.Time - near).TotalMinutes);
                if (gap <= window.TotalMinutes && gap < bestGap) { best = dep; bestGap = gap; }
            }
        }
        return best;
    }

    private static Day? Load(string dir, string date)
    {
        var path = Path.Combine(dir, date + ".jsonl");
        FileInfo fi;
        try { fi = new FileInfo(path); if (!fi.Exists) return null; } catch { return null; }
        if (Cache.TryGetValue(date, out var c) &&
            (c.Length == fi.Length || DateTime.UtcNow - c.BuiltAt < TimeSpan.FromMinutes(2)))
            return c;

        var map = new Dictionary<string, List<Dep>>();
        try
        {
            using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            using var sr = new StreamReader(fs);
            string? line;
            while ((line = sr.ReadLine()) != null)
            {
                if (!line.Contains("\"DEPART\"") || !line.Contains("\"gate\"")) continue;
                try
                {
                    using var doc = JsonDocument.Parse(line);
                    var r = doc.RootElement;
                    string S(string n) => r.TryGetProperty(n, out var p) && p.ValueKind == JsonValueKind.String ? p.GetString() ?? "" : "";
                    var gate = S("gate"); var apt = S("airport"); var cs = S("aircraftId");
                    if (gate.Length == 0 || apt.Length == 0 || cs.Length == 0) continue;
                    DateTime t = default;
                    foreach (var n in new[] { "takeoffTime", "taxiTime", "time" })
                        if (DateTime.TryParse(S(n), null, System.Globalization.DateTimeStyles.AdjustToUniversal, out t)) break;
                    if (t == default) continue;
                    var k = Key(apt, cs);
                    if (!map.TryGetValue(k, out var list)) map[k] = list = new List<Dep>();
                    var rwy = S("runway");
                    list.Add(new Dep(t, gate, rwy.Length > 0 ? rwy : null));
                }
                catch { /* torn / partial line */ }
            }
        }
        catch { return c; }

        var day = new Day(map, fi.Length, DateTime.UtcNow);
        Cache[date] = day;
        if (Cache.Count > MaxDays)
            foreach (var old in Cache.Keys.OrderBy(k => k).Take(Cache.Count - MaxDays).ToList())
                Cache.TryRemove(old, out _);
        return day;
    }
}
