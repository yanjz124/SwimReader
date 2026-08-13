using Microsoft.Extensions.Options;
using SwimReader.Core.Bus;
using SwimReader.Parsers;
using SwimReader.Parsers.Apds;
using SwimReader.Parsers.Ismc;
using SwimReader.Parsers.Smes;
using SwimReader.Parsers.Tais;
using SwimReader.Parsers.Tdes;
using SwimReader.Scds;
using SwimReader.Scds.Configuration;
using SwimReader.Scds.Connection;
using SwimReader.Server.Adapters;
using SwimReader.Server.AdsbFi;
using SwimReader.Server.Streaming;

// Load .env file into environment variables (search upward from working directory)
static void LoadEnvFile()
{
    var dir = new DirectoryInfo(Directory.GetCurrentDirectory());
    while (dir is not null)
    {
        var envFile = Path.Combine(dir.FullName, ".env");
        if (File.Exists(envFile))
        {
            foreach (var line in File.ReadAllLines(envFile))
            {
                var trimmed = line.Trim();
                if (string.IsNullOrEmpty(trimmed) || trimmed.StartsWith('#'))
                    continue;
                var idx = trimmed.IndexOf('=');
                if (idx > 0)
                    Environment.SetEnvironmentVariable(trimmed[..idx].Trim(), trimmed[(idx + 1)..].Trim());
            }
            return;
        }
        dir = dir.Parent;
    }
}
LoadEnvFile();

var builder = WebApplication.CreateBuilder(args);

// --- Configuration ---
builder.Services.Configure<ScdsConnectionOptions>(
    builder.Configuration.GetSection(ScdsConnectionOptions.SectionName));

// --- Core services ---
builder.Services.AddSingleton<IEventBus, ChannelEventBus>();

// --- SCDS connection ---
builder.Services.AddSingleton<ScdsConnectionManager>();
builder.Services.AddHostedService<ScdsHostedService>();

// --- Parsers ---
builder.Services.AddSingleton<IStddsMessageParser, TaisMessageParser>();
builder.Services.AddSingleton<IStddsMessageParser, TdesMessageParser>();
builder.Services.AddSingleton<IStddsMessageParser, SmesMessageParser>();
builder.Services.AddSingleton<IStddsMessageParser, ApdsMessageParser>();
builder.Services.AddSingleton<IStddsMessageParser, IsmcMessageParser>();
builder.Services.AddSingleton<ParserPipeline>();
builder.Services.AddHostedService<ParserPipelineHostedService>();

// --- DGScope adapter ---
builder.Services.AddSingleton<TrackStateManager>();
builder.Services.AddSingleton<ClientConnectionManager>();
builder.Services.AddSingleton<SwimReader.Server.Profile.ProfileStore>();
// Register as both singleton and hosted service so the controller can
// resolve it for snapshot-on-connect.
builder.Services.AddSingleton<DgScopeAdapter>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<DgScopeAdapter>());
// Persist track + flight-plan state across restarts (periodic + on shutdown);
// the matching load runs below, before app.Run(), so it precedes Solace data.
builder.Services.AddHostedService<DgScopePersistenceService>();

// Optional raw-XML diagnostic tap. Activates only when RAW_MESSAGE_LOG_PATH
// env var is set; lets us spot-check that the parser+adapter aren't dropping
// fields the upstream feed actually carries (e.g. <ident>, manual SPCs).
builder.Services.AddHostedService<SwimReader.Server.RawMessageLogger>();

// --- ADS-B hybrid enrichment (adsb.fi + adsb.lol + airplanes.live) ---
builder.Services.Configure<AdsbFiOptions>(
    builder.Configuration.GetSection(AdsbFiOptions.SectionName));

// Register HTTP clients for all 3 ADS-B APIs (same v2 response format)
builder.Services.AddHttpClient("AdsbFi", client =>
{
    client.BaseAddress = new Uri("https://opendata.adsb.fi/api/");
    client.DefaultRequestHeaders.UserAgent.ParseAdd("SwimReader/1.0");
    client.Timeout = TimeSpan.FromSeconds(10);
});
builder.Services.AddHttpClient("AdsbLol", client =>
{
    client.BaseAddress = new Uri("https://api.adsb.lol/");
    client.DefaultRequestHeaders.UserAgent.ParseAdd("SwimReader/1.0");
    client.Timeout = TimeSpan.FromSeconds(10);
});
builder.Services.AddHttpClient("AirplanesLive", client =>
{
    client.BaseAddress = new Uri("https://api.airplanes.live/");
    client.DefaultRequestHeaders.UserAgent.ParseAdd("SwimReader/1.0");
    client.Timeout = TimeSpan.FromSeconds(10);
});

builder.Services.AddSingleton<AdsbFiClient>();
builder.Services.AddSingleton<MultiAdsbClient>();
builder.Services.AddSingleton<AdsbFiCache>();

var adsbFiConfig = builder.Configuration.GetSection(AdsbFiOptions.SectionName).Get<AdsbFiOptions>();
if (adsbFiConfig?.Enabled == true)
{
    if (adsbFiConfig.CallsignEnrichmentEnabled)
        builder.Services.AddHostedService<CallsignEnrichmentService>();

    if (adsbFiConfig.MilitaryInjectionEnabled)
        builder.Services.AddHostedService<MilitaryInjectionService>();
}

// --- ASP.NET Core ---
builder.Services.AddControllers();

var app = builder.Build();

// Restore persisted dStars state BEFORE the host starts processing Solace data,
// so the first connecting client sees full prior state (callsign/owner/history)
// and fresh positions re-associate with the saved flight plans by GUID.
SwimReader.Server.Adapters.DgScopePersistence.Load(
    app.Services.GetRequiredService<SwimReader.Server.Adapters.TrackStateManager>(),
    app.Services.GetRequiredService<SwimReader.Server.Adapters.DgScopeAdapter>(),
    SwimReader.Server.Adapters.DgScopePersistence.ResolvePath(),
    app.Services.GetRequiredService<ILogger<SwimReader.Server.Adapters.DgScopeAdapter>>());

app.UseWebSockets();
app.MapControllers();

app.MapGet("/", () => "SwimReader STDDS Server - GET /health for status, /dstars/{facility}/updates for data");

app.Run();

/// <summary>
/// Wraps ParserPipeline as a BackgroundService for DI hosting.
/// </summary>
internal sealed class ParserPipelineHostedService : BackgroundService
{
    private readonly ParserPipeline _pipeline;

    public ParserPipelineHostedService(ParserPipeline pipeline) => _pipeline = pipeline;

    protected override Task ExecuteAsync(CancellationToken stoppingToken)
        => _pipeline.RunAsync(stoppingToken);
}
