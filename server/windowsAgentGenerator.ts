export interface WindowsAgentOptions {
  wsUrl: string;
  appUrl: string;
  hostName: string;
  groupLabel: string;
  /** Server enrollment key embedded in the script; lets the agent register. */
  enrollKey: string;
}

export function generatePowerShellHostScript(opts: WindowsAgentOptions): string {
  const safeName = opts.hostName.replace(/'/g, "''");
  const safeGroup = opts.groupLabel.replace(/'/g, "''");
  const safeWsUrl = opts.wsUrl.replace(/'/g, "''");
  const safeAppUrl = opts.appUrl.replace(/'/g, "''");
  const safeEnrollKey = opts.enrollKey.replace(/'/g, "''");

  return `<#
  DeskBridge Windows Host Agent
  Exposes this Windows PC to your DeskBridge mobile controller over encrypted WebSockets.
  Works natively on Windows 10 / 11 with PowerShell 5.1+ (.NET Framework).

  SECURITY: this script contains your DeskBridge enrollment key. Anyone holding it
  can register a machine with your relay. Do not share or commit it.
#>

param(
  [string]$HostName = '${safeName}',
  [string]$GroupLabel = '${safeGroup}',
  [string]$RelayWsUrl = '${safeWsUrl}',
  [string]$AppBaseUrl = '${safeAppUrl}',
  [string]$EnrollKey = '${safeEnrollKey}',
  # Capture interval while idle; while you are actively controlling the PC it drops to ~33 ms.
  [int]$FrameIntervalMs = 100,
  [int]$JpegQuality = 62,
  [int]$MaxStreamWidth = 1152,
  # -1 = primary monitor; otherwise an index into [System.Windows.Forms.Screen]::AllScreens
  [int]$MonitorIndex = -1,
  # Frames sent but not yet acknowledged by a controller. Higher = smoother on high-latency links.
  [int]$MaxInFlight = 4
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Web.Extensions

Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class DeskBridgeWin32 {
  [DllImport("user32.dll")]
  public static extern bool SetCursorPos(int X, int Y);

  [DllImport("user32.dll")]
  public static extern void mouse_event(uint dwFlags, int dx, int dy, int dwData, UIntPtr dwExtraInfo);

  [DllImport("user32.dll")]
  public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

  [DllImport("user32.dll")]
  public static extern bool LockWorkStation();

  [DllImport("user32.dll")]
  public static extern bool SetProcessDPIAware();

  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
  public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);

  public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  public const uint MOUSEEVENTF_LEFTUP = 0x0004;
  public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
  public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
  public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
  public const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
  public const uint MOUSEEVENTF_WHEEL = 0x0800;
  public const uint MOUSEEVENTF_HWHEEL = 0x01000;
  public const uint KEYEVENTF_KEYUP = 0x0002;

  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int x; public int y; }

  [StructLayout(LayoutKind.Sequential)]
  public struct CURSORINFO {
    public int cbSize;
    public int flags;
    public IntPtr hCursor;
    public POINT ptScreenPos;
  }

  [DllImport("user32.dll")]
  public static extern bool GetCursorInfo(ref CURSORINFO pci);

  [DllImport("user32.dll")]
  public static extern bool DrawIconEx(IntPtr hdc, int xLeft, int yTop, IntPtr hIcon, int cxWidth, int cyWidth, int istepIfAniCur, IntPtr hbrFlickerFreeDraw, int diFlags);

  public static void DrawCursor(IntPtr hdc, int originX, int originY) {
    CURSORINFO ci = new CURSORINFO();
    ci.cbSize = Marshal.SizeOf(typeof(CURSORINFO));
    if (GetCursorInfo(ref ci) && ci.flags == 1 && ci.hCursor != IntPtr.Zero) {
      DrawIconEx(hdc, ci.ptScreenPos.x - originX, ci.ptScreenPos.y - originY, ci.hCursor, 0, 0, 0, IntPtr.Zero, 0x0003);
    }
  }

  // ---- SendInput-based keyboard (Unicode text + arbitrary key combos) ----
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

  // MOUSEINPUT is the largest member, so including it gives INPUT the size Windows expects on x86 and x64.
  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }

  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public uint type; public InputUnion u; }

  [DllImport("user32.dll", SetLastError = true)]
  public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

  public const uint INPUT_KEYBOARD = 1;
  public const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
  public const uint KEYEVENTF_UNICODE = 0x0004;

  static INPUT Key(ushort vk, ushort scan, uint flags) {
    INPUT i = new INPUT();
    i.type = INPUT_KEYBOARD;
    i.u.ki.wVk = vk;
    i.u.ki.wScan = scan;
    i.u.ki.dwFlags = flags;
    return i;
  }

  static bool IsExtended(ushort vk) {
    // Navigation cluster, arrows, Insert/Delete, Windows/Apps keys, Divide, NumLock.
    return (vk >= 0x21 && vk <= 0x28) || vk == 0x2D || vk == 0x2E || vk == 0x5B || vk == 0x5C || vk == 0x5D || vk == 0x6F || vk == 0x90 || vk == 0x2C;
  }

  static uint Send(System.Collections.Generic.List<INPUT> inputs) {
    if (inputs.Count == 0) return 0;
    return SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf(typeof(INPUT)));
  }

  /// Types text exactly (any Unicode, including emoji). LF becomes Enter, TAB becomes Tab, CR is ignored.
  public static uint TypeUnicode(string text) {
    var inputs = new System.Collections.Generic.List<INPUT>();
    foreach (char c in text) {
      if (c == (char)13) continue;
      if (c == (char)10 || c == (char)9) {
        ushort vk = (ushort)(c == (char)10 ? 0x0D : 0x09);
        inputs.Add(Key(vk, 0, 0));
        inputs.Add(Key(vk, 0, KEYEVENTF_KEYUP));
        continue;
      }
      inputs.Add(Key(0, (ushort)c, KEYEVENTF_UNICODE));
      inputs.Add(Key(0, (ushort)c, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
    }
    return Send(inputs);
  }

  /// Presses modifiers, taps key, releases modifiers in reverse order.
  public static uint SendCombo(ushort[] modifiers, ushort vk) {
    var inputs = new System.Collections.Generic.List<INPUT>();
    foreach (ushort m in modifiers) inputs.Add(Key(m, 0, IsExtended(m) ? KEYEVENTF_EXTENDEDKEY : 0));
    uint ext = IsExtended(vk) ? KEYEVENTF_EXTENDEDKEY : 0;
    inputs.Add(Key(vk, 0, ext));
    inputs.Add(Key(vk, 0, ext | KEYEVENTF_KEYUP));
    for (int i = modifiers.Length - 1; i >= 0; i--) {
      ushort m = modifiers[i];
      inputs.Add(Key(m, 0, (IsExtended(m) ? KEYEVENTF_EXTENDEDKEY : 0) | KEYEVENTF_KEYUP));
    }
    return Send(inputs);
  }

  public static string GetActiveWindowTitle() {
    IntPtr handle = GetForegroundWindow();
    var sb = new System.Text.StringBuilder(256);
    if (GetWindowText(handle, sb, 256) > 0) return sb.ToString();
    return "Windows Desktop";
  }
}
"@

# Capture pipeline: runs on a background thread so input handling and network sends never
# wait for screen capture or JPEG encoding. Sends only the screen tiles that changed.
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

public class DeskBridgeFrame {
  public bool Key;
  public int Width;
  public int Height;
  // Flat [x, y, w, h, byteLength] per tile, in stream pixels.
  public int[] Rects;
  public byte[] Data;
  public int DataLength;
  public double CaptureMs;
  public double EncodeMs;
  public int ChangedTiles;
  public int TotalTiles;
  public int Quality;
  internal byte[] Pixels;
  internal int Generation;
  internal int KeyFor;
}

public class DeskBridgeStreamer {
  public const int TileSize = 64;

  [StructLayout(LayoutKind.Sequential)]
  struct POINT { public int x; public int y; }

  [StructLayout(LayoutKind.Sequential)]
  struct CURSORINFO { public int cbSize; public int flags; public IntPtr hCursor; public POINT ptScreenPos; }

  [DllImport("user32.dll")]
  static extern bool GetCursorInfo(ref CURSORINFO pci);

  [DllImport("user32.dll")]
  static extern bool DrawIconEx(IntPtr hdc, int xLeft, int yTop, IntPtr hIcon, int cxWidth, int cyWidth, int istepIfAniCur, IntPtr hbrFlickerFreeDraw, int diFlags);

  readonly object gate = new object();
  readonly Stopwatch clock = Stopwatch.StartNew();
  readonly ImageCodecInfo jpegCodec;
  Thread thread;
  volatile bool running;

  public volatile bool Paused = true;
  public int IdleIntervalMs = 100;
  public int ActiveIntervalMs = 33;
  public string LastError = "";

  // Requested settings (guarded by gate; applied on the capture thread).
  Rectangle bounds;
  int maxWidth;
  int quality;
  bool configDirty = true;
  int keyRequested = 1;
  int keySatisfied = 0;
  long activeUntil;

  // Capture-thread-only state.
  Rectangle curBounds;
  int curMaxWidth = -1;
  Bitmap capBmp;
  Graphics capG;
  Bitmap outBmp;
  Graphics outG;
  int outW;
  int outH;
  int stride;
  EncoderParameters encParams;
  readonly MemoryStream tileStream = new MemoryStream();

  // Shared frame state (guarded by gate).
  byte[] refPixels;
  int generation;
  DeskBridgeFrame pending;
  readonly Stack<byte[]> spare = new Stack<byte[]>();

  public DeskBridgeStreamer(Rectangle bounds, int maxWidth, int quality) {
    foreach (ImageCodecInfo c in ImageCodecInfo.GetImageEncoders()) {
      if (c.MimeType == "image/jpeg") jpegCodec = c;
    }
    this.bounds = bounds;
    this.maxWidth = maxWidth;
    this.quality = Clamp(quality, 30, 95);
  }

  static int Clamp(int v, int lo, int hi) { return Math.Max(lo, Math.Min(hi, v)); }

  public void Start() {
    if (running) return;
    running = true;
    thread = new Thread(Run);
    thread.IsBackground = true;
    thread.Name = "DeskBridgeCapture";
    thread.Start();
  }

  public void Stop() {
    running = false;
    if (thread != null) thread.Join(2000);
  }

  public void SetBounds(Rectangle b) { lock (gate) { bounds = b; configDirty = true; keyRequested++; } }
  public void SetQuality(int mw, int q) { lock (gate) { maxWidth = mw; quality = Clamp(q, 30, 95); configDirty = true; } }
  public void RequestKeyframe() { lock (gate) { keyRequested++; } }
  public void NotifyActivity() { lock (gate) { activeUntil = clock.ElapsedMilliseconds + 600; } }
  public int CurrentQuality { get { lock (gate) { return quality; } } }

  /// Hands the freshest unsent frame to the sender. Its pixels become the diff reference.
  public DeskBridgeFrame TryTakeFrame() {
    lock (gate) {
      DeskBridgeFrame f = pending;
      if (f == null) return null;
      pending = null;
      if (refPixels != null) spare.Push(refPixels);
      refPixels = f.Pixels;
      f.Pixels = null;
      generation++;
      if (f.Key && f.KeyFor > keySatisfied) keySatisfied = f.KeyFor;
      return f;
    }
  }

  void Run() {
    while (running) {
      long started = clock.ElapsedMilliseconds;
      int interval;
      lock (gate) { interval = started < activeUntil ? ActiveIntervalMs : IdleIntervalMs; }
      if (!Paused) {
        try {
          Tick();
          LastError = "";
        } catch (Exception e) {
          LastError = e.Message;
          Thread.Sleep(250);
        }
      }
      long spent = clock.ElapsedMilliseconds - started;
      Thread.Sleep((int)Math.Max(2, interval - spent));
    }
  }

  byte[] TakeSpare(int size) {
    lock (gate) {
      while (spare.Count > 0) {
        byte[] b = spare.Pop();
        if (b.Length == size) return b;
      }
    }
    return new byte[size];
  }

  void Configure(Rectangle b, int mw, int q) {
    bool sizeChanged = b != curBounds || mw != curMaxWidth || capBmp == null;
    encParams = new EncoderParameters(1);
    encParams.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)q);
    if (!sizeChanged) return;

    if (outG != null) outG.Dispose();
    if (outBmp != null && outBmp != capBmp) outBmp.Dispose();
    if (capG != null) capG.Dispose();
    if (capBmp != null) capBmp.Dispose();

    curBounds = b;
    curMaxWidth = mw;
    capBmp = new Bitmap(b.Width, b.Height, PixelFormat.Format24bppRgb);
    capG = Graphics.FromImage(capBmp);
    int w = Math.Min(Math.Max(320, mw), b.Width);
    int h = (int)Math.Round(b.Height * (w / (double)b.Width));
    if (w < b.Width) {
      outBmp = new Bitmap(w, h, PixelFormat.Format24bppRgb);
      outG = Graphics.FromImage(outBmp);
      outG.InterpolationMode = InterpolationMode.Bilinear;
      outG.CompositingMode = CompositingMode.SourceCopy;
      outG.CompositingQuality = CompositingQuality.HighSpeed;
      outG.SmoothingMode = SmoothingMode.HighSpeed;
      outG.PixelOffsetMode = PixelOffsetMode.HighSpeed;
    } else {
      outBmp = capBmp;
      outG = null;
    }
    outW = w;
    outH = h;
  }

  void DrawCursor() {
    CURSORINFO ci = new CURSORINFO();
    ci.cbSize = Marshal.SizeOf(typeof(CURSORINFO));
    if (!GetCursorInfo(ref ci) || ci.flags != 1 || ci.hCursor == IntPtr.Zero) return;
    IntPtr hdc = capG.GetHdc();
    try {
      DrawIconEx(hdc, ci.ptScreenPos.x - curBounds.X, ci.ptScreenPos.y - curBounds.Y, ci.hCursor, 0, 0, 0, IntPtr.Zero, 3);
    } finally {
      capG.ReleaseHdc(hdc);
    }
  }

  void CopyPixels(byte[] dst) {
    BitmapData d = outBmp.LockBits(new Rectangle(0, 0, outW, outH), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
    try {
      Marshal.Copy(d.Scan0, dst, 0, stride * outH);
    } finally {
      outBmp.UnlockBits(d);
    }
  }

  int ReadStride() {
    BitmapData d = outBmp.LockBits(new Rectangle(0, 0, outW, outH), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
    int s = Math.Abs(d.Stride);
    outBmp.UnlockBits(d);
    return s;
  }

  bool TileDiffers(byte[] a, byte[] b, int tx, int ty) {
    int x0 = tx * TileSize * 3;
    int x1 = Math.Min((tx + 1) * TileSize, outW) * 3;
    int y0 = ty * TileSize;
    int y1 = Math.Min(y0 + TileSize, outH);
    for (int y = y0; y < y1; y++) {
      int row = y * stride;
      for (int i = row + x0; i < row + x1; i++) {
        if (a[i] != b[i]) return true;
      }
    }
    return false;
  }

  void EncodeRect(int x, int y, int w, int h, List<int> rects, MemoryStream output) {
    tileStream.SetLength(0);
    if (x == 0 && y == 0 && w == outW && h == outH) {
      outBmp.Save(tileStream, jpegCodec, encParams);
    } else {
      using (Bitmap part = outBmp.Clone(new Rectangle(x, y, w, h), PixelFormat.Format24bppRgb)) {
        part.Save(tileStream, jpegCodec, encParams);
      }
    }
    int len = (int)tileStream.Length;
    output.Write(tileStream.GetBuffer(), 0, len);
    rects.Add(x); rects.Add(y); rects.Add(w); rects.Add(h); rects.Add(len);
  }

  void Tick() {
    Rectangle b; int mw; int q; bool dirty; int myGen; byte[] reference; int keyReq; bool wantKey;
    lock (gate) {
      b = bounds; mw = maxWidth; q = quality; dirty = configDirty; configDirty = false;
      myGen = generation; reference = refPixels; keyReq = keyRequested; wantKey = keyRequested != keySatisfied;
    }
    if (dirty || capBmp == null) {
      Configure(b, mw, q);
      stride = ReadStride();
    }

    Stopwatch sw = Stopwatch.StartNew();
    capG.CopyFromScreen(curBounds.Location, Point.Empty, curBounds.Size, CopyPixelOperation.SourceCopy);
    DrawCursor();
    if (outG != null) outG.DrawImage(capBmp, 0, 0, outW, outH);
    byte[] cur = TakeSpare(stride * outH);
    CopyPixels(cur);
    double capMs = sw.Elapsed.TotalMilliseconds;

    int tilesX = (outW + TileSize - 1) / TileSize;
    int tilesY = (outH + TileSize - 1) / TileSize;
    int total = tilesX * tilesY;
    bool key = wantKey || reference == null || reference.Length != cur.Length;
    bool[] changed = new bool[total];
    int nChanged = 0;
    if (!key) {
      for (int ty = 0; ty < tilesY; ty++) {
        for (int tx = 0; tx < tilesX; tx++) {
          if (TileDiffers(cur, reference, tx, ty)) { changed[ty * tilesX + tx] = true; nChanged++; }
        }
      }
      if (nChanged == 0) {
        // Screen matches what the receiver already has: nothing to send.
        lock (gate) {
          spare.Push(cur);
          if (pending != null && pending.Generation == myGen && !pending.Key) {
            spare.Push(pending.Pixels);
            pending = null;
          }
        }
        return;
      }
      // Past half the screen, one full JPEG is smaller than many tiles.
      if (nChanged * 2 > total) key = true;
    }

    sw.Restart();
    List<int> rects = new List<int>();
    MemoryStream output = new MemoryStream();
    if (key) {
      EncodeRect(0, 0, outW, outH, rects, output);
      nChanged = total;
    } else {
      for (int ty = 0; ty < tilesY; ty++) {
        int tx = 0;
        while (tx < tilesX) {
          if (!changed[ty * tilesX + tx]) { tx++; continue; }
          int start = tx;
          while (tx < tilesX && changed[ty * tilesX + tx]) tx++;
          int x = start * TileSize;
          int y = ty * TileSize;
          EncodeRect(x, y, Math.Min(tx * TileSize, outW) - x, Math.Min(TileSize, outH - y), rects, output);
        }
      }
    }
    double encMs = sw.Elapsed.TotalMilliseconds;

    DeskBridgeFrame f = new DeskBridgeFrame();
    f.Key = key; f.Width = outW; f.Height = outH; f.Rects = rects.ToArray();
    f.Data = output.GetBuffer(); f.DataLength = (int)output.Length;
    f.CaptureMs = capMs; f.EncodeMs = encMs; f.ChangedTiles = nChanged; f.TotalTiles = total; f.Quality = q;
    f.Pixels = cur; f.Generation = myGen; f.KeyFor = keyReq;

    lock (gate) {
      if (generation != myGen) {
        // The sender took a frame while we worked, so our diff base is outdated. Retry next tick.
        spare.Push(cur);
        return;
      }
      if (pending != null) spare.Push(pending.Pixels);
      pending = f;
    }
  }
}
"@

[DeskBridgeWin32]::SetProcessDPIAware() | Out-Null

$jsonSerializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$jsonSerializer.MaxJsonLength = 10485760

$hostIdFile = Join-Path $env:APPDATA "DeskBridge-host-id.txt"
if (Test-Path $hostIdFile) {
  $HostId = (Get-Content $hostIdFile -Raw).Trim()
} else {
  $HostId = "win-" + ([guid]::NewGuid().ToString("N").Substring(0, 8))
  $HostId | Out-File -FilePath $hostIdFile -Encoding ascii -NoNewline
}

# Per-host secret issued by the relay on first registration; proves this machine owns $HostId.
$hostSecretFile = Join-Path $env:APPDATA "DeskBridge-host-secret.txt"
$script:HostSecret = ''
if (Test-Path $hostSecretFile) {
  $script:HostSecret = (Get-Content $hostSecretFile -Raw).Trim()
}

# Monitor selection. $bounds/$screenW/$screenH describe the monitor being captured; every
# coordinate mapping below is relative to $bounds, so switching monitors just swaps them.
function Get-MonitorList {
  $all = [System.Windows.Forms.Screen]::AllScreens
  $list = @()
  for ($i = 0; $i -lt $all.Length; $i++) {
    $list += @{
      index = $i
      name = $all[$i].DeviceName.Replace([string][char]92, '').Replace('.', '')
      width = $all[$i].Bounds.Width
      height = $all[$i].Bounds.Height
      primary = [bool]$all[$i].Primary
    }
  }
  return ,$list
}

function Resolve-MonitorIndex([int]$requested) {
  $all = [System.Windows.Forms.Screen]::AllScreens
  if ($requested -ge 0 -and $requested -lt $all.Length) { return $requested }
  for ($i = 0; $i -lt $all.Length; $i++) {
    if ($all[$i].Primary) { return $i }
  }
  return 0
}

$script:activeMonitor = Resolve-MonitorIndex $MonitorIndex
$bounds = [System.Windows.Forms.Screen]::AllScreens[$script:activeMonitor].Bounds
$screenW = $bounds.Width
$screenH = $bounds.Height

$script:sendBuf = New-Object byte[] 2097152
$script:streamer = New-Object DeskBridgeStreamer -ArgumentList $bounds, $MaxStreamWidth, $JpegQuality
$script:streamer.IdleIntervalMs = [Math]::Max(33, $FrameIntervalMs)
$script:streamer.Start()

function Select-Monitor([int]$index) {
  $resolved = Resolve-MonitorIndex $index
  $script:activeMonitor = $resolved
  $script:bounds = [System.Windows.Forms.Screen]::AllScreens[$resolved].Bounds
  $script:screenW = $script:bounds.Width
  $script:screenH = $script:bounds.Height
  # The capture thread reallocates its buffers and sends a keyframe for the new display.
  $script:streamer.SetBounds($script:bounds)
  $script:monitorChanged = $true
  Write-Host "Streaming monitor $resolved ($($script:screenW)x$($script:screenH))" -ForegroundColor Cyan
}

# Virtual-key codes for Send-KeyCombo. PowerShell hashtables are case-insensitive.
$script:VkMap = @{
  'Enter' = 0x0D; 'Return' = 0x0D; 'Tab' = 0x09; 'Escape' = 0x1B; 'Esc' = 0x1B; 'Backspace' = 0x08;
  'Delete' = 0x2E; 'Del' = 0x2E; 'Insert' = 0x2D; 'Ins' = 0x2D; 'Home' = 0x24; 'End' = 0x23;
  'PageUp' = 0x21; 'PgUp' = 0x21; 'PageDown' = 0x22; 'PgDn' = 0x22; 'Space' = 0x20;
  'ArrowUp' = 0x26; 'Up' = 0x26; 'ArrowDown' = 0x28; 'Down' = 0x28;
  'ArrowLeft' = 0x25; 'Left' = 0x25; 'ArrowRight' = 0x27; 'Right' = 0x27;
  'PrintScreen' = 0x2C; 'PrtSc' = 0x2C; 'Pause' = 0x13; 'CapsLock' = 0x14; 'Menu' = 0x5D; 'Apps' = 0x5D;
  'VolumeMute' = 0xAD; 'VolumeDown' = 0xAE; 'VolumeUp' = 0xAF;
  'MediaNext' = 0xB0; 'MediaPrev' = 0xB1; 'MediaPlayPause' = 0xB3;
  '-' = 0xBD; '=' = 0xBB; '+' = 0xBB; '[' = 0xDB; ']' = 0xDD; ';' = 0xBA; ',' = 0xBC; '.' = 0xBE; '/' = 0xBF
}
for ($c = 65; $c -le 90; $c++) { $script:VkMap[[string][char]$c] = $c }
for ($d = 0; $d -le 9; $d++) { $script:VkMap[[string]$d] = 0x30 + $d }
for ($f = 1; $f -le 24; $f++) { $script:VkMap["F$f"] = 0x6F + $f }
$script:ModMap = @{ 'Ctrl' = 0x11; 'Control' = 0x11; 'Alt' = 0x12; 'Shift' = 0x10; 'Win' = 0x5B; 'Meta' = 0x5B; 'Cmd' = 0x5B }

# Sends a combo such as "Ctrl+Shift+T", "Win+E", "Alt+F4" or "F5". Returns $false if unknown.
function Send-KeyCombo([string]$combo) {
  if ([string]::IsNullOrWhiteSpace($combo)) { return $false }
  $parts = @($combo.Split('+') | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
  if ($combo.EndsWith('++')) { $parts += '+' }
  if ($parts.Count -eq 0) { return $false }
  $keyName = $parts[$parts.Count - 1]
  $modNames = @()
  if ($parts.Count -gt 1) { $modNames = $parts[0..($parts.Count - 2)] }
  $mods = @()
  foreach ($p in $modNames) {
    if (-not $script:ModMap.ContainsKey($p)) { Write-Host "Unknown modifier '$p' in '$combo'" -ForegroundColor DarkYellow; return $false }
    $mods += [uint16]$script:ModMap[$p]
  }
  $isWin = $mods -contains [uint16]0x5B
  # Win+L is handled by the OS secure desktop and cannot be injected; Ctrl+Alt+Del cannot be sent at all.
  if ($isWin -and $mods.Count -eq 1 -and $keyName -eq 'L') { [DeskBridgeWin32]::LockWorkStation() | Out-Null; return $true }
  if ($script:ModMap.ContainsKey($keyName)) {
    $vkOnly = [uint16]$script:ModMap[$keyName]
    [DeskBridgeWin32]::SendCombo([uint16[]]$mods, $vkOnly) | Out-Null
    return $true
  }
  if (-not $script:VkMap.ContainsKey($keyName)) { Write-Host "Unknown key '$keyName' in '$combo'" -ForegroundColor DarkYellow; return $false }
  [DeskBridgeWin32]::SendCombo([uint16[]]$mods, [uint16]$script:VkMap[$keyName]) | Out-Null
  return $true
}

# ClientWebSocket allows one send at a time. Frames are sent asynchronously so the loop keeps
# handling input during the upload; anything else waits for the in-progress send first.
$script:sendTask = $null

function Wait-PendingSend {
  if ($null -ne $script:sendTask) {
    try { $script:sendTask.Wait() } finally { $script:sendTask = $null }
  }
}

function Send-WsJson($ws, $obj) {
  Wait-PendingSend
  $json = $jsonSerializer.Serialize($obj)
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  $seg = New-Object System.ArraySegment[byte]($bytes, 0, $bytes.Length)
  $ws.SendAsync($seg, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [System.Threading.CancellationToken]::None).Wait()
}

# Starts sending a tiled (v2) frame; see src/lib/frameProtocol.ts for the format.
function Start-FrameSend($ws, $frame, [int]$seq, [string]$activeWin, $stats) {
  $metaJson = $jsonSerializer.Serialize(@{
    hostId = $HostId
    seq = $seq
    activeWindow = $activeWin
    timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    w = $frame.Width
    h = $frame.Height
    key = $frame.Key
    r = $frame.Rects
    stats = $stats
  })
  $metaBytes = [System.Text.Encoding]::UTF8.GetBytes($metaJson)
  $metaLen = $metaBytes.Length
  $totalLen = 4 + $metaLen + $frame.DataLength
  if ($totalLen -gt $script:sendBuf.Length) {
    $script:sendBuf = New-Object byte[] ($totalLen + 262144)
  }
  $script:sendBuf[0] = 0x44
  $script:sendBuf[1] = 0x02
  $script:sendBuf[2] = [byte](($metaLen -shr 8) -band 0xFF)
  $script:sendBuf[3] = [byte]($metaLen -band 0xFF)
  [Array]::Copy($metaBytes, 0, $script:sendBuf, 4, $metaLen)
  [Array]::Copy($frame.Data, 0, $script:sendBuf, 4 + $metaLen, $frame.DataLength)
  $seg = New-Object System.ArraySegment[byte]($script:sendBuf, 0, $totalLen)
  $script:sendTask = $ws.SendAsync($seg, [System.Net.WebSockets.WebSocketMessageType]::Binary, $true, [System.Threading.CancellationToken]::None)
  return $totalLen
}

function Handle-RemoteInput($evt) {
  switch ($evt.type) {
    'mousemove' {
      if ($evt.relative -eq $true) {
        $pos = [System.Windows.Forms.Cursor]::Position
        $nx = [Math]::Max($bounds.X, [Math]::Min($bounds.X + $screenW - 1, $pos.X + [int]$evt.dx))
        $ny = [Math]::Max($bounds.Y, [Math]::Min($bounds.Y + $screenH - 1, $pos.Y + [int]$evt.dy))
        [DeskBridgeWin32]::SetCursorPos($nx, $ny) | Out-Null
      } else {
        $nx = [Math]::Max(0, [Math]::Min($screenW - 1, [int]([Math]::Round([double]$evt.x * $screenW))))
        $ny = [Math]::Max(0, [Math]::Min($screenH - 1, [int]([Math]::Round([double]$evt.y * $screenH))))
        [DeskBridgeWin32]::SetCursorPos($bounds.X + $nx, $bounds.Y + $ny) | Out-Null
      }
    }
    'click' {
      if ($null -ne $evt.x -and $null -ne $evt.y) {
        $nx = [Math]::Max(0, [Math]::Min($screenW - 1, [int]([Math]::Round([double]$evt.x * $screenW))))
        $ny = [Math]::Max(0, [Math]::Min($screenH - 1, [int]([Math]::Round([double]$evt.y * $screenH))))
        [DeskBridgeWin32]::SetCursorPos($bounds.X + $nx, $bounds.Y + $ny) | Out-Null
        Start-Sleep -Milliseconds 12
      }
      if ($evt.button -eq 'right') {
        [DeskBridgeWin32]::mouse_event([DeskBridgeWin32]::MOUSEEVENTF_RIGHTDOWN, 0, 0, 0, [UIntPtr]::Zero)
        [DeskBridgeWin32]::mouse_event([DeskBridgeWin32]::MOUSEEVENTF_RIGHTUP, 0, 0, 0, [UIntPtr]::Zero)
      } else {
        $count = if ($evt.double -eq $true) { 2 } else { 1 }
        for ($i = 0; $i -lt $count; $i++) {
          [DeskBridgeWin32]::mouse_event([DeskBridgeWin32]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
          [DeskBridgeWin32]::mouse_event([DeskBridgeWin32]::MOUSEEVENTF_LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
          if ($count -gt 1 -and $i -eq 0) { Start-Sleep -Milliseconds 25 }
        }
      }
    }
    'scroll' {
      if ($null -ne $evt.deltaY -and [double]$evt.deltaY -ne 0) {
        $wheel = [int]([Math]::Round(-[double]$evt.deltaY * 120))
        if ($wheel -ne 0) {
          [DeskBridgeWin32]::mouse_event([DeskBridgeWin32]::MOUSEEVENTF_WHEEL, 0, 0, $wheel, [UIntPtr]::Zero)
        }
      }
      if ($null -ne $evt.deltaX -and [double]$evt.deltaX -ne 0) {
        $hwheel = [int]([Math]::Round([double]$evt.deltaX * 120))
        if ($hwheel -ne 0) {
          [DeskBridgeWin32]::mouse_event([DeskBridgeWin32]::MOUSEEVENTF_HWHEEL, 0, 0, $hwheel, [UIntPtr]::Zero)
        }
      }
    }
    'type' {
      [DeskBridgeWin32]::TypeUnicode([string]$evt.text) | Out-Null
    }
    'key' {
      $combo = [string]$evt.key
      if ($null -ne $evt.modifiers -and @($evt.modifiers).Count -gt 0) {
        $prefix = (@($evt.modifiers) | ForEach-Object {
          switch ([string]$_) { 'ctrl' { 'Ctrl' } 'alt' { 'Alt' } 'shift' { 'Shift' } 'win' { 'Win' } default { [string]$_ } }
        }) -join '+'
        $combo = "$prefix+$combo"
      }
      Send-KeyCombo $combo | Out-Null
    }
    'hotkey' {
      $combo = [string]$evt.combo
      if ($combo -eq 'Ctrl+Shift+Esc') {
        # Injected Ctrl+Shift+Esc is unreliable from a non-elevated process; start Task Manager directly.
        Start-Process taskmgr.exe
      } else {
        Send-KeyCombo $combo | Out-Null
      }
    }
    'monitor' {
      Select-Monitor ([int]$evt.index)
    }
    'launch' {
      $target = [string]$evt.target
      Start-Process $target
    }
    'shell' {
      $cmd = [string]$evt.command
      Start-Process powershell.exe -ArgumentList "-NoExit", "-Command", $cmd
    }
    'clipboard' {
      [System.Windows.Forms.Clipboard]::SetText([string]$evt.text)
    }
    'quality' {
      $mw = if ($null -ne $evt.maxWidth) { [int]$evt.maxWidth } else { 1152 }
      $jq = if ($null -ne $evt.jpegQuality) { [int]$evt.jpegQuality } else { 62 }
      $script:streamer.SetQuality($mw, $jq)
    }
  }
}

Write-Host ""
Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host "  DeskBridge Windows Host Agent" -ForegroundColor White
Write-Host "  Workstation: $HostName ($GroupLabel)" -ForegroundColor Gray
Write-Host "  Resolution : \${screenW}x\${screenH}" -ForegroundColor Gray
Write-Host "=====================================================" -ForegroundColor Cyan

while ($true) {
  $script:AuthRejected = $false
  $ws = New-Object System.Net.WebSockets.ClientWebSocket
  $ws.Options.SetRequestHeader('ngrok-skip-browser-warning', 'true')
  # Unsolicited pongs keep the relay heartbeat satisfied even if a ping reply is delayed.
  $ws.Options.KeepAliveInterval = [TimeSpan]::FromSeconds(10)
  try {
    Write-Host "Connecting to DeskBridge Relay: $RelayWsUrl ..." -ForegroundColor Yellow
    $ws.ConnectAsync([Uri]$RelayWsUrl, [System.Threading.CancellationToken]::None).Wait()

    Send-WsJson $ws @{
      event = 'host:register'
      payload = @{
        hostId = $HostId
        name = $HostName
        groupLabel = $GroupLabel
        os = [System.Environment]::OSVersion.VersionString
        screenWidth = $screenW
        screenHeight = $screenH
        monitors = (Get-MonitorList)
        activeMonitor = $script:activeMonitor
        agentType = 'windows-native'
        enrollKey = $EnrollKey
        hostSecret = $script:HostSecret
      }
    }

    $buffer = New-Object byte[] 65536
    $recvMs = New-Object System.IO.MemoryStream
    $script:sendTask = $null
    $script:streamer.Paused = $true
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    $frameSeq = 0
    $inFlight = @{}          # seq -> send time (ms)
    $rttMs = 0.0             # smoothed send -> ack round trip
    $kbps = 0.0              # smoothed upload rate
    $bytesWindow = 0
    $rateWindowStart = 0
    $controllers = 0

    $recvTask = $null
    $shouldClose = $false
    while ($ws.State -eq [System.Net.WebSockets.WebSocketState]::Open -and -not $shouldClose) {
      $drained = 0
      $pendingRelDx = 0
      $pendingRelDy = 0

      while ($drained -lt 80) {
        if ($null -eq $recvTask) {
          $seg = New-Object System.ArraySegment[byte]($buffer, 0, $buffer.Length)
          $recvTask = $ws.ReceiveAsync($seg, [System.Threading.CancellationToken]::None)
        }
        $waitMs = if ($drained -eq 0) { 2 } else { 0 }
        if (-not $recvTask.Wait($waitMs)) {
          break
        }
        $result = $recvTask.Result
        $recvTask = $null
        if ($result.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) {
          $shouldClose = $true
          break
        }
        $recvMs.Write($buffer, 0, $result.Count)
        if ($result.EndOfMessage) {
          $msgText = [System.Text.Encoding]::UTF8.GetString($recvMs.GetBuffer(), 0, [int]$recvMs.Length)
          $recvMs.SetLength(0)
          $msg = $jsonSerializer.DeserializeObject($msgText)

          if ($msg.event -eq 'host:auth_error') {
            Write-Host "Relay rejected this agent: $($msg.payload.error)" -ForegroundColor Red
            $script:AuthRejected = $true
          } elseif ($msg.event -eq 'host:registered') {
            if ($msg.payload.ContainsKey('hostSecret') -and $msg.payload.hostSecret) {
              $script:HostSecret = [string]$msg.payload.hostSecret
              $script:HostSecret | Out-File -FilePath $hostSecretFile -Encoding ascii -NoNewline
            }
            $code = $msg.payload.pairingCode
            $pairUrl = "$AppBaseUrl/?pair=$code&host=$HostId"
            Write-Host ""
            Write-Host "  ONLINE & READY TO PAIR" -ForegroundColor Green
            Write-Host "  Pairing Code : $code" -ForegroundColor Cyan
            Write-Host "  Pair Link    : $pairUrl" -ForegroundColor White
            Write-Host "  Scan QR inside the DeskBridge Host Console or enter code $code on your phone." -ForegroundColor Gray
            Write-Host ""
          } elseif ($msg.event -eq 'host:controller_count') {
            $controllers = [int]$msg.payload.count
            $inFlight.Clear()
            $script:streamer.Paused = ($controllers -le 0)
            if ($controllers -gt 0) { $script:streamer.RequestKeyframe() }
          } elseif ($msg.event -eq 'host:keyframe_request') {
            $script:streamer.RequestKeyframe()
          } elseif ($msg.event -eq 'host:frame_ack') {
            if ($null -ne $msg.payload.seq) {
              $ackSeq = [int]$msg.payload.seq
              # Relay-generated acks (frame reached no controller) free the window but say
              # nothing about the end-to-end path, so they are not RTT samples.
              $isRelayAck = $msg.payload.ContainsKey('relay') -and $msg.payload.relay -eq $true
              if ($inFlight.ContainsKey($ackSeq) -and -not $isRelayAck) {
                $sample = $clock.ElapsedMilliseconds - $inFlight[$ackSeq]
                $rttMs = if ($rttMs -le 0) { [double]$sample } else { 0.7 * $rttMs + 0.3 * $sample }
              }
              foreach ($k in @($inFlight.Keys)) { if ($k -le $ackSeq) { $inFlight.Remove($k) } }
            }
          } elseif ($msg.event -eq 'client:input') {
            $ev = $msg.payload
            if ($ev.type -ne 'quality') { $script:streamer.NotifyActivity() }
            if ($ev.type -eq 'mousemove' -and $ev.relative -eq $true) {
              $pendingRelDx += [int]$ev.dx
              $pendingRelDy += [int]$ev.dy
            } else {
              if ($pendingRelDx -ne 0 -or $pendingRelDy -ne 0) {
                $pos = [System.Windows.Forms.Cursor]::Position
                $nx = [Math]::Max($bounds.X, [Math]::Min($bounds.X + $screenW - 1, $pos.X + $pendingRelDx))
                $ny = [Math]::Max($bounds.Y, [Math]::Min($bounds.Y + $screenH - 1, $pos.Y + $pendingRelDy))
                [DeskBridgeWin32]::SetCursorPos($nx, $ny) | Out-Null
                $pendingRelDx = 0
                $pendingRelDy = 0
              }
              try {
                Handle-RemoteInput $ev
              } catch {
                Write-Host "Input '$($ev.type)' failed: $($_.Exception.Message)" -ForegroundColor DarkYellow
              }
            }
          }
        }
        $drained++
      }

      if ($script:monitorChanged) {
        $script:monitorChanged = $false
        Send-WsJson $ws @{
          event = 'host:update'
          payload = @{
            screenWidth = $screenW
            screenHeight = $screenH
            activeMonitor = $script:activeMonitor
            monitors = (Get-MonitorList)
          }
        }
      }

      if ($pendingRelDx -ne 0 -or $pendingRelDy -ne 0) {
        $pos = [System.Windows.Forms.Cursor]::Position
        $nx = [Math]::Max($bounds.X, [Math]::Min($bounds.X + $screenW - 1, $pos.X + $pendingRelDx))
        $ny = [Math]::Max($bounds.Y, [Math]::Min($bounds.Y + $screenH - 1, $pos.Y + $pendingRelDy))
        [DeskBridgeWin32]::SetCursorPos($nx, $ny) | Out-Null
      }

      # A failed async send means the connection is gone: surface it to the reconnect logic.
      if ($null -ne $script:sendTask -and $script:sendTask.IsCompleted) {
        $done = $script:sendTask
        $script:sendTask = $null
        if ($done.IsFaulted) { throw $done.Exception.InnerException }
      }

      $nowMs = $clock.ElapsedMilliseconds
      # If acks stop arriving (e.g. a controller vanished mid-frame), do not stall forever.
      if ($inFlight.Count -ge $MaxInFlight) {
        $oldest = ($inFlight.Values | Measure-Object -Minimum).Minimum
        if (($nowMs - $oldest) -gt 1500) { $inFlight.Clear() }
      }

      if ($controllers -gt 0 -and $null -eq $script:sendTask -and $inFlight.Count -lt $MaxInFlight) {
        $frame = $script:streamer.TryTakeFrame()
        if ($null -ne $frame) {
          $frameSeq++
          $stats = @{
            cap = [Math]::Round($frame.CaptureMs, 1)
            enc = [Math]::Round($frame.EncodeMs, 1)
            kbps = [Math]::Round($kbps)
            q = $frame.Quality
            mw = $frame.Width
            ch = $frame.ChangedTiles
            tt = $frame.TotalTiles
            inf = $inFlight.Count
          }
          # Only report RTT once measured; the relay's adaptive quality treats it as a real sample.
          if ($rttMs -gt 0) { $stats.rtt = [Math]::Round($rttMs) }
          $sent = Start-FrameSend $ws $frame $frameSeq ([DeskBridgeWin32]::GetActiveWindowTitle()) $stats
          $inFlight[$frameSeq] = $nowMs
          $bytesWindow += $sent
        }
      }

      if (($nowMs - $rateWindowStart) -ge 1000) {
        $instant = ($bytesWindow * 8.0) / ($nowMs - $rateWindowStart)
        $kbps = if ($kbps -le 0) { $instant } else { 0.6 * $kbps + 0.4 * $instant }
        $bytesWindow = 0
        $rateWindowStart = $nowMs
      }
      if ($script:streamer.LastError) {
        Write-Host "Capture error: $($script:streamer.LastError)" -ForegroundColor DarkYellow
        $script:streamer.LastError = ''
      }
    }
  } catch {
    Write-Host "Connection interrupted: $($_.Exception.Message). Reconnecting in 4s..." -ForegroundColor Red
  } finally {
    $script:streamer.Paused = $true
    $script:sendTask = $null
    $ws.Dispose()
  }
  if ($script:AuthRejected) {
    Write-Host "Retrying in 60s. Re-download the agent from the DeskBridge Host tab if this keeps happening." -ForegroundColor Yellow
    Start-Sleep -Seconds 60
  } else {
    Start-Sleep -Seconds 4
  }
}
`;
}

export function generateBatchLauncher(scriptName = 'DeskBridge-Host.ps1'): string {
  return `@echo off
title DeskBridge Windows Host Agent
echo Starting DeskBridge Windows Host Agent...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0${scriptName}"
pause
`;
}

export function generateNodeHostScript(opts: WindowsAgentOptions): string {
  return `// DeskBridge Cross-Platform Node.js Host Agent (Node 22+)
// Run: node deskbridge-host.mjs
// SECURITY: this file contains your DeskBridge enrollment key. Do not share or commit it.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { exec, execFile } from 'node:child_process';

const RELAY_WS_URL = ${JSON.stringify(opts.wsUrl)};
const APP_URL = ${JSON.stringify(opts.appUrl)};
const HOST_NAME = process.env.DESKBRIDGE_NAME || ${JSON.stringify(opts.hostName)};
const GROUP_LABEL = process.env.DESKBRIDGE_GROUP || ${JSON.stringify(opts.groupLabel)};
const ENROLL_KEY = ${JSON.stringify(opts.enrollKey)};
const HOST_ID = 'node-' + os.hostname().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10);
const SECRET_FILE = path.join(os.homedir(), '.deskbridge-host.json');

function loadHostSecret() {
  try {
    const data = JSON.parse(fs.readFileSync(SECRET_FILE, 'utf8'));
    return data.hostId === HOST_ID ? String(data.hostSecret || '') : '';
  } catch {
    return '';
  }
}

function saveHostSecret(secret) {
  fs.writeFileSync(SECRET_FILE, JSON.stringify({ hostId: HOST_ID, hostSecret: secret }), { mode: 0o600 });
}

// Open a file, app or URL without passing the target through a shell.
function launchTarget(target) {
  if (process.platform === 'win32') {
    execFile('powershell.exe', ['-NoProfile', '-Command', 'Start-Process -FilePath $env:DESKBRIDGE_TARGET'], {
      env: { ...process.env, DESKBRIDGE_TARGET: target },
    });
  } else if (process.platform === 'darwin') {
    execFile('open', [target]);
  } else {
    execFile('xdg-open', [target]);
  }
}

let retryDelayMs = 4000;

function connect() {
  const ws = new WebSocket(RELAY_WS_URL);
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({
      event: 'host:register',
      payload: {
        hostId: HOST_ID,
        name: HOST_NAME,
        groupLabel: GROUP_LABEL,
        os: \`\${os.type()} \${os.release()}\`,
        screenWidth: 1920,
        screenHeight: 1080,
        agentType: 'windows-native',
        enrollKey: ENROLL_KEY,
        hostSecret: loadHostSecret(),
      },
    }));
  });

  ws.addEventListener('message', (evt) => {
    const msg = JSON.parse(String(evt.data));
    if (msg.event === 'host:auth_error') {
      console.error(\`[DeskBridge] Relay rejected this agent: \${msg.payload.error}\`);
      retryDelayMs = 60000;
    } else if (msg.event === 'host:registered') {
      retryDelayMs = 4000;
      if (msg.payload.hostSecret) saveHostSecret(msg.payload.hostSecret);
      console.log(\`[DeskBridge] Paired Host Ready: \${HOST_NAME}\`);
      console.log(\`[DeskBridge] Pairing Code: \${msg.payload.pairingCode}\`);
      console.log(\`[DeskBridge] Pair URL: \${APP_URL}/?pair=\${msg.payload.pairingCode}&host=\${HOST_ID}\`);
    } else if (msg.event === 'client:input') {
      const input = msg.payload;
      if (input.type === 'launch' && input.target) {
        launchTarget(String(input.target));
      } else if (input.type === 'shell' && input.command) {
        exec(input.command, (err, stdout, stderr) => {
          console.log('[Shell]', stdout || stderr || err?.message || 'done');
        });
      }
    }
  });

  ws.addEventListener('close', () => {
    console.log(\`[DeskBridge] Disconnected. Reconnecting in \${retryDelayMs / 1000}s...\`);
    setTimeout(connect, retryDelayMs);
  });
}

connect();
`;
}
