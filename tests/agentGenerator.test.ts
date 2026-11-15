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

test('PowerShell agent: balanced C# and script blocks', () => {
  const ps1 = generatePowerShellHostScript(opts);
  const start = ps1.indexOf('Add-Type @"');
  const end = ps1.indexOf('"@', start);
  const cs = ps1.slice(start, end);
  const body = ps1.slice(end + 2);
  const count = (t: string, c: string) => t.split(c).length - 1;
  for (const [open, close] of [['{', '}'], ['(', ')'], ['[', ']']]) {
    assert.equal(count(cs, open), count(cs, close), `C# ${open}${close} balanced`);
    assert.equal(count(body, open), count(body, close), `PowerShell ${open}${close} balanced`);
  }
  // The C# block lives in a JS template literal: escape sequences there would be mangled.
  assert.doesNotMatch(cs, /\\/, 'no backslashes in C# block');
  assert.doesNotMatch(ps1, /undefined/);
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
