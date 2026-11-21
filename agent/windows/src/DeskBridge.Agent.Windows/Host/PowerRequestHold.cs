using System.Runtime.InteropServices;
using DeskBridge.Agent.Core.Power;
using Microsoft.Win32.SafeHandles;
using Windows.Win32;
using Windows.Win32.Foundation;
using Windows.Win32.System.Power;
using Windows.Win32.System.Threading;
using Windows.Win32.UI.Input.KeyboardAndMouse;

namespace DeskBridge.Agent.Windows.Host;

/// <summary>
/// Keep-awake through a power request (system and display required). Unlike SetThreadExecutionState, which the
/// PowerShell agent uses, a power request belongs to a handle rather than the calling thread, so the async event
/// loop can set and clear it from any thread-pool thread. <c>powercfg /requests</c> lists it under the agent.
/// </summary>
public sealed class PowerRequestHold : IPowerHold, IDisposable
{
    private const string Reason = "DeskBridge agent keep-awake (remote access)";
    private readonly SafeFileHandle _request;
    private readonly Action<string> _log;
    private bool _held;

    public PowerRequestHold(Action<string> log)
    {
        _log = log;
        _request = Create();
        if (_request.IsInvalid) _log($"Keep-awake unavailable: PowerCreateRequest failed ({Marshal.GetLastPInvokeError()}).");
    }

    public void SetHeld(bool held)
    {
        if (_request.IsInvalid || held == _held) return;
        bool ok = true;
        foreach (POWER_REQUEST_TYPE type in (ReadOnlySpan<POWER_REQUEST_TYPE>)[POWER_REQUEST_TYPE.PowerRequestSystemRequired, POWER_REQUEST_TYPE.PowerRequestDisplayRequired])
        {
            ok &= held ? PInvoke.PowerSetRequest(_request, type) : PInvoke.PowerClearRequest(_request, type);
        }
        _held = held;
        if (!ok) _log($"Keep-awake: could not {(held ? "set" : "clear")} the power request ({Marshal.GetLastPInvokeError()}).");
    }

    /// <summary>Zero-distance relative mouse move: resets the idle timer without moving the cursor.</summary>
    public void NudgeIdleTimer()
    {
        Span<INPUT> input = [new INPUT { type = INPUT_TYPE.INPUT_MOUSE, Anonymous = { mi = new MOUSEINPUT { dwFlags = MOUSE_EVENT_FLAGS.MOUSEEVENTF_MOVE } } }];
        PInvoke.SendInput(input, Marshal.SizeOf<INPUT>());
    }

    public void Dispose()
    {
        SetHeld(false);
        _request.Dispose();
    }

    private static unsafe SafeFileHandle Create()
    {
        fixed (char* reason = Reason)
        {
            var context = new REASON_CONTEXT
            {
                Version = PInvoke.POWER_REQUEST_CONTEXT_VERSION,
                Flags = POWER_REQUEST_CONTEXT_FLAGS.POWER_REQUEST_CONTEXT_SIMPLE_STRING,
            };
            context.Reason.SimpleReasonString = reason;
            return PInvoke.PowerCreateRequest(context);
        }
    }
}
