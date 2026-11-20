using DeskBridge.Agent.Core.Enrollment;
using Xunit;

namespace DeskBridge.Agent.Core.Tests.Enrollment;

public class EnrollmentInputTests
{
    private static EnrollmentTarget Ok(string? linkOrRelay, string? code = null)
    {
        Assert.True(EnrollmentInput.TryParse(linkOrRelay, code, out var target, out var error), error);
        return target!;
    }

    private static string Fails(string? linkOrRelay, string? code = null)
    {
        Assert.False(EnrollmentInput.TryParse(linkOrRelay, code, out var target, out var error));
        Assert.Null(target);
        return error!;
    }

    [Fact]
    public void Enrollment_link_gives_relay_base_websocket_uri_and_code()
    {
        var t = Ok("https://relay.example.com/enroll/K7QM-4TXP");
        Assert.Equal(new Uri("https://relay.example.com/"), t.RelayBase);
        Assert.Equal(new Uri("wss://relay.example.com/ws"), t.WebSocketUri);
        Assert.Equal("K7QM4TXP", t.Code);
    }

    [Fact]
    public void Link_keeps_a_non_default_port_and_tolerates_whitespace_and_trailing_slash()
    {
        var t = Ok("  https://relay.example.com:8443/enroll/k7qm-4txp/ \r\n");
        Assert.Equal(new Uri("https://relay.example.com:8443/"), t.RelayBase);
        Assert.Equal(new Uri("wss://relay.example.com:8443/ws"), t.WebSocketUri);
        Assert.Equal("K7QM4TXP", t.Code);
    }

    [Theory]
    [InlineData("https://relay.example.com")]
    [InlineData("relay.example.com")]
    [InlineData("wss://relay.example.com/ws")]
    [InlineData("https://relay.example.com/")]
    public void Relay_url_plus_typed_code(string relay)
    {
        var t = Ok(relay, "k7qm 4txp");
        Assert.Equal(new Uri("https://relay.example.com/"), t.RelayBase);
        Assert.Equal(new Uri("wss://relay.example.com/ws"), t.WebSocketUri);
        Assert.Equal("K7QM4TXP", t.Code);
    }

    [Fact]
    public void Plain_http_is_allowed_only_for_a_local_relay()
    {
        var local = Ok("http://localhost:3000/enroll/K7QM-4TXP");
        Assert.Equal(new Uri("ws://localhost:3000/ws"), local.WebSocketUri);
        Ok("http://127.0.0.1:3000", "K7QM4TXP");

        Assert.Contains("https", Fails("http://relay.example.com/enroll/K7QM-4TXP"));
    }

    [Fact]
    public void Missing_code_is_reported()
    {
        Assert.Contains("code", Fails("https://relay.example.com"), StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [InlineData("K7QM-4TX")]      // too short
    [InlineData("K7QM-4TXPP")]    // too long
    [InlineData("IIII-OOOO")]     // look-alike characters are never issued
    [InlineData("K7QM_4TXP")]
    public void Malformed_codes_are_rejected(string code)
    {
        Assert.Contains("code", Fails("https://relay.example.com", code), StringComparison.OrdinalIgnoreCase);
        Assert.Contains("code", Fails($"https://relay.example.com/enroll/{code}"), StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("ftp://relay.example.com/enroll/K7QM-4TXP")]
    [InlineData("not a url at all")]
    public void Unusable_relay_input_is_rejected(string? input)
    {
        Fails(input, "K7QM4TXP");
    }

    [Fact]
    public void Error_messages_never_echo_the_code()
    {
        var error = Fails("http://relay.example.com/enroll/K7QM-4TXP");
        Assert.DoesNotContain("K7QM", error);
    }
}
