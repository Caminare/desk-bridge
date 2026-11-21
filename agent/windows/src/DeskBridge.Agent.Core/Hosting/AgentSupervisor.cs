using DeskBridge.Agent.Core.Relay;
using DeskBridge.Agent.Core.Status;

namespace DeskBridge.Agent.Core.Hosting;

/// <summary>The agent's real work, kept behind an interface so the supervisor's state machine is testable.</summary>
public interface IAgentHost
{
    /// <summary>Saved host id and secret are both present.</summary>
    bool IsEnrolled { get; }

    /// <summary>Shows the enrollment window. True once new credentials are saved; false if the user cancelled.</summary>
    /// <param name="keepHostId">Re-enroll: send the current host id so the relay reuses it.</param>
    Task<bool> EnrollAsync(bool keepHostId, CancellationToken ct);

    /// <summary>Connects and streams until cancelled or revoked.</summary>
    Task<RelayStopReason> RunAsync(CancellationToken ct);

    void ForgetEnrollment();
}

public enum SupervisorExit
{
    Stopped,
    /// <summary>The PC had no credentials and the user closed the enrollment window.</summary>
    EnrollmentCancelled,
}

/// <summary>
/// The agent's lifecycle: enroll when needed, run, and react to the tray (pause, resume, re-enroll, quit) and to the
/// relay revoking this PC. Commands may come from any thread; each cancels the current run and the loop decides
/// what comes next. An open enrollment window is only closed by <see cref="Stop"/>.
/// </summary>
public sealed class AgentSupervisor
{
    private readonly IAgentHost _host;
    private readonly AgentStatusTracker _status;
    private readonly Action<string> _log;
    private readonly TimeSpan _retryDelay;
    private readonly CancellationTokenSource _stop = new();
    private readonly SemaphoreSlim _wake = new(0);
    private readonly object _gate = new();
    private CancellationTokenSource? _run;
    private bool _paused;
    private bool _reenroll;

    public AgentSupervisor(IAgentHost host, AgentStatusTracker status, Action<string> log, TimeSpan? retryDelay = null)
    {
        _host = host;
        _status = status;
        _log = log;
        _retryDelay = retryDelay ?? TimeSpan.FromSeconds(10);
    }

    public bool IsPaused
    {
        get { lock (_gate) return _paused; }
    }

    public void Pause() => Command(() => _paused = true);

    public void Resume() => Command(() => _paused = false);

    public void Reenroll() => Command(() =>
    {
        _reenroll = true;
        _paused = false;
    });

    public void Stop()
    {
        _stop.Cancel();
        _wake.Release();
    }

    public async Task<SupervisorExit> RunAsync(bool reenrollFirst)
    {
        lock (_gate) _reenroll = reenrollFirst;
        CancellationToken stop = _stop.Token;
        while (!stop.IsCancellationRequested)
        {
            bool paused, reenroll;
            lock (_gate)
            {
                paused = _paused;
                reenroll = _reenroll;
                _reenroll = false;
            }

            if (reenroll || !_host.IsEnrolled)
            {
                bool wasEnrolled = _host.IsEnrolled;
                _status.SetEnrolling();
                bool enrolled = await EnrollAsync(reenroll && wasEnrolled, stop).ConfigureAwait(false);
                if (stop.IsCancellationRequested) break;
                if (!enrolled && !wasEnrolled) return SupervisorExit.EnrollmentCancelled;
                // Cancelled re-enroll: carry on with the credentials we already have.
                continue;
            }

            if (paused)
            {
                _status.SetPaused();
                await WaitForCommandAsync(stop).ConfigureAwait(false);
                continue;
            }

            _status.SetConnecting();
            await RunOnceAsync(stop).ConfigureAwait(false);
        }
        return SupervisorExit.Stopped;
    }

    private void Command(Action change)
    {
        lock (_gate)
        {
            change();
            _run?.Cancel();
        }
        _wake.Release();
    }

    private async Task<bool> EnrollAsync(bool keepHostId, CancellationToken stop)
    {
        try
        {
            return await _host.EnrollAsync(keepHostId, stop).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (stop.IsCancellationRequested)
        {
            return false;
        }
        catch (Exception ex)
        {
            _log($"Enrollment failed: {ex.GetType().Name}: {ex.Message}");
            return false;
        }
    }

    private async Task RunOnceAsync(CancellationToken stop)
    {
        using var run = CancellationTokenSource.CreateLinkedTokenSource(stop);
        lock (_gate)
        {
            // A command that arrived between reading the state and getting here still applies.
            if (_paused || _reenroll) return;
            _run = run;
        }
        try
        {
            RelayStopReason reason = await _host.RunAsync(run.Token).ConfigureAwait(false);
            if (reason == RelayStopReason.Revoked) _host.ForgetEnrollment();
        }
        catch (OperationCanceledException) when (run.IsCancellationRequested)
        {
        }
        catch (Exception ex)
        {
            _log($"Agent stopped unexpectedly: {ex.GetType().Name}: {ex.Message}. Restarting in {_retryDelay.TotalSeconds:0}s.");
            try
            {
                await Task.Delay(_retryDelay, run.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
            }
        }
        finally
        {
            lock (_gate) _run = null;
        }
    }

    private async Task WaitForCommandAsync(CancellationToken stop)
    {
        try
        {
            await _wake.WaitAsync(stop).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
        }
    }
}
