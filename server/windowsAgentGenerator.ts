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
  [int]$FrameIntervalMs = 80,
  [int]$JpegQuality = 62,
  [int]$MaxStreamWidth = 1152,
  # -1 = primary monitor; otherwise an index into [System.Windows.Forms.Screen]::AllScreens
  [int]$MonitorIndex = -1
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

$jpegCodec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
$encoderParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
$encoderParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]$JpegQuality)

$capBmp = New-Object System.Drawing.Bitmap($screenW, $screenH, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$capG = [System.Drawing.Graphics]::FromImage($capBmp)
$capMs = New-Object System.IO.MemoryStream
$script:targetW = 0
$script:targetH = 0
$script:targetQ = $JpegQuality
$script:scaledBmp = $null
$script:scaledG = $null
$script:fastBmp = $null
$script:fastG = $null
$script:fastW = 0
$script:fastH = 0
$script:sendBuf = New-Object byte[] 2097152
$script:fastEncoderParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
$script:fastEncoderParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]50)

function Update-CaptureConfig([int]$maxW, [int]$quality) {
  $script:lastMaxW = $maxW
  $script:lastQuality = $quality
  $q = [Math]::Max(30, [Math]::Min(95, $quality))
  $script:targetQ = $q
  $encoderParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]$q)
  $fq = [Math]::Min(50, $q)
  $script:fastEncoderParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]$fq)

  $nextW = [Math]::Min([Math]::Max(640, $maxW), $screenW)
  $nextH = [int]([Math]::Round($screenH * ($nextW / $screenW)))
  if ($nextW -ne $script:targetW -or $nextH -ne $script:targetH) {
    if ($null -ne $script:scaledG) { $script:scaledG.Dispose() }
    if ($null -ne $script:scaledBmp) { $script:scaledBmp.Dispose() }
    $script:targetW = $nextW
    $script:targetH = $nextH
    if ($nextW -lt $screenW) {
      $script:scaledBmp = New-Object System.Drawing.Bitmap($nextW, $nextH, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
      $script:scaledG = [System.Drawing.Graphics]::FromImage($script:scaledBmp)
      $script:scaledG.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::Bilinear
      $script:scaledG.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
      $script:scaledG.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighSpeed
      $script:scaledG.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighSpeed
    } else {
      $script:scaledBmp = $null
      $script:scaledG = $null
    }
  }

  $mw = [Math]::Min(880, $nextW)
  $mh = [int]([Math]::Round($screenH * ($mw / $screenW)))
  if ($mw -ne $script:fastW -or $mh -ne $script:fastH) {
    if ($null -ne $script:fastG) { $script:fastG.Dispose() }
    if ($null -ne $script:fastBmp) { $script:fastBmp.Dispose() }
    $script:fastW = $mw
    $script:fastH = $mh
    $script:fastBmp = New-Object System.Drawing.Bitmap($mw, $mh, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $script:fastG = [System.Drawing.Graphics]::FromImage($script:fastBmp)
    $script:fastG.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::Bilinear
    $script:fastG.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
    $script:fastG.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighSpeed
    $script:fastG.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighSpeed
  }
}

Update-CaptureConfig $MaxStreamWidth $JpegQuality

function Select-Monitor([int]$index) {
  $resolved = Resolve-MonitorIndex $index
  $script:activeMonitor = $resolved
  $script:bounds = [System.Windows.Forms.Screen]::AllScreens[$resolved].Bounds
  $script:screenW = $script:bounds.Width
  $script:screenH = $script:bounds.Height
  $capG.Dispose()
  $capBmp.Dispose()
  $script:capBmp = New-Object System.Drawing.Bitmap($script:screenW, $script:screenH, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $script:capG = [System.Drawing.Graphics]::FromImage($script:capBmp)
  # Force scaled buffers to be rebuilt for the new resolution.
  $script:targetW = 0
  $script:fastW = 0
  Update-CaptureConfig $script:lastMaxW $script:lastQuality
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

function Capture-ScreenBinary([bool]$fastMotion) {
  $capG.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
  $hdc = $capG.GetHdc()
  try {
    [DeskBridgeWin32]::DrawCursor($hdc, $bounds.X, $bounds.Y)
  } finally {
    $capG.ReleaseHdc($hdc)
  }

  $capMs.SetLength(0)
  if ($fastMotion -and $null -ne $script:fastBmp -and $null -ne $script:fastG) {
    $script:fastG.DrawImage($capBmp, 0, 0, $script:fastW, $script:fastH)
    $script:fastBmp.Save($capMs, $jpegCodec, $script:fastEncoderParams)
  } elseif ($null -ne $script:scaledBmp -and $null -ne $script:scaledG) {
    $script:scaledG.DrawImage($capBmp, 0, 0, $script:targetW, $script:targetH)
    $script:scaledBmp.Save($capMs, $jpegCodec, $encoderParams)
  } else {
    $capBmp.Save($capMs, $jpegCodec, $encoderParams)
  }

  $len = [int]$capMs.Length
  $buf = $capMs.GetBuffer()
  $sig = if ($fastMotion) { "f:$len" } else { "h:$len" }
  if ($len -gt 64) {
    $step = [Math]::Max(1, [int]($len / 32))
    for ($i = 0; $i -lt $len; $i += $step) {
      $sig += ":$($buf[$i])"
    }
  }
  return @{
    length = $len
    sig = $sig
  }
}

function Send-WsJson($ws, $obj) {
  $json = $jsonSerializer.Serialize($obj)
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  $seg = New-Object System.ArraySegment[byte]($bytes, 0, $bytes.Length)
  $ws.SendAsync($seg, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [System.Threading.CancellationToken]::None).Wait()
}

function Send-WsBinaryFrame($ws, [string]$hid, [int]$seq, [string]$activeWin, [long]$ts, [System.IO.MemoryStream]$jpegMs) {
  $metaJson = $jsonSerializer.Serialize(@{
    hostId = $hid
    seq = $seq
    activeWindow = $activeWin
    timestamp = $ts
  })
  $metaBytes = [System.Text.Encoding]::UTF8.GetBytes($metaJson)
  $metaLen = $metaBytes.Length
  $jpegLen = [int]$jpegMs.Length
  $totalLen = 4 + $metaLen + $jpegLen

  if ($totalLen -gt $script:sendBuf.Length) {
    $script:sendBuf = New-Object byte[] ($totalLen + 65536)
  }

  $script:sendBuf[0] = 0x44
  $script:sendBuf[1] = 0x01
  $script:sendBuf[2] = [byte](($metaLen -shr 8) -band 0xFF)
  $script:sendBuf[3] = [byte]($metaLen -band 0xFF)
  [Array]::Copy($metaBytes, 0, $script:sendBuf, 4, $metaLen)
  [Array]::Copy($jpegMs.GetBuffer(), 0, $script:sendBuf, 4 + $metaLen, $jpegLen)

  $seg = New-Object System.ArraySegment[byte]($script:sendBuf, 0, $totalLen)
  $ws.SendAsync($seg, [System.Net.WebSockets.WebSocketMessageType]::Binary, $true, [System.Threading.CancellationToken]::None).Wait()
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
      $mw = if ($null -ne $evt.maxWidth) { [int]$evt.maxWidth } else { 1280 }
      $jq = if ($null -ne $evt.jpegQuality) { [int]$evt.jpegQuality } else { 68 }
      Update-CaptureConfig $mw $jq
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
    $lastFrame = [DateTime]::MinValue
    $lastFrameSentAt = [DateTime]::MinValue
    $motionUntil = [DateTime]::MinValue
    $lastWasMotion = $false
    $lastSig = ''
    $frameSeq = 0
    $lastAckSeq = 0
    $inputDirty = $false
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
            $lastAckSeq = $frameSeq
            $lastSig = ''
          } elseif ($msg.event -eq 'host:frame_ack') {
            if ($null -ne $msg.payload.seq) {
              $ackSeq = [int]$msg.payload.seq
              if ($ackSeq -gt $lastAckSeq) { $lastAckSeq = $ackSeq }
            } else {
              $lastAckSeq = $frameSeq
            }
          } elseif ($msg.event -eq 'client:input') {
            $ev = $msg.payload
            if ($ev.type -eq 'mousemove' -and $ev.relative -eq $true) {
              $pendingRelDx += [int]$ev.dx
              $pendingRelDy += [int]$ev.dy
              $inputDirty = $true
              $motionUntil = ([DateTime]::UtcNow).AddMilliseconds(280)
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
              $inputDirty = $true
              if ($ev.type -ne 'quality') {
                $motionUntil = ([DateTime]::UtcNow).AddMilliseconds(280)
              } else {
                $lastSig = ''
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
        $lastSig = ''
        $inputDirty = $true
      }

      if ($pendingRelDx -ne 0 -or $pendingRelDy -ne 0) {
        $pos = [System.Windows.Forms.Cursor]::Position
        $nx = [Math]::Max($bounds.X, [Math]::Min($bounds.X + $screenW - 1, $pos.X + $pendingRelDx))
        $ny = [Math]::Max($bounds.Y, [Math]::Min($bounds.Y + $screenH - 1, $pos.Y + $pendingRelDy))
        [DeskBridgeWin32]::SetCursorPos($nx, $ny) | Out-Null
      }

      $now = [DateTime]::UtcNow
      $inFlight = $frameSeq - $lastAckSeq
      $canSendByAck = ($inFlight -lt 2) -or (($now - $lastFrameSentAt).TotalMilliseconds -ge 450)
      $elapsedMs = ($now - $lastFrame).TotalMilliseconds
      $inMotion = ($now -lt $motionUntil)
      $minInterval = if ($inputDirty -or $inMotion) { 30 } else { $FrameIntervalMs }

      if ($controllers -gt 0 -and $canSendByAck -and $elapsedMs -ge $minInterval) {
        $useFast = $inMotion
        $cap = Capture-ScreenBinary $useFast
        $needSettle = ($lastWasMotion -and (-not $useFast))
        $changed = ($cap.sig -ne $lastSig) -or $inputDirty -or $needSettle -or ($elapsedMs -ge 1000)
        if ($changed) {
          $frameSeq++
          $activeWin = [DeskBridgeWin32]::GetActiveWindowTitle()
          $ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
          Send-WsBinaryFrame $ws $HostId $frameSeq $activeWin $ts $capMs
          $lastSig = $cap.sig
          $lastWasMotion = $useFast
          $lastFrame = $now
          $lastFrameSentAt = $now
          $inputDirty = $false
        }
      }
    }
  } catch {
    Write-Host "Connection interrupted: $($_.Exception.Message). Reconnecting in 4s..." -ForegroundColor Red
  } finally {
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
