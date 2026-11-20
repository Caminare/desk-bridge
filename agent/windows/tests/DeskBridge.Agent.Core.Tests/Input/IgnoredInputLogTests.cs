using System.Text.Json;
using DeskBridge.Agent.Core.Input;
using Xunit;

namespace DeskBridge.Agent.Core.Tests.Input;

public class IgnoredInputLogTests
{
    private static JsonElement Json(string json)
    {
        using JsonDocument doc = JsonDocument.Parse(json);
        return doc.RootElement.Clone();
    }

    [Fact]
    public void Logs_each_ignored_type_once()
    {
        var lines = new List<string>();
        var log = new IgnoredInputLog(lines.Add);
        log.Report(Json("""{"type":"launch","target":"notepad"}"""));
        log.Report(Json("""{"type":"launch","target":"calc"}"""));
        log.Report(Json("""{"type":"shell","command":"dir"}"""));
        Assert.Equal(["Ignoring input type 'launch' (not supported by this agent yet).", "Ignoring input type 'shell' (not supported by this agent yet)."], lines);
    }

    [Fact]
    public void Payloads_without_a_string_type_are_reported_as_malformed_once()
    {
        var lines = new List<string>();
        var log = new IgnoredInputLog(lines.Add);
        log.Report(Json("""{"x":1}"""));
        log.Report(Json("""42"""));
        Assert.Equal(["Ignoring malformed input."], lines);
    }

    [Fact]
    public void Long_or_odd_type_names_are_truncated_and_sanitised()
    {
        var lines = new List<string>();
        var log = new IgnoredInputLog(lines.Add);
        log.Report(Json($$"""{"type":"{{new string('a', 100)}}\n"}"""));
        Assert.Equal($"Ignoring input type '{new string('a', 32)}' (not supported by this agent yet).", Assert.Single(lines));
    }
}
