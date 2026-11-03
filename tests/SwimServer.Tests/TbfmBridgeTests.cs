using System.Text.Json;

namespace SwimServer.Tests;

/// <summary>
/// TbfmBridge parsing, driven with messages shaped like the live TBFM MIS feed (namespace,
/// envelope, tag layout copied from real traffic, 2026-11-02). Callsigns and times are made up:
/// captured SWIM traffic is not committed, since that would be redistributing FAA data.
/// </summary>
public class TbfmBridgeTests
{
    private const string Ns = "urn:us:gov:dot:faa:atm:tfm:tbfmmeteringpublication:1.1.0";

    private static TbfmBridge NewBridge() => new("u", "p", "q", "h", "v");

    private static string T(int minutesFromNow) =>
        DateTime.UtcNow.AddMinutes(minutesFromNow).ToString("yyyy-MM-ddTHH:mm:ssZ");

    private static string Air(string ctr, string aid, string tmaId, string body,
                              string apt = "OAK", string airType = "AMD") =>
        $"<env xmlns=\"{Ns}\" envSrce=\"TMA.{ctr}.FAA.GOV\" envTime=\"{T(0)}\">" +
        $"<tma msgId=\"1\" msgTime=\"{T(0)}\">" +
        $"<air airType=\"{airType}\" aid=\"{aid}\" dap=\"SAN\" apt=\"{apt}\" tmaId=\"{tmaId}\" gufi=\"KX000000AA\">" +
        body + "</air></tma></env>";

    private static string Adp(string ctr, string mrns) =>
        $"<env xmlns=\"{Ns}\" envSrce=\"TMA.{ctr}.FAA.GOV\" envTime=\"{T(0)}\">" +
        $"<tma msgId=\"2\" msgTime=\"{T(0)}\"><adp><tra>EDC</tra><mrns>{mrns}</mrns></adp></tma></env>";

    private static string Mrn(string nam, string mrt, string? mfx = null) =>
        $"<mrn><nam>{nam}</nam><mrt>{mrt}</mrt><gat>ZOA</gat>{(mfx is null ? "" : $"<mfx>{mfx}</mfx>")}" +
        "<lat>364255N</lat><lon>1204643W</lon><rad>70.0</rad><lan>105.0</lan><ran>187.0</ran></mrn>";

    private static JsonElement Json(object o) => JsonSerializer.SerializeToElement(o);

    private static JsonElement Eram(TbfmBridge b, string aid) =>
        Json(b.EramSnapshot()).EnumerateArray().Single(r => r.GetProperty("aid").GetString() == aid);

    private static bool InEram(TbfmBridge b, string aid) =>
        Json(b.EramSnapshot()).EnumerateArray().Any(r => r.GetProperty("aid").GetString() == aid);

    // ── times ────────────────────────────────────────────────────────────────

    [Fact]
    public void StaAndEta_ArriveSeparately_AndMerge()
    {
        var b = NewBridge();
        b.Process(Air("ZLA", "TST100", "L1", $"<sta><mfx>PXN</mfx><sta_dfx>{T(30)}</sta_dfx><sta_sfx>{T(30)}</sta_sfx></sta>"));
        b.Process(Air("ZLA", "TST100", "L1", $"<eta><mfx>PXN</mfx><eta_dfx>{T(27)}</eta_dfx><eta_sfx>{T(27)}</eta_sfx><eta_mfx>{T(26)}</eta_mfx></eta>"));

        var r = Eram(b, "TST100");
        Assert.Equal("PXN", r.GetProperty("point").GetString());
        Assert.Equal(T(30), r.GetProperty("staPoint").GetDateTime().ToString("yyyy-MM-ddTHH:mm:ssZ"));
        // sfx wins over mfx so STA − ETA compares one point with itself
        Assert.Equal(T(27), r.GetProperty("etaPoint").GetDateTime().ToString("yyyy-MM-ddTHH:mm:ssZ"));
        Assert.Equal("ZLA", r.GetProperty("ctr").GetString());
    }

    [Fact]
    public void Del_RemovesTheSchedule()
    {
        var b = NewBridge();
        b.Process(Air("ZLA", "TST101", "L2", $"<sta><mfx>PXN</mfx><sta_sfx>{T(30)}</sta_sfx></sta>"));
        Assert.True(InEram(b, "TST101"));

        b.Process(Air("ZLA", "TST101", "L2", "", airType: "DEL"));
        Assert.False(InEram(b, "TST101"));
    }

