namespace SwimReader.Core.Events;

/// <summary>
/// Marker interface for all SWIM events flowing through the event bus.
/// </summary>
public interface ISwimEvent
{
    DateTime Timestamp { get; }
    string Source { get; }
}
