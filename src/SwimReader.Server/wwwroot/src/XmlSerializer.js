// Ported from _source/XmlSerializer.cs  (generic helper `XmlSerializer<T>`)
//
// IMPORTANT ADAPTATION: .NET's System.Xml.Serialization.XmlSerializer is REFLECTION-driven —
// it walks a type's properties and honors [XmlElement]/[XmlAttribute]/[XmlRoot]/etc. JavaScript
// has no runtime type metadata or attribute reflection, so a faithful 1:1 reproduction is not
// possible. This is a documented BEST-EFFORT generic XML mapper:
//   • Serialize: own enumerable properties -> child elements (arrays -> repeated elements,
//     primitives -> text). It does NOT honor [XmlAttribute] (everything becomes an element) or
//     [Xml*] name overrides.
//   • Deserialize: DOMParser -> plain object graph (optionally assigned onto a `type` instance).
// For real config round-tripping, prefer JSON (see notes in README). API kept so call sites port.
//
// C# `XmlSerializer<T>.Method(...)` (static on a generic) -> `new XmlSerializer(T).Method(...)`.

export class XmlSerializer {
    #type;
    constructor(type) { this.#type = type; } // T

    // ---- Deserialize ----
    Deserialize(xml, encoding = undefined, settings = undefined) { // T Deserialize(string [,Encoding][,settings])
        if (xml == null || xml === "")
            throw new Error("XML cannot be null or empty"); // ArgumentException
        const doc = new DOMParser().parseFromString(xml, "application/xml");
        return XmlSerializer.#fromElement(doc.documentElement, this.#type);
    }
    static async DeserializeFromFile(filename, type, settings = undefined) { // File.Exists + XmlReader -> fetch
        if (filename == null || filename === "")
            throw new Error("XML filename cannot be null or empty");
        const xml = await (await fetch(filename)).text();
        return new XmlSerializer(type).Deserialize(xml);
    }

    // ---- Serialize ----
    Serialize(source, namespaces = undefined, settings = undefined) { // string Serialize(T [,namespaces][,settings])
        if (source == null)
            throw new Error("Object to serialize cannot be null"); // ArgumentNullException
        let xml = null;
        try {
            xml = XmlSerializer.#toXml(XmlSerializer.#rootTag(this.#type, source), source, 0); // indented by default
        }
        catch (e) { }
        return xml;
    }
    // Browsers cannot write files; return the XML so the caller can trigger a download.
    SerializeToFile(source, filename, namespaces = undefined, settings = undefined) {
        if (source == null)
            throw new Error("Object to serialize cannot be null");
        return this.Serialize(source); // caller downloads it; no filesystem write
    }

    // ---- best-effort helpers ----
    static #rootTag(type, source) {
        return (type && type.name) || (source && source.constructor && source.constructor.name) || "object";
    }
    static #escape(s) {
        return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }
    static #toXml(tag, value, depth, seen = new WeakSet()) {
        const pad = "\t".repeat(depth); // GetIndentedSettings: Indent=true, IndentChars="\t"
        if (value == null) return `${pad}<${tag} />\n`;
        // ADAPTATION: .NET's XmlSerializer honors [XmlIgnore] (which excludes RadarWindow's runtime
        // object graph — Aircraft, DCB buttons/menus, textures) and throws on circular references.
        // Those attributes were dropped in the port, so guard against cycles/runaway depth here
        // (best-effort settings XML — see README). A revisited object or depth>64 is emitted empty.
        if (typeof value === "object") {
            if (seen.has(value) || depth > 64) return `${pad}<${tag} />\n`;
            seen.add(value);
        }
        if (Array.isArray(value)) {
            return value.map(v => XmlSerializer.#toXml(tag, v, depth, seen)).join("");
        }
        if (typeof value === "object") {
            let inner = "";
            for (const k of Object.keys(value)) {
                const v = value[k];
                if (typeof v === "function") continue;
                inner += XmlSerializer.#toXml(k, v, depth + 1, seen);
            }
            return `${pad}<${tag}>\n${inner}${pad}</${tag}>\n`;
        }
        return `${pad}<${tag}>${XmlSerializer.#escape(value)}</${tag}>\n`;
    }
    static #fromElement(el, type) {
        if (el == null) return null;
        const children = [...el.children];
        if (children.length === 0) {
            const txt = el.textContent;
            // scalar coercion
            if (txt === "true" || txt === "false") return txt === "true";
            if (txt !== "" && !isNaN(Number(txt))) return Number(txt);
            return txt;
        }
        const obj = (type && typeof type === "function") ? new type() : {};
        // group repeated tags into arrays
        const groups = new Map();
        for (const c of children) {
            if (!groups.has(c.tagName)) groups.set(c.tagName, []);
            groups.get(c.tagName).push(c);
        }
        for (const [tag, els] of groups) {
            const vals = els.map(e => XmlSerializer.#fromElement(e, null));
            obj[tag] = els.length > 1 ? vals : vals[0];
        }
        // attributes -> properties (best effort)
        for (const a of el.attributes || [])
            obj[a.name] = a.value;
        return obj;
    }
}
