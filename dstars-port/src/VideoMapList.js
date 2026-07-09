// Ported 1:1 from _source/VideoMapList.cs
// namespace DGScope
// class VideoMapList : List<VideoMap> -> extends Array. List.Contains uses VideoMap.Equals
// (by Number) -> `this.some(x => x.equals(map))`. File IO -> fetch / returned string.
import { VideoMap } from "./VideoMap.js";
import { GeoJSONMapExporter } from "./MapGeoJSON.js";

export class VideoMapList extends Array {
    // [XmlIgnore]
    Filename = null; // string

    // C# ctors: () | (object[] maps) | (string filename).
    // NOTE: Array subclass methods (map/filter/slice) invoke the constructor with a numeric
    // length via Symbol.species — pass that straight through so those keep working.
    constructor(arg) {
        if (typeof arg === "number") { super(arg); return; } // Array species (length)
        super();
        if (Array.isArray(arg)) { // VideoMapList(object[] maps)
            for (const item of arg) {
                if (!(item instanceof VideoMap))
                    throw new Error("Passed object was type " + (item && item.constructor ? item.constructor.name : item) + " and not a Video Map."); // InvalidDataException
                this.Add(item);
            }
        }
        else if (typeof arg === "string") { // VideoMapList(string filename)
            this.Filename = arg;
        }
    }

    // new void Add(VideoMap map) — bump Number until unique, then add.
    Add(map) {
        while (this.some(x => x.equals(map))) { // Contains(map) (VideoMap.Equals by Number)
            map.Number++;
        }
        super.push(map); // base.Add(map)
    }

    // new void AddRange(IEnumerable<VideoMap> collection)
    AddRange(collection) {
        for (const map of collection) {
            this.Add(map);
        }
    }

    static SerializeToJsonFile(videoMaps, filename) {
        // File.WriteAllText -> return the JSON for the caller to download (no browser fs).
        return VideoMapList.SerializeToJson(videoMaps);
    }
    static SerializeToJson(videoMaps) { // string
        return GeoJSONMapExporter.MapsToGeoJSON(videoMaps);
    }
    static async DeserializeFromJsonFile(filename) { // File.ReadAllText -> fetch
        let json = await (await fetch(filename)).text();
        return GeoJSONMapExporter.GeoJSONToMaps(json);
    }
    static DeserializeFromJson(jsonString) {
        return GeoJSONMapExporter.GeoJSONToMaps(jsonString);
    }
}
