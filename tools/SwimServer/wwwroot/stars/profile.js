// ─────────────────────────────────────────────────────────────────────────
// STARS profile XML applier — translates a DGScope RadarWindow profile
// (the same XmlSerializer output the WPF app reads) into the JS state
// the scope already uses.
//
// Source format reference: DGScope/scope/RadarWindow.cs (XmlSerializer on
// the RadarWindow public properties + nested PrefSet/Nexrad/etc.).
// Example: %LOCALAPPDATA%\DGScope Profile Manager\profiles\profiles\
//          {ARTCC}\{FACILITY}.xml
//
// Server endpoint: /api/stars/profile/{artcc}/{name}  (StarsProfileRoutes.cs)
//
// Mapped fields (top-level RadarWindow → JS):
//   <BackColor>..<TPAColor>     → COLORS dict (Color.ToArgb signed int)
//   <HistoryColors> repeated     → HISTORY_COLORS (when accessor exposed)
//   <ScreenRotation>             → prefSet.ScreenRotation (deg, applied to canvas)
//   <ShowRangeRings>             → prefSet.ShowRangeRings
//   <QuickLookList><string>      → prefSet.QuickLookedTCPs
//   <SelectedBeaconCodes>        → window.SSA.selectedBeaconCodes
//   <DrawATPAMonitorCones>       → starsState.DrawATPAMonitorCones
//   <ClockPhase>                 → ClockPhase config (when exposed)
//   <Nexrad>                     → prefSet.Nexrad + WX_COLORS via Nexrad.setColorTable
//   <CurrentPrefSet>             → PrefSet (Brightness, Range, AltitudeFilter*,
//                                  PTL*, History*, Leader*, DCB*, CharSize, …)
// ─────────────────────────────────────────────────────────────────────────

