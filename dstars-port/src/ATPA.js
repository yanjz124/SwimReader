// Ported 1:1 from _source/ATPA.cs
// namespace DGScope
// Threading adapted: Task.WaitAll -> await Promise.all; Task.Run(f) -> Promise.resolve().then(f);
// lock -> no-op. C# collection initializer -> SerializableDictionary(entries).
import { SerializableDictionary } from "./SerializableDictionary.js";
import { ATPAVolume } from "./ATPAVolume.js";
import { RadarWindow } from "./RadarWindow.js";

export class ATPA {
    #active = false; // bool active = false
    RequiredSeparation = new SeparationTable(); // SeparationTable
    Volumes = [];         // List<ATPAVolume>
    ExcludedACIDs = [];   // List<string>
    ExcludedSSRCodes = []; // List<BeaconCodeRange>
    get Active() { return this.#active; } // bool
    set Active(value) {
        if (value === this.#active) {
            return;
        }
        else {
            this.#active = value;
            if (!value) {
                // lock (RadarWindow.Aircraft)
                {
                    RadarWindow.Aircraft.forEach(x => ATPAVolume.ResetAircraftATPAValues(x, true)); // .ToList().ForEach(...)
                }
            }
        }
    }

    constructor() {
        // Set up 7110.126B CWT table (collection initializers -> SerializableDictionary(entries))
        // B Following
        this.RequiredSeparation.Add("B", new SerializableDictionary([["A", 5], ["B", 3], ["D", 3]]));
        // C Following
        this.RequiredSeparation.Add("C", new SerializableDictionary([["A", 6], ["B", 4], ["D", 4]]));
        // D Following
        this.RequiredSeparation.Add("D", new SerializableDictionary([["A", 6], ["B", 4], ["D", 4]]));
        // E Following
        this.RequiredSeparation.Add("E", new SerializableDictionary([["A", 7], ["B", 5], ["C", 3.5], ["D", 5]]));
        // F Following
        this.RequiredSeparation.Add("F", new SerializableDictionary([["A", 7], ["B", 5], ["C", 3.5], ["D", 5]]));
        // G Following
        this.RequiredSeparation.Add("G", new SerializableDictionary([["A", 7], ["B", 5], ["C", 3.5], ["D", 5]]));
        // H Following
        this.RequiredSeparation.Add("H", new SerializableDictionary([["A", 8], ["B", 5], ["C", 5], ["D", 5]]));
        // I Following
        this.RequiredSeparation.Add("I", new SerializableDictionary([["A", 8], ["B", 5], ["C", 5], ["D", 5], ["E", 4]]));
    }

    #calculating = false; // private bool calculating = false
    async Calculate(aircraftList, radar) { // async Task Calculate(ICollection<Aircraft> aircraftList, Radar radar)
        let aircraft; // List<Aircraft>
        if (!this.#calculating) {
            // lock (aircraftList)
            aircraft = [...aircraftList]; // aircraftList.ToList()
            this.#calculating = true;
            let tasks; // Task[]
            // lock (Volumes)
            {
                let tasklist = []; // List<Task>
                for (const volume of this.Volumes) {
                    tasklist.push(ATPA.#CalculateATPA(volume, aircraft, this, radar));
                }
                tasks = tasklist; // .ToArray()
            }
            await Promise.all(tasks); // Task.WaitAll(tasks)
            this.#calculating = false;
        }
    }

    static #CalculateATPA(volume, aircraft, atpa, radar) { // private static Task
        return Promise.resolve().then(() => volume.CalculateATPA(aircraft, atpa, radar)); // Task.Run(() => ...)
    }
}

// class SeparationTable : SerializableDictionary<string, SerializableDictionary<string, double>>
export class SeparationTable extends SerializableDictionary { }

export const ATPAStatus = Object.freeze({
    Monitor: 1,
    Caution: 2,
    Alert: 3,
});
