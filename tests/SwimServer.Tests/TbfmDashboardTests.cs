using System.Text.Json;

namespace SwimServer.Tests;

/// <summary>
/// The /tbfm dashboard projections. Message shapes are copied from the live TBFM MIS feed
/// (2026-11-03); callsigns and times are made up, since captured SWIM traffic is not committed.
///
/// The point of these is the two aggregation rules that are easy to "fix" the wrong way:
/// a flight's delay is the MAXIMUM over its metering chain (TBFM distributes the hold upstream,
/// so summing double-counts), while a meter point's delay is its own record's.
/// </summary>
public class TbfmDashboardTests
{
    private const string Ns = "urn:us:gov:dot:faa:atm:tfm:tbfmmeteringpublication:1.1.0";

    private static TbfmBridge NewBridge() => new("u", "p", "q", "h", "v");

    private static string T(double minutesFromNow) =>
        DateTime.UtcNow.AddMinutes(minutesFromNow).ToString("yyyy-MM-ddTHH:mm:ssZ");

    /// <summary>One center's schedule for a flight: a point STA/ETA, optionally a runway pair.</summary>
    private static string Link(string ctr, string aid, string apt, string point,
                               double staMin, double etaMin,
                               double? staRwyMin = null, double? etaRwyMin = null,
                               string tracon = "EDC", string? rwy = null, string? acs = null,
                               string cat = "OVERFLIGHT")
    {
        var sta = $"<sta><mfx>{point}</mfx><sta_sfx>{T(staMin)}</sta_sfx><sta_dfx>{T(staMin)}</sta_dfx>"
                + (staRwyMin is { } sr ? $"<sta_rwy>{T(sr)}</sta_rwy>" : "") + "</sta>";
        var eta = $"<eta><mfx>{point}</mfx><eta_sfx>{T(etaMin)}</eta_sfx><eta_dfx>{T(etaMin)}</eta_dfx>"
                + (etaRwyMin is { } er ? $"<eta_rwy>{T(er)}</eta_rwy>" : "") + "</eta>";
        var mrp = $"<mrp><mfx>{point}</mfx><sfx>{point}</sfx><dfx>{point}</dfx><tra>{tracon}</tra>"
                + $"<gat>{ctr}_GATE</gat><scn>{apt}_{point}</scn><cat>{cat}</cat>"
                + (rwy is null ? "" : $"<rwy>{rwy}</rwy><cfg>EAST</cfg>") + "</mrp>";
        var flt = $"<flt><aid>{aid}</aid><apt>{apt}</apt><dap>JFK</dap><typ>B738/L</typ>"
                + $"<bcn>1234</bcn><tds>{ctr}</tds><ara>35000</ara>"
                + (acs is null ? "" : $"<acs>{acs}</acs>") + "</flt>";
        var sch = "<sch><sfz>NO</sfz><sus>NO</sus><man>NO</man></sch>";
        return $"<env xmlns=\"{Ns}\" envSrce=\"TMA.{ctr}.FAA.GOV\" envTime=\"{T(0)}\">"
             + $"<tma msgId=\"1\" msgTime=\"{T(0)}\">"
             + $"<air airType=\"AMD\" aid=\"{aid}\" dap=\"JFK\" apt=\"{apt}\" tmaId=\"{ctr}{aid}\" gufi=\"KX000000AA\">"
             + flt + mrp + sch + sta + eta + "</air></tma></env>";
    }

    private static string Rate(string ctr, string kind, string id, double rate) =>
        $"<env xmlns=\"{Ns}\" envSrce=\"TMA.{ctr}.FAA.GOV\" envTime=\"{T(0)}\">"
      + $"<tma msgId=\"3\" msgTime=\"{T(0)}\"><con><{kind} rateType=\"NOW\"><apt>{id}</apt>"
      + $"<tra>X99</tra><rat>{rate}</rat><tim>{T(-5)}</tim></{kind}></con></tma></env>";

    private static JsonElement Json(object o) => JsonSerializer.SerializeToElement(o);

    /// <summary>A flight metered by ZOB, then ZAU, then ZAB (which owns the runway schedule).</summary>
    private static TbfmBridge ThreeCenterChain()
    {
        var b = NewBridge();
        b.Process(Link("ZOB", "TST200", "PHX", "ZAU_N", staMin: 20, etaMin: 20));
        b.Process(Link("ZAU", "TST200", "PHX", "BFFMP", staMin: 45, etaMin: 39));   // +6 absorbed here
        b.Process(Link("ZAB", "TST200", "PHX", "ZDVPHXX", staMin: 70, etaMin: 70,
                       staRwyMin: 86, etaRwyMin: 85.5, tracon: "P50", rwy: "8", cat: "ARRIVAL"));
        return b;
    }

    // ── grouping ─────────────────────────────────────────────────────────────

