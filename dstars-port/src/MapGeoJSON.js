// Ported 1:1 from _source/MapGeoJSON.cs
// namespace DGScope
// BAMCIS.GeoJSON -> _shims/GeoJSON.js; Newtonsoft JObject/JToken fixups -> plain JSON.parse
// objects/arrays; File.ReadAllText/WriteAllText -> fetch / returned string; MessageBox/Debug -> console.
import { VideoMap, MapCategory } from "./VideoMap.js";
import { Line } from "./Line.js";
import { GeoPoint } from "./GeoPoint.js";
import { VideoMapList } from "./VideoMapList.js";
import {
    GeoJson, GeoJsonType, GeoJsonConfig, Feature, FeatureCollection, Geometry,
    GeometryCollection, LineString, Polygon, MultiLineString, MultiPolygon, LinearRing, Position,
} from "./_shims/GeoJSON.js";

export class GeoJSONMapExporter { // public static class
    static MapsToGeoJSON(maps) { // string
        let features = []; // List<Feature>
        for (const map of maps) {
            let feature = new Feature(GeoJSONMapExporter.#MapToGeometryCollection(map));
            feature.Properties["name"] = map.Name;         // Properties.Add(...)
            feature.Properties["number"] = map.Number;
            feature.Properties["category"] = map.Category;
            feature.Properties["mnemonic"] = map.Mnemonic;
            features.push(feature);
        }
        let fc = new FeatureCollection(features);
        return fc.ToJson();
    }
    static MapToGeoJSON(map) { // string
        let fc = new FeatureCollection(GeoJSONMapExporter.#MapToFeatureList(map));
        return fc.ToJson();
    }

    static #MapToFeatureList(map) { // List<Feature>
        let features = [];
        for (const line of map.Lines) {
            let lineString = GeoJSONMapExporter.#LineToLineString(line);
            if (lineString != null) {
                let feature = new Feature(lineString);
                features.push(feature);
            }
        }
        return features;
    }

    static #MapToGeometryCollection(map) { // GeometryCollection
        let linestrings = []; // List<Geometry>
        for (const line of map.Lines) {
            let lineString = GeoJSONMapExporter.#LineToLineString(line);
            if (lineString != null)
                linestrings.push(lineString);
        }
        return new GeometryCollection(linestrings);
    }

