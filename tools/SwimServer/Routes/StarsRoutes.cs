namespace SwimServer;

/// <summary>
/// STARS frontend routes: the scope SPA + vNAS profile REST.
///
/// Phase 1 ships: facility-picker landing page, scope page, vNAS profile
/// API. Subsequent phases append video map / track stream / DCB / etc.
/// </summary>
static class StarsRoutes
{
    public static void Register(WebApplication app, ServerContext ctx)
    {
        // Landing page: ARTCC + facility picker
        app.MapGet("/stars", async (HttpContext c) =>
        {
            c.Response.ContentType = "text/html";
            await c.Response.SendFileAsync(Path.Combine(ctx.WebRootPath, "stars", "index.html"));
        });

        // Scope page: /stars/{artcc}/{facility}. Inject a cache-busting version
        // (the newest mtime of the stars JS/CSS) into the asset refs so browsers
        // and the CDN always fetch the latest frontend — no manual ?v bumping or
        // hard-refreshes needed.
        app.MapGet("/stars/{artcc:regex(^[A-Za-z0-9]+$)}/{facility:regex(^[A-Za-z0-9]+$)}",
            async (HttpContext c, string artcc, string facility) =>
            {
                var dir = Path.Combine(ctx.WebRootPath, "stars");
                var html = await File.ReadAllTextAsync(Path.Combine(dir, "scope.html"));
                long ver = 0;
                foreach (var f in System.IO.Directory.EnumerateFiles(dir)
                             .Where(p => p.EndsWith(".js") || p.EndsWith(".css")))
                    ver = System.Math.Max(ver, File.GetLastWriteTimeUtc(f).Ticks);
                html = System.Text.RegularExpressions.Regex.Replace(
                    html, "(src|href)=\"([\\w.-]+\\.(?:js|css))\"", $"$1=\"$2?v={ver}\"");
                c.Response.Headers.CacheControl = "no-cache";
                c.Response.ContentType = "text/html";
                await c.Response.WriteAsync(html);
            });

        // ── vNAS profile REST ────────────────────────────────────────────────
        app.MapGet("/api/stars/artccs", async () =>
        {
            var ids = await ctx.Stars.GetArtccIdsAsync();
            return Results.Json(ids, ctx.JsonOpts);
        });

        app.MapGet("/api/stars/artcc/{artccId}", async (string artccId) =>
        {
            var fac = await ctx.Stars.GetStarsFacilitiesAsync(artccId);
            return fac is not null ? Results.Json(fac, ctx.JsonOpts) : Results.NotFound();
        });

        app.MapGet("/api/stars/facility/{artccId}/{facilityId}",
            async (string artccId, string facilityId) =>
            {
                var fac = await ctx.Stars.GetFacilityAsync(artccId, facilityId);
                return fac is not null ? Results.Json(fac, ctx.JsonOpts) : Results.NotFound();
            });

        // ── Phase 2: video maps ─────────────────────────────────────────────
        // Reads from CRC export tree on disk. See KNOWN-DEVIATIONS G10 for why
        // we can't fetch from vNAS directly. Layout: crc-export/{artcc}/VideoMaps/{mapId}.geojson
        app.MapGet("/api/stars/videoMap/{artccId}/{mapId}",
            async (string artccId, string mapId) =>
            {
                var content = await ctx.Stars.GetVideoMapGeoJsonAsync(artccId, mapId);
                if (content is null) return Results.NotFound(new { error = "map_not_in_crc_export", artccId, mapId });
                return Results.Bytes(content.Value.bytes, content.Value.contentType);
            });

        app.MapGet("/api/stars/videoMaps/{artccId}", (string artccId) =>
        {
            var ids = ctx.Stars.ListAvailableVideoMapIds(artccId);
            return Results.Json(new { artccId, available = ids, crcExportRoot = ctx.Stars.CrcExportRoot }, ctx.JsonOpts);
        });

        // (Removed: POST /api/stars/import-from-crc/{artccId}. It ran server-side
        // and only ever saw the *server's* %LOCALAPPDATA%/CRC folder — on the Pi
        // that surfaced JY's path to every viewer. Video maps are now served
        // exclusively from the crc-export tree; admins seed it via upload-export.)

        // DGScope profile XMLs from %LOCALAPPDATA%/DGScope Profile Manager/
        app.MapGet("/api/stars/profiles/{artccId}", (string artccId) =>
            Results.Json(new { artccId = artccId.ToUpperInvariant(),
                profiles = ctx.Stars.ListProfiles(artccId.ToUpperInvariant()) }, ctx.JsonOpts));

        // /api/stars/profile/{x}/{y} was previously registered both here (JSON,
        // vNAS-style) AND in StarsProfileRoutes.cs (XML, DGScope-style),
        // throwing AmbiguousMatchException on every GET. The XML one is the
        // documented public route; this vNAS variant is now at -json/.
        app.MapGet("/api/stars/profile-json/{artccId}/{profileName}",
            (string artccId, string profileName) =>
            {
                var p = ctx.Stars.LoadProfile(artccId.ToUpperInvariant(), profileName);
                return p is not null ? Results.Json(p, ctx.JsonOpts) : Results.NotFound();
            });

        // POST a CRC export ZIP — extracts under crc-export/{artccId}/.
        // multipart/form-data, fields: artccId, file
        app.MapPost("/api/stars/upload-export", async (HttpContext c) =>
        {
            if (!c.Request.HasFormContentType) return Results.BadRequest("expected multipart/form-data");
            var form = await c.Request.ReadFormAsync();
            var artccId = form["artccId"].ToString();
            if (string.IsNullOrEmpty(artccId)) return Results.BadRequest("artccId required");
            var file = form.Files["file"];
            if (file is null) return Results.BadRequest("file required");

            var dest = Path.Combine(ctx.Stars.CrcExportRoot, artccId);
            Directory.CreateDirectory(dest);
            await using (var s = file.OpenReadStream())
            {
                System.IO.Compression.ZipFile.ExtractToDirectory(s, dest, overwriteFiles: true);
            }
            var ids = ctx.Stars.ListAvailableVideoMapIds(artccId);
            return Results.Json(new { artccId, extracted = ids.Length, mapIds = ids }, ctx.JsonOpts);
        });
    }
}
