using System.Xml.Linq;
using Microsoft.Extensions.Logging;
using SwimReader.Core.Events;

namespace SwimReader.Parsers.Tdes;

/// <summary>
/// Parses TDES (Terminal Data Exchange Service) messages into DepartureEvents.
/// Schema will be refined after capturing real TDES messages.
/// </summary>
public sealed class TdesMessageParser : IStddsMessageParser
{
    private readonly ILogger<TdesMessageParser> _logger;

    public TdesMessageParser(ILogger<TdesMessageParser> logger)
    {
        _logger = logger;
    }

    public bool CanParse(string serviceType, XDocument doc)
    {
        return serviceType.Equals("TDES", StringComparison.OrdinalIgnoreCase);
    }

    public IEnumerable<ISwimEvent> Parse(string serviceType, XDocument doc, DateTime receivedAt)
    {
        // TODO: Implement after capturing real TDES XML samples via MessageCapture.
        // Expected fields: callsign, airport, runway, gate, OOOI times
        _logger.LogDebug("TDES message received - parser stub, awaiting schema discovery");
        yield break;
    }
}
