// ─────────────────────────────────────────────────────────────────────────────
// STARS Display Control Bar (DCB) — Phase 4.
//
// Ports from the WPF DGScope reference:
//   • scope/DCB.cs (full)              — DCB container, layout, draw frame
//   • scope/DCBButton.cs (full)        — button colors + states (Active,
//                                        Disabled, Hover, Dwell)
//   • scope/DCBMenu.cs (full)          — menu container, button list
//   • scope/RadarWindow.cs:3468-3608   — every button declaration, exact
//                                        Text, exact Height/Width, exact
//                                        AddButton ordering
//   • scope/RadarWindow.cs:3920-3995   — UpdateDcbButtonText (live label
//                                        formatters: "RANGE\n{Range}",
//                                        "RR\n{spacing}", brite labels)
//   • scope/RadarWindow.cs:3800-3815   — RR CNTR toggle behavior
//   • scope/RadarWindow.cs:4140-4180   — LDR/HISTORY +/− on right-click
//   • scope/RadarWindow.cs:4430-4520   — Brightness slider math (step=10)
//   • CRC docs § Display Control Bar  — button taxonomy & submenu layout
//
// All deviations: see docs/stars/KNOWN-DEVIATIONS.md (G14 added for the
// button colors which match the WPF DCBButton defaults exactly).
// ─────────────────────────────────────────────────────────────────────────────

// Color constants — DCBButton.cs lines 23-26 verbatim.
const DCB_COLOR = {
  ACTIVE_BG:        "rgb(0, 128, 0)",       // Color.Green
  INACTIVE_BG:      "rgb(0, 80, 0)",        // Color.FromArgb(0,80,0)
  DISABLED_BG:      "rgb(0, 40, 0)",        // Color.FromArgb(0,40,0)
  FRAME_BG:         "rgb(0, 35, 15)",       // DCB.cs:96 — main panel fill
  TEXT:             "rgb(255, 255, 255)",   // Color.White
  TEXT_DWELL:       "rgb(255, 255, 0)",     // Color.Yellow
  TEXT_DISABLED:    "rgb(64, 64, 64)",      // Color.DarkGray
  BORDER:           "rgb(0, 60, 0)",
};

// Button factory — kept tiny because we render ~50 of them.
function btn(id, text, opts = {}) {
  return {
    id, text, ...opts,
    active: !!opts.active,
    disabled: !!opts.disabled,
  };
}

// Adjusted color per brightness slider.
function dcbAdjust(rgbStr, brightness) {
  // Parse "rgb(r,g,b)" → scaled
  const m = rgbStr.match(/\d+/g);
  if (!m) return rgbStr;
  const k = brightness / 100;
  return `rgb(${(m[0]|0)*k|0}, ${(m[1]|0)*k|0}, ${(m[2]|0)*k|0})`;
}

// ── Menu definitions (button order matches RadarWindow.cs:3536-3590) ────────
function mainMenu(state) {
  const p = state.prefSet;
  // Heights verbatim from scope/RadarWindow.cs:3468-3608 button declarations.
  const list = [
    btn("RANGE", `RANGE\n${p.Range}`),                                                   // 80
    btn("PLACE_CNTR", "PLACE\nCNTR", { half: true }),                                    // 40
    btn("OFF_CNTR", "OFF\nCNTR", { half: true }),                                        // 40
    btn("RR_NUM", `RR\n${p.RangeRingSpacing}`),                                          // 80
    btn("PLACE_RR", "PLACE\nRR", { half: true }),                                        // 40
    btn("RR_CNTR", "RR\nCNTR", { active: p.RangeRingsCentered, half: true }),            // 40
    btn("MAPS", "MAPS", { submenu: "MAPS" }),                                            // 80
  ];
  // Inline MAP buttons show the bound map's starsId + shortName, matching
  // WPF rendering ("37 MNORTH" / "38 MSOUTH" / ...). Falls back to "MAP n"
  // when no map is bound to that slot yet.
  for (let i = 0; i < 6; i++) {
    const m = state.dcbMapAt(i);
    let label;
    if (m) {
      const name = (m.shortName || m.name || "").slice(0, 8);
      label = m.starsId != null ? `${m.starsId}\n${name}` : (name || `MAP ${i + 1}`);
    } else {
      label = `MAP\n${i + 1}`;
    }
    list.push(btn(`MAP_${i}`, label, {
      active: !!(m && m.visible), half: true, mapIdx: i,                                 // 40
    }));
  }
  for (let i = 0; i < 6; i++) {
    list.push(btn(`WX_${i + 1}`, `WX${i + 1}`, {
      active: !!state.wxLevels[i], wx: i + 1, narrow: true,                              // 80h × 40w
    }));
  }
  list.push(btn("BRITE", "BRITE", { submenu: "BRITE" }));                                // 80
  list.push(btn("LDR_DIR", `LDR DIR\n${ldrDirName(p.OwnedDataBlockPosition)}`,
    { half: true }));                                                                    // 40
  list.push(btn("LDR_LEN", `LDR LEN\n${p.LeaderLength}`, { half: true }));                // 40 (RadarWindow.cs:3946)
  list.push(btn("CHAR_SIZE", "CHAR\nSIZE", { submenu: "CHARSIZE" }));                    // 80
  list.push(btn("MODE", "MODE\nFSL", { disabled: true }));                               // 80
  list.push(btn("SITE", "SITE", { submenu: "SITE" }));                                   // 80
  list.push(btn("SHIFT", "SHIFT", { submenu: "AUX" }));                                  // 80
  return list;
}

