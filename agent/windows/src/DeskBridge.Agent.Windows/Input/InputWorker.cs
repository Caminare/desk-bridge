using System.Threading.Channels;
using DeskBridge.Agent.Core.Input;

namespace DeskBridge.Agent.Windows.Input;

/// <summary>
/// Applies input on a dedicated thread so capture or a slow send never delays a click. Each drain
/// coalesces the queued backlog before injecting it.
/// </summary>
public sealed class InputWorker : IDisposable
{
    private static readonly TimeSpan JoinTimeout = TimeSpan.FromSeconds(2);

    private readonly Channel<InputCommand> _queue = Channel.CreateUnbounded<InputCommand>(
        new UnboundedChannelOptions { SingleReader = true });
    private readonly IInputInjector _injector;
    private readonly Action<Exception>? _onError;
    private readonly CancellationTokenSource _stop = new();
    private readonly Thread _thread;

    /// <summary>
    /// Raised on the worker thread after each injected (possibly coalesced) command. Subscribers
    /// must return quickly. The capture scheduler uses this to wake capture shortly after input.
    /// </summary>
    public event Action? InputApplied;

    public InputWorker(IInputInjector injector, Action<Exception>? onError = null)
    {
        _injector = injector;
        _onError = onError;
        _thread = new Thread(Run) { IsBackground = true, Name = "DeskBridge input" };
        _thread.Start();
    }

    /// <summary>Queues a command. Returns false after <see cref="Dispose"/>.</summary>
    public bool TryEnqueue(InputCommand command) => _queue.Writer.TryWrite(command);

    /// <summary>
    /// Stops the worker. Commands still queued are dropped, so no input is injected after this
    /// returns (unless the caller is the worker thread itself, which cannot be joined).
    /// </summary>
    public void Dispose()
    {
        _queue.Writer.TryComplete();
        _stop.Cancel();
        if (Thread.CurrentThread != _thread)
        {
            _thread.Join(JoinTimeout);
        }
    }

    private void Run()
    {
        var pending = new List<InputCommand>();
        try
        {
            while (_queue.Reader.WaitToReadAsync(_stop.Token).AsTask().GetAwaiter().GetResult())
            {
                while (_queue.Reader.TryRead(out InputCommand? command))
                {
                    InputCoalescer.Add(pending, command);
                }

                foreach (InputCommand command in pending)
                {
                    if (_stop.IsCancellationRequested)
                    {
                        return;
                    }
                    Apply(command);
                }
                pending.Clear();
            }
        }
        catch (OperationCanceledException) when (_stop.IsCancellationRequested)
        {
            // Dispose requested the stop.
        }
    }

    private void Apply(InputCommand command)
    {
        try
        {
            _injector.Inject(command);
            InputApplied?.Invoke();
        }
        catch (Exception ex)
        {
            // One failed injection must not stop the queue; the next command still goes through.
            _onError?.Invoke(ex);
        }
    }
}
