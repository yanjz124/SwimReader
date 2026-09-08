using System.Globalization;
using System.IO.Compression;
using System.Text.Json;

namespace SwimServer;

/// <summary>
/// Request to permanently archive an incident/accident window: a callsign and/or an area
/// (explicit bbox, or a radius around one or more airports) over a UTC time window.
/// </summary>
public sealed class IncidentRequest
{
    public string? Title { get; set; }
    public string? Callsign { get; set; }
    public string[]? Airports { get; set; }           // ASDE-X airports to capture (ICAO, e.g. KMIA)
    public double? MinLat { get; set; }
    public double? MinLon { get; set; }
    public double? MaxLat { get; set; }
    public double? MaxLon { get; set; }
    public double? AroundNm { get; set; }              // if set with Airports, build the ERAM bbox around them
    public DateTime StartUtc { get; set; }
    public DateTime EndUtc { get; set; }
    public string? Notes { get; set; }
}

public sealed class IncidentMeta
{
    public string Id { get; set; } = "";
    public string? Title { get; set; }
    public string? Callsign { get; set; }
    public string[] Airports { get; set; } = Array.Empty<string>();
    public double? MinLat { get; set; }
    public double? MinLon { get; set; }
    public double? MaxLat { get; set; }
    public double? MaxLon { get; set; }
    public DateTime StartUtc { get; set; }
    public DateTime EndUtc { get; set; }
    public DateTime CreatedUtc { get; set; }
    public string? Notes { get; set; }
    public long EramRecords { get; set; }
    public Dictionary<string, long> AsdexRecords { get; set; } = new();
    public Dictionary<string, long> TaisRecords { get; set; } = new();   // facility → record count
    public long TotalBytes { get; set; }
    public bool HasFlightPlan { get; set; }
    public string CapturedSources { get; set; } = "";
}

