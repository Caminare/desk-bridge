using System.Diagnostics;
using System.Runtime.InteropServices;
using DeskBridge.Agent.Core.Cursor;
using DeskBridge.Agent.Core.Streaming;
using SharpGen.Runtime;
using Vortice;
using Vortice.Mathematics;
using Vortice.Direct3D;
using Vortice.Direct3D11;
using Vortice.DXGI;
using Windows.Win32;
using Windows.Win32.Foundation;
using Windows.Win32.Graphics.Gdi;

namespace DeskBridge.Agent.Windows.Capture;

/// <summary>
/// Desktop Duplication capture of one monitor. Each acquired frame is copied on the GPU into a
/// persistent full-resolution texture (so keyframes can be re-rendered without a new desktop update),
/// scaled to the stream size by the D3D11 video processor, read back into a reusable CPU buffer and,
/// unless the controllers draw it themselves, topped with the mouse pointer, which duplication does not include.
/// </summary>
public sealed unsafe class DxgiFrameSource : IFrameSource
{
    private const Format BgraFormat = Format.B8G8R8A8_UNorm;
    // The video processor's filter taps reach one stream pixel beyond a changed rectangle.
    private const int DirtyMargin = 1;

    private readonly nint _monitor;
    private readonly Stopwatch _clock = new();

    private IDXGIOutputDuplication? _dup;
    private ID3D11Device? _device;
    private ID3D11DeviceContext? _context;
    private ID3D11VideoDevice? _videoDevice;
    private ID3D11VideoContext? _videoContext;
    private ID3D11Texture2D? _desktopCopy;
    private ID3D11VideoProcessorInputView? _inputView;

    // Rebuilt whenever the target size changes.
    private ID3D11VideoProcessorEnumerator? _vpEnum;
    private ID3D11VideoProcessor? _vp;
    private ID3D11Texture2D? _scaled;
    private ID3D11Texture2D? _staging;
    private ID3D11VideoProcessorOutputView? _outputView;
    private int _targetW, _targetH;

    private byte[] _cpu = [];
    private bool _havePicture;
    private bool _picturePresented; // the CPU buffer holds a frame of the current target size from the current duplication
    private int _srcW, _srcH;

    private RawRect[] _dirtyBuf = new RawRect[64];
    private OutduplMoveRect[] _moveBuf = new OutduplMoveRect[16];

    // Pointer state from duplication metadata, in source pixels (relative to the output).
    private bool _ptrVisible;
    private int _ptrX, _ptrY;
    private byte[] _shape = new byte[4096];
    private OutduplPointerShapeInfo _shapeInfo;
    private bool _haveShape;
    private CursorShapeData? _cursorShape;
    private PixelRect _lastCursorRect;
    private volatile bool _drawCursor = true;

    /// <param name="monitor">HMONITOR to capture; 0 selects the primary monitor.</param>
    public DxgiFrameSource(nint monitor = 0)
    {
        _monitor = monitor != 0 ? monitor : (nint)PInvoke.MonitorFromPoint(default, MONITOR_FROM_FLAGS.MONITOR_DEFAULTTOPRIMARY).Value;
        Initialize(); // throws when DXGI is unavailable so the factory can fall back
    }

    public string Method => "dxgi";

    public (int Width, int Height) SourceSize => (_srcW, _srcH);

    // Duplication reports the shape's top-left corner; the protocol wants the hotspot.
    public CursorSnapshot Cursor => new(_ptrVisible, _ptrX + _shapeInfo.HotSpot.X, _ptrY + _shapeInfo.HotSpot.Y, _cursorShape);

    public bool DrawCursor
    {
        get => _drawCursor;
        set => _drawCursor = value;
    }

    /// <summary>Why the last <see cref="CaptureStatus.Lost"/> happened, for logs; null when none has.</summary>
    public string? LastLostReason { get; private set; }

    private bool IsInitialized => _dup is not null;

