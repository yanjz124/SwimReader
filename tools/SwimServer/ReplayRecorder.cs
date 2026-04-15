using System.IO.Compression;
using System.Text.Json;
using System.Threading.Channels;

namespace SwimServer;

/// <summary>
/// Records real-time flight/ASDE-X data to gzipped JSONL files for replay.
/// Non-blocking: uses a bounded channel so the real-time pipeline is never stalled.
/// </summary>
public sealed class ReplayRecorder : IDisposable
{
    private readonly string _baseDir;
    private readonly string _cleanupDir;  // dir to enforce budget on (may be parent for shared budget)
    private readonly Channel<RecordEntry> _channel;
    private readonly Task _writerTask;
    private readonly CancellationTokenSource _cts = new();
    private readonly long _maxTotalBytes;

    public ReplayRecorder(string baseDir, long maxTotalBytes = 0, string? cleanupDir = null)
    {
        _baseDir = baseDir;
        _cleanupDir = cleanupDir ?? baseDir;
        _maxTotalBytes = maxTotalBytes > 0 ? maxTotalBytes : 30L * 1024 * 1024 * 1024; // default 30 GB
        Directory.CreateDirectory(_baseDir);

        _channel = Channel.CreateBounded<RecordEntry>(
            new BoundedChannelOptions(4000)
            {
                FullMode = BoundedChannelFullMode.DropOldest,
                SingleReader = true
            });

        _writerTask = Task.Run(WriterLoop);
    }

    /// <summary>Record a batch of flight/track summaries (already-serialized objects).</summary>
    public void RecordBatch(object[] summaries, DateTime utcNow)
    {
        if (summaries.Length == 0) return;
        _channel.Writer.TryWrite(new RecordEntry('B', summaries, utcNow));
    }

    /// <summary>Record a full snapshot for seek support.</summary>
    public void RecordSnapshot(object[] summaries, DateTime utcNow)
    {
        if (summaries.Length == 0) return;
        _channel.Writer.TryWrite(new RecordEntry('S', summaries, utcNow));
    }

    /// <summary>Record a flight/track removal.</summary>
    public void RecordRemove(object removeData, DateTime utcNow)
    {
        _channel.Writer.TryWrite(new RecordEntry('R', removeData, utcNow));
    }

    /// <summary>Record holdbar state (ASDE-X only).</summary>
    public void RecordHoldbar(object holdbarData, DateTime utcNow)
    {
        _channel.Writer.TryWrite(new RecordEntry('H', holdbarData, utcNow));
    }

    /// <summary>Get the list of available hourly replay files with time ranges.</summary>
    public List<ReplayFileInfo> GetAvailableFiles(string? subDir = null)
    {
        var dir = subDir != null ? Path.Combine(_baseDir, subDir) : _baseDir;
        if (!Directory.Exists(dir)) return new();

        var files = Directory.GetFiles(dir, "*.jsonl.gz", SearchOption.TopDirectoryOnly)
            .Select(f =>
            {
                var name = Path.GetFileName(f);
                // Parse "2026-04-01T14.jsonl.gz" → DateTime
                var stem = name.Replace(".jsonl.gz", "");
                if (DateTime.TryParseExact(stem, "yyyy-MM-dd'T'HH",
                    System.Globalization.CultureInfo.InvariantCulture,
                    System.Globalization.DateTimeStyles.AssumeUniversal | System.Globalization.DateTimeStyles.AdjustToUniversal,
                    out var hour))
                {
                    return new ReplayFileInfo { Path = f, Hour = hour, Size = new FileInfo(f).Length };
                }
                return null;
            })
            .Where(f => f != null)
            .OrderBy(f => f!.Hour)
            .ToList()!;

        return files!;
    }

    public void Dispose()
    {
        _cts.Cancel();
        _channel.Writer.TryComplete();
        _writerTask.Wait(TimeSpan.FromSeconds(5));
        _cts.Dispose();
    }

    // ── Background writer ──────────────────────────────────────────────────

