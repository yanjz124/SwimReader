namespace SwimReader.Core.Events;

/// <summary>
/// Raw XML message received from SCDS before parsing.
/// Used for logging, diagnostics, and message capture.
/// </summary>
public sealed class RawMessageEvent : ISwimEvent
{
    public required DateTime Timestamp { get; init; }
    public required string Source { get; init; }
    public required string Topic { get; init; }
    public required string XmlContent { get; init; }
    public required string ServiceType { get; init; }
}
