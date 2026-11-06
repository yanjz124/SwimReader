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
        // Five hand-placed circles used to live here, and they left most of the country
        // uncovered. Measured against the 64 facilities we actually serve, 15 of the 28
        // busiest TRACONs fell outside EVERY region — Seattle by 386 NM, Portland 279,
        // Phoenix 196, Salt Lake 188, Denver 167, Boston 129, plus Houston, Miami, Detroit,
        // Cleveland, Minneapolis, Cincinnati, Nashville, Albuquerque and Palm Beach. A track
        // at one of those could never be enriched: with no ADS-B target anywhere near it,
        // the position tier has nothing to match against, and that showed up as
        // `positionNoCoverage` 1397 against 651 position matches on /diag.
        //
        // This set is generated to cover every facility with 250 NM circles and then pruned
        // to the minimum that still covers them all (20, verified zero uncovered). Regenerate
        // it the same way if the facility list grows — don't nudge circles by hand, which is
        // how the gaps above survived unnoticed.
        //
        // Cost is fine: 20 requests per 60 s refresh, spread over three APIs that each allow
        // ~1/s, so roughly 0.1 req/s per source.
        new() { Name = "Anchorage",   Latitude = 61.2, Longitude = -150.0, RadiusNm = 250 },
        new() { Name = "PugetSound",  Latitude = 48.0, Longitude = -123.0, RadiusNm = 250 },
        new() { Name = "Montana",     Latitude = 48.0, Longitude = -109.0, RadiusNm = 250 },
        new() { Name = "Boise",       Latitude = 45.0, Longitude = -116.0, RadiusNm = 250 },
        new() { Name = "Minneapolis", Latitude = 45.0, Longitude = -95.0,  RadiusNm = 250 },
        new() { Name = "UpperLakes",  Latitude = 45.0, Longitude = -88.0,  RadiusNm = 250 },
        new() { Name = "NewEngland",  Latitude = 45.0, Longitude = -67.0,  RadiusNm = 250 },
        new() { Name = "NorCal",      Latitude = 40.5, Longitude = -123.0, RadiusNm = 250 },
        new() { Name = "SaltLake",    Latitude = 40.5, Longitude = -109.0, RadiusNm = 250 },
        new() { Name = "Ohio",        Latitude = 40.5, Longitude = -81.0,  RadiusNm = 250 },
        new() { Name = "NewYork",     Latitude = 40.5, Longitude = -74.0,  RadiusNm = 250 },
        new() { Name = "GreatBasin",  Latitude = 36.0, Longitude = -116.0, RadiusNm = 250 },
        new() { Name = "Oklahoma",    Latitude = 36.0, Longitude = -95.0,  RadiusNm = 250 },
        new() { Name = "Tennessee",   Latitude = 36.0, Longitude = -88.0,  RadiusNm = 250 },
        new() { Name = "Carolinas",   Latitude = 36.0, Longitude = -81.0,  RadiusNm = 250 },
        new() { Name = "Arizona",     Latitude = 31.5, Longitude = -109.0, RadiusNm = 250 },
        new() { Name = "Texas",       Latitude = 31.5, Longitude = -95.0,  RadiusNm = 250 },
        new() { Name = "Gulf",        Latitude = 31.5, Longitude = -88.0,  RadiusNm = 250 },
        new() { Name = "Florida",     Latitude = 27.0, Longitude = -81.0,  RadiusNm = 250 },
        new() { Name = "Hawaii",      Latitude = 21.3, Longitude = -157.9, RadiusNm = 250 },
    ];

    public TimeSpan EnrichmentRegionRefresh { get; set; } = TimeSpan.FromSeconds(60);

    /// <summary>
    /// Where SwimServer answers, for the SFDPS correlation source. It is a separate process on
    /// the same box and must stay the only consumer of the SFDPS Solace queue (SWIM_FEED_HOST),
    /// so its en-route picture is fetched over HTTP rather than subscribed to a second time.
    /// Empty disables that source; the ADS-B and cross-facility ones are unaffected.
    /// </summary>
    public string SwimServerBaseUrl { get; set; } = "http://127.0.0.1:5001";
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
