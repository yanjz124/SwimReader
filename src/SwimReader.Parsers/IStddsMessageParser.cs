using System.Xml.Linq;
using SwimReader.Core.Events;

namespace SwimReader.Parsers;

/// <summary>
/// Interface for STDDS message parsers. Each parser handles one service type.
/// </summary>
public interface IStddsMessageParser
{
    /// <summary>
    /// Check if this parser can handle the given message based on service type and/or XML content.
    /// </summary>
    bool CanParse(string serviceType, XDocument doc);

    /// <summary>
    /// Parse the XML document into zero or more domain events.
    /// A single XML message may produce multiple events (e.g., TAIS AIG200 produces both
    /// TrackPositionEvent and FlightPlanDataEvent).
    /// </summary>
    IEnumerable<ISwimEvent> Parse(string serviceType, XDocument doc, DateTime receivedAt);
}
