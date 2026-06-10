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
  const list = [
    btn("RANGE", `RANGE\n${p.Range}`),
    btn("PLACE_CNTR", "PLACE\nCNTR"),
    btn("OFF_CNTR", "OFF\nCNTR"),
    btn("RR_NUM", `RR\n${p.RangeRingSpacing}`),
    btn("PLACE_RR", "PLACE\nRR"),
    btn("RR_CNTR", "RR\nCNTR", { active: p.RangeRingsCentered }),
    btn("MAPS", "MAPS", { submenu: "MAPS" }),
  ];
  // 6 inline MAP toggles bound to mapButtonAssignments[0..5] → starsId
  for (let i = 0; i < 6; i++) {
    const m = state.dcbMapAt(i);
    list.push(btn(`MAP_${i}`, `MAP\n${i + 1}`, {
      active: !!(m && m.visible),
      half: true,    // RadarWindow.cs:3553 → Height = 40 (half)
      mapIdx: i,
    }));
  }
  // 6 WX level toggles (Phase 10 fills these)
  for (let i = 0; i < 6; i++) {
    list.push(btn(`WX_${i + 1}`, `WX${i + 1}`, {
      active: !!state.wxLevels[i], wx: i + 1, narrow: true,
    }));
  }
  list.push(btn("BRITE", "BRITE", { submenu: "BRITE" }));
  list.push(btn("LDR_DIR", `LDR DIR\n${ldrDirName(p.OwnedDataBlockPosition)}`));
  list.push(btn("LDR_LEN", `LDR\n${p.LeaderLength}`));
  list.push(btn("CHAR_SIZE", "CHAR SIZE", { disabled: true }));
  list.push(btn("MODE", "MODE\nFSL", { disabled: true }));
  list.push(btn("SITE", "SITE", { submenu: "SITE" }));
  list.push(btn("SHIFT", "SHIFT", { submenu: "AUX" }));
  return list;
}

function auxMenu(state) {
  const p = state.prefSet;
  const list = [
    btn("VOL", "VOL\nN/A", { disabled: true }),
    btn("HIST_NUM", `HISTORY\n${p.HistoryNum}`),
    btn("HIST_RATE", `H RATE\n${p.HistoryRate.toFixed(1)}`),
    btn("CURSOR_HOME", "CURSOR\nHOME", { disabled: true }),
    btn("CURSOR_SPEED", "CURSOR\nSPEED", { disabled: true }),
    btn("MAP_UNCOR", "MAP\nUNCOR", { disabled: true }),
    btn("UNCOR", "UNCOR", { disabled: true }),
    btn("BEACON_MODE", "BEACON\nMODE-2", { disabled: true }),
    btn("RTQC", "RTQC", { disabled: true }),
    btn("MCP", "MCP", { disabled: true }),
    btn("DCB_TOP",    "DCB\nTOP",    { active: p.DCBLocation === "Top",    half: true }),
    btn("DCB_LEFT",   "DCB\nLEFT",   { active: p.DCBLocation === "Left",   half: true }),
    btn("DCB_RIGHT",  "DCB\nRIGHT",  { active: p.DCBLocation === "Right",  half: true }),
    btn("DCB_BOTTOM", "DCB\nBOTTOM", { active: p.DCBLocation === "Bottom", half: true }),
    btn("PTL_LEN", `PTL\nLEN ${p.PTLLength}`),
    btn("PTL_OWN", "PTL OWN", { active: p.PTLOwn }),
    btn("PTL_ALL", "PTL ALL", { active: p.PTLAll }),
    btn("SHIFT", "SHIFT", { submenu: "MAIN" }),
  ];
  return list;
}

function briteMenu(state) {
  const b = state.prefSet.Brightness;
  // Per RadarWindow.cs:3957-3973. Order verbatim.
  const items = [
    ["DCB",     "DCB",     b.DCB],
    ["BKC",     "BKC",     b.Background],
    ["MPA",     "MPA",     b.VideoMapA],
    ["MPB",     "MPB",     b.VideoMapB],
    ["FDB",     "FDB",     b.DataBlock],     // (WPF uses FullDataBlocks; ours is unified Brightness.DataBlock)
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
    btn(`BRITE_${id}`, `${label} ${v}`, { brite: id }));
  list.push(btn("BRITE_DONE", "DONE", { submenu: "MAIN" }));
  return list;
}

