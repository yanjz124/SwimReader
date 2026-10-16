using System.Text.Json;

namespace SwimServer;

/// <summary>
/// Airport Operations — the single-airport weather/runway board at <c>/airport/{id}</c>.
///
/// Modelled on the ASOS "airport operations" displays in towers and FBOs: current wind over a
/// compass rose with the runways drawn to scale, the field's pressure/temperature state, and the
/// per-runway head/crosswind split that decides which runway is in use.
///
/// Two sources, both already here:
///   * <b>NASR</b> — field elevation, magnetic variation and the runways (APT_RWY + APT_RWY_END,
///     the latter carrying TRUE_ALIGNMENT and threshold coordinates).
///   * <b>METAR</b> — aviationweather.gov's JSON form, which returns an already-parsed observation
///     (wind, temp, dewpoint, altimeter, cloud layers, flight category) plus history with `hours`.
///     Parsing raw METAR ourselves would be a liability for no gain.
///
/// Everything else on the page is derived here rather than in the browser, so the numbers are the
/// same for every client and testable with curl.
///
/// Deliberately NOT included: the lightning/thunderstorm panel those displays carry. ITWS does
/// publish lightning, but it is not on our SCDS queue (26 product types, none of them lightning),
/// and a panel that can only ever say "0 strikes" is worse than no panel.
/// </summary>
static class AirportOpsRoutes
{
    // METARs update hourly (plus SPECIs) and the page polls; cache so a room full of viewers is
    // still one request per airport per minute to aviationweather.gov.
    private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, (JsonElement[] obs, DateTime at)> Cache = new();
    private static readonly TimeSpan CacheTtl = TimeSpan.FromSeconds(60);

