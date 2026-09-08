namespace SwimServer;

/// <summary>
/// Incident/accident archive API. Create pins a callsign+area+window's replay data (ERAM + ASDE-X)
/// and flight plan permanently (outside the budget-managed replay dir); list/detail/delete manage them.
/// Replay of an archived incident is served by ReplayServer.MapIncidentEndpoints.
/// </summary>
static class IncidentRoutes
{
    public static void Register(WebApplication app, IncidentArchive archive)
    {
        app.MapGet("/api/incidents", () => Results.Json(archive.List()));

        app.MapGet("/api/incidents/{id}", (string id) =>
        {
            var m = archive.ReadMeta(id);
            return m is null ? Results.NotFound() : Results.Json(m);
        });

        app.MapGet("/api/incidents/{id}/flightplan", (string id) =>
        {
            var p = archive.FlightPlanPath(id);
            return p is null ? Results.NotFound() : Results.File(p, "application/json");
        });

        app.MapPost("/api/incidents", async (HttpContext c) =>
        {
            IncidentRequest? req;
            try { req = await c.Request.ReadFromJsonAsync<IncidentRequest>(); }
            catch { return Results.BadRequest("malformed request"); }
            if (req is null) return Results.BadRequest("empty request");
            try
            {
                // Extraction is I/O-bound over the replay files — run off the request thread.
                var meta = await Task.Run(() => archive.Create(req));
                return Results.Json(meta);
            }
            catch (ArgumentException ex) { return Results.BadRequest(ex.Message); }
            catch (Exception ex) { return Results.Problem("archive failed: " + ex.Message); }
        });

        app.MapDelete("/api/incidents/{id}", (string id) =>
            archive.Delete(id) ? Results.Ok(new { deleted = true }) : Results.NotFound());
    }
}
