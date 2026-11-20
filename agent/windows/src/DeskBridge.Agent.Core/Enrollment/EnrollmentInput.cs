namespace DeskBridge.Agent.Core.Enrollment;

/// <param name="RelayBase">HTTP(S) origin of the relay, used for the enroll request.</param>
/// <param name="WebSocketUri">Where the agent connects after enrolling.</param>
/// <param name="Code">Normalised one-time code (8 characters, no dash).</param>
public sealed record EnrollmentTarget(Uri RelayBase, Uri WebSocketUri, string Code)
{
    // The code is a credential until it is used: keep it out of logs.
    public override string ToString() => $"EnrollmentTarget {{ RelayBase = {RelayBase} }}";
}

/// <summary>Turns what the user pasted (an enrollment link, or a relay URL and a typed code) into a target.</summary>
public static class EnrollmentInput
{
    // Must match server/enrollmentCodes.ts.
    private const string Alphabet = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
    private const int CodeLength = 8;
    private const string EnrollPrefix = "/enroll/";

    public static bool TryParse(string? linkOrRelay, string? typedCode, out EnrollmentTarget? target, out string? error)
    {
        target = null;
        string input = (linkOrRelay ?? "").Trim();
        if (input.Length == 0)
        {
            error = "Paste the enrollment link from the Windows Host tab.";
            return false;
        }
        if (!input.Contains("://", StringComparison.Ordinal)) input = "https://" + input;

        if (!Uri.TryCreate(input, UriKind.Absolute, out Uri? uri) || uri.Host.Length == 0 ||
            uri.Scheme is not ("http" or "https" or "ws" or "wss"))
        {
            error = "That is not a DeskBridge link. It should look like https://your-relay/enroll/XXXX-XXXX.";
            return false;
        }

        bool secure = uri.Scheme is "https" or "wss";
        if (!secure && !uri.IsLoopback)
        {
            error = "The relay address must use https (plain http is only allowed for a relay on this PC).";
            return false;
        }

        string? rawCode = typedCode;
        string path = uri.AbsolutePath.TrimEnd('/');
        if (path.StartsWith(EnrollPrefix, StringComparison.OrdinalIgnoreCase))
        {
            rawCode = Uri.UnescapeDataString(path[EnrollPrefix.Length..]);
        }

        if (string.IsNullOrWhiteSpace(rawCode))
        {
            error = "Enter the 8-character enrollment code, or paste the full enrollment link.";
            return false;
        }
        string? code = NormalizeCode(rawCode);
        if (code is null)
        {
            error = "That enrollment code is not valid. Codes have 8 characters, like K7QM-4TXP.";
            return false;
        }

        string authority = uri.IsDefaultPort ? uri.Host : $"{uri.Host}:{uri.Port}";
        if (uri.HostNameType == UriHostNameType.IPv6) authority = uri.IsDefaultPort ? $"[{uri.Host}]" : $"[{uri.Host}]:{uri.Port}";
        target = new EnrollmentTarget(
            new Uri($"{(secure ? "https" : "http")}://{authority}/"),
            new Uri($"{(secure ? "wss" : "ws")}://{authority}/ws"),
            code);
        error = null;
        return true;
    }

    private static string? NormalizeCode(string raw)
    {
        Span<char> buf = stackalloc char[CodeLength];
        int n = 0;
        foreach (char ch in raw)
        {
            if (ch is '-' or ' ') continue;
            char c = char.ToUpperInvariant(ch);
            if (n == CodeLength || !Alphabet.Contains(c)) return null;
            buf[n++] = c;
        }
        return n == CodeLength ? new string(buf) : null;
    }
}
