namespace SwimReader.Server.AdsbFi;

public sealed class AdsbFiOptions
{
    public const string SectionName = "AdsbFi";

    public bool Enabled { get; set; }
    public string BaseUrl { get; set; } = "https://opendata.adsb.fi/api/";
    public TimeSpan MinRequestInterval { get; set; } = TimeSpan.FromMilliseconds(1100);
    public TimeSpan HexCacheDuration { get; set; } = TimeSpan.FromMinutes(5);
    public TimeSpan GeoCacheDuration { get; set; } = TimeSpan.FromSeconds(30);
    public bool CallsignEnrichmentEnabled { get; set; } = true;
    public bool MilitaryInjectionEnabled { get; set; } = true;
    public TimeSpan MilitaryPollInterval { get; set; } = TimeSpan.FromSeconds(15);
    public int AltitudeProximityFeet { get; set; } = 1000;
    public double PositionProximityNm { get; set; } = 5.0;
    public List<FacilityCoverage> Facilities { get; set; } = [];

    /// <summary>
    /// Large regional geo queries for enrichment. Each region is a 250 NM circle.
    /// One API call per region, results combined for all-facility matching.
    /// Default: 5 circles covering CONUS.
    /// </summary>
    public List<GeoRegion> EnrichmentRegions { get; set; } =
    [
        new() { Name = "NE",      Latitude = 38.0,  Longitude = -77.0,  RadiusNm = 250 },
        new() { Name = "SE",      Latitude = 30.0,  Longitude = -84.0,  RadiusNm = 250 },
        new() { Name = "Central", Latitude = 41.0,  Longitude = -90.0,  RadiusNm = 250 },
        new() { Name = "South",   Latitude = 34.0,  Longitude = -100.0, RadiusNm = 250 },
        new() { Name = "West",    Latitude = 37.0,  Longitude = -120.0, RadiusNm = 250 },
    ];

    public TimeSpan EnrichmentRegionRefresh { get; set; } = TimeSpan.FromSeconds(60);
}

public sealed class FacilityCoverage
{
    public required string FacilityId { get; set; }
    public double CenterLatitude { get; set; }
    public double CenterLongitude { get; set; }
    public int RadiusNm { get; set; } = 150;
}

public sealed class GeoRegion
{
    public string Name { get; set; } = "";
    public double Latitude { get; set; }
    public double Longitude { get; set; }
    public int RadiusNm { get; set; } = 250;
}
