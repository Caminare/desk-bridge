using System.Buffers;
using System.Runtime.InteropServices;
using DeskBridge.Agent.Core.Streaming;
using Windows.Win32;
using Windows.Win32.Foundation;
using Windows.Win32.Graphics.Gdi;
using Windows.Win32.UI.WindowsAndMessaging;

namespace DeskBridge.Agent.Windows.Capture;

/// <summary>
/// Fallback capture: one HALFTONE <c>StretchBlt</c> from the screen DC into a top-down 32-bit DIB
/// section of the stream size, then the pointer via <c>DrawIconEx</c>. GDI has no change
/// notification, so a non-forced call sleeps for <c>timeout</c> (acting as the frame pacer) and then
/// always returns a frame with unknown dirty rects.
/// </summary>
public sealed unsafe class GdiFrameSource : IFrameSource
{
    private const uint CaptureBlt = 0x40000000; // include layered windows
    private const uint SrcCopy = 0x00CC0020;

    private readonly int _srcX, _srcY, _srcW, _srcH;
    private readonly System.Diagnostics.Stopwatch _clock = new();

    private HDC _memDc;
    private HBITMAP _dib;
    private HGDIOBJ _oldBitmap;
    private byte* _bits;
    private PointerMemory? _memory;
    private int _targetW, _targetH;

    private HCURSOR _cachedCursor;
    private (int X, int Y) _cachedHotspot;

    /// <param name="monitor">HMONITOR to capture; 0 selects the primary monitor.</param>
    public GdiFrameSource(nint monitor = 0)
    {
        HMONITOR hmon = monitor != 0
            ? new HMONITOR((void*)monitor)
            : PInvoke.MonitorFromPoint(default, MONITOR_FROM_FLAGS.MONITOR_DEFAULTTOPRIMARY);
        MONITORINFO info = new() { cbSize = (uint)sizeof(MONITORINFO) };
        if (!PInvoke.GetMonitorInfo(hmon, ref info)) throw new InvalidOperationException("GetMonitorInfo failed.");
        _srcX = info.rcMonitor.left;
        _srcY = info.rcMonitor.top;
        _srcW = info.rcMonitor.Width;
        _srcH = info.rcMonitor.Height;
    }

    public string Method => "gdi";

    public (int Width, int Height) SourceSize => (_srcW, _srcH);

    public CaptureResult TryCapture(int targetWidth, int targetHeight, TimeSpan timeout, bool forceFrame)
    {
        if (targetWidth <= 0 || targetHeight <= 0) throw new ArgumentOutOfRangeException(nameof(targetWidth), "Target size must be positive.");
        if (!forceFrame && timeout > TimeSpan.Zero) Thread.Sleep(timeout);

        _clock.Restart();
        EnsureDib(targetWidth, targetHeight);

        HDC screen = PInvoke.GetDC(HWND.Null);
        if (screen.IsNull) return new CaptureResult(CaptureStatus.Lost, default, null, 0);
        try
        {
            PInvoke.SetStretchBltMode(_memDc, STRETCH_BLT_MODE.HALFTONE);
            // SetStretchBltMode(HALFTONE) requires the brush origin to be reset by the caller on 9x; harmless on NT.
            if (!PInvoke.StretchBlt(_memDc, 0, 0, targetWidth, targetHeight, screen, _srcX, _srcY, _srcW, _srcH, (ROP_CODE)(SrcCopy | CaptureBlt)))
                return new CaptureResult(CaptureStatus.Lost, default, null, 0);
        }
        finally
        {
            PInvoke.ReleaseDC(HWND.Null, screen);
        }

        DrawCursor(targetWidth, targetHeight);
        _clock.Stop();
        return new CaptureResult(CaptureStatus.Frame, new FrameImage(_memory!.Memory, targetWidth, targetHeight, targetWidth * 4), null, _clock.Elapsed.TotalMilliseconds);
    }