    static #LineToLineString(line) { // LineString
        let positions = []; // List<Position>
        if (Math.abs(line.End1.Latitude) > 90 || Math.abs(line.End2.Latitude) > 90 || Math.abs(line.End1.Longitude) > 180 || Math.abs(line.End2.Longitude) > 180)
            return null;
        positions.push(new Position(line.End1.Longitude, line.End1.Latitude));
        positions.push(new Position(line.End2.Longitude, line.End2.Latitude));
        return new LineString(positions);
    }

    static MapToGeoJSONFile(map, filename) {
        // File.WriteAllText -> no browser filesystem; return the JSON for the caller to download.
        return GeoJSONMapExporter.MapToGeoJSON(map);
    }
    static MapsToGeoJSONFile(maps, filename) {
        return GeoJSONMapExporter.MapsToGeoJSON(maps);
    }

    static async GeoJSONFileToMaps(path) { // VideoMapList  (File.ReadAllText -> fetch)
        let json = await (await fetch(path)).text();
        try {
            return GeoJSONMapExporter.GeoJSONToMaps(json);
        }
        catch (ex) { console.log("Error with video map " + path + "\r\n" + ex.message); } // MessageBox.Show
        return null;
    }

    /// Preprocesses GeoJSON to fix invalid LineStrings with fewer than 2 positions.
    static #FixInvalidLineStrings(json) { // string
        try {
            let obj = JSON.parse(json); // JObject.Parse
            GeoJSONMapExporter.#FixGeometriesRecursive(obj);
            return JSON.stringify(obj); // obj.ToString()
        }
        catch (ex) {
            console.log(`Error preprocessing GeoJSON: ${ex.message}`);
            return json;
        }
    }

    static #FixGeometriesRecursive(token) {
        if (token == null) return;

        if (typeof token === "object" && !Array.isArray(token)) { // token is JObject jObj
            let jObj = token;
            let typeValue = jObj["type"]; // ?.Value<string>()
            if (typeValue === "LineString") {
                let coordinates = Array.isArray(jObj["coordinates"]) ? jObj["coordinates"] : null;
                if (coordinates != null && coordinates.length < 2) {
                    jObj["__delete__"] = true;
                }
                return;
            }
            if (typeValue === "GeometryCollection") {
                let geometries = Array.isArray(jObj["geometries"]) ? jObj["geometries"] : null;
                if (geometries != null) {
                    for (const geom of geometries)
                        GeoJSONMapExporter.#FixGeometriesRecursive(geom);
                    let validGeometries = geometries.filter(g =>
                        !(typeof g === "object" && !Array.isArray(g) && g["__delete__"] === true));
                    jObj["geometries"] = validGeometries;
                    return;
                }
            }
            if (typeValue === "Feature") {
                let geometry = jObj["geometry"];
                if (geometry != null) {
                    GeoJSONMapExporter.#FixGeometriesRecursive(geometry);
                    if (typeof geometry === "object" && !Array.isArray(geometry) && geometry["__delete__"] === true) {
                        jObj["geometry"] = null;
                    }
                }
                return;
            }
            if (typeValue === "FeatureCollection") {
                let features = Array.isArray(jObj["features"]) ? jObj["features"] : null;
                if (features != null) {
                    for (const feature of features)
                        GeoJSONMapExporter.#FixGeometriesRecursive(feature);
                }
                return;
            }
            if (typeValue === "MultiLineString") {
                let coordinates = Array.isArray(jObj["coordinates"]) ? jObj["coordinates"] : null;
                if (coordinates != null) {
                    let validLines = coordinates.filter(line => Array.isArray(line) && line.length >= 2);
                    jObj["coordinates"] = validLines;
                }
                return;
            }
            if (typeValue === "Polygon") {
                let coordinates = Array.isArray(jObj["coordinates"]) ? jObj["coordinates"] : null;
                if (coordinates != null) {
                    let validRings = [];
                    for (const ring of coordinates) {
                        if (Array.isArray(ring) && ring.length >= 2)
                            validRings.push(ring);
                    }
                    jObj["coordinates"] = validRings;
                }
                return;
            }
            // Recursively process all other properties
            for (const name of Object.keys(jObj)) {
                if (name !== "__delete__") {
                    GeoJSONMapExporter.#FixGeometriesRecursive(jObj[name]);
                }
            }
        }
        else if (Array.isArray(token)) { // token is JArray jArr
            for (let i = 0; i < token.length; i++)
                GeoJSONMapExporter.#FixGeometriesRecursive(token[i]);
        }
    }

    static GeoJSONToMaps(json) { // VideoMapList
        let maps = new VideoMapList();
        GeoJsonConfig.IgnoreLatitudeValidation = true;
        GeoJsonConfig.IgnoreLongitudeValidation = true;

        json = GeoJSONMapExporter.#FixInvalidLineStrings(json);

        try {
            let data = GeoJson.FromJson(json);
            switch (data.Type) {
                case GeoJsonType.FeatureCollection: {
                    let featureCollection = data; // as FeatureCollection
                    if (featureCollection.Features.some(x => x.Geometry != null && x.Geometry.Type === GeoJsonType.GeometryCollection)) {
                        for (const feature of featureCollection.Features.filter(x => x.Geometry != null && x.Geometry.Type === GeoJsonType.GeometryCollection)) {
                            let newmap = new VideoMap();
                            let geometryCollection = feature.Geometry; // as GeometryCollection
                            if ("name" in feature.Properties) newmap.Name = feature.Properties["name"];
                            if ("number" in feature.Properties) newmap.Number = Math.trunc(feature.Properties["number"]);
                            if ("mnemonic" in feature.Properties) newmap.Mnemonic = feature.Properties["mnemonic"];
                            if ("category" in feature.Properties) newmap.Category = Math.trunc(feature.Properties["category"]); // (MapCategory)(int)
                            for (const geometry of geometryCollection.Geometries) {
                                let lines = GeoJSONMapExporter.#GeometryToLines(geometry);
                                if (lines != null && lines.length > 0)
                                    newmap.Lines.push(...lines);
                            }
                            if (newmap.Lines.length > 0)
                                maps.Add(newmap);
                        }
                    }
                    else {
                        let map = new VideoMap();
                        map.Name = "Imported map - " + new Date().toLocaleDateString() + " " + new Date().toLocaleTimeString();
                        for (const feature of featureCollection.Features.filter(x => x.Geometry != null)) {
                            let lines = GeoJSONMapExporter.#GeometryToLines(feature.Geometry);
                            if (lines != null && lines.length > 0)
                                map.Lines.push(...lines);
                        }
                        if (map.Lines.length > 0)
                            maps.Add(map);
                    }
                    break;
                }
                case GeoJsonType.Feature: {
                    let singleFeature = data; // as Feature
                    if (singleFeature?.Geometry != null) {
                        let featureMap = new VideoMap();
                        if ("name" in singleFeature.Properties) featureMap.Name = singleFeature.Properties["name"];
                        else featureMap.Name = "Imported map - " + new Date().toLocaleDateString() + " " + new Date().toLocaleTimeString();
                        if ("number" in singleFeature.Properties) featureMap.Number = Math.trunc(singleFeature.Properties["number"]);
                        if ("mnemonic" in singleFeature.Properties) featureMap.Mnemonic = singleFeature.Properties["mnemonic"];
                        if ("category" in singleFeature.Properties) featureMap.Category = Math.trunc(singleFeature.Properties["category"]);
                        let featureLines = GeoJSONMapExporter.#GeometryToLines(singleFeature.Geometry);
                        if (featureLines != null && featureLines.length > 0) {
                            featureMap.Lines.push(...featureLines);
                            maps.Add(featureMap);
                        }
                    }
                    break;
                }
                case GeoJsonType.LineString:
                case GeoJsonType.MultiLineString:
                case GeoJsonType.Polygon:
                case GeoJsonType.MultiPolygon:
                case GeoJsonType.GeometryCollection: {
                    let geomLines = GeoJSONMapExporter.#GeometryToLines(data); // as Geometry
                    if (geomLines != null && geomLines.length > 0) {
                        let geomMap = new VideoMap();
                        geomMap.Name = "Imported map - " + new Date().toLocaleDateString() + " " + new Date().toLocaleTimeString();
                        geomMap.Lines.push(...geomLines);
                        maps.Add(geomMap);
                    }
                    break;
                }
            }
            return maps;
        }
        catch (ex) {
            console.log(`BAMCIS parsing failed: ${ex.message}. Attempting fallback JSON parsing.`);
            try {
                return GeoJSONMapExporter.#TryManualGeoJSONParse(json);
            }
            catch (fallbackEx) {
                console.log(`Fallback parsing also failed: ${fallbackEx.message}`);
                return maps;
            }
        }
    }

    static #TryManualGeoJSONParse(json) { // VideoMapList
        let maps = new VideoMapList();
        let obj = JSON.parse(json); // JObject.Parse
        let topType = obj["type"];

        if (topType === "FeatureCollection") {
            let features = Array.isArray(obj["features"]) ? obj["features"] : null;
            if (features != null) {
                for (const feature of features) {
                    if (feature["geometry"] != null) {
                        let geometry = feature["geometry"];
                        let lines = GeoJSONMapExporter.#ManualGeometryToLines(geometry);
                        if (lines != null && lines.length > 0) {
                            let map = new VideoMap();
                            if (feature["properties"]?.["name"] != null) map.Name = feature["properties"]["name"];
                            if (feature["properties"]?.["number"] != null) map.Number = Math.trunc(feature["properties"]["number"]);
                            if (feature["properties"]?.["mnemonic"] != null) map.Mnemonic = feature["properties"]["mnemonic"];
                            map.Lines.push(...lines);
                            maps.Add(map);
                        }
                    }
                }
            }
        }
        else if (topType === "Feature") {
            if (obj["geometry"] != null) {
                let lines = GeoJSONMapExporter.#ManualGeometryToLines(obj["geometry"]);
                if (lines != null && lines.length > 0) {
                    let map = new VideoMap();
                    if (obj["properties"]?.["name"] != null) map.Name = obj["properties"]["name"];
                    else map.Name = "Imported map - " + new Date().toLocaleDateString() + " " + new Date().toLocaleTimeString();
                    map.Lines.push(...lines);
                    maps.Add(map);
                }
            }
        }
        else {
            let lines = GeoJSONMapExporter.#ManualGeometryToLines(obj);
            if (lines != null && lines.length > 0) {
                let map = new VideoMap();
                map.Name = "Imported map - " + new Date().toLocaleDateString() + " " + new Date().toLocaleTimeString();
                map.Lines.push(...lines);
                maps.Add(map);
            }
        }
        return maps;
    }

    static #ManualGeometryToLines(geometry) { // List<Line>
        if (geometry == null || !(typeof geometry === "object" && !Array.isArray(geometry))) return null;
        let geometryObj = geometry;
        let typeStr = geometryObj["type"];
        let lines = [];
        try {
            if (typeStr === "LineString") {
                let coordinates = Array.isArray(geometryObj["coordinates"]) ? geometryObj["coordinates"] : null;
                if (coordinates != null && coordinates.length >= 2) {
                    for (let i = 1; i < coordinates.length; i++) {
                        let pt1 = coordinates[i - 1], pt2 = coordinates[i];
                        if (Array.isArray(pt1) && Array.isArray(pt2) && pt1.length >= 2 && pt2.length >= 2) {
                            lines.push(new Line(new GeoPoint(pt1[1], pt1[0]), new GeoPoint(pt2[1], pt2[0])));
                        }
                    }
                }
            }
            else if (typeStr === "MultiLineString") {
                let lineStrings = Array.isArray(geometryObj["coordinates"]) ? geometryObj["coordinates"] : null;
                if (lineStrings != null) {
                    for (const lineString of lineStrings) {
                        if (Array.isArray(lineString) && lineString.length >= 2) {
                            for (let i = 1; i < lineString.length; i++) {
                                let pt1 = lineString[i - 1], pt2 = lineString[i];
                                if (Array.isArray(pt1) && Array.isArray(pt2) && pt1.length >= 2 && pt2.length >= 2)
                                    lines.push(new Line(new GeoPoint(pt1[1], pt1[0]), new GeoPoint(pt2[1], pt2[0])));
                            }
                        }
                    }
                }
            }
            else if (typeStr === "Polygon") {
                let rings = Array.isArray(geometryObj["coordinates"]) ? geometryObj["coordinates"] : null;
                if (rings != null) {
                    for (const ring of rings) {
                        if (Array.isArray(ring) && ring.length >= 2) {
                            for (let i = 1; i < ring.length; i++) {
                                let pt1 = ring[i - 1], pt2 = ring[i];
                                if (Array.isArray(pt1) && Array.isArray(pt2) && pt1.length >= 2 && pt2.length >= 2)
                                    lines.push(new Line(new GeoPoint(pt1[1], pt1[0]), new GeoPoint(pt2[1], pt2[0])));
                            }
                        }
                    }
                }
            }
            else if (typeStr === "MultiPolygon") {
                let polygons = Array.isArray(geometryObj["coordinates"]) ? geometryObj["coordinates"] : null;
                if (polygons != null) {
                    for (const polygon of polygons) {
                        if (Array.isArray(polygon)) {
                            for (const ring of polygon) {
                                if (Array.isArray(ring) && ring.length >= 2) {
                                    for (let i = 1; i < ring.length; i++) {
                                        let pt1 = ring[i - 1], pt2 = ring[i];
                                        if (Array.isArray(pt1) && Array.isArray(pt2) && pt1.length >= 2 && pt2.length >= 2)
                                            lines.push(new Line(new GeoPoint(pt1[1], pt1[0]), new GeoPoint(pt2[1], pt2[0])));
                                    }
                                }
                            }
                        }
                    }
                }
            }
            else if (typeStr === "GeometryCollection") {
                let geometries = Array.isArray(geometryObj["geometries"]) ? geometryObj["geometries"] : null;
                if (geometries != null) {
                    for (const geom of geometries) {
                        let geomLines = GeoJSONMapExporter.#ManualGeometryToLines(geom);
                        if (geomLines != null)
                            lines.push(...geomLines);
                    }
                }
            }
        }
        catch (ex) {
            console.log(`Error in manual geometry parsing: ${ex.message}`);
        }
        return lines.length > 0 ? lines : null;
    }

    static #GeometryToLines(geometry) { // List<Line>
        if (geometry == null) return null;
        switch (geometry.Type) {
            case GeoJsonType.LineString:
                return GeoJSONMapExporter.#LineStringToLines(geometry);
            case GeoJsonType.Polygon:
                return GeoJSONMapExporter.#PolygonToLines(geometry);
            case GeoJsonType.MultiLineString:
                return GeoJSONMapExporter.#MultiLineStringToLines(geometry);
            case GeoJsonType.MultiPolygon:
                return GeoJSONMapExporter.#MultiPolygonToLines(geometry);
            case GeoJsonType.GeometryCollection: {
                let allLines = [];
                let collection = geometry; // as GeometryCollection
                for (const geom of collection.Geometries) {
                    let lines = GeoJSONMapExporter.#GeometryToLines(geom);
                    if (lines != null && lines.length > 0)
                        allLines.push(...lines);
                }
                return allLines.length > 0 ? allLines : null;
            }
            default:
                return null; // Point, MultiPoint not supported
        }
    }

    static #LineStringToLines(lineString) { // List<Line>
        if (lineString == null) return null;
        let points = [...lineString.Coordinates];
        let lines = [];
        for (let i = 1; i < points.length; i++) {
            let end1 = new GeoPoint(points[i].Latitude, points[i].Longitude);
            let end2 = new GeoPoint(points[i - 1].Latitude, points[i - 1].Longitude);
            lines.push(new Line(end1, end2));
        }
        return lines;
    }

    static #PolygonToLines(polygon) { // List<Line>
        if (polygon == null || polygon.Coordinates == null || polygon.Coordinates.length === 0)
            return null;
        let lines = [];
        for (const ring of polygon.Coordinates) {
            let ringLines = GeoJSONMapExporter.#LinearRingToLines(ring);
            if (ringLines != null && ringLines.length > 0)
                lines.push(...ringLines);
        }
        return lines.length > 0 ? lines : null;
    }

    static #LinearRingToLines(ring) { // List<Line>
        if (ring == null || ring.Coordinates == null || ring.Coordinates.length < 2)
            return null;
        let points = [...ring.Coordinates];
        let lines = [];
        for (let i = 1; i < points.length; i++) {
            let end1 = new GeoPoint(points[i].Latitude, points[i].Longitude);
            let end2 = new GeoPoint(points[i - 1].Latitude, points[i - 1].Longitude);
            lines.push(new Line(end1, end2));
        }
        return lines;
    }

    static #MultiLineStringToLines(multiLineString) { // List<Line>
        if (multiLineString == null || multiLineString.Coordinates == null || multiLineString.Coordinates.length === 0)
            return null;
        let lines = [];
        for (const lineString of multiLineString.Coordinates) {
            let lineStringLines = GeoJSONMapExporter.#LineStringToLines(lineString);
            if (lineStringLines != null && lineStringLines.length > 0)
                lines.push(...lineStringLines);
        }
        return lines.length > 0 ? lines : null;
    }

    static #MultiPolygonToLines(multiPolygon) { // List<Line>
        if (multiPolygon == null || multiPolygon.Coordinates == null || multiPolygon.Coordinates.length === 0)
            return null;
        let lines = [];
        for (const polygon of multiPolygon.Coordinates) {
            let polygonLines = GeoJSONMapExporter.#PolygonToLines(polygon);
            if (polygonLines != null && polygonLines.length > 0)
                lines.push(...polygonLines);
        }
        return lines.length > 0 ? lines : null;
    }
}