    private void Initialize()
    {
        try
        {
            using IDXGIFactory1 factory = DXGI.CreateDXGIFactory1<IDXGIFactory1>();
            IDXGIAdapter1? adapter = null;
            IDXGIOutput1? output1 = null;
            for (uint a = 0; output1 is null && factory.EnumAdapters1(a, out IDXGIAdapter1 candidate).Success; a++)
            {
                for (uint o = 0; candidate.EnumOutputs(o, out IDXGIOutput output).Success; o++)
                {
                    using (output)
                    {
                        if (output.Description.Monitor == _monitor)
                        {
                            output1 = output.QueryInterface<IDXGIOutput1>();
                            adapter = candidate;
                            break;
                        }
                    }
                }
                if (adapter is null) candidate.Dispose();
            }
            if (output1 is null || adapter is null) throw new InvalidOperationException("The monitor was not found on any DXGI adapter.");

            using (adapter)
            using (output1)
            {
                FeatureLevel[] levels = [FeatureLevel.Level_11_1, FeatureLevel.Level_11_0, FeatureLevel.Level_10_1, FeatureLevel.Level_10_0];
                Result hr = D3D11.D3D11CreateDevice(adapter, DriverType.Unknown, DeviceCreationFlags.BgraSupport | DeviceCreationFlags.VideoSupport,
                    levels, out _device, out _context);
                hr.CheckError();

                _dup = output1.DuplicateOutput(_device);
            }

            ModeDescription mode = _dup.Description.ModeDescription;
            _srcW = (int)mode.Width;
            _srcH = (int)mode.Height;

            _videoDevice = _device!.QueryInterface<ID3D11VideoDevice>();
            _videoContext = _context!.QueryInterface<ID3D11VideoContext>();

            Texture2DDescription desc = new()
            {
                Width = (uint)_srcW,
                Height = (uint)_srcH,
                MipLevels = 1,
                ArraySize = 1,
                Format = BgraFormat,
                SampleDescription = new SampleDescription(1, 0),
                Usage = ResourceUsage.Default,
                BindFlags = BindFlags.ShaderResource | BindFlags.RenderTarget,
            };
            _desktopCopy = _device.CreateTexture2D(desc);

            _havePicture = false;
            _picturePresented = false;
            _targetW = _targetH = 0; // forces the scaler to be rebuilt for this device
            _lastCursorRect = default;
        }
        catch
        {
            Teardown();
            throw;
        }
    }

    private void Teardown()
    {
        ReleaseScaler();
        _inputView?.Dispose(); _inputView = null;
        _desktopCopy?.Dispose(); _desktopCopy = null;
        _videoContext?.Dispose(); _videoContext = null;
        _videoDevice?.Dispose(); _videoDevice = null;
        _dup?.Dispose(); _dup = null;
        _context?.Dispose(); _context = null;
        _device?.Dispose(); _device = null;
        _havePicture = false;
        _picturePresented = false;
    }

    private void ReleaseScaler()
    {
        _outputView?.Dispose(); _outputView = null;
        _staging?.Dispose(); _staging = null;
        _scaled?.Dispose(); _scaled = null;
        _vp?.Dispose(); _vp = null;
        _vpEnum?.Dispose(); _vpEnum = null;
        _picturePresented = false;
    }

    private void EnsureScaler(int targetW, int targetH)
    {
        if (_vp is not null && targetW == _targetW && targetH == _targetH) return;
        ReleaseScaler();

        VideoProcessorContentDescription content = new()
        {
            InputFrameFormat = VideoFrameFormat.Progressive,
            InputFrameRate = new Rational(60, 1),
            InputWidth = (uint)_srcW,
            InputHeight = (uint)_srcH,
            OutputFrameRate = new Rational(60, 1),
            OutputWidth = (uint)targetW,
            OutputHeight = (uint)targetH,
            Usage = VideoUsage.OptimalQuality,
        };
        _vpEnum = _videoDevice!.CreateVideoProcessorEnumerator(content);
        _vp = _videoDevice.CreateVideoProcessor(_vpEnum, 0);

        Texture2DDescription scaledDesc = new()
        {
            Width = (uint)targetW,
            Height = (uint)targetH,
            MipLevels = 1,
            ArraySize = 1,
            Format = BgraFormat,
            SampleDescription = new SampleDescription(1, 0),
            Usage = ResourceUsage.Default,
            BindFlags = BindFlags.RenderTarget,
        };
        _scaled = _device!.CreateTexture2D(scaledDesc);

        Texture2DDescription stagingDesc = scaledDesc;
        stagingDesc.Usage = ResourceUsage.Staging;
        stagingDesc.BindFlags = BindFlags.None;
        stagingDesc.CPUAccessFlags = CpuAccessFlags.Read;
        _staging = _device.CreateTexture2D(stagingDesc);

        VideoProcessorOutputViewDescription outDesc = new() { ViewDimension = VideoProcessorOutputViewDimension.Texture2D };
        _outputView = _videoDevice.CreateVideoProcessorOutputView(_scaled, _vpEnum, outDesc);

        if (_inputView is null)
        {
            VideoProcessorInputViewDescription inDesc = new() { ViewDimension = VideoProcessorInputViewDimension.Texture2D };
            _inputView = _videoDevice.CreateVideoProcessorInputView(_desktopCopy!, _vpEnum, inDesc);
        }

        _targetW = targetW;
        _targetH = targetH;
        int stride = targetW * 4;
        if (_cpu.Length != stride * targetH) _cpu = new byte[stride * targetH];
    }