function auxMenu(state) {
  const p = state.prefSet;
  // Heights verbatim from scope/RadarWindow.cs:3492-3508.
  const list = [
    btn("VOL", "VOL\nN/A", { disabled: true }),                                            // 80
    btn("HIST_NUM", `HISTORY\n${p.HistoryNum}`, { half: true }),                          // 40
    btn("HIST_RATE", `H_RATE\n${p.HistoryRate.toFixed(1)}`, { half: true }),              // 40 (RadarWindow.cs:3953)
    btn("CURSOR_HOME", "CURSOR\nHOME", { disabled: true }),                                // 80
    btn("CURSOR_SPEED", "CSR SPD\nN/A", { disabled: true }),                              // 80
    btn("MAP_UNCOR", "MAP\nUNCOR", { disabled: true }),                                    // 80
    btn("UNCOR", "UNCOR", { disabled: true }),                                             // 80
    btn("BEACON_MODE", "BEACON\nMODE-2", { disabled: true }),                              // 80
    btn("RTQC", "RTQC", { disabled: true }),                                               // 80
    btn("MCP", "MCP", { disabled: true }),                                                 // 80
    btn("DCB_TOP",    "DCB\nTOP",    { active: p.DCBLocation === "Top",    half: true }), // 40
    btn("DCB_LEFT",   "DCB\nLEFT",   { active: p.DCBLocation === "Left",   half: true }), // 40
    btn("DCB_RIGHT",  "DCB\nRIGHT",  { active: p.DCBLocation === "Right",  half: true }), // 40
    btn("DCB_BOTTOM", "DCB\nBOTTOM", { active: p.DCBLocation === "Bottom", half: true }), // 40
    btn("PTL_LEN", `PTL\nLNTH\n${p.PTLLength}`),                                           // 80 (RadarWindow.cs:3954)
    btn("PTL_OWN", "PTL OWN", { active: p.PTLOwn, half: true }),                          // 40
    btn("PTL_ALL", "PTL ALL", { active: p.PTLAll, half: true }),                          // 40
    btn("SHIFT", "SHIFT", { submenu: "MAIN" }),                                            // 80
  ];
  return list;
}

function briteMenu(state) {
  const b = state.prefSet.Brightness;
  // BRITE submenu — every adjustment button is 40 tall per RadarWindow.cs
  // :3511+ (briteDCBbutton..briteWXCbutton all have Height = 40). They pair
  // 2-per-column. DONE button is 80 (full) per briteDoneButton declaration.
  const items = [
    ["DCB",     "DCB",     b.DCB],
    ["BKC",     "BKC",     b.Background],
    ["MPA",     "MPA",     b.VideoMapA],
    ["MPB",     "MPB",     b.VideoMapB],
    ["FDB",     "FDB",     b.DataBlock],
    ["LST",     "LST",     b.Lists],
    ["POS",     "POS",     b.Position],
    ["LDB",     "LDB",     b.DataBlock],
    ["OTH",     "OTH",     b.DataBlock],
    ["TLS",     "TLS",     b.Lists],
    ["RR",      "RR",      b.RangeRings],
    ["CMP",     "CMP",     b.Compass],
    ["BCN",     "BCN",     b.Position],
    ["PRI",     "PRI",     b.Position],
    ["HST",     "HST",     b.History],
    ["WX",      "WX",      b.Weather],
    ["WXC",     "WXC",     b.Weather],
  ];
  const list = items.map(([id, label, v]) =>
    btn(`BRITE_${id}`, `${label} ${v}`, { brite: id, half: true }));
  list.push(btn("BRITE_DONE", "DONE", { submenu: "MAIN" }));     // 80
  return list;
}

