using System.Collections.Concurrent;

namespace SwimReader.Server.Adapters;

/// <summary>
/// A controller's edits to one track's flight plan (scratchpads, aircraft type, ownership, pending
/// handoff), layered on top of the read-only live feed. This is what makes STARS commands "stick":
/// DGScope over a real ScopeServer POSTs these edits and the server is authoritative; our feed is
/// FAA data we can't write back to, so we keep the edit here and re-apply it to every outgoing
/// FlightPlanUpdate for the track. null = not overridden; "" = explicitly cleared.
/// </summary>
public sealed class FpOverride
{
    public string? Scratchpad1;
    public string? Scratchpad2;
    public string? AircraftType;
    public string? Owner;
    public string? PendingHandoff;
    public DateTime Updated = DateTime.UtcNow;

    /// <summary>Merge the fields present in a client POST (non-null) into this override.</summary>
    public void MergeFrom(ClientFpUpdate u)
    {
        if (u.Scratchpad1 is not null) Scratchpad1 = u.Scratchpad1;
        if (u.Scratchpad2 is not null) Scratchpad2 = u.Scratchpad2;
        if (u.AircraftType is not null) AircraftType = u.AircraftType;
        if (u.Owner is not null) Owner = u.Owner;
        if (u.PendingHandoff is not null) PendingHandoff = u.PendingHandoff;
        Updated = DateTime.UtcNow;
    }

    /// <summary>Return a copy of <paramref name="u"/> with this override's set fields applied.</summary>
    public DstarsFlightPlanUpdate Apply(DstarsFlightPlanUpdate u) => u with
    {
        Scratchpad1 = Scratchpad1 ?? u.Scratchpad1,
        Scratchpad2 = Scratchpad2 ?? u.Scratchpad2,
        AircraftType = AircraftType ?? u.AircraftType,
        Owner = Owner ?? u.Owner,
        PendingHandoff = PendingHandoff ?? u.PendingHandoff,
    };
}

/// <summary>
/// Per-track controller overrides. Keyed by the track Guid (which already encodes the facility via
/// TrackStateManager), so lookups in the FP-build path need no facility argument.
/// </summary>
public sealed class OverrideStore
{
    private readonly ConcurrentDictionary<Guid, FpOverride> _ov = new();

    public FpOverride? Get(Guid guid) => _ov.TryGetValue(guid, out var o) ? o : null;

    public FpOverride Apply(Guid guid, ClientFpUpdate u)
    {
        var o = _ov.GetOrAdd(guid, _ => new FpOverride());
        lock (o) o.MergeFrom(u);
        return o;
    }

    public void Remove(Guid guid) => _ov.TryRemove(guid, out _);
}
