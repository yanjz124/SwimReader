namespace SwimReader.Scds.Configuration;

/// <summary>
/// Configuration options for connecting to FAA SCDS via Solace SMF over TLS.
/// Bind from "ScdsConnection" config section or environment variables.
/// </summary>
public sealed class ScdsConnectionOptions
{
    public const string SectionName = "ScdsConnection";

    public string Host { get; set; } = "tcps://ems2.swim.faa.gov:55443";
    public string Username { get; set; } = string.Empty;
    public string Password { get; set; } = string.Empty;
    public string MessageVpn { get; set; } = "STDDS";
    public string QueueName { get; set; } = string.Empty;

    /// <summary>
    /// Reconnect delay after connection loss.
    /// </summary>
    public TimeSpan ReconnectDelay { get; set; } = TimeSpan.FromSeconds(5);

    /// <summary>
    /// Maximum reconnect attempts before giving up (0 = infinite).
    /// </summary>
    public int MaxReconnectAttempts { get; set; } = 0;
}
