import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdaptiveQuality, QUALITY_LADDER, capLevelFor } from '../server/adaptiveStream.js';

test('capLevelFor picks the best level within the preset width', () => {
  assert.equal(QUALITY_LADDER[capLevelFor(1600)].maxWidth, 1600);
  assert.equal(QUALITY_LADDER[capLevelFor(1152)].maxWidth, 1152);
  assert.equal(QUALITY_LADDER[capLevelFor(854)].maxWidth, 800);
  assert.equal(QUALITY_LADDER[capLevelFor(100)].maxWidth, 640);
});

test('steps down on high RTT, respecting the hold time', () => {
  const a = new AdaptiveQuality(1152, { downHoldMs: 1000 });
  const start = a.level;
  assert.ok(a.onRttSample(600, 2000));
  assert.equal(a.level, start + 1);
  assert.equal(a.onRttSample(600, 2500), null, 'within hold');
  assert.ok(a.onRttSample(600, 3100));
  assert.equal(a.level, start + 2);
});

test('very high RTT drops two levels at once and never goes below the lowest', () => {
  const a = new AdaptiveQuality(1152);
  a.onRttSample(5000, 10_000);
  assert.equal(a.level, capLevelFor(1152) + 2);
  for (let t = 20_000; t < 40_000; t += 2000) a.onRttSample(5000, t);
  assert.equal(a.level, QUALITY_LADDER.length - 1);
});

test('steps up slowly when calm, never above the cap', () => {
  const a = new AdaptiveQuality(1152, { upHoldMs: 4000 });
  a.onRttSample(600, 2000);
  a.onRttSample(600, 4000);
  const low = a.level;
  assert.equal(a.onRttSample(50, 6000), null, 'not calm long enough');
  assert.ok(a.onRttSample(50, 8001));
  assert.equal(a.level, low - 1);
  for (let t = 20_000; t < 100_000; t += 5000) a.onRttSample(50, t);
  assert.equal(a.level, a.cap);
});

test('medium RTT holds steady', () => {
  const a = new AdaptiveQuality(1152);
  for (let t = 0; t < 30_000; t += 1000) assert.equal(a.onRttSample(300, t), null);
});

test('setCap jumps to the new preset', () => {
  const a = new AdaptiveQuality(1152);
  assert.equal(a.setCap(1600).maxWidth, 1600);
  assert.equal(a.setCap(854).maxWidth, 800);
  assert.equal(a.onRttSample(-1), null, 'ignores invalid samples');
});
