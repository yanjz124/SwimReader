namespace SwimServer;

/// <summary>
/// FAA LADD (Limiting Aircraft Data Displayed) compliance.
///
/// The FAA SWIM Terms of Service require blocking any general-aviation / on-demand
/// aircraft <b>registration, call sign, or flight number</b> that appears on the
/// monthly "IndustryLADD" list — from BOTH real-time and historical display and
/// distribution. This service loads that list and answers <see cref="IsBlocked"/>;
/// callers drop matching aircraft at ingestion so they never enter the flight
/// store, history files, exports, or any frontend.
///
/// <para><b>Operator setup (required for compliance):</b> the SCDS account holder
/// downloads the "IndustryLADD" file from the FAA ADX portal (https://adx.faa.gov,
/// SCBlockAtIndustry community) on/after the first Thursday of each month and drops
/// it in <c>&lt;working-dir&gt;/ladd/</c> (any <c>.txt</c> or <c>.csv</c>). We
/// reload every few hours, so a monthly update is picked up within a day without a
/// restart. The list must be updated within FIVE business days of publication.</para>
///
/// <para>If no file is present the block set is empty and NOTHING is filtered — a
/// prominent WARNING is logged so it's obvious LADD is inactive.</para>
/// </summary>
static class LaddService
{
    // Immutable snapshot swapped atomically on reload; readers never lock.
    private static volatile HashSet<string> _blocked = new(StringComparer.OrdinalIgnoreCase);
    private static string _dir = "ladd";
    private static DateTime _loadedAt = DateTime.MinValue;
    private static volatile int _count;

    public static int Count => _count;
    public static DateTime LoadedAt => _loadedAt;
    public static bool Active => _count > 0;
    public static string Directory_ => _dir;

    public static void Init(string workingDir)
    {
        _dir = Path.Combine(workingDir, "ladd");
        try { Directory.CreateDirectory(_dir); } catch { /* best effort */ }
        Load();
        // Reload periodically so a fresh monthly list is picked up without a restart.
        _ = Task.Run(async () =>
        {
            while (true)
            {
                await Task.Delay(TimeSpan.FromHours(6));
                Load();
            }
        });
    }

    /// <summary>True if this call sign or registration is on the LADD list and must
    /// be blocked. Cheap no-op (returns false) when no list is loaded.</summary>
    public static bool IsBlocked(string? callsign, string? registration)
    {
        if (_count == 0) return false;
        var set = _blocked;
        if (!string.IsNullOrEmpty(callsign) && set.Contains(Normalize(callsign))) return true;
        if (!string.IsNullOrEmpty(registration) && set.Contains(Normalize(registration))) return true;
        return false;
    }

    // Identifiers are matched case-insensitively with dashes/spaces removed, so the
    // list's "N123-AB" matches a feed's "N123AB" (and vice-versa).
    private static string Normalize(string s)
    {
        Span<char> buf = stackalloc char[s.Length];
        int n = 0;
        foreach (var c in s)
            if (c is not ('-' or ' ' or '.')) buf[n++] = char.ToUpperInvariant(c);
        return new string(buf[..n]);
    }

    public static void Load()
    {
        try
        {
            if (!System.IO.Directory.Exists(_dir)) { WarnInactive(); return; }
            var files = System.IO.Directory.GetFiles(_dir, "*.txt")
                .Concat(System.IO.Directory.GetFiles(_dir, "*.csv"))
                .ToArray();
            if (files.Length == 0) { WarnInactive(); return; }

            var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var file in files)
            {
                foreach (var line in File.ReadLines(file))
                {
                    // The ADX list is essentially one identifier per line, but tolerate
                    // CSV/TSV by splitting on common delimiters and taking each token.
                    foreach (var tok in line.Split(new[] { ',', '\t', ';', '|', ' ' },
                             StringSplitOptions.RemoveEmptyEntries))
                    {
                        var t = Normalize(tok);
                        // Registrations/callsigns/flight numbers are 2–10 alphanumerics.
                        if (t.Length is < 2 or > 10) continue;
                        bool alnum = true;
                        foreach (var c in t) if (!char.IsLetterOrDigit(c)) { alnum = false; break; }
                        if (alnum) set.Add(t);
                    }
                }
            }

            _blocked = set;
            _count = set.Count;
            _loadedAt = DateTime.UtcNow;
            Console.WriteLine($"[LADD] Loaded {set.Count} blocked identifiers from {files.Length} file(s) in {_dir}");
            if (set.Count == 0) WarnInactive();
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[LADD] Load error: {ex.Message}");
        }
    }

    private static void WarnInactive()
    {
        _blocked = new(StringComparer.OrdinalIgnoreCase);
        _count = 0;
        Console.WriteLine($"[LADD] *** WARNING: no IndustryLADD list found in '{_dir}' — LADD filtering is INACTIVE. " +
            "Download IndustryLADD from https://adx.faa.gov and place it there to comply with the FAA SWIM Terms of Service. ***");
    }
}