/// <summary>
/// Archives incident windows by slicing the live replay files (ERAM en-route + per-airport ASDE-X
/// surface + per-facility TAIS/STARS terminal) into a permanent per-incident directory, plus the
/// flight plan. Slices keep the exact {t,k,d} hourly-gz format, so they replay through the same
/// ReplayServer engine. The incidents dir lives OUTSIDE the budget-managed replay dir, so archived
/// incidents are never pruned.
///
/// Capture semantics: the area (explicit bbox, or a radius around the given airports) keeps EVERY
/// track inside it — the whole en-route + terminal picture, not just the incident flight. ASDE-X
/// keeps every surface track at each airport. When only a callsign is given, the incident flight's
/// own ERAM track is first swept to build a padded corridor bbox, so "everything along the flight
/// path" is captured too.
/// </summary>
public sealed class IncidentArchive
{
    private readonly string _incidentsDir;
    private readonly string _replayDir;                                   // .../replay
    private readonly Func<IncidentRequest, object> _captureFlightPlan;    // live + history lookup (Program.cs)
    private readonly Func<string, (double lat, double lon)?> _airportLoc; // NASR airport lookup (Program.cs)
    private readonly JsonSerializerOptions _json =
        new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull };

    public IncidentArchive(string incidentsDir, string replayDir,
        Func<IncidentRequest, object> captureFlightPlan,
        Func<string, (double, double)?> airportLoc)
    {
        _incidentsDir = incidentsDir;
        _replayDir = replayDir;
        _captureFlightPlan = captureFlightPlan;
        _airportLoc = airportLoc;
        Directory.CreateDirectory(_incidentsDir);
    }

    public string IncidentDir(string id) => Path.Combine(_incidentsDir, id);

    /// <summary>Extract + persist an incident. Runs synchronously (I/O-bound over the replay files).</summary>
    public IncidentMeta Create(IncidentRequest req)
    {
        if (req.EndUtc <= req.StartUtc) throw new ArgumentException("EndUtc must be after StartUtc");
        var callsign = string.IsNullOrWhiteSpace(req.Callsign) ? null : req.Callsign.Trim().ToUpperInvariant();
        var airports = (req.Airports ?? Array.Empty<string>())
            .Select(a => a.Trim().ToUpperInvariant()).Where(a => a.Length > 0).Distinct().ToArray();

        // Resolve the area bbox: explicit, or a radius (deg) around the given airports.
        var bbox = ResolveBbox(req, airports);

        // Callsign-only (no explicit/airport area): sweep the incident flight's own ERAM track and
        // build a padded corridor bbox around it, so we capture EVERYTHING along the flight path
        // (surrounding traffic + terminal), not just the one aircraft.
        if (callsign != null)
        {
            double padDeg = (req.AroundNm ?? 50.0) / 60.0;   // default 50 NM corridor either side
            var pathBox = ComputeCallsignBbox(Path.Combine(_replayDir, "eram"), req.StartUtc, req.EndUtc, callsign, padDeg);
            if (pathBox != null)
                bbox = bbox == null ? pathBox : Union(bbox.Value, pathBox.Value);
        }

        if (callsign == null && bbox == null)
            throw new ArgumentException("Provide a callsign and/or an area (bbox or airports + aroundNm).");

        var id = DateTime.UtcNow.ToString("yyyyMMdd-HHmmss") + "-" + Slug(req.Title ?? callsign ?? "incident");
        var dir = IncidentDir(id);
        Directory.CreateDirectory(dir);

        // ── ERAM slice — flights matching the callsign OR inside the area ────────────
        long eramRecords = 0;
        Func<JsonElement, bool> keepEram = s =>
        {
            if (callsign != null && s.TryGetProperty("callsign", out var c) && c.ValueKind == JsonValueKind.String
                && string.Equals(c.GetString(), callsign, StringComparison.OrdinalIgnoreCase)) return true;
            if (bbox != null && s.TryGetProperty("latitude", out var la) && s.TryGetProperty("longitude", out var lo)
                && la.ValueKind == JsonValueKind.Number && lo.ValueKind == JsonValueKind.Number)
            {
                double lat = la.GetDouble(), lon = lo.GetDouble();
                if (lat >= bbox.Value.minLat && lat <= bbox.Value.maxLat
                    && lon >= bbox.Value.minLon && lon <= bbox.Value.maxLon) return true;
            }
            return false;
        };
        eramRecords = SliceReplay(Path.Combine(_replayDir, "eram"), Path.Combine(dir, "eram"),
            req.StartUtc, req.EndUtc, keepEram);

        // ── ASDE-X slice — the FULL surface picture at each airport in the window ─────
        var asdexRecords = new Dictionary<string, long>();
        foreach (var ap in airports)
        {
            var recs = SliceReplay(Path.Combine(_replayDir, "asdex", ap), Path.Combine(dir, "asdex", ap),
                req.StartUtc, req.EndUtc, keepSummary: null);   // keep every surface track
            if (recs > 0) asdexRecords[ap] = recs;
        }

        // ── TAIS / STARS terminal slice — every terminal facility whose tracks intersect the ────
        // area (or match the callsign). TAIS summaries use lat/lon (not latitude/longitude).
        var taisRecords = new Dictionary<string, long>();
        var taisBase = Path.Combine(_replayDir, "tais");
        if (Directory.Exists(taisBase) && (callsign != null || bbox != null))
        {
            Func<JsonElement, bool> keepTais = s =>
            {
                if (callsign != null && s.TryGetProperty("callsign", out var c) && c.ValueKind == JsonValueKind.String
                    && string.Equals(c.GetString(), callsign, StringComparison.OrdinalIgnoreCase)) return true;
                if (bbox != null && s.TryGetProperty("lat", out var la) && s.TryGetProperty("lon", out var lo)
                    && la.ValueKind == JsonValueKind.Number && lo.ValueKind == JsonValueKind.Number)
                {
                    double lat = la.GetDouble(), lon = lo.GetDouble();
                    if (lat >= bbox.Value.minLat && lat <= bbox.Value.maxLat
                        && lon >= bbox.Value.minLon && lon <= bbox.Value.maxLon) return true;
                }
                return false;
            };
            foreach (var facDir in Directory.GetDirectories(taisBase))
            {
                var fac = Path.GetFileName(facDir);
                var recs = SliceReplay(facDir, Path.Combine(dir, "tais", fac),
                    req.StartUtc, req.EndUtc, keepTais);
                if (recs > 0) taisRecords[fac] = recs;
            }
        }

        // ── Flight plan (live snapshot + persisted history) ──────────────────────────
        bool hasFp = false;
        if (callsign != null)
        {
            try
            {
                var fp = _captureFlightPlan(req);
                File.WriteAllText(Path.Combine(dir, "flightplan.json"), JsonSerializer.Serialize(fp, _json));
                hasFp = true;
            }
            catch { /* best-effort */ }
        }

        long total = 0;
        foreach (var f in Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories)) total += new FileInfo(f).Length;

        var sources = new List<string>();
        if (eramRecords > 0) sources.Add("ERAM");
        if (asdexRecords.Count > 0) sources.Add("ASDE-X");
        if (taisRecords.Count > 0) sources.Add("STARS/TAIS");
        if (hasFp) sources.Add("flight plan");

        var meta = new IncidentMeta
        {
            Id = id, Title = req.Title, Callsign = callsign, Airports = airports,
            MinLat = bbox?.minLat, MinLon = bbox?.minLon, MaxLat = bbox?.maxLat, MaxLon = bbox?.maxLon,
            StartUtc = req.StartUtc, EndUtc = req.EndUtc, CreatedUtc = DateTime.UtcNow, Notes = req.Notes,
            EramRecords = eramRecords, AsdexRecords = asdexRecords, TaisRecords = taisRecords, TotalBytes = total,
            HasFlightPlan = hasFp, CapturedSources = string.Join(", ", sources),
        };
        File.WriteAllText(Path.Combine(dir, "meta.json"), JsonSerializer.Serialize(meta, _json));
        return meta;
    }

    public List<IncidentMeta> List()
    {
        var list = new List<IncidentMeta>();
        if (!Directory.Exists(_incidentsDir)) return list;
        foreach (var d in Directory.GetDirectories(_incidentsDir))
        {
            var m = ReadMeta(Path.GetFileName(d));
            if (m != null) list.Add(m);
        }
        return list.OrderByDescending(m => m.CreatedUtc).ToList();
    }

    public IncidentMeta? ReadMeta(string id)
    {
        var f = Path.Combine(IncidentDir(id), "meta.json");
        if (!File.Exists(f)) return null;
        try { return JsonSerializer.Deserialize<IncidentMeta>(File.ReadAllText(f), _json); } catch { return null; }
    }

    public string? FlightPlanPath(string id)
    {
        var f = Path.Combine(IncidentDir(id), "flightplan.json");
        return File.Exists(f) ? f : null;
    }

    public bool Delete(string id)
    {
        // id is a single path segment (validated by caller); refuse anything with separators.
        if (id.Contains('/') || id.Contains('\\') || id.Contains("..")) return false;
        var dir = IncidentDir(id);
        if (!Directory.Exists(dir)) return false;
        Directory.Delete(dir, recursive: true);
        return true;
    }

    // ── internals ────────────────────────────────────────────────────────────────────
    private (double minLat, double minLon, double maxLat, double maxLon)? ResolveBbox(IncidentRequest req, string[] airports)
    {
        if (req.MinLat is { } mnla && req.MinLon is { } mnlo && req.MaxLat is { } mxla && req.MaxLon is { } mxlo)
            return (Math.Min(mnla, mxla), Math.Min(mnlo, mxlo), Math.Max(mnla, mxla), Math.Max(mnlo, mxlo));
        if (req.AroundNm is { } nm && airports.Length > 0)
        {
            double deg = nm / 60.0;   // 1° lat ≈ 60 NM (lon approximated the same for a generous box)
            double? mnLa = null, mnLo = null, mxLa = null, mxLo = null;
            foreach (var ap in airports)
            {
                var loc = _airportLoc(ap);
                if (loc is null) continue;
                mnLa = Math.Min(mnLa ?? loc.Value.lat - deg, loc.Value.lat - deg);
                mxLa = Math.Max(mxLa ?? loc.Value.lat + deg, loc.Value.lat + deg);
                mnLo = Math.Min(mnLo ?? loc.Value.lon - deg, loc.Value.lon - deg);
                mxLo = Math.Max(mxLo ?? loc.Value.lon + deg, loc.Value.lon + deg);
            }
            if (mnLa != null) return (mnLa!.Value, mnLo!.Value, mxLa!.Value, mxLo!.Value);
        }
        return null;
    }

    private static (double minLat, double minLon, double maxLat, double maxLon) Union(
        (double minLat, double minLon, double maxLat, double maxLon) a,
        (double minLat, double minLon, double maxLat, double maxLon) b) =>
        (Math.Min(a.minLat, b.minLat), Math.Min(a.minLon, b.minLon),
         Math.Max(a.maxLat, b.maxLat), Math.Max(a.maxLon, b.maxLon));

    /// <summary>
    /// Sweep the ERAM replay files in [start,end] for the callsign's own positions and return a
    /// bounding box of its track, padded by <paramref name="padDeg"/> degrees on every side. Returns
    /// null if the callsign is never seen (e.g. LADD-masked or outside the recorded window).
    /// </summary>
    private (double minLat, double minLon, double maxLat, double maxLon)? ComputeCallsignBbox(
        string eramDir, DateTime start, DateTime end, string callsign, double padDeg)
    {
        if (!Directory.Exists(eramDir)) return null;
        long startMs = new DateTimeOffset(start, TimeSpan.Zero).ToUnixTimeMilliseconds();
        long endMs = new DateTimeOffset(end, TimeSpan.Zero).ToUnixTimeMilliseconds();
        double mnLa = double.MaxValue, mnLo = double.MaxValue, mxLa = double.MinValue, mxLo = double.MinValue;
        bool any = false;

        foreach (var file in Directory.GetFiles(eramDir, "*.jsonl.gz").OrderBy(f => f, StringComparer.Ordinal))
        {
            var stem = Path.GetFileName(file).Replace(".jsonl.gz", "");
            var hourStr = stem.Length >= 13 ? stem[..13] : stem;
            if (DateTime.TryParseExact(hourStr, "yyyy-MM-dd'T'HH", CultureInfo.InvariantCulture,
                    DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var fileHour))
                if (fileHour < start.AddHours(-1) || fileHour > end) continue;

            using var fs = File.OpenRead(file);
            using var gz = new GZipStream(fs, CompressionMode.Decompress);
            using var sr = new StreamReader(gz);
            string? line;
            while ((line = sr.ReadLine()) != null)
            {
                if (line.Length == 0) continue;
                JsonDocument doc;
                try { doc = JsonDocument.Parse(line); } catch { continue; }
                using (doc)
                {
                    var root = doc.RootElement;
                    if (!root.TryGetProperty("t", out var tEl) || tEl.ValueKind != JsonValueKind.Number) continue;
                    long t = tEl.GetInt64();
                    if (t < startMs || t > endMs) continue;
                    if (!root.TryGetProperty("d", out var dEl) || dEl.ValueKind != JsonValueKind.Array) continue;
                    foreach (var s in dEl.EnumerateArray())
                    {
                        if (!s.TryGetProperty("callsign", out var c) || c.ValueKind != JsonValueKind.String
                            || !string.Equals(c.GetString(), callsign, StringComparison.OrdinalIgnoreCase)) continue;
                        if (!s.TryGetProperty("latitude", out var la) || !s.TryGetProperty("longitude", out var lo)
                            || la.ValueKind != JsonValueKind.Number || lo.ValueKind != JsonValueKind.Number) continue;
                        double lat = la.GetDouble(), lon = lo.GetDouble();
                        mnLa = Math.Min(mnLa, lat); mxLa = Math.Max(mxLa, lat);
                        mnLo = Math.Min(mnLo, lon); mxLo = Math.Max(mxLo, lon);
                        any = true;
                    }
                }
            }
        }
        if (!any) return null;
        return (mnLa - padDeg, mnLo - padDeg, mxLa + padDeg, mxLo + padDeg);
    }

    /// <summary>
    /// Copy the {t,k,d} records within [start,end] from srcDir's hourly gz files into dstDir's hourly
    /// gz files. For batch/snapshot records (arrays), keeps only summaries where keepSummary is true
    /// (null = keep the whole record). Removes/holdbars pass through. Returns the record count written.
    /// </summary>
    private long SliceReplay(string srcDir, string dstDir, DateTime start, DateTime end, Func<JsonElement, bool>? keepSummary)
    {
        if (!Directory.Exists(srcDir)) return 0;
        long startMs = new DateTimeOffset(start, TimeSpan.Zero).ToUnixTimeMilliseconds();
        long endMs = new DateTimeOffset(end, TimeSpan.Zero).ToUnixTimeMilliseconds();
        long count = 0;
        var writers = new Dictionary<string, (FileStream fs, GZipStream gz, StreamWriter sw)>();

        StreamWriter WriterFor(long t)
        {
            var dt = DateTimeOffset.FromUnixTimeMilliseconds(t).UtcDateTime;
            var hour = dt.ToString("yyyy-MM-dd'T'HH");
            if (!writers.TryGetValue(hour, out var w))
            {
                Directory.CreateDirectory(dstDir);
                var fs = new FileStream(Path.Combine(dstDir, hour + ".jsonl.gz"), FileMode.Create, FileAccess.Write);
                var gz = new GZipStream(fs, CompressionLevel.Optimal, leaveOpen: true);
                var sw = new StreamWriter(gz, leaveOpen: true);
                w = (fs, gz, sw); writers[hour] = w;
            }
            return w.sw;
        }

        try
        {
            foreach (var file in Directory.GetFiles(srcDir, "*.jsonl.gz").OrderBy(f => f, StringComparer.Ordinal))
            {
                // Skip files whose hour can't overlap the window (allow 1h lead so a seek snapshot is included).
                var stem = Path.GetFileName(file).Replace(".jsonl.gz", "");
                var hourStr = stem.Length >= 13 ? stem[..13] : stem;
                if (DateTime.TryParseExact(hourStr, "yyyy-MM-dd'T'HH", CultureInfo.InvariantCulture,
                        DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var fileHour))
                {
                    if (fileHour < start.AddHours(-1) || fileHour > end) continue;
                }

                using var fs = File.OpenRead(file);
                using var gz = new GZipStream(fs, CompressionMode.Decompress);
                using var sr = new StreamReader(gz);
                string? line;
                while ((line = sr.ReadLine()) != null)
                {
                    if (line.Length == 0) continue;
                    JsonDocument doc;
                    try { doc = JsonDocument.Parse(line); } catch { continue; }
                    using (doc)
                    {
                        var root = doc.RootElement;
                        if (!root.TryGetProperty("t", out var tEl) || tEl.ValueKind != JsonValueKind.Number) continue;
                        long t = tEl.GetInt64();
                        if (t < startMs || t > endMs) continue;
                        var kind = root.TryGetProperty("k", out var kEl) ? (kEl.GetString() ?? "B") : "B";
                        if (!root.TryGetProperty("d", out var dEl)) continue;

                        string outLine;
                        if (keepSummary != null && (kind == "B" || kind == "S") && dEl.ValueKind == JsonValueKind.Array)
                        {
                            var kept = new List<JsonElement>();
                            foreach (var s in dEl.EnumerateArray()) if (keepSummary(s)) kept.Add(s);
                            if (kept.Count == 0) continue;   // nothing relevant in this record
                            outLine = "{\"t\":" + t + ",\"k\":\"" + kind + "\",\"d\":["
                                + string.Join(",", kept.Select(e => e.GetRawText())) + "]}";
                        }
                        else
                        {
                            outLine = "{\"t\":" + t + ",\"k\":\"" + kind + "\",\"d\":" + dEl.GetRawText() + "}";
                        }
                        WriterFor(t).WriteLine(outLine);
                        count++;
                    }
                }
            }
        }
        finally
        {
            foreach (var w in writers.Values) { try { w.sw.Flush(); w.gz.Flush(); w.sw.Dispose(); w.gz.Dispose(); w.fs.Dispose(); } catch { } }
        }
        return count;
    }

    private static string Slug(string s)
    {
        var chars = s.Trim().ToUpperInvariant()
            .Select(c => char.IsLetterOrDigit(c) ? c : '-').ToArray();
        var slug = new string(chars).Trim('-');
        while (slug.Contains("--")) slug = slug.Replace("--", "-");
        return slug.Length > 40 ? slug[..40] : (slug.Length == 0 ? "incident" : slug);
    }
}
