using System.IO.Compression;
using System.Text.RegularExpressions;

namespace SwimServer;

/// <summary>
/// Downloads, parses and resolves the FAA NASR 28-Day Subscription data set.
///
/// Public surface:
///   - LoadAsync(...)               — full download + parse pipeline; returns the parsed NasrData
///   - ResolveRoute(...)            — turn a route string into a list of [lat,lon] waypoints
///   - LookupAirport / LookupPoint  — single-fix lookup helpers (used by other route resolvers)
/// </summary>
static class NasrService
{
    static readonly Regex AirwayPattern = new(@"^[JVQTLMNP]\d+$", RegexOptions.Compiled);

    // ── Loader ──────────────────────────────────────────────────────────────

    /// <summary>
    /// Compute the AIRAC effective date, ensure CSVs are downloaded, and parse them.
    /// Returns null if download/parse fails or data is already loaded for this cycle
    /// (caller should check existingData?.EffectiveDate before discarding).
    /// </summary>
    public static async Task<NasrData?> LoadAsync(NasrData? existingData)
    {
        var nasrDir = Path.Combine(Directory.GetCurrentDirectory(), "nasr-data");
        Directory.CreateDirectory(nasrDir);

        // Calculate current AIRAC cycle effective date
        // Reference: 2026-01-22 is a known AIRAC date; cycles are every 28 days
        var reference = new DateTime(2026, 1, 22, 0, 0, 0, DateTimeKind.Utc);
        var today = DateTime.UtcNow.Date;
        var daysSinceRef = (int)(today - reference).TotalDays;
        var cycleOffset = daysSinceRef >= 0 ? (daysSinceRef / 28) * 28 : ((daysSinceRef / 28) - 1) * 28;
        var effectiveDate = reference.AddDays(cycleOffset);
        var dateStr = effectiveDate.ToString("yyyy-MM-dd");

        var cycleDir = Path.Combine(nasrDir, dateStr);

        // Check if already loaded for this cycle
        if (existingData?.EffectiveDate == dateStr)
        {
            Console.WriteLine($"[NASR] Already loaded cycle {dateStr}");
            return null;
        }

        // Check for cached CSVs (re-download if new files like ILS_BASE.csv are missing)
        var navFile = Path.Combine(cycleDir, "NAV_BASE.csv");
        var ilsFile = Path.Combine(cycleDir, "ILS_BASE.csv");
        if (!File.Exists(navFile) || !File.Exists(ilsFile))
        {
            Console.WriteLine($"[NASR] Downloading cycle {dateStr}...");
            await DownloadNasr(effectiveDate, cycleDir);
        }

        if (!File.Exists(navFile))
        {
            Console.WriteLine("[NASR] CSV files not found after download attempt");
            return null;
        }

        Console.WriteLine($"[NASR] Parsing cycle {dateStr}...");
        var data = new NasrData { EffectiveDate = dateStr };

        data.Navaids = ParseNavBase(Path.Combine(cycleDir, "NAV_BASE.csv"));
        Console.WriteLine($"[NASR]   Navaids: {data.Navaids.Count} identifiers");

        data.Fixes = ParseFixBase(Path.Combine(cycleDir, "FIX_BASE.csv"));
        Console.WriteLine($"[NASR]   Fixes: {data.Fixes.Count} identifiers");

        (data.Airports, data.AirportsIcao, data.AirportOverlay) = ParseAptBase(Path.Combine(cycleDir, "APT_BASE.csv"));
        Console.WriteLine($"[NASR]   Airports: {data.Airports.Count} FAA LIDs, {data.AirportsIcao.Count} ICAO, {data.AirportOverlay.Count} overlay (B/C/D/E)");

        data.Airways = ParseAwyBase(Path.Combine(cycleDir, "AWY_BASE.csv"));
        Console.WriteLine($"[NASR]   Airways: {data.Airways.Count} routes");

        // Parse SID/STAR procedures (optional — files may not exist)
        data.Procedures = new Dictionary<string, List<ProcedureDef>>(StringComparer.OrdinalIgnoreCase);
        data.ProceduresFull = new Dictionary<string, List<ProcedureFullDef>>(StringComparer.OrdinalIgnoreCase);
        try
        {
            var stars = ParseProcedureCsvs(cycleDir, "STAR", out var starsFull);
            foreach (var kv in stars) data.Procedures[kv.Key] = kv.Value;
            foreach (var kv in starsFull) data.ProceduresFull[kv.Key] = kv.Value;
            Console.WriteLine($"[NASR]   STARs: {stars.Count} procedures ({starsFull.Count} full)");
        }
        catch (Exception ex) { Console.WriteLine($"[NASR]   STAR parse skipped: {ex.Message}"); }
        try
        {
            var dps = ParseProcedureCsvs(cycleDir, "DP", out var dpsFull);
            foreach (var kv in dps)
            {
                if (data.Procedures.ContainsKey(kv.Key))
                    data.Procedures[kv.Key].AddRange(kv.Value);
                else
                    data.Procedures[kv.Key] = kv.Value;
            }
            foreach (var kv in dpsFull)
            {
                if (data.ProceduresFull.ContainsKey(kv.Key))
                    data.ProceduresFull[kv.Key].AddRange(kv.Value);
                else
                    data.ProceduresFull[kv.Key] = kv.Value;
            }
            Console.WriteLine($"[NASR]   DPs (SIDs): {dps.Count} procedures ({dpsFull.Count} full)");
        }
        catch (Exception ex) { Console.WriteLine($"[NASR]   DP parse skipped: {ex.Message}"); }

        // Parse ILS/LOC/LDA centerlines (optional)
        try
        {
            data.Centerlines = ParseIlsCenterlines(Path.Combine(cycleDir, "ILS_BASE.csv"));
            Console.WriteLine($"[NASR]   Centerlines: {data.Centerlines.Count} ILS/LOC/LDA approaches");
        }
        catch (Exception ex) { Console.WriteLine($"[NASR]   ILS parse skipped: {ex.Message}"); }

        Console.WriteLine($"[NASR] Loaded successfully — cycle {dateStr}");
        return data;
    }

