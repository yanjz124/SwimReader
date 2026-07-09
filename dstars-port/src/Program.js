// Ported (STUB) from _source/Program.cs
// namespace DGScope
// The WinForms desktop entry point: [STAThread] Main -> OpenFileDialog facility-config picker ->
// PropertyForm / Application.Run(RadarWindow). The browser bootstraps RadarWindow differently (a
// host page creates the canvas + RadarWindow and starts the render loop), so the Main/Start dialog
// flow has no faithful browser analog and is stubbed. Non-UI helpers adapted.
import { RadarWindow } from "./RadarWindow.js";
import { XmlSerializer } from "./XmlSerializer.js";

export class Program { // static class Program
    static Start(screensaver = false, facilityConfig = null) {
        // OpenFileDialog/SaveFileDialog config picker + PropertyForm + radarWindow.Run(...):
        // desktop-only. The browser host bootstraps RadarWindow and calls Run itself. No-op here.
    }
    // [STAThread] static void Main(string[] args)
    static Main(args) {
        // EnableVisualStyles / SetCompatibleTextRenderingDefault / LoadReceiverPlugins /
        // --file/--config/--screensaver arg parsing -> desktop-only; browser entry is elsewhere.
    }

    static IsAdministrator() { // bool
        // WindowsIdentity/WindowsPrincipal admin check has no browser equivalent.
        return false;
    }

    static async TryLoad(facilityConfig) { // RadarWindow
        try {
            return await XmlSerializer.DeserializeFromFile(facilityConfig, RadarWindow); // XmlSerializer<RadarWindow>.DeserializeFromFile
        }
        catch (ex) {
            let radarWindow = new RadarWindow();
            console.log(ex.stack);
            console.log(facilityConfig + "\n" + ex.message); // MessageBox.Show(...) + Environment.Exit(1)
            return null;
        }
    }

    static LoadReceiverPlugins() {
        // Directory.GetFiles("DGScope.*.dll") + Assembly.LoadFile reflection to instantiate
        // Receiver plugins -> no filesystem/assembly reflection in the browser. No-op.
    }
}
