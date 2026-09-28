using System.Globalization;
using System.Text.RegularExpressions;

namespace SwimServer;

/// <summary>
/// GET /api/storage — what each persisted dataset holds: how far back it reaches, how much disk it
/// uses, and (for the rolling ones) the cap the budget enforcer trims it to. Shown on the home
/// page's STORAGE card so it's obvious how much replay / history is actually available.
///
/// Coverage comes from the date/hour stamped into each file name ("2026-09-26T06.jsonl.gz",
/// "2026-09-26.jsonl"). Walking ~10k files takes a moment on the Pi's SD card, so the result is
/// cached for a minute.
/// </summary>
static class StorageRoutes
{
    private sealed record Spec(string Key, string Name, string Group, string Path, string Pattern,
        string? Bucket, bool Hourly, string Note);

    private static readonly TimeSpan CacheFor = TimeSpan.FromSeconds(60);
    private static object? _cached;
    private static DateTime _cachedAt = DateTime.MinValue;
    private static readonly SemaphoreSlim Gate = new(1, 1);
    private static readonly Regex Stamp = new(@"^(\d{4}-\d{2}-\d{2})(?:T(\d{2}))?", RegexOptions.Compiled);

    public static void Register(WebApplication app)
    {
        var cwd = Directory.GetCurrentDirectory();
        string P(params string[] parts) => Path.Combine(new[] { cwd }.Concat(parts).ToArray());
        var specs = new[]
        {
            new Spec("eram",   "ERAM replay",       "Rolling replay",  P("replay", "eram"),  ReplayFiles.Pattern, "replay", true,
                     "En-route scope replay; shares the replay cap"),
            new Spec("asdex",  "ASDE-X replay",     "Rolling replay",  P("replay", "asdex"), ReplayFiles.Pattern, "replay", true,
                     "Surface replay, per airport; shares the replay cap"),
            new Spec("tais",   "STARS / TAIS replay","Rolling replay", P("replay", "tais"),  ReplayFiles.Pattern, "replay", true,
                     "Terminal replay, per facility; shares the replay cap"),
            new Spec("history","Flight history",    "Rolling history", P("flight-history"),  "*.jsonl",    "flight-history", false,
                     "Every completed flight plan + events (Route Finder, history search)"),
            new Spec("tdls",   "TDLS history",      "Rolling history", P("tdls-history"),    "*.jsonl",    "tdls-history", false,
                     "Datalink clearances and tower departures"),
            new Spec("itws",   "ITWS history",      "Rolling history", P("itws-history"),    "*",          null, false,
                     "Terminal weather products"),
            new Spec("incidents","Incident archive","Permanent",       P("incidents"),       "*",          null, false,
                     "Archived incident slices — never trimmed"),
            new Spec("aircraft","Aircraft DB",      "Reference",       P("aircraft-db"),     "*",          null, false,
                     "Registration / Mode-S / SELCAL per airframe"),
            new Spec("cache",  "Flight cache",      "Reference",       P("flight-cache"),    "*",          null, false,
                     "Live-flight snapshot restored on restart"),
            new Spec("nasr",   "NASR data",         "Reference",       P("nasr-data"),       "*",          null, false,
                     "FAA navigation data (downloaded every AIRAC)"),
        };

        app.MapGet("/api/storage", async () =>
        {
            if (_cached is not null && DateTime.UtcNow - _cachedAt < CacheFor) return Results.Json(_cached);
            await Gate.WaitAsync();
            try
            {
                if (_cached is null || DateTime.UtcNow - _cachedAt >= CacheFor)
                {
                    _cached = await Task.Run(() => Build(specs, cwd));
                    _cachedAt = DateTime.UtcNow;
                }
                return Results.Json(_cached);
            }
            finally { Gate.Release(); }
        });
    }

    private static object Build(Spec[] specs, string cwd)
    {
        var rows = specs.Select(Scan).Where(r => r is not null).ToList();

        // Rolling caps are per bucket (the three replay feeds share one). Report each bucket once.
        var buckets = specs.Where(s => s.Bucket is not null).Select(s => s.Bucket!).Distinct()
            .Select(b => new
            {
                bucket = b,
                usedBytes = rows.Where(r => r!.bucket == b).Sum(r => r!.bytes),
                capBytes = PersistenceBudget.CapBytes(b),
            }).ToList();

        long? diskFree = null, diskTotal = null;
        try
        {
            var di = new DriveInfo(Path.GetPathRoot(cwd) ?? "/");
            diskFree = di.AvailableFreeSpace; diskTotal = di.TotalSize;
        }
        catch { /* not fatal */ }

        return new { generated = DateTime.UtcNow.ToString("o"), datasets = rows, buckets, diskFreeBytes = diskFree, diskTotalBytes = diskTotal };
    }

    private sealed record Row(string key, string name, string group, string note, string? bucket,
        long bytes, int files, int items, string? oldest, string? newest, double? spanDays);

    private static Row? Scan(Spec s)
    {
        if (!Directory.Exists(s.Path)) return null;
        long bytes = 0; int files = 0;
        DateTime? lo = null, hi = null;
        foreach (var f in Directory.EnumerateFiles(s.Path, s.Pattern, SearchOption.AllDirectories))
        {
            try { bytes += new FileInfo(f).Length; } catch { continue; }
            files++;
            var m = Stamp.Match(Path.GetFileName(f));
            if (!m.Success) continue;
            if (!DateTime.TryParseExact(m.Groups[1].Value, "yyyy-MM-dd", CultureInfo.InvariantCulture,
                    DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var d)) continue;
            var start = m.Groups[2].Success ? d.AddHours(int.Parse(m.Groups[2].Value)) : d;
            var end = m.Groups[2].Success ? start.AddHours(1) : start.AddDays(1);
            if (lo is null || start < lo) lo = start;
            if (hi is null || end > hi) hi = end;
        }
        // The file covering "now" isn't finished; don't report coverage into the future.
        if (hi > DateTime.UtcNow) hi = DateTime.UtcNow;
        // items = top-level entries (e.g. the number of archived incidents / replay feeds' airports).
        int items = 0; try { items = Directory.GetDirectories(s.Path).Length; } catch { }
        return new Row(s.Key, s.Name, s.Group, s.Note, s.Bucket, bytes, files, items,
            lo?.ToString("o"), hi?.ToString("o"),
            lo is not null && hi is not null ? Math.Round((hi.Value - lo.Value).TotalDays, 2) : null);
    }
}
