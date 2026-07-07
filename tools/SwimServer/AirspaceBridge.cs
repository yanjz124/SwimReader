using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using SolaceSystems.Solclient.Messaging;

namespace SwimServer;

/// <summary>
/// Ingests SWIM AIRSPACE AIXM sector-assignment snapshots from the FDPS queue.
/// Facility (ARTCC) is taken from Solace user-property headers and/or the topic —
/// it is not present in the XML payload.
/// </summary>
sealed class AirspaceBridge
{
    static readonly Regex ArtccRegex = new(@"\b(Z[A-Z]{2})\b", RegexOptions.Compiled);
    static readonly Regex AixmHint = new(
        @"SectorAssignmentStatus|AirspaceTimeSlice|<\w*:?Airspace\b",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    readonly ConcurrentDictionary<string, FacilitySplitMap> _assignments = new(StringComparer.OrdinalIgnoreCase);

    public long MessageCount;
    public long ParseSuccessCount;
    string? _lastSampleXml;
    string? _lastFacility;
    Dictionary<string, string>? _lastHeaders;
    string? _cacheDir;

    public void SetCacheDir(string dir) => _cacheDir = dir;

    public bool LooksLikeAixm(string body) =>
        body.Contains("aixm", StringComparison.OrdinalIgnoreCase) || AixmHint.IsMatch(body);

    public bool TryProcess(IMessage message, string body)
    {
        if (!LooksLikeAixm(body)) return false;

        Interlocked.Increment(ref MessageCount);
        _lastSampleXml = body.Length > 200_000 ? body[..200_000] : body;

        var facility = ExtractFacility(message);
        if (facility is null)
        {
            if (MessageCount <= 5 || MessageCount % 100 == 0)
                Console.WriteLine($"[AIRSPACE] AIXM message #{MessageCount} — facility unknown (check user properties / topic)");
            return true;
        }

        if (!TryParseAssignments(body, out var positions))
        {
            if (MessageCount <= 5)
                Console.WriteLine($"[AIRSPACE] AIXM for {facility} — no SectorAssignmentStatus data parsed");
            return true;
        }

        var sectorToGroup = BuildSectorToGroup(positions);
        var map = new FacilitySplitMap
        {
            Facility = facility,
            UpdatedAt = DateTime.UtcNow,
            Source = "aixm",
            Positions = positions,
            SectorToGroup = sectorToGroup,
        };

        _assignments[facility] = map;
        _lastFacility = facility;
        Interlocked.Increment(ref ParseSuccessCount);

        if (ParseSuccessCount <= 3 || ParseSuccessCount % 50 == 0)
        {
            var posSummary = string.Join(", ", positions.Select(p =>
                $"{p.PrimarySector}→[{string.Join(",", p.ControlledSectors)}]"));
            Console.WriteLine($"[AIRSPACE] {facility} updated — {positions.Length} position(s): {posSummary}");
        }

        if (_cacheDir is not null) Save(_cacheDir);

        return true;
    }

    public FacilitySplitMap? Get(string facility) =>
        _assignments.TryGetValue(facility.Trim().ToUpperInvariant(), out var m) ? m : null;

    public IReadOnlyList<FacilitySplitMap> GetAll() => _assignments.Values.OrderBy(m => m.Facility).ToList();

    public object DebugInfo() => new
    {
        messageCount = MessageCount,
        parseSuccessCount = ParseSuccessCount,
        facilities = _assignments.Keys.OrderBy(k => k).ToArray(),
        lastFacility = _lastFacility,
        lastHeaders = _lastHeaders,
        hasSample = _lastSampleXml is not null,
    };

    public string? GetSampleXml() => _lastSampleXml;

    // ── Facility extraction (Solace headers / topic) ────────────────────────

    string? ExtractFacility(IMessage message)
    {
        var headers = ExtractUserProperties(message);
        _lastHeaders = headers.Count > 0 ? headers : null;

        // Explicit property names seen in SWIM / FAA feeds (best-effort).
        foreach (var key in new[] { "centre", "center", "artcc", "facility", "unitIdentifier", "controllingUnit", "airspaceCentre", "airspaceCenter" })
        {
            if (headers.TryGetValue(key, out var val) && TryParseArtcc(val, out var fac))
                return fac;
        }

        foreach (var kv in headers)
        {
            if (TryParseArtcc(kv.Value, out var fac)) return fac;
            if (ArtccRegex.Match(kv.Key).Success && TryParseArtcc(kv.Key, out fac)) return fac;
        }

        var topic = message.Destination?.Name;
        if (!string.IsNullOrEmpty(topic) && TryParseArtcc(topic, out var fromTopic))
            return fromTopic;

        return null;
    }

    static Dictionary<string, string> ExtractUserProperties(IMessage message)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var map = message.UserPropertyMap;
        if (map is null) return result;

        try
        {
            while (true)
            {
                var kv = map.GetNext();
                if (kv.Key is null) break;
                var field = kv.Value;
                if (field is null) continue;
                result[kv.Key] = field.ToString() ?? "";
            }
        }
        catch { /* best-effort */ }

        return result;
    }

    static bool TryParseArtcc(string? text, out string facility)
    {
        facility = "";
        if (string.IsNullOrWhiteSpace(text)) return false;
        var m = ArtccRegex.Match(text.ToUpperInvariant());
        if (!m.Success) return false;
        facility = m.Groups[1].Value;
        return true;
    }

    // ── AIXM parsing ────────────────────────────────────────────────────────