    [Fact]
    public void LandedFlights_DropOffTheScopeFeed()
    {
        var b = NewBridge();
        b.Process(Air("ZNY", "TST102", "N1", $"<sta><mfx>LENDY</mfx><sta_rwy>{T(5)}</sta_rwy></sta>", apt: "JFK"));
        Assert.True(InEram(b, "TST102"));

        b.Process(Air("ZNY", "TST102", "N1", "<flt><aid>TST102</aid><acs>LANDED</acs></flt>", apt: "JFK"));
        Assert.False(InEram(b, "TST102"));
    }

    [Fact]
    public void PassedSta_StillBeingRevised_IsKept()
    {
        var b = NewBridge();
        // STA 5 min ago, but the message carrying it arrived just now: TBFM is still revising
        // this one (a late flight), so it stays. Dropping needs no time update since the STA.
        b.Process(Air("ZLA", "TST103", "L3", $"<sta><mfx>PXN</mfx><sta_sfx>{T(-5)}</sta_sfx></sta>"));
        Assert.True(InEram(b, "TST103"));
    }

    // ── purge waits for the LAST scheduled time, not the first ───────────────

    [Fact]
    public void Purge_KeepsARecordWhoseRunwayStaIsStillAhead()
    {
        var b = NewBridge();
        // Meter fix well behind, runway still well ahead — the ordinary picture once an arrival is
        // inside the meter fix. Purging on StaMeterFix alone threw this away 20 min before the
        // runway STA mattered, while EramSnapshot was still willing to show it.
        b.Process(Air("ZOA", "TST120", "P1",
            $"<sta><mfx>PXN</mfx><sta_sfx>{T(-20)}</sta_sfx><sta_rwy>{T(20)}</sta_rwy></sta>"));
        b.PurgeStale();
        Assert.Equal(1, b.FlightCount);
        Assert.True(InEram(b, "TST120"));
    }

    [Fact]
    public void Purge_DropsARecordOnceEveryScheduledTimeIsWellPast()
    {
        var b = NewBridge();
        b.Process(Air("ZOA", "TST121", "P2",
            $"<sta><mfx>PXN</mfx><sta_sfx>{T(-40)}</sta_sfx><sta_rwy>{T(-20)}</sta_rwy></sta>"));
        b.PurgeStale();
        Assert.Equal(0, b.FlightCount);
    }

    // ── each centre's schedule kept separately ───────────────────────────────

    [Fact]
    public void ExtendedMetering_KeepsOneRecordPerCentre()
    {
        var b = NewBridge();
        b.Process(Air("ZLC", "TST104", "C1", $"<sta><mfx>D34S</mfx><sta_sfx>{T(20)}</sta_sfx></sta>", apt: "DFW"));
        b.Process(Air("ZDV", "TST104", "D1", $"<sta><mfx>ABQ</mfx><sta_sfx>{T(40)}</sta_sfx></sta>", apt: "DFW"));
        b.Process(Air("ZAB", "TST104", "A1", $"<sta><mfx>CME</mfx><sta_sfx>{T(60)}</sta_sfx></sta>", apt: "DFW"));

        var recs = Json(b.EramSnapshot()).EnumerateArray().Where(r => r.GetProperty("aid").GetString() == "TST104").ToList();
        Assert.Equal(3, recs.Count);
        Assert.Equal(new[] { "ABQ", "CME", "D34S" }, recs.Select(r => r.GetProperty("point").GetString()).OrderBy(x => x));
    }

    // ── point types and arc names from adaptation ────────────────────────────

    [Fact]
    public void PointType_ComesFromAdaptation_AndIsNullWithoutIt()
    {
        var b = NewBridge();
        b.Process(Air("ZLA", "TST105", "L5", $"<sta><mfx>PXN</mfx><sta_sfx>{T(30)}</sta_sfx></sta>"));
        Assert.Equal(JsonValueKind.Null, Eram(b, "TST105").GetProperty("pointType").ValueKind);

        b.Process(Adp("ZLA", Mrn("PXN", "MFA")));
        Assert.Equal("MFA", Eram(b, "TST105").GetProperty("pointType").GetString());
    }

