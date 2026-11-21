namespace DeskBridge.Agent.Core.Startup;

/// <summary>The per-user Run key (<c>HKCU\Software\Microsoft\Windows\CurrentVersion\Run</c>) or a fake.</summary>
public interface IRunKey
{
    string? Get(string name);

    void Set(string name, string value);

    void Delete(string name);
}

/// <summary>
/// Opt-in "Start with Windows" through the per-user Run key: no admin, and the user can see and disable it in Task
/// Manager's startup apps. It counts as on only when the value points at this exe, so a portable exe that was moved
/// shows as off until the user ticks it again.
/// </summary>
public sealed class Autostart(IRunKey key, string exePath)
{
    public const string ValueName = "DeskBridge Agent";

    public bool IsEnabled =>
        key.Get(ValueName) is { } value
        && string.Equals(value.Trim().Trim('"'), exePath, StringComparison.OrdinalIgnoreCase);

    public void SetEnabled(bool enabled)
    {
        if (enabled) key.Set(ValueName, $"\"{exePath}\"");
        else if (key.Get(ValueName) is not null) key.Delete(ValueName);
    }
}