    internal static bool TryParseAssignments(string body, out SplitPosition[] positions)
    {
        positions = Array.Empty<SplitPosition>();
        try
        {
            var doc = XDocument.Parse(body);
            if (doc.Root is null) return false;

            var slices = doc.Descendants()
                .Where(e => e.Name.LocalName is "AirspaceTimeSlice" or "Airspace")
                .ToList();

            if (slices.Count == 0)
                slices = doc.Descendants().Where(e => e.Name.LocalName == "timeSlice").ToList();

            var list = new List<SplitPosition>();
            foreach (var slice in slices)
            {
                var designator = slice.Descendants()
                    .FirstOrDefault(e => e.Name.LocalName == "designator")?.Value?.Trim();
                if (string.IsNullOrEmpty(designator)) continue;

                var ext = slice.Descendants()
                    .FirstOrDefault(e => e.Name.LocalName == "SectorAssignmentStatusExtension");
                if (ext is null) continue;

                var favs = ext.Descendants()
                    .Where(e => e.Name.LocalName == "FAVnumber")
                    .Select(e => e.Value.Trim())
                    .Where(v => v.Length >= 2)
                    .ToList();

                if (favs.Count == 0) continue;

                var controlled = favs
                    .Select(f => NormalizeSectorId(f[..2]))
                    .Distinct(StringComparer.OrdinalIgnoreCase)
                    .OrderBy(s => s, SectorIdComparer.Instance)
                    .ToArray();

                list.Add(new SplitPosition
                {
                    PrimarySector = NormalizeSectorId(designator),
                    ControlledSectors = controlled,
                    FavNumbers = favs.ToArray(),
                });
            }

            positions = list.ToArray();
            return positions.Length > 0;
        }
        catch
        {
            return false;
        }
    }

    static Dictionary<string, string> BuildSectorToGroup(IEnumerable<SplitPosition> positions)
    {
        var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var pos in positions)
        {
            foreach (var sec in pos.ControlledSectors)
                map[sec] = pos.PrimarySector;
        }
        return map;
    }

    internal static string NormalizeSectorId(string id)
    {
        id = id.Trim().ToUpperInvariant();
        // Strip leading zeros for numeric sectors (032 → 32) but keep suffixes (30R).
        var m = Regex.Match(id, @"^0+(\d+)(.*)$");
        return m.Success ? m.Groups[1].Value + m.Groups[2].Value : id;
    }

    // ── Persistence ─────────────────────────────────────────────────────────

    public void Save(string dir)
    {
        try
        {
            Directory.CreateDirectory(dir);
            var path = Path.Combine(dir, "airspace-assignments.json");
            var tmp = path + ".tmp";
            var payload = new Persisted { Assignments = _assignments.Values.ToList() };
            File.WriteAllText(tmp, JsonSerializer.Serialize(payload));
            File.Move(tmp, path, overwrite: true);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[AIRSPACE] save failed: {ex.GetType().Name}: {ex.Message}");
        }
    }

    public void Load(string dir)
    {
        try
        {
            var path = Path.Combine(dir, "airspace-assignments.json");
            if (!File.Exists(path)) return;
            var p = JsonSerializer.Deserialize<Persisted>(File.ReadAllText(path));
            if (p?.Assignments is null) return;
            foreach (var a in p.Assignments)
            {
                if (string.IsNullOrEmpty(a.Facility)) continue;
                a.Facility = a.Facility.ToUpperInvariant();
                if (a.SectorToGroup.Count == 0 && a.Positions.Length > 0)
                    a.SectorToGroup = BuildSectorToGroup(a.Positions);
                _assignments[a.Facility] = a;
            }
            Console.WriteLine($"[AIRSPACE] loaded {_assignments.Count} facility assignment snapshot(s)");
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[AIRSPACE] load failed: {ex.GetType().Name}: {ex.Message}");
        }
    }

    sealed class Persisted
    {
        public List<FacilitySplitMap> Assignments { get; set; } = new();
    }
}

public sealed class SplitPosition
{
    public string PrimarySector { get; set; } = "";
    public string[] ControlledSectors { get; set; } = Array.Empty<string>();
    public string[] FavNumbers { get; set; } = Array.Empty<string>();
}

public sealed class FacilitySplitMap
{
    public string Facility { get; set; } = "";
    public DateTime UpdatedAt { get; set; }
    public string Source { get; set; } = "aixm";
    public SplitPosition[] Positions { get; set; } = Array.Empty<SplitPosition>();
    public Dictionary<string, string> SectorToGroup { get; set; } = new(StringComparer.OrdinalIgnoreCase);
}

/// <summary>Sort sector IDs numerically then by suffix (30, 30R, 32).</summary>
sealed class SectorIdComparer : IComparer<string>
{
    public static readonly SectorIdComparer Instance = new();

    public int Compare(string? a, string? b)
    {
        if (a is null && b is null) return 0;
        if (a is null) return -1;
        if (b is null) return 1;
        var ma = Regex.Match(a, @"^(\d+)(.*)$");
        var mb = Regex.Match(b, @"^(\d+)(.*)$");
        if (ma.Success && mb.Success)
        {
            var na = int.Parse(ma.Groups[1].Value);
            var nb = int.Parse(mb.Groups[1].Value);
            var c = na.CompareTo(nb);
            return c != 0 ? c : string.Compare(ma.Groups[2].Value, mb.Groups[2].Value, StringComparison.OrdinalIgnoreCase);
        }
        return string.Compare(a, b, StringComparison.OrdinalIgnoreCase);
    }
}