    public CaptureResult TryCapture(int targetWidth, int targetHeight, TimeSpan timeout, bool forceFrame)
    {
        if (targetWidth <= 0 || targetHeight <= 0) throw new ArgumentOutOfRangeException(nameof(targetWidth), "Target size must be positive.");

        if (!IsInitialized)
        {
            try { Initialize(); }
            catch (Exception ex) when (IsDeviceFailure(ex))
            {
                LastLostReason = "reinitialize: " + ex.Message;
                // Secure desktop (UAC, lock screen) or a mode change in progress: stay Lost, don't spin.
                Thread.Sleep((int)Math.Clamp(timeout.TotalMilliseconds, 1, 100));
                return Lost();
            }
        }

        try
        {
            return CaptureCore(targetWidth, targetHeight, timeout, forceFrame);
        }
        catch (Exception ex) when (IsDeviceFailure(ex))
        {
            LastLostReason = ex.ToString();
            Teardown();
            return Lost();
        }
    }

    private static bool IsDeviceFailure(Exception ex) => ex is SharpGenException or COMException or InvalidOperationException;

    private static CaptureResult Lost() => new(CaptureStatus.Lost, default, null, 0);

    private CaptureResult CaptureCore(int targetW, int targetH, TimeSpan timeout, bool forceFrame)
    {
        uint waitMs = (uint)Math.Clamp(timeout.TotalMilliseconds, 0, int.MaxValue);
        Result hr = _dup!.AcquireNextFrame(waitMs, out OutduplFrameInfo info, out IDXGIResource? resource);

        if (hr.Code == Vortice.DXGI.ResultCode.WaitTimeout.Code)
        {
            if (!forceFrame || !_havePicture) return new CaptureResult(CaptureStatus.NoChange, default, null, 0);
            return Render(targetW, targetH, dirtySource: null, cursorChanged: false);
        }
        if (hr.Failure)
        {
            LastLostReason = $"AcquireNextFrame 0x{hr.Code:X8}";
            Teardown(); // ACCESS_LOST, device removed, session disconnected, ...
            return Lost();
        }

        _clock.Restart();
        bool presented = info.LastPresentTime != 0 || info.AccumulatedFrames > 0;
        List<PixelRect>? desktopDirty = []; // cursor-only frames: the desktop did not change
        bool cursorChanged = false;
        bool firstPicture = !_havePicture;
        try
        {
            if (presented)
            {
                using ID3D11Texture2D frame = resource!.QueryInterface<ID3D11Texture2D>();
                _context!.CopyResource(_desktopCopy!, frame);
                _havePicture = true;
                desktopDirty = firstPicture ? null : ReadDirtyRects(info.TotalMetadataBufferSize, targetW, targetH);
            }

            if (info.LastMouseUpdateTime != 0)
            {
                cursorChanged = true;
                _ptrVisible = info.PointerPosition.Visible;
                _ptrX = info.PointerPosition.Position.X;
                _ptrY = info.PointerPosition.Position.Y;
                if (info.PointerShapeBufferSize > 0) ReadPointerShape(info.PointerShapeBufferSize);
            }
        }
        finally
        {
            resource?.Dispose();
            _dup.ReleaseFrame();
        }

        // A pointer drawn by the controllers changes nothing in the picture.
        bool pointerInFrame = cursorChanged && _drawCursor;
        if (!presented && !pointerInFrame && !forceFrame) return new CaptureResult(CaptureStatus.NoChange, default, null, 0);
        if (!_havePicture) return new CaptureResult(CaptureStatus.NoChange, default, null, 0);

        // A forced frame without any update has no change information.
        return Render(targetW, targetH, presented || pointerInFrame ? desktopDirty : null, pointerInFrame);
    }