function mapsMenu(state) {
  // MAPS submenu — verbatim heights from scope/RadarWindow.cs:3476-3477 +
  // 3563-3567 (DONE = 40, CLR ALL = 40, every per-map toggle = 40).
  const list = [
    btn("MAPS_DONE", "DONE", { submenu: "MAIN", half: true }),
    btn("MAPS_CLEAR", "CLR ALL", { half: true }),
  ];
  for (let i = 0; i < state.videoMaps.length; i++) {
    const m = state.videoMaps[i];
    const lbl = m.shortName || m.name || (m.starsId != null ? `MAP ${m.starsId}` : `MAP ${i + 1}`);
    list.push(btn(`MAP_TOG_${i}`, lbl.slice(0, 8), {
      active: !!m.visible,
      mapIdx: i,
      half: true,
    }));
  }
  return list;
}

// CHAR SIZE submenu — per CRC docs § DCB CHAR SIZE: 5 adjustable categories.
function charSizeMenu(state) {
  const c = state.prefSet.CharSize;
  const list = [
    btn("CSZ_DONE", "DONE", { submenu: "MAIN" }),
    btn("CSZ_DB",   `DATA\nBLOCKS\n${c.DataBlock}`, { csz: "DataBlock" }),
    btn("CSZ_LST",  `LISTS\n${c.Lists}`,     { csz: "Lists" }),
    btn("CSZ_DCB",  `DCB\n${c.DCB}`,         { csz: "DCB" }),
    btn("CSZ_TLS",  `TOOLS\n${c.Tools}`,     { csz: "Tools" }),
    btn("CSZ_POS",  `POS\n${c.Position}`,    { csz: "Position" }),
  ];
  return list;
}

function siteMenu(state) {
  // RadarWindow.cs:3737-3770 — one button per ASR site, then MULTI (disabled),
  // then FUSED. No DONE button (WPF closes on a site click).
  const list = [];
  for (const s of state.asrSites) {
    list.push(btn(`SITE_${s.id}`, s.asrId || s.id.slice(0, 5),
      { active: state.radar === s.id }));
  }
  list.push(btn("SITE_MULTI", "MULTI", { disabled: true }));            // RadarWindow.cs:3757 Enabled=false
  list.push(btn("SITE_FUSED", "FUSED", { active: state.radar === "FUSED" || state.radar == null }));
  return list;
}

function ldrDirName(v) {
  return ["INV","NW","N","NE","W","","E","SW","S","SE"][v|0] || "N";
}

// ── Layout + render ─────────────────────────────────────────────────────────
// Submenu mode: AUX replaces the main menu (SHIFT navigation), but BRITE /
// MAPS / SITE / CHARSIZE are popouts that float next to their parent
// button while the main DCB stays visible underneath dimmed. Mirrors CRC's
// behaviour where most submenus pop out.
const POPOUT_SUBMENUS = new Set(["BRITE", "MAPS", "SITE", "CHARSIZE"]);

class DCB {
  constructor(rootEl, state) {
    this.root = rootEl;
    this.state = state;
    this.active = "MAIN";        // base menu always one of MAIN / AUX
    this.popout = null;           // current popout submenu key, or null
    this.popoutAnchorId = null;   // ID of the parent button so we can find rect
    this.handlers = {};
    rootEl.addEventListener("click", (e) => this._onClick(e));
    rootEl.addEventListener("contextmenu", (e) => this._onRClick(e));
    rootEl.addEventListener("wheel",     (e) => this._onWheel(e), { passive: false });
    // Backdrop + popout overlay containers, mounted as siblings of the DCB
    this.backdrop = document.createElement("div");
    this.backdrop.id = "dcb-backdrop";
    this.backdrop.style.cssText = `
      position: fixed; inset: 0;
      background: transparent;
      z-index: 19;
      display: none;
    `;
    this.backdrop.addEventListener("click", () => { this.popout = null; this.popoutAnchorId = null; this.render(); });
    document.body.appendChild(this.backdrop);
    this.popoutEl = document.createElement("div");
    this.popoutEl.id = "dcb-popout";
    this.popoutEl.style.cssText = `
      position: fixed; z-index: 21;
      display: none;
      background: ${DCB_COLOR.FRAME_BG};
      padding: 0;
      box-sizing: border-box;
      align-content: flex-start;
      font-family: FixedDemiBold, ui-monospace, monospace;
    `;
    this.popoutEl.addEventListener("click", (e) => this._onPopoutClick(e));
    this.popoutEl.addEventListener("contextmenu", (e) => this._onPopoutRClick(e));
    this.popoutEl.addEventListener("wheel", (e) => this._onPopoutWheel(e), { passive: false });
    document.body.appendChild(this.popoutEl);
  }
  on(event, fn) { (this.handlers[event] ||= []).push(fn); }
  emit(event, ...args) { (this.handlers[event] || []).forEach(fn => fn(...args)); }