    [Fact]
    public void PointType_PrefersTheFix_WhenANameIsBoth()
    {
        // ZSE has HELNS (MFX) beside "HELNS." (MFA)
        var b = NewBridge();
        b.Process(Adp("ZSE", Mrn("HELNS", "MFX") + Mrn("HELNS.", "MFA")));
        b.Process(Air("ZSE", "TST106", "S6", $"<sta><mfx>HELNS</mfx><sta_sfx>{T(30)}</sta_sfx></sta>", apt: "PDX"));
        Assert.Equal("MFX", Eram(b, "TST106").GetProperty("pointType").GetString());
    }

    [Fact]
    public void SameNameDifferentType_BothKept()
    {
        // ZLA: LAX/NORTH is both an O3A and an O4A
        var b = NewBridge();
        b.Process(Adp("ZLA", Mrn("LAX/NORTH", "O3A", "LOSHNW") + Mrn("LAX/NORTH", "O4A", "LOSHNW")));
        var pts = Json(b.Adaptation("ZLA")!).GetProperty("points").EnumerateArray()
                    .Where(p => p.GetProperty("name").GetString() == "LAX/NORTH").ToList();
        Assert.Equal(2, pts.Count);
    }

    [Fact]
    public void ArcName_FromAdaptation_OnlyWhenUnambiguous()
    {
        var b = NewBridge();
        b.Process(Adp("ZLA",
            Mrn("ZABEAST", "MFA") + Mrn("ZABEOA", "OMA", "ZABEAST") +
            Mrn("STEWWMP", "MFA") + Mrn("STEWOA", "OMA", "STEWWMP") + Mrn("STEWOA2", "OMA", "STEWWMP")));
        b.Process(Air("ZLA", "TST107", "L7", $"<sta><mfx>ZABEAST</mfx><sta_oma>{T(20)}</sta_oma><sta_sfx>{T(30)}</sta_sfx></sta>", apt: "LAX"));
        b.Process(Air("ZLA", "TST108", "L8", $"<sta><mfx>STEWWMP</mfx><sta_oma>{T(20)}</sta_oma><sta_sfx>{T(30)}</sta_sfx></sta>", apt: "LAS"));

        Assert.Equal("ZABEOA", Eram(b, "TST107").GetProperty("arcs").GetProperty("oma").GetProperty("name").GetString());
        // two OMAs serve STEWWMP — don't guess
        Assert.Equal(JsonValueKind.Null, Eram(b, "TST108").GetProperty("arcs").GetProperty("oma").GetProperty("name").ValueKind);
    }

    [Fact]
    public void ArcName_FromTheSchedulesOwnMrp_Wins()
    {
        var b = NewBridge();
        b.Process(Air("ZSE", "TST109", "S9",
            $"<mrp><mfx>VANTZ</mfx><oma>MOXEE/T</oma><cat>ARRIVAL</cat></mrp>" +
            $"<sta><mfx>VANTZ</mfx><sta_oma>{T(20)}</sta_oma><sta_sfx>{T(30)}</sta_sfx></sta>", apt: "PDX"));
        var r = Eram(b, "TST109");
        Assert.Equal("MOXEE/T", r.GetProperty("arcs").GetProperty("oma").GetProperty("name").GetString());
        Assert.Equal("ARRIVAL", r.GetProperty("mrp").GetProperty("cat").GetString());
    }

    [Fact]
    public void Point_IsTheSfxFromMrp_NotTheMeterFix()
    {
        // Live shape (ZAU, AAL1614): mfx MOTRR, but the STA/ETA are for sfx FYTTEMF
        var b = NewBridge();
        b.Process(Air("ZAU", "TST110", "G1",
            "<mrp><mfx>MOTRR</mfx><sfx>FYTTEMF</sfx><dfx>FYTTEMF</dfx><cat>ARRIVAL</cat></mrp>" +
            $"<sta><mfx>MOTRR</mfx><sta_sfx>{T(30)}</sta_sfx></sta>", apt: "ORD"));
        var r = Eram(b, "TST110");
        Assert.Equal("FYTTEMF", r.GetProperty("point").GetString());
        Assert.Equal("MOTRR", r.GetProperty("meterFix").GetString());

        // without mrp, the meter fix is the best name we have
        b.Process(Air("ZAU", "TST111", "G2", $"<sta><mfx>MOTRR</mfx><sta_sfx>{T(30)}</sta_sfx></sta>", apt: "ORD"));
        Assert.Equal("MOTRR", Eram(b, "TST111").GetProperty("point").GetString());
    }

