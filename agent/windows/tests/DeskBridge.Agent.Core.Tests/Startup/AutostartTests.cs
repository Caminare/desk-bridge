using DeskBridge.Agent.Core.Startup;
using Xunit;

namespace DeskBridge.Agent.Core.Tests.Startup;

public sealed class AutostartTests
{
    private sealed class FakeRunKey : IRunKey
    {
        public Dictionary<string, string> Values { get; } = new(StringComparer.OrdinalIgnoreCase);

        public string? Get(string name) => Values.GetValueOrDefault(name);

        public void Set(string name, string value) => Values[name] = value;

        public void Delete(string name) => Values.Remove(name);
    }

    private const string Exe = @"C:\Users\me\Tools\DeskBridge.Agent.exe";
    private readonly FakeRunKey _key = new();

    [Fact]
    public void Off_when_there_is_no_run_value()
    {
        Assert.False(new Autostart(_key, Exe).IsEnabled);
    }

    [Fact]
    public void Enable_writes_the_quoted_exe_path_and_reads_back_as_on()
    {
        var autostart = new Autostart(_key, Exe);

        autostart.SetEnabled(true);

        Assert.Equal($"\"{Exe}\"", _key.Values[Autostart.ValueName]);
        Assert.True(autostart.IsEnabled);
    }

    [Fact]
    public void A_value_for_a_moved_exe_reads_as_off_and_enabling_repoints_it()
    {
        _key.Set(Autostart.ValueName, @"""D:\Old\DeskBridge.Agent.exe""");
        var autostart = new Autostart(_key, Exe);

        Assert.False(autostart.IsEnabled);
        autostart.SetEnabled(true);
        Assert.True(autostart.IsEnabled);
    }

    [Fact]
    public void Matches_paths_case_insensitively_and_without_quotes()
    {
        _key.Set(Autostart.ValueName, Exe.ToUpperInvariant());

        Assert.True(new Autostart(_key, Exe).IsEnabled);
    }

    [Fact]
    public void Disable_removes_the_value()
    {
        var autostart = new Autostart(_key, Exe);
        autostart.SetEnabled(true);

        autostart.SetEnabled(false);
        autostart.SetEnabled(false);

        Assert.Empty(_key.Values);
        Assert.False(autostart.IsEnabled);
    }
}
