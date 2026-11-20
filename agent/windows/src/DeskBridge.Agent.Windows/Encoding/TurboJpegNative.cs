using System.Runtime.InteropServices;

namespace DeskBridge.Agent.Windows.Encoding;

/// <summary>
/// TurboJPEG 3 entry points. Every constant below is copied from libjpeg-turbo 3.2.1
/// <c>src/turbojpeg.h</c> (enum values counted from the declaration order there).
/// </summary>
internal static unsafe partial class TurboJpegNative
{
    private const string Lib = "turbojpeg";

    public const int TJINIT_COMPRESS = 0;

    public const int TJPARAM_NOREALLOC = 2;
    public const int TJPARAM_QUALITY = 3;
    public const int TJPARAM_SUBSAMP = 4;

    public const int TJSAMP_444 = 0;
    public const int TJSAMP_420 = 2;

    public const int TJPF_BGRX = 3;

    [LibraryImport(Lib)]
    public static partial nint tj3Init(int initType);

    [LibraryImport(Lib)]
    public static partial void tj3Destroy(nint handle);

    [LibraryImport(Lib)]
    public static partial int tj3Set(nint handle, int param, int value);

    [LibraryImport(Lib)]
    public static partial nuint tj3JPEGBufSize(int width, int height, int jpegSubsamp);

    [LibraryImport(Lib)]
    public static partial int tj3Compress8(nint handle, byte* srcBuf, int width, int pitch, int height, int pixelFormat, byte** jpegBuf, nuint* jpegSize);

    [LibraryImport(Lib)]
    private static partial byte* tj3GetErrorStr(nint handle);

    public static string ErrorString(nint handle)
    {
        byte* p = tj3GetErrorStr(handle);
        return p is null ? "unknown TurboJPEG error" : Marshal.PtrToStringAnsi((nint)p) ?? "unknown TurboJPEG error";
    }
}