    [Fact]
    public void ChainAcrossCenters_IsOneFlight_InStaOrder()
    {
        var board = Json(ThreeCenterChain().AirportBoard("PHX"));
        Assert.Equal(1, board.GetProperty("metered").GetInt32());
        Assert.Equal(1, board.GetProperty("arriving").GetInt32());

        var f = board.GetProperty("flights").EnumerateArray().Single();
        var chain = f.GetProperty("chain").EnumerateArray()
            .Select(l => l.GetProperty("ctr").GetString()).ToArray();
        // Nearest the field last — the chain is a route, so STA order is geographic order.
        Assert.Equal(new[] { "ZOB", "ZAU", "ZAB" }, chain);
        Assert.Equal("ZAB", f.GetProperty("terminalCtr").GetString());
        Assert.Equal("8", f.GetProperty("rwy").GetString());
        Assert.Equal("P50", f.GetProperty("tracon").GetString());
    }

    [Fact]
    public void FlightDelay_IsMaxOverTheChain_NotTheSum()
    {
        var f = Json(ThreeCenterChain().AirportBoard("PHX")).GetProperty("flights").EnumerateArray().Single();
        // ZAU holds 6 min; the other two links read ~0. Summing would give the same here only
        // because the others are zero — so assert the max explicitly against a second holding link.
        Assert.Equal(6.0, f.GetProperty("delayMin").GetDouble(), 1);
    }

    [Fact]
    public void TwoHoldingLinks_TakeTheLarger_NotTheTotal()
    {
        var b = NewBridge();
        b.Process(Link("ZAU", "TST201", "ORD", "BFFMP", staMin: 40, etaMin: 36));   // +4
        b.Process(Link("ZOB", "TST201", "ORD", "ZAU_N", staMin: 60, etaMin: 53));   // +7
        var f = Json(b.AirportBoard("ORD")).GetProperty("flights").EnumerateArray().Single();
        Assert.Equal(7.0, f.GetProperty("delayMin").GetDouble(), 1);   // not 11
    }

    [Fact]
    public void AirportDirectory_CountsFlights_NotRecords()
    {
        var rows = Json(ThreeCenterChain().AirportsSnapshot()).EnumerateArray()
            .Single(r => r.GetProperty("apt").GetString() == "PHX");
        Assert.Equal(1, rows.GetProperty("metered").GetInt32());
        Assert.Equal(3, rows.GetProperty("centers").GetInt32());
        Assert.Equal(3, rows.GetProperty("points").GetInt32());
        Assert.Equal(1, rows.GetProperty("delayed").GetInt32());
        Assert.Equal("P50", rows.GetProperty("tracon").GetString());
    }

    [Fact]
    public void KPrefixedAirport_ResolvesToTheFaaLid()
    {
        // TBFM publishes FAA LIDs; a link typed with the ICAO code must still find the board.
        var board = Json(ThreeCenterChain().AirportBoard("KPHX"));
        Assert.Equal("PHX", board.GetProperty("apt").GetString());
        Assert.Equal(1, board.GetProperty("metered").GetInt32());
    }

    [Fact]
    public void RunwayDelay_ComesFromTheTerminalRecord()
    {
        var f = Json(ThreeCenterChain().AirportBoard("PHX")).GetProperty("flights").EnumerateArray().Single();
        Assert.Equal(0.5, f.GetProperty("rwyDelayMin").GetDouble(), 1);
    }

    [Fact]
    public void LandedFlight_IsNotOnTheBoard()
    {
        var b = NewBridge();
        b.Process(Link("ZAB", "TST202", "PHX", "ZDVPHXX", staMin: 10, etaMin: 10,
                       staRwyMin: 25, etaRwyMin: 25, rwy: "8", acs: "LANDED"));
        Assert.Equal(0, Json(b.AirportBoard("PHX")).GetProperty("metered").GetInt32());
    }

    // ── center board ─────────────────────────────────────────────────────────

    [Fact]
    public void CenterBoard_RollsUpItsOwnPointsOnly()
    {
        var board = Json(ThreeCenterChain().CenterBoard("ZAU")!);
        Assert.Equal("ZAU", board.GetProperty("ctr").GetString());
        Assert.Equal(1, board.GetProperty("scheduled").GetInt32());
        var p = board.GetProperty("points").EnumerateArray().Single();
        Assert.Equal("BFFMP", p.GetProperty("name").GetString());
        // A meter point reports ITS OWN delay — what the sector working it sees — not the flight's.
        Assert.Equal(6, p.GetProperty("delayMin").GetInt32());
        Assert.Equal(1, p.GetProperty("delayed").GetInt32());
        Assert.Equal("PHX", p.GetProperty("airports").EnumerateArray().Single().GetProperty("apt").GetString());
    }

    [Fact]
    public void CenterBoard_Unknown_IsNull() => Assert.Null(NewBridge().CenterBoard("ZZZ"));

