// Ported 1:1 from _source/AirportsXml.cs
// namespace DGScope
// NOTE: Generated code (xsd) — XML-serialization DTOs. Attributes preserved as comments.
import { GeoPoint } from "./GeoPoint.js";

/// <remarks/>
// [Serializable] [DesignerCategory("code")] [XmlType(AnonymousType=true)] [XmlRoot(Namespace="", IsNullable=false)]
export class Airports { // partial class Airports
    #airportField = []; // Airport[] = new Airport[0]
    /// <remarks/>
    // [XmlElement("Airport")]
    get Airport() { return this.#airportField; } // Airport[]
    set Airport(value) { this.#airportField = value; }
}

/// <remarks/>
// [Serializable] [DesignerCategory("code")] [XmlType(AnonymousType=true)]
export class Airport { // partial class Airport
    #locationField = null;  // AirportLocation
    #runwaysField = null;   // Runway[]
    #idField = null;        // string
    #nameField = null;      // string
    #elevationField = 0;    // short
    #magVarField = 0;       // decimal
    #frequencyField = 0;    // byte

    /// <remarks/>
    get Location() { return this.#locationField; }        // AirportLocation
    set Location(value) { this.#locationField = value; }
    /// <remarks/>
    // [XmlArrayItem("Runway", IsNullable=false)]
    get Runways() { return this.#runwaysField; }          // Runway[]
    set Runways(value) { this.#runwaysField = value; }
    /// <remarks/>
    // [XmlAttribute]
    get ID() { return this.#idField; }                    // string
    set ID(value) { this.#idField = value; }
    /// <remarks/>
    // [XmlAttribute]
    get Name() { return this.#nameField; }                // string
    set Name(value) { this.#nameField = value; }
    /// <remarks/>
    // [XmlAttribute]
    get Elevation() { return this.#elevationField; }      // short
    set Elevation(value) { this.#elevationField = value; }
    /// <remarks/>
    // [XmlAttribute]
    get MagVar() { return this.#magVarField; }            // decimal
    set MagVar(value) { this.#magVarField = value; }
    /// <remarks/>
    // [XmlAttribute]
    get Frequency() { return this.#frequencyField; }      // byte
    set Frequency(value) { this.#frequencyField = value; }
    toString() {
        // NOTE: C# source literally has "{ 0}: {1}" (stray space) which would throw
        // FormatException; the intended text is reproduced here.
        return `${this.ID}: ${this.Name}`; // string.Format("{ 0}: {1}", ID, Name)
    }
}

/// <remarks/>
// [Serializable] [DesignerCategory("code")] [XmlType(AnonymousType=true)]
export class AirportLocation extends GeoPoint { // partial class AirportLocation : GeoPoint
    /// <remarks/>
    // [XmlAttribute]
    get Lat() { return this.Latitude; }         // double
    set Lat(value) { this.Latitude = value; }
    /// <remarks/>
    // [XmlAttribute]
    get Lon() { return this.Longitude; }        // double
    set Lon(value) { this.Longitude = value; }
    constructor() { super(); } // AirportLocation() : base() { }
}

/// <remarks/>
// [Serializable] [DesignerCategory("code")] [XmlType(AnonymousType=true)]
export class Runway { // partial class Runway
    #startLocField = null; // AirportLocation
    #endLocField = null;   // AirportLocation
    #idField = null;       // string
    #headingField = 0;     // decimal
    #lengthField = 0;      // ushort
    #widthField = 0;       // ushort

    /// <remarks/>
    get StartLoc() { return this.#startLocField; }     // AirportLocation
    set StartLoc(value) { this.#startLocField = value; }
    /// <remarks/>
    get EndLoc() { return this.#endLocField; }         // AirportLocation
    set EndLoc(value) { this.#endLocField = value; }
    /// <remarks/>
    // [XmlAttribute]
    get ID() { return this.#idField; }                 // string
    set ID(value) { this.#idField = value; }
    /// <remarks/>
    // [XmlAttribute]
    get Heading() { return this.#headingField; }       // decimal
    set Heading(value) { this.#headingField = value; }
    /// <remarks/>
    // [XmlAttribute]
    get Length() { return this.#lengthField; }         // ushort
    set Length(value) { this.#lengthField = value; }
    /// <remarks/>
    // [XmlAttribute]
    get Width() { return this.#widthField; }           // ushort
    set Width(value) { this.#widthField = value; }
    toString() {
        return this.ID;
    }
}