    // ── other message kinds ──────────────────────────────────────────────────

    [Fact]
    public void HeartbeatsAndRates_AreRecordedPerCentre()
    {
        var b = NewBridge();
        b.Process($"<mis xmlns=\"{Ns}\" misTime=\"{T(0)}\" misSrce=\"TMA.ZHU.FAA.GOV\"><hb /></mis>");
        b.Process($"<env xmlns=\"{Ns}\" envSrce=\"TMA.ZSE.FAA.GOV\"><tma><con>" +
                  $"<aar><apt>SEA</apt><tra>S46</tra><tim>{T(-60)}</tim><rat>3600</rat></aar>" +
                  $"<tar tarType=\"NOW\"><tra>S46</tra><tim>{T(-60)}</tim><rat>3600</rat></tar></con></tma></env>");

        var centers = Json(b.CentersSnapshot()).EnumerateArray().ToDictionary(c => c.GetProperty("ctr").GetString()!);
        Assert.Equal(JsonValueKind.Number, centers["ZHU"].GetProperty("heartbeatSec").ValueKind);
        var rates = centers["ZSE"].GetProperty("rates").EnumerateArray().ToList();
        Assert.Contains(rates, r => r.GetProperty("kind").GetString() == "aar" && r.GetProperty("id").GetString() == "SEA");
        Assert.Contains(rates, r => r.GetProperty("kind").GetString() == "tar" && r.GetProperty("type").GetString() == "NOW");
    }

    [Fact]
    public void MalformedAndUnknown_AreCountedNotThrown()
    {
        var b = NewBridge();
        b.Process("<not xml");
        b.Process($"<env xmlns=\"{Ns}\" envSrce=\"TMA.ZOB.FAA.GOV\"><tma><zzz/></tma></env>");
        var d = Json(b.DebugSnapshot());
        Assert.Equal(1, d.GetProperty("unparsed").GetInt64());
        Assert.Equal(1, d.GetProperty("unknownKinds").GetProperty("zzz").GetInt64());
    }

    // ── adaptation persistence ───────────────────────────────────────────────

    [Fact]
    public void Adaptation_SurvivesASaveAndLoad()
    {
        var dir = Path.Combine(Path.GetTempPath(), "tbfm-test-" + Guid.NewGuid().ToString("N"));
        try
        {
            var a = NewBridge();
            a.Process(Adp("ZLA", Mrn("PXN", "MFA") + Mrn("LAX/NORTH", "O3A", "LOSHNW") + Mrn("LAX/NORTH", "O4A", "LOSHNW")));
            a.SetCacheDir(dir);
            a.SaveAdaptationIfDirty();

            var b = NewBridge();
            b.LoadAdaptation(dir);
            var pts = Json(b.Adaptation("ZLA")!).GetProperty("points").EnumerateArray().ToList();
            Assert.Equal(3, pts.Count);
            var pxn = pts.Single(p => p.GetProperty("name").GetString() == "PXN");
            Assert.Equal("MFA", pxn.GetProperty("type").GetString());
            Assert.Equal(70.0, pxn.GetProperty("radiusNm").GetDouble());
        }
        finally { if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true); }
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    [Theory]
    [InlineData("445759N", 44.966388)]
    [InlineData("1224018W", -122.671666)]
    [InlineData("364255N", 36.715277)]
    public void ParseDms_DecodesTbfmLatLon(string s, double expected) =>
        Assert.Equal(expected, TbfmBridge.ParseDms(s)!.Value, 5);

    [Theory]
    [InlineData("TMA.ZLC.FAA.GOV", "ZLC")]
    [InlineData("TMA.zab.FAA.GOV", "ZAB")]
    [InlineData(null, null)]
    public void CenterOf_TakesTheArtcc(string? src, string? expected) =>
        Assert.Equal(expected, TbfmBridge.CenterOf(src));
}