    public static void Register(WebApplication app, ServerContext ctx)
    {
        app.MapGet("/airport", async (HttpContext c) =>
        {
            c.Response.ContentType = "text/html";
            await c.Response.SendFileAsync(Path.Combine(ctx.WebRootPath, "airport", "index.html"));
        });
        // Route constraint, not a regex: in a route pattern a regex's {3,4} has to be written {{3,4}},
        // and getting that wrong throws at startup rather than at request time — it took the server
        // down in a restart loop. length(3,4) says the same thing with nothing to escape.
        app.MapGet("/airport/{id:length(3,4)}", async (HttpContext c, string id) =>
        {
            c.Response.ContentType = "text/html";
            await c.Response.SendFileAsync(Path.Combine(ctx.WebRootPath, "airport", "index.html"));
        });

        app.MapGet("/api/airport/{id}", async (string id) =>
        {
            id = (id ?? "").Trim().ToUpperInvariant();
            if (id.Length is < 3 or > 4) return Results.BadRequest(new { error = "3- or 4-letter identifier" });

            var nasr = ctx.GetNasr();
            // Accept either form: KDCA or DCA. NASR keys runways by FAA LID.
            var info = Lookup(nasr, id);
            var lid = info?.Lid ?? (id.Length == 4 && id[0] is 'K' ? id[1..] : id);
            var icao = info?.Icao is { Length: > 0 } ic ? ic
                     : id.Length == 4 ? id
                     : "K" + id;   // good enough for CONUS; AWC simply 404s if it isn't a station

            var obs = await GetObs(icao);
            var cur = obs.Length > 0 ? obs[0] : default;
            var wx = cur.ValueKind == JsonValueKind.Object ? ReadObs(cur) : null;

            List<RunwayDef> rwys = nasr?.Runways.TryGetValue(lid, out var r) == true ? r : new();
            double? elevFt = info?.ElevFt ?? (wx?.ElevM is double em ? em * 3.280839895 : null);

            return Results.Json(new
            {
                id,
                found = info is not null || wx is not null,
                airport = info is null ? null : new
                {
                    lid = info.Lid,
                    icao = info.Icao,
                    name = info.Name,
                    city = info.City,
                    state = info.State,
                    lat = info.Lat,
                    lon = info.Lon,
                    elevFt = info.ElevFt,
                    magVarDeg = info.MagVarDeg,
                    artcc = info.Artcc,
                    twrType = info.TwrType,
                },
                // AWC knows the station name even when NASR doesn't have the id (military, PR, VI).
                stationName = wx?.Name,
                nasrCycle = nasr?.EffectiveDate,
                metar = wx is null ? null : new
                {
                    raw = wx.Raw,
                    type = wx.Type,
                    obsTime = wx.ObsTime,
                    ageSec = wx.ObsTime is null ? (int?)null : (int)(DateTime.UtcNow - wx.ObsTime.Value).TotalSeconds,
                    windDirDeg = wx.WindDir,          // TRUE, like the runway alignments
                    windVariable = wx.WindVrb,
                    windSpeedKt = wx.WindKt,
                    windGustKt = wx.GustKt,
                    visibilitySm = wx.VisSm,
                    visibilityText = wx.VisText,
                    tempC = wx.TempC,
                    dewpointC = wx.DewC,
                    altimeterInHg = wx.AltimInHg,
                    seaLevelPressureMb = wx.SlpMb,
                    clouds = wx.Clouds,
                    ceilingFt = wx.CeilingFt,
                    ceilingText = wx.CeilingText,
                    flightCategory = wx.FltCat,
                    weather = wx.WxString,
                    remarks = wx.Remarks,
                },
                derived = wx is null ? null : Derive(wx, elevFt),
                runways = rwys.Select(rw => new
                {
                    id = rw.Id,
                    lenFt = rw.LenFt,
                    widthFt = rw.WidthFt,
                    surface = rw.Surface,
                    lights = rw.Lights,
                    ends = rw.Ends.Select(e => new
                    {
                        id = e.Id,
                        trueAlignDeg = e.TrueAlign,
                        // What the runway is painted with, and what a controller says. Magnetic =
                        // true - declination (east positive). Getting this backwards is obvious in
                        // the output: a runway numbered 01 would come out at 351 degrees.
                        magAlignDeg = e.TrueAlign is double ta && info?.MagVarDeg is double mvar
                            ? Norm360(ta - mvar) : (double?)null,
                        lat = e.Lat,
                        lon = e.Lon,
                        elevFt = e.ElevFt,
                        ils = e.Ils,
                        displacedThrFt = e.DisplacedThrFt,
                        // Positive head = landing into wind; cross is signed (+ from the right).
                        components = Components(e.TrueAlign, wx?.WindDir, wx?.WindKt, wx?.GustKt),
                    }),
                }),
                // Oldest first, so a chart or a row of "preceding wind" arrows reads left to right.
                history = obs.Skip(1).Select(ReadObs).Where(o => o is not null).Reverse()
                    .Select(o => new
                    {
                        time = o!.ObsTime,
                        dirDeg = o.WindDir,
                        variable = o.WindVrb,
                        speedKt = o.WindKt,
                        gustKt = o.GustKt,
                        tempC = o.TempC,
                        dewpointC = o.DewC,
                        altimeterInHg = o.AltimInHg,
                        visibilitySm = o.VisSm,
                        ceilingFt = o.CeilingFt,
                        flightCategory = o.FltCat,
                    }),
            }, ctx.JsonOpts);
        });
    }

    static AirportInfo? Lookup(NasrData? n, string id)
    {
        if (n is null) return null;
        if (n.AirportInfoIcao.TryGetValue(id, out var byIcao)) return byIcao;
        if (n.AirportInfo.TryGetValue(id, out var byLid)) return byLid;
        // KDCA -> DCA. Only strip a leading K: PANC/PHNL/TJSJ keep their full id as the LID.
        if (id.Length == 4 && id[0] == 'K' && n.AirportInfo.TryGetValue(id[1..], out var stripped)) return stripped;
        return null;
    }

