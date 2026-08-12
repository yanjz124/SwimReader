// Ported 1:1 from _source/MapImporter/CRC/CRCMapImporter.cs
// namespace DGScope.MapImporter.CRC
// File.OpenText + JsonSerializer.Deserialize<CRCARTCC> -> fetch().text() + JSON.parse (the parsed
// object's keys match the CRCARTCC DTO field names, so it is used directly). Directory.GetParent
// path building -> string ops. CRCFacilityPicker.ShowDialog is stubbed (returns Cancel) -> the
// multi-facility branch returns [] until a DOM picker exists (single-facility import works).
// GeoJSONMapExporter.GeoJSONFileToMaps is async -> awaited. MessageBox -> console. Method is async.
import { VideoMap, MapCategory } from "../../VideoMap.js";
import { GeoJSONMapExporter } from "../../MapGeoJSON.js";
import { CRCFacilityPicker } from "./CRCFacilityPicker.js";
import { DialogResult } from "../../_shims/WinForms.js";

export class CRCMapImporter { // internal class
    static async CRCARTCCFileToMaps(filename) { // List<VideoMap>
        let artcc; // CRCARTCC
        {
            // StreamReader + JsonSerializer.Deserialize(file, typeof(CRCARTCC)) -> fetch + JSON.parse
            let text = await (await fetch(filename)).text();
            artcc = JSON.parse(text);
        }
        if (artcc == null) {
            return [];
        }
        let artcc_id = artcc.id;
        // Directory.GetParent(filename).Parent.FullName + "\VideoMaps\" + artcc_id + "\"
        let parts = filename.split(/[\\/]/);
        parts.pop(); // drop the filename -> GetParent
        parts.pop(); // GetParent.Parent
        let mapdirectory = parts.join("/") + "/VideoMaps/" + artcc_id + "/";
        let facilities = artcc.facility.childFacilities.filter(x => x.starsConfiguration != null && x.starsConfiguration.videoMapIds && x.starsConfiguration.videoMapIds.length > 0);
        if (facilities.length === 0) {
            return [];
        }
        let importfacility; // Facility
        if (facilities.length === 1) {
            importfacility = facilities[0]; // First()
        }
        else {
            let ids = facilities.map(x => x.id); // Select(x => x.id).ToList()
            {
                let picker = new CRCFacilityPicker(facilities.map(x => x.id));
                if (picker.ShowDialog() === DialogResult.OK) {
                    importfacility = facilities.filter(x => x.id === picker.PickedFacility)[0] ?? null; // FirstOrDefault
                    if (importfacility == null) {
                        return [];
                    }
                }
                else {
                    return [];
                }
                picker.Dispose();
            }
        }
        let importmapids = [...importfacility.starsConfiguration.videoMapIds]; // ToList()
        let maps = []; // List<VideoMap>
        for (const importmapid of importmapids) {
            let importmap = artcc.videoMaps.filter(x => x.id === importmapid)[0] ?? null; // Videomap FirstOrDefault
            if (importmap == null) {
                continue;
            }
            if (importmap.starsId != null) { // starsId.HasValue
                let map = new VideoMap();
                let mappath = mapdirectory + importmap.id + ".geojson";
                let name = importmap.name;
                let mnemonic = importmap.shortName;
                let importmapobj = await GeoJSONMapExporter.GeoJSONFileToMaps(mappath);
                if (importmapobj == null) {
                    console.log("Did not import map: " + name); // MessageBox.Show
                    continue;
                }
                if (importmapobj.length > 0) { // Any()
                    map.Lines = importmapobj[0].Lines; // First().Lines
                }
                map.Name = name;
                map.Mnemonic = mnemonic;
                map.Category = importmap.starsBrightnessCategory === "A" ? MapCategory.A : MapCategory.B;
                map.Number = importmap.starsId; // starsId.Value
                maps.push(map);
            }
        }
        return maps;
    }
}