    static async Task DownloadNasr(DateTime effectiveDate, string outputDir)
    {
        Directory.CreateDirectory(outputDir);
        var dateUrl = effectiveDate.ToString("yyyy-MM-dd");
        var url = $"https://nfdc.faa.gov/webContent/28DaySub/28DaySubscription_Effective_{dateUrl}.zip";

        using var http = new HttpClient { Timeout = TimeSpan.FromMinutes(10) };
        Console.WriteLine($"[NASR] GET {url}");

        using var response = await http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead);
        if (!response.IsSuccessStatusCode)
        {
            Console.WriteLine($"[NASR] Download failed: {response.StatusCode}");
            return;
        }

        // Stream outer zip to temp file
        var tempZip = Path.Combine(outputDir, "outer.zip");
        await using (var fs = File.Create(tempZip))
            await response.Content.CopyToAsync(fs);

        var size = new FileInfo(tempZip).Length;
        Console.WriteLine($"[NASR] Downloaded {size / 1024 / 1024}MB, extracting CSV data...");

        // Find and extract the inner CSV zip
        var innerZipPath = Path.Combine(outputDir, "csv.zip");
        using (var outerZip = ZipFile.OpenRead(tempZip))
        {
            var csvZipEntry = outerZip.Entries.FirstOrDefault(e =>
                e.FullName.Contains("CSV_Data/", StringComparison.OrdinalIgnoreCase) &&
                e.Name.EndsWith("_CSV.zip", StringComparison.OrdinalIgnoreCase));

            if (csvZipEntry is null)
            {
                Console.WriteLine("[NASR] Could not find CSV zip inside subscription");
                outerZip.Dispose();
                File.Delete(tempZip);
                return;
            }

            csvZipEntry.ExtractToFile(innerZipPath, overwrite: true);
        } // outerZip closed here — safe to delete

        // Extract the CSV files we need from the inner zip
        var needed = new[] { "NAV_BASE.csv", "FIX_BASE.csv", "AWY_BASE.csv", "APT_BASE.csv", "ILS_BASE.csv" };
        // Also extract STAR, DP, and ILS procedure files
        using (var innerZip = ZipFile.OpenRead(innerZipPath))
        {
            foreach (var entry in innerZip.Entries)
            {
                var name = entry.Name;
                bool isNeeded = needed.Any(n => name.Equals(n, StringComparison.OrdinalIgnoreCase))
                    || name.StartsWith("STAR_", StringComparison.OrdinalIgnoreCase) && name.EndsWith(".csv", StringComparison.OrdinalIgnoreCase)
                    || name.StartsWith("DP_", StringComparison.OrdinalIgnoreCase) && name.EndsWith(".csv", StringComparison.OrdinalIgnoreCase)
                    || name.StartsWith("ILS_", StringComparison.OrdinalIgnoreCase) && name.EndsWith(".csv", StringComparison.OrdinalIgnoreCase);
                if (isNeeded)
                {
                    var dest = Path.Combine(outputDir, name);
                    entry.ExtractToFile(dest, overwrite: true);
                    Console.WriteLine($"[NASR]   Extracted {name} ({entry.Length / 1024}KB)");
                }
            }
        } // innerZip closed here — safe to delete

