using SwimReader.Core.Bus;
using SwimReader.Core.Events;

namespace SwimReader.Server;

/// <summary>
/// Optional diagnostic hosted service: when the env var
/// <c>RAW_MESSAGE_LOG_PATH</c> is set, writes one JSONL line per
/// <see cref="RawMessageEvent"/> to that path, optionally filtered by
/// service type (<c>RAW_MESSAGE_LOG_SERVICE</c>, e.g. TAIS) and the
/// per-service "src" element (<c>RAW_MESSAGE_LOG_SRC</c>, e.g. PCT).
///
/// Used to spot-check parser coverage by diffing raw XML vs /dstars
/// output. Disabled by default — no overhead when the env var is unset.
/// </summary>
internal sealed class RawMessageLogger : BackgroundService
{
    private readonly IEventBus _bus;
    private readonly ILogger<RawMessageLogger> _logger;
    private readonly string? _path;
    private readonly string? _serviceFilter;
    private readonly string? _srcFilter;

    public RawMessageLogger(IEventBus bus, ILogger<RawMessageLogger> logger)
    {
        _bus = bus;
        _logger = logger;
        _path = Environment.GetEnvironmentVariable("RAW_MESSAGE_LOG_PATH");
        _serviceFilter = Environment.GetEnvironmentVariable("RAW_MESSAGE_LOG_SERVICE")?.ToUpperInvariant();
        _srcFilter = Environment.GetEnvironmentVariable("RAW_MESSAGE_LOG_SRC")?.ToUpperInvariant();
    }

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(_path))
        {
            _logger.LogInformation("RawMessageLogger: disabled (RAW_MESSAGE_LOG_PATH unset)");
            return;
        }

        _logger.LogInformation("RawMessageLogger: writing to {Path} (service={Service}, src={Src})",
            _path, _serviceFilter ?? "*", _srcFilter ?? "*");

        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        await using var stream = new FileStream(_path, FileMode.Append, FileAccess.Write, FileShare.Read);
        await using var writer = new StreamWriter(stream) { AutoFlush = false };

        var nextFlush = DateTime.UtcNow.AddSeconds(1);
        long count = 0;

        await foreach (var evt in _bus.SubscribeAsync("raw-message-logger", ct))
        {
            if (evt is not RawMessageEvent raw) continue;
            if (_serviceFilter is not null &&
                !string.Equals(raw.ServiceType, _serviceFilter, StringComparison.OrdinalIgnoreCase)) continue;
            if (_srcFilter is not null && !XmlSrcMatches(raw.XmlContent, _srcFilter)) continue;

            // {"_rx":"<iso>","topic":"...","xml":"<escaped>"}
            await writer.WriteAsync("{\"_rx\":\"");
            await writer.WriteAsync(DateTime.UtcNow.ToString("o"));
            await writer.WriteAsync("\",\"topic\":");
            await writer.WriteAsync(System.Text.Json.JsonSerializer.Serialize(raw.Topic));
            await writer.WriteAsync(",\"xml\":");
            await writer.WriteAsync(System.Text.Json.JsonSerializer.Serialize(raw.XmlContent));
            await writer.WriteLineAsync("}");
            count++;

            if (DateTime.UtcNow >= nextFlush)
            {
                await writer.FlushAsync(ct);
                nextFlush = DateTime.UtcNow.AddSeconds(1);
            }
        }

        await writer.FlushAsync(CancellationToken.None);
        _logger.LogInformation("RawMessageLogger: stopped after {Count} messages", count);
    }

    private static bool XmlSrcMatches(string xml, string upperSrc)
    {
        // Quick string-scan instead of XML parse — runs on every msg.
        var i = xml.IndexOf("<src>", StringComparison.Ordinal);
        if (i < 0) return false;
        var j = xml.IndexOf("</src>", i + 5, StringComparison.Ordinal);
        if (j < 0) return false;
        var span = xml.AsSpan(i + 5, j - i - 5).Trim();
        return span.Equals(upperSrc.AsSpan(), StringComparison.OrdinalIgnoreCase);
    }
}
