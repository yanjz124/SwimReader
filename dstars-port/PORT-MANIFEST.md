# Port manifest — DGScope `scope/scope/` → `dstars-port/src/`

Status: ⬜ todo · 🟡 in progress · ✅ ported · ⏸️ deferred (needs adaptation ruling)

Ordered roughly bottom-up (leaf data/enums first, `RadarWindow.cs` last).

| Status | Lines | File |
|--------|------:|------|
| ✅ | 23 | STARS/LeaderDirection.cs |
| ✅ | 23 | STARS/TCP.cs |
| ✅ | 69 | STARS/ClockPhase.cs |
| ✅ | 19 | ATPATcpDisplay.cs |
| ✅ | 27 | ITWSRadarSiteStringConverter.cs — TypeConverter stub; GetStandardValues→NexradDisplay.Sensors |
| ✅ | 36 | VideoMapFile.cs |
| ✅ | 38 | ScratchpadFilter.cs |
| ✅ | 40 | Line.cs |
| ✅ | 43 | RangeBearingLine.cs |
| ✅ | 43 | ReceiverCollectionEditor.cs — WinForms CollectionEditor stub (DLL reflection not possible) |
| ✅ | 44 | MapImporter/CRC/CRCFacilityPicker.cs — config dialog stub (ShowDialog→Cancel; PickedFacility) |
| ✅ | 49 | VideoMap.cs |
| ✅ | 50 | InputBox.cs — Input.InputBox → window.prompt; ref string→{value} |
| ✅ | 51 | CustomLists.cs — ListOfIReceiver (extends Array); best-effort XML; Type.GetType reflection noted as limitation |
| ✅ | 51 | TPARing.cs |
| ✅ | 57 | TimeSync.cs — NTP not possible in browser → Resync no-op, CurrentTime()=system clock |
| ✅ | 58 | ADSBBeaconReader/ADSBv2Response.cs |
| ✅ | 58 | LeaderLine.cs |
| ✅ | 58 | MSAWVolume.cs |
| ✅ | 59 | ATPAVolumeSelector.Designer.cs — WinForms layout — subsumed |
| ✅ | 59 | VideoMapSelector.Designer.cs — WinForms layout — subsumed |
| ✅ | 64 | VideoMapList.cs — extends Array; equality-aware Add dedup (VideoMap.equals); GeoJSON serialize; file IO→fetch |
| ✅ | 67 | PropertyForm.Designer.cs — WinForms layout — subsumed |
| ✅ | 70 | ADSBBeaconReader/ADSBBeaconReaderSettings.cs |
| ✅ | 72 | CASuppressionVolume.cs |
| ✅ | 72 | MapImporter/CRC/CRCFacilityPicker.Designer.cs — WinForms layout — subsumed into stub |
| ✅ | 72 | RuntimeServiceProvider.cs — IServiceProvider/ITypeDescriptorContext stub |
| ✅ | 72 | StarsSounds.cs — HTMLAudioElement (loop/play/pause); .wav assets at Sounds/*.wav; ref bool→holder |
| ✅ | 75 | SerializableDictionary.cs — Map subclass; Read/WriteXml implemented (best-effort string XML) |
| ✅ | 81 | VideoMapSelector.cs — config dialog + editor stub |
| ✅ | 83 | FAAMapDATFileParser.cs |
| ✅ | 83 | Waypoints.cs |
| ✅ | 88 | BeaconCodeRange.cs |
| ✅ | 91 | MSAWImporter.cs |
| ✅ | 91 | ReadWriteBuffer.cs |
| ✅ | 92 | MapImporter/CRC/CRCMapImporter.cs — CRCARTCCFileToMaps async; JsonConvert→JSON.parse, path ops, picker stubbed, GeoJSONFileToMaps awaited |
| ✅ | 99 | ADSBBeaconReader/ADSBBeaconReaderForm.cs — ADS-B sources dialog stub |
| ✅ | 102 | MinSep.cs |
| ✅ | 103 | DCB.cs — full DCB class + DCBLocation enum (GL shim; Draw validated in test/dcb.test.js) |
| ✅ | 104 | ATPA.cs — threading adapted (Promise.all); CWT table + ATPAStatus |
| ✅ | 116 | ATPAVolumeSelector.cs — config dialog + UITypeEditors stub |
| ✅ | 116 | Receivers.cs |
| ✅ | 119 | MSAW.cs |
| ✅ | 133 | ConflictAlertSystem.cs |
| ✅ | 144 | MapImporter/VRC/VRCFileParser.cs |
| ✅ | 144 | PropertyForm.cs — settings property-grid dialog stub |
| ✅ | 147 | ADSBBeaconReader/ADSBBeaconReaderForm.Designer.cs — WinForms layout — subsumed |
| ✅ | 148 | Altitude.cs |
| ✅ | 174 | STARS/TargetExtentSymbols.cs |
| ✅ | 174 | WeatherService.cs — full (METAR altimeter avg); WebClient→fetch; csharp_metar_decoder via _shims/MetarDecoder.js stub |
| ✅ | 180 | STARS/PrefSet.cs |
| ✅ | 193 | DCBMenu.cs — DCBMenu + DCBMenuItem (GL shim) |
| ✅ | 202 | GeoPoint.cs |
| ✅ | 210 | Program.cs — WinForms desktop entry point stub (browser bootstraps RadarWindow separately); helpers adapted |
| ✅ | 211 | ATPAVolume.cs |
| ✅ | 215 | VideoMapForm.Designer.cs — WinForms layout — subsumed |
| ✅ | 232 | Radar.cs |
| ✅ | 234 | PrimaryReturn.cs — standalone target return (was :Control); GDI line→canvas, Stopwatch fade |
| ✅ | 257 | XmlSerializer.cs — best-effort generic XML (reflection has no JS analog): DOMParser read + recursive write; file-write→download |
| ✅ | 298 | AirportsXml.cs |
| ✅ | 306 | NexradDisplay.cs — NexradDisplay + Polygon + ScopeServerWxRadarReport; WebClient→fetch, Timer→setInterval; + WXColorTable.js (from NexradDecoder, namespace DGScope); NWS binary decode via _shims/NexradDecoder.js stub |
| ✅ | 341 | VideoMapForm.cs — video-map manager dialog + editor stub |
| ✅ | 361 | DCBButton.cs — DCBButton + Toggle/Adjustment/Submenu/Action/Radio (GL shim, GDI text→texture) |
| ✅ | 376 | MapImporter/CRC/CRCARTCC.cs |
| ✅ | 423 | TransparentLabel.cs — standalone canvas text label (was :Control); GDI text→canvas, flash timer→setInterval |
| ✅ | 487 | ADSBBeaconReader/ADSBBeaconReaderService.cs — ADSB poll+correlate; WebClient→fetch, JsonConvert→JSON.parse, Timer→setInterval, Thread.Sleep→await |
| ✅ | 520 | Metars.cs — ADDS XML METAR response DTOs (XSD-generated; fields flattened) |
| ✅ | 719 | MapGeoJSON.cs — GeoJSONMapExporter; BAMCIS.GeoJSON→_shims/GeoJSON.js, JObject fixups→plain JSON; round-trip verified |
| ✅ | 1086 | Aircraft.cs — FULLY ported (logic + RedrawDataBlock/OldRedrawDataBlock/RedrawTarget + real PrimaryReturn/TransparentLabel fields); FDB/LDB validated in test/aircraft.test.js |
| ⬜ | 6962 | RadarWindow.cs |

**Progress:** 72/73 files ported. 47 tests pass. **ONLY `RadarWindow.cs` (6962) REMAINS** — the main GL render loop, ported in ~300–500-line chunks against the tested GL shim.
**RadarWindow.cs port progress: lines 5212 / 6962** (+ GeoToScreenPoint, GeoToPixel, ScreenToGeoPoint [PointF+Point overloads merged via Point/PointF dispatch; dead code kept 1:1], DrawCompass [bezel + tick marks + 36 bearing labels], DrawATPAVolumes, DrawMSAWVolumes, DrawMSAWVolumeOutline; + #cmp_labels/#cmp_ar). Shims: Matrix4.Column0-3, Vector4.Length, Color.Aqua; import Line.

Prior: **lines 4985** (+ ProcessMouse [.wip splice], CenterMouse). Shim: GameWindow.Bounds.

Prior: **lines 4371** (+ Window_RenderFrame — main render loop). Shims: Mouse.GetState, Vector4 Sub/Add/scaleEq/addEq, Matrix4.Inverted (test-verified), SwapBuffers, MathHelper, Font.Height.

Prior: **lines 4259** (+ Dcb*Click handlers, ReleaseDCBButton, UpdateDCB, render-matrix fields).

Prior: **lines 4131** (+ DcbLdrDirButton_Down/Up, DcbSubmenuButtonClick, DcbButtonClick, SiteButton_Click). Shim: GameWindow.PointToScreen.

Prior: **lines 3939** (+ ~60 DCB button/menu field decls, TCP property, SetupDCB).

Prior: **lines 3740** (+ Window_KeyPress/KeyDown/KeyUp, Window_Resize, Window_UpdateFrame). #showAllCallsigns + #centeredmouse (early; C# @4368). Shims: WinForms.SaveFileDialog, GameWindow.Width/Height.
**IMPORTANT Key-shim correction:** `Key` is now the OpenTK 3.x **integer** enum (not Symbols) because Window_KeyDown does ordered comparisons (`e.Key >= Key.A && e.Key <= Key.Z`, `(int)e.Key > 9`). Chars stay 1-char strings, so `GetType()==typeof(char)` → `typeof x==="string"` still holds; KeyToChar/#previewMap are now number-keyed and (faithfully) conflate KeyCode with the F-keys via shared integers, matching C#'s `(int)` cast.

Prior: **lines 3540** (+ DisplayPreviewMessage, RenderStatus, LACAMCIId, RenderLACAMCIList, ToFilterAltitudeString, GeneratePreviewString [+2 tests]).

Prior: **lines 3160** (+ ProcessImpliedCommand, KeysToString [+4 tests], RenderPreview). Key shim: letter/number/period/plus Symbols + KeyToChar map.

Prior: **lines 2879** — `ProcessCommand` (source 1548-2879, the full ~1332-line command switch) spliced into the class whole. Covers leader-direction slews, SPC/alert tags, `*` splat (RBL/TPA), `.`/`+` scratchpads, `F7` multifunction (ATPA/2.5, beacons, filters, leader lines, MSAW, quicklook, ATIS text, scratchpads), range rings, WX levels, recenter, min-sep, and default scratchpad/type/handoff entry. Key shim gained function-key + End/KeypadMultiply Symbols (char=string vs named-key=Symbol contract → `GetType()==typeof(char)` becomes `typeof x==="string"`).
Shims added this chunk: OpenTK input (`Keyboard`/`Key`/`Mouse`/`ButtonState` + `CursorVisible`), `WinForms.Clipboard` (navigator.clipboard, async→fire-and-forget), `_shims/System.js` (`Environment.Exit`). Cursor-warp `Mouse.SetPosition` is a no-op (browser can't warp the OS cursor); GetType()==typeof(X) → constructor === X (exact-type, matches C#).
Shims: `_shims/Collections.js` (ObservableCollection + NotifyCollectionChanged*), `_shims/Threading.js` (Timer/TimerCallback + Task), `_shims/Crypto.js` (sync MD5, RFC-1321, test-verified). GameWindow shim: OpenTK window events + Title + Run().
Adaptation: the 4 per-aircraft event handlers (HandedOff/HandoffInitiated/Transferred/OwnershipChange) are arrow class fields, not methods — stable per-instance refs so C#'s `+=`/`-=` method-group symmetry survives.