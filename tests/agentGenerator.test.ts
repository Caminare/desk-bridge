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
