using System.Diagnostics;

namespace SwimServer;

/// <summary>
/// Reports the currently-deployed git commit (short hash + commit time) by reading the repo
/// live, so the homepage can show "what's live" — including after frontend-only deploys that
/// don't restart the server. Cached briefly to avoid spawning git on every request.
/// </summary>
static class VersionInfo
{
    private static readonly object _lock = new();
    private static string _commit = "";
    private static string _commitTime = "";
    private static DateTime _readAt = DateTime.MinValue;

    public static object Get(string repoRoot)
    {
        lock (_lock)
        {
            if ((DateTime.UtcNow - _readAt).TotalSeconds > 20)
            {
                try
                {
                    _commit = RunGit(repoRoot, "rev-parse --short HEAD");
                    _commitTime = RunGit(repoRoot, "show -s --format=%cI HEAD");
                    _readAt = DateTime.UtcNow;
                }
                catch { /* keep last good values */ }
            }
            return new { commit = _commit, commitTime = _commitTime };
        }
    }

    private static string RunGit(string dir, string args)
    {
        var psi = new ProcessStartInfo("git", args)
        {
            WorkingDirectory = dir,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        using var p = Process.Start(psi)!;
        var output = p.StandardOutput.ReadToEnd().Trim();
        p.WaitForExit(3000);
        return output;
    }
}