  buttons() {
    // Only MAIN/AUX render in the base DCB. Popout submenus render in
    // the popoutEl overlay.
    switch (this.active) {
      case "MAIN": return mainMenu(this.state);
      case "AUX":  return auxMenu(this.state);
    }
    return [];
  }
  popoutButtons() {
    switch (this.popout) {
      case "BRITE":    return briteMenu(this.state);
      case "MAPS":     return mapsMenu(this.state);
      case "SITE":     return siteMenu(this.state);
      case "CHARSIZE": return charSizeMenu(this.state);
    }
    return [];
  }

  render() {
    const p = this.state.prefSet;
    const loc = p.DCBLocation;
    const vertical = (loc === "Left" || loc === "Right");
    const sizeAxis = 80;

    // Horizontal DCB: flex-flow: column wrap inside an 80-tall strip → items
    // flow TOP→BOTTOM, then wrap to next column. Two 40-tall items stack in
    // the same column; an 80-tall item takes the column alone.
    // Vertical DCB: flex-flow: row wrap inside an 80-wide strip → items flow
    // LEFT→RIGHT then wrap. Two 40-wide items share a row.
    // Horizontal DCB: flex-flow:column wrap with EXACT 80px inner height so
    // 40+40 half buttons sum to 80 and stack into one column. Any internal
    // margin/padding pushes the sum past 80 and forces a new column for each
    // half button (the bug seen in chrome).
    Object.assign(this.root.style, {
      position: "fixed",
      background: dcbAdjust(DCB_COLOR.FRAME_BG, p.Brightness.DCB),
      pointerEvents: "auto",
      userSelect: "none",
      fontFamily: "FixedDemiBold, ui-monospace, monospace",
      display: "flex",
      gap: "0",
      padding: "0",
      zIndex: 20,
      alignContent: "flex-start",
      boxSizing: "border-box",
      ...(vertical
          ? { top: 0, bottom: 0, width: sizeAxis + "px",
              [loc === "Left" ? "left" : "right"]: 0,
              flexFlow: "row wrap", overflowY: "hidden" }
          : { left: 0, right: 0, height: sizeAxis + "px",
              [loc === "Top" ? "top" : "bottom"]: 0,
              flexFlow: "column wrap", overflowX: "hidden" }),
    });

    const halfAxis = sizeAxis / 2;   // 40
    const html = this.buttons().map(b => {
      let w, h;
      if (vertical) {
        h = b.narrow ? halfAxis : sizeAxis;
        w = b.half ? halfAxis : sizeAxis;
      } else {
        w = b.narrow ? halfAxis : sizeAxis;
        h = b.half ? halfAxis : sizeAxis;
      }
      const bg = b.disabled ? DCB_COLOR.DISABLED_BG
                : b.active   ? DCB_COLOR.ACTIVE_BG
                             : DCB_COLOR.INACTIVE_BG;
      const fg = b.disabled ? DCB_COLOR.TEXT_DISABLED : DCB_COLOR.TEXT;
      const fs = (p.CharSize?.DCB ?? 11);
      // DCBButton.Draw (DCBButton.cs:60-130) renders a 3-pixel BEVEL:
      //   inactive (raised):
      //     top-left poly  = DarkGray  (cs:71  drawactive=false)
      //     bot-right poly = Black     (cs:81  drawactive=false → drawactive used inverted)
      //   active (pressed) — colours SWAP, looks recessed.
      // bordersize is 3 (cs:12). Easiest CSS analog is 4 differently-coloured
      // borders. AdjustedColor scales DarkGray (128,128,128) by Brightness.DCB.
      const bri = (p.Brightness?.DCB ?? 100) / 100;
      const dark    = `rgb(${(128*bri)|0},${(128*bri)|0},${(128*bri)|0})`;  // Color.DarkGray
      const black   = "rgb(0,0,0)";
      // drawactive in WPF starts true when Active != (mousePressed && mouseInside).
      // Without hover state in our HTML render path, treat active = pressed look.
      const tl = b.active ? black : dark;       // top + left bevel
      const br = b.active ? dark  : black;      // bottom + right bevel
      return `<div class="dcb-btn" data-id="${b.id}"
        ${b.mapIdx != null ? `data-map="${b.mapIdx}"` : ""}
        ${b.brite ? `data-brite="${b.brite}"` : ""}
        ${b.wx ? `data-wx="${b.wx}"` : ""}
        ${b.csz ? `data-csz="${b.csz}"` : ""}
        ${b.submenu ? `data-submenu="${b.submenu}"` : ""}
        ${b.disabled ? `data-disabled="1"` : ""}
        style="
          width:${w}px; height:${h}px;
          background:${dcbAdjust(bg, p.Brightness.DCB)};
          color:${fg};
          border-top:3px solid ${tl};
          border-left:3px solid ${tl};
          border-right:3px solid ${br};
          border-bottom:3px solid ${br};
          display:flex; align-items:center; justify-content:center;
          text-align:center; line-height:1.05; font-size:${fs}px;
          white-space:pre; cursor:${b.disabled ? "default" : "pointer"};
          flex:none; box-sizing:border-box;
        ">${b.text}</div>`;
    }).join("");
    this.root.innerHTML = html;
    this._renderPopout();
  }

