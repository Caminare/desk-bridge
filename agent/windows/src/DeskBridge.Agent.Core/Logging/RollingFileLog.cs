using System.Text;

namespace DeskBridge.Agent.Core.Logging;

/// <summary>
/// Append-only text log with one rotated predecessor (<c>agent.log</c> and <c>agent.log.1</c>), so a long-running
/// agent never grows its log without bound. Thread-safe; each line is flushed so the file can be tailed while the
/// agent runs (<c>Get-Content -Wait</c>). Callers must never pass secrets.
/// </summary>
public sealed class RollingFileLog : IDisposable
{
    private static readonly UTF8Encoding Utf8 = new(encoderShouldEmitUTF8Identifier: false);
    private readonly object _gate = new();
    private readonly string _path;
    private readonly long _maxBytes;
    private FileStream? _stream;

    public RollingFileLog(string path, long maxBytes)
    {
        _path = Path.GetFullPath(path);
        _maxBytes = maxBytes;
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        _stream = Open();
    }

    public string FilePath => _path;

    public void WriteLine(string line)
    {
        byte[] bytes = Utf8.GetBytes(line + Environment.NewLine);
        lock (_gate)
        {
            if (_stream is null) return;
            try
            {
                if (_stream.Length > 0 && _stream.Length + bytes.Length > _maxBytes) Rotate();
                _stream.Write(bytes);
                _stream.Flush();
            }
            catch (IOException)
            {
                // Disk full or the file was locked by another tool: losing a log line must not stop the agent.
            }
        }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            _stream?.Dispose();
            _stream = null;
        }
    }

    private void Rotate()
    {
        _stream!.Dispose();
        try
        {
            File.Move(_path, _path + ".1", overwrite: true);
        }
        finally
        {
            // Reopen even if the move failed (e.g. .1 open in an editor) so logging continues in the current file.
            _stream = Open();
        }
    }

    private FileStream Open() =>
        new(_path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete);
}
