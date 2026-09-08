using System.Collections.Concurrent;

namespace SwimServer;

/// <summary>
/// Incident/accident archive API. Create pins a callsign+area+window's replay data
/// (ERAM + ASDE-X + STARS/TAIS) and flight plan permanently (outside the budget-managed replay dir);
/// list/detail/delete manage them. Replay of an archived incident is served by
/// ReplayServer.MapIncidentEndpoints.
///
/// Archiving runs as a BACKGROUND JOB: the POST returns a jobId immediately and the extraction
/// continues server-side, so the client can leave the page and the archive still completes. An
/// identical in-flight request returns the same job (idempotent), so a double-click or a resubmit
/// never archives twice. GET .../jobs/{id} reports progress. Delete is gated behind the operator
/// reveal key.
/// </summary>
static class IncidentRoutes
{
    private sealed class Job
    {
        public string Id = "";
        public string Key = "";
        public volatile string Status = "running";   // running | done | error
        public volatile string Stage = "starting";
        public DateTime StartedUtc = DateTime.UtcNow;
        public DateTime? FinishedUtc;
        public object? Meta;
        public string? Error;
    }

    private static readonly ConcurrentDictionary<string, Job> _jobs = new();

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

        // Start a background archive job. Returns { jobId, status, stage } (202).
        app.MapPost("/api/incidents", async (HttpContext c) =>
        {
            IncidentRequest? req;
            try { req = await c.Request.ReadFromJsonAsync<IncidentRequest>(); }
            catch { return Results.BadRequest("malformed request"); }
            if (req is null) return Results.BadRequest("empty request");

            // Idempotency key — an identical request already running returns that same job, so a
            // double-click / back-then-resubmit doesn't archive the same window twice.
            var key = string.Join("|", req.Title, req.Callsign,
                string.Join(",", req.Airports ?? Array.Empty<string>()),
                req.AroundNm, req.MinLat, req.MinLon, req.MaxLat, req.MaxLon,
                req.StartUtc.ToString("o"), req.EndUtc.ToString("o"));
            var existing = _jobs.Values.FirstOrDefault(j => j.Status == "running" && j.Key == key);
            if (existing != null)
                return Results.Accepted($"/api/incidents/jobs/{existing.Id}",
                    new { jobId = existing.Id, status = existing.Status, stage = existing.Stage });

            PruneJobs();
            var job = new Job { Id = Guid.NewGuid().ToString("N")[..12], Key = key };
            _jobs[job.Id] = job;
            _ = Task.Run(() =>
            {
                try
                {
                    var meta = archive.Create(req, stage => job.Stage = stage);
                    job.Meta = meta; job.Stage = "done"; job.Status = "done";
                }
                catch (ArgumentException ex) { job.Error = ex.Message; job.Status = "error"; }
                catch (Exception ex) { job.Error = "archive failed: " + ex.Message; job.Status = "error"; }
                finally { job.FinishedUtc = DateTime.UtcNow; }
            });
            return Results.Accepted($"/api/incidents/jobs/{job.Id}",
                new { jobId = job.Id, status = job.Status, stage = job.Stage });
        });

        // Poll a background archive job.
        app.MapGet("/api/incidents/jobs/{jobId}", (string jobId) =>
        {
            if (!_jobs.TryGetValue(jobId, out var j)) return Results.NotFound();
            return Results.Json(new
            {
                jobId = j.Id,
                status = j.Status,
                stage = j.Stage,
                elapsedSec = (int)((j.FinishedUtc ?? DateTime.UtcNow) - j.StartedUtc).TotalSeconds,
                meta = j.Meta,
                error = j.Error,
            });
        });

        // Delete is privileged: only a request carrying the reveal/bypass key (the operator
        // "backdoor") may remove an archive. Ordinary visitors can create archives but never
        // delete them, so a public window can't be used to wipe preserved incidents.
        app.MapDelete("/api/incidents/{id}", (string id, HttpContext http) =>
        {
            if (!LaddService.Reveal(http)) return Results.StatusCode(403);
            return archive.Delete(id) ? Results.Ok(new { deleted = true }) : Results.NotFound();
        });
    }

    // Drop finished jobs after a grace period so a client that navigated away can still read the
    // result when it comes back, without the map growing without bound.
    private static void PruneJobs()
    {
        var cutoff = DateTime.UtcNow.AddMinutes(-15);
        foreach (var kv in _jobs)
            if (kv.Value.FinishedUtc is { } f && f < cutoff) _jobs.TryRemove(kv.Key, out _);
    }
}