    private CaptureResult Render(int targetW, int targetH, List<PixelRect>? dirtySource, bool cursorChanged)
    {
        if (!_clock.IsRunning) _clock.Restart();
        bool sizeChanged = _vp is null || targetW != _targetW || targetH != _targetH;
        EnsureScaler(targetW, targetH);

        ScaleDesktop();
        int stride = targetW * 4;
        ReadBack(stride);

        PixelRect newCursor = default;
        if (_drawCursor && _ptrVisible && _haveShape)
        {
            double sx = (double)targetW / _srcW, sy = (double)targetH / _srcH;
            newCursor = CursorBlender.Draw(_cpu, targetW, targetH, stride, _shapeInfo.Type, _shape,
                (int)_shapeInfo.Width, (int)_shapeInfo.Height, (int)_shapeInfo.Pitch, _ptrX, _ptrY, sx, sy);
        }

        // Dirty rects are only trustworthy when the previous CPU frame was produced by this same duplication at this size.
        List<PixelRect>? dirty = sizeChanged || !_picturePresented ? null : dirtySource;
        if (dirty is not null)
        {
            if (cursorChanged || _lastCursorRect != newCursor)
            {
                if (_lastCursorRect.Width > 0) dirty.Add(_lastCursorRect);
                if (newCursor.Width > 0) dirty.Add(newCursor);
            }
            RectScaler.CapCount(dirty);
        }
        _lastCursorRect = newCursor;
        _picturePresented = true;

        _clock.Stop();
        return new CaptureResult(CaptureStatus.Frame, new FrameImage(_cpu, targetW, targetH, stride), dirty, _clock.Elapsed.TotalMilliseconds);
    }

    private void ScaleDesktop()
    {
        VideoProcessorStream stream = new() { Enable = true, InputSurface = _inputView };
        _videoContext!.VideoProcessorBlt(_vp!, _outputView!, 0, 1, [stream]).CheckError();
    }

    private void ReadBack(int stride)
    {
        _context!.CopyResource(_staging!, _scaled!);
        MappedSubresource map = _context.Map(_staging!, 0, MapMode.Read, Vortice.Direct3D11.MapFlags.None);
        try
        {
            byte* src = (byte*)map.DataPointer;
            int rowPitch = (int)map.RowPitch;
            for (int y = 0; y < _targetH; y++)
                new ReadOnlySpan<byte>(src + (long)y * rowPitch, stride).CopyTo(_cpu.AsSpan(y * stride, stride));
        }
        finally
        {
            _context.Unmap(_staging!, 0);
        }
    }

    private void ReadPointerShape(uint size)
    {
        if (_shape.Length < size) _shape = new byte[size];
        fixed (byte* p = _shape)
        {
            Result r = _dup!.GetFramePointerShape((uint)_shape.Length, (IntPtr)p, out _, out _shapeInfo);
            _haveShape = r.Success;
        }
        if (_haveShape)
        {
            _cursorShape = CursorShapeConverter.TryConvert((CursorShapeType)_shapeInfo.Type, _shape,
                (int)_shapeInfo.Width, (int)_shapeInfo.Height, (int)_shapeInfo.Pitch, _shapeInfo.HotSpot.X, _shapeInfo.HotSpot.Y);
        }
    }

    /// <summary>Dirty plus move-destination rectangles in stream coordinates; null when the metadata is missing or unusable.</summary>
    private List<PixelRect>? ReadDirtyRects(uint metadataBytes, int targetW, int targetH)
    {
        if (metadataBytes == 0) return null;

        int dirtyCap = (int)(metadataBytes / (uint)sizeof(RawRect)) + 1;
        if (_dirtyBuf.Length < dirtyCap) _dirtyBuf = new RawRect[dirtyCap];
        int moveCap = (int)(metadataBytes / (uint)sizeof(OutduplMoveRect)) + 1;
        if (_moveBuf.Length < moveCap) _moveBuf = new OutduplMoveRect[moveCap];

        // Move rects first: the dirty list is read into the larger shared budget only when it applies.
        if (_dup!.GetFrameMoveRects((uint)(_moveBuf.Length * sizeof(OutduplMoveRect)), _moveBuf, out uint moveBytes).Failure) return null;
        if (_dup.GetFrameDirtyRects((uint)(_dirtyBuf.Length * sizeof(RawRect)), _dirtyBuf, out uint dirtyBytes).Failure) return null;

        int moves = (int)(moveBytes / (uint)sizeof(OutduplMoveRect));
        int dirties = (int)(dirtyBytes / (uint)sizeof(RawRect));
        if (moves + dirties == 0) return null;

        var rects = new List<PixelRect>(moves + dirties + 2);
        for (int i = 0; i < dirties; i++)
        {
            RawRect r = _dirtyBuf[i];
            if (RectScaler.TryScale(r.Left, r.Top, r.Right, r.Bottom, _srcW, _srcH, targetW, targetH, DirtyMargin, out PixelRect pr)) rects.Add(pr);
        }
        for (int i = 0; i < moves; i++)
        {
            RawRect r = _moveBuf[i].DestinationRect; // the source area did not change, only where its pixels landed
            if (RectScaler.TryScale(r.Left, r.Top, r.Right, r.Bottom, _srcW, _srcH, targetW, targetH, DirtyMargin, out PixelRect pr)) rects.Add(pr);
        }
        return rects;
    }

    public void Dispose() => Teardown();
}
