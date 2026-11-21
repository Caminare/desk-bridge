using System.Diagnostics;
using DeskBridge.Agent.Core.Enrollment;
using DeskBridge.Agent.Core.Hosting;
using DeskBridge.Agent.Core.Power;
using DeskBridge.Agent.Core.Startup;
using DeskBridge.Agent.Core.Status;

namespace DeskBridge.Agent.App;

/// <summary>
/// The agent's only UI while running: a tray icon whose colour shows the connection state, a notification when a
/// controller connects, and a menu for keep-awake, autostart, pause, re-enroll, logs and quit. Lives on the UI thread;
/// status changes from the agent threads are marshalled here.
/// </summary>
internal sealed class TrayApp : ApplicationContext
{
    private readonly AgentSupervisor _supervisor;
    private readonly AgentStatusTracker _status;
    private readonly KeepAwakeController _keepAwake;
    private readonly AgentStateFile _stateFile;
    private readonly Autostart _autostart;
    private readonly string _version;
    private readonly Action<string> _log;

    private readonly TrayIcons _icons = new();
    private readonly NotifyIcon _tray = new();
    private readonly ContextMenuStrip _menu = new();
    private readonly ToolStripMenuItem _statusItem = new() { Enabled = false };
    private readonly ToolStripMenuItem _keepAwakeItem = new("Keep PC awake");
    private readonly ToolStripMenuItem _autostartItem = new("Start with Windows");
    private readonly ToolStripMenuItem _pauseItem = new("Pause sharing");
    private readonly ToolStripMenuItem _reenrollItem = new("Re-enroll...");
    private bool _quitting;

    public TrayApp(AgentSupervisor supervisor, AgentStatusTracker status, KeepAwakeController keepAwake,
        AgentStateFile stateFile, Autostart autostart, string version, Action<string> log)
    {
        _supervisor = supervisor;
        _status = status;
        _keepAwake = keepAwake;
        _stateFile = stateFile;
        _autostart = autostart;
        _version = version;
        _log = log;

        _keepAwakeItem.Click += (_, _) => ToggleKeepAwake();
        _autostartItem.Click += (_, _) => ToggleAutostart();
        _pauseItem.Click += (_, _) => TogglePause();
        _reenrollItem.Click += (_, _) => _supervisor.Reenroll();
        _menu.Items.AddRange([
            _statusItem,
            new ToolStripSeparator(),
            _keepAwakeItem,
            _autostartItem,
            _pauseItem,
            new ToolStripSeparator(),
            _reenrollItem,
            new ToolStripMenuItem("Open log folder", null, (_, _) => OpenLogFolder()),
            new ToolStripMenuItem("About DeskBridge agent", null, (_, _) => ShowAbout()),
            new ToolStripSeparator(),
            new ToolStripMenuItem("Quit", null, (_, _) => Quit()),
        ]);
        _menu.Opening += (_, _) => RefreshMenu();
        // Forces the handle so BeginInvoke works before the menu is first opened.
        _ = _menu.Handle;

        _tray.ContextMenuStrip = _menu;
        _tray.DoubleClick += (_, _) => ShowAbout();
        Render(_status.Current);
        _tray.Visible = true;

        _status.Changed += _ => OnUi(() => Render(_status.Current));
        _status.ControllerJoined += count => OnUi(() => NotifyControllerJoined(count));
    }

    /// <summary>Called once the supervisor has finished (quit, or first enrollment cancelled).</summary>
    public void Exit() => OnUi(ExitThread);

    public void Quit()
    {
        if (_quitting) return;
        _quitting = true;
        _log("Quit from the tray.");
        _statusItem.Text = "Stopping...";
        _tray.Text = "DeskBridge: stopping";
        _supervisor.Stop();
    }

    protected override void ExitThreadCore()
    {
        _tray.Visible = false;
        _tray.Dispose();
        _menu.Dispose();
        _icons.Dispose();
        base.ExitThreadCore();
    }