    private void EnsureDib(int w, int h)
    {
        if (!_memDc.IsNull && w == _targetW && h == _targetH) return;
        ReleaseDib();

        HDC screen = PInvoke.GetDC(HWND.Null);
        try
        {
            _memDc = PInvoke.CreateCompatibleDC(screen);
            BITMAPINFO bmi = default;
            bmi.bmiHeader.biSize = (uint)sizeof(BITMAPINFOHEADER);
            bmi.bmiHeader.biWidth = w;
            bmi.bmiHeader.biHeight = -h; // top-down
            bmi.bmiHeader.biPlanes = 1;
            bmi.bmiHeader.biBitCount = 32;
            bmi.bmiHeader.biCompression = 0; // BI_RGB
            void* bits;
            _dib = PInvoke.CreateDIBSection(screen, &bmi, DIB_USAGE.DIB_RGB_COLORS, &bits, HANDLE.Null, 0);
            if (_dib.IsNull) throw new InvalidOperationException("CreateDIBSection failed.");
            _bits = (byte*)bits;
            _oldBitmap = PInvoke.SelectObject(_memDc, _dib);
        }
        finally
        {
            PInvoke.ReleaseDC(HWND.Null, screen);
        }
        _memory = new PointerMemory(_bits, w * 4 * h);
        _targetW = w;
        _targetH = h;
    }

    private void DrawCursor(int targetW, int targetH)
    {
        CURSORINFO ci = new() { cbSize = (uint)sizeof(CURSORINFO) };
        if (!PInvoke.GetCursorInfo(ref ci) || (ci.flags & CURSORINFO_FLAGS.CURSOR_SHOWING) == 0 || ci.hCursor.IsNull) return;

        if (ci.hCursor != _cachedCursor)
        {
            _cachedHotspot = (0, 0);
            if (PInvoke.GetIconInfo(new BorrowedHandle((nint)ci.hCursor.Value), out ICONINFO ii))
            {
                _cachedHotspot = ((int)ii.xHotspot, (int)ii.yHotspot);
                if (!ii.hbmMask.IsNull) PInvoke.DeleteObject(ii.hbmMask);
                if (!ii.hbmColor.IsNull) PInvoke.DeleteObject(ii.hbmColor);
            }
            _cachedCursor = ci.hCursor;
        }

        double sx = (double)targetW / _srcW, sy = (double)targetH / _srcH;
        int x = (int)Math.Round((ci.ptScreenPos.X - _srcX - _cachedHotspot.X) * sx);
        int y = (int)Math.Round((ci.ptScreenPos.Y - _srcY - _cachedHotspot.Y) * sy);
        int size = PInvoke.GetSystemMetrics(SYSTEM_METRICS_INDEX.SM_CXCURSOR);
        int cw = Math.Max(1, (int)Math.Round(size * sx)), ch = Math.Max(1, (int)Math.Round(size * sy));
        PInvoke.DrawIconEx(_memDc, x, y, new HICON((void*)ci.hCursor.Value), cw, ch, 0, HBRUSH.Null, DI_FLAGS.DI_NORMAL);
    }

    private void ReleaseDib()
    {
        if (!_memDc.IsNull)
        {
            if (!_oldBitmap.IsNull) PInvoke.SelectObject(_memDc, _oldBitmap);
            if (!_dib.IsNull) PInvoke.DeleteObject(_dib);
            PInvoke.DeleteDC(_memDc);
        }
        _memDc = default;
        _dib = default;
        _oldBitmap = default;
        _bits = null;
        _memory = null;
        _targetW = _targetH = 0;
    }

    public void Dispose() => ReleaseDib();

    /// <summary>Wraps a handle we do not own (the shared system cursor) so it is never destroyed.</summary>
    private sealed class BorrowedHandle(nint handle) : SafeHandle(handle, ownsHandle: false)
    {
        public override bool IsInvalid => handle == 0;

        protected override bool ReleaseHandle() => true;
    }

    /// <summary>Exposes the DIB section's unmanaged pixels as a <see cref="Memory{T}"/> without a copy.</summary>
    private sealed class PointerMemory : MemoryManager<byte>
    {
        private readonly byte* _ptr;
        private readonly int _length;

        public PointerMemory(byte* ptr, int length)
        {
            _ptr = ptr;
            _length = length;
        }

        public override Span<byte> GetSpan() => new(_ptr, _length);

        public override MemoryHandle Pin(int elementIndex = 0) => new(_ptr + elementIndex);

        public override void Unpin() { }

        protected override void Dispose(bool disposing) { }
    }
}
