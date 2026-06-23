namespace SwimServer;

/// <summary>
/// STARS profile XML loader. Serves the user's DGScope profile files
/// (the same XML format the WPF app reads from
/// %LOCALAPPDATA%\DGScope Profile Manager\profiles\profiles\{ARTCC}\{FACILITY}.xml)
/// so the web port honours their per-facility colour/brightness/Nexrad
/// preferences instead of guessing.
///
/// Server scans a per-deploy `stars-profiles/{ARTCC}/{FACILITY}.xml`
/// directory (gitignored — each operator copies their own profiles in).
/// Client parses the XML and applies fields to the JS prefSet.
/// </summary>
static class StarsProfileRoutes
{
    public static void Register(WebApplication app, ServerContext ctx)
    {
        // List all profiles the server can find. Used by the SITE submenu.
        app.MapGet("/api/stars/profiles", () =>
        {
            var root = ProfileRoot();
            if (root is null || !Directory.Exists(root))
                return Results.Json(new { root = (string?)null, profiles = Array.Empty<object>() });
            var list = new List<object>();
            foreach (var artccDir in Directory.EnumerateDirectories(root))
            {
                var artcc = Path.GetFileName(artccDir);
                foreach (var f in Directory.EnumerateFiles(artccDir, "*.xml"))
                    list.Add(new {
                        artcc,
                        name  = Path.GetFileNameWithoutExtension(f),
                        bytes = new FileInfo(f).Length,
                    });
            }
            return Results.Json(new { root, profiles = list }, ctx.JsonOpts);
        });

        // Fetch one profile's raw XML — client parses it client-side via
        // DOMParser. We do NOT parse server-side because the format is
        // verbose XmlSerializer output of DGScope's RadarWindow class —
        // mapping the full graph in C# would be wasted work when DOM
        // parsing in JS is one line.
        app.MapGet("/api/stars/profile/{artcc}/{name}", (string artcc, string name) =>
        {
            // Path traversal guard — only ASCII alnum + . - _ permitted.
            if (!IsSafeName(artcc) || !IsSafeName(name))
                return Results.BadRequest("invalid artcc/name");
            var root = ProfileRoot();
            if (root is null) return Results.NotFound("profile root not configured");
            var path = Path.Combine(root, artcc, name + ".xml");
            if (!File.Exists(path)) return Results.NotFound();
            // Serve as text/xml so DOMParser picks it up cleanly. ETag from
            // mtime + length avoids re-shipping the (potentially 200 KB)
            // file on every page load.
            var fi  = new FileInfo(path);
            var etag = $"\"{fi.LastWriteTimeUtc.Ticks:x}-{fi.Length:x}\"";
            return Results.File(path, "application/xml", entityTag: new Microsoft.Net.Http.Headers.EntityTagHeaderValue(etag));
        });
    }

    // Resolve profile root from STARS_PROFILE_ROOT env var, else
    // <repo>/stars-profiles (works for local dev where SwimServer runs from
    // tools/SwimServer/ and the repo root is two levels up).
    static string? ProfileRoot()
    {
        var env = Environment.GetEnvironmentVariable("STARS_PROFILE_ROOT");
        if (!string.IsNullOrEmpty(env)) return env;
        var cwd = Directory.GetCurrentDirectory();
        // Walk up until we find stars-profiles/ or hit the root.
        var dir = new DirectoryInfo(cwd);
        while (dir != null)
        {
            var candidate = Path.Combine(dir.FullName, "stars-profiles");
            if (Directory.Exists(candidate)) return candidate;
            dir = dir.Parent;
        }
        return null;
    }

    static bool IsSafeName(string s)
        => s.Length > 0 && s.Length <= 64
           && s.All(c => char.IsLetterOrDigit(c) || c is '.' or '-' or '_');
}