    [Fact]
    public void PointGeometry_ComesFromAdaptation()
    {
        var b = ThreeCenterChain();
        b.Process($"<env xmlns=\"{Ns}\" envSrce=\"TMA.ZAU.FAA.GOV\" envTime=\"{T(0)}\">"
            + $"<tma msgId=\"2\" msgTime=\"{T(0)}\"><adp><tra>C90</tra><mrns>"
            + "<mrn><nam>BFFMP</nam><mrt>MFA</mrt><gat>ZMP_GATE</gat>"
            + "<lat>364255N</lat><lon>1204643W</lon><rad>70.0</rad><lan>105.0</lan><ran>187.0</ran></mrn>"
            + "</mrns></adp></tma></env>");

        var board = Json(b.CenterBoard("ZAU")!);
        var p = board.GetProperty("points").EnumerateArray().Single();
        Assert.Equal("MFA", p.GetProperty("type").GetString());
        Assert.Equal(70, p.GetProperty("radiusNm").GetDouble());
        Assert.Equal(105, p.GetProperty("leftAngle").GetDouble());

        var g = board.GetProperty("geometry").EnumerateArray().Single();
        Assert.Equal(36.715, g.GetProperty("lat").GetDouble(), 2);
        Assert.Equal(-120.779, g.GetProperty("lon").GetDouble(), 2);
    }

    // ── rates ────────────────────────────────────────────────────────────────

    [Fact]
    public void Rate3600_ReadsAsUnrestricted()
    {
        var b = ThreeCenterChain();
        b.Process(Rate("ZAB", "aar", "PHX", 3600));
        var row = Json(b.AirportsSnapshot()).EnumerateArray()
            .Single(r => r.GetProperty("apt").GetString() == "PHX");
        Assert.Equal(3600, row.GetProperty("aar").GetDouble());
        Assert.False(row.GetProperty("aarRestricted").GetBoolean());
    }

    [Fact]
    public void RealRate_ReadsAsRestricted_AndReachesTheBoard()
    {
        var b = ThreeCenterChain();
        b.Process(Rate("ZAB", "aar", "PHX", 40));
        var row = Json(b.AirportsSnapshot()).EnumerateArray()
            .Single(r => r.GetProperty("apt").GetString() == "PHX");
        Assert.True(row.GetProperty("aarRestricted").GetBoolean());

        var rates = Json(b.AirportBoard("PHX")).GetProperty("rates").EnumerateArray().ToArray();
        Assert.Contains(rates, r => r.GetProperty("id").GetString() == "PHX"
                                 && r.GetProperty("rate").GetDouble() == 40);
    }

    [Fact]
    public void CenterBoard_ShowsOnlyItsOwnRates()
    {
        // An airport's AAR may be published by any center, so the airport board scans them all —
        // but a CENTER board that did the same put ZNY's EWR rates on ZLA's page.
        var b = ThreeCenterChain();
        b.Process(Rate("ZAB", "aar", "PHX", 40));
        b.Process(Rate("ZOB", "aar", "CLE", 48));

        var zab = Json(b.CenterBoard("ZAB")!).GetProperty("rates").EnumerateArray().ToArray();
        Assert.Equal("PHX", Assert.Single(zab).GetProperty("id").GetString());

        var zob = Json(b.CenterBoard("ZOB")!).GetProperty("rates").EnumerateArray().ToArray();
        Assert.Equal("CLE", Assert.Single(zob).GetProperty("id").GetString());

        // ZAU published nothing, so its board is empty rather than showing the other two.
        Assert.Empty(Json(b.CenterBoard("ZAU")!).GetProperty("rates").EnumerateArray());
    }

    [Fact]
    public void MeterPointRates_DoNotCollapseOntoOneTraconEntry()
    {
        // mar/gar are per METER POINT and carry an <mfx>. Keyed on kind/TRACON alone, a center
        // with a dozen metered fixes reported one rate and the last message in won.
        var b = ThreeCenterChain();
        string Mar(string point, int rate) =>
            $"<env xmlns=\"{Ns}\" envSrce=\"TMA.ZAB.FAA.GOV\" envTime=\"{T(0)}\">"
          + $"<tma msgId=\"4\" msgTime=\"{T(0)}\"><con><mar><tra>P50</tra><mfx>{point}</mfx>"
          + $"<rat>{rate}</rat><tim>{T(-5)}</tim></mar></con></tma></env>";
        b.Process(Mar("BRDEY", 24));
        b.Process(Mar("ALIBYX1", 18));

        var rates = Json(b.CenterBoard("ZAB")!).GetProperty("rates").EnumerateArray()
            .Where(r => r.GetProperty("kind").GetString() == "mar").ToArray();
        Assert.Equal(2, rates.Length);
        Assert.Equal(new[] { 18.0, 24.0 }, rates.Select(r => r.GetProperty("rate").GetDouble()).OrderBy(x => x));
    }

    [Fact]
    public void Stats_CountsFlightsAndRecordsSeparately()
    {
        var s = Json(ThreeCenterChain().Stats());
        Assert.Equal(3, s.GetProperty("records").GetInt32());    // one per metering center
        Assert.Equal(1, s.GetProperty("flights").GetInt32());    // one airplane
        Assert.Equal(1, s.GetProperty("airports").GetInt32());
        Assert.Equal(3, s.GetProperty("centers").GetInt32());
    }
}
