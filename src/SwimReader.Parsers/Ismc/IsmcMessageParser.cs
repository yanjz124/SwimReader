using System.Xml.Linq;
using Microsoft.Extensions.Logging;
using SwimReader.Core.Events;

namespace SwimReader.Parsers.Ismc;

/// <summary>
/// Parses ISMC (Information Service Management Center) messages.
/// Stub parser — ISMC provides system status/management data.
/// </summary>
public sealed class IsmcMessageParser : IStddsMessageParser
{
    private readonly ILogger<IsmcMessageParser> _logger;

    public IsmcMessageParser(ILogger<IsmcMessageParser> logger)
    {
        _logger = logger;
    }

    public bool CanParse(string serviceType, XDocument doc)
    {
        return serviceType.Equals("ISMC", StringComparison.OrdinalIgnoreCase);
    }

    public IEnumerable<ISwimEvent> Parse(string serviceType, XDocument doc, DateTime receivedAt)
    {
        _logger.LogDebug("ISMC message received - parser stub");
        yield break;
    }
}
