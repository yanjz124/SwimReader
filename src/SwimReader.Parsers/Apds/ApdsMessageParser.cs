using System.Xml.Linq;
using Microsoft.Extensions.Logging;
using SwimReader.Core.Events;

namespace SwimReader.Parsers.Apds;

/// <summary>
/// Parses APDS (Aeronautical Product Distribution Service) messages.
/// Stub parser — APDS provides aeronautical information/charts, lower priority for DGScope.
/// </summary>
public sealed class ApdsMessageParser : IStddsMessageParser
{
    private readonly ILogger<ApdsMessageParser> _logger;

    public ApdsMessageParser(ILogger<ApdsMessageParser> logger)
    {
        _logger = logger;
    }

    public bool CanParse(string serviceType, XDocument doc)
    {
        return serviceType.Equals("APDS", StringComparison.OrdinalIgnoreCase);
    }

    public IEnumerable<ISwimEvent> Parse(string serviceType, XDocument doc, DateTime receivedAt)
    {
        _logger.LogDebug("APDS message received - parser stub");
        yield break;
    }
}
