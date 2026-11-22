import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  FALLBACK_CURSOR_SHAPE,
  PREDICTION_TIMEOUT_MS,
  RemoteCursor,
  RemoteCursorStore,
  activeMonitorSize,
} from '../src/lib/remoteCursor.js';
import type { CursorShape, HostProfile } from '../src/types/deskbridge.js';

const shape = (id: string): CursorShape => ({ id, w: 2, h: 2, hotX: 0, hotY: 0, rgba: 'AAAAAAAAAAAAAAAAAAAAAA==' });
const monitor = { width: 1000, height: 500 };

describe('RemoteCursor', () => {
  test('shows nothing until the agent reports a position', () => {
    const c = new RemoteCursor();
    assert.equal(c.state(0), null);
  });

  test('shows the agent position with its current shape', () => {
    const c = new RemoteCursor();
    c.onShape(shape('arrow'));
    c.onRemote({ x: 0.5, y: 0.25, visible: true, shape: 'arrow' }, 0);
    assert.deepEqual(c.state(0), { x: 0.5, y: 0.25, shape: shape('arrow') });
  });

  test('hides the cursor when the agent says it is hidden or it is on another monitor', () => {
    const c = new RemoteCursor();
    c.onShape(shape('arrow'));
    c.onRemote({ x: 0.5, y: 0.5, visible: false, shape: 'arrow' }, 0);
    assert.equal(c.state(0), null);
    c.onRemote({ x: 1.2, y: 0.5, visible: true, shape: 'arrow' }, 0);
    assert.equal(c.state(0), null);
    c.onRemote({ x: 0.5, y: -0.1, visible: true, shape: 'arrow' }, 0);
    assert.equal(c.state(0), null);
  });

  test('draws a built-in arrow when the shape is unknown, so the cursor never just disappears', () => {
    const c = new RemoteCursor();
    c.onRemote({ x: 0.5, y: 0.5, visible: true, shape: 'unknown' }, 0);
    assert.equal(c.state(0)!.shape, FALLBACK_CURSOR_SHAPE);
    c.onRemote({ x: 0.5, y: 0.5, visible: true, shape: null }, 0);
    assert.equal(c.state(0)!.shape, FALLBACK_CURSOR_SHAPE);
  });

  test('the built-in arrow is a valid shape', () => {
    const s = FALLBACK_CURSOR_SHAPE;
    assert.equal(Buffer.from(s.rgba, 'base64').length, s.w * s.h * 4);
    assert.ok(s.hotX >= 0 && s.hotX < s.w && s.hotY >= 0 && s.hotY < s.h);
  });

  test('an absolute local move is shown at once and stale agent echoes do not pull it back', () => {
    const c = new RemoteCursor();
    c.onShape(shape('arrow'));
    c.onRemote({ x: 0.1, y: 0.1, visible: true, shape: 'arrow' }, 0);
    c.onLocalInput({ type: 'mousemove', x: 0.8, y: 0.6, relative: false }, monitor, 1000);
    assert.deepEqual(c.state(1000), { x: 0.8, y: 0.6, shape: shape('arrow') });

    // Echoes of earlier input arrive a full round trip later, even after the user stopped (long paths).
    c.onRemote({ x: 0.3, y: 0.3, visible: true, shape: 'arrow' }, 1100);
    assert.equal(c.state(1500)!.x, 0.8);
  });

  test('hands over to the agent once it reports the predicted position (within 2 px)', () => {
    const c = new RemoteCursor();
    c.onShape(shape('arrow'));
    c.onRemote({ x: 0.1, y: 0.1, visible: true, shape: 'arrow' }, 0);
    c.onLocalInput({ type: 'mousemove', x: 0.8, y: 0.6, relative: false }, monitor, 1000);
    c.onRemote({ x: 0.802, y: 0.6, visible: true, shape: 'arrow' }, 1400); // 2 px off on a 1000 px monitor
    assert.equal(c.predictionEndsAt(), null);
    // From now on the agent's position is shown, e.g. when a program moves the cursor.
    c.onRemote({ x: 0.2, y: 0.2, visible: true, shape: 'arrow' }, 1500);
    assert.equal(c.state(1500)!.x, 0.2);
  });

  test('falls back to the agent position after the prediction timeout', () => {
    const c = new RemoteCursor();
    c.onShape(shape('arrow'));
    c.onRemote({ x: 0.1, y: 0.1, visible: true, shape: 'arrow' }, 0);
    c.onLocalInput({ type: 'mousemove', x: 0.8, y: 0.6, relative: false }, monitor, 1000);
    c.onRemote({ x: 0.3, y: 0.3, visible: true, shape: 'arrow' }, 1100); // never matches (clamped, blocked, ...)
    assert.equal(c.state(1000 + PREDICTION_TIMEOUT_MS - 1)!.x, 0.8);
    assert.equal(c.state(1000 + PREDICTION_TIMEOUT_MS)!.x, 0.3);
  });

  test('clicks with coordinates also predict', () => {
    const c = new RemoteCursor();
    c.onShape(shape('arrow'));
    c.onRemote({ x: 0.1, y: 0.1, visible: true, shape: 'arrow' }, 0);
    c.onLocalInput({ type: 'click', button: 'left', x: 0.4, y: 0.7 }, monitor, 1000);
    assert.equal(c.state(1000)!.y, 0.7);
  });

  test('relative moves apply the same physical-pixel deltas the agent applies, clamped to the monitor', () => {
    const c = new RemoteCursor();
    c.onShape(shape('arrow'));
    c.onRemote({ x: 0.5, y: 0.5, visible: true, shape: 'arrow' }, 0);
    c.onLocalInput({ type: 'mousemove', x: 0, y: 0, relative: true, dx: 100, dy: -50 }, monitor, 1000);
    assert.deepEqual(c.state(1000), { x: 0.6, y: 0.4, shape: shape('arrow') });

    c.onLocalInput({ type: 'mousemove', x: 0, y: 0, relative: true, dx: 5000, dy: -5000 }, monitor, 1010);
    const s = c.state(1010)!;
    assert.equal(s.x, 999 / 1000);
    assert.equal(s.y, 0);
  });

  test('a relative move after the hand-over starts from the agent position, not the old prediction', () => {
    const c = new RemoteCursor();
    c.onShape(shape('arrow'));
    c.onRemote({ x: 0.5, y: 0.5, visible: true, shape: 'arrow' }, 0);
    c.onLocalInput({ type: 'mousemove', x: 0, y: 0, relative: true, dx: 100, dy: 0 }, monitor, 1000);
    c.onRemote({ x: 0.2, y: 0.2, visible: true, shape: 'arrow' }, 1200); // a program moved the cursor
    const later = 1000 + PREDICTION_TIMEOUT_MS + 100;
    c.onLocalInput({ type: 'mousemove', x: 0, y: 0, relative: true, dx: 100, dy: 0 }, monitor, later);
    assert.equal(c.state(later)!.x, 0.3);
  });

  test('relative moves are ignored until a position is known', () => {
    const c = new RemoteCursor();
    c.onShape(shape('arrow'));
    c.onLocalInput({ type: 'mousemove', x: 0, y: 0, relative: true, dx: 10, dy: 10 }, monitor, 0);
    assert.equal(c.state(0), null);
    assert.equal(c.predictionEndsAt(), null);
  });

  test('a predicted cursor is shown even while the agent reported it hidden', () => {
    const c = new RemoteCursor();
    c.onShape(shape('arrow'));
    c.onRemote({ x: 0.5, y: 0.5, visible: false, shape: 'arrow' }, 0);
    c.onLocalInput({ type: 'mousemove', x: 0.2, y: 0.2, relative: false }, monitor, 1000);
    assert.equal(c.state(1000)!.x, 0.2);
  });

  test('predictionEndsAt tells the view when to repaint for the hand-over', () => {
    const c = new RemoteCursor();
    assert.equal(c.predictionEndsAt(), null);
    c.onLocalInput({ type: 'mousemove', x: 0.2, y: 0.2, relative: false }, monitor, 1000);
    assert.equal(c.predictionEndsAt(), 1000 + PREDICTION_TIMEOUT_MS);
  });

  test('notifies listeners on every change and stops after unsubscribe', () => {
    const c = new RemoteCursor();
    let calls = 0;
    const off = c.subscribe(() => calls++);
    c.onShape(shape('arrow'));
    c.onRemote({ x: 0.5, y: 0.5, visible: true, shape: 'arrow' }, 0);
    c.onLocalInput({ type: 'mousemove', x: 0.2, y: 0.2, relative: false }, monitor, 1);
    c.onLocalInput({ type: 'type', text: 'x' }, monitor, 2); // no cursor effect
    assert.equal(calls, 3);
    off();
    c.onRemote({ x: 0.5, y: 0.5, visible: true, shape: 'arrow' }, 3);
    assert.equal(calls, 3);
  });

  test('keeps a bounded number of shapes', () => {
    const c = new RemoteCursor();
    for (let i = 0; i < 40; i++) c.onShape(shape(`s${i}`));
    c.onRemote({ x: 0.5, y: 0.5, visible: true, shape: 's0' }, 0);
    assert.equal(c.state(0)!.shape, FALLBACK_CURSOR_SHAPE, 'oldest shape evicted');
    c.onRemote({ x: 0.5, y: 0.5, visible: true, shape: 's39' }, 0);
    assert.equal(c.state(0)!.shape.id, 's39');
  });
});

describe('RemoteCursorStore', () => {
  test('returns one cursor per host', () => {
    const store = new RemoteCursorStore();
    assert.equal(store.get('a'), store.get('a'));
    assert.notEqual(store.get('a'), store.get('b'));
  });
});

describe('activeMonitorSize', () => {
  const host = { screenWidth: 1920, screenHeight: 1080 } as HostProfile;

  test('uses the active monitor when the agent reported monitors', () => {
    const multi = {
      ...host,
      monitors: [
        { index: 0, name: 'A', width: 2560, height: 1440, primary: true },
        { index: 1, name: 'B', width: 1280, height: 1024, primary: false },
      ],
      activeMonitor: 1,
    };
    assert.deepEqual(activeMonitorSize(multi), { width: 1280, height: 1024 });
  });

  test('falls back to the screen size', () => {
    assert.deepEqual(activeMonitorSize(host), { width: 1920, height: 1080 });
  });
});