    private async Task WriterLoop()
    {
        string? currentFilePath = null;
        FileStream? fs = null;
        GZipStream? gz = null;
        StreamWriter? sw = null;
        DateTime currentHour = default;
        int recordCount = 0;
        DateTime lastFlush = DateTime.UtcNow;
        DateTime lastCleanup = DateTime.UtcNow;

        var jsonOpts = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

        try
        {
            await foreach (var entry in _channel.Reader.ReadAllAsync(_cts.Token))
            {
                var hour = new DateTime(entry.Timestamp.Year, entry.Timestamp.Month, entry.Timestamp.Day,
                    entry.Timestamp.Hour, 0, 0, DateTimeKind.Utc);

                // Rotate file on hour boundary
                if (hour != currentHour || sw == null)
                {
                    if (sw != null)
                    {
                        await sw.FlushAsync();
                        await gz!.FlushAsync();
                        sw.Dispose(); gz!.Dispose(); fs!.Dispose();
                        Console.WriteLine($"[REPLAY] Closed {Path.GetFileName(currentFilePath)} ({recordCount} records)");
                    }

                    currentHour = hour;
                    recordCount = 0;
                    var baseName = hour.ToString("yyyy-MM-dd'T'HH");
                    var fileName = baseName + ".jsonl.gz";
                    currentFilePath = Path.Combine(_baseDir, fileName);
                    // If file already exists (restart within same hour), use a suffix
                    if (File.Exists(currentFilePath))
                    {
                        for (int i = 1; ; i++)
                        {
                            var altName = $"{baseName}-{i}.jsonl.gz";
                            var altPath = Path.Combine(_baseDir, altName);
                            if (!File.Exists(altPath)) { currentFilePath = altPath; fileName = altName; break; }
                        }
                    }
                    fs = new FileStream(currentFilePath, FileMode.Create, FileAccess.Write, FileShare.Read);
                    gz = new GZipStream(fs, CompressionLevel.Fastest, leaveOpen: true);
                    sw = new StreamWriter(gz, leaveOpen: true);
                    Console.WriteLine($"[REPLAY] Writing to {fileName}");
                }

                // Write JSONL record: {"t":millis,"k":"B","d":[...]}
                var millis = new DateTimeOffset(entry.Timestamp).ToUnixTimeMilliseconds();
                var line = JsonSerializer.Serialize(new { t = millis, k = entry.Kind.ToString(), d = entry.Data }, jsonOpts);
                await sw.WriteLineAsync(line);
                recordCount++;

                // Flush every 10 seconds for crash recovery
                var now = DateTime.UtcNow;
                if ((now - lastFlush).TotalSeconds >= 10)
                {
                    await sw.FlushAsync();
                    await gz!.FlushAsync();
                    lastFlush = now;
                }

                // Cleanup old files every hour
                if ((now - lastCleanup).TotalHours >= 1)
                {
                    CleanupOldFiles();
                    lastCleanup = now;
                }
            }
        }
        catch (OperationCanceledException) { }
        catch (Exception ex)
        {
            Console.WriteLine($"[REPLAY] Writer error: {ex.Message}");
        }
        finally
        {
            if (sw != null)
            {
                try { await sw.FlushAsync(); sw.Dispose(); } catch { }
            }
            if (gz != null) try { gz.Dispose(); } catch { }
            if (fs != null) try { fs.Dispose(); } catch { }
        }
    }

    private void CleanupOldFiles()
    {
        try
        {
            // Size-based retention: delete oldest files across ALL sibling recorders (shared budget)
            if (!Directory.Exists(_cleanupDir)) return;
            var files = Directory.GetFiles(_cleanupDir, "*.jsonl.gz", SearchOption.AllDirectories)
                .Select(f => new FileInfo(f))
                .OrderBy(f => f.Name) // chronological by filename (yyyy-MM-ddTHH)
                .ToList();

            var totalBytes = files.Sum(f => f.Length);
            if (totalBytes <= _maxTotalBytes) return;

            Console.WriteLine($"[REPLAY] Cleanup: {totalBytes / (1024 * 1024)} MB exceeds {_maxTotalBytes / (1024 * 1024)} MB budget in {_cleanupDir}");
            foreach (var fi in files)
            {
                if (totalBytes <= _maxTotalBytes) break;
                totalBytes -= fi.Length;
                try { fi.Delete(); Console.WriteLine($"[REPLAY] Deleted: {Path.GetRelativePath(_cleanupDir, fi.FullName)} ({fi.Length / 1024} KB)"); }
                catch (Exception ex) { Console.WriteLine($"[REPLAY] Delete failed {fi.FullName}: {ex.Message}"); }
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[REPLAY] Cleanup error: {ex.Message}");
        }
    }

    private readonly record struct RecordEntry(char Kind, object Data, DateTime Timestamp);
}

public class ReplayFileInfo
{
    public string Path { get; set; } = "";
    public DateTime Hour { get; set; }
    public long Size { get; set; }
}