    // ── METAR (aviationweather.gov JSON) ─────────────────────────────────────────────────────
    static async Task<JsonElement[]> GetObs(string icao)
    {
        if (Cache.TryGetValue(icao, out var hit) && DateTime.UtcNow - hit.at < CacheTtl) return hit.obs;
        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(12) };
            // 6 hours covers the preceding-wind arrows and a readable trend without a big payload.
            var url = $"https://aviationweather.gov/api/data/metar?ids={Uri.EscapeDataString(icao)}&format=json&hours=6";
            var json = await http.GetStringAsync(url);
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.ValueKind != JsonValueKind.Array) return Array.Empty<JsonElement>();
            var arr = doc.RootElement.EnumerateArray().Select(e => e.Clone()).ToArray();
            // AWC returns newest first; keep that order (index 0 = current).
            Cache[icao] = (arr, DateTime.UtcNow);
            return arr;
        }
        catch
        {
            // Serve a stale cache rather than nothing — a 40-minute-old METAR still beats a blank
            // board, and the page shows the observation's own age anyway.
            return Cache.TryGetValue(icao, out var old) ? old.obs : Array.Empty<JsonElement>();
        }
    }

    sealed class Obs
    {
        public string? Raw, Type, Name, WxString, Remarks, VisText, CeilingText, FltCat;
        public DateTime? ObsTime;
        public double? WindDir, WindKt, GustKt, VisSm, TempC, DewC, AltimInHg, SlpMb, CeilingFt, ElevM;
        public bool WindVrb;
        public object[]? Clouds;
    }

    static Obs? ReadObs(JsonElement e)
    {
        if (e.ValueKind != JsonValueKind.Object) return null;
        var o = new Obs
        {
            Raw = Str(e, "rawOb"),
            Type = Str(e, "metarType"),
            Name = Str(e, "name"),
            WxString = Str(e, "wxString"),
            FltCat = Str(e, "fltCat"),
            TempC = Num(e, "temp"),
            DewC = Num(e, "dewp"),
            WindKt = Num(e, "wspd"),
            GustKt = Num(e, "wgst"),
            SlpMb = Num(e, "slp"),
            ElevM = Num(e, "elev"),
        };

        if (e.TryGetProperty("obsTime", out var ot) && ot.TryGetInt64(out var unix))
            o.ObsTime = DateTimeOffset.FromUnixTimeSeconds(unix).UtcDateTime;

        // wdir is a number, or the string "VRB" when the direction is variable.
        if (e.TryGetProperty("wdir", out var wd))
        {
            if (wd.ValueKind == JsonValueKind.Number) o.WindDir = wd.GetDouble();
            else if (wd.ValueKind == JsonValueKind.String)
            {
                var sv = wd.GetString() ?? "";
                if (sv.Equals("VRB", StringComparison.OrdinalIgnoreCase)) o.WindVrb = true;
                else if (double.TryParse(sv, out var dv)) o.WindDir = dv;
            }
        }

        // altim comes back in hPa; US displays want inches of mercury.
        var altimHpa = Num(e, "altim");
        if (altimHpa is double hpa && hpa > 0) o.AltimInHg = Math.Round(hpa / 33.8638866667, 2);

        // visib can be "10+" or "1 1/2"; keep the text and a numeric best-effort.
        if (e.TryGetProperty("visib", out var vz))
        {
            if (vz.ValueKind == JsonValueKind.Number) { o.VisSm = vz.GetDouble(); o.VisText = Fmt(o.VisSm) + " SM"; }
            else if (vz.ValueKind == JsonValueKind.String)
            {
                var sv = (vz.GetString() ?? "").Trim();
                o.VisText = sv.Length > 0 ? sv + " SM" : null;
                var numPart = new string(sv.TakeWhile(ch => char.IsDigit(ch) || ch == '.').ToArray());
                if (double.TryParse(numPart, out var nv)) o.VisSm = nv;
            }
        }

        // Ceiling = lowest BKN/OVC/VV layer. FEW/SCT are not a ceiling.
        if (e.TryGetProperty("clouds", out var cl) && cl.ValueKind == JsonValueKind.Array)
        {
            var layers = new List<object>();
            foreach (var c in cl.EnumerateArray())
            {
                var cover = Str(c, "cover") ?? "";
                var baseFt = Num(c, "base");
                layers.Add(new { cover, baseFt });
                if (baseFt is double b && cover is "BKN" or "OVC" or "OVX" or "VV")
                    if (o.CeilingFt is null || b < o.CeilingFt) o.CeilingFt = b;
            }
            o.Clouds = layers.ToArray();
            o.CeilingText = o.CeilingFt is double cf ? $"{cf:0} ft"
                : layers.Count == 0 || (Str(cl.EnumerateArray().FirstOrDefault(), "cover") is "CLR" or "SKC" or "CAVOK")
                    ? "CLR" : "unlimited";
        }

        if (o.Raw is { Length: > 0 } raw)
        {
            var i = raw.IndexOf(" RMK ", StringComparison.Ordinal);
            if (i >= 0) o.Remarks = raw[(i + 5)..].Trim();
        }
        return o;
    }

    // ── derived values ───────────────────────────────────────────────────────────────────────
    static object Derive(Obs wx, double? elevFt)
    {
        double? rh = null, daFt = null, paFt = null, hiF = null, wcF = null, tF = null, dF = null;

        if (wx.TempC is double t)
        {
            tF = t * 9 / 5 + 32;
            if (wx.DewC is double d)
            {
                dF = d * 9 / 5 + 32;
                // Magnus/Tetens — the usual approximation, good to a few tenths of a percent.
                double Es(double c) => 6.112 * Math.Exp(17.67 * c / (c + 243.5));
                rh = Math.Clamp(100.0 * Es(d) / Es(t), 0, 100);
            }
        }

        if (elevFt is double elev && wx.AltimInHg is double alt)
        {
            // Pressure altitude: field elevation corrected for the altimeter setting.
            paFt = elev + (29.92 - alt) * 1000;
            if (wx.TempC is double t2)
            {
                // Density altitude via the ISA deviation form used by the E6-B and by these displays.
                var isaC = 15 - 1.98 * (paFt.Value / 1000);
                daFt = paFt + 118.8 * (t2 - isaC);
            }
        }

        // Heat index (NWS Rothfusz) only means anything in the heat; wind chill only in the cold.
        if (tF is double tf && rh is double r)
        {
            if (tf >= 80 && r >= 40)
            {
                var hi = -42.379 + 2.04901523 * tf + 10.14333127 * r - 0.22475541 * tf * r
                         - 0.00683783 * tf * tf - 0.05481717 * r * r + 0.00122874 * tf * tf * r
                         + 0.00085282 * tf * r * r - 0.00000199 * tf * tf * r * r;
                if (r < 13 && tf is >= 80 and <= 112)
                    hi -= ((13 - r) / 4) * Math.Sqrt((17 - Math.Abs(tf - 95)) / 17);
                else if (r > 85 && tf is >= 80 and <= 87)
                    hi += ((r - 85) / 10) * ((87 - tf) / 5);
                hiF = hi;
            }
        }
        if (tF is double tf2 && wx.WindKt is double kt && tf2 <= 50 && kt >= 3)
        {
            var mph = kt * 1.15077945;
            wcF = 35.74 + 0.6215 * tf2 - 35.75 * Math.Pow(mph, 0.16) + 0.4275 * tf2 * Math.Pow(mph, 0.16);
        }

        return new
        {
            tempF = Round(tF, 0),
            dewpointF = Round(dF, 0),
            relHumidityPct = Round(rh, 0),
            pressureAltFt = Round(paFt, 0),
            densityAltFt = Round(daFt, 0),
            heatIndexF = Round(hiF, 0),
            windChillF = Round(wcF, 0),
            fieldElevFt = Round(elevFt, 0),
        };
    }

    /// <summary>
    /// Head/crosswind for one runway end. Head is positive into wind (a headwind on landing);
    /// cross is signed, positive when it blows from the right of the landing direction, which is
    /// how a tower display labels "from the right". Both in knots, gusts carried alongside.
    /// </summary>
    static object? Components(double? trueAlign, double? windDir, double? windKt, double? gustKt)
    {
        if (trueAlign is not double rw || windDir is not double wd || windKt is not double kt) return null;
        var delta = (wd - rw) * Math.PI / 180.0;
        var head = kt * Math.Cos(delta);
        var cross = kt * Math.Sin(delta);
        double? gHead = null, gCross = null;
        if (gustKt is double g) { gHead = g * Math.Cos(delta); gCross = g * Math.Sin(delta); }
        return new
        {
            headKt = Math.Round(head, 1),
            crossKt = Math.Round(cross, 1),
            crossFrom = cross >= 0 ? "R" : "L",
            tailwind = head < 0,
            gustHeadKt = Round(gHead, 1),
            gustCrossKt = Round(gCross, 1),
            angleDeg = Math.Round(Math.Abs(((wd - rw + 540) % 360) - 180), 0),
        };
    }

    static double Norm360(double d) => ((d % 360) + 360) % 360;
    static double? Round(double? v, int digits) => v is double d ? Math.Round(d, digits) : null;
    static string Fmt(double? v) => v is double d ? d.ToString("0.##") : "";
    static string? Str(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var p) && p.ValueKind == JsonValueKind.String
            ? p.GetString() : null;
    static double? Num(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var p) && p.ValueKind == JsonValueKind.Number
            ? p.GetDouble() : null;
}
