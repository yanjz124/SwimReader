// Ported 1:1 from _source/Altitude.cs
// namespace DGScope
// [ProtoContract]
import { Altimeter } from "./WeatherService.js";

export class Altitude {
    // [ProtoMember(1)]
    Value = 0; // int
    #_alttype = AltitudeType.Unknown; // AltitudeType
    // [ProtoMember(2)]
    get AltitudeType() { return this.#_alttype; } // AltitudeType
    set AltitudeType(value) {
        this.#_alttype = value;
    }
    TransitionAltitude = 0; // int
    get PressureAltitude() { // int
        if (this.AltitudeType === AltitudeType.Pressure)
            return this.Value;
        let altimetervalue = this.#Altimeter.Value;
        let correction = Math.trunc((altimetervalue - 29.92) * 1000);
        let newvalue = this.Value;
        if (this.AltitudeType === AltitudeType.True)
            newvalue -= correction;
        return newvalue;
    }
    set PressureAltitude(value) {
        this.UpdateAltitude(value, AltitudeType.Pressure);
    }
    get TrueAltitude() { // int
        if (this.AltitudeType === AltitudeType.True)
            return this.Value;
        let altimetervalue = this.#Altimeter.Value;
        let correction = Math.trunc((altimetervalue - 29.92) * 1000);
        let newvalue = this.Value;
        if (this.AltitudeType === AltitudeType.Pressure)
            newvalue += correction;
        return newvalue;
    }
    set TrueAltitude(value) {
        this.UpdateAltitude(value, AltitudeType.True);
    }

    static Clone(altitude) { // static Altitude Clone(Altitude altitude)
        let newAlt = new Altitude();
        newAlt.TransitionAltitude = altitude.TransitionAltitude;
        newAlt.#Altimeter = altitude.#Altimeter;
        newAlt.Value = altitude.Value;
        newAlt.AltitudeType = altitude.AltitudeType;
        return newAlt;
    }
    Clone() { // Altitude Clone()
        return Altitude.Clone(this);
    }

    // private object convertLockObject  -> lock() is a no-op in single-threaded JS; field dropped.

    constructor() { } // Altitude()

    SetAltitudeProperties(TransitionAltitude, Altimeter) {
        this.TransitionAltitude = TransitionAltitude;
        this.#Altimeter = Altimeter;
    }

    UpdateAltitude(Value, type) {
        // lock (convertLockObject)
        {
            this.Value = Value;
            this.AltitudeType = type;
        }
    }

    #Altimeter = new Altimeter(); // private Altimeter Altimeter = new Altimeter()
    ConvertTo(type) { // Altitude ConvertTo(AltitudeType type)
        let newAlt = new Altitude();
        // lock (convertLockObject)
        {
            if (type !== this.AltitudeType) {
                if (type === AltitudeType.Pressure) {
                    if (this.AltitudeType === AltitudeType.True) {
                        newAlt.Value = this.PressureAltitude;
                        newAlt.AltitudeType = AltitudeType.Pressure;
                    }
                }
                else if (type === AltitudeType.True) {
                    if (this.AltitudeType === AltitudeType.Pressure) {
                        newAlt.Value = this.TrueAltitude;
                        newAlt.AltitudeType = AltitudeType.True;
                    }
                }
                else {
                    throw new Error("NotImplementedException");
                }
            }
            else {
                newAlt.Value = this.Value;
                newAlt.AltitudeType = this.AltitudeType;
            }
            return newAlt;
        }
    }
    toString() {
        if (this.AltitudeType === AltitudeType.Pressure) {
            return `FL${Math.trunc(this.Value / 100).toString().padStart(3, '0')}`; // string.Format("FL{0}", (Value / 100).ToString("D3"))
        }
        return `${this.Value}ft.`; // string.Format("{0}ft.", Value)
    }
}

export const AltitudeType = Object.freeze({
    Pressure: 0,
    True: 1,
    Unknown: 2,
});
