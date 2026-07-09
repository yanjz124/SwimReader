// Ported 1:1 from _source/MSAWImporter.cs
// namespace DGScope
// Adaptations: System.Xml.Linq.XDocument -> browser DOMParser; File.ReadAllText -> fetch().text();
// double/int.TryParse(InvariantCulture) -> Number parsing.
import { MSAWVolume } from "./MSAWVolume.js";
import { GeoPoint } from "./GeoPoint.js";

/// <summary>
/// Imports MSAW volumes from vSTARS facility "SystemVolume" XML
/// (the format produced by the myfsim.com vSTARS MSAW Volume Creator).
/// </summary>
export class MSAWImporter { // public static class
    static async Import(path) { // static List<MSAWVolume> Import(string path)
        const text = await (await fetch(path)).text(); // File.ReadAllText(path)
        return MSAWImporter.Parse(text);
    }

    static Parse(text) { // static List<MSAWVolume> Parse(string text)
        let result = []; // List<MSAWVolume>
        if (text == null || text.trim() === "") // string.IsNullOrWhiteSpace(text)
            return result;

        let doc; // XDocument
        // XDocument.Parse -> DOMParser; a parsererror element signals invalid XML (DOMParser doesn't throw).
        doc = new DOMParser().parseFromString(text, "application/xml");
        if (doc.getElementsByTagName("parsererror").length > 0) {
            // The MSAW creator emits a bare sequence of <SystemVolume> elements
            // with no single root, which isn't valid standalone XML. Wrap it.
            doc = new DOMParser().parseFromString("<MSAWVolumes>" + text + "</MSAWVolumes>", "application/xml");
        }

        for (const el of doc.getElementsByTagName("SystemVolume")) { // doc.Descendants("SystemVolume")
            let type = el.getAttribute("VolumeType"); // (string)el.Attribute("VolumeType")
            if (!(type == null || type === "") && !(type.toLowerCase() === "msaw")) // !IsNullOrEmpty && !Equals("MSAW", OrdinalIgnoreCase)
                continue;

            let vol = Object.assign(new MSAWVolume(), {
                Name: el.getAttribute("Name"),
                Floor: MSAWImporter.#ParseInt(el.getAttribute("Floor")),
                Ceiling: MSAWImporter.#ParseInt(el.getAttribute("Ceiling")),
                Radius: MSAWImporter.#ParseDouble(el.getAttribute("Radius")),
            });

            let shape = el.getAttribute("VolumeShape"); // (string)el.Attribute("VolumeShape")
            let isCircle = !(shape == null || shape === "") && shape.toLowerCase() === "circle"; // !IsNullOrEmpty && Equals("Circle", OrdinalIgnoreCase)

            let center = [...el.children].find(c => c.tagName === "Center"); // el.Element("Center")
            if (center != null && isCircle)
                vol.Center = MSAWImporter.#ReadPoint(center);

            for (const wp of el.getElementsByTagName("WorldPoint")) { // el.Descendants("WorldPoint")
                let p = MSAWImporter.#ReadPoint(wp);
                if (p != null)
                    vol.Points.push(p);
            }

            // Keep usable volumes only: a polygon needs >= 3 points, a circle a center + radius.
            if (vol.Points.length >= 3 || (vol.Radius > 0 && vol.Center != null))
                result.push(vol);
        }
        return result;
    }

    static #ReadPoint(el) { // private static GeoPoint
        let lat = Number(el.getAttribute("Lat")); // double.TryParse((string)el.Attribute("Lat"), Float, InvariantCulture, out lat)
        let lon = Number(el.getAttribute("Lon"));
        if (el.getAttribute("Lat") != null && !Number.isNaN(lat) &&
            el.getAttribute("Lon") != null && !Number.isNaN(lon))
            return new GeoPoint(lat, lon);
        return null;
    }

    static #ParseInt(a) { // private static int  (a = attribute string value, or null)
        let v = a != null ? parseInt(a, 10) : NaN;
        return (a != null && !Number.isNaN(v)) ? v : 0;
    }

    static #ParseDouble(a) { // private static double
        let v = a != null ? Number(a) : NaN;
        return (a != null && !Number.isNaN(v)) ? v : 0;
    }
}
