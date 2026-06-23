namespace SwimReader.Core.Events;

/// <summary>
/// Flight plan data from TAIS AIG200 or TDES messages.
/// Maps to DGScope FlightPlanUpdate (UpdateType 1).
/// </summary>
public sealed class FlightPlanDataEvent : ISwimEvent
{
    public required DateTime Timestamp { get; init; }
    public required string Source { get; init; }

    // Identification
    public string? Callsign { get; init; }
    public string? TrackNumber { get; init; }
    public int? ModeSCode { get; init; }

    // Aircraft
    public string? AircraftType { get; init; }
    public string? WakeCategory { get; init; }
    public string? EquipmentSuffix { get; init; }

    // Flight plan
    public string? FlightRules { get; init; }
    public string? Origin { get; init; }
    public string? Destination { get; init; }
    public string? EntryFix { get; init; }
    public string? ExitFix { get; init; }
    public string? Route { get; init; }
    public int? RequestedAltitude { get; init; }
    public string? AssignedSquawk { get; init; }
    public string? Runway { get; init; }

    // ATC
    public string? Scratchpad1 { get; init; }
    public string? Scratchpad2 { get; init; }
    public string? Owner { get; init; }
    public string? PendingHandoff { get; init; }
    public int? LdrDirection { get; init; }

    // Handoff state — derived from TAIS <ocr> (Operational Control Required).
    // TAIS does NOT publish the receiving sector in the standard feed; we can
    // detect that a handoff is in progress and (when cps == us) infer
    // OUTBOUND direction, but INBOUND is not derivable without richer data.
    // Raw OCR string values seen in TAIS samples:
    //   "no change"             — idle, no handoff
    //   "pending"               — handoff request out / awaiting accept
    //   "normal handoff"        — handoff in progress
    //   "intrafacility handoff" — local handoff within facility
    public string? HandoffOcr { get; init; }
    public bool   IsHandoffInProgress { get; init; }

    // Source facility
    public string? Facility { get; init; }
}
