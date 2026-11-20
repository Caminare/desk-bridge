using DeskBridge.Agent.Core.Enrollment;
using Xunit;

namespace DeskBridge.Agent.Core.Tests.Enrollment;

public sealed class AgentStateFileTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("deskbridge-state-").FullName;
    private string PathIn => Path.Combine(_dir, "nested", "agent.json");

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    [Fact]
    public void Missing_file_loads_defaults_and_is_not_enrolled()
    {
        var state = new AgentStateFile(PathIn).Load(out var error);
        Assert.Null(error);
        Assert.False(state.IsEnrolled);
        Assert.Equal(Environment.MachineName, state.Name);
        Assert.Equal(1152, state.MaxWidth);
        Assert.Equal(62, state.JpegQuality);
    }

    [Fact]
    public void Saved_enrollment_round_trips()
    {
        var file = new AgentStateFile(PathIn);
        file.Save(new AgentState { RelayUrl = "wss://relay.example/ws", HostId = "pc-1234abcd", Name = "Office", GroupLabel = "Lab", MaxWidth = 1600, JpegQuality = 70 });

        var state = file.Load(out var error);
        Assert.Null(error);
        Assert.True(state.IsEnrolled);
        Assert.Equal(new Uri("wss://relay.example/ws"), state.RelayUri);
        Assert.Equal("pc-1234abcd", state.HostId);
        Assert.Equal("Office", state.Name);
        Assert.Equal("Lab", state.GroupLabel);
        Assert.Equal(1600, state.MaxWidth);
        Assert.Equal(70, state.JpegQuality);
    }

    [Fact]
    public void Forgetting_clears_the_enrollment_but_keeps_preferences()
    {
        var file = new AgentStateFile(PathIn);
        file.Save(new AgentState { RelayUrl = "wss://relay.example/ws", HostId = "pc-1", Name = "Office", MaxWidth = 1600 });

        file.ForgetEnrollment();

        var state = file.Load(out _);
        Assert.False(state.IsEnrolled);
        Assert.Equal("", state.HostId);
        Assert.Equal("Office", state.Name);
        Assert.Equal(1600, state.MaxWidth);
    }

    [Fact]
    public void Phase_0_config_with_an_enrollment_key_is_not_enrolled_and_the_key_is_dropped_on_save()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(PathIn)!);
        File.WriteAllText(PathIn, """{"relayUrl":"wss://relay.example/ws","enrollKey":"long-lived-key","name":"Dev"}""");
        var file = new AgentStateFile(PathIn);

        var state = file.Load(out var error);
        Assert.Null(error);
        Assert.False(state.IsEnrolled);
        Assert.Equal("Dev", state.Name);

        file.Save(state);
        Assert.DoesNotContain("long-lived-key", File.ReadAllText(PathIn));
    }

    [Theory]
    [InlineData("{not json")]
    [InlineData("[]")]
    public void Corrupt_file_reports_an_error_and_is_not_enrolled(string content)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(PathIn)!);
        File.WriteAllText(PathIn, content);
        var state = new AgentStateFile(PathIn).Load(out var error);
        Assert.NotNull(error);
        Assert.False(state.IsEnrolled);
    }

    [Theory]
    [InlineData("https://relay.example/ws", "pc-1")]   // must be a WebSocket URL
    [InlineData("wss://relay.example/ws", "bad id!")]
    [InlineData("", "pc-1")]
    public void Invalid_relay_or_host_id_is_not_enrolled(string relayUrl, string hostId)
    {
        var file = new AgentStateFile(PathIn);
        file.Save(new AgentState { RelayUrl = relayUrl, HostId = hostId });
        Assert.False(file.Load(out _).IsEnrolled);
    }
}
