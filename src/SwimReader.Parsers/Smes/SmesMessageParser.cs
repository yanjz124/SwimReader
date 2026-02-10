using System.Xml.Linq;
using Microsoft.Extensions.Logging;
using SwimReader.Core.Events;

namespace SwimReader.Parsers.Smes;

/// <summary>
/// Parses SMES (Surface Movement Event Service / ASDE-X) messages into SurfaceMovementEvents.
/// Schema will be refined after capturing real SMES messages.
/// </summary>
public sealed class SmesMessageParser : IStddsMessageParser
{
    private readonly ILogger<SmesMessageParser> _logger;

    public SmesMessageParser(ILogger<SmesMessageParser> logger)
    {
        _logger = logger;
    }

    public bool CanParse(string serviceType, XDocument doc)
    {
        return serviceType.Equals("SMES", StringComparison.OrdinalIgnoreCase);
    }

    public IEnumerable<ISwimEvent> Parse(string serviceType, XDocument doc, DateTime receivedAt)
    {
        // TODO: Implement after capturing real SMES XML samples via MessageCapture.
        // Expected: ASDE-X Cat 10/11 position reports with lat/lon, ground speed, heading
        _logger.LogDebug("SMES message received - parser stub, awaiting schema discovery");
        yield break;
    }
}
