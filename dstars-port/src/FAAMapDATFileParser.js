// Ported 1:1 from _source/FAAMapDATFileParser.cs
// namespace DGScope
// Adaptation: GetMapFromFile(filename) reads the file via StreamReader. The browser
// can't synchronously read a local path, so this takes the file's TEXT content
// (the caller does the async read). Logic below is otherwise identical.
import { VideoMap } from "./VideoMap.js";
import { Line } from "./Line.js";
import { GeoPoint } from "./GeoPoint.js";
import { tryParseInt, tryParseDouble } from "./_shims/Primitives.js";

export class FAAMapDATFileParser { // public static class
    static GetMapFromFile(fileText) { // static VideoMap GetMapFromFile(string filename)
        let map = new VideoMap();
        map.Name = "Imported map - " + new Date().toLocaleDateString() + " " + new Date().toLocaleTimeString(); // DateTime.Now.ToShortDateString/ToShortTimeString
        try {
            // Open the text file using a stream reader. (StreamReader -> iterate split lines.)
            {
                let points = null; // List<GeoPoint>
                for (const line of fileText.split(/\r?\n/)) { // while (!sr.EndOfStream) { line = sr.ReadLine(); }
                    if (line.length > 0 && line[0] !== '!') {
                        if (line.startsWith("LINE")) {
                            if (points != null && points.length >= 2) {
                                for (let i = 1; i < points.length; i++) {
                                    map.Lines.push(new Line(points[i - 1], points[i]));
                                }
                            }
                            points = [];
                        }
                        else if (line.startsWith("GP ")) {
                            let point = {}; // out GeoPoint
                            if (FAAMapDATFileParser.TryParsePoint(line, point))
                                points.push(point.value);
                        }
                    }
                }
            }
        }
        catch (e) { // catch (IOException e)
            console.log("The file could not be read:");
            console.log(e.message);
        }
        return map;
    }

    static TryParsePoint(pointString, point /* out GeoPoint */) { // static bool
        let latstring = pointString.substring(2, 2 + 14).trim().split(/\s+/); // Substring(2,14).Trim().Split()
        let lonstring = pointString.substring(17, 17 + 15).trim().split(/\s+/); // Substring(17,15).Trim().Split()
        point.value = null;
        if (latstring.length !== 3 || lonstring.length !== 3)
            return false;
        let latDeg = {}, latMin = {}, latSec = {}, lonDeg = {}, lonMin = {}, lonSec = {};
        if (!tryParseInt(latstring[0], latDeg))
            return false;
        if (!tryParseInt(latstring[1], latMin))
            return false;
        if (!tryParseDouble(latstring[2], latSec))
            return false;
        if (!tryParseInt(lonstring[0], lonDeg))
            return false;
        if (!tryParseInt(lonstring[1], lonMin))
            return false;
        if (!tryParseDouble(lonstring[2], lonSec))
            return false;
        let latitude = latDeg.value + (latMin.value / 60) + (latSec.value / 3600);
        let longitude = -(lonDeg.value + (lonMin.value / 60) + (lonSec.value / 3600));
        point.value = new GeoPoint(latitude, longitude);
        return true;
    }
}
