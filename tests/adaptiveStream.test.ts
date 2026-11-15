import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdaptiveQuality, QUALITY_LADDER, capLevelFor } from '../server/adaptiveStream.js';

test('capLevelFor picks the best level within the preset width', () => {
  assert.equal(QUALITY_LADDER[capLevelFor(1600)].maxWidth, 1600);
  assert.equal(QUALITY_LADDER[capLevelFor(1152)].maxWidth, 1152);
  assert.equal(QUALITY_LADDER[capLevelFor(854)].maxWidth, 800);
  assert.equal(QUALITY_LADDER[capLevelFor(100)].maxWidth, 640);
});

test('a high but steady RTT (long path, no congestion) keeps full quality', () => {
  const a = new AdaptiveQuality(1152);
  for (let t = 0; t < 60_000; t += 100) assert.equal(a.onRttSample(600 + (t % 3) * 10, t), null);
  assert.equal(a.level, a.cap);
  assert.equal(a.baselineMs, 600);
});

test('queuing above the baseline steps down, respecting the hold time', () => {
  const a = new AdaptiveQuality(1152, { downHoldMs: 1000 });
  for (let t = 0; t < 2000; t += 100) a.onRttSample(300, t);
  const start = a.level;
  assert.ok(a.onRttSample(650, 2000), 'queue 350 ms > 250 ms');
  assert.equal(a.level, start + 1);
  assert.equal(a.onRttSample(650, 2500), null, 'within hold');
  assert.ok(a.onRttSample(650, 3100));
  assert.equal(a.level, start + 2);
});

test('heavy queuing drops two levels and never below the lowest', () => {
  const a = new AdaptiveQuality(1152);
  a.onRttSample(100, 0);
  a.onRttSample(1000, 5000);
  assert.equal(a.level, capLevelFor(1152) + 2);
  for (let t = 6000; t < 14_000; t += 1500) a.onRttSample(1000, t);
  assert.equal(a.level, QUALITY_LADDER.length - 1);
});

test('recovers once queuing clears, stepping up slowly and never above the cap', () => {
  const a = new AdaptiveQuality(1152, { upHoldMs: 4000 });
  a.onRttSample(200, 0);
  a.onRttSample(800, 2000);
  a.onRttSample(800, 4000);
  const low = a.level;
  assert.ok(low > a.cap);
  assert.equal(a.onRttSample(220, 6000), null, 'not calm long enough');
  assert.ok(a.onRttSample(220, 8001));
  assert.equal(a.level, low - 1);
  for (let t = 10_000; t < 60_000; t += 5000) a.onRttSample(220, t);
  assert.equal(a.level, a.cap);
});

test('baseline follows the path when it gets slower for good', () => {
  const a = new AdaptiveQuality(1152, { baselineWindowMs: 10_000 });
  for (let t = 0; t < 10_000; t += 500) a.onRttSample(100, t);
  // Path moves (e.g. phone switches to mobile data): RTT steady at 400.
  let t = 10_000;
  for (; t < 40_000; t += 500) a.onRttSample(400, t);
  assert.equal(a.baselineMs, 400, 'old minimum aged out');
  const lvl = a.level;
  for (; t < 60_000; t += 500) a.onRttSample(400, t);
  assert.ok(a.level <= lvl, 'no further step-downs at the new steady RTT');
});

test('setCap jumps to the new preset; invalid samples are ignored', () => {
  const a = new AdaptiveQuality(1152);
  assert.equal(a.setCap(1600).maxWidth, 1600);
  assert.equal(a.setCap(854).maxWidth, 800);
  assert.equal(a.onRttSample(-1), null);
});
