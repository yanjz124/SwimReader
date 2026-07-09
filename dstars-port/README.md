# dstars-port — faithful 1:1 transliteration of DGScope to browser JS

**Goal:** reproduce DGScope *exactly*. This is a mechanical transliteration, not a
paraphrase or reimplementation. No creative liberties. Every DGScope class, method,
field, and branch is reproduced in order.

## Layout
- `_source/` — read-only copy of DGScope's `scope/scope/` main project (C# reference). Do not edit.
- `src/` — the JS port. Folder structure mirrors `_source/` exactly (`src/STARS/TCP.js` ↔ `_source/STARS/TCP.cs`).
- `PORT-MANIFEST.md` — per-file port status. Update after each file.

## Fixed transliteration conventions (approved)
1. One `.js` per `.cs`, mirroring folders. ES modules (`export class`, `import`).
2. `using` directives dropped; cross-file types brought in via `import`.
3. `namespace` dropped (module = namespace).
4. C# constructs with no JS equivalent are **preserved as trailing comments** (max fidelity):
   attributes (`[Serializable]`, `[TypeConverter]`, `[JsonObject]`, `[XmlIgnore]`, `[Browsable]`…),
   and type annotations (`// string`, `// int[]`).
5. Enums → `Object.freeze({ NAME: value, … })` preserving exact underlying integers.
6. Auto-property `{ get; set; }` → plain class field. Property with a body → JS `get`/`set`.
7. `override ToString()` → `toString()`.
8. `System.Threading.Timer` → `setTimeout` re-arm shim (commented as such).

## Adaptation protocol
When a **new kind** of forced adaptation appears (something not covered by the rules
above — e.g. GL rendering, WinForms controls/layout, file I/O, XML serialization,
threading models), STOP and ask the user before writing it. Record the ruling here and
in the manifest so it becomes a fixed rule.

