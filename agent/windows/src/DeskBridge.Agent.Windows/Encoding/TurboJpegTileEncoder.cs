using System.Buffers;
using DeskBridge.Agent.Core.Streaming;

namespace DeskBridge.Agent.Windows.Encoding;

/// <summary>JPEG-encodes rectangles of a BGRA frame with libjpeg-turbo (TurboJPEG 3 API).</summary>
public sealed unsafe class TurboJpegTileEncoder : ITileEncoder
{
    private nint _handle;
    private byte[] _out = [];
    private int _quality = -1;
    private int _subsamp = -1;

    public TurboJpegTileEncoder()
    {
        _handle = TurboJpegNative.tj3Init(TurboJpegNative.TJINIT_COMPRESS);
        if (_handle == 0) throw new InvalidOperationException("tj3Init failed: " + TurboJpegNative.ErrorString(0));
        // We own the output buffer and size it with tj3JPEGBufSize, so the library must never reallocate it.
        Set(TurboJpegNative.TJPARAM_NOREALLOC, 1);
    }

    public int Encode(in FrameImage image, PixelRect rect, int quality, ChromaSubsampling subsampling, IBufferWriter<byte> output)
    {
        ObjectDisposedException.ThrowIf(_handle == 0, this);
        ArgumentNullException.ThrowIfNull(output);
        if (rect.Width <= 0 || rect.Height <= 0
            || rect.X < 0 || rect.Y < 0
            || rect.X + rect.Width > image.Width || rect.Y + rect.Height > image.Height)
            throw new ArgumentOutOfRangeException(nameof(rect), $"{rect} is outside the {image.Width}x{image.Height} image.");
        if (image.Stride < image.Width * 4 || image.Pixels.Length < (long)image.Stride * (image.Height - 1) + image.Width * 4)
            throw new ArgumentException("The pixel buffer is smaller than Stride x Height.", nameof(image));

        int samp = subsampling == ChromaSubsampling.S444 ? TurboJpegNative.TJSAMP_444 : TurboJpegNative.TJSAMP_420;
        int q = Math.Clamp(quality, 1, 100);
        if (q != _quality) { Set(TurboJpegNative.TJPARAM_QUALITY, q); _quality = q; }
        if (samp != _subsamp) { Set(TurboJpegNative.TJPARAM_SUBSAMP, samp); _subsamp = samp; }

        // The 4:4:4 bound is the worst case for any subsampling.
        nuint cap = TurboJpegNative.tj3JPEGBufSize(rect.Width, rect.Height, TurboJpegNative.TJSAMP_444);
        if (cap == 0) throw new InvalidOperationException("tj3JPEGBufSize failed for " + rect);
        if (_out.Length < (int)cap) _out = new byte[(int)cap];

        nuint size = (nuint)_out.Length;
        int rc;
        fixed (byte* pixels = image.Pixels.Span)
        fixed (byte* dst = _out)
        {
            byte* src = pixels + (long)rect.Y * image.Stride + (long)rect.X * 4;
            byte* jpeg = dst;
            rc = TurboJpegNative.tj3Compress8(_handle, src, rect.Width, image.Stride, rect.Height, TurboJpegNative.TJPF_BGRX, &jpeg, &size);
        }
        if (rc != 0) throw new InvalidOperationException("tj3Compress8 failed: " + TurboJpegNative.ErrorString(_handle));

        Span<byte> span = output.GetSpan((int)size);
        _out.AsSpan(0, (int)size).CopyTo(span);
        output.Advance((int)size);
        return (int)size;
    }

    private void Set(int param, int value)
    {
        if (TurboJpegNative.tj3Set(_handle, param, value) != 0)
            throw new InvalidOperationException($"tj3Set({param}, {value}) failed: " + TurboJpegNative.ErrorString(_handle));
    }

    public void Dispose()
    {
        nint h = Interlocked.Exchange(ref _handle, 0);
        if (h != 0) TurboJpegNative.tj3Destroy(h);
    }
}
