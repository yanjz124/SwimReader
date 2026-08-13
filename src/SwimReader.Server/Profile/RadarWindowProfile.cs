using System.Xml.Serialization;
using SwimReader.Server.Ca;

namespace SwimReader.Server.Profile;

/// <summary>
/// The subset of DGScope's <c>&lt;RadarWindow&gt;</c> profile XML that the server-side alert engines
/// need. This is the exact format the DGScope profile-manager emits and DGScope itself loads — we
/// deserialize it with XmlSerializer, which maps by element name and silently ignores every element
/// not declared here (so the full RadarWindow config passes through untouched). Element names and the
/// nested types (CASuppressionVolume/MSAWVolume/ATPAVolume, GeoPoint) match DGScope 1:1, so the same
/// file drives both the C# engines and — parsed client-side — the JS scope.
/// </summary>
[XmlRoot("RadarWindow")]
public class RadarWindowProfile
{
    // ── Conflict Alert (STCA) ─────────────────────────────────────────────────
    public bool ConflictAlertActive { get; set; } = true;
    public int ConflictAlertLookAheadSeconds { get; set; } = 5;
    public double ConflictAlertHorizontalSeparation { get; set; } = 3;
    public int ConflictAlertVerticalSeparation { get; set; } = 1000;

    [XmlArray("ConflictAlertSuppressionVolumes")]
    [XmlArrayItem("CASuppressionVolume")]
    public List<CASuppressionVolume> ConflictAlertSuppressionVolumes { get; set; } = new();

    // ── MSAW ──────────────────────────────────────────────────────────────────
    public bool MSAWActive { get; set; } = true;
    public int MSAWLookAheadSeconds { get; set; } = 30;

    [XmlArray("MSAWVolumes")]
    [XmlArrayItem("MSAWVolume")]
    public List<Msaw.MSAWVolume> MSAWVolumes { get; set; } = new();

    [XmlArray("MSAWSuppressionVolumes")]
    [XmlArrayItem("MSAWVolume")]
    public List<Msaw.MSAWVolume> MSAWSuppressionVolumes { get; set; } = new();

    // ── ATPA ──────────────────────────────────────────────────────────────────
    public bool ATPAActive { get; set; } = true;

    [XmlArray("ATPAVolumes")]
    [XmlArrayItem("ATPAVolume")]
    public List<Atpa.ATPAVolume> ATPAVolumes { get; set; } = new();

    // ── Video maps ──────────────────────────────────────────────────────────────
    // References to external .geojson map files (geometry is NOT inline). Filepath is the
    // profile-manager author's local path; we resolve maps server-side by its basename.
    [XmlArray("VideoMapFiles")]
    [XmlArrayItem("VideoMapFile")]
    public List<VideoMapFile> VideoMapFiles { get; set; } = new();

    // Just enough of the pref set to know which maps are displayed by default.
    public PrefSetLite? CurrentPrefSet { get; set; }

    // METAR/altimeter stations shown in the SSA (DGScope <AltimeterStations>).
    [XmlArray("AltimeterStations")]
    [XmlArrayItem("string")]
    public List<string> AltimeterStations { get; set; } = new();
}

public class PrefSetLite
{
    [XmlArray("DisplayedMaps")]
    [XmlArrayItem("int")]
    public List<int> DisplayedMaps { get; set; } = new();
}

/// <summary>One &lt;VideoMapFile&gt; entry from the profile — a reference to an external geojson map.</summary>
public class VideoMapFile
{
    public string? Filepath { get; set; }
    public int MapNumber { get; set; }
    public string? ShortName { get; set; }
    public string? FullName { get; set; }
    public string? BrightnessGroup { get; set; }   // "A" | "B"
    public string? DCBButton { get; set; }          // DCB slot(s), may be comma-separated
    // The profile's Filepath is the author's Windows path; extract the basename handling BOTH
    // separators (Path.GetFileName on Linux doesn't treat '\' as a separator, so it wouldn't split it).
    [System.Xml.Serialization.XmlIgnore]
    public string? BaseName => string.IsNullOrEmpty(Filepath) ? null : Filepath.Replace('\\', '/').Split('/').Last();
}
