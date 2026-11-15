import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateNodeHostScript, generatePowerShellHostScript } from '../server/windowsAgentGenerator.js';

const opts = {
  wsUrl: 'wss://relay.example/ws',
  appUrl: 'https://relay.example',
  hostName: "Bob's PC",
  groupLabel: "O'Office",
  enrollKey: 'enroll-key-123',
};

test('PowerShell agent escapes single quotes in embedded values', () => {
  const ps1 = generatePowerShellHostScript(opts);
  assert.ok(ps1.includes("[string]$HostName = 'Bob''s PC'"));
  assert.ok(ps1.includes("[string]$GroupLabel = 'O''Office'"));
  assert.ok(ps1.includes("[string]$EnrollKey = 'enroll-key-123'"));
});

test('PowerShell agent sends enrollment key and host secret on register', () => {
  const ps1 = generatePowerShellHostScript(opts);
  assert.match(ps1, /enrollKey = \$EnrollKey/);
  assert.match(ps1, /hostSecret = \$script:HostSecret/);
  assert.match(ps1, /host:auth_error/);
});

test('Node agent is valid JavaScript and never shells out for launch', () => {
  const js = generateNodeHostScript({ ...opts, hostName: 'name"; process.exit(1); "' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskbridge-agent-'));
  const file = path.join(dir, 'agent.mjs');
  try {
    fs.writeFileSync(file, js);
    execFileSync(process.execPath, ['--check', file]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(js.includes('"enroll-key-123"'));
  assert.match(js, /launchTarget\(String\(input\.target\)\)/);
  assert.doesNotMatch(js, /start ""/);
});

function splitCSharpBlocks(ps1: string) {
  const blocks: string[] = [];
  let rest = '';
  let cursor = 0;
  const re = /@"\n([\s\S]*?)\n"@/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(ps1))) {
    blocks.push(m[1]);
    rest += ps1.slice(cursor, m.index);
    cursor = m.index + m[0].length;
  }
  rest += ps1.slice(cursor);
  return { blocks, rest };
}

test('PowerShell agent: balanced C# and script blocks', () => {
  const ps1 = generatePowerShellHostScript(opts);
  const { blocks, rest } = splitCSharpBlocks(ps1);
  assert.equal(blocks.length, 2, 'Win32 helpers + capture pipeline');
  const count = (t: string, c: string) => t.split(c).length - 1;
  for (const [open, close] of [['{', '}'], ['(', ')'], ['[', ']']]) {
    blocks.forEach((cs, i) => assert.equal(count(cs, open), count(cs, close), `C# block ${i} ${open}${close} balanced`));
    assert.equal(count(rest, open), count(rest, close), `PowerShell ${open}${close} balanced`);
  }
  for (const cs of blocks) {
    // The C# lives in a JS template literal (escape sequences would be mangled) and inside a
    // PowerShell expandable here-string (a $ would be interpolated).
    assert.doesNotMatch(cs, /\\/, 'no backslashes in C#');
    assert.doesNotMatch(cs, /\$/, 'no $ in C#');
    // Windows PowerShell 5.1 compiles with the C# 5 compiler.
    assert.doesNotMatch(cs, /\?\.|=>|\bnameof\b/, 'no C# 6+ syntax');
  }
  assert.doesNotMatch(ps1, /undefined/);
});

test('PowerShell agent: capture pipeline runs on a thread and sends tiled frames', () => {
  const ps1 = generatePowerShellHostScript(opts);
  for (const needle of [
    'Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"',
    'public class DeskBridgeStreamer',
    'public DeskBridgeFrame TryTakeFrame()',
    'New-Object DeskBridgeStreamer -ArgumentList $bounds, $MaxStreamWidth, $JpegQuality',
    '$script:streamer.Start()',
    "$script:sendBuf[1] = 0x02",
    "$msg.event -eq 'host:keyframe_request'",
    '$script:streamer.SetQuality($mw, $jq)',
    '$script:streamer.SetBounds($script:bounds)',
    '[int]$MaxInFlight = 32',
    '$windowOpen = ($inFlight.Count -eq 0) -or ($inFlight.Count -lt $MaxInFlight -and $inFlightBytes -lt $byteBudget)',
    '$stats.brtt = [Math]::Round($baseRttMs)',
    'double pixelBudget = mw * (mw * 9.0 / 16.0);',
    'StretchBlt(memDC, 0, 0, outW, outH, screen, curBounds.X, curBounds.Y, curBounds.Width, curBounds.Height, SRCCOPY)',
    'dibBitmap = new Bitmap(w, h, stride, PixelFormat.Format24bppRgb, dibBits);',
    'AllowFastCapture = false;',
    'activeUntil = Math.Max(activeUntil, clock.ElapsedMilliseconds + 500);',
    "cm = $(if ($frame.FastCapture) { 'fast' } else { 'gdi+' })",
  ]) {
    assert.ok(ps1.includes(needle), `missing: ${needle}`);
  }
  // Old single-threaded capture path is gone.
  assert.doesNotMatch(ps1, /Capture-ScreenBinary|Update-CaptureConfig/);
  // Frame sends are asynchronous: no .Wait() on the binary send.
  assert.doesNotMatch(ps1, /WebSocketMessageType\]::Binary[^\n]*\.Wait\(\)/);
});

test('PowerShell agent: SendInput keyboard and monitor switching are wired up', () => {
  const ps1 = generatePowerShellHostScript(opts);
  for (const needle of [
    'public static uint TypeUnicode(string text)',
    'public static uint SendCombo(ushort[] modifiers, ushort vk)',
    'function Send-KeyCombo([string]$combo)',
    'function Select-Monitor([int]$index)',
    "[DeskBridgeWin32]::TypeUnicode([string]$evt.text)",
    "    'monitor' {",
    "event = 'host:update'",
    'monitors = (Get-MonitorList)',
    '[int]$MonitorIndex = -1',
  ]) {
    assert.ok(ps1.includes(needle), `missing: ${needle}`);
  }
  // SendKeys is gone: it mangled Unicode and could not express arbitrary combos.
  assert.doesNotMatch(ps1, /SendKeys/);
});
