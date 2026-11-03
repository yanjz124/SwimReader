using System.Text.Json;

namespace SwimServer.Tests;

/// <summary>
/// FAV → GeoJSON conversion. Every case here is something the live feed actually does and that a
/// first reading of it got wrong — closure, the 99,xxx ceiling, and what excludeModules mean.
/// Shapes are copied from vNAS (2026-11-03); the coordinates are made up.
/// </summary>
public class VnasAirspaceTests
{
    private static VnasAirspace Load(string json)
    {
        var dir = Path.Combine(Path.GetTempPath(), "swimtest-fav-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        File.WriteAllText(Path.Combine(dir, "ZDC.json"), json);
        var a = new VnasAirspace(new HttpClient(), dir);
        a.LoadCache();
        return a;
    }

    /// <summary>A FAV whose modules each cover one band over the same square boundary.</summary>
    private static string Fav(string favId, params (int lo, int hi)[] bands)
    {
        const string square = "{\"points\":[{\"lat\":38,\"lon\":-78},{\"lat\":38,\"lon\":-77},"
                            + "{\"lat\":39,\"lon\":-77},{\"lat\":39,\"lon\":-78}]}";
        var mods = string.Join(",", bands.Select((b, i) =>
            "{\"moduleId\":" + (i + 1) + ",\"lowerAlt\":" + b.lo + ",\"upperAlt\":" + b.hi
            + ",\"boundary\":" + square + "}"));
        return "{\"artccId\":\"ZDC\",\"favId\":\"" + favId + "\",\"modules\":[" + mods
             + "],\"excludeModules\":[]}";
    }

    private static JsonElement Geo(VnasAirspace a, int? lo = null, int? hi = null,
                                   string? sector = null, bool sentinel = false)
        => JsonSerializer.SerializeToElement(a.GeoJson("ZDC", lo, hi, sector, sentinel)!);

    private static JsonElement[] Features(JsonElement g) =>
        g.GetProperty("features").EnumerateArray().ToArray();

    // ── ring closure ─────────────────────────────────────────────────────────

    [Fact]
    public void Ring_IsClosed_BecauseNothingInTheFeedArrivesClosed()
    {
        // Measured: all 4,886 rings across 24 ARTCCs end somewhere other than where they start.
        var f = Features(Geo(Load($"[{Fav("00101", (0, 10000))}]"))).Single();
        var ring = f.GetProperty("geometry").GetProperty("coordinates")[0];
        Assert.Equal(5, ring.GetArrayLength());        // 4 points in, 5 out
        Assert.Equal(ring[0][0].GetDouble(), ring[4][0].GetDouble());
        Assert.Equal(ring[0][1].GetDouble(), ring[4][1].GetDouble());
        // GeoJSON is lon,lat — not lat,lon, which is how FAV points arrive.
        Assert.Equal(-78, ring[0][0].GetDouble());
        Assert.Equal(38, ring[0][1].GetDouble());
    }

    [Fact]
    public void RingWithUnderThreePoints_IsDropped()
    {
        var json = """
        [{"id":"f","artccId":"ZDC","favId":"00101","excludeModules":[],"modules":[
          {"moduleId":1,"lowerAlt":0,"upperAlt":1000,
           "boundary":{"points":[{"lat":38,"lon":-78},{"lat":38,"lon":-77}]}}]}]
        """;
        Assert.Empty(Features(Geo(Load(json))));
    }

    // ── the 99,xxx ceiling ───────────────────────────────────────────────────

    [Fact]
    public void CeilingAbove99000_IsUnlimited_NotDropped()
    {
        // ZAB 06701 really runs 30,000 → 99,100. Dropping these would delete the top of 464
        // modules, i.e. the ceiling of every high sector in the country.
        var p = Features(Geo(Load($"[{Fav("03201", (30000, 99100))}]"))).Single().GetProperty("properties");
        Assert.True(p.GetProperty("unlimitedCeiling").GetBoolean());
        Assert.Equal(JsonValueKind.Null, p.GetProperty("upperAlt").ValueKind);
        Assert.Equal(30000, p.GetProperty("lowerAlt").GetInt32());
        Assert.False(p.GetProperty("sentinel").GetBoolean());
    }

    [Fact]
    public void UnlimitedCeiling_MatchesAnyAltitudeAboveItsFloor()
    {
        var a = Load($"[{Fav("03201", (30000, 99100))}]");
        Assert.Single(Features(Geo(a, lo: 60000, hi: 60000)));   // far above the stated ceiling
        Assert.Empty(Features(Geo(a, lo: 5000, hi: 9000)));      // below the floor
    }

    [Fact]
    public void ModuleEntirelyIn99kBand_IsSentinel_AndHiddenByDefault()
    {
        // 224 modules have BOTH ends >= 99,000 — (99800,99900) alone 117 times. What that encodes
        // is not known, so it is kept and flagged rather than deleted or drawn as real airspace.
        var a = Load($"[{Fav("00701", (99800, 99900))}]");
        Assert.Empty(Features(Geo(a)));
        var f = Features(Geo(a, sentinel: true)).Single();
        Assert.True(f.GetProperty("properties").GetProperty("sentinel").GetBoolean());
    }

    [Fact]
    public void SentinelModule_IsNeverFilteredInByAnAltitudeQuery()
    {
        var a = Load($"[{Fav("00701", (99800, 99900))}]");
        Assert.Empty(Features(Geo(a, lo: 99800, hi: 99900)));
    }

    // ── altitude banding ─────────────────────────────────────────────────────

    [Fact]
    public void Bands_AreInclusive_SoTheHundredFootStepHasNoHole()
    {
        // ZDC Gordonsville 32: three stacked slabs, which is the thing a flat KML ring cannot say.
        var a = Load($"[{Fav("03201", (21100, 23000), (23100, 27000), (27100, 33400))}]");
        Assert.Equal(3, Features(Geo(a)).Length);

        // Exactly on a boundary, both sides match — the band includes its own endpoints.
        var atEdge = Features(Geo(a, lo: 23000, hi: 23100));
        Assert.Equal(2, atEdge.Length);

        // Inside the 100 ft step, the slab below still answers: 23,050 is nobody's floor or
        // ceiling, and returning nothing there would punch a hole through the whole stack.
        Assert.Single(Features(Geo(a, lo: 23050, hi: 23050)));

        var mid = Features(Geo(a, lo: 24000, hi: 24000)).Single().GetProperty("properties");
        Assert.Equal(23100, mid.GetProperty("lowerAlt").GetInt32());
    }

    [Fact]
    public void NoAltitudeFilter_ReturnsEveryRealModule()
        => Assert.Equal(3, Features(Geo(Load($"[{Fav("03201", (21100, 23000), (23100, 27000), (27100, 33400))}]"))).Length);

    // ── excludeModules ───────────────────────────────────────────────────────

    [Fact]
    public void ExcludeModule_IsItsOwnFeatureWithItsOwnBand_NotAPolygonHole()
    {
        // ZAU 01101 subtracts only the bottom 100 ft of a 0–10,000 volume. As a GeoJSON interior
        // ring that area would vanish at every altitude; only 38 of 382 exclude modules even
        // share a band with a parent module.
        var json = """
        [{"id":"f","artccId":"ZDC","favId":"01101","modules":[
            {"moduleId":1,"lowerAlt":0,"upperAlt":10000,
             "boundary":{"points":[{"lat":38,"lon":-78},{"lat":38,"lon":-77},{"lat":39,"lon":-77}]}}],
          "excludeModules":[
            {"moduleId":1,"lowerAlt":0,"upperAlt":100,
             "boundary":{"points":[{"lat":38.1,"lon":-77.9},{"lat":38.1,"lon":-77.8},{"lat":38.2,"lon":-77.8}]}}]}]
        """;
        var a = Load(json);
        var all = Features(Geo(a));
        Assert.Equal(2, all.Length);
        // One ring each — the exclusion is not spliced into the parent as a second ring.
        foreach (var f in all)
            Assert.Equal(1, f.GetProperty("geometry").GetProperty("coordinates").GetArrayLength());
        Assert.Single(all, f => f.GetProperty("properties").GetProperty("exclude").GetBoolean());

        // It carries its own band, so above 100 ft only the parent answers.
        var high = Features(Geo(a, lo: 5000, hi: 5000)).Single();
        Assert.False(high.GetProperty("properties").GetProperty("exclude").GetBoolean());
    }

    // ── identity ─────────────────────────────────────────────────────────────

    [Fact]
    public void Sector_IsTheFirstThreeCharactersOfFavId()
    {
        var json = $"[{Fav("00701", (0, 10000))},{Fav("00702", (0, 10000))},{Fav("03201", (0, 10000))}]";
        var a = Load(json);
        Assert.Equal(new[] { "007", "007", "032" },
            Features(Geo(a)).Select(f => f.GetProperty("properties").GetProperty("sector").GetString()));
        // ?sector= accepts the bare number as well as the padded form.
        Assert.Equal(2, Features(Geo(a, sector: "7")).Length);
        Assert.Equal(2, Features(Geo(a, sector: "007")).Length);
        Assert.Single(Features(Geo(a, sector: "32")));
    }

    [Fact]
    public void UnknownArtcc_IsNull() => Assert.Null(Load("[]").GeoJson("ZZZ"));

    [Fact]
    public void Status_ReportsWhatIsHeld()
    {
        var a = Load($"[{Fav("00101", (0, 10000), (10100, 99900))},{Fav("00701", (99800, 99900))}]");
        var s = JsonSerializer.SerializeToElement(a.Status());
        var row = s.GetProperty("rows").EnumerateArray().Single();
        Assert.Equal("ZDC", row.GetProperty("artcc").GetString());
        Assert.Equal(2, row.GetProperty("favs").GetInt32());
        Assert.Equal(3, row.GetProperty("modules").GetInt32());
        Assert.Equal(2, row.GetProperty("sectors").GetInt32());
        Assert.Equal(1, row.GetProperty("unlimitedCeiling").GetInt32());
        Assert.Equal(1, row.GetProperty("sentinelOnly").GetInt32());
    }
}
