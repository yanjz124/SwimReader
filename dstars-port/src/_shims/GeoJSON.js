// Shim for the BAMCIS.GeoJSON library (external, outside the 73-file scope) — the GeoJSON type
// hierarchy DGScope's GeoJSONMapExporter uses, over plain JSON. GeoJson.FromJson builds the typed
// objects; ToJson serializes back. Position uses GeoJSON coordinate order [lon, lat, elev].

export const GeoJsonType = Object.freeze({
    Point: "Point", MultiPoint: "MultiPoint", LineString: "LineString", MultiLineString: "MultiLineString",
    Polygon: "Polygon", MultiPolygon: "MultiPolygon", GeometryCollection: "GeometryCollection",
    Feature: "Feature", FeatureCollection: "FeatureCollection",
});
export const GeoJsonConfig = { IgnoreLatitudeValidation: false, IgnoreLongitudeValidation: false };

export class Position {
    constructor(longitude = 0, latitude = 0, elevation = undefined) {
        this.Longitude = longitude; this.Latitude = latitude; this.Elevation = elevation;
    }
}
export class Geometry { Type; }
export class LineString extends Geometry {
    constructor(positions = []) { super(); this.Type = GeoJsonType.LineString; this.Coordinates = positions; } // Position[]
}
export class LinearRing {
    constructor(positions = []) { this.Coordinates = positions; } // Position[]
}
export class Polygon extends Geometry {
    constructor(rings = []) { super(); this.Type = GeoJsonType.Polygon; this.Coordinates = rings; } // LinearRing[]
}
export class MultiLineString extends Geometry {
    constructor(lineStrings = []) { super(); this.Type = GeoJsonType.MultiLineString; this.Coordinates = lineStrings; } // LineString[]
}
export class MultiPolygon extends Geometry {
    constructor(polygons = []) { super(); this.Type = GeoJsonType.MultiPolygon; this.Coordinates = polygons; } // Polygon[]
}
export class GeometryCollection extends Geometry {
    constructor(geometries = []) { super(); this.Type = GeoJsonType.GeometryCollection; this.Geometries = geometries; }
}
export class Feature {
    constructor(geometry = null) { this.Type = GeoJsonType.Feature; this.Geometry = geometry; this.Properties = {}; }
    ToJson() { return JSON.stringify(toPlain(this)); }
}
export class FeatureCollection {
    constructor(features = []) { this.Type = GeoJsonType.FeatureCollection; this.Features = features; }
    ToJson() { return JSON.stringify(toPlain(this)); }
}

function pos(c) { return new Position(c[0], c[1], c[2]); }

export class GeoJson {
    static FromJson(json) { return build(JSON.parse(json)); }
}

function build(o) {
    if (o == null) return null;
    switch (o.type) {
        case "FeatureCollection": return new FeatureCollection((o.features || []).map(build));
        case "Feature": { const f = new Feature(o.geometry ? build(o.geometry) : null); f.Properties = o.properties || {}; return f; }
        case "LineString": return new LineString((o.coordinates || []).map(pos));
        case "MultiLineString": return new MultiLineString((o.coordinates || []).map(ls => new LineString(ls.map(pos))));
        case "Polygon": return new Polygon((o.coordinates || []).map(r => new LinearRing(r.map(pos))));
        case "MultiPolygon": return new MultiPolygon((o.coordinates || []).map(poly => new Polygon(poly.map(r => new LinearRing(r.map(pos))))));
        case "GeometryCollection": return new GeometryCollection((o.geometries || []).map(build));
        case "Point": { const p = new Geometry(); p.Type = GeoJsonType.Point; return p; }
        case "MultiPoint": { const p = new Geometry(); p.Type = GeoJsonType.MultiPoint; return p; }
    }
    return null;
}

function toPlain(g) {
    if (g == null) return null;
    const P = p => [p.Longitude, p.Latitude];
    switch (g.Type) {
        case GeoJsonType.FeatureCollection: return { type: "FeatureCollection", features: g.Features.map(toPlain) };
        case GeoJsonType.Feature: return { type: "Feature", geometry: toPlain(g.Geometry), properties: g.Properties };
        case GeoJsonType.LineString: return { type: "LineString", coordinates: g.Coordinates.map(P) };
        case GeoJsonType.MultiLineString: return { type: "MultiLineString", coordinates: g.Coordinates.map(ls => ls.Coordinates.map(P)) };
        case GeoJsonType.Polygon: return { type: "Polygon", coordinates: g.Coordinates.map(r => r.Coordinates.map(P)) };
        case GeoJsonType.MultiPolygon: return { type: "MultiPolygon", coordinates: g.Coordinates.map(poly => poly.Coordinates.map(r => r.Coordinates.map(P))) };
        case GeoJsonType.GeometryCollection: return { type: "GeometryCollection", geometries: g.Geometries.map(toPlain) };
    }
    return null;
}
