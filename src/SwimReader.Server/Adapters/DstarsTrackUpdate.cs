using System.Text.Json.Serialization;

namespace SwimReader.Server.Adapters;

/// <summary>
/// JSON DTO matching DGScope's TrackUpdate exactly (UpdateType 0).
/// Property names must match DGScope.Receivers.ScopeServer.TrackUpdate.
/// Null fields are omitted from JSON serialization.
/// </summary>
public sealed class DstarsTrackUpdate
{
    public required Guid Guid { get; init; }
    public DateTime TimeStamp { get; init; } = DateTime.UtcNow;
    public int UpdateType => 0; // Track

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public DstarsAltitude? Altitude { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? GroundSpeed { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? GroundTrack { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? Ident { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? IsOnGround { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Squawk { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public DstarsGeoPoint? Location { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Callsign { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? VerticalRate { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? ModeSCode { get; init; }
}

public sealed class DstarsGeoPoint
{
    public double Latitude { get; init; }
    public double Longitude { get; init; }
}

public sealed class DstarsAltitude
{
    public int Value { get; init; }
    public int AltitudeType { get; init; } // 0=Pressure, 1=True, 2=Unknown
}
