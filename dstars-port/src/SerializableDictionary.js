// Ported 1:1 from _source/SerializableDictionary.cs
// [XmlRoot("dictionary")]
// class SerializableDictionary<TKey,TValue> : Dictionary<TKey,TValue>, IXmlSerializable
//   -> extends JS Map (generics dropped; comparer/capacity ctor args have no JS equivalent).
//   The IXmlSerializable Read/WriteXml methods are DEFERRED (need the XmlSerializer ruling).

function escapeXml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export class SerializableDictionary extends Map {
    // C# constructor overloads:
    //   ()  ;  (IDictionary)  ;  (IDictionary, comparer)  ;  (comparer)  ;  (capacity)  ;  (capacity, comparer)
    // JS: copy entries when an iterable dictionary is passed; ignore comparer/capacity.
    constructor(arg) {
        if (arg != null && typeof arg[Symbol.iterator] === 'function') {
            super(arg);  // from IDictionary
        } else {
            super();     // capacity / comparer overloads -> no JS equivalent, ignored
        }
    }

    // Dictionary<K,V>.Add(key, value)   (Map.set; note: C# throws on duplicate key, Map overwrites)
    Add(key, value) {
        this.set(key, value);
    }

    // Dictionary<K,V>.TryGetValue(key, out value)   -> out-holder convention
    TryGetValue(key, out) {
        if (this.has(key)) {
            out.value = this.get(key);
            return true;
        }
        out.value = undefined;
        return false;
    }

    // ── IXmlSerializable Members ──
    // C# ReadXml(XmlReader)/WriteXml(XmlWriter) use a per-type XmlSerializer for key & value.
    // No JS reflection -> BEST-EFFORT string XML matching the <item><key/><value/></item> shape.
    // Signatures adapted: WriteXml() returns the item XML; ReadXml(xml) parses a string.
    GetSchema() {
        return null;
    }
    WriteXml() { // string
        let s = "";
        for (const [key, value] of this) {
            s += "<item><key>" + escapeXml(key) + "</key><value>" + escapeXml(value) + "</value></item>";
        }
        return s;
    }
    ReadXml(xml) {
        if (xml == null || xml === "") return;
        const doc = new DOMParser().parseFromString("<dictionary>" + xml + "</dictionary>", "application/xml");
        for (const item of doc.getElementsByTagName("item")) {
            const keyEl = [...item.children].find(c => c.tagName === "key");
            const valEl = [...item.children].find(c => c.tagName === "value");
            const key = keyEl ? keyEl.textContent : null;
            let value = valEl ? valEl.textContent : null;
            if (value !== null && value !== "" && !isNaN(Number(value))) value = Number(value); // scalar coercion
            this.Add(key, value);
        }
    }
}