function mapsMenu(state) {
  // MAPS submenu — contains MAP7..MAPN, DONE, CLR ALL. We list every videoMap
  // (more than 6) with starsId assigned.
  const list = [
    btn("MAPS_DONE", "DONE", { submenu: "MAIN" }),
    btn("MAPS_CLEAR", "CLR ALL"),
  ];
  // Each known video map gets a button (starsId or short name as label).
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

function siteMenu(state) {
  // RadarWindow.cs:3741+ — one button per ASR site (Phase 6 populates real
  // ASR list); plus MULTI and FUSED.
  const list = [
    btn("SITE_MULTI", "MULTI"),
    btn("SITE_FUSED", "FUSED", { active: true }),
    btn("SITE_DONE",  "DONE", { submenu: "MAIN" }),
  ];
  for (const s of state.asrSites) {
    list.push(btn(`SITE_${s.id}`, s.asrId || s.id.slice(0, 5)));
  }
  return list;
}

function ldrDirName(v) {
  return ["INV","NW","N","NE","W","","E","SW","S","SE"][v|0] || "N";
}

// ── Layout + render ─────────────────────────────────────────────────────────
class DCB {
  constructor(rootEl, state) {
    this.root = rootEl;
    this.state = state;
    this.active = "MAIN";
    this.handlers = {};
    rootEl.addEventListener("click", (e) => this._onClick(e));
    rootEl.addEventListener("contextmenu", (e) => this._onRClick(e));
    rootEl.addEventListener("wheel",     (e) => this._onWheel(e), { passive: false });
  }
  on(event, fn) { (this.handlers[event] ||= []).push(fn); }
  emit(event, ...args) { (this.handlers[event] || []).forEach(fn => fn(...args)); }

  buttons() {
    switch (this.active) {
      case "MAIN":  return mainMenu(this.state);
      case "AUX":   return auxMenu(this.state);
      case "BRITE": return briteMenu(this.state);
      case "MAPS":  return mapsMenu(this.state);
      case "SITE":  return siteMenu(this.state);
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
    Object.assign(this.root.style, {
      position: "fixed",
      background: dcbAdjust(DCB_COLOR.FRAME_BG, p.Brightness.DCB),
      pointerEvents: "auto",
      userSelect: "none",
      fontFamily: "ui-monospace, monospace",
      display: "flex",
      gap: "0",
      padding: "1px",
      zIndex: 20,
      alignContent: "flex-start",
      ...(vertical
          ? { top: 0, bottom: 0, width: sizeAxis + "px",
              [loc === "Left" ? "left" : "right"]: 0,
              flexFlow: "row wrap", overflowY: "auto" }
          : { left: 0, right: 0, height: sizeAxis + "px",
              [loc === "Top" ? "top" : "bottom"]: 0,
              flexFlow: "column wrap", overflowX: "auto" }),
    });

    const halfAxis = sizeAxis / 2;   // 40
    const html = this.buttons().map(b => {
      // For horizontal: height = full bar (80) or half (40); width is fixed.
      // For vertical:   width  = full bar (80) or half (40); height is fixed.
      let w, h;
      if (vertical) {
        h = b.narrow ? halfAxis - 2 : sizeAxis - 2;     // tall axis
        w = (b.half ? halfAxis : sizeAxis) - 2;          // wraps to share a row
      } else {
        w = b.narrow ? halfAxis - 2 : sizeAxis - 2;     // long axis
        h = (b.half ? halfAxis : sizeAxis) - 2;          // wraps to stack
      }
      const bg = b.disabled ? DCB_COLOR.DISABLED_BG
                : b.active   ? DCB_COLOR.ACTIVE_BG
                             : DCB_COLOR.INACTIVE_BG;
      const fg = b.disabled ? DCB_COLOR.TEXT_DISABLED : DCB_COLOR.TEXT;
      return `<div class="dcb-btn" data-id="${b.id}"
        ${b.mapIdx != null ? `data-map="${b.mapIdx}"` : ""}
        ${b.brite ? `data-brite="${b.brite}"` : ""}
        ${b.wx ? `data-wx="${b.wx}"` : ""}
        ${b.submenu ? `data-submenu="${b.submenu}"` : ""}
        ${b.disabled ? `data-disabled="1"` : ""}
        style="
          width:${w}px; height:${h}px;
          margin:1px;
          background:${dcbAdjust(bg, p.Brightness.DCB)};
          color:${fg};
          border:1px solid ${DCB_COLOR.BORDER};
          display:flex; align-items:center; justify-content:center;
          text-align:center; line-height:1.05; font-size:11px;
          white-space:pre; cursor:${b.disabled ? "default" : "pointer"};
          flex:none; box-sizing:border-box;
        ">${b.text}</div>`;
    }).join("");
    this.root.innerHTML = html;
  }

  _btn(target) {
    return target.closest(".dcb-btn");
  }
  _onClick(e) {
    const el = this._btn(e.target);
    if (!el || el.dataset.disabled) return;
    const id = el.dataset.id;
    const submenu = el.dataset.submenu;
    this.emit("click", { id, el, e });
    // Built-in: submenu navigation
    if (submenu) { this.active = submenu; this.render(); return; }
    // Built-in: MAP toggle
    if (el.dataset.map != null) { this.emit("mapToggle", +el.dataset.map); return; }
    // Built-in: BRITE adjust (left-click = +10 step)
    if (el.dataset.brite) { this.emit("briteAdjust", el.dataset.brite, +10); return; }
    // Built-in: numeric cycle for RANGE, RR, LDR LEN, HISTORY, PTL_LEN
    this.emit("numAdjust", id, +1);
  }
  _onRClick(e) {
    e.preventDefault();
    const el = this._btn(e.target);
    if (!el || el.dataset.disabled) return;
    const id = el.dataset.id;
    if (el.dataset.brite) { this.emit("briteAdjust", el.dataset.brite, -10); return; }
    this.emit("numAdjust", id, -1);
  }
  _onWheel(e) {
    const el = this._btn(e.target);
    if (!el || el.dataset.disabled) return;
    e.preventDefault();
    const dir = e.deltaY < 0 ? +1 : -1;
    if (el.dataset.brite) { this.emit("briteAdjust", el.dataset.brite, dir * 10); return; }
    this.emit("numAdjust", el.dataset.id, dir);
  }
}

window.DCB = DCB;