    private void OnUi(Action action)
    {
        if (_menu.IsDisposed) return;
        try
        {
            _menu.BeginInvoke(action);
        }
        catch (InvalidOperationException)
        {
            // Shutting down: the handle is gone.
        }
    }

    private void Render(AgentStatus status)
    {
        if (_quitting) return;
        _tray.Icon = _icons.For(status.Kind);
        // NotifyIcon.Text is limited to 127 characters.
        string text = $"DeskBridge: {status.Summary}";
        _tray.Text = text.Length > 127 ? text[..127] : text;
        _statusItem.Text = status.Summary;
    }

    private void NotifyControllerJoined(int count)
    {
        if (_quitting) return;
        string who = count == 1 ? "A controller has" : $"{count} controllers have";
        _tray.ShowBalloonTip(5_000, "DeskBridge: remote session started",
            $"{who} connected. This screen is being shared and can be controlled remotely.", ToolTipIcon.Info);
    }

    private void RefreshMenu()
    {
        bool enrolling = _status.Current.Kind == AgentStatusKind.Enrolling;
        _keepAwakeItem.Checked = _keepAwake.Enabled;
        _autostartItem.Checked = _autostart.IsEnabled;
        _pauseItem.Text = _supervisor.IsPaused ? "Resume sharing" : "Pause sharing";
        _pauseItem.Enabled = !enrolling && !_quitting;
        _reenrollItem.Enabled = !enrolling && !_quitting;
    }

    private void ToggleKeepAwake()
    {
        bool on = !_keepAwake.Enabled;
        _keepAwake.SetEnabled(on, Environment.TickCount64);
        AgentState state = _stateFile.Load(out _);
        state.KeepAwake = on;
        _stateFile.Save(state);
        _log(on ? "Keep-awake on: the PC and display stay awake and unlocked while the agent runs." : "Keep-awake off.");
    }

    private void ToggleAutostart()
    {
        bool on = !_autostart.IsEnabled;
        try
        {
            _autostart.SetEnabled(on);
            _log(on ? "Start with Windows on." : "Start with Windows off.");
        }
        catch (Exception ex) when (ex is UnauthorizedAccessException or System.Security.SecurityException or IOException)
        {
            _log($"Could not change Start with Windows: {ex.GetType().Name}");
            MessageBox.Show($"Could not change Start with Windows: {ex.Message}", "DeskBridge", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    private void TogglePause()
    {
        if (_supervisor.IsPaused)
        {
            _log("Sharing resumed from the tray.");
            _supervisor.Resume();
        }
        else
        {
            _log("Sharing paused from the tray.");
            _supervisor.Pause();
        }
    }

    private static void OpenLogFolder()
    {
        string? folder = AgentLog.FilePath is { } path ? Path.GetDirectoryName(path) : null;
        if (folder is null || !Directory.Exists(folder)) return;
        Process.Start(new ProcessStartInfo { FileName = folder, UseShellExecute = true });
    }

    private void ShowAbout()
    {
        AgentState state = _stateFile.Load(out _);
        AgentStatus status = _status.Current;
        var lines = new List<string>
        {
            $"DeskBridge agent {_version}",
            "",
            $"Status: {status.Summary}",
            $"PC name: {state.Name}",
            $"Host id: {(state.IsEnrolled ? state.HostId : "not enrolled")}",
            $"Relay: {(state.IsEnrolled ? state.RelayUrl : "-")}",
        };
        if (status.PairingCode is not null) lines.Add($"Pairing code: {status.PairingCode}");
        if (status.PairingUrl is not null) lines.Add($"Pairing link: {status.PairingUrl}");
        if (AgentLog.FilePath is { } log) lines.Add($"Log: {log}");
        MessageBox.Show(string.Join(Environment.NewLine, lines), "About DeskBridge agent", MessageBoxButtons.OK, MessageBoxIcon.Information);
    }
}
