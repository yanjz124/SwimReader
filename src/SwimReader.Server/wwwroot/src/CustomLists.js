// Ported from _source/CustomLists.cs
// ListOfIReceiver : List<Receiver>, IXmlSerializable -> extends Array (IXmlSerializable best-effort).
//
// LIMITATION (documented): ReadXml uses Type.GetType(AssemblyQualifiedName) to reconstruct concrete
// Receiver subclasses by reflection. JS has no reflection-by-assembly-name, and the concrete
// receiver classes live in the DGScope.Receivers.* projects (outside the 73-file main-project
// scope). So ReadXml deserializes each <Receiver> to a best-effort plain object (retaining its
// type name in __type); a faithful port needs a receiver-type registry. XmlReader/XmlWriter have
// no JS analog -> signatures adapted to strings.
import { XmlSerializer } from "./XmlSerializer.js";

export class ListOfIReceiver extends Array {
    constructor() { super(); } // ListOfIReceiver() : base()
    GetSchema() { return null; }

    WriteXml() { // void WriteXml(XmlWriter) -> returns the <Receivers> XML string
        let s = "<Receivers>";
        for (const receiver of this) {
            // receiver.GetType().AssemblyQualifiedName -> constructor name (no .NET assembly name in JS)
            const typeName = receiver && receiver.constructor ? receiver.constructor.name : "Receiver";
            s += `<Receiver AssemblyQualifiedName="${typeName}">`;
            s += new XmlSerializer(receiver && receiver.constructor).Serialize(receiver) ?? "";
            s += "</Receiver>";
        }
        s += "</Receivers>";
        return s;
    }

    ReadXml(xml) { // void ReadXml(XmlReader) -> parses a string
        if (xml == null || xml === "") return;
        const doc = new DOMParser().parseFromString(xml, "application/xml");
        for (const rEl of doc.getElementsByTagName("Receiver")) {
            const typeName = rEl.getAttribute("AssemblyQualifiedName"); // Type.GetType(name) -> not reconstructable
            const obj = new XmlSerializer(null).Deserialize(rEl.outerHTML);
            if (obj && typeof obj === "object") obj.__type = typeName;
            this.push(obj); // this.Add((Receiver)serial.Deserialize(reader))
        }
    }
}
