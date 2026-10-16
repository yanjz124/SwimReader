namespace SwimServer;

record NavPoint(string Ident, double Lat, double Lon, string Type = "");
record AirportOverlayPoint(string Lid, string Icao, double Lat, double Lon, string Cls);

/// <summary>APT_BASE fields the airport pages need beyond a lat/lon: field elevation (for density
/// altitude), magnetic variation (METAR winds are true, runway/ATIS headings are magnetic), and the
/// name/owner details worth printing on a header.</summary>
record AirportInfo(string Lid, string Icao, string Name, string City, string State,
    double Lat, double Lon, double? ElevFt, double? MagVarDeg, string Artcc, string TwrType);

/// <summary>One runway from APT_RWY, with its two ends from APT_RWY_END.</summary>
record RunwayDef(string Id, int? LenFt, int? WidthFt, string Surface, string Lights,
    List<RunwayEnd> Ends);

/// <summary>One runway end. <paramref name="TrueAlign"/> is TRUE_ALIGNMENT — degrees TRUE, which is
/// the same reference a raw METAR's wind uses, so head/crosswind needs no variation applied.</summary>
record RunwayEnd(string Id, double? TrueAlign, double? Lat, double? Lon, double? ElevFt,
    string Ils, int? DisplacedThrFt);
record CenterlinePoint(double Lat1, double Lon1, double Lat2, double Lon2, string Apt, string Rwy);
record AirwayDef(string Id, string Designation, List<string> Fixes);

// Type = "STAR" or "DP"; Transitions keyed by enroute fix name
record ProcedureDef(string Id, string Airport, string Type, List<string> Fixes, Dictionary<string, List<string>> Transitions);

// All body legs + transitions for map overlay
record ProcedureFullDef(string Id, string Airport, string Type, List<List<string>> Legs);

record PositionRecord(double Lat, double Lon, long Ticks, char Sym);

class NasrData
{
    public Dictionary<string, List<NavPoint>> Navaids { get; set; } = new();
    public Dictionary<string, List<NavPoint>> Fixes { get; set; } = new();
    public Dictionary<string, NavPoint> Airports { get; set; } = new();
    public Dictionary<string, NavPoint> AirportsIcao { get; set; } = new();
    public Dictionary<string, AirwayDef> Airways { get; set; } = new();
    public Dictionary<string, List<ProcedureDef>> Procedures { get; set; } = new(); // name → list (may have same name at different airports)
    public Dictionary<string, List<ProcedureFullDef>> ProceduresFull { get; set; } = new(); // full legs for map overlay
    public List<AirportOverlayPoint> AirportOverlay { get; set; } = new(); // public airports with derived airspace class
    public List<CenterlinePoint> Centerlines { get; set; } = new(); // ILS/LOC/LDA approach centerlines
    public Dictionary<string, AirportInfo> AirportInfo { get; set; } = new();      // by FAA LID
    public Dictionary<string, AirportInfo> AirportInfoIcao { get; set; } = new();  // by ICAO id
    public Dictionary<string, List<RunwayDef>> Runways { get; set; } = new();      // by FAA LID
    public string EffectiveDate { get; set; } = "";
}
