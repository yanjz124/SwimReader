// Feed receiver for the DGScope port — consumes SwimReader.Server's dSTARS HTTP stream
// (/dstars/{facility}/updates, newline-delimited JSON of DstarsTrackUpdate/FlightPlanUpdate/Deletion)
// and drives RadarWindow.Aircraft. This is the browser equivalent of DGScope's ScopeServerClient
// receiver (which isn't part of the ported scope/scope project — it lives in a separate assembly).
import { RadarWindow } from "./src/RadarWindow.js";
import { Aircraft } from "./src/Aircraft.js";
import { GeoPoint } from "./src/GeoPoint.js";

export function connectFeed(facility, onState) {
  const byGuid = new Map();               // track/fp Guid (string) -> Aircraft
  const pendingFlightPlans = new Map();   // AssociatedTrackGuid -> FlightPlanUpdate (queued until track arrives)
  const url = `/dstars/${encodeURIComponent(facility)}/updates`;
  let stop = false;

  (async () => {
    while (!stop) {
      try {
        const resp = await fetch(url);
        if (!resp.ok || !resp.body) throw new Error("HTTP " + resp.status);
        onState && onState({ connected: true });
        const reader = resp.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (line) {
              try {
                handle(JSON.parse(line));
              } catch (e) { /* skip bad line */ }
            }
          }
        }
      } catch (e) {
        onState && onState({ connected: false, error: String(e && e.message || e) });
      }
      if (!stop) await new Promise(r => setTimeout(r, 2000)); // reconnect backoff
    }
  })();

  function handle(u) {
    const now = RadarWindow.CurrentTime;
    switch (u.UpdateType) {
      case 2: { // Deletion
        const ac = byGuid.get(u.Guid);
        if (ac) { RadarWindow.Aircraft.Remove(ac); byGuid.delete(u.Guid); }
        return;
      }
      case 1: { // Flight plan
        const ac = u.AssociatedTrackGuid ? byGuid.get(u.AssociatedTrackGuid) : null;
        if (ac) {
          ac.Callsign = u.Callsign ?? ac.Callsign;
          ac.FlightPlanCallsign = u.Callsign ?? ac.FlightPlanCallsign;
          ac.FlightPlanGuid = u.Guid;
        } else {
          pendingFlightPlans.set(u.AssociatedTrackGuid, u);
        }
        return;
      }
      default: { // 0 = Track
        let ac = byGuid.get(u.Guid);
        if (!ac) {
          ac = new Aircraft();
          byGuid.set(u.Guid, ac);
          RadarWindow.Aircraft.Add(ac);
        }
        if (u.Location) ac.SetLocation(new GeoPoint(u.Location.Latitude, u.Location.Longitude), now);
        if (u.GroundTrack != null) ac.SetTrack(u.GroundTrack, now);
        if (u.GroundSpeed != null) ac.GroundSpeed = u.GroundSpeed;
        if (u.Squawk != null) ac.Squawk = u.Squawk;
        if (u.Callsign != null && u.Callsign !== "") {
          ac.Callsign = u.Callsign;
        }
        if (u.ModeSCode != null) ac.ModeSCode = u.ModeSCode;
        ac.LastMessageTime = now;
        if (u.Altitude != null && ac.Altitude) {
          const alt = u.Altitude.Value;
          if (alt != null) {
            try { if (u.Altitude.AltitudeType === 1) ac.Altitude.TrueAltitude = alt; else ac.Altitude.PressureAltitude = alt; } catch {}
          }
        }
        // Apply queued flight plan after all track data is set
        const queuedFp = pendingFlightPlans.get(u.Guid);
        if (queuedFp) {
          if (queuedFp.Callsign) ac.Callsign = queuedFp.Callsign;
          ac.FlightPlanGuid = queuedFp.Guid;
          pendingFlightPlans.delete(u.Guid);
        }
        return;
      }
    }
  }
  return { stop() { stop = true; }, count: () => byGuid.size };
}
