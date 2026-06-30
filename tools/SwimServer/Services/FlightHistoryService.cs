using System.Text.Json;

namespace SwimServer;

/// <summary>
/// Persists purged flights to daily JSONL files under flight-history/, and
/// enforces a disk budget (cap at 85% of total disk) by deleting the oldest
/// files when the total size exceeds the budget.
/// </summary>
static class FlightHistoryService
{
    /// <summary>
    /// Calculate the dynamic max-history budget: (85% of total disk) − (used non-history bytes).
    /// </summary>
    public static long GetMaxHistoryBytes(string historyDir)
    {
        try
        {
            var drive = new DriveInfo(Path.GetPathRoot(Path.GetFullPath(historyDir)) ?? "/");
            long historySize = Directory.Exists(historyDir)
                ? Directory.GetFiles(historyDir, "*.jsonl").Sum(f => new FileInfo(f).Length) : 0;
            var usedNonHistory = drive.TotalSize - drive.TotalFreeSpace - historySize;
            var budget = Math.Max(0, (long)(drive.TotalSize * 0.85) - usedNonHistory);
            return budget;
        }
        catch { return 2L * 1024 * 1024 * 1024; }
    }

    public static void Save(FlightState f, string historyDir, JsonSerializerOptions historyJsonOpts)
    {
        try
        {
            Directory.CreateDirectory(historyDir);
            var datePart = DateTime.UtcNow.ToString("yyyy-MM-dd");
            var filePath = Path.Combine(historyDir, $"{datePart}.jsonl");
            var record = new
            {
                f.Gufi, f.FdpsGufi, f.Callsign, f.ComputerId, f.Operator, f.Originator, f.FlightStatus,
                f.Origin, f.Destination, f.AircraftType, f.Registration, f.WakeCategory,
                f.ModeSCode, f.EquipmentQualifier, f.AircraftPerformance, f.Squawk, f.AssignedSquawk, f.FlightRules, f.FlightType,
                f.Route, f.OriginalRoute, f.STAR, f.Remarks,
                f.AssignedAltitude, f.AssignedVfr, f.BlockFloor, f.BlockCeiling,
                f.InterimAltitude, f.ReportedAltitude,
                f.Latitude, f.Longitude, f.GroundSpeed, f.RequestedSpeed, f.RequestedAltitude,
                f.ControllingFacility, f.ControllingSector, f.ReportingFacility,
                // Full ICAO Field 10/18 capabilities so the saved plan is complete in history
                f.DataLinkCode, f.CommunicationCode, f.OtherDataLink, f.OtherCommunicationCapabilities,
                f.NavigationCode, f.PBNCode, f.OtherNavigationCapabilities,
                f.SurveillanceCode, f.OtherSurveillanceCapabilities, f.SELCAL,
                f.EstimatedElapsedTimes,
                // Time fields needed by ICAO FPL Field 13/16 and EDCT views
                f.ActualDepartureTime,
                ETA = f.ETA,
                f.EdctTime,
                f.CoordinationFix, f.CoordinationTime,
                f.AlternateAerodrome,
                LastSeen = f.LastSeen.ToString("o"),
                Events = f.GetAllEvents().Select(e => new { e.Time, e.Source, e.Centre, e.Summary }).ToArray()
            };
            var line = JsonSerializer.Serialize(record, historyJsonOpts);
            var lineBytes = System.Text.Encoding.UTF8.GetBytes(line);
            long offset;
            lock (historyDir) // serialize writes to same file
            {
                offset = File.Exists(filePath) ? new FileInfo(filePath).Length : 0;
                using var fs = new FileStream(filePath, FileMode.Append, FileAccess.Write, FileShare.Read);
                fs.Write(lineBytes, 0, lineBytes.Length);
                fs.WriteByte((byte)'\n');
            }
            // Index entry — used by /api/history for fast searches.
            FlightHistoryIndex.AppendEntry(historyDir, datePart,
                f.Callsign ?? "", f.ComputerId ?? "",
                f.Origin ?? "", f.Destination ?? "", f.Registration ?? "",
                offset, lineBytes.Length);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[History] Save error for {f.Gufi}: {ex.Message}");
        }
    }

    public static void Cleanup(string historyDir)
    {
        try
        {
            if (!Directory.Exists(historyDir)) return;
            var files = Directory.GetFiles(historyDir, "*.jsonl").OrderBy(f => f).ToList();
            long total = files.Sum(f => new FileInfo(f).Length);
            long maxBytes = GetMaxHistoryBytes(historyDir);
            Console.WriteLine($"[History] {files.Count} files, {total / 1024 / 1024}MB used, {maxBytes / 1024 / 1024}MB budget (85% disk)");
            while (total > maxBytes && files.Count > 1)
            {
                var oldest = files[0];
                var size = new FileInfo(oldest).Length;
                File.Delete(oldest);
                Console.WriteLine($"[History] Deleted {Path.GetFileName(oldest)} ({size / 1024 / 1024}MB) to stay under budget");
                files.RemoveAt(0);
                total -= size;
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[History] Cleanup error: {ex.Message}");
        }
    }
}
