using DeskBridge.Agent.Core.Logging;
using Xunit;

namespace DeskBridge.Agent.Core.Tests.Logging;

public sealed class RollingFileLogTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "deskbridge-log-" + Guid.NewGuid().ToString("N"));
    private string LogPath => Path.Combine(_dir, "logs", "agent.log");

    public void Dispose()
    {
        if (Directory.Exists(_dir)) Directory.Delete(_dir, recursive: true);
    }

    private static string Read(string path)
    {
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }

    [Fact]
    public void Creates_the_folder_and_appends_lines_readable_while_open()
    {
        using var log = new RollingFileLog(LogPath, maxBytes: 1_000);

        log.WriteLine("first");
        log.WriteLine("second");

        Assert.Equal($"first{Environment.NewLine}second{Environment.NewLine}", Read(LogPath));
    }

    [Fact]
    public void Appends_to_an_existing_log_across_runs()
    {
        using (var log = new RollingFileLog(LogPath, maxBytes: 1_000)) log.WriteLine("run 1");
        using (var log = new RollingFileLog(LogPath, maxBytes: 1_000)) log.WriteLine("run 2");

        Assert.Equal($"run 1{Environment.NewLine}run 2{Environment.NewLine}", Read(LogPath));
    }

    [Fact]
    public void Rotates_to_a_single_previous_file_when_the_cap_is_reached()
    {
        using var log = new RollingFileLog(LogPath, maxBytes: 20);

        log.WriteLine("aaaaaaaaaa"); // 12 bytes with CRLF
        log.WriteLine("bbbbbbbbbb"); // would pass 20: rotate first
        log.WriteLine("cccccccccc"); // rotate again, the "a" file is gone

        Assert.Equal($"cccccccccc{Environment.NewLine}", Read(LogPath));
        Assert.Equal($"bbbbbbbbbb{Environment.NewLine}", Read(LogPath + ".1"));
        Assert.Equal(2, Directory.GetFiles(Path.GetDirectoryName(LogPath)!).Length);
    }

    [Fact]
    public void Concurrent_writers_never_interleave_inside_a_line()
    {
        using var log = new RollingFileLog(LogPath, maxBytes: 10_000_000);

        Parallel.For(0, 400, i => log.WriteLine($"line {i:D4} {new string('x', 40)}"));

        string[] lines = Read(LogPath).Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries);
        Assert.Equal(400, lines.Length);
        Assert.All(lines, l => Assert.Matches(@"^line \d{4} x{40}$", l));
    }

    [Fact]
    public void Writing_after_dispose_is_ignored()
    {
        var log = new RollingFileLog(LogPath, maxBytes: 1_000);
        log.Dispose();

        log.WriteLine("late");

        Assert.Equal("", Read(LogPath));
    }
}
