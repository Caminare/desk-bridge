using DeskBridge.Agent.Core.Displays;
using DeskBridge.Agent.Core.Enrollment;
using DeskBridge.Agent.Core.Hosting;
using DeskBridge.Agent.Core.Input;
using DeskBridge.Agent.Core.Relay;
using DeskBridge.Agent.Core.Status;
using DeskBridge.Agent.Core.Streaming;
using DeskBridge.Agent.Windows.Capture;
using DeskBridge.Agent.Windows.Encoding;
using DeskBridge.Agent.Windows.Host;
using DeskBridge.Agent.Windows.Input;

namespace DeskBridge.Agent.App;

/// <summary>The Windows implementation of what <see cref="AgentSupervisor"/> drives: enrollment window and streaming.</summary>
internal sealed class AgentHost(
    AgentStateFile stateFile,
    IHostSecretStore secrets,
    EnrollmentClient enrollment,
    AgentStatusTracker status,
    SynchronizationContext ui,
    string? perfLogPath,
    Action<string> log) : IAgentHost
{
    public bool IsEnrolled => stateFile.Load(out _).IsEnrolled && secrets.Load() is not null;

    public async Task<bool> EnrollAsync(bool keepHostId, CancellationToken ct)
    {
        AgentState state = stateFile.Load(out _);
        log(keepHostId ? $"Re-enrolling {state.HostId}." : "This PC is not enrolled. Opening the enrollment window.");
        EnrollmentOutcome? outcome = await OnUiThread(
            () => EnrollmentForm.ShowAsync(enrollment, state.Name, keepHostId ? state.HostId : null, ct)).ConfigureAwait(false);
        if (outcome is null)
        {
            log("Enrollment cancelled.");
            return false;
        }

        secrets.Save(outcome.Credentials.HostSecret);
        state = stateFile.Load(out _);
        state.RelayUrl = outcome.Target.WebSocketUri.ToString();
        state.HostId = outcome.Credentials.HostId;
        state.Name = outcome.Name;
        stateFile.Save(state);
        log($"Enrolled as {state.HostId} on {outcome.Target.RelayBase}.");
        return true;
    }

    public void ForgetEnrollment() => stateFile.ForgetEnrollment();

    public async Task<RelayStopReason> RunAsync(CancellationToken ct)
    {
        AgentState state = stateFile.Load(out string? stateError);
        if (stateError is not null) log(stateError);
        var options = new RelayOptions(state.RelayUri!, state.HostId, state.Name, state.GroupLabel);

        // Streams the primary monitor until the controller picks another; follows display changes.
        using var source = new SwitchableFrameSource(MonitorEnumerator.List, d => FrameSourceFactory.Create(d.Handle, log), log);
        using var encoder = new TurboJpegTileEncoder();
        log($"Capture: {source.Method} {DescribeMonitor(source.Active)}. Host id {state.HostId}. Relay {state.RelayUri}");

        var injector = new InputInjector(() =>
        {
            DisplayInfo d = source.Active;
            return (d.X, d.Y, d.Width, d.Height);
        });
        using var input = new InputWorker(injector, ex => log($"Input error: {ex.GetType().Name}"));

        var relay = new RelayClient(
            options,
            () =>
            {
                // Monitors may have changed while disconnected; a difference is sent as host:update right after.
                source.RequestRefresh();
                return source.Snapshot(Environment.OSVersion.VersionString);
            },
            secrets,
            new ClientWebSocketTransportFactory());
        source.DisplaysChanged += () =>
        {
            log($"Streaming {DescribeMonitor(source.Active)} ({source.Method}).");
            _ = SendHostUpdateAsync(relay, source.Update());
        };

        var ignoredInput = new IgnoredInputLog(log);
        using CsvPerfLog? perfLog = perfLogPath is null ? null : CsvPerfLog.Create(perfLogPath);
        if (perfLog is not null) log($"Writing per-frame timing to {Path.GetFullPath(perfLogPath!)}");

        var settings = new StreamSettings(state.MaxWidth, state.JpegQuality);
        StreamingEngine? engineRef = null;
        using var engine = new StreamingEngine(relay, source, encoder, settings,
            payload =>
            {
                switch (InputParser.Parse(payload))
                {
                    case SelectMonitor m:
                        // Applied by the capture thread; wake it so the switch shows promptly.
                        source.RequestMonitor(m.Index);
                        engineRef?.NotifyInputApplied();
                        break;
                    case { } command:
                        input.TryEnqueue(command);
                        break;
                    default:
                        ignoredInput.Report(payload);
                        break;
                }
            },
            log,
            perfLog is null ? null : new FramePerfOptions(perfLog, ThreadCycles.Current));
        engineRef = engine;
        input.InputApplied += engine.NotifyInputApplied;
        engine.ConnectionEvent += status.Apply;

        log("Running.");
        return await engine.RunAsync(ct).ConfigureAwait(false);
    }

    private Task<T> OnUiThread<T>(Func<Task<T>> action)
    {
        var done = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
        ui.Post(async _ =>
        {
            try
            {
                done.TrySetResult(await action());
            }
            catch (Exception ex)
            {
                done.TrySetException(ex);
            }
        }, null);
        return done.Task;
    }

    private static string DescribeMonitor(DisplayInfo d) =>
        $"{d.DeviceName} {d.Width}x{d.Height} at ({d.X},{d.Y}){(d.Primary ? " primary" : "")}";

    private async Task SendHostUpdateAsync(RelayClient relay, HostUpdatePayload update)
    {
        try
        {
            await relay.SendEventAsync("host:update", update).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            // Offline: the next host:register carries the current monitors anyway.
            log($"host:update not sent: {ex.GetType().Name}");
        }
    }
}
