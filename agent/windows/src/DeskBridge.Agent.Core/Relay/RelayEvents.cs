using System.Text.Json;

namespace DeskBridge.Agent.Core.Relay;

public abstract record RelayEvent;

public sealed record RegisteredEvent(string HostId, string PairingCode, string PairingUrl, int ControllerCount) : RelayEvent;

public sealed record ControllerCountEvent(int Count) : RelayEvent;

public sealed record FrameAckEvent(long Seq, bool IsRelayAck) : RelayEvent;

public sealed record KeyframeRequestEvent : RelayEvent;

/// <summary>Raw <c>client:input</c> payload; parsing input types is a later slice.</summary>
public sealed record InputEvent(JsonElement Payload) : RelayEvent;

public sealed record AuthErrorEvent(string Message) : RelayEvent;

/// <summary>Why <see cref="RelayClient.RunAsync"/> returned.</summary>
public enum RelayStopReason
{
    Cancelled,
    /// <summary>The relay no longer knows this host (close 4403). Credentials were cleared; enroll again.</summary>
    Revoked,
}

/// <param name="Replaced">Close code 4409: a newer connection for this host id took over (likely a second agent).</param>
/// <param name="AuthRejected">Auth error or close code 4401.</param>
/// <param name="Revoked">Close code 4403: the host was removed or never enrolled. No retry follows.</param>
public sealed record DisconnectedEvent(
    string Reason,
    int? CloseCode,
    bool Replaced,
    bool AuthRejected,
    TimeSpan RetryIn,
    bool Revoked = false) : RelayEvent;
