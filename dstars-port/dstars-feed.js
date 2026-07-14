// Feed receiver for the DGScope port — consumes SwimReader.Server's dSTARS HTTP stream
// (/dstars/{facility}/updates, newline-delimited JSON of DstarsTrackUpdate/FlightPlanUpdate/Deletion)
// and drives RadarWindow.Aircraft. This is the browser equivalent of DGScope's ScopeServerClient
// receiver (which isn't part of the ported scope/scope project — it lives in a separate assembly).
import { RadarWindow } from "./src/RadarWindow.js";
import { Aircraft } from "./src/Aircraft.js";

export function connectFeed(facility, onState) {
  const byGuid = new Map();               // track/fp Guid (string) -> Aircraft
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
            if (line) { try { handle(JSON.parse(line)); } catch (e) { /* skip bad line */ } }
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
          if (u.Callsign != null) { ac.Callsign = u.Callsign; ac.FlightPlanCallsign = u.Callsign; }
          if (u.AssociatedTrackGuid) byGuid.set(u.AssociatedTrackGuid, ac);
        }
        return;
      }
      default: { // 0 = Track
        let ac = byGuid.get(u.Guid);
        if (!ac) { ac = new Aircraft(); byGuid.set(u.Guid, ac); RadarWindow.Aircraft.Add(ac); }
        ac.SetLocation(u.Latitude, u.Longitude, now);
        if (u.GroundTrack != null) ac.SetTrack(u.GroundTrack, now);
        if (u.GroundSpeed != null) ac.GroundSpeed = u.GroundSpeed;
        if (u.Squawk != null) ac.Squawk = u.Squawk;
        if (u.Callsign != null && (ac.Callsign == null || ac.Callsign === "")) ac.Callsign = u.Callsign;
        if (u.ModeSCode != null) ac.ModeSCode = u.ModeSCode;
        ac.LastMessageTime = now;
        // Altitude: DstarsAltitude → reported pressure/true altitude (best-effort field probing).
        if (u.Altitude != null && ac.Altitude) {
          const alt = (typeof u.Altitude === "number") ? u.Altitude
                    : (u.Altitude.Value ?? u.Altitude.PressureAltitude ?? u.Altitude.TrueAltitude);
          if (alt != null) {
            try { if (u.AltitudeType === 1) ac.Altitude.TrueAltitude = alt; else ac.Altitude.PressureAltitude = alt; } catch {}
          }
        }
        return;
      }
    }
  }
  return { stop() { stop = true; }, count: () => byGuid.size };
}
