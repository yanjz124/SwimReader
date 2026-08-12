// Ported 1:1 from _source/MapImporter/VRC/VRCFileParser.cs
// namespace DGScope.MapImporter.VRC
// Adaptation: GetMapsFromFile takes the file's TEXT (browser can't sync-read a path).
import { VideoMap } from "../../VideoMap.js";
import { Line } from "../../Line.js";
import { GeoPoint } from "../../GeoPoint.js";
import { tryParseDouble } from "../../_shims/Primitives.js";

export class VRCFileParser { // public static class
    static GetMapsFromFile(fileText) { // static List<VideoMap> GetMapsFromFile(string filename)
        let maps = []; // List<VideoMap>
        try {
            {
                let sectionName = "";
                let shortened = false; // bool shortened = false
                let currentMap = null; // VideoMap
                for (const line of fileText.split(/\r?\n/)) { // while (!sr.EndOfStream) { line = sr.ReadLine(); }
                    let linedata;
                    if (line.includes(";"))
                        linedata = line.substring(0, line.indexOf(";"));
                    else
                        linedata = line;
                    linedata = linedata; // (source has this no-op self-assignment)
                    let issectionheader = false;
                    if (linedata.includes("[") && linedata.includes("]")) {
                        // Substring(line.IndexOf("[")+1, linedata.IndexOf("]") - linedata.IndexOf("[") - 1)
                        let start = line.indexOf("[") + 1;
                        let len = linedata.indexOf("]") - linedata.indexOf("[") - 1;
                        sectionName = linedata.substring(start, start + len).toUpperCase();
                        issectionheader = true;
                    }
                    if (issectionheader)
                        continue;
                    if (linedata.length === 0)
                        continue;
                    if (sectionName !== "SID" && sectionName !== "STAR")
                        continue;
                    let linename;
                    if (linedata.substring(0, 1).trim().length !== 0 && linedata.length > 25) {
                        linename = linedata.substring(0, 25).trim();
                        linedata = linedata.substring(26);
                        currentMap = Object.assign(new VideoMap(), { Name: linename });
                        maps.push(currentMap);
                    }
                    let newline = {}; // out Line
                    if (currentMap != null && VRCFileParser.TryParseLine(linedata, newline))
                        currentMap.Lines.push(newline.value);
                }
            }
        }
        catch (e) { // catch (IOException e)
            console.log("The file could not be read:");
            console.log(e.message);
        }
        return maps;
    }

    static TryParseLine(linestring, line /* out Line */) { // static bool
        linestring = linestring.trim();
        line.value = new Line();
        let lineparts = linestring.split(' ');
        if (lineparts.length < 4)
            return false;
        let point1 = lineparts[0] + " " + lineparts[1];
        let point2 = lineparts[2] + " " + lineparts[3];
        let geoPoint1 = {}; // out GeoPoint
        if (VRCFileParser.TryParsePoint(point1, geoPoint1)) {
            let geoPoint2 = {}; // out GeoPoint
            if (VRCFileParser.TryParsePoint(point2, geoPoint2)) {
                line.value.End1 = geoPoint1.value;
                line.value.End2 = geoPoint2.value;
                return true;
            }
        }
        return false;
    }

    static TryParsePoint(pointString, point /* out GeoPoint */) { // static bool
        point.value = new GeoPoint();
        pointString = pointString.trim();
        let pointSplit = pointString.split(' ');
        if (pointSplit.length < 2)
            return false;
        let lat = pointSplit[0].split('.');
        let lon = pointSplit[1].split('.');
        let value = { value: 0 }; // double value = 0
        let latitude = 0;         // double latitude = 0
        let latOut = { value: 0 };
        if (lat.length === 2 && tryParseDouble(pointSplit[0], latOut)) {
            latitude = latOut.value;
        }
        else { //  Try VRC format
            if (lat[0].length >= 2 && tryParseDouble(lat[0].substring(1), value))
                latitude += value.value;
            else
                return false;
            if (lat.length > 2 && tryParseDouble(lat[1], value))
                latitude += value.value / 60;
            if (lat.length >= 3 && tryParseDouble(lat[2], value))
                latitude += value.value / 3600;
            if (lat.length >= 4 && tryParseDouble(lat[3], value))
                latitude += value.value / (3600 * Math.pow(10, lat[3].trim().length));
        }
        if (pointSplit[0].includes('S'))
            latitude *= -1;

        let longitude = 0;
        let lonOut = { value: 0 };
        if (lon.length === 2 && tryParseDouble(pointSplit[1], lonOut)) {
            longitude = lonOut.value;
        }
        else { //  Try VRC format
            if (tryParseDouble(lon[0].substring(1), value))
                longitude += value.value;
            else
                return false;
            if (lon.length > 2 && tryParseDouble(lon[1], value))
                longitude += value.value / 60;
            if (lon.length >= 3 && tryParseDouble(lon[2], value))
                longitude += value.value / 3600;
            if (lon.length >= 4 && tryParseDouble(lon[3], value))
                longitude += value.value / (3600 * Math.pow(10, lon[3].trim().length));
        }
        if (pointSplit[1].includes('W'))
            longitude *= -1;
        point.value.Latitude = latitude;
        point.value.Longitude = longitude;
        return true;
    }
}
