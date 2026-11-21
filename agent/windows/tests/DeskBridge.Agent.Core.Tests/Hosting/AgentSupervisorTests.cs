using System.Threading.Channels;
using DeskBridge.Agent.Core.Hosting;
using DeskBridge.Agent.Core.Relay;
using DeskBridge.Agent.Core.Status;
using Xunit;

namespace DeskBridge.Agent.Core.Tests.Hosting;

public sealed class AgentSupervisorTests
{
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(5);

    /// <summary>Records what the supervisor asks for and lets each test decide how runs and enrollments end.</summary>
    private sealed class FakeAgent : IAgentHost
    {
        public bool Enrolled { get; set; } = true;
        public List<string> Calls { get; } = [];
        public Channel<string> Started { get; } = Channel.CreateUnbounded<string>();
        public TaskCompletionSource<RelayStopReason>? CurrentRun { get; private set; }
        public TaskCompletionSource<bool>? CurrentEnroll { get; private set; }

        public bool IsEnrolled => Enrolled;

        public async Task<bool> EnrollAsync(bool keepHostId, CancellationToken ct)
        {
            Calls.Add(keepHostId ? "reenroll" : "enroll");
            var enroll = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            CurrentEnroll = enroll;
            await using var _ = ct.Register(() => enroll.TrySetResult(false));
            Started.Writer.TryWrite("enroll");
            bool ok = await enroll.Task;
            if (ok) Enrolled = true;
            return ok;
        }

        public async Task<RelayStopReason> RunAsync(CancellationToken ct)
        {
            Calls.Add("run");
            var run = new TaskCompletionSource<RelayStopReason>(TaskCreationOptions.RunContinuationsAsynchronously);
            CurrentRun = run;
            await using var _ = ct.Register(() => run.TrySetResult(RelayStopReason.Cancelled));
            Started.Writer.TryWrite("run");
            return await run.Task;
        }

        public void ForgetEnrollment()
        {
            Calls.Add("forget");
            Enrolled = false;
        }

        public async Task WaitFor(string what)
        {
            using var cts = new CancellationTokenSource(Timeout);
            Assert.Equal(what, await Started.Reader.ReadAsync(cts.Token));
        }
    }

    private readonly FakeAgent _agent = new();
    private readonly AgentStatusTracker _status = new();

    private AgentSupervisor Create() => new(_agent, _status, _ => { });

    [Fact]
    public async Task Enrolled_pc_runs_until_stopped()
    {
        var supervisor = Create();
        Task<SupervisorExit> done = supervisor.RunAsync(reenrollFirst: false);

        await _agent.WaitFor("run");
        Assert.Equal(AgentStatusKind.Connecting, _status.Current.Kind);
        supervisor.Stop();

        Assert.Equal(SupervisorExit.Stopped, await done.WaitAsync(Timeout));
        Assert.Equal(["run"], _agent.Calls);
    }

    [Fact]
    public async Task First_run_enrolls_then_runs()
    {
        _agent.Enrolled = false;
        var supervisor = Create();
        Task<SupervisorExit> done = supervisor.RunAsync(reenrollFirst: false);

        await _agent.WaitFor("enroll");
        Assert.Equal(AgentStatusKind.Enrolling, _status.Current.Kind);
        _agent.CurrentEnroll!.SetResult(true);
        await _agent.WaitFor("run");
        supervisor.Stop();

        await done.WaitAsync(Timeout);
        Assert.Equal(["enroll", "run"], _agent.Calls);
    }

    [Fact]
    public async Task Cancelling_the_first_enrollment_exits()
    {
        _agent.Enrolled = false;
        Task<SupervisorExit> done = Create().RunAsync(reenrollFirst: false);

        await _agent.WaitFor("enroll");
        _agent.CurrentEnroll!.SetResult(false);

        Assert.Equal(SupervisorExit.EnrollmentCancelled, await done.WaitAsync(Timeout));
    }

    [Fact]
    public async Task Pause_stops_the_run_and_resume_starts_a_new_one()
    {
        var supervisor = Create();
        Task<SupervisorExit> done = supervisor.RunAsync(reenrollFirst: false);
        await _agent.WaitFor("run");

        supervisor.Pause();
        await WaitUntil(() => _status.Current.Kind == AgentStatusKind.Paused);
        Assert.True(supervisor.IsPaused);
        Assert.Equal(["run"], _agent.Calls);

        supervisor.Resume();
        await _agent.WaitFor("run");
        Assert.False(supervisor.IsPaused);
        supervisor.Stop();

        await done.WaitAsync(Timeout);
        Assert.Equal(["run", "run"], _agent.Calls);
    }