## Adaptation rulings log
_(append as decisions are made)_
- **System.Drawing value types** (PointF/SizeF/RectangleF/… — used in 19 files) → `src/_shims/SystemDrawing.js`, reproducing the .NET struct members 1:1 (X/Y, Width/Height). Members added only as referenced.
- **`out` parameters** (`bool TryParse(s, out T x)`) → pass a holder object `const x = {}`; the method sets `x.value` and still returns the bool. Call sites: `const x = {}; if (T.TryParse(s, x)) { … x.value … }`. Keeps boolean control flow identical.
- **Object initializers** (`new T(){ P = v }`) → `Object.assign(new T(), { P: v })`.
- **Constructor overloads** (C# allows many; JS one) → single constructor with default params reproducing all overloads.
- **WinForms designer infra** (`TypeConverter`/`StringConverter`/`UITypeEditor` subclasses, `*.Designer.cs`, Form classes) → ⏸️ DEFERRED, batched for one consolidated UI-mapping ruling. First deferred: `ITWSRadarSiteStringConverter.cs`.
- **`GetHashCode`/`Equals` overrides** → `getHashCode()` / `equals(obj)` methods. (`obj as T` → `obj instanceof T ? obj : null`.)
- **`abstract` class / member** → plain base class; abstract member implemented as one that `throw new Error("abstract")`; subclasses override.
- **`decimal`** → JS `number`.
- **`interface`** (e.g. `IScreenObject`) → duck-typed; interface noted in a comment, no runtime construct.
- **Class declaration order** — JS evaluates `extends` at load, so a base class must be declared before its subclasses (C# is order-independent). Reorder within a file when needed and note it.
- **`{ get; private set; }`** → plain public field (JS has no property-level access modifier without a backing field). Private-set enforcement dropped; runtime behavior identical. (`{ get; set; }` with a `private`/`readonly` backing field that has real logic still uses `#field` + `get`/`set`.)
- **`Convert.ToString(x, 8)` / `Convert.ToInt32(s, 8)`** (octal) → `x.toString(8)` / `parseInt(s, 8)`. `PadLeft(n,'0')` → `padStart(n,'0')`. `Regex.Match(s, "...")` → `s.match(/.../)` (`.Success` → non-null, `.Value` → `m[0]`).
- **`double.TryParse`/`int.TryParse`** → `tryParseDouble`/`tryParseInt` in `_shims/Primitives.js`, out-holder convention. `(int)x` cast → `Math.trunc(x)`. `.ToString("D3")` → `.toString().padStart(3,'0')`. `string.IsNullOrEmpty(s)` → `s == null || s === ""`. `.Contains(c)`/`.Substring(i)` → `.includes(c)`/`.substring(i)`.
- **`lock(obj){ … }`** → body runs directly (JS is single-threaded); the lock-object field is dropped, the `lock` noted in a comment.
- **Unicode identifiers** (`λ`, `φ`, `θ`, `Δφ` in geodesy math) → kept verbatim (valid JS identifiers) for maximum fidelity.
- **`Dictionary<K,V>`** → JS `Map`. `.ContainsKey`→`.has`, `dict[k]`→`.get(k)`/`.set(k,v)`, `.Add(k,v)`→`.set(k,v)`.
- **`List<T>` / `ObservableCollection<T>`** → JS `Array`. `.Add`→`.push`, `.ToList()`/`.ToArray()`→`[...x]`/`x.filter(...)`, `.Remove(x)`→`splice(indexOf)`, `.Count`→`.length`.
- **LINQ** → array methods: `from x in c where p select x` → `c.filter(x=>p)`; `.FirstOrDefault()` → `c.find(...)  ?? null` (or `[0] ?? null`); `.Where(...).Count()` → `.filter(...).length`; `.ForEach` → `.forEach`.
- **`Task` / `async Task`** → `async`; **`Task.WaitAll(tasks)`** → `await Promise.all(tasks)`; **`Task.Run(f)`** → `f()` (returns a promise). `Thread.Sleep(n)` in a sync method → no-op (browser can't block synchronously), noted in a comment.
- **`DateTime`** → JS `Date`; **`DateTime.MinValue`** → `new Date(-8640000000000000)` (JS min date, used as a "never" sentinel); **`TimeSpan.Ticks`** (100 ns units) → `date.getTime() * 10000` (ms → ticks) so tick-based arithmetic stays identical.
- **Method overloads distinguished by parameter type** (e.g. `GetPlane(Guid,...)` vs `GetPlane(int,...)`) → one JS method dispatching on `typeof`/`instanceof`.
- **`base.ToString()`** (implicit `object`) → `Object.prototype.toString.call(this)` (minor: yields `[object Object]` rather than the CLR type name).
- **`HashSet<T>`** → JS `Set`. `.Add(x)` returns bool (false if present) → emulate with `.has(x) ? …skip… : .add(x)`. `StringComparer.OrdinalIgnoreCase` → key on `x.toLowerCase()`.
- **`List<T>.Clear()`** → `arr.length = 0`; `.Insert(0,x)` → `unshift`; `.Any(p)` → `.some(p)`; `.Contains(x)` → `.includes(x)`; `.RemoveAt(i)` → `splice(i,1)`.
- **`ReferenceEquals(a,b)`** → `a === b` (objects compare by reference in JS).
- **C# indexer `this[i]`** → a method (e.g. `Item(i)`) — JS classes have no user indexer.
- **`IEnumerable<T>` property with `yield return`** → a getter returning a generator iterator (`get X(){ return (function*(){…})(); }`); iterator method form → `*X()`.
- **`byte[]`** → `Uint8Array`; **`Array.Copy(src,si,dst,di,n)`** → `dst.set(src.subarray(si,si+n), di)`.
- **`MathHelper.DegreesToRadians(x)`** (OpenTK) → `x * Math.PI / 180`.
- **`OrderBy(k)`** → `.sort((a,b) => k(a) - k(b))` (stable in modern engines, matches OrderBy).
- **`Dictionary.TryGetValue(k, out v)`** → a `TryGetValue(k, outHolder)` method on the `Map` subclass: sets `outHolder.value`, returns bool.
- **Nullable `T?` `.HasValue`/`.Value`** → `x != null` / `x` (JS values are already nullable).
- **`Dictionary<K,V>` subclass** (`SerializableDictionary`) → `extends Map`; `.Add`→`.set` (via an `Add` method), `.TryGetValue` method, indexer→`.get`/`.set`. Comparer/capacity ctor overloads ignored.
- **C# nested classes** → module-level classes (JS has no true member classes); original nesting noted in a comment. Referenced by simple name.
- **Partial port of an enum out of a deferred file** — when a small enum (e.g. `DCBLocation`) lives in a GL/UI file, the enum is ported into that file's `.js` now and the class body left as a deferred comment, so already-ported files can import it.
- **`System.Media.SoundPlayer` + embedded `.wav` resources** → DEFERRED (audio bucket): maps to `HTMLAudioElement` (`loop`/`play`/`pause`) but needs an asset-delivery decision; `ref bool` params also need restructuring.
- **`System.Xml.Linq.XDocument`** (parsing, not serialization) → browser `DOMParser` (`parseFromString(...,"application/xml")`, check for a `parsererror` element instead of a thrown `XmlException`). `.Descendants(n)`→`getElementsByTagName(n)`, `.Element(n)`→`[...el.children].find(...)`, `.Attribute(n)`→`getAttribute(n)`.
- **`File.ReadAllText(path)` / `StreamReader`** → `await (await fetch(path)).text()`, or the caller supplies the text (browser can't sync-read local paths). Line iteration → `text.split(/\r?\n/)`.
- **`DateTime.Now`** → `new Date()` (`.ToShortDateString/TimeString` → `toLocaleDateString/TimeString`).
- **`Substring(start,len)`** → `substring(start, start+len)`; **`.Split()`** (no-arg, whitespace) → `.split(/\s+/)`; **`string.Format`** → template literal.
- **C# `event EventHandler<T>`** (+ `?.Invoke`, `+=`/`-=`) → `EventHandler` shim in `_shims/DotNetEvent.js`: each event is a field `= new EventHandler()`; `X?.Invoke(s,a)` → `this.X.Invoke(s,a)` (no-ops when empty); `obj.X += h` → `obj.X.add(h)`. `System.EventArgs` → shim class; `new EventArgs()` unchanged.
- **`Guid`** → string; **`Guid.NewGuid()`** → `crypto.randomUUID()`; **`Guid.Empty`** → `"00000000-0000-0000-0000-000000000000"`.
- **C# collection initializer** (`new Dict { {k,v}, … }`) → constructor with entries (`new SerializableDictionary([[k,v],…])`) or repeated `.Add`.
- **`TimeSpan.TotalSeconds`/`.TotalHours`** → `ms/1000` / `ms/3600000` (date subtraction gives ms). `(int)(…).TotalSeconds` → `Math.trunc(ms/1000)`.
- **`Console.WriteLine("{0}…{1}", a, b)`** → `console.log(\`…${a}…${b}\`)`.
- **`Array.Initialize()`** on a reference-type array → no-op (only meaningful for value-type arrays in C#).
- **Stubbing rendering** (Aircraft): WinForms-typed fields (`PrimaryReturn`/`TransparentLabel`) → `null` with a deferred comment; methods that drive them (`RedrawDataBlock`/`RedrawTarget`/`Dispose`) → `throw` a "rendering deferred" error until the GL/UI ruling lands.
- **DEFERRED buckets needing a ruling before their files can be ported:**
  - XML serialization / reflection (`IXmlSerializable`, `XmlSerializer`, `Type.GetType`) — `CustomLists.cs`, `XmlSerializer.cs`, `SerializableDictionary.cs`, and receiver (de)serialization.
  - Network/threading services (`NtpClient`, `HttpClient`, `Stopwatch`, `Task`/`Thread`) — `TimeSync.cs`, `WeatherService.cs`, `Metars.cs`, `ADSBBeaconReaderService.cs`.
  - WinForms UI (Forms, `*.Designer.cs`, controls `TransparentLabel`/`DCBButton`, `TypeConverter`/`UITypeEditor`) — many files.
- **OpenTK/OpenGL rendering** → RULED: **Option C — immediate-mode GL emulation shim** (see `GL-RENDERING-OPTIONS.md`).
  - `_shims/OpenTK.js` — `Matrix4`/`Vector4` reproducing OpenTK's row-major, row-vector (`v'=v*M`) semantics.
  - `_shims/GL.js` — static `GL.*` immediate-mode API on Canvas 2D. Pipeline: `Vertex2` → `v * modelview * projection` → NDC → viewport→pixels; matrix ops **pre-multiply** (`newOp * modelview`). Validated in `test/gl-math.test.js` + `test/gl-context.test.js` against DCB's exact transform.
  - `_shims/SystemDrawing.js` gained `Color` (ARGB, `FromArgb` overloads, named colors, `toCanvasRgba`).
  - Textures (NEXRAD/history) are a first-cut axis-aligned `drawImage`; `PolygonStipple` is a no-op — both flagged in `GL.js` to refine when those files are ported.
  - Rendering files now port the same mechanical way: `GL.Begin/Vertex2/End` transliterate verbatim.
- **System.Drawing `Point`/`Size`/`Rectangle`/`Font`** → added to `_shims/SystemDrawing.js` (Rectangle overloads `(x,y,w,h)`/`(Point,Size)`, `Contains` half-open; Font `toCanvasFont()`, points≈px for now).
- **C# `new` member hiding** (`public new bool X`) → override the member in the subclass; when the hider needs the base value, make the base member a `#backing` + `get`/`set` so the subclass can use `super.X`. Get-only hiders become a getter with no setter.
- **Pulling static helpers out of a deferred file** — e.g. `RadarWindow.AdjustedColor` is ported into the `RadarWindow.js` stub now because DCB/DCBMenu/etc. call it; the rest of RadarWindow stays deferred.
- **GDI text→GL texture** (`Bitmap` + `Graphics.DrawString` → `LockBits`/`Scan0` → `GL.TexImage2D`) → render to an `OffscreenCanvas` with `fillText`, then hand the canvas straight to `GL.TexImage2D` (shim accepts a canvas). `StringFormat`/`StringAlignment` (Center/Center) → canvas `textAlign`/`textBaseline`. Requires a browser/OffscreenCanvas at runtime (not Node); import-safe (only used inside draw methods).
- **`System.Windows.Forms.Cursor.Clip`** → `_shims/WinForms.js` `Cursor` no-op (browser can't confine the OS cursor; value retained).
- **GL texture-filter enums** (`TextureMagFilter`/`MinFilter`/`TextureWrapMode`) added to `_shims/GL.js` (no-ops; canvas handles smoothing).
- **`: System.Windows.Forms.Control` subclasses** (TransparentLabel) → ported STANDALONE: the Control members actually used (`ForeColor`/`Font`/`Text`/`Size`/`Width`/`Height`/`Padding`/`RightToLeft`/`AutoSize`) become own fields/accessors; window-specific bits (`SetStyle`/`CreateParams`/`CreateGraphics`/`TabStop`/`OnPaint*`/`Dispose`) stubbed.
- **`Graphics.MeasureString`** → `OffscreenCanvas` `measureText` (width; height from `actualBoundingBox…` or `Size*1.3`). **`Graphics.DrawString`** → `fillText`; **`GraphicsPath.AddString` + `DrawPath` outline** → `strokeText` (black) then `fillText` (white). Screen DPI → 96.
- **`System.Timers.Timer`** → `setInterval` (with `.unref()` in Node so tests don't hang).
- **Color struct value-equality** (`base.ForeColor == value`) → compare `.ToArgb()` (JS objects are reference-equal otherwise).
- **`ContentAlignment`** (SystemDrawing), **`Padding`** (SystemDrawing), **`RightToLeft`** (WinForms) enums/classes added as referenced.
- **`System.Diagnostics.Stopwatch`** → `_shims/Diagnostics.js` (`performance.now()`/`Date.now()`; `Elapsed` returns a TimeSpan-like `{TotalSeconds,TotalMilliseconds,Ticks}`).
- **WinForms `Control.Parent`-relative positioning** (PrimaryReturn) → `Parent` stays `null` in the browser (RadarWindow composites returns via GL/`TargetImage`, not WinForms child layout), so the `if (Parent != null)` positioning branches are inert — faithful and correct for the GL path.
- **`str + null` concatenation** — C# treats null as "" in `"x" + null`; JS yields `"xnull"`. Coalesce with `?? ""` where a possibly-null string is concatenated (e.g. `" " + (Category ?? "")` in Aircraft.OldRedrawDataBlock).
- **`PadLeft(n[,'0'])`/`PadRight(n)`** → `padStart(n[,'0'])`/`padEnd(n)`; **`ToString("D3")`/`("D2")`** → `Math.trunc(x).toString().padStart(3|2,'0')`; **`ToString("0.00")`** → `toFixed(2)`. NOTE (faithful quirk): `Aircraft.RedrawDataBlock` builds `altstring` from the *previous* frame's `dbAlt` then refreshes it — a one-frame altitude lag reproduced exactly (see test).
- **`System.Numerics.Vector2`** → `_shims/OpenTK.js` `Vector2 {X,Y}`. **`WebClient.OpenRead`** → `await fetch(url)` → `arrayBuffer()`. **`System.Threading.Timer`** (dueTime/period) → `setInterval` (with an immediate first fire for dueTime 0; `.unref()` in Node).
- **External library outside the 73-file scope** (NexradDecoder's binary `RadialPacketDecoder`) → `_shims/NexradDecoder.js` stub (NWS binary path deferred; the default ScopeServer weather path works). `WXColor`/`WXColorTable` are `namespace DGScope`, so ported for real as `src/WXColorTable.js`.
- **`ref bool[]`** where the method only mutates elements (not reassigns) → plain array param (JS arrays are reference types; element writes are visible to the caller).
- **`WebClient.DownloadString`** → `await (await fetch(url)).text()`. **`Task.Run(() => f())`** fire-and-forget → call `f()` without awaiting (returns a promise). **`Regex.Split(s, "\r\n|\r|\n")`** → `s.split(/\r\n|\r|\n/)`.
- **External `csharp_metar_decoder`** (outside 73-file scope) → `_shims/MetarDecoder.js` stub (`DecodedMetar`/`MetarDecoder.ParseWithMode` return invalid → filtered; WeatherService degrades to 29.92). The main-project `Metars.cs` parses METARs for real.
- **NTP (`Yort.Ntp`)** — impossible in a browser (UDP) → `TimeSync.Resync` no-op, `Synchronized=false`, `CurrentTime()` uses `new Date()` (system clock).
- **`JsonConvert.DeserializeObject<T>(json)`** (Newtonsoft) → `JSON.parse` + a mapper that reads `[JsonProperty("wire")]` names into the ported class fields (e.g. `deserializeADSBv2Response`).
- **`Func<T>` / `Action`** delegates → plain JS functions. **`Thread.Sleep(ms)`** in an async method → `await new Promise(r=>setTimeout(r,ms))`.
- **File logging** (`File.AppendAllText` to `LocalApplicationData`) → no-op (no browser filesystem). **`KeyValuePair<K,V>`** → `{ Key, Value }`. **`d.ToString("F6")`/`"F2"`** → `toFixed(6)`/`toFixed(2)`. **`BaseUrl.TrimEnd('/')`** → `replace(/\/+$/,"")`.
- **Reflection-based `System.Xml.Serialization.XmlSerializer<T>`** — NOT 1:1 portable (JS has no runtime type/attribute reflection). Implemented as a documented **best-effort** generic mapper (`XmlSerializer.js`): `Serialize` walks own properties → child elements (no `[XmlAttribute]`/rename support); `Deserialize` via `DOMParser`; file-read → `fetch`, file-write → returns XML for the caller to download. `SerializableDictionary.Read/WriteXml` similarly best-effort string XML. **`Type.GetType(AssemblyQualifiedName)`** (CustomLists receiver reconstruction) has no JS analog → deserializes to a plain object retaining `__type`; a real port needs a type registry.
- **`List<T>` subclass with IXmlSerializable** (`ListOfIReceiver`) → `extends Array`.
- **External `BAMCIS.GeoJSON`** (outside scope) → `_shims/GeoJSON.js` (the GeoJSON type hierarchy + `GeoJson.FromJson`/`ToJson` over plain JSON). **Newtonsoft `JObject`/`JArray`/`JToken`** fixups → plain `JSON.parse` objects/arrays (`token["x"]?.Value<string>()`→`token.x`, `as JArray`→`Array.isArray(x)?x:null`, `new JArray(seq.Where(p))`→`seq.filter(p)`, `JObject.ToString()`→`JSON.stringify`). Round-trip verified.
- **`List<T>` subclass** (`VideoMapList`) → `extends Array`; equality-aware `List.Contains` (uses `VideoMap.Equals` by `Number`) → `this.some(x=>x.equals(map))`. Array-species numeric-length constructor passed through so `map`/`filter`/`slice` keep working.
- **`System.Media.SoundPlayer` + embedded `.wav`** → `HTMLAudioElement` (`loop=true;play()` / `pause();currentTime=0`); resource name → `Sounds/*.wav` asset URL (assets must be served); `ref bool playing` → `{value}` holder; guarded `typeof Audio==="undefined"` so it's silent/import-safe in Node.
- **WinForms input dialog** (`Input.InputBox` Form) → `window.prompt`; `ref string` → `{value}`; returns `DialogResult`.
- **WinForms designer infra** (`TypeConverter`/`StringConverter`, `CollectionEditor`, `UITypeEditor`) → base dropped; methods kept but inert (no property grid in the browser). `Assembly.LoadFrom`/`GetTypes` DLL reflection has no browser analog → stubbed (would need a static class registry).