        // Cleanup temp zips
        File.Delete(tempZip);
        File.Delete(innerZipPath);
    }

    // ── CSV parsers ────────────────────────────────────────────────────────

    static List<string> ParseCsvLine(string line)
    {
        var fields = new List<string>();
        var i = 0;
        while (i < line.Length)
        {
            if (line[i] == '"')
            {
                var end = line.IndexOf('"', i + 1);
                if (end < 0) end = line.Length;
                fields.Add(line[(i + 1)..end]);
                i = end + 2; // skip closing quote + comma
            }
            else
            {
                var end = line.IndexOf(',', i);
                if (end < 0) end = line.Length;
                fields.Add(line[i..end]);
                i = end + 1;
            }
        }
        return fields;
    }

    static int ColIdx(List<string> headers, string name) =>
        headers.FindIndex(h => h.Equals(name, StringComparison.OrdinalIgnoreCase));

    static Dictionary<string, List<NavPoint>> ParseNavBase(string path)
    {
        var result = new Dictionary<string, List<NavPoint>>(StringComparer.OrdinalIgnoreCase);
        using var reader = new StreamReader(path);
        var headers = ParseCsvLine(reader.ReadLine()!);
        int iId = ColIdx(headers, "NAV_ID"), iLat = ColIdx(headers, "LAT_DECIMAL"), iLon = ColIdx(headers, "LONG_DECIMAL");
        int iType = ColIdx(headers, "NAV_TYPE");
        if (iId < 0 || iLat < 0 || iLon < 0) return result;

        while (reader.ReadLine() is { } line)
        {
            var f = ParseCsvLine(line);
            if (f.Count <= Math.Max(iId, Math.Max(iLat, iLon))) continue;
            if (!double.TryParse(f[iLat], out var lat) || !double.TryParse(f[iLon], out var lon)) continue;
            var id = f[iId].Trim();
            if (string.IsNullOrEmpty(id)) continue;
            var type = (iType >= 0 && iType < f.Count) ? f[iType].Trim() : "";
            if (!result.ContainsKey(id)) result[id] = new List<NavPoint>();
            result[id].Add(new NavPoint(id, lat, lon, type));
        }
        return result;
    }

    static Dictionary<string, List<NavPoint>> ParseFixBase(string path)
    {
        var result = new Dictionary<string, List<NavPoint>>(StringComparer.OrdinalIgnoreCase);
        using var reader = new StreamReader(path);
        var headers = ParseCsvLine(reader.ReadLine()!);
        int iId = ColIdx(headers, "FIX_ID"), iLat = ColIdx(headers, "LAT_DECIMAL"), iLon = ColIdx(headers, "LONG_DECIMAL");
        if (iId < 0 || iLat < 0 || iLon < 0) return result;

        while (reader.ReadLine() is { } line)
        {
            var f = ParseCsvLine(line);
            if (f.Count <= Math.Max(iId, Math.Max(iLat, iLon))) continue;
            if (!double.TryParse(f[iLat], out var lat) || !double.TryParse(f[iLon], out var lon)) continue;
            var id = f[iId].Trim();
            if (string.IsNullOrEmpty(id)) continue;
            if (!result.ContainsKey(id)) result[id] = new List<NavPoint>();
            result[id].Add(new NavPoint(id, lat, lon));
        }
        return result;
    }

    static (Dictionary<string, NavPoint> byLid, Dictionary<string, NavPoint> byIcao, List<AirportOverlayPoint> overlay) ParseAptBase(string path)
    {
        var byLid = new Dictionary<string, NavPoint>(StringComparer.OrdinalIgnoreCase);
        var byIcao = new Dictionary<string, NavPoint>(StringComparer.OrdinalIgnoreCase);
        var overlay = new List<AirportOverlayPoint>();
        using var reader = new StreamReader(path);
        var headers = ParseCsvLine(reader.ReadLine()!);
        int iId = ColIdx(headers, "ARPT_ID"), iIcao = ColIdx(headers, "ICAO_ID");
        int iLat = ColIdx(headers, "LAT_DECIMAL"), iLon = ColIdx(headers, "LONG_DECIMAL");
        int iSiteType = ColIdx(headers, "SITE_TYPE_CODE"), iUse = ColIdx(headers, "FACILITY_USE_CODE");
        int iStatus = ColIdx(headers, "ARPT_STATUS"), iTwr = ColIdx(headers, "TWR_TYPE_CODE");
        int iFar139 = ColIdx(headers, "FAR_139_TYPE_CODE");
        if (iId < 0 || iLat < 0 || iLon < 0) return (byLid, byIcao, overlay);

        while (reader.ReadLine() is { } line)
        {
            var f = ParseCsvLine(line);
            if (f.Count <= Math.Max(iId, Math.Max(iLat, iLon))) continue;
            if (!double.TryParse(f[iLat], out var lat) || !double.TryParse(f[iLon], out var lon)) continue;
            var lid = f[iId].Trim();
            if (string.IsNullOrEmpty(lid)) continue;
            var pt = new NavPoint(lid, lat, lon);
            byLid.TryAdd(lid, pt);
            var icao = "";
            if (iIcao >= 0 && iIcao < f.Count)
            {
                icao = f[iIcao].Trim();
                if (!string.IsNullOrEmpty(icao)) byIcao.TryAdd(icao, pt);
            }

            // Build airport overlay: public-use operational airports only
            var siteType = iSiteType >= 0 && iSiteType < f.Count ? f[iSiteType].Trim() : "";
            var use = iUse >= 0 && iUse < f.Count ? f[iUse].Trim() : "";
            var status = iStatus >= 0 && iStatus < f.Count ? f[iStatus].Trim() : "";
            if (siteType.Equals("A", StringComparison.OrdinalIgnoreCase) &&
                use.Equals("PU", StringComparison.OrdinalIgnoreCase) &&
                status.Equals("O", StringComparison.OrdinalIgnoreCase))
            {
                var twr = iTwr >= 0 && iTwr < f.Count ? f[iTwr].Trim() : "";
                var far139 = iFar139 >= 0 && iFar139 < f.Count ? f[iFar139].Trim() : "";

                // Derive airspace class from tower type + FAR 139 certification
                string cls;
                if (far139.StartsWith("I E", StringComparison.OrdinalIgnoreCase))
                    cls = "B";
                else if (twr.Contains("TRACON", StringComparison.OrdinalIgnoreCase) ||
                         twr.Contains("RAPCON", StringComparison.OrdinalIgnoreCase) ||
                         twr.Contains("RATCF", StringComparison.OrdinalIgnoreCase) ||
                         twr.Contains("A/C", StringComparison.OrdinalIgnoreCase))
                    cls = "C";
                else if (twr.StartsWith("ATCT", StringComparison.OrdinalIgnoreCase))
                    cls = "D";
                else
                    cls = "E";

                overlay.Add(new AirportOverlayPoint(lid, icao, lat, lon, cls));
            }
        }
        return (byLid, byIcao, overlay);
    }

    // Great-circle destination point from a given lat/lon, bearing (degrees), and distance (NM)
    static (double lat, double lon) DestPoint(double lat, double lon, double brngDeg, double distNm)
    {
        const double R = 3440.065; // earth radius in NM
        double d = distNm / R;
        double lat1 = lat * Math.PI / 180, lon1 = lon * Math.PI / 180, brng = brngDeg * Math.PI / 180;
        double lat2 = Math.Asin(Math.Sin(lat1) * Math.Cos(d) + Math.Cos(lat1) * Math.Sin(d) * Math.Cos(brng));
        double lon2 = lon1 + Math.Atan2(Math.Sin(brng) * Math.Sin(d) * Math.Cos(lat1),
                                         Math.Cos(d) - Math.Sin(lat1) * Math.Sin(lat2));
        return (lat2 * 180 / Math.PI, lon2 * 180 / Math.PI);
    }

    static List<CenterlinePoint> ParseIlsCenterlines(string path)
    {
        var result = new List<CenterlinePoint>();
        if (!File.Exists(path)) return result;

        using var reader = new StreamReader(path);
        var headers = ParseCsvLine(reader.ReadLine()!);

        int iApt = ColIdx(headers, "ARPT_ID");
        if (iApt < 0) iApt = ColIdx(headers, "FACILITY_SITE_NO"); // fallback
        int iRwy = ColIdx(headers, "RWY_END_ID");
        if (iRwy < 0) iRwy = ColIdx(headers, "RWY_ID");

        // System type — try multiple column names
        int iType = ColIdx(headers, "SYSTEM_TYPE");
        if (iType < 0) iType = ColIdx(headers, "ILS_COMP_TYPE_CODE");
        if (iType < 0) iType = ColIdx(headers, "ILS_TYPE");
        if (iType < 0) iType = ColIdx(headers, "SYSTEM_TYPE_CODE");

        int iLat = ColIdx(headers, "LAT_DECIMAL");
        int iLon = ColIdx(headers, "LONG_DECIMAL");

        // Approach bearing — try multiple column names
        int iBrg = ColIdx(headers, "LOC_BEARING");
        if (iBrg < 0) iBrg = ColIdx(headers, "APCH_BEAR");
        if (iBrg < 0) iBrg = ColIdx(headers, "MAG_BRG");
        if (iBrg < 0) iBrg = ColIdx(headers, "ILS_MAG_BRG");

        int iVar = ColIdx(headers, "MAG_VARN");
        if (iVar < 0) iVar = ColIdx(headers, "MAG_VAR");
        int iVarH = ColIdx(headers, "MAG_VAR_HEMIS");
        if (iVarH < 0) iVarH = ColIdx(headers, "MAG_VARN_HEMIS");
        if (iVarH < 0) iVarH = ColIdx(headers, "MAG_HEMIS");

        int iLen = ColIdx(headers, "RWY_LEN");
        if (iLen < 0) iLen = ColIdx(headers, "RWY_LENGTH");

        // Log discovered columns for debugging
        Console.WriteLine($"[NASR]   ILS columns: apt={iApt} rwy={iRwy} type={iType} lat={iLat} lon={iLon} brg={iBrg} var={iVar} varH={iVarH} len={iLen}");

        if (iApt < 0 || iLat < 0 || iLon < 0 || iBrg < 0) {
            Console.WriteLine("[NASR]   ILS_BASE.csv: missing required columns, skipping centerlines");
            Console.WriteLine($"[NASR]   Headers: {string.Join(", ", headers.Take(30))}");
            return result;
        }

        while (reader.ReadLine() is { } line)
        {
            var f = ParseCsvLine(line);
            var maxIdx = Math.Max(iApt, Math.Max(iLat, Math.Max(iLon, iBrg)));
            if (f.Count <= maxIdx) continue;

            // All records in ILS_BASE.csv are ILS/LOC/LDA/SDF approaches
            // System type codes: LS=ILS, LD=ILS/DME, LC=LOC, LE=LDA/DME, LG=LDA/GS, LA=LDA, SF=SDF, SD=SDF/DME, DD=DME
            // Skip DD (DME-only, no localizer component)
            if (iType >= 0 && iType < f.Count)
            {
                var sysType = f[iType].Trim().ToUpperInvariant();
                if (sysType == "DD") continue;
            }

            if (!double.TryParse(f[iLat], out var locLat) || !double.TryParse(f[iLon], out var locLon)) continue;
            if (!double.TryParse(f[iBrg], out var magBrg)) continue;

            // Magnetic variation → true bearing
            double magVar = 0;
            if (iVar >= 0 && iVar < f.Count && double.TryParse(f[iVar], out var mv))
            {
                var hemis = iVarH >= 0 && iVarH < f.Count ? f[iVarH].Trim().ToUpperInvariant() : "W";
                magVar = hemis == "E" ? mv : -mv;
            }
            double trueBrg = magBrg + magVar;

            // Runway length (feet) → NM; default to ~7000ft if missing
            double rwyLenFt = 7000;
            if (iLen >= 0 && iLen < f.Count && double.TryParse(f[iLen], out var lenFt) && lenFt > 0)
                rwyLenFt = lenFt;
            double rwyLenNm = rwyLenFt / 6076.12;

            // Reverse bearing = direction from localizer toward threshold (and beyond)
            double reverseBrg = trueBrg + 180;

            // Compute threshold (approx: localizer position + rwy length along reverse bearing)
            var threshold = DestPoint(locLat, locLon, reverseBrg, rwyLenNm);
            // Compute 15 NM endpoint from threshold
            var farPoint = DestPoint(threshold.lat, threshold.lon, reverseBrg, 15.0);

            var aptId = f[iApt].Trim();
            var rwyId = iRwy >= 0 && iRwy < f.Count ? f[iRwy].Trim() : "";

            result.Add(new CenterlinePoint(threshold.lat, threshold.lon, farPoint.lat, farPoint.lon, aptId, rwyId));
        }
        return result;
    }

    static Dictionary<string, AirwayDef> ParseAwyBase(string path)
    {
        var result = new Dictionary<string, AirwayDef>(StringComparer.OrdinalIgnoreCase);
        using var reader = new StreamReader(path);
        var headers = ParseCsvLine(reader.ReadLine()!);
        int iId = ColIdx(headers, "AWY_ID"), iDesig = ColIdx(headers, "AWY_DESIGNATION"), iStr = ColIdx(headers, "AIRWAY_STRING");
        if (iId < 0 || iStr < 0) return result;

        while (reader.ReadLine() is { } line)
        {
            var f = ParseCsvLine(line);
            if (f.Count <= Math.Max(iId, iStr)) continue;
            var id = f[iId].Trim();
            var desig = iDesig >= 0 && iDesig < f.Count ? f[iDesig].Trim() : "";
            var awyStr = f[iStr].Trim();
            if (string.IsNullOrEmpty(id) || string.IsNullOrEmpty(awyStr)) continue;
            var fixes = awyStr.Split(' ', StringSplitOptions.RemoveEmptyEntries).ToList();
            result.TryAdd(id, new AirwayDef(id, desig, fixes));
        }
        return result;
    }

    // Parse SID/STAR procedure CSV files — adaptive header detection
    // These files have a route/leg structure with fix sequences per procedure
    static Dictionary<string, List<ProcedureDef>> ParseProcedureCsvs(string cycleDir, string type, out Dictionary<string, List<ProcedureFullDef>> fullResult)
    {
        // type = "STAR" or "DP"
        // Files: {type}_BASE.csv has procedure name + airport, {type}_RTE.csv has fix sequences
        // Computer codes like "ALWYZ.FRDMM6" → route strings use the part after the dot ("FRDMM6")
        var result = new Dictionary<string, List<ProcedureDef>>(StringComparer.OrdinalIgnoreCase);
        fullResult = new Dictionary<string, List<ProcedureFullDef>>(StringComparer.OrdinalIgnoreCase);
        if (!Directory.Exists(cycleDir)) return result;

        var codeCol = type == "STAR" ? "STAR_COMPUTER_CODE" : "DP_COMPUTER_CODE";

        // Step 1: Parse BASE file to get computer_code → airport mapping
        var baseFile = Path.Combine(cycleDir, $"{type}_BASE.csv");
        var codeToAirports = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (File.Exists(baseFile))
        {
            using var br = new StreamReader(baseFile);
            var bh = ParseCsvLine(br.ReadLine()!);
            int iCode = bh.FindIndex(h => h.Trim().Equals(codeCol, StringComparison.OrdinalIgnoreCase));
            int iApt = bh.FindIndex(h => h.Trim().Equals("SERVED_ARPT", StringComparison.OrdinalIgnoreCase));
            if (iCode >= 0 && iApt >= 0)
            {
                while (br.ReadLine() is { } line)
                {
                    var f = ParseCsvLine(line);
                    if (f.Count > Math.Max(iCode, iApt))
                        codeToAirports[f[iCode].Trim()] = f[iApt].Trim().ToUpperInvariant();
                }
            }
            Console.WriteLine($"[NASR]   {type}_BASE: {codeToAirports.Count} procedures");
        }

        // Step 2: Parse RTE file to get fix sequences per computer code
        var rteFile = Path.Combine(cycleDir, $"{type}_RTE.csv");
        if (!File.Exists(rteFile))
        {
            Console.WriteLine($"[NASR]   {type}_RTE.csv not found");
            return result;
        }

        using var reader = new StreamReader(rteFile);
        var headers = ParseCsvLine(reader.ReadLine()!);

        int iRteCode = headers.FindIndex(h => h.Trim().Equals(codeCol, StringComparison.OrdinalIgnoreCase));
        int iFix = headers.FindIndex(h => h.Trim().Equals("POINT", StringComparison.OrdinalIgnoreCase));
        int iSeq = headers.FindIndex(h => h.Trim().Equals("POINT_SEQ", StringComparison.OrdinalIgnoreCase));
        int iRouteType = headers.FindIndex(h => h.Trim().Equals("ROUTE_PORTION_TYPE", StringComparison.OrdinalIgnoreCase));
        int iTransCode = headers.FindIndex(h => h.Trim().Equals("TRANSITION_COMPUTER_CODE", StringComparison.OrdinalIgnoreCase));
        int iRouteName = headers.FindIndex(h => h.Trim().Equals("ROUTE_NAME", StringComparison.OrdinalIgnoreCase));

        if (iRteCode < 0 || iFix < 0)
        {
            Console.WriteLine($"[NASR]   Missing columns: {codeCol}={iRteCode}, POINT={iFix}");
            return result;
        }

        // Read all rows grouped by computer code
        var rows = new List<(string code, string routeType, string routeName, string tranCode, int seq, string fix)>();
        while (reader.ReadLine() is { } line)
        {
            var f = ParseCsvLine(line);
            if (f.Count <= Math.Max(iRteCode, iFix)) continue;
            var code = f[iRteCode].Trim();
            var fix = f[iFix].Trim().ToUpperInvariant();
            if (string.IsNullOrEmpty(code) || string.IsNullOrEmpty(fix)) continue;

            var routeType = iRouteType >= 0 && iRouteType < f.Count ? f[iRouteType].Trim().ToUpperInvariant() : "";
            var routeName = iRouteName >= 0 && iRouteName < f.Count ? f[iRouteName].Trim() : "";
            var tranCode = iTransCode >= 0 && iTransCode < f.Count ? f[iTransCode].Trim() : "";
            var seq = 0;
            if (iSeq >= 0 && iSeq < f.Count) int.TryParse(f[iSeq].Trim(), out seq);
            rows.Add((code, routeType, routeName, tranCode, seq, fix));
        }

        // Group by computer code and build fix sequences
        // For BODY portions, extract only the common (non-runway-dependent) fixes:
        // each ROUTE_NAME is a separate leg (different runway); we keep only fixes shared by ALL legs,
        // then reverse them to flight direction (stored order is opposite to flight direction)
        var grouped = rows.GroupBy(r => r.code);
        foreach (var g in grouped)
        {
            var computerCode = g.Key;
            var bodyRows = g.Where(r => r.routeType == "BODY" || string.IsNullOrEmpty(r.routeType)).ToList();

            // Group body rows by ROUTE_NAME to get individual legs
            var legs = bodyRows
                .GroupBy(r => r.routeName)
                .Select(lg => lg.OrderBy(r => r.seq).Select(r => r.fix).Where(f => !string.IsNullOrEmpty(f)).ToList())
                .Where(leg => leg.Count > 0)
                .ToList();

            // Extract procedure identifier and airport (needed for both common and full defs)
            var dotIdx = computerCode.IndexOf('.');
            var afterDot = dotIdx >= 0 ? computerCode[(dotIdx + 1)..].Trim().ToUpperInvariant() : computerCode.Trim().ToUpperInvariant();
            var beforeDot = dotIdx >= 0 ? computerCode[..dotIdx].Trim().ToUpperInvariant() : computerCode.Trim().ToUpperInvariant();
            codeToAirports.TryGetValue(computerCode, out var airports);
            var airport = airports?.Split(' ', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault() ?? "";
            var identifiers = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            if (!string.IsNullOrEmpty(afterDot)) identifiers.Add(afterDot);
            if (!string.IsNullOrEmpty(beforeDot) && beforeDot != afterDot) identifiers.Add(beforeDot);

            // Build full leg data for procedure map overlay (all body legs + transitions)
            var allLegs = new List<List<string>>();
            foreach (var leg in legs)
            {
                var copy = new List<string>(leg);
                copy.Reverse(); // Reverse to flight direction
                if (copy.Count >= 2) allLegs.Add(copy);
            }
            var transGroups = g.Where(r => r.routeType == "TRANSITION").GroupBy(r => r.tranCode);
            foreach (var tg in transGroups)
            {
                var tranFixes = tg.OrderBy(r => r.seq).Select(r => r.fix)
                    .Where(f => !string.IsNullOrEmpty(f)).ToList();
                tranFixes.Reverse();
                if (tranFixes.Count >= 2) allLegs.Add(tranFixes);
            }
            if (allLegs.Count > 0)
            {
                // Use the versioned name (with trailing digit) as canonical Id to avoid duplicates
                var procId = identifiers.FirstOrDefault(id => id.Length > 0 && char.IsDigit(id[^1])) ?? identifiers.First();
                var fDef = new ProcedureFullDef(procId, airport, type, allLegs);
                foreach (var ident in identifiers)
                {
                    if (!fullResult.ContainsKey(ident)) fullResult[ident] = new List<ProcedureFullDef>();
                    fullResult[ident].Add(fDef);
                }
            }

            // Build common (non-runway-dependent) body fixes for QU route resolution
            List<string> bodyFixes;
            if (legs.Count <= 1)
            {
                bodyFixes = (legs.Count == 1 ? legs[0] : bodyRows.OrderBy(r => r.seq).Select(r => r.fix)
                    .Where(f => !string.IsNullOrEmpty(f)).Distinct().ToList());
                bodyFixes.Reverse();
            }
            else
            {
                var commonFixes = new HashSet<string>(legs[0], StringComparer.OrdinalIgnoreCase);
                foreach (var leg in legs.Skip(1))
                    commonFixes.IntersectWith(leg);
                var shortestLeg = legs.OrderBy(l => l.Count).First();
                bodyFixes = shortestLeg.Where(f => commonFixes.Contains(f)).ToList();
                bodyFixes.Reverse();
            }

            if (bodyFixes.Count < 1) continue;

            // Build transitions for QU route resolution (enroute portions only, not runway legs)
            // SID transitions: stem → enroute (after body); STAR transitions: enroute → stem (before body)
            var transitions = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);
            foreach (var tg in transGroups)
            {
                var tranFixes = tg.OrderBy(r => r.seq).Select(r => r.fix)
                    .Where(f => !string.IsNullOrEmpty(f)).ToList();
                tranFixes.Reverse(); // Reverse to flight direction
                if (tranFixes.Count < 2) continue;

                // Determine transition name from transition code: the part that ISN'T the procedure name
                var tc = tg.Key;
                var tdot = tc.IndexOf('.');
                string transName;
                if (tdot >= 0)
                {
                    var tBefore = tc[..tdot].Trim().ToUpperInvariant();
                    var tAfter = tc[(tdot + 1)..].Trim().ToUpperInvariant();
                    transName = identifiers.Contains(tAfter) ? tBefore
                        : identifiers.Contains(tBefore) ? tAfter
                        : tAfter; // default to after-dot
                }
                else
                {
                    transName = tc.Trim().ToUpperInvariant();
                }

                // Key by the enroute endpoint: SID = last fix, STAR = first fix
                var endpointKey = type == "DP" ? tranFixes[^1] : tranFixes[0];
                if (!string.IsNullOrEmpty(endpointKey))
                    transitions[endpointKey] = tranFixes;
                // Also register by transition name
                if (!string.IsNullOrEmpty(transName) && !transitions.ContainsKey(transName))
                    transitions[transName] = tranFixes;
            }

            foreach (var ident in identifiers)
            {
                var def = new ProcedureDef(ident, airport, type, bodyFixes, transitions);
                if (!result.ContainsKey(ident)) result[ident] = new List<ProcedureDef>();
                result[ident].Add(def);
            }
        }

        return result;
    }

    // ── Route resolver ────────────────────────────────────────────────────

    public static List<double[]> ResolveRoute(string routeText, string? origin, string? destination, NasrData nasr)
    {
        var waypoints = new List<double[]>();
        NavPoint? lastPt = null;

        // Add origin airport
        if (!string.IsNullOrEmpty(origin))
        {
            var apt = LookupAirport(origin, nasr);
            if (apt is not null) { waypoints.Add(new[] { apt.Lat, apt.Lon }); lastPt = apt; }
        }

        // Tokenize: split on spaces and dots, filter out DCT, "/", and empty tokens
        var tokens = routeText.Split(new[] { ' ', '.' }, StringSplitOptions.RemoveEmptyEntries)
            .Where(t => !t.Equals("DCT", StringComparison.OrdinalIgnoreCase) && t != "/")
            .ToArray();

        for (int i = 0; i < tokens.Length; i++)
        {
            var token = tokens[i].ToUpperInvariant();

            // Strip speed/altitude annotations (e.g., FIX/N0450F350)
            var slash = token.IndexOf('/');
            if (slash > 0) token = token[..slash];

            if (AirwayPattern.IsMatch(token))
            {
                // Airway: resolve intermediate fixes between entry and exit
                string? exitFix = null;
                if (i + 1 < tokens.Length)
                {
                    exitFix = tokens[i + 1].ToUpperInvariant();
                    var es = exitFix.IndexOf('/');
                    if (es > 0) exitFix = exitFix[..es];
                }
                var awyPts = ResolveAirway(token, lastPt, exitFix, nasr);
                foreach (var pt in awyPts)
                {
                    waypoints.Add(new[] { pt.Lat, pt.Lon });
                    lastPt = pt;
                }
                if (exitFix is not null) i++; // skip exit fix (already included)
            }
            else
            {
                // Skip tokens that are just the origin/destination (already added)
                if (token == origin?.ToUpperInvariant() || token == destination?.ToUpperInvariant()) continue;

                // Fix/navaid/airport
                var pt = LookupPoint(token, lastPt, nasr);

                // If not found, try fix-radial-distance (FRD) format: {navaid}{radial:3}{distance:3}
                // e.g., SBY217078 = SBY VOR, radial 217°, 78nm
                if (pt is null && token.Length >= 8 && char.IsDigit(token[^1]))
                {
                    var nameEnd = token.Length;
                    while (nameEnd > 0 && char.IsDigit(token[nameEnd - 1])) nameEnd--;
                    var digits = token[nameEnd..];
                    var baseName = token[..nameEnd];
                    if (digits.Length == 6 && nameEnd >= 2)
                    {
                        // FRD: 3-digit radial + 3-digit distance
                        var basePt = LookupPoint(baseName, lastPt, nasr);
                        if (basePt is not null &&
                            int.TryParse(digits[..3], out var radial) &&
                            int.TryParse(digits[3..], out var distNm) &&
                            radial >= 0 && radial <= 360 && distNm > 0)
                        {
                            var (frdLat, frdLon) = ProjectPoint(basePt.Lat, basePt.Lon, radial, distNm);
                            pt = new NavPoint(token, frdLat, frdLon);
                        }
                    }
                    // Fallback: strip digits and use base navaid directly
                    if (pt is null && nameEnd >= 2 && nameEnd < token.Length)
                        pt = LookupPoint(baseName, lastPt, nasr);
                }

                if (pt is not null)
                {
                    waypoints.Add(new[] { pt.Lat, pt.Lon });
                    lastPt = pt;
                }
                else if (nasr.Procedures.TryGetValue(token, out var procs))
                {
                    // SID/STAR procedure — expand fix sequence (common non-runway-dependent portion + transitions)
                    // Pick the procedure for the matching airport (origin for SID, destination for STAR)
                    var proc = procs.Count == 1 ? procs[0]
                        : procs.FirstOrDefault(p =>
                            (!string.IsNullOrEmpty(origin) && p.Airport.Equals(origin.TrimStart('K'), StringComparison.OrdinalIgnoreCase)) ||
                            (!string.IsNullOrEmpty(destination) && p.Airport.Equals(destination.TrimStart('K'), StringComparison.OrdinalIgnoreCase)))
                        ?? procs[0];

                    // STAR transitions: if lastPt matches a transition entry, prepend transition fixes before body
                    if (proc.Type == "STAR" && proc.Transitions.Count > 0 && lastPt is not null)
                    {
                        if (proc.Transitions.TryGetValue(lastPt.Ident, out var tranFixes))
                        {
                            // Transition goes enroute → stem; skip the first fix (already plotted as lastPt)
                            for (int ti = 1; ti < tranFixes.Count; ti++)
                            {
                                var tp = LookupPoint(tranFixes[ti], lastPt, nasr);
                                if (tp is not null) { waypoints.Add(new[] { tp.Lat, tp.Lon }); lastPt = tp; }
                            }
                        }
                    }

                    // SID: check if lastPt is already on a transition (aircraft past the stem, e.g., direct-to a transition fix)
                    // Route like "REWET.BOBZY5.BNA" — REWET is on the BNA transition, skip body entirely
                    bool sidTransitionHandled = false;
                    if (proc.Type == "DP" && proc.Transitions.Count > 0 && lastPt is not null && i + 1 < tokens.Length)
                    {
                        var nextToken = tokens[i + 1].ToUpperInvariant();
                        var nextSlash = nextToken.IndexOf('/');
                        if (nextSlash > 0) nextToken = nextToken[..nextSlash];
                        if (proc.Transitions.TryGetValue(nextToken, out var sidTranFixes))
                        {
                            // Check if lastPt is on this transition
                            int tranSkipIdx = -1;
                            for (int ti = 0; ti < sidTranFixes.Count; ti++)
                            {
                                if (sidTranFixes[ti].Equals(lastPt.Ident, StringComparison.OrdinalIgnoreCase))
                                { tranSkipIdx = ti + 1; break; }
                            }
                            if (tranSkipIdx >= 0)
                            {
                                // lastPt is on the transition → skip body, plot remaining transition fixes
                                for (int ti = tranSkipIdx; ti < sidTranFixes.Count; ti++)
                                {
                                    var tp = LookupPoint(sidTranFixes[ti], lastPt, nasr);
                                    if (tp is not null) { waypoints.Add(new[] { tp.Lat, tp.Lon }); lastPt = tp; }
                                }
                                i++; // skip next token (transition endpoint)
                                sidTransitionHandled = true;
                            }
                        }
                    }

                    if (!sidTransitionHandled)
                    {
                        // Body expansion: skip ahead if lastPt is already on the procedure
                        int startIdx = 0;
                        if (lastPt is not null)
                        {
                            for (int fi = 0; fi < proc.Fixes.Count; fi++)
                            {
                                if (proc.Fixes[fi].Equals(lastPt.Ident, StringComparison.OrdinalIgnoreCase))
                                {
                                    startIdx = fi + 1;
                                    break;
                                }
                            }
                            // If not found by name, check by proximity (within 1nm)
                            if (startIdx == 0)
                            {
                                double bestDist = double.MaxValue;
                                int bestIdx = -1;
                                for (int fi = 0; fi < proc.Fixes.Count; fi++)
                                {
                                    var fixPt2 = LookupPoint(proc.Fixes[fi], lastPt, nasr);
                                    if (fixPt2 is not null)
                                    {
                                        var d = HaversineNm(lastPt.Lat, lastPt.Lon, fixPt2.Lat, fixPt2.Lon);
                                        if (d < bestDist) { bestDist = d; bestIdx = fi; }
                                    }
                                }
                                if (bestDist < 1.0 && bestIdx >= 0)
                                    startIdx = bestIdx + 1;
                            }
                        }

                        for (int fi = startIdx; fi < proc.Fixes.Count; fi++)
                        {
                            var fixPt = LookupPoint(proc.Fixes[fi], lastPt, nasr);
                            if (fixPt is not null)
                            {
                                waypoints.Add(new[] { fixPt.Lat, fixPt.Lon });
                                lastPt = fixPt;
                            }
                        }

                        // SID transitions: after body, append transition fixes to reach enroute
                        if (proc.Type == "DP" && proc.Transitions.Count > 0 && i + 1 < tokens.Length)
                        {
                            var nextToken = tokens[i + 1].ToUpperInvariant();
                            var nextSlash = nextToken.IndexOf('/');
                            if (nextSlash > 0) nextToken = nextToken[..nextSlash];
                            if (proc.Transitions.TryGetValue(nextToken, out var sidTranFixes))
                            {
                                // Transition goes stem → enroute; skip fixes already plotted
                                for (int ti = 0; ti < sidTranFixes.Count; ti++)
                                {
                                    if (lastPt is not null && sidTranFixes[ti].Equals(lastPt.Ident, StringComparison.OrdinalIgnoreCase))
                                        continue;
                                    var tp = LookupPoint(sidTranFixes[ti], lastPt, nasr);
                                    if (tp is not null) { waypoints.Add(new[] { tp.Lat, tp.Lon }); lastPt = tp; }
                                }
                                i++; // skip the next token (transition endpoint)
                            }
                        }
                    }
                }
            }
        }

        // Add destination airport
        if (!string.IsNullOrEmpty(destination))
        {
            var apt = LookupAirport(destination, nasr);
            if (apt is not null) waypoints.Add(new[] { apt.Lat, apt.Lon });
        }

        return waypoints;
    }

    public static NavPoint? LookupAirport(string code, NasrData nasr)
    {
        // Try ICAO first (KDCA), then FAA LID (DCA), then strip K prefix
        if (nasr.AirportsIcao.TryGetValue(code, out var apt)) return apt;
        if (nasr.Airports.TryGetValue(code, out apt)) return apt;
        if (code.Length == 4 && code.StartsWith("K") && nasr.Airports.TryGetValue(code[1..], out apt)) return apt;
        return null;
    }

    public static double HaversineNm(double lat1, double lon1, double lat2, double lon2)
    {
        const double R = 3440.065;
        var dLat = (lat2 - lat1) * Math.PI / 180;
        var dLon = (lon2 - lon1) * Math.PI / 180;
        var a = Math.Sin(dLat / 2) * Math.Sin(dLat / 2) +
                Math.Cos(lat1 * Math.PI / 180) * Math.Cos(lat2 * Math.PI / 180) *
                Math.Sin(dLon / 2) * Math.Sin(dLon / 2);
        return R * 2 * Math.Atan2(Math.Sqrt(a), Math.Sqrt(1 - a));
    }

    // Project a point from lat/lon along a bearing for a given distance (great circle)
    static (double Lat, double Lon) ProjectPoint(double lat, double lon, double bearingDeg, double distNm)
    {
        const double R = 3440.065; // Earth radius in nm
        var d = distNm / R;
        var brng = bearingDeg * Math.PI / 180;
        var lat1 = lat * Math.PI / 180;
        var lon1 = lon * Math.PI / 180;
        var lat2 = Math.Asin(Math.Sin(lat1) * Math.Cos(d) + Math.Cos(lat1) * Math.Sin(d) * Math.Cos(brng));
        var lon2 = lon1 + Math.Atan2(Math.Sin(brng) * Math.Sin(d) * Math.Cos(lat1),
                                      Math.Cos(d) - Math.Sin(lat1) * Math.Sin(lat2));
        return (lat2 * 180 / Math.PI, lon2 * 180 / Math.PI);
    }

    public static NavPoint? LookupPoint(string ident, NavPoint? near, NasrData nasr)
    {
        // Collect candidates from navaids, fixes, airports
        var candidates = new List<NavPoint>();
        if (nasr.Navaids.TryGetValue(ident, out var navs)) candidates.AddRange(navs);
        if (nasr.Fixes.TryGetValue(ident, out var fixes)) candidates.AddRange(fixes);
        if (nasr.Airports.TryGetValue(ident, out var apt)) candidates.Add(apt);
        if (nasr.AirportsIcao.TryGetValue(ident, out apt)) candidates.Add(apt);
        // Try stripping K prefix for airports
        if (ident.Length == 4 && ident.StartsWith("K") && nasr.Airports.TryGetValue(ident[1..], out apt))
            candidates.Add(apt);

        if (candidates.Count == 0) return null;
        if (candidates.Count == 1 || near is null) return candidates[0];

        // Disambiguate by proximity to last point
        return candidates.MinBy(c => DistSq(c.Lat, c.Lon, near.Lat, near.Lon));
    }

    static List<NavPoint> ResolveAirway(string airwayId, NavPoint? entryPt, string? exitFix, NasrData nasr)
    {
        if (!nasr.Airways.TryGetValue(airwayId, out var awy)) return new List<NavPoint>();

        var fixList = awy.Fixes;
        if (fixList.Count == 0) return new List<NavPoint>();

        // Find entry index (closest to entryPt)
        int entryIdx = 0;
        if (entryPt is not null)
        {
            double bestDist = double.MaxValue;
            for (int i = 0; i < fixList.Count; i++)
            {
                var pt = LookupPoint(fixList[i], null, nasr);
                if (pt is null) continue;
                var d = DistSq(pt.Lat, pt.Lon, entryPt.Lat, entryPt.Lon);
                if (d < bestDist) { bestDist = d; entryIdx = i; }
            }
        }

        // Find exit index (by name match)
        int exitIdx = fixList.Count - 1;
        if (exitFix is not null)
        {
            for (int i = 0; i < fixList.Count; i++)
            {
                if (fixList[i].Equals(exitFix, StringComparison.OrdinalIgnoreCase))
                {
                    exitIdx = i;
                    break;
                }
            }
        }

        // Build waypoint list between entry and exit (inclusive)
        var result = new List<NavPoint>();
        int step = entryIdx <= exitIdx ? 1 : -1;
        for (int i = entryIdx; i != exitIdx + step; i += step)
        {
            if (i < 0 || i >= fixList.Count) break;
            var pt = LookupPoint(fixList[i], result.Count > 0 ? result[^1] : entryPt, nasr);
            if (pt is not null) result.Add(pt);
        }
        return result;
    }

    static double DistSq(double lat1, double lon1, double lat2, double lon2)
    {
        var dlat = lat1 - lat2;
        var dlon = (lon1 - lon2) * Math.Cos(lat1 * Math.PI / 180);
        return dlat * dlat + dlon * dlon;
    }
}
