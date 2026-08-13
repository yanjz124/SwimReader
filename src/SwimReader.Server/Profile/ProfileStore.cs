using System.Collections.Concurrent;
using System.Xml.Serialization;

namespace SwimReader.Server.Profile;

/// <summary>
/// Loads and caches DGScope <c>&lt;RadarWindow&gt;</c> profile XML per facility from a
/// <c>stars-profiles/</c> directory (searched upward from the app base dir, like the .env lookup).
/// A facility maps to <c>{FACILITY}.xml</c> or <c>{FACILITY}_*.xml</c> anywhere under that root
/// (so e.g. facility RDU matches <c>ZDC/RDU_TRACON.xml</c>). Returns null when no profile exists —
/// callers then fall back to their runway-derived defaults.
/// </summary>
public sealed class ProfileStore
{
    private string? _root;
    private readonly ConcurrentDictionary<string, RadarWindowProfile?> _cache = new(StringComparer.OrdinalIgnoreCase);
    private readonly ILogger? _log;

    public ProfileStore(ILogger<ProfileStore>? log = null)
    {
        _log = log;
        EnsureRoot();
    }

    // The profiles dir may not exist at startup (profiles are placed out-of-band), so re-resolve it
    // lazily rather than caching a permanent null — otherwise adding profiles would need a restart.
    private string? EnsureRoot()
    {
        if (_root != null) return _root;
        _root = FindRoot();
        if (_root != null) _log?.LogInformation("STARS profiles root: {Root}", _root);
        return _root;
    }

    public string? Root => EnsureRoot();

    /// <summary>Loaded profile for a facility, or null. Cached (including negative results).</summary>
    public RadarWindowProfile? Get(string facility) => _cache.GetOrAdd(facility, Load);

    /// <summary>Drop the cache so edited/added profiles reload on next Get (also re-resolves root).</summary>
    public void Invalidate() { _cache.Clear(); _root = FindRoot(); }

    /// <summary>
    /// Store an uploaded DGScope RadarWindow XML profile (produced by the desktop profile-manager)
    /// verbatim at <c>stars-profiles/{FAC}.xml</c> and reload so the engines pick it up. The raw bytes
    /// are written unchanged — every element the profile-manager wrote is preserved, not just the
    /// CA/MSAW/ATPA subset we parse. Validates it deserializes as a RadarWindow first; returns the
    /// parsed profile (for reporting counts) or throws on malformed XML.
    /// </summary>
    public (string File, RadarWindowProfile Parsed) SaveRawXml(string facility, string xml)
    {
        // Validate it's a RadarWindow we can read before persisting.
        var ser = new XmlSerializer(typeof(RadarWindowProfile));
        RadarWindowProfile parsed;
        using (var sr = new StringReader(xml))
            parsed = (RadarWindowProfile)ser.Deserialize(sr)!;

        var root = _root ?? CreateRoot();
        Directory.CreateDirectory(root);
        var file = Path.Combine(root, facility.ToUpperInvariant() + ".xml");
        File.WriteAllText(file, xml);
        _root = root;
        Invalidate();
        _log?.LogInformation("Uploaded STARS profile {File} ({CA} CA, {MSAW} MSAW, {ATPA} ATPA vols)",
            file, parsed.ConflictAlertSuppressionVolumes.Count, parsed.MSAWVolumes.Count, parsed.ATPAVolumes.Count);
        return (file, parsed);
    }

    /// <summary>List every stored profile (filename → parsed counts) for the manager UI.</summary>
    public IEnumerable<(string Name, string File)> List()
    {
        var root = EnsureRoot();
        if (root == null || !Directory.Exists(root)) yield break;
        foreach (var f in Directory.EnumerateFiles(root, "*.xml", SearchOption.AllDirectories))
            yield return (Path.GetFileNameWithoutExtension(f), f);
    }

    // When no stars-profiles/ exists yet, create it at the repo/app root (dir holding the solution or .git).
    private static string CreateRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        for (int i = 0; i < 8 && dir != null; i++, dir = dir.Parent)
            if (File.Exists(Path.Combine(dir.FullName, "SwimReader.sln")) || Directory.Exists(Path.Combine(dir.FullName, ".git")))
                return Path.Combine(dir.FullName, "stars-profiles");
        return Path.Combine(AppContext.BaseDirectory, "stars-profiles");
    }

    private RadarWindowProfile? Load(string facility)
    {
        EnsureRoot();
        var file = FindFile(facility);
        if (file == null) return null;
        try
        {
            using var fs = File.OpenRead(file);
            var ser = new XmlSerializer(typeof(RadarWindowProfile));
            var profile = (RadarWindowProfile?)ser.Deserialize(fs);
            _log?.LogInformation(
                "Loaded STARS profile {File} for {Facility}: {CA} CA vols, {MSAW} MSAW vols, {MSUP} MSAW-suppression",
                Path.GetFileName(file), facility,
                profile?.ConflictAlertSuppressionVolumes.Count ?? 0,
                profile?.MSAWVolumes.Count ?? 0,
                profile?.MSAWSuppressionVolumes.Count ?? 0);
            return profile;
        }
        catch (Exception ex)
        {
            _log?.LogWarning(ex, "Failed to load STARS profile {File}", file);
            return null;
        }
    }

    private string? FindFile(string facility)
    {
        if (_root == null || !Directory.Exists(_root)) return null;
        foreach (var f in Directory.EnumerateFiles(_root, "*.xml", SearchOption.AllDirectories))
        {
            var name = Path.GetFileNameWithoutExtension(f);
            if (name.Equals(facility, StringComparison.OrdinalIgnoreCase) ||
                name.StartsWith(facility + "_", StringComparison.OrdinalIgnoreCase))
                return f;
        }
        return null;
    }

    private static string? FindRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        for (int i = 0; i < 8 && dir != null; i++, dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, "stars-profiles");
            if (Directory.Exists(candidate)) return candidate;
        }
        return null;
    }
}