    [Fact]
    public async Task Stop_while_paused_exits()
    {
        var supervisor = Create();
        Task<SupervisorExit> done = supervisor.RunAsync(reenrollFirst: false);
        await _agent.WaitFor("run");
        supervisor.Pause();
        await WaitUntil(() => _status.Current.Kind == AgentStatusKind.Paused);

        supervisor.Stop();

        Assert.Equal(SupervisorExit.Stopped, await done.WaitAsync(Timeout));
    }

    [Fact]
    public async Task Reenroll_keeps_the_host_id_and_runs_again()
    {
        var supervisor = Create();
        Task<SupervisorExit> done = supervisor.RunAsync(reenrollFirst: false);
        await _agent.WaitFor("run");

        supervisor.Reenroll();
        await _agent.WaitFor("enroll");
        _agent.CurrentEnroll!.SetResult(true);
        await _agent.WaitFor("run");
        supervisor.Stop();

        await done.WaitAsync(Timeout);
        Assert.Equal(["run", "reenroll", "run"], _agent.Calls);
    }

    [Fact]
    public async Task Cancelling_a_reenroll_resumes_with_the_old_credentials()
    {
        var supervisor = Create();
        Task<SupervisorExit> done = supervisor.RunAsync(reenrollFirst: true);

        await _agent.WaitFor("enroll");
        _agent.CurrentEnroll!.SetResult(false);
        await _agent.WaitFor("run");
        supervisor.Stop();

        await done.WaitAsync(Timeout);
        Assert.Equal(["reenroll", "run"], _agent.Calls);
    }

    [Fact]
    public async Task Reenroll_while_paused_unpauses()
    {
        var supervisor = Create();
        Task<SupervisorExit> done = supervisor.RunAsync(reenrollFirst: false);
        await _agent.WaitFor("run");
        supervisor.Pause();
        await WaitUntil(() => _status.Current.Kind == AgentStatusKind.Paused);

        supervisor.Reenroll();
        await _agent.WaitFor("enroll");
        _agent.CurrentEnroll!.SetResult(true);
        await _agent.WaitFor("run");
        supervisor.Stop();

        await done.WaitAsync(Timeout);
        Assert.False(supervisor.IsPaused);
    }

    [Fact]
    public async Task Revoked_forgets_the_credentials_and_enrolls_from_scratch()
    {
        var supervisor = Create();
        Task<SupervisorExit> done = supervisor.RunAsync(reenrollFirst: false);
        await _agent.WaitFor("run");

        _agent.CurrentRun!.SetResult(RelayStopReason.Revoked);
        await _agent.WaitFor("enroll");
        _agent.CurrentEnroll!.SetResult(true);
        await _agent.WaitFor("run");
        supervisor.Stop();

        await done.WaitAsync(Timeout);
        Assert.Equal(["run", "forget", "enroll", "run"], _agent.Calls);
    }

    [Fact]
    public async Task Stop_closes_an_open_enrollment()
    {
        _agent.Enrolled = false;
        var supervisor = Create();
        Task<SupervisorExit> done = supervisor.RunAsync(reenrollFirst: false);
        await _agent.WaitFor("enroll");

        supervisor.Stop();

        Assert.Equal(SupervisorExit.Stopped, await done.WaitAsync(Timeout));
    }

    [Fact]
    public async Task A_failing_run_is_reported_and_retried_rather_than_crashing()
    {
        var errors = new List<string>();
        var supervisor = new AgentSupervisor(_agent, _status, errors.Add, retryDelay: TimeSpan.FromMilliseconds(10));
        Task<SupervisorExit> done = supervisor.RunAsync(reenrollFirst: false);
        await _agent.WaitFor("run");

        _agent.CurrentRun!.SetException(new InvalidOperationException("boom"));
        await _agent.WaitFor("run");
        supervisor.Stop();

        await done.WaitAsync(Timeout);
        Assert.Contains(errors, e => e.Contains("boom"));
    }

    private static async Task WaitUntil(Func<bool> condition)
    {
        var deadline = DateTime.UtcNow + Timeout;
        while (!condition())
        {
            Assert.True(DateTime.UtcNow < deadline, "condition not reached");
            await Task.Delay(5);
        }
    }
}
