// ─────────────────────────────────────────────────────────────────────────
// STARS handoff state machine — line-by-line port of DGScope.
//
// Single source of truth for "Owned", "PendingHandoff", flash, and the
// 8-step ProcessImpliedCommand click chain. Every block below is preceded
// by the verbatim C# from DGScope so the translation is auditable.
//
// Source files:
//   .stars-reference/scope/RadarWindow.cs:1075-1093   PositionChange()
//   .stars-reference/scope/RadarWindow.cs:2688-2770   ProcessImpliedCommand
//   .stars-reference/scope/Aircraft.cs:100-110        Owned getter/setter
//   .stars-reference/scope/Aircraft.cs:34-58          PositionInd / PendingHandoff
//   .stars-reference/scope/RadarWindow.cs:5436-5468   colour tier (Owned branch)
// ─────────────────────────────────────────────────────────────────────────

(function () {
  // ── PositionInd / PendingHandoff resolution ─────────────────────────────
  //
  // DGScope state:
  //   Aircraft.PositionInd   — string (the controlling TCP)
  //   Aircraft.PendingHandoff — string (TCP the handoff is going to)
  //
  // Web-port state:
  //   t.PositionInd  — STDDS feed, set on TAIS tracks
  //   fp.Owner       — SFDPS/FDPS feed, controlling sector
  //   fp.PendingHandoff — TAIS <pendingHandoff> when present
  //
  // For "PositionInd" semantics we prefer fp.Owner (richest source) then
  // fall back to t.PositionInd. For PendingHandoff we use fp.PendingHandoff
  // (TAIS only — SFDPS surfaces handoff via fp.HandoffReceiving but that's
  // a separate event-driven field).
  function positionInd(t, fp) {
    const v = (fp && fp.Owner) || (t && t.PositionInd) || "";
    return v ? String(v).trim().toUpperCase() : "";
  }
  function pendingHandoff(t, fp) {
    const v = (fp && fp.PendingHandoff) || "";
    return v ? String(v).trim().toUpperCase() : "";
  }
  function me() {
    const v = (window.ownTcp && window.ownTcp()) || "";
    return v ? String(v).trim().toUpperCase() : "";
  }

  // ── PositionChange() — RadarWindow.cs:1080-1093 ─────────────────────────
  // C# source (verbatim):
  //   private void PositionChange()
  //   {
  //       lock (Aircraft)
  //       {
  //           var aclist = Aircraft.ToList();
  //           aclist.ForEach(x => x.Owned = x.PositionInd == ThisPositionIndicator || x.PendingHandoff == ThisPositionIndicator);
  //           aclist.ForEach(x => x.DataBlock.Flashing = x.PendingHandoff == ThisPositionIndicator);
  //           aclist.ForEach(x => x.DataBlock2.Flashing = x.PendingHandoff == ThisPositionIndicator);
  //           aclist.ForEach(x => x.DataBlock3.Flashing = x.PendingHandoff == ThisPositionIndicator);
  //           aclist.ForEach(x => x.FDB = false);
  //       }
  //       QuickLookList.Remove(ThisPositionIndicator);
  //       QuickLookList.Remove(ThisPositionIndicator + "+");
  //   }
  //
  // Web-port translation: re-derived per call rather than mutated on a
  // ForEach (canvas is stateless between frames). Mutates per-track _owned
  // booleans to mirror what DGScope's Owned property holds. Call after a
  // SIGN ON / SIGN OFF to clear FDB and update QuickLookList — same as
  // PositionChange in DGScope (invoked when ThisPositionIndicator changes).
  function onPositionChange() {
    if (!window.tracks) return;
    const meTcp = me();
    for (const t of window.tracks.values()) {
      const fp = window.trackToFp ? window.trackToFp.get(t.Guid) : null;
      const pi = positionInd(t, fp);
      const ph = pendingHandoff(t, fp);
      t._owned    = (pi === meTcp) || (ph === meTcp);
      t._flashing =  ph === meTcp;
      t._forcedMode = null;                            // cs:1089 FDB = false
    }
    // cs:1091-1092 — remove self from QuickLookList.
    if (window.prefSet && Array.isArray(window.prefSet.QuickLookedTCPs)) {
      const ql = window.prefSet.QuickLookedTCPs;
      const i  = ql.indexOf(meTcp);
      if (i >= 0) ql.splice(i, 1);
      const j  = ql.indexOf(meTcp + "+");
      if (j >= 0) ql.splice(j, 1);
    }
  }

  // ── isOwned / isFlashing — per-frame, equivalent to Aircraft.Owned ──────
  // Aircraft.Owned (Aircraft.cs:100-110) returns a stored bool; the bool
  // is REWRITTEN every PositionChange() call (cs:1085). Render code reads
  // it (RadarWindow.cs:5454, :5565, :6291 etc.). Since we don't have an
  // events-on-change setter, we just re-evaluate the predicate inline —
  // same result.
  function isOwned(t, fp) {
    const meTcp = me();
    if (!meTcp) return false;
    return positionInd(t, fp) === meTcp || pendingHandoff(t, fp) === meTcp;
  }
  function isInboundHandoff(t, fp) {
    const meTcp = me();
    if (!meTcp) return false;
    // TAIS feed: the receiving sector is NOT published, so inbound cannot
    // be detected on TAIS-sourced flight plans. The check still applies to
    // SFDPS-sourced ones (DGScope NAS feed parses the receiver from
    // <handoff> element) — and to any future feed that does carry it.
    const ph = pendingHandoff(t, fp);
    if (!ph || ph === "?") return false;            // placeholder = unknown rx
    return ph === meTcp;
  }
  function isOutboundHandoff(t, fp) {
    const meTcp = me();
    if (!meTcp) return false;
    // Outbound: we are the controlling position AND a handoff is in
    // progress. The receiver TCP is only known when ph !== "?" (non-TAIS
    // feeds); for TAIS we use IsHandoffInProgress as the trigger.
    if (positionInd(t, fp) !== meTcp) return false;
    if (fp && fp.IsHandoffInProgress) return true;
    const ph = pendingHandoff(t, fp);
    return ph && ph !== "?" && ph !== meTcp;
  }
  // Any handoff in progress on this track (regardless of direction). Used
  // for the data-block flash when we can't determine inbound/outbound
  // (TAIS captures show <ocr>=pending without a receiver).
  function isHandoffInProgress(t, fp) {
    if (fp && fp.IsHandoffInProgress) return true;
    const ph = pendingHandoff(t, fp);
    return !!ph;
  }
  // "Just transferred" — fired when cps transitioned AWAY from me (an
  // outbound handoff just got accepted by the receiver). Mirrors DGScope
  // Aircraft.Transferred event + Aircraft_Transferred handler stamping
  // JustTransferredAt + render-loop guard at RadarWindow.cs:6200 which
  // skips clearing Flashing while the 5s window is active.
  // CRC STARS spec: data block blinks white for 5 seconds after the
  // receiving controller accepts your outbound handoff, then stays
  // white until clicked.
  const JUST_TRANSFERRED_WINDOW_MS = 5000;
  function justTransferred(t, fp) {
    if (!fp || !fp._justTransferredAt) return false;
    if (Date.now() - fp._justTransferredAt > JUST_TRANSFERRED_WINDOW_MS) return false;
    return true;
  }

  // ── ProcessImpliedCommand — RadarWindow.cs:2688-2769 ────────────────────
  // C# source (verbatim — comments below mirror the WPF blocks):
  //
  //   if (clickedplane) {
  //       var plane = clicked as Aircraft;
  //       // Accept Handoff, Recall handoff
  //       if (plane.PendingHandoff == ThisPositionIndicator) {
  //           plane.PositionInd = ThisPositionIndicator;
  //           plane.PendingHandoff = null;
  //           plane.SendUpdate();
  //       }
  //       else if (plane.PositionInd == ThisPositionIndicator && !string.IsNullOrEmpty(plane.PendingHandoff)) {
  //           plane.PendingHandoff = null;
  //           plane.SendUpdate();
  //       }
  //       // Accept pointout / clear
  //       else if (plane.Pointout) {
  //           plane.Pointout = false;
  //       }
  //       else if (plane.ForceQuickLook) {
  //           plane.ForceQuickLook = false;
  //       }
  //       // Return data block to unowned color
  //       else if (plane.Owned && plane.PositionInd != ThisPositionIndicator) {
  //           plane.Owned = false;
  //       }
  //       // Beacon readout — owned + associated
  //       else if (plane.Owned && !string.IsNullOrEmpty(plane.FlightPlanCallsign)) {
  //           DisplayPreviewMessage(string.Format("{0} {1} {2}", plane.FlightPlanCallsign, plane.Squawk, plane.AssignedSquawk));
  //       }
  //       // Toggle FDB — !Owned + callsign
  //       else if (!plane.Owned && !string.IsNullOrEmpty(plane.FlightPlanCallsign)) {
  //           plane.FDB = !plane.FDB;
  //       }
  //       // Toggle FDB — no callsign (unassociated)
  //       else if (string.IsNullOrEmpty(plane.FlightPlanCallsign)) {
  //           plane.FDB = !plane.FDB;
  //       }
  //   }
  //
  // Web-port translation: mutate our local state (fp.Owner, fp.Pending-
  // Handoff, t._forcedMode, t._forceQuickLook). SendUpdate() is a no-op
  // because our feed is read-only — the local state change makes the
  // scope display match the user's intent, the SFDPS broker won't know.
  function processImplied(plane) {
    const fp     = window.trackToFp ? window.trackToFp.get(plane.Guid) : null;
    const meTcp  = me();
    const pi     = positionInd(plane, fp);
    const ph     = pendingHandoff(plane, fp);
    const cs     = (fp && fp.Callsign) ? fp.Callsign : "";

    // 1. ACCEPT — cs:2712-2717
    if (ph && ph === meTcp) {
      if (fp) {
        fp.Owner = meTcp; fp.PendingHandoff = null;
        // Bump freshness so mergedFp's "newest STATE wins" rule prefers
        // our local mutation over any stale sibling. Without this, a
        // sibling fp with an old Owner=other can shadow the accept and
        // the data block flips to PDB green instead of FDB white.
        // DGScope has no sibling merge (one Aircraft per plane) so this
        // hook is a port-only necessity.
        fp._updatedAt = Date.now();
      }
      plane._owned = true;
      plane._flashing = false;
      return;
    }
    // 2. RECALL — cs:2718-2722
    if (pi === meTcp && ph) {
      if (fp) { fp.PendingHandoff = null; fp._updatedAt = Date.now(); }
      plane._flashing = false;
      return;
    }
    // 3. Clear pointout — cs:2724-2727
    if (plane._pointout) { plane._pointout = false; return; }
    // 4. Clear ForceQuickLook — cs:2728-2731
    if (plane._forceQuickLook) { plane._forceQuickLook = false; return; }
    // 4.5 Stop the outbound-complete blink. Matches DGScope click handler
    // step added alongside Aircraft_Transferred: first click during the 5s
    // blink stops the flashing (data block stays white). Second click hits
    // RELEASE below to go green.
    if (fp && fp._justTransferredAt && pi && pi !== meTcp && ph !== meTcp) {
      const age = Date.now() - fp._justTransferredAt;
      if (age >= 0 && age < 5000) {
        fp._justTransferredAt = 0;
        return;
      }
    }
    // 5. RELEASE — cs:2744-2747
    if (plane._owned && pi && pi !== meTcp) {
      plane._owned = false;
      return;
    }
    // 6. Beacon readout — cs:2752-2755
    if (plane._owned && cs) {
      const sq = plane.Squawk || "";
      const asq = fp && fp.AssignedSquawk ? String(fp.AssignedSquawk).padStart(4, "0") : "";
      if (window.setResponse) window.setResponse(`${cs} ${sq} ${asq}`.trim());
      return;
    }
    // 7. Toggle FDB — !Owned + callsign — cs:2757-2760
    if (!plane._owned && cs) {
      const cur = (typeof window.dataBlockMode === "function")
        ? window.dataBlockMode(plane, fp) : "LDB";
      plane._forcedMode = (cur === "FDB") ? "LDB" : "FDB";
      return;
    }
    // 8. Toggle FDB — unassociated — cs:2764-2767
    if (!cs) {
      const cur = (typeof window.dataBlockMode === "function")
        ? window.dataBlockMode(plane, fp) : "LDB";
      plane._forcedMode = (cur === "FDB") ? "LDB" : "FDB";
      return;
    }
  }

  // ── Inbound-handoff flash phase ─────────────────────────────────────────
  // RadarWindow.cs:1086 sets DataBlock.Flashing = true when PendingHandoff
  // == me; the actual blink phase is driven by the OpenGL frame counter
  // and pulses ~1 Hz. We mirror with wall-clock mod 1000.
  function flashPhaseHidden() { return (Date.now() % 1000) >= 500; }

  window.Handoff = {
    positionInd, pendingHandoff, me,
    isOwned, isInboundHandoff, isOutboundHandoff, isHandoffInProgress,
    justTransferred,
    onPositionChange,
    processImplied,
    flashPhaseHidden,
  };
})();
