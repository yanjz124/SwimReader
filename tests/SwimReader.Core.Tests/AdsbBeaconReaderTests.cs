using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using SwimReader.Core.Bus;
using SwimReader.Core.Events;
using SwimReader.Core.Models;
using SwimReader.Server.Adapters;
using SwimReader.Server.Profile;
using SwimReader.Server.Streaming;

namespace SwimReader.Core.Tests;

/// <summary>
/// Pins where an ADS-B-resolved callsign has to land for STARS' F1 hold-to-reveal
/// readout to show it.
///
/// The readout renders the TRACK's callsign (Aircraft.cs:591-609 / the
/// ShowCallsignWithNoSquawk branch in scope.js), because in DGScope the
/// ADSBBeaconReader is a receiver that sets it on the Aircraft itself. Our
/// enrichment instead fabricated a flight plan, so for 435,000 published
/// enrichments the callsign reached the browser in Scratchpad1 and AssignedSquawk
/// and F1 showed nothing. Nothing errored and nothing logged; the only way to see
/// it is to assert on the emitted field.
///
/// Two more fields had to stay clear, each with its own visible failure:
///   Callsign = the beacon code made "1200" the scope's dedup key, and
///   dedupByCallsign only grants its co-location escape to keys it built itself
///   ("SQ:" prefix) — so every VFR 1200 target in a facility collapsed onto one.
///   AssignedSquawk = the callsign put a callsign in a beacon-code field, so an
///   FDB rendered "1200 N98RR" on its assigned-vs-received mismatch line.
/// </summary>
public class AdsbBeaconReaderTests
{
    private sealed class NoopBus : IEventBus
    {
        public ValueTask PublishAsync(ISwimEvent e, CancellationToken ct = default) => default;
        public IAsyncEnumerable<ISwimEvent> SubscribeAsync(string n, CancellationToken ct = default)
            => throw new NotSupportedException();
    }

    private static DgScopeAdapter NewAdapter() => new(
        new NoopBus(),
        new TrackStateManager(NullLogger<TrackStateManager>.Instance),
        new ClientConnectionManager(NullLogger<ClientConnectionManager>.Instance),
        new ProfileStore(),
        NullLogger<DgScopeAdapter>.Instance);

    private const string Facility = "TST";
    private const string TrackNum = "4210";

    private static TrackPositionEvent UntaggedTrack() => new()
    {
        Timestamp = DateTime.UtcNow,
        Source = "TAIS",
        Position = new GeoPosition(38.95, -77.45),
        TrackNumber = TrackNum,
        Squawk = "1200",
        AltitudeFeet = 3500,
        Facility = Facility,
    };

    private static FlightPlanDataEvent Enrichment() => new()
    {
        Timestamp = DateTime.UtcNow,
        Source = "ADSB_ENRICH",
        AdsbCallsign = "N98RR",
        Scratchpad1 = "N98RR",
        AircraftType = "PIVI",
        TrackNumber = TrackNum,
        Facility = Facility,
    };

    private static JsonElement Parse(string? json) =>
        JsonDocument.Parse(json!).RootElement;

    private static string? Str(JsonElement e, string prop) =>
        e.TryGetProperty(prop, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString()
            : null;

    [Fact]
    public void UntaggedTarget_AdsbCallsign_ReachesTheTrackUpdate()
    {
        var a = NewAdapter();
        var track = UntaggedTrack();

        // Before enrichment the target is a bare radar return: F1 has nothing.
        Assert.Null(Str(Parse(a.ConvertTrack(track)), "Callsign"));

        a.ConvertFlightPlan(Enrichment());

        // The callsign rides the next real radar update — no synthetic position
        // event, so the track's own position time is never restamped with a stale fix.
        Assert.Equal("N98RR", Str(Parse(a.ConvertTrack(track)), "Callsign"));
    }

    [Fact]
    public void UntaggedTarget_EnrichmentLeavesCallsignAndAssignedSquawkClear()
    {
        var a = NewAdapter();
        a.ConvertTrack(UntaggedTrack());
        var fp = Parse(a.ConvertFlightPlan(Enrichment()));

        // A beacon code here becomes the client's dedup key and merges every 1200.
        Assert.True(string.IsNullOrEmpty(Str(fp, "Callsign")));
        // A callsign here renders as an assigned-vs-received beacon mismatch.
        Assert.True(string.IsNullOrEmpty(Str(fp, "AssignedSquawk")));
        // It is still mirrored into the scratchpad, which is what an FDB shows.
        Assert.Equal("N98RR", Str(fp, "Scratchpad1"));
    }

    [Fact]
    public void LaddTarget_KeepsItsCallsignOnTheFlightPlan()
    {
        // A Mode S target TAIS gives no callsign for DOES have a flight plan, so the
        // callsign is flight-plan data and belongs on line 1 — the opposite case, and
        // the reason the two must not be collapsed into one code path.
        var a = NewAdapter();
        const int modeS = 0xA12345;

        a.ConvertTrack(new TrackPositionEvent
        {
            Timestamp = DateTime.UtcNow,
            Source = "TAIS",
            Position = new GeoPosition(38.95, -77.45),
            ModeSCode = modeS,
            TrackNumber = "4211",
            Squawk = "3607",
            Facility = Facility,
        });

        var fp = Parse(a.ConvertFlightPlan(new FlightPlanDataEvent
        {
            Timestamp = DateTime.UtcNow,
            Source = "ADSB_ENRICH",
            Callsign = "DAL1663",
            AssignedSquawk = "3607",
            ModeSCode = modeS,
            Facility = Facility,
        })!);

        Assert.Equal("DAL1663", Str(fp, "Callsign"));
    }
}
