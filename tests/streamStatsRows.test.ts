import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { StreamStats } from '../src/lib/frameCompositor.js';
import { buildStatsRows } from '../src/lib/streamStatsRows.js';

const base: StreamStats = { fps: 7, kbpsIn: 690, decodeMs: 1.4, queued: 0, width: 911, height: 569, keyframes: 0, skipped: 0 };

const agent = {
  sfps: 4,
  rtt: 247,
  brtt: 242,
  cap: 73.2,
  cm: 'fast',
  sm: 'coc',
  caps: 73.2,
  capc: 18.4,
  dif: 2.1,
  tick: 80.5,
  cfps: 11.8,
  pfps: 9,
  same: 0,
  drop: 5,
  rd: 0.5,
  kf: 3,
  kr: 'big',
  age: 120,
  snd: 4,
  lps: 210,
  kreq: 0,
};

const value = (rows: [string, string][], label: string) => rows.find(([k]) => k === label)?.[1];

test('basic rows without agent stats', () => {
  const rows = buildStatsRows(base, true);
  assert.deepEqual(rows.map(([k]) => k), ['FPS', 'Down', 'Decode', 'Size']);
  assert.equal(value(rows, 'Down'), '0.69 Mbps');
  assert.equal(value(rows, 'Size'), '911×569');
});

test('detailed rows explain the capture-to-send gap', () => {
  const rows = buildStatsRows({ ...base, agent }, true);
  assert.equal(value(rows, 'Queue'), '5 ms');
  assert.equal(value(rows, 'Scaling'), 'coarse');
  assert.equal(value(rows, 'Cap smooth'), '73.2 ms');
  assert.equal(value(rows, 'Cap coarse'), '18.4 ms');
  assert.equal(value(rows, 'Captures'), '11.8/s');
  assert.equal(value(rows, 'Dropped'), '5.0/s');
  assert.equal(value(rows, 'Keyframes'), '3.0/s (>50%)');
  assert.equal(value(rows, 'Mailbox'), '120 ms');
  assert.equal(value(rows, 'Agent loop'), '210/s');
});

test('compact rows (fullscreen overlay) leave out the diagnostics', () => {
  const rows = buildStatsRows({ ...base, agent }, false);
  assert.equal(value(rows, 'Agent FPS'), '4.0');
  assert.equal(value(rows, 'Scaling'), undefined);
  assert.equal(value(rows, 'Dropped'), undefined);
});

test('missing diagnostics from an older agent show as dashes', () => {
  const rows = buildStatsRows({ ...base, agent: { sfps: 4, cap: 60 } }, true);
  assert.equal(value(rows, 'Scaling'), '–');
  assert.equal(value(rows, 'Cap coarse'), '–');
  assert.equal(value(rows, 'Keyframes'), '–');
});

test('labels are unique (they are React keys)', () => {
  const rows = buildStatsRows({ ...base, queued: 3, skipped: 2, agent }, true);
  const labels = rows.map(([k]) => k);
  assert.equal(new Set(labels).size, labels.length);
});
