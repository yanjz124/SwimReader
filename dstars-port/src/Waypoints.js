// Ported 1:1 from _source/Waypoints.cs
// namespace DGScope
// NOTE: Generated code may require at least .NET Framework 4.5 or .NET Core/Standard 2.0.

/// <remarks/>
// [System.SerializableAttribute()]
// [System.ComponentModel.DesignerCategoryAttribute("code")]
// [System.Xml.Serialization.XmlTypeAttribute(AnonymousType=true)]
// [System.Xml.Serialization.XmlRootAttribute(Namespace="", IsNullable=false)]
export class Waypoints { // partial class Waypoints

    #waypointField = []; // WaypointsWaypoint[] = new WaypointsWaypoint[0]

    /// <remarks/>
    // [System.Xml.Serialization.XmlElementAttribute("Waypoint")]
    get Waypoint() { // WaypointsWaypoint[]
        return this.#waypointField;
    }
    set Waypoint(value) {
        this.#waypointField = value;
    }
}

/// <remarks/>
// [System.SerializableAttribute()]
// [System.ComponentModel.DesignerCategoryAttribute("code")]
// [System.Xml.Serialization.XmlTypeAttribute(AnonymousType=true)]
export class WaypointsWaypoint { // partial class WaypointsWaypoint

    #locationField = null; // AirportLocation

    #idField = null; // string

    #typeField = null; // string

    /// <remarks/>
    get Location() { // AirportLocation
        return this.#locationField;
    }
    set Location(value) {
        this.#locationField = value;
    }

    /// <remarks/>
    // [System.Xml.Serialization.XmlAttributeAttribute()]
    get ID() { // string
        return this.#idField;
    }
    set ID(value) {
        this.#idField = value;
    }

    /// <remarks/>
    // [System.Xml.Serialization.XmlAttributeAttribute()]
    get Type() { // string
        return this.#typeField;
    }
    set Type(value) {
        this.#typeField = value;
    }

    toString() {
        return this.ID;
    }
}
