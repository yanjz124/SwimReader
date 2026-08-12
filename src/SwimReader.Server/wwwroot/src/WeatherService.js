// Ported 1:1 from _source/WeatherService.cs
// namespace DGScope
// csharp_metar_decoder -> _shims/MetarDecoder.js (external lib stub). WebClient.DownloadString ->
// fetch().text(). Task.Run(fire-and-forget) -> call the async method without awaiting.
import { DecodedMetar, MetarDecoder, Value } from "./_shims/MetarDecoder.js";

const MIN_DATE = () => new Date(-8640000000000000);
const fiveMinAgo = () => new Date(Date.now() - 5 * 60 * 1000); // DateTime.Now.AddMinutes(-5)

export class WeatherService { // internal class WeatherService
    #_altimeterStations = []; // List<string>
    get AltimeterStations() { return this.#_altimeterStations; }
    set AltimeterStations(value) {
        this.#_altimeterStations = value;
        this.#correctioncalculated = false;
        this.GetWeather(true); // fire-and-forget
    }

    #_altimeterCorrection = 0; // int

    get Metars() { // List<DecodedMetar>
        this.GetWeather(false); // Task.Run(() => GetWeather(false))  (fire-and-forget)
        return this.#parsedMetars.filter(x => this.AltimeterStations.includes(x.ICAO));
    }
    #correctioncalculated = false; // bool
    #altimeter; // Altimeter
    get Altimeter() { // Altimeter
        if (!this.#correctioncalculated || this.#lastMetarUpdate < fiveMinAgo()) {
            let totalaltimeter = 0;
            let metarscount = this.Metars.length; // Metars.Count
            if (this.Metars.length > 0) {
                for (const metar of this.Metars) {
                    try {
                        if (metar.Pressure != null)
                            totalaltimeter += metar.Pressure.GetConvertedValue(Value.Unit.MercuryInch);
                        else
                            metarscount--;
                    }
                    catch (e) {
                        metarscount--;
                    }
                }
                totalaltimeter /= metarscount;
            }
            else {
                totalaltimeter = 29.92;
            }
            if (this.#altimeter == null)
                this.#altimeter = new Altimeter();

            this.#altimeter.Value = totalaltimeter;
        }
        return this.#altimeter;
    }

    get AltimeterCorrection() { // int
        if (!this.#correctioncalculated || this.#lastMetarUpdate < fiveMinAgo()) {
            let totalaltimeter = 0;
            let metarscount = this.Metars.length;
            if (this.Metars.length > 0) {
                for (const metar of this.Metars) {
                    try {
                        totalaltimeter += metar.Pressure.GetConvertedValue(Value.Unit.MercuryInch);
                    }
                    catch (e) {
                        metarscount--;
                    }
                }
                totalaltimeter /= metarscount;
            }
            else {
                totalaltimeter = 29.92;
            }
            this.#_altimeterCorrection = Math.trunc((totalaltimeter - 29.92) * 1000);
            this.#correctioncalculated = true;
        }
        return this.#_altimeterCorrection;
    }

    #lastMetarUpdate = MIN_DATE(); // DateTime lastMetarUpdate = DateTime.MinValue
    #parsedMetars = []; // List<DecodedMetar>
    #gettingWx = false; // bool
    async GetWeather(force = false) { // async Task<bool>
        if ((this.#lastMetarUpdate < fiveMinAgo() || force) && !this.#gettingWx) {
            this.#gettingWx = true;
            let tempMetars = []; // List<DecodedMetar>
            let metars = await this.GetBulkAsync();
            this.#lastMetarUpdate = new Date();
            this.#parsedMetars = metars.filter(x => x.IsValid);
            this.#correctioncalculated = false;
        }
        this.#gettingWx = false;
        return true;
    }

    async GetBulkAsync() { // async Task<List<DecodedMetar>>
        let list = []; // List<DecodedMetar>
        try {
            let url = "https://aviationweather.gov/api/data/metar?ids=" + this.AltimeterStations.join(",");
            {
                // WebClient.DownloadString(url) -> fetch().text()
                let s = await (await fetch(url)).text();
                let metars = s.split(/\r\n|\r|\n/); // Regex.Split(s, "\r\n|\r|\n")
                for (const metar of metars) {
                    try {
                        list.push(MetarDecoder.ParseWithMode(metar));
                    }
                    catch (ex) {
                        console.log(ex);
                    }
                }
            }
        }
        catch (ex) {
            console.log(ex);
        }
        return list;
    }
}

export class Altimeter {
    Value = 29.92; // double
}
