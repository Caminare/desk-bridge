export interface WindowsAgentOptions {
  wsUrl: string;
  appUrl: string;
  hostName: string;
  groupLabel: string;
}

export function generatePowerShellHostScript(opts: WindowsAgentOptions): string {
  const safeName = opts.hostName.replace(/'/g, "''");
  const safeGroup = opts.groupLabel.replace(/'/g, "''");
  const safeWsUrl = opts.wsUrl.replace(/'/g, "''");
  const safeAppUrl = opts.appUrl.replace(/'/g, "''");

  return `<#
  DeskBridge Windows Host Agent
  Exposes this Windows PC to your DeskBridge mobile controller over encrypted WebSockets.
  Works natively on Windows 10 / 11 with PowerShell 5.1+ (.NET Framework).
#>

param(
  [string]$HostName = '${safeName}',
  [string]$GroupLabel = '${safeGroup}',
  [string]$RelayWsUrl = '${safeWsUrl}',
  [string]$AppBaseUrl = '${safeAppUrl}',
  [int]$FrameIntervalMs = 130,
  [int]$JpegQuality = 78,
  [int]$MaxStreamWidth = 1600
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
  public const uint KEYEVENTF_KEYUP = 0x0002;

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

$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
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
$script:scaledBmp = $null
$script:scaledG = $null

function Update-CaptureConfig([int]$maxW, [int]$quality) {
  $q = [Math]::Max(30, [Math]::Min(95, $quality))
  $encoderParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]$q)
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
      $script:scaledG.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBilinear
      $script:scaledG.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighSpeed
    } else {
      $script:scaledBmp = $null
      $script:scaledG = $null
    }
  }
}

Update-CaptureConfig $MaxStreamWidth $JpegQuality

function Capture-ScreenBase64 {
  $capG.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
  $capMs.SetLength(0)
  if ($null -ne $script:scaledBmp -and $null -ne $script:scaledG) {
    $script:scaledG.DrawImage($capBmp, 0, 0, $script:targetW, $script:targetH)
    $script:scaledBmp.Save($capMs, $jpegCodec, $encoderParams)
  } else {
    $capBmp.Save($capMs, $jpegCodec, $encoderParams)
  }
  $b64 = [Convert]::ToBase64String($capMs.GetBuffer(), 0, [int]$capMs.Length)
  return "data:image/jpeg;base64,$b64"
}

function Send-WsJson($ws, $obj) {
  $json = $jsonSerializer.Serialize($obj)
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  $seg = New-Object System.ArraySegment[byte]($bytes, 0, $bytes.Length)
  $ws.SendAsync($seg, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [System.Threading.CancellationToken]::None).Wait()
}

function Handle-RemoteInput($evt) {
  switch ($evt.type) {
    'mousemove' {
      if ($evt.relative -eq $true) {
        $pos = [System.Windows.Forms.Cursor]::Position
        $nx = [Math]::Max(0, [Math]::Min($screenW - 1, $pos.X + [int]$evt.dx))
        $ny = [Math]::Max(0, [Math]::Min($screenH - 1, $pos.Y + [int]$evt.dy))
        [DeskBridgeWin32]::SetCursorPos($nx, $ny) | Out-Null
      } else {
        $nx = [int]([Math]::Round([double]$evt.x * $screenW))
        $ny = [int]([Math]::Round([double]$evt.y * $screenH))
        [DeskBridgeWin32]::SetCursorPos($nx, $ny) | Out-Null
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
      $wheel = [int](-$evt.deltaY * 120)
      [DeskBridgeWin32]::mouse_event([DeskBridgeWin32]::MOUSEEVENTF_WHEEL, 0, 0, $wheel, [UIntPtr]::Zero)
    }
    'type' {
      $escaped = [System.Text.RegularExpressions.Regex]::Replace([string]$evt.text, '([+^%~(){}\\[\\]])', '{$1}')
      [System.Windows.Forms.SendKeys]::SendWait($escaped)
    }
    'key' {
      $k = [string]$evt.key
      $map = @{
        'Enter' = '{ENTER}'; 'Tab' = '{TAB}'; 'Escape' = '{ESC}'; 'Backspace' = '{BACKSPACE}';
        'Delete' = '{DELETE}'; 'ArrowUp' = '{UP}'; 'ArrowDown' = '{DOWN}'; 'ArrowLeft' = '{LEFT}'; 'ArrowRight' = '{RIGHT}'
      }
      if ($map.ContainsKey($k)) {
        [System.Windows.Forms.SendKeys]::SendWait($map[$k])
      }
    }
    'hotkey' {
      $combo = [string]$evt.combo
      switch ($combo) {
        'Win+D' {
          [DeskBridgeWin32]::keybd_event(0x5B, 0, 0, [UIntPtr]::Zero)
          [DeskBridgeWin32]::keybd_event(0x44, 0, 0, [UIntPtr]::Zero)
          [DeskBridgeWin32]::keybd_event(0x44, 0, [DeskBridgeWin32]::KEYEVENTF_KEYUP, [UIntPtr]::Zero)
          [DeskBridgeWin32]::keybd_event(0x5B, 0, [DeskBridgeWin32]::KEYEVENTF_KEYUP, [UIntPtr]::Zero)
        }
        'Win+L' { [DeskBridgeWin32]::LockWorkStation() | Out-Null }
        'Alt+Tab' { [System.Windows.Forms.SendKeys]::SendWait('%{TAB}') }
        'Ctrl+C' { [System.Windows.Forms.SendKeys]::SendWait('^c') }
        'Ctrl+V' { [System.Windows.Forms.SendKeys]::SendWait('^v') }
        'Ctrl+S' { [System.Windows.Forms.SendKeys]::SendWait('^s') }
        'Ctrl+Shift+Esc' { Start-Process taskmgr.exe }
      }
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
      $mw = if ($null -ne $evt.maxWidth) { [int]$evt.maxWidth } else { 1600 }
      $jq = if ($null -ne $evt.jpegQuality) { [int]$evt.jpegQuality } else { 78 }
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
  $ws = New-Object System.Net.WebSockets.ClientWebSocket
  $ws.Options.SetRequestHeader('ngrok-skip-browser-warning', 'true')
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
        agentType = 'windows-native'
      }
    }

    $buffer = New-Object byte[] 65536
    $recvMs = New-Object System.IO.MemoryStream
    $lastFrame = [DateTime]::MinValue
    $controllers = 0

    $recvTask = $null
    $shouldClose = $false
    while ($ws.State -eq [System.Net.WebSockets.WebSocketState]::Open -and -not $shouldClose) {
      $drained = 0
      $pendingRelDx = 0
      $pendingRelDy = 0

      while ($drained -lt 60) {
        if ($null -eq $recvTask) {
          $seg = New-Object System.ArraySegment[byte]($buffer, 0, $buffer.Length)
          $recvTask = $ws.ReceiveAsync($seg, [System.Threading.CancellationToken]::None)
        }
        $waitMs = if ($drained -eq 0) { 3 } else { 0 }
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

          if ($msg.event -eq 'host:registered') {
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
          } elseif ($msg.event -eq 'client:input') {
            $ev = $msg.payload
            if ($ev.type -eq 'mousemove' -and $ev.relative -eq $true) {
              $pendingRelDx += [int]$ev.dx
              $pendingRelDy += [int]$ev.dy
            } else {
              if ($pendingRelDx -ne 0 -or $pendingRelDy -ne 0) {
                $pos = [System.Windows.Forms.Cursor]::Position
                $nx = [Math]::Max(0, [Math]::Min($screenW - 1, $pos.X + $pendingRelDx))
                $ny = [Math]::Max(0, [Math]::Min($screenH - 1, $pos.Y + $pendingRelDy))
                [DeskBridgeWin32]::SetCursorPos($nx, $ny) | Out-Null
                $pendingRelDx = 0
                $pendingRelDy = 0
              }
              Handle-RemoteInput $ev
            }
          }
        }
        $drained++
      }

      if ($pendingRelDx -ne 0 -or $pendingRelDy -ne 0) {
        $pos = [System.Windows.Forms.Cursor]::Position
        $nx = [Math]::Max(0, [Math]::Min($screenW - 1, $pos.X + $pendingRelDx))
        $ny = [Math]::Max(0, [Math]::Min($screenH - 1, $pos.Y + $pendingRelDy))
        [DeskBridgeWin32]::SetCursorPos($nx, $ny) | Out-Null
      }

      $now = [DateTime]::UtcNow
      if ($controllers -gt 0 -and ($now - $lastFrame).TotalMilliseconds -ge $FrameIntervalMs) {
        $frame = Capture-ScreenBase64
        $activeWin = [DeskBridgeWin32]::GetActiveWindowTitle()
        Send-WsJson $ws @{
          event = 'host:frame'
          payload = @{
            hostId = $HostId
            frame = $frame
            activeWindow = $activeWin
            timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
          }
        }
        $lastFrame = $now
      }
    }
  } catch {
    Write-Host "Connection interrupted: $($_.Exception.Message). Reconnecting in 4s..." -ForegroundColor Red
  } finally {
    $ws.Dispose()
  }
  Start-Sleep -Seconds 4
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
import os from 'node:os';
import { exec } from 'node:child_process';

const RELAY_WS_URL = ${JSON.stringify(opts.wsUrl)};
const APP_URL = ${JSON.stringify(opts.appUrl)};
const HOST_NAME = process.env.DESKBRIDGE_NAME || ${JSON.stringify(opts.hostName)};
const GROUP_LABEL = process.env.DESKBRIDGE_GROUP || ${JSON.stringify(opts.groupLabel)};
const HOST_ID = 'node-' + os.hostname().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10);

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
      },
    }));
  });

  ws.addEventListener('message', (evt) => {
    const msg = JSON.parse(String(evt.data));
    if (msg.event === 'host:registered') {
      console.log(\`[DeskBridge] Paired Host Ready: \${HOST_NAME}\`);
      console.log(\`[DeskBridge] Pairing Code: \${msg.payload.pairingCode}\`);
      console.log(\`[DeskBridge] Pair URL: \${APP_URL}/?pair=\${msg.payload.pairingCode}&host=\${HOST_ID}\`);
    } else if (msg.event === 'client:input') {
      const input = msg.payload;
      if (input.type === 'launch' && input.target) {
        const cmd = process.platform === 'win32' ? \`start "" "\${input.target}"\` : \`open "\${input.target}"\`;
        exec(cmd);
      } else if (input.type === 'shell' && input.command) {
        exec(input.command, (err, stdout, stderr) => {
          console.log('[Shell]', stdout || stderr || err?.message || 'done');
        });
      }
    }
  });

  ws.addEventListener('close', () => {
    console.log('[DeskBridge] Disconnected. Reconnecting in 4s...');
    setTimeout(connect, 4000);
  });
}

connect();
`;
}
