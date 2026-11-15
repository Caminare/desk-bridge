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
  [int]$FrameIntervalMs = 250,
  [int]$JpegQuality = 55
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
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
  public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);

  public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  public const uint MOUSEEVENTF_LEFTUP = 0x0004;
  public static uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
  public static uint MOUSEEVENTF_RIGHTUP = 0x0010;
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

function Capture-ScreenBase64 {
  $bmp = New-Object System.Drawing.Bitmap($screenW, $screenH)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)

  $targetW = [Math]::Min(1280, $screenW)
  $targetH = [int]([Math]::Round($screenH * ($targetW / $screenW)))
  $scaled = New-Object System.Drawing.Bitmap($targetW, $targetH)
  $sg = [System.Drawing.Graphics]::FromImage($scaled)
  $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::Bilinear
  $sg.DrawImage($bmp, 0, 0, $targetW, $targetH)

  $ms = New-Object System.IO.MemoryStream
  $scaled.Save($ms, $jpegCodec, $encoderParams)
  $b64 = [Convert]::ToBase64String($ms.ToArray())

  $ms.Dispose()
  $sg.Dispose()
  $scaled.Dispose()
  $g.Dispose()
  $bmp.Dispose()
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
        $nx = [int]([Math]::Round([double]$evt.x * $screenW))
        $ny = [int]([Math]::Round([double]$evt.y * $screenH))
        [DeskBridgeWin32]::SetCursorPos($nx, $ny) | Out-Null
      }
      if ($evt.button -eq 'right') {
        [DeskBridgeWin32]::mouse_event([DeskBridgeWin32]::MOUSEEVENTF_RIGHTDOWN, 0, 0, 0, [UIntPtr]::Zero)
        [DeskBridgeWin32]::mouse_event([DeskBridgeWin32]::MOUSEEVENTF_RIGHTUP, 0, 0, 0, [UIntPtr]::Zero)
      } else {
        $count = if ($evt.double -eq $true) { 2 } else { 1 }
        for ($i = 0; $i -lt $count; $i++) {
          [DeskBridgeWin32]::mouse_event([DeskBridgeWin32]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
          [DeskBridgeWin32]::mouse_event([DeskBridgeWin32]::MOUSEEVENTF_LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
          Start-Sleep -Milliseconds 40
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
    $lastFrame = [DateTime]::MinValue
    $controllers = 0

    $recvTask = $null
    while ($ws.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
      if ($null -eq $recvTask) {
        $seg = New-Object System.ArraySegment[byte]($buffer, 0, $buffer.Length)
        $recvTask = $ws.ReceiveAsync($seg, [System.Threading.CancellationToken]::None)
      }

      if ($recvTask.IsCompleted) {
        $result = $recvTask.Result
        $recvTask = $null
        if ($result.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) { break }
        $msgText = [System.Text.Encoding]::UTF8.GetString($buffer, 0, $result.Count)
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
          Handle-RemoteInput $msg.payload
        }
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
      Start-Sleep -Milliseconds 25
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
