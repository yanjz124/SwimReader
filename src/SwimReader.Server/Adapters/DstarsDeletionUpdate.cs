namespace SwimReader.Server.Adapters;

/// <summary>
/// JSON DTO matching DGScope's DeletionUpdate exactly (UpdateType 2).
/// Sent when a track is lost or dropped.
/// </summary>
public sealed class DstarsDeletionUpdate
{
    public required Guid Guid { get; init; }
    public DateTime TimeStamp { get; init; } = DateTime.UtcNow;
    public int UpdateType => 2; // Deletion
}
