namespace SwimReader.Core.Events;

/// <summary>
/// Departure event from TDES service.
/// Provides gate/taxi/takeoff timing data.
/// </summary>
public sealed class DepartureEvent : ISwimEvent
{
    public required DateTime Timestamp { get; init; }
    public required string Source { get; init; }

    public string? Callsign { get; init; }
    public string? Airport { get; init; }
    public string? Runway { get; init; }
    public string? Gate { get; init; }

    public DateTime? GateOutTime { get; init; }
    public DateTime? TaxiStartTime { get; init; }
    public DateTime? TakeoffTime { get; init; }
}