  _renderPopout() {
    if (!this.popout) {
      this.popoutEl.style.display = "none";
      this.backdrop.style.display = "none";
      return;
    }
    // Find anchor button in the main DCB.
    const anchor = this.popoutAnchorId
      ? this.root.querySelector(`[data-id="${this.popoutAnchorId}"]`)
      : null;
    const p = this.state.prefSet;
    const sizeAxis = 80;
    const halfAxis = 40;
    const items = this.popoutButtons();
    const vertical = (p.DCBLocation === "Left" || p.DCBLocation === "Right");
    // Container size: row of buttons next to the anchor (horizontal DCB) or
    // column of buttons (vertical DCB).
    // We render the same flex-flow as base menu so two half-buttons stack.
    Object.assign(this.popoutEl.style, {
      display: "flex",
      flexFlow: vertical ? "row wrap" : "column wrap",
      [vertical ? "width" : "height"]: sizeAxis + "px",
      alignContent: "flex-start",
      background: dcbAdjust(DCB_COLOR.FRAME_BG, p.Brightness.DCB),
      boxShadow: "0 0 12px #000",
    });

    // Position next to anchor
    if (anchor) {
      const r = anchor.getBoundingClientRect();
      if (vertical) {
        // DCB at left/right: popout below/above the anchor
        this.popoutEl.style.top = r.bottom + "px";
        this.popoutEl.style.left = r.left + "px";
      } else {
        // DCB at top/bottom: popout to the right of the anchor
        this.popoutEl.style.top = r.top + "px";
        this.popoutEl.style.left = r.right + "px";
        this.popoutEl.style.height = sizeAxis + "px";
      }
    } else {
      // Fallback: anchor not found, position near top-left
      this.popoutEl.style.top = "10px";
      this.popoutEl.style.left = "10px";
    }

    const html = items.map(b => {
      let w, h;
      if (vertical) {
        h = b.narrow ? halfAxis : sizeAxis;
        w = b.half   ? halfAxis : sizeAxis;
      } else {
        w = b.narrow ? halfAxis : sizeAxis;
        h = b.half   ? halfAxis : sizeAxis;
      }
      const bg = b.disabled ? DCB_COLOR.DISABLED_BG
                : b.active   ? DCB_COLOR.ACTIVE_BG
                             : DCB_COLOR.INACTIVE_BG;
      const fg = b.disabled ? DCB_COLOR.TEXT_DISABLED : DCB_COLOR.TEXT;
      const fs = (p.CharSize?.DCB ?? 11);
      // Bevel — same as main DCB (DCBButton.cs:60-130).
      const bri = (p.Brightness?.DCB ?? 100) / 100;
      const dark  = `rgb(${(128*bri)|0},${(128*bri)|0},${(128*bri)|0})`;
      const black = "rgb(0,0,0)";
      const tl = b.active ? black : dark;
      const br = b.active ? dark  : black;
      return `<div class="dcb-btn" data-id="${b.id}"
        ${b.mapIdx != null ? `data-map="${b.mapIdx}"` : ""}
        ${b.brite ? `data-brite="${b.brite}"` : ""}
        ${b.wx ? `data-wx="${b.wx}"` : ""}
        ${b.csz ? `data-csz="${b.csz}"` : ""}
        ${b.submenu ? `data-submenu="${b.submenu}"` : ""}
        ${b.disabled ? `data-disabled="1"` : ""}
        style="
          width:${w}px; height:${h}px;
          background:${dcbAdjust(bg, p.Brightness.DCB)};
          color:${fg};
          border-top:3px solid ${tl};
          border-left:3px solid ${tl};
          border-right:3px solid ${br};
          border-bottom:3px solid ${br};
          display:flex; align-items:center; justify-content:center;
          text-align:center; line-height:1.05; font-size:${fs}px;
          white-space:pre; cursor:${b.disabled ? "default" : "pointer"};
          flex:none; box-sizing:border-box;
        ">${b.text}</div>`;
    }).join("");
    this.popoutEl.innerHTML = html;

    // Compute width (horizontal DCB) so we know the popout's pixel extent
    // for clamping if it would go off-screen.
    requestAnimationFrame(() => {
      const r = this.popoutEl.getBoundingClientRect();
      if (!vertical && r.right > window.innerWidth) {
        this.popoutEl.style.left = (window.innerWidth - r.width) + "px";
      }
    });

    this.backdrop.style.display = "block";
  }

