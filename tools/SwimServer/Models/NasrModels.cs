namespace SwimServer;

record NavPoint(string Ident, double Lat, double Lon, string Type = "");
record AirportOverlayPoint(string Lid, string Icao, double Lat, double Lon, string Cls);
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
    public string EffectiveDate { get; set; } = "";
}