(function () {
  // .NET Color.ToArgb() returns signed Int32 with ARGB byte order
  // (alpha << 24 | red << 16 | green << 8 | blue). Reverse:
  function argbInt32ToRgb(n) {
    n = Number(n) | 0;
    const a = (n >>> 24) & 0xff;
    const r = (n >>> 16) & 0xff;
    const g = (n >>>  8) & 0xff;
    const b = (n >>>  0) & 0xff;
    return { r, g, b, a };
  }

  // Read direct integer / float / bool / string child of an element.
  const intOf   = (el, tag) => { const t = el?.querySelector?.(tag)?.textContent;   return t == null ? null : parseInt(t, 10); };
  const floatOf = (el, tag) => { const t = el?.querySelector?.(tag)?.textContent;   return t == null ? null : parseFloat(t); };
  const boolOf  = (el, tag) => { const t = el?.querySelector?.(tag)?.textContent;   return t == null ? null : (t.trim().toLowerCase() === "true"); };
  const strOf   = (el, tag) => { const t = el?.querySelector?.(tag)?.textContent;   return t == null ? null : t.trim(); };
  // CHILD-of-element (querySelector descends; some tags repeat at deeper
  // levels e.g. <Range> appears under <CurrentPrefSet> AND inside ATPA
  // volumes — we need a DIRECT-child variant).
  const directChild = (el, tag) => {
    for (const c of el.children) if (c.tagName === tag) return c;
    return null;
  };
  const intD   = (el, tag) => { const c = directChild(el, tag); return c == null ? null : parseInt(c.textContent, 10); };
  const floatD = (el, tag) => { const c = directChild(el, tag); return c == null ? null : parseFloat(c.textContent); };
  const boolD  = (el, tag) => { const c = directChild(el, tag); return c == null ? null : (c.textContent.trim().toLowerCase() === "true"); };
  const strD   = (el, tag) => { const c = directChild(el, tag); return c == null ? null : c.textContent.trim(); };

  function colorRgb(el, tag) {
    const c = directChild(el, tag);
    if (!c || c.textContent.trim() === "") return null;
    const argb = argbInt32ToRgb(c.textContent);
    return [argb.r, argb.g, argb.b];
  }

  // Top-level <RadarWindow> Color* properties → COLORS dict keys.
  // Source: RadarWindow.cs:60-105 + the corresponding ToArgb XML attribs.
  const COLOR_MAP = {
    BackColor:               "Back",
    RangeRingColor:          "RangeRing",
    VideoMapLineColor:       "VideoMapA",
    VideoMapLineColorB:      "VideoMapB",
    ReturnColor:             "Return",
    BeaconColor:             "BeaconTarget",
    BeaconTargetColor:       "BeaconTarget",      // alt name on some profiles
    DataBlockColor:          "DataBlock",
    PointoutColor:           "Pointout",
    LDBColor:                "LDB",
    SelectedColor:           "Selected",
    OwnedColor:              "Owned",
    DataBlockEmergencyColor: "Emerg",
    RBLColor:                "RBL",
    TPAColor:                "TPA",
  };

  // <Nexrad><ColorTable><WXColor> ... </WXColor> ... </ColorTable></Nexrad>
  //   <MinValue>20</MinValue>
  //   <MinColor>-14267059</MinColor>
  //   <StippleColor>16777215</StippleColor>
  //   <Stipple>NONE|LIGHT|DENSE</Stipple>
  // Order: by MinValue ascending (matches NexradDisplay.cs:127-138 order).
  function readNexradColorTable(nexEl) {
    const ct = directChild(nexEl, "ColorTable");
    if (!ct) return null;
    const out = [];
    for (const c of ct.children) {
      if (c.tagName !== "WXColor") continue;
      const min     = floatD(c, "MinValue") ?? 0;
      const minRgb  = colorRgb(c, "MinColor") ?? [255, 255, 255];
      const stipple = (strD(c, "Stipple") || "NONE").toLowerCase();
      out.push({ minValue: min, color: minRgb, stipple });
    }
    out.sort((a, b) => a.minValue - b.minValue);
    return out;
  }

  // <CurrentPrefSet> → prefSet PARTIAL UPDATE. Names below mirror PrefSet
  // public properties (PrefSet.cs).
  function applyPrefSet(psEl, prefSet) {
    if (!psEl || !prefSet) return;
    const set = (tag, dst, conv = (x) => x) => {
      const v = directChild(psEl, tag);
      if (v != null && v.textContent.trim() !== "") prefSet[dst] = conv(v.textContent.trim());
    };
    set("Range",                         "Range",                          parseFloat);
    set("RangeRingSpacing",              "RangeRingSpacing",               parseInt);
    set("RangeRingsCentered",            "RangeRingsCentered",             (t) => t.toLowerCase() === "true");
    set("DCBLocation",                   "DCBLocation",                    (t) => t);
    set("DCBVisible",                    "DCBVisible",                     (t) => t.toLowerCase() === "true");
    set("OwnedDataBlockPosition",        "OwnedDataBlockPosition",         (t) => t);
    set("UnownedDataBlockPosition",      "UnownedDataBlockPosition",       (t) => t);
    set("UnassociatedDataBlockPosition", "UnassociatedDataBlockPosition",  (t) => t);
    set("LeaderLength",                  "LeaderLength",                   parseInt);
    set("PTLLength",                     "PTLLength",                      parseFloat);
    set("PTLOwn",                        "PTLOwn",                         (t) => t.toLowerCase() === "true");
    set("PTLAll",                        "PTLAll",                         (t) => t.toLowerCase() === "true");
    set("HistoryNum",                    "HistoryNum",                     parseInt);
    set("HistoryRate",                   "HistoryRate",                    parseFloat);
    set("AltitudeFilterAssociatedMin",   "AltitudeFilterAssociatedMin",   parseInt);
    set("AltitudeFilterAssociatedMax",   "AltitudeFilterAssociatedMax",   parseInt);
    set("AltitudeFilterUnAssociatedMin", "AltitudeFilterUnAssociatedMin", parseInt);
    set("AltitudeFilterUnAssociatedMax", "AltitudeFilterUnAssociatedMax", parseInt);
    set("ScopeCentered",                 "ScopeCentered",                  (t) => t.toLowerCase() === "true");
    set("LdbBeaconCodesInhibited",       "LdbBeaconCodesInhibited",        (t) => t.toLowerCase() === "true");

    // Brightness — each named child under <Brightness>.
    const br = directChild(psEl, "Brightness");
    if (br) {
      prefSet.Brightness = prefSet.Brightness || {};
      const fields = [
        "DCB", "Background", "FullDataBlocks", "Lists", "PositionSymbols",
        "LimitedDataBlocks", "OtherFDBs", "Tools", "RangeRings", "Compass",
        "BeaconTargets", "PrimaryTargets", "History", "Weather", "WeatherContrast",
      ];
      for (const f of fields) {
        const v = directChild(br, f);
        if (v != null) prefSet.Brightness[f] = parseInt(v.textContent, 10);
      }
      // The earlier 3-into-1 collapse (DataBlock / Position) is preserved
      // — last-write-wins from the most-specific WPF field. KNOWN-DEVIATIONS.md
      // A2/A3 explains why the split isn't yet wired through every renderer.
      if (prefSet.Brightness.FullDataBlocks != null) prefSet.Brightness.DataBlock = prefSet.Brightness.FullDataBlocks;
      if (prefSet.Brightness.PositionSymbols != null) prefSet.Brightness.Position = prefSet.Brightness.PositionSymbols;
    }

    // <CharSize> sub-block with DataBlock/Lists/DCB/Tools/Position pixel sizes.
    const cs = directChild(psEl, "CharSize");
    if (cs) {
      prefSet.CharSize = prefSet.CharSize || {};
      for (const c of cs.children) {
        const n = parseInt(c.textContent, 10);
        if (Number.isFinite(n)) prefSet.CharSize[c.tagName] = n;
      }
    }

    // <PreviewAreaLocation>, <StatusAreaLocation>.
    const setPt = (tag, dst) => {
      const el = directChild(psEl, tag);
      if (!el) return;
      const X = intD(el, "X"), Y = intD(el, "Y");
      if (X != null && Y != null) prefSet[dst] = { X, Y };
    };
    setPt("PreviewAreaLocation", "PreviewAreaLocation");
    setPt("StatusAreaLocation",  "StatusAreaLocation");
  }

  // Apply a parsed DGScope profile XML (DOMParser document) to live state.
  function apply(doc) {
    const rw = doc.querySelector("RadarWindow");
    if (!rw) { console.warn("[STARS profile] no <RadarWindow> root"); return; }

    // Top-level Color* → COLORS dict.
    if (window.COLORS) {
      for (const [tag, key] of Object.entries(COLOR_MAP)) {
        const rgb = colorRgb(rw, tag);
        if (rgb) window.COLORS[key] = rgb;
      }
    }

    // ScreenRotation (degrees) → prefSet for renderer to consume.
    const rot = directChild(rw, "ScreenRotation");
    if (rot != null) window.prefSet.ScreenRotation = parseFloat(rot.textContent);

    // <ShowRangeRings>.
    const srr = directChild(rw, "ShowRangeRings");
    if (srr != null) window.prefSet.ShowRangeRings = srr.textContent.trim().toLowerCase() === "true";

    // <QuickLookList><string>...</string></QuickLookList>
    const ql = directChild(rw, "QuickLookList");
    if (ql) {
      const list = [];
      for (const s of ql.querySelectorAll("string")) list.push(s.textContent.trim());
      window.prefSet.QuickLookedTCPs = list;
    }

    // <SelectedBeaconCodes><string>...</SelectedBeaconCodes>
    const sb = directChild(rw, "SelectedBeaconCodes");
    if (sb && window.SSA) {
      window.SSA.selectedBeaconCodes = [...sb.querySelectorAll("string")].map(s => s.textContent.trim());
    }

    // <DrawATPAMonitorCones>true</...>
    const dac = directChild(rw, "DrawATPAMonitorCones");
    if (dac != null && window.starsState) {
      window.starsState.DrawATPAMonitorCones = dac.textContent.trim().toLowerCase() === "true";
    }

    // <InvertKeyboard>, <InvertMouse>
    const ik = directChild(rw, "InvertKeyboard");
    if (ik != null) window.prefSet.InvertKeyboard = ik.textContent.trim().toLowerCase() === "true";

    // <Nexrad> → prefSet.Nexrad + ColorTable into Nexrad module.
    const nx = directChild(rw, "Nexrad");
    if (nx) {
      window.prefSet.Nexrad = window.prefSet.Nexrad || { enabled: false, levels: 0x3F, brightness: 80 };
      const en = directChild(nx, "Enabled");
      if (en != null) window.prefSet.Nexrad.enabled = en.textContent.trim().toLowerCase() === "true";
      const table = readNexradColorTable(nx);
      if (table && window.Nexrad?.setColorTable) window.Nexrad.setColorTable(table);
    }

    // <CurrentPrefSet> → prefSet fields.
    const cps = directChild(rw, "CurrentPrefSet");
    if (cps) applyPrefSet(cps, window.prefSet);

    // <FontName>, <DCBFontName>, etc. — the web port uses CSS @font-face;
    // we apply size only (cf. FontSize → prefSet.FontSize for the SSA/MCA).
    const fs = directChild(rw, "FontSize");
    if (fs != null) window.prefSet.FontSize = parseInt(fs.textContent, 10);
    const dfn = directChild(rw, "DCBFontSize");
    if (dfn != null) {
      window.prefSet.CharSize = window.prefSet.CharSize || {};
      window.prefSet.CharSize.DCB = parseInt(dfn.textContent, 10);
    }

    console.log("[STARS profile] applied — COLORS, prefSet, NEXRAD ColorTable refreshed.");
    // Nudge the DCB + canvas to re-render with new state.
    window._afterPrefChange?.();
    if (window.dcb?.render) window.dcb.render();
  }

  // Fetch + apply by name. Returns true on success.
  async function load(artcc, name) {
    try {
      const r = await fetch(`/api/stars/profile/${encodeURIComponent(artcc)}/${encodeURIComponent(name)}`);
      if (!r.ok) { console.warn(`[STARS profile] ${artcc}/${name} → HTTP ${r.status}`); return false; }
      const text = await r.text();
      const doc  = new DOMParser().parseFromString(text, "application/xml");
      // DOMParser puts errors inside the doc as <parsererror>.
      if (doc.querySelector("parsererror")) {
        console.warn("[STARS profile] XML parse error");
        return false;
      }
      apply(doc);
      return true;
    } catch (e) {
      console.warn("[STARS profile] load failed:", e);
      return false;
    }
  }

  window.StarsProfile = { load, apply };
})();
