namespace SwimServer;

/// <summary>
/// STARS frontend routes: the scope SPA + vNAS profile REST.
///
/// Phase 1 ships: facility-picker landing page, scope page, vNAS profile
/// API. Subsequent phases append video map / track stream / DCB / etc.
/// </summary>
static class StarsRoutes
{
    // Where a scope request should go instead of the scope, or null to serve it.
    //
    // Before this, `/stars/{artcc}/{facility}` served the scope shell for any two strings — a
    // facility with no starsConfiguration (306 of them across 10 ARTCCs), a typo, or just a
    // lowercase id all produced a blank screen with no explanation. See the alias rule on
    // StarsBridge.Resolve for why DJT in particular looked like a video-map bug.
    private static async Task<string?> ScopeRedirect(
        ServerContext ctx, HttpContext c, string artcc, string facility, string basePath)
    {
        var r = await ctx.Stars.ResolveFacilityAsync(artcc, facility);
        var qs = c.Request.QueryString.HasValue ? c.Request.QueryString.Value! : "";

        // Back to the picker that matches the surface we came from (/stars or /starsv2), which is
        // already the right destination: it lists exactly the facilities that do have a config.
        string Notice(string msg) => $"{basePath}?notice=" + Uri.EscapeDataString(msg);

        switch (r.Status)
        {
            case StarsBridge.StarsFacilityStatus.Aliased:
                // DJT → PBI. Keep the query string so ?area=/?replay=/?profile= survive the hop.
                return $"{basePath}/{artcc.ToUpperInvariant()}/{r.AliasOf}{qs}";

            case StarsBridge.StarsFacilityStatus.NoStarsConfig:
                return Notice($"{r.FacilityId} ({r.Type ?? "unknown type"}) has no STARS "
                            + $"configuration in {artcc.ToUpperInvariant()}, so there is nothing to "
                            + "display. Pick a facility below.");

            case StarsBridge.StarsFacilityStatus.NotFound:
                return Notice($"{artcc.ToUpperInvariant()} has no facility \"{r.FacilityId}\". "
                            + "Pick a facility below.");

            case StarsBridge.StarsFacilityStatus.Ok:
                // Canonicalise the case so everything downstream — the scope's own
                // /api/stars/facility fetch, bookmarks, replay links — sees one spelling.
                var canonical = $"{basePath}/{artcc.ToUpperInvariant()}/{r.FacilityId}";
                return string.Equals(c.Request.Path.Value, canonical, StringComparison.Ordinal)
                    ? null : canonical + qs;

            default:
                return null;   // Unknown — vNAS unreachable; serve it rather than block it.
        }
    }

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
                if (await ScopeRedirect(ctx, c, artcc, facility, "/stars") is { } to)
                {
                    c.Response.Redirect(to);
                    return;
                }
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

        // ── STARS v2 (test surface): scope + in-browser DGScope profile manager ──
        // Not linked from the home page. Same scope assets as /stars plus profile-editor.js;
        // scope.js keys the editor off the /starsv2/ path. Bare /starsv2 serves the picker with
        // its facility links rewritten to /starsv2/.
        app.MapGet("/starsv2", async (HttpContext c) =>
        {
            var html = await File.ReadAllTextAsync(Path.Combine(ctx.WebRootPath, "stars", "index.html"));
            // Rewrite anchor navigations from /stars/ to /starsv2/ so picking a facility lands on v2.
            html = html.Replace("</body>",
                "<script>document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a[href^=\"/stars/\"]');" +
                "if(a){e.preventDefault();location.href=a.getAttribute('href').replace('/stars/','/starsv2/');}},true);</script></body>");
            c.Response.Headers.CacheControl = "no-cache";
            c.Response.ContentType = "text/html";
            await c.Response.WriteAsync(html);
        });
        app.MapGet("/starsv2/{artcc:regex(^[A-Za-z0-9]+$)}/{facility:regex(^[A-Za-z0-9]+$)}",
            async (HttpContext c, string artcc, string facility) =>
            {
                if (await ScopeRedirect(ctx, c, artcc, facility, "/starsv2") is { } to)
                {
                    c.Response.Redirect(to);
                    return;
                }
                var dir = Path.Combine(ctx.WebRootPath, "stars");
                var html = await File.ReadAllTextAsync(Path.Combine(dir, "starsv2.html"));
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

        // Resolve which ARTCC a STARS facility belongs to — lets a caller with only the facility id
        // (e.g. the incident STARS replay link) build the /stars/{artcc}/{facility} URL.
        app.MapGet("/api/stars/resolve/{facilityId}", async (string facilityId) =>
        {
            var artcc = await ctx.Stars.ResolveArtccForFacilityAsync(facilityId);
            return artcc is not null
                ? Results.Json(new { facilityId = facilityId.ToUpperInvariant(), artccId = artcc }, ctx.JsonOpts)
                : Results.NotFound(new { facilityId = facilityId.ToUpperInvariant(), error = "no_stars_artcc" });
        });

        // ── Phase 2: video maps ─────────────────────────────────────────────
        // Fetched from vNAS's public file store on demand and cached under
        // crc-export/{artcc}/VideoMaps/{mapId}.geojson; a cached file older than the published
        // lastUpdatedAt is refetched. (KNOWN-DEVIATIONS G10, which said the geometry wasn't
        // publicly served, was wrong — it was looking at the admin API.)
        app.MapGet("/api/stars/videoMap/{artccId}/{mapId}",
            async (string artccId, string mapId) =>
            {
                var content = await ctx.Stars.GetVideoMapGeoJsonAsync(artccId, mapId);
                if (content is null) return Results.NotFound(new { error = "map_unavailable", artccId, mapId });
                return Results.Bytes(content.Value.bytes, content.Value.contentType);
            });

        // When the mirror last checked itself against vNAS, and what it did about it.
        app.MapGet("/api/stars/videoMaps-sync", () => Results.Json(ctx.Stars.Sync, ctx.JsonOpts));

        app.MapGet("/api/stars/videoMaps/{artccId}", async (string artccId) =>
        {
            artccId = artccId.ToUpperInvariant();
            var cached    = ctx.Stars.ListAvailableVideoMapIds(artccId);
            var published = await ctx.Stars.ListPublishedVideoMapIdsAsync(artccId);
            // `available` is what the scope can actually draw — everything vNAS publishes, since
            // an uncached map is one fetch away. It falls back to the disk list if the catalog
            // couldn't be read, which is the only case where disk is the limit.
            return Results.Json(new
            {
                artccId,
                available = published.Length > 0 ? published : cached,
                published = published.Length,
                cached    = cached.Length,
                source    = published.Length > 0 ? "vnas" : "crc-export",
                crcExportRoot = ctx.Stars.CrcExportRoot,
            }, ctx.JsonOpts);
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
