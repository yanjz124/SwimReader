using System.Diagnostics;

namespace SwimServer;

/// <summary>
/// Runs the bundled SwimReader.Server (the STARS/DGScope feed on port 5000) as a child process,
/// so the desktop build is one thing to launch. The /dstars proxy in DgScopeRoutes expects it on
/// 127.0.0.1:5000. It lives in a stars/ folder beside the exe, which only the published package
/// has, so `dotnet run` and the Pi are unchanged. Its console output shares ours.
/// </summary>
static class StarsProcess
{
    const string Url = "http://127.0.0.1:5000";
    static Process? _child;

    public static void Start(IHostApplicationLifetime lifetime)
    {
        var exe = Path.Combine(AppContext.BaseDirectory, "stars", "SwimReader.Server.exe");
        if (!File.Exists(exe)) return;
        if (Environment.GetEnvironmentVariable("SWIM_NO_STARS") is "1" or "true") return;

        var psi = new ProcessStartInfo(exe)
        {
            WorkingDirectory = Path.GetDirectoryName(exe)!,
            UseShellExecute = false,
        };
        // Pin the port the proxy dials. Env is inherited, so the SCDSCONNECTION__* values that
        // Program.cs loaded from swimreader.config.json reach the child without a second copy.
        psi.Environment["ASPNETCORE_URLS"] = Url;

        try
        {
            _child = Process.Start(psi);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("[stars] could not start SwimReader.Server: " + ex.Message);
            return;
        }
        if (_child is null) return;

        Console.WriteLine($"[stars] SwimReader.Server started (pid {_child.Id}) on {Url}");
        _child.EnableRaisingEvents = true;
        _child.Exited += (_, _) =>
        {
            if (_child is not null)
                Console.Error.WriteLine($"[stars] SwimReader.Server exited (code {_child.ExitCode}); /dstars will 502 until restart");
        };

        lifetime.ApplicationStopping.Register(Stop);
        AppDomain.CurrentDomain.ProcessExit += (_, _) => Stop();
    }

    static void Stop()
    {
        var c = _child;
        _child = null;
        if (c is null) return;
        try { if (!c.HasExited) c.Kill(entireProcessTree: true); } catch { }
        c.Dispose();
    }
}
