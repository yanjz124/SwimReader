// Ported 1:1 from _source/Receivers.cs
// namespace DGScope.Receivers
import { GeoPoint } from "./GeoPoint.js";
import { Aircraft } from "./Aircraft.js";

export class Receiver { // abstract class Receiver
    #enabled = false; // private bool enabled
    Name = null; // string
    get Enabled() { // bool
        return this.#enabled;
    }
    set Enabled(value) {
        if (value && this.aircraft != null) {
            this.Start();
        }
        else
            this.Stop();
        this.#enabled = value;
    }

    aircraft = null;                    // protected ObservableCollection<Aircraft>  -> Array
    Location = new GeoPoint(0, 0);      // GeoPoint
    Range = 250;                        // double
    CreateNewAircraft = true;           // bool
    Start() { throw new Error("abstract"); } // abstract void Start()
    Stop() { throw new Error("abstract"); }  // abstract void Stop()
    Restart(sleep = 0) {
        this.Stop();
        // System.Threading.Thread.Sleep(sleep);  (no synchronous blocking sleep in the browser; no-op)
        this.Start();
    }

    InRange(location, altitude) { // bool
        let distance = location.DistanceTo(this.Location);
        if (distance <= this.Range)
            return true;
        return false;
    }
    SetAircraftList(Aircraft) { // void SetAircraftList(ObservableCollection<Aircraft> Aircraft)
        this.aircraft = Aircraft;
        if (this.Enabled)
            this.Start();
    }
    SetWeatherRadarDisplay(weatherRadar) { // virtual void; NexradDisplay weatherRadar
    }

    // C# overloads distinguished by first-arg type, merged into one JS method:
    //   Aircraft GetPlane(Guid guid, bool createnew = false)
    //   Aircraft GetPlane(int icaoID, bool? createnew = null)
    GetPlane(id, createnew) {
        if (typeof id !== 'number') { // Guid overload
            const guid = id;
            if (createnew === undefined) createnew = false;
            let plane;
            // lock (aircraft)
            {
                plane = this.aircraft.filter(x => x.TrackGuid === guid)[0] ?? null; // FirstOrDefault
                if (plane == null && createnew) {
                    plane = new Aircraft(guid);
                    this.aircraft.push(plane);
                }
            }
            return plane;
        }
        // int icaoID overload
        const icaoID = id;
        if (createnew === undefined) createnew = null;
        if (createnew == null)
            createnew = this.CreateNewAircraft;
        let plane;
        // lock (aircraft)
        {
            plane = this.aircraft.filter(x => x.ModeSCode === icaoID)[0] ?? null; // FirstOrDefault
            if (plane == null && createnew === true) {
                plane = new Aircraft(icaoID);
                this.aircraft.push(plane);
            }
        }
        return plane;
    }

    GetPlaneBySquawk(squawk) { // Aircraft
        let plane = null;
        // lock (aircraft)
        {
            if (this.aircraft.filter(x => x.Squawk === squawk).length === 1)
                plane = this.aircraft.filter(x => x.Squawk === squawk)[0] ?? null; // FirstOrDefault
        }
        return plane;
    }

    Remove(plane) { // void Remove(Aircraft plane)
        // lock (aircraft)
        {
            this.aircraft.filter(x => x === plane).forEach(y => {
                const idx = this.aircraft.indexOf(y);
                if (idx >= 0) this.aircraft.splice(idx, 1); // aircraft.Remove(y)
            });
        }
    }
    toString() {
        return Object.prototype.toString.call(this); // base.ToString()
    }
}
