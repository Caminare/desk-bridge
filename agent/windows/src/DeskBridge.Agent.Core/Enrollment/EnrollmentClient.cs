using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace DeskBridge.Agent.Core.Enrollment;

public enum EnrollmentFailure
{
    /// <summary>Code unknown, expired or already used.</summary>
    InvalidCode,
    RateLimited,
    Unreachable,
    UnexpectedResponse,
}

public abstract record EnrollmentResult
{
    private EnrollmentResult() { }

    public sealed record Enrolled(string HostId, string HostSecret) : EnrollmentResult
    {
        public override string ToString() => $"Enrolled {{ HostId = {HostId} }}";
    }

    /// <param name="Message">Ready to show to the user.</param>
    public sealed record Failed(EnrollmentFailure Kind, string Message) : EnrollmentResult;
}

/// <summary>Exchanges a one-time enrollment code for this PC's host id and host secret.</summary>
public sealed class EnrollmentClient(HttpClient http)
{
    private static bool IsValidHostId(string id) =>
        id.Length is > 0 and <= 64 && id.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_' or '.');

    public async Task<EnrollmentResult> EnrollAsync(
        EnrollmentTarget target, string name, string? previousHostId, CancellationToken ct)
    {
        var body = new JsonObject { ["code"] = target.Code, ["name"] = name };
        if (!string.IsNullOrEmpty(previousHostId)) body["previousHostId"] = previousHostId;
        using var request = new HttpRequestMessage(HttpMethod.Post, new Uri(target.RelayBase, "api/agent/enroll"))
        {
            Content = new StringContent(body.ToJsonString(), Encoding.UTF8, new MediaTypeHeaderValue("application/json")),
        };

        HttpStatusCode status;
        string text;
        try
        {
            using var response = await http.SendAsync(request, ct).ConfigureAwait(false);
            status = response.StatusCode;
            text = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is HttpRequestException || (ex is TaskCanceledException && !ct.IsCancellationRequested))
        {
            return new EnrollmentResult.Failed(EnrollmentFailure.Unreachable,
                $"Could not reach the relay at {target.RelayBase.Host}. Check the address and your internet connection.");
        }

        JsonElement json = TryParseObject(text);
        string? relayError = Str(json, "error");
        switch (status)
        {
            case HttpStatusCode.OK:
                if (Str(json, "hostId") is { } hostId && IsValidHostId(hostId) && Str(json, "hostSecret") is { Length: > 0 } secret)
                    return new EnrollmentResult.Enrolled(hostId, secret);
                break;
            case HttpStatusCode.Unauthorized:
                return new EnrollmentResult.Failed(EnrollmentFailure.InvalidCode,
                    relayError ?? "This enrollment code is invalid, expired or already used. Create a new one in the Windows Host tab.");
            case HttpStatusCode.TooManyRequests:
                return new EnrollmentResult.Failed(EnrollmentFailure.RateLimited,
                    relayError ?? "Too many failed attempts. Try again in a few minutes.");
        }
        return new EnrollmentResult.Failed(EnrollmentFailure.UnexpectedResponse,
            $"The relay at {target.RelayBase.Host} gave an unexpected answer ({(int)status}). Is this a DeskBridge relay, and is it up to date?");
    }

    private static JsonElement TryParseObject(string text)
    {
        try
        {
            using var doc = JsonDocument.Parse(text);
            return doc.RootElement.ValueKind == JsonValueKind.Object ? doc.RootElement.Clone() : default;
        }
        catch (JsonException)
        {
            return default;
        }
    }

    private static string? Str(JsonElement obj, string name) =>
        obj.ValueKind == JsonValueKind.Object && obj.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString()
            : null;
}
