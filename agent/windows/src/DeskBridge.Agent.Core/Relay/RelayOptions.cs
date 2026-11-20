using System.Text;
using System.Text.Json.Serialization;

namespace DeskBridge.Agent.Core.Relay;

/// <summary>Static connection settings. ToString never includes the enrollment key.</summary>
public sealed record RelayOptions(
    Uri RelayUri,
    string EnrollmentKey,
    string HostId,
    string Name,
    string GroupLabel)
{
    public const string AgentType = "windows-native";

    public TimeSpan RetryDelay { get; init; } = TimeSpan.FromSeconds(4);
    public TimeSpan AuthRejectedDelay { get; init; } = TimeSpan.FromSeconds(60);

    private bool PrintMembers(StringBuilder builder)
    {
        builder.Append("RelayUri = ").Append(RelayUri).Append(", HostId = ").Append(HostId)
            .Append(", Name = ").Append(Name).Append(", GroupLabel = ").Append(GroupLabel);
        return true;
    }
}

/// <summary>Monitor entry as accepted by the relay's sanitizeMonitors.</summary>
public sealed record MonitorModel(
    int Index,
    int X,
    int Y,
    int Width,
    int Height,
    bool Primary,
    string? Name = null);

/// <summary>What the caller knows about the screen at (re)connect time.</summary>
public sealed record RegistrationSnapshot(
    int ScreenWidth,
    int ScreenHeight,
    IReadOnlyList<MonitorModel> Monitors,
    int ActiveMonitor,
    string Os);
