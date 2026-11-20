using DeskBridge.Agent.Core.Input;
using DeskBridge.Agent.Windows.Input;
using Xunit;

namespace DeskBridge.Agent.Windows.Tests.Input;

public class InputWorkerTests
{
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(5);

    /// <summary>Records commands instead of sending input. The first call can be held open to build a backlog.</summary>
    private sealed class FakeInjector : IInputInjector
    {
        private readonly object _gate = new();
        private readonly List<InputCommand> _applied = new();
        private readonly bool _holdFirstCall;
        private readonly SemaphoreSlim _entered = new(0);
        private readonly ManualResetEventSlim _release = new(initialState: false);
        private int _calls;

        public FakeInjector(bool holdFirstCall = false) => _holdFirstCall = holdFirstCall;

        public IReadOnlyList<InputCommand> Applied
        {
            get
            {
                lock (_gate)
                {
                    return _applied.ToArray();
                }
            }
        }

        /// <summary>Blocks until the held first call has started.</summary>
        public bool WaitUntilEntered() => _entered.Wait(Timeout);

        public void Release() => _release.Set();

        public void Inject(InputCommand command)
        {
            bool first;
            lock (_gate)
            {
                _applied.Add(command);
                first = ++_calls == 1;
            }
            if (first && _holdFirstCall)
            {
                _entered.Release();
                _release.Wait(Timeout);
            }
        }
    }

    [Fact]
    public void Queued_relative_moves_are_summed_and_absolute_moves_keep_the_latest_position()
    {
        var injector = new FakeInjector(holdFirstCall: true);
        using var worker = new InputWorker(injector);
        using var applied = new SemaphoreSlim(0);
        worker.InputApplied += () => applied.Release();

        worker.TryEnqueue(new MouseMoveRelative(1, 1));
        Assert.True(injector.WaitUntilEntered());

        // The worker is busy, so everything below waits in the queue and is drained as one backlog.
        worker.TryEnqueue(new MouseMoveRelative(2, 2));
        worker.TryEnqueue(new MouseMoveRelative(3, 3));
        worker.TryEnqueue(new MouseMoveAbsolute(0.1, 0.1));
        worker.TryEnqueue(new MouseMoveAbsolute(0.5, 0.6));
        worker.TryEnqueue(new MouseMoveRelative(1, 0));
        injector.Release();

        // One signal per applied command: the first move, then the three drained entries.
        for (int i = 0; i < 4; i++)
        {
            Assert.True(applied.Wait(Timeout));
        }

        Assert.Equal(
            new InputCommand[]
            {
                new MouseMoveRelative(1, 1),
                new MouseMoveRelative(5, 5),
                new MouseMoveAbsolute(0.5, 0.6),
                new MouseMoveRelative(1, 0),
            },
            injector.Applied);
    }

    [Fact]
    public void Clicks_are_never_reordered_past_moves()
    {
        var injector = new FakeInjector(holdFirstCall: true);
        using var worker = new InputWorker(injector);
        using var applied = new SemaphoreSlim(0);
        worker.InputApplied += () => applied.Release();

        worker.TryEnqueue(new MouseMoveRelative(1, 1));
        Assert.True(injector.WaitUntilEntered());

        var click = new MouseClick(MouseButton.Left, false, null);
        worker.TryEnqueue(new MouseMoveRelative(2, 0));
        worker.TryEnqueue(click);
        worker.TryEnqueue(new MouseMoveRelative(3, 0));
        injector.Release();

        for (int i = 0; i < 4; i++)
        {
            Assert.True(applied.Wait(Timeout));
        }

        Assert.Equal(
            new InputCommand[] { new MouseMoveRelative(1, 1), new MouseMoveRelative(2, 0), click, new MouseMoveRelative(3, 0) },
            injector.Applied);
    }

    [Fact]
    public void An_injection_failure_is_reported_and_later_commands_still_apply()
    {
        var injector = new ThrowingOnceInjector();
        var errors = new List<Exception>();
        using var worker = new InputWorker(injector, errors.Add);
        using var applied = new SemaphoreSlim(0);
        worker.InputApplied += () => applied.Release();

        worker.TryEnqueue(new TypeText("first"));
        worker.TryEnqueue(new TypeText("second"));

        Assert.True(applied.Wait(Timeout));
        Assert.Equal(new InputCommand[] { new TypeText("second") }, injector.Applied);
        Assert.Single(errors);
    }

    [Fact]
    public void TryEnqueue_returns_false_after_dispose()
    {
        var worker = new InputWorker(new FakeInjector());
        worker.Dispose();

        Assert.False(worker.TryEnqueue(new MouseMoveRelative(1, 1)));
    }

    [Fact]
    public void Dispose_is_idempotent()
    {
        var worker = new InputWorker(new FakeInjector());
        worker.Dispose();
        worker.Dispose();
    }

    private sealed class ThrowingOnceInjector : IInputInjector
    {
        private readonly List<InputCommand> _applied = new();
        private bool _thrown;

        public IReadOnlyList<InputCommand> Applied => _applied;

        public void Inject(InputCommand command)
        {
            if (!_thrown)
            {
                _thrown = true;
                throw new InvalidOperationException("simulated SendInput failure");
            }
            _applied.Add(command);
        }
    }
}
