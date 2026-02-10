using System.Xml.Linq;
using Microsoft.Extensions.Logging;
using SwimReader.Core.Bus;
using SwimReader.Core.Events;

namespace SwimReader.Parsers;

/// <summary>
/// Routes raw XML messages to the appropriate parser based on service type.
/// Subscribes to RawMessageEvents from the event bus and publishes parsed domain events.
/// </summary>
public sealed class ParserPipeline
{
    private readonly IReadOnlyList<IStddsMessageParser> _parsers;
    private readonly IEventBus _eventBus;
    private readonly ILogger<ParserPipeline> _logger;

    public ParserPipeline(
        IEnumerable<IStddsMessageParser> parsers,
        IEventBus eventBus,
        ILogger<ParserPipeline> logger)
    {
        _parsers = parsers.ToList();
        _eventBus = eventBus;
        _logger = logger;
    }

    /// <summary>
    /// Run the parser pipeline: subscribe to raw events, parse, republish as domain events.
    /// </summary>
    public async Task RunAsync(CancellationToken ct)
    {
        _logger.LogInformation("Parser pipeline started with {Count} parsers", _parsers.Count);

        await foreach (var evt in _eventBus.SubscribeAsync("ParserPipeline", ct))
        {
            if (evt is not RawMessageEvent raw)
                continue;

            try
            {
                await ParseAndPublishAsync(raw, ct);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to parse {ServiceType} message from topic {Topic}",
                    raw.ServiceType, raw.Topic);
            }
        }
    }

    private async Task ParseAndPublishAsync(RawMessageEvent raw, CancellationToken ct)
    {
        XDocument doc;
        try
        {
            doc = XDocument.Parse(raw.XmlContent);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Invalid XML in {ServiceType} message", raw.ServiceType);
            return;
        }

        var parsed = false;

        foreach (var parser in _parsers)
        {
            if (!parser.CanParse(raw.ServiceType, doc))
                continue;

            foreach (var domainEvent in parser.Parse(raw.ServiceType, doc, raw.Timestamp))
            {
                await _eventBus.PublishAsync(domainEvent, ct);
                parsed = true;
            }
        }

        if (!parsed)
        {
            _logger.LogDebug("No parser handled {ServiceType} message from {Topic}",
                raw.ServiceType, raw.Topic);
        }
    }
}