  _btn(target) {
    return target.closest(".dcb-btn");
  }
  _handleButton(el, baseAdjust) {
    // Shared click handling for both base DCB and popout. baseAdjust is +1
    // or -1 depending on left- vs right-click.
    if (!el || el.dataset.disabled) return;
    const id = el.dataset.id;
    const submenu = el.dataset.submenu;
    this.emit("click", { id, el });
    if (submenu) {
      // SHIFT/Aux replace; everything else pops out.
      if (POPOUT_SUBMENUS.has(submenu)) {
        this.popout = submenu;
        this.popoutAnchorId = id;
      } else if (submenu === "AUX" || submenu === "MAIN") {
        this.active = submenu;
        this.popout = null; this.popoutAnchorId = null;
      } else {
        this.active = submenu;
      }
      this.render();
      return;
    }
    if (el.dataset.map != null) { this.emit("mapToggle", +el.dataset.map); return; }
    if (el.dataset.wx)    { this.emit("wxToggle",   +el.dataset.wx);                   return; }
    if (el.dataset.brite) { this.emit("briteAdjust", el.dataset.brite, baseAdjust * 5); return; }
    if (el.dataset.csz)   { this.emit("cszAdjust",   el.dataset.csz,   baseAdjust);     return; }
    this.emit("numAdjust", id, baseAdjust);
  }
  _onClick(e) {
    const el = this._btn(e.target);
    this._handleButton(el, +1);
  }
  _onPopoutClick(e) {
    const el = this._btn(e.target);
    this._handleButton(el, +1);
  }
  _onPopoutRClick(e) {
    e.preventDefault();
    const el = this._btn(e.target);
    this._handleButton(el, -1);
  }
  _onPopoutWheel(e) {
    e.preventDefault();
    const el = this._btn(e.target);
    if (!el || el.dataset.disabled) return;
    const dir = e.deltaY < 0 ? +1 : -1;
    if (el.dataset.brite) { this.emit("briteAdjust", el.dataset.brite, dir * 5); return; }
    if (el.dataset.csz)   { this.emit("cszAdjust",   el.dataset.csz,   dir);     return; }
    this.emit("numAdjust", el.dataset.id, dir);
  }
  _onRClick(e) {
    e.preventDefault();
    const el = this._btn(e.target);
    this._handleButton(el, -1);
  }
  _onWheel(e) {
    const el = this._btn(e.target);
    if (!el || el.dataset.disabled) return;
    e.preventDefault();
    const dir = e.deltaY < 0 ? +1 : -1;
    if (el.dataset.brite) { this.emit("briteAdjust", el.dataset.brite, dir * 5); return; }
    if (el.dataset.csz)   { this.emit("cszAdjust",   el.dataset.csz,   dir);     return; }
    this.emit("numAdjust", el.dataset.id, dir);
  }
}

window.DCB = DCB;
