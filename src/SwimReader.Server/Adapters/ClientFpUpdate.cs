namespace SwimReader.Server.Adapters;

/// <summary>
/// Inbound command message a scope client POSTs to <c>/dstars/{facility}/update</c>. Mirrors the
/// partial <c>FlightPlanUpdate</c>/<c>DeletionUpdate</c> that DGScope's ScopeServerClient sends
/// (JSON, NullValueHandling.Ignore — so an ABSENT field means "unchanged" and an empty string means
/// "clear"). Only the handful of fields DGScope ever transmits are honored here.
/// </summary>
public sealed class ClientFpUpdate
{
    public Guid Guid { get; set; }
    public int UpdateType { get; set; } = 1;   // 1 = Flightplan, 2 = Deletion

    // null = field not present in this POST (unchanged); "" = clear; value = set.
    public string? Scratchpad1 { get; set; }
    public string? Scratchpad2 { get; set; }
    public string? AircraftType { get; set; }
    public string? Owner { get; set; }
    public string? PendingHandoff { get; set; }
}
