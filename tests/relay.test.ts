import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFrame as encodeFrameV, parseFrame } from '../src/lib/frameProtocol.js';
import {
  TestSocket,
  decodeFrameMeta,
  encodeFrame,
  enrollHost,
  loginCookie,
  sleep,
  startTestRelay,
  type TestRelay,
} from './helpers.js';

describe('REST authentication', () => {
  let t: TestRelay;
  before(async () => {
    t = await startTestRelay();
  });
  after(() => t.stop());

  for (const [method, path] of [
    ['GET', '/api/hosts'],
    ['POST', '/api/agent/enroll-codes'],
    ['POST', '/api/ai/transcribe'],
    ['POST', '/api/hosts/pair-code'],
    ['PATCH', '/api/hosts/x'],
    ['DELETE', '/api/hosts/x'],
    ['GET', '/api/qr?data=x'],
  ] as const) {
    test(`anonymous ${method} ${path} is 401`, async () => {
      const res = await fetch(`${t.base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : '{}' });
      assert.equal(res.status, 401);
    });
  }

  test('anonymous health check reveals nothing beyond ok', async () => {
    const data = await (await fetch(`${t.base}/api/health`)).json();
    assert.deepEqual(data, { ok: true });
  });

  test('authenticated health check includes transcriptionReady and omits geminiReady', async () => {
    const cookie = await loginCookie(t.base);
    const data = await (await fetch(`${t.base}/api/health`, { headers: { cookie } })).json();
    assert.equal(data.ok, true);
    assert.equal(typeof data.transcriptionReady, 'boolean');
    assert.equal('geminiReady' in data, false);
  });

  test('wrong token is rejected, right token sets an HttpOnly cookie', async () => {
    const bad = await fetch(`${t.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'nope' }),
    });
    assert.equal(bad.status, 401);

    const good = await fetch(`${t.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'test-owner-token-0123456789' }),
    });
    assert.equal(good.status, 200);
    const setCookie = good.headers.get('set-cookie') || '';
    assert.match(setCookie, /^db_session=/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
  });

  test('forged session cookie is not accepted', async () => {
    const res = await fetch(`${t.base}/api/hosts`, { headers: { cookie: 'db_session=9999999999999.abc.forged' } });
    assert.equal(res.status, 401);
  });

  test('authenticated requests succeed and legacy agent download route is gone', async () => {
    const cookie = await loginCookie(t.base);
    assert.equal((await fetch(`${t.base}/api/hosts`, { headers: { cookie } })).status, 200);
    assert.equal((await fetch(`${t.base}/api/host-agent/download?format=ps1`, { headers: { cookie } })).status, 404);
  });
});

describe('WebSocket host and controller protocol', () => {
  let t: TestRelay;
  let cookie: string;
  const sockets: TestSocket[] = [];
  const open = async (opts?: Parameters<typeof TestSocket.open>[1]) => {
    const s = await TestSocket.open(t.wsUrl, opts);
    sockets.push(s);
    return s;
  };
  const openController = async () => {
    const c = await open({ headers: { cookie, origin: t.base } });
    c.send('client:subscribe_fleet');
    await c.until((s) => Boolean(s.event('fleet:update')), 2000, 'fleet:update');
    return c;
  };
  const registerEnrolledHost = async (name: string, extra: Record<string, unknown> = {}) => {
    const creds = await enrollHost(t.base, cookie, name);
    const h = await open();
    h.send('host:register', { hostId: creds.hostId, hostSecret: creds.hostSecret, name, ...extra });
    await h.until((s) => Boolean(s.event('host:registered') || s.event('host:auth_error')), 2000, 'registration');
    return { h, ...creds };
  };

  before(async () => {
    t = await startTestRelay();
    cookie = await loginCookie(t.base);
  });
  after(async () => {
    sockets.forEach((s) => s.close());
    await t.stop();
  });

  test('host without a secret is rejected with 4401', async () => {
    const h = await open();
    h.send('host:register', { hostId: 'no-secret' });
    await h.until((s) => s.closeCode !== null, 2000, 'close');
    assert.ok(h.event('host:auth_error'));
    assert.equal(h.closeCode, 4401);
  });

  test('re-registering a host id with the wrong secret is rejected without dropping the live host', async () => {
    const { h: legit, hostId } = await registerEnrolledHost('host-b');
    const hijack = await open();
    hijack.send('host:register', { hostId, hostSecret: 'wrong-secret', name: 'host-b' });
    await hijack.until((s) => s.closeCode !== null, 2000, 'close');
    assert.ok(hijack.event('host:auth_error'));
    assert.equal(hijack.closeCode, 4401);
    await sleep(50);
    assert.equal(legit.ws.readyState, legit.ws.OPEN);
  });

  test('host reconnects with its secret, replacing the old socket', async () => {
    const { h: first, hostId, hostSecret } = await registerEnrolledHost('host-c');
    const second = await open();
    second.send('host:register', { hostId, hostSecret, name: 'host-c' });
    await second.until((s) => Boolean(s.event('host:registered')), 2000, 'registered');
    const reg = second.event('host:registered');
    assert.ok(reg, 'registered');
    assert.equal(reg.payload.hostSecret, undefined, 'no new secret issued');
    await first.until((s) => s.closeCode !== null, 2000, 'old socket closed');
    assert.equal(first.closeCode, 4409);
  });

  test('anonymous controller events are rejected', async () => {
    const anon = await open();
    anon.send('client:subscribe_fleet');
    await anon.until((s) => s.closeCode !== null, 2000, 'close');
    assert.ok(anon.event('auth:required'));
    assert.equal(anon.event('fleet:update'), undefined);
    assert.equal(anon.closeCode, 4401);
  });

  test('a session cookie from a foreign origin is treated as anonymous', async () => {
    const { hostId } = await registerEnrolledHost('host-x');
    const xo = await open({ headers: { cookie, origin: 'https://evil.example' } });
    xo.send('client:pair', { hostId });
    await xo.until((s) => s.closeCode !== null, 2000, 'close');
    assert.equal(xo.closeCode, 4401);
    assert.equal(xo.event('client:paired'), undefined);
  });

  test('fleet updates never include host secrets', async () => {
    const { hostId, hostSecret } = await registerEnrolledHost('host-d');
    const c = await openController();
    const raw = JSON.stringify(c.messages);
    assert.ok(raw.includes(hostId));
    assert.ok(!raw.includes('secretHash'));
    assert.ok(!raw.includes('hostSecret'));
    assert.ok(!raw.includes(hostSecret));
  });

  test('frames and input flow between paired controller and host', async () => {
    const { h, hostId } = await registerEnrolledHost('host-e');
    const c = await openController();
    c.send('client:pair', { hostId });
    await c.until((s) => Boolean(s.event('client:paired')), 2000, 'paired');

    h.ws.send(encodeFrame({ hostId, seq: 1 }, Buffer.from('jpeg-1')));
    await c.until((s) => s.binaries.length === 1, 2000, 'frame');
    assert.equal(decodeFrameMeta(c.binaries[0]).hostId, hostId);

    c.send('client:input', { hostId, input: { type: 'type', text: 'hello' } });
    await h.until((s) => s.messages.some((m) => m.event === 'client:input'), 2000, 'input');
    assert.equal(h.messages.find((m) => m.event === 'client:input')!.payload.text, 'hello');
  });

  test('a host cannot inject frames into another host stream', async () => {
    const { hostId: victimId } = await registerEnrolledHost('victim');
    const { h: attacker } = await registerEnrolledHost('attacker');
    const c = await openController();
    c.send('client:pair', { hostId: victimId });
    await c.until((s) => Boolean(s.event('client:paired')), 2000, 'paired');

    attacker.ws.send(encodeFrame({ hostId: victimId, seq: 1 }, Buffer.from('fake')));
    attacker.send('host:frame', { hostId: victimId, frame: 'data:image/jpeg;base64,AAAA' });
    await sleep(200);
    assert.equal(c.binaries.length, 0);
    assert.equal(c.messages.filter((m) => m.event === 'host:frame').length, 0);
  });

  test('hosts report monitors; host:update is validated and broadcast', async () => {
    const { h, hostId } = await registerEnrolledHost('multi', {
      screenWidth: 2560,
      screenHeight: 1440,
      monitors: [
        { index: 0, name: 'DISPLAY1', width: 2560, height: 1440, primary: true },
        { index: 1, name: 'DISPLAY2', width: 1920, height: 1080, primary: false },
        { index: 2, name: 'bogus', width: -5, height: 'x' },
      ],
      activeMonitor: 0,
    });
    const c = await openController();
    const hostIn = (msgs: TestSocket['messages']) =>
      [...msgs].reverse().find((m) => m.event === 'fleet:update')?.payload as unknown as Array<Record<string, any>>;
    let multi = hostIn(c.messages).find((x) => x.hostId === hostId)!;
    assert.equal(multi.monitors.length, 2, 'malformed monitor dropped');
    assert.equal(multi.activeMonitor, 0);

    const before = c.messages.length;
    h.send('host:update', { screenWidth: 1920, screenHeight: 1080, activeMonitor: 1 });
    await c.until((s) => s.messages.length > before && s.messages.slice(before).some((m) => m.event === 'fleet:update'), 2000, 'fleet update');
    multi = hostIn(c.messages).find((x) => x.hostId === hostId)!;
    assert.equal(multi.activeMonitor, 1);
    assert.equal(multi.screenWidth, 1920);

    // Unknown monitor index and absurd sizes are rejected.
    const mark = c.messages.length;
    h.send('host:update', { screenWidth: 999999, activeMonitor: 7 });
    await c.until((s) => s.messages.slice(mark).some((m) => m.event === 'fleet:update'), 2000, 'fleet update');
    multi = hostIn(c.messages).find((x) => x.hostId === hostId)!;
    assert.equal(multi.screenWidth, 1920);
    assert.equal(multi.activeMonitor, undefined);
  });

  test('monitor switch input is forwarded to the host', async () => {
    const { h, hostId } = await registerEnrolledHost('multi-2');
    const c = await openController();
    c.send('client:pair', { hostId });
    await c.until((s) => Boolean(s.event('client:paired')), 2000, 'paired');
    c.send('client:input', { hostId, input: { type: 'monitor', index: 1 } });
    await h.until((s) => s.messages.some((m) => m.event === 'client:input' && m.payload.type === 'monitor'), 2000, 'input');
  });

  const cursorShape = (id: string) => ({
    id,
    w: 2,
    h: 2,
    hotX: 1,
    hotY: 0,
    rgba: Buffer.alloc(16, 0xff).toString('base64'),
  });
  const fleetHost = (c: TestSocket, hostId: string) =>
    ([...c.messages].reverse().find((m) => m.event === 'fleet:update')?.payload as unknown as Array<Record<string, any>>).find(
      (x) => x.hostId === hostId,
    );

  test('a host advertising client cursor support is acknowledged and flagged in the fleet', async () => {
    const { h: withCursor, hostId: cursorId } = await registerEnrolledHost('cursor-yes', { cursor: true });
    const { h: without, hostId: plainId } = await registerEnrolledHost('cursor-no');
    assert.equal(withCursor.event('host:registered')!.payload.clientCursor, true);
    assert.notEqual(without.event('host:registered')!.payload.clientCursor, true);

    const c = await openController();
    assert.equal(fleetHost(c, cursorId)!.clientCursor, true);
    assert.notEqual(fleetHost(c, plainId)!.clientCursor, true);

    // A pairing-code refresh re-sends host:registered; it must not turn frame cursors back on.
    withCursor.send('host:regenerate_code');
    await withCursor.until((s) => s.messages.filter((m) => m.event === 'host:registered').length === 2, 2000, 'second registered');
    assert.equal(withCursor.messages.filter((m) => m.event === 'host:registered')[1].payload.clientCursor, true);
  });

  test('cursor shape and position flow from the host to paired controllers; invalid ones are dropped', async () => {
    const { h, hostId } = await registerEnrolledHost('cursor-flow', { cursor: true });
    const c = await openController();
    c.send('client:pair', { hostId });
    await c.until((s) => Boolean(s.event('client:paired')), 2000, 'paired');

    h.send('host:cursor_shape', { ...cursorShape('bad'), w: 500 });
    h.send('host:cursor', { x: 'nope', y: 0, visible: true, shape: 'arrow' });
    h.send('host:cursor_shape', cursorShape('arrow'));
    h.send('host:cursor', { x: 0.5, y: 0.25, visible: true, shape: 'arrow' });
    await c.until((s) => Boolean(s.event('host:cursor')), 2000, 'cursor position');

    const shapes = c.messages.filter((m) => m.event === 'host:cursor_shape');
    assert.equal(shapes.length, 1);
    assert.deepEqual(shapes[0].payload, { hostId, ...cursorShape('arrow') });
    const positions = c.messages.filter((m) => m.event === 'host:cursor');
    assert.equal(positions.length, 1);
    assert.deepEqual(positions[0].payload, { hostId, x: 0.5, y: 0.25, visible: true, shape: 'arrow' });
  });

  test('a controller pairing later gets the recent cursor shapes, then the position', async () => {
    const { h, hostId } = await registerEnrolledHost('cursor-replay', { cursor: true });
    h.send('host:cursor_shape', cursorShape('arrow'));
    h.send('host:cursor_shape', cursorShape('ibeam'));
    h.send('host:cursor', { x: 0.1, y: 0.2, visible: true, shape: 'ibeam' });
    await sleep(100);

    const c = await openController();
    c.send('client:pair', { hostId });
    await c.until((s) => Boolean(s.event('host:cursor')), 2000, 'replayed cursor');
    const events = c.messages.filter((m) => m.event.startsWith('host:cursor'));
    // Agents send each shape once per connection (animated cursors reuse them), so all recent ones are replayed.
    assert.deepEqual(
      events.map((m) => (m.event === 'host:cursor' ? 'pos' : m.payload.id)),
      ['arrow', 'ibeam', 'pos'],
    );
    assert.equal(c.event('host:cursor')!.payload.x, 0.1);
  });

  test('the relay keeps at most 32 cursor shapes per host, dropping the least recently sent', async () => {
    const { h, hostId } = await registerEnrolledHost('cursor-cache', { cursor: true });
    for (let i = 0; i < 33; i++) h.send('host:cursor_shape', cursorShape(`s${i}`));
    h.send('host:cursor_shape', cursorShape('s1')); // re-sent: becomes the most recent
    h.send('host:cursor', { x: 0.5, y: 0.5, visible: true, shape: 's1' });
    await sleep(150);

    const c = await openController();
    c.send('client:pair', { hostId });
    await c.until((s) => Boolean(s.event('host:cursor')), 2000, 'replayed cursor');
    const ids = c.messages.filter((m) => m.event === 'host:cursor_shape').map((m) => m.payload.id);
    assert.equal(ids.length, 32);
    assert.ok(!ids.includes('s0'), 'oldest evicted');
    assert.equal(ids[0], 's2', 's1 moved to the end when re-sent');
    assert.equal(ids[ids.length - 1], 's1');
  });

  test('a host cannot send cursor messages into another host stream', async () => {
    const { hostId: victimId } = await registerEnrolledHost('cursor-victim', { cursor: true });
    const { h: attacker } = await registerEnrolledHost('cursor-attacker', { cursor: true });
    const c = await openController();
    c.send('client:pair', { hostId: victimId });
    await c.until((s) => Boolean(s.event('client:paired')), 2000, 'paired');

    attacker.send('host:cursor_shape', { hostId: victimId, ...cursorShape('evil') });
    attacker.send('host:cursor', { hostId: victimId, x: 0.5, y: 0.5, visible: true, shape: 'evil' });
    const anon = await open();
    anon.send('host:cursor', { hostId: victimId, x: 0.5, y: 0.5, visible: true, shape: null });
    await sleep(200);
    assert.equal(c.messages.filter((m) => m.event.startsWith('host:cursor')).length, 0);
  });

  test('oversized messages close the socket without crashing the relay', async () => {
    const big = await open();
    big.ws.send(Buffer.alloc(9 * 1024 * 1024));
    await big.until((s) => s.closeCode !== null, 3000, 'close');
    assert.equal(big.closeCode, 1009);
    const res = await fetch(`${t.base}/api/health`);
    assert.equal(res.status, 200);
  });
});

describe('heartbeat', () => {
  let t: TestRelay;
  before(async () => {
    t = await startTestRelay({ heartbeatMs: 100 });
  });
  after(() => t.stop());

  test('a host that stops answering pings is terminated and marked offline', async () => {
    const cookie = await loginCookie(t.base);
    const zombieCreds = await enrollHost(t.base, cookie, 'zombie');
    const healthyCreds = await enrollHost(t.base, cookie, 'healthy');
    // autoPong: false simulates a connection that died silently.
    const host = await TestSocket.open(t.wsUrl, { autoPong: false });
    host.send('host:register', zombieCreds);
    await host.until((s) => Boolean(s.event('host:registered')), 2000, 'registered');

    const healthy = await TestSocket.open(t.wsUrl);
    healthy.send('host:register', healthyCreds);
    await healthy.until((s) => Boolean(s.event('host:registered')), 2000, 'registered');

    await host.until((s) => s.closeCode !== null, 2000, 'zombie terminated');
    await sleep(350);
    assert.equal(healthy.ws.readyState, healthy.ws.OPEN, 'responsive host stays connected');

    const hosts = (await (await fetch(`${t.base}/api/hosts`, { headers: { cookie } })).json()).hosts as Array<{
      hostId: string;
      status: string;
    }>;
    assert.equal(hosts.find((h) => h.hostId === zombieCreds.hostId)?.status, 'offline');
    assert.equal(hosts.find((h) => h.hostId === healthyCreds.hostId)?.status, 'online');
    healthy.close();
  });
});

describe('AI routes', () => {
  let t: TestRelay;
  const savedKey = process.env.GEMINI_API_KEY;
  before(async () => {
    delete process.env.GEMINI_API_KEY;
    t = await startTestRelay({ aiRateLimitPerMin: 2 });
  });
  after(async () => {
    if (savedKey !== undefined) process.env.GEMINI_API_KEY = savedKey;
    await t.stop();
  });

  test('POST /api/ai/transcribe with missing audioBase64 returns 400', async () => {
    const cookie = await loginCookie(t.base);
    const res = await fetch(`${t.base}/api/ai/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ mimeType: 'audio/webm' }),
    });
    assert.equal(res.status, 400);
  });

  test('POST /api/ai/transcribe with audioBase64 larger than 5 MB returns 413', async () => {
    const cookie = await loginCookie(t.base);
    const res = await fetch(`${t.base}/api/ai/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ audioBase64: 'A'.repeat(5 * 1024 * 1024 + 1), mimeType: 'audio/webm' }),
    });
    assert.equal(res.status, 413);
  });

  test('missing Gemini key yields 503, and requests are rate limited per session', async () => {
    const cookie = await loginCookie(t.base);
    const call = () =>
      fetch(`${t.base}/api/ai/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ audioBase64: 'AAAA', mimeType: 'audio/webm' }),
      });
    const first = await call();
    assert.equal(first.status, 503);
    assert.match((await first.json()).error, /GEMINI_API_KEY/);
    assert.equal((await call()).status, 503);
    const limited = await call();
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
  });
});

describe('tiled (v2) frames, keyframes and adaptive quality', () => {
  let t: TestRelay;
  let cookie: string;
  const sockets: TestSocket[] = [];
  const tile = (x: number, y: number, n = 1) => ({ x, y, w: 64, h: 64, data: new Uint8Array(n).fill(9) });
  const key = (seq: number, extra: Record<string, unknown> = {}) =>
    Buffer.from(encodeFrameV(2, { hostId: 'v2', seq, w: 128, h: 64, key: true, ...extra }, [{ x: 0, y: 0, w: 128, h: 64, data: new Uint8Array([1, 2]) }]));
  const delta = (seq: number, extra: Record<string, unknown> = {}) =>
    Buffer.from(encodeFrameV(2, { hostId: 'v2', seq, w: 128, h: 64, key: false, ...extra }, [tile(64, 0)]));

  async function setup(name: string) {
    const creds = await enrollHost(t.base, cookie, name);
    const h = await TestSocket.open(t.wsUrl);
    sockets.push(h);
    h.send('host:register', { ...creds, agentType: 'windows-native' });
    await h.until((s) => Boolean(s.event('host:registered')), 2000, 'registered');
    const c = await TestSocket.open(t.wsUrl, { headers: { cookie, origin: t.base } });
    sockets.push(c);
    c.send('client:pair', { hostId: creds.hostId });
    await c.until((s) => Boolean(s.event('client:paired')), 2000, 'paired');
    return { h, c, hostId: creds.hostId };
  }

  before(async () => {
    t = await startTestRelay();
    cookie = await loginCookie(t.base);
  });
  after(async () => {
    sockets.forEach((s) => s.close());
    await t.stop();
  });

  test('pairing requests a keyframe and withholds deltas until it arrives', async () => {
    const { h, c, hostId } = await setup('v2-a');
    await h.until((s) => s.messages.some((m) => m.event === 'host:keyframe_request'), 2000, 'keyframe request');

    h.ws.send(delta(1));
    await h.until((s) => s.messages.some((m) => m.event === 'host:frame_ack' && m.payload.seq === 1), 2000, 'relay ack');
    assert.equal(c.binaries.length, 0, 'delta withheld before keyframe');
    assert.equal(h.messages.find((m) => m.event === 'host:frame_ack' && m.payload.seq === 1)!.payload.relay, true);

    h.ws.send(key(2));
    h.ws.send(delta(3));
    await c.until((s) => s.binaries.length === 2, 2000, 'keyframe + delta');
    const frames = c.binaries.map((b) => parseFrame(b)!);
    assert.deepEqual(frames.map((f) => [f.header.seq, f.isKey]), [[2, true], [3, false]]);
    assert.equal(frames[0].header.hostId, hostId, 'hostId rewritten to the registered host');
  });

  test('controller keyframe requests are forwarded (throttled)', async () => {
    const { h, c, hostId } = await setup('v2-b');
    await sleep(350);
    const before = h.messages.filter((m) => m.event === 'host:keyframe_request').length;
    c.send('client:keyframe_request', { hostId });
    c.send('client:keyframe_request', { hostId });
    await h.until((s) => s.messages.filter((m) => m.event === 'host:keyframe_request').length > before, 2000, 'forwarded');
    await sleep(100);
    assert.equal(h.messages.filter((m) => m.event === 'host:keyframe_request').length, before + 1, 'throttled');
  });

  test('a full-frame keyframe becomes the cached image for new controllers', async () => {
    const { h, hostId } = await setup('v2-c');
    h.ws.send(key(1));
    await sleep(100);
    const c2 = await TestSocket.open(t.wsUrl, { headers: { cookie, origin: t.base } });
    sockets.push(c2);
    c2.send('client:pair', { hostId });
    await c2.until((s) => Boolean(s.event('client:paired')), 2000, 'paired');
    assert.equal(c2.event('client:paired')!.payload.latestFrame, 'data:image/jpeg;base64,AQI=');
  });

  test('a steady high RTT keeps quality; queuing above the baseline lowers it', async () => {
    const { h, c, hostId } = await setup('v2-d');
    const qualityMsgs = () => h.messages.filter((m) => m.event === 'client:input' && m.payload.type === 'quality');
    // Long path, no congestion: RTT high but flat.
    h.ws.send(key(1, { stats: { rtt: 600 } }));
    h.ws.send(delta(2, { stats: { rtt: 610 } }));
    await sleep(150);
    assert.equal(qualityMsgs().length, 0, 'baseline RTT alone is not congestion');
    // Frames start queuing: RTT climbs well above the 600 ms baseline.
    h.ws.send(delta(3, { stats: { rtt: 1100 } }));
    await h.until((s) => s.messages.some((m) => m.event === 'client:input' && m.payload.type === 'quality'), 2000, 'quality down');
    const down = h.messages.filter((m) => m.event === 'client:input' && m.payload.type === 'quality').at(-1)!.payload;
    assert.ok(down.maxWidth < 1152, `stepped below default (${down.maxWidth})`);

    c.send('client:input', { hostId, input: { type: 'quality', maxWidth: 1600, jpegQuality: 78 } });
    await h.until(
      (s) => s.messages.some((m) => m.event === 'client:input' && m.payload.type === 'quality' && m.payload.maxWidth === 1600),
      2000,
      'preset applied',
    );
    const applied = h.messages.filter((m) => m.event === 'client:input' && m.payload.type === 'quality').at(-1)!.payload;
    assert.equal(applied.jpegQuality, 75, 'mapped onto the ladder');
  });

  test('malformed v2 frames are dropped', async () => {
    const { h, c } = await setup('v2-e');
    h.ws.send(key(1));
    await c.until((s) => s.binaries.length === 1, 2000, 'keyframe');
    const bad = Buffer.from(encodeFrameV(2, { seq: 2, w: 64, h: 64 }, [{ x: 32, y: 0, w: 64, h: 64, data: new Uint8Array([1]) }]));
    h.ws.send(bad);
    await sleep(150);
    assert.equal(c.binaries.length, 1);
  });
});

describe('login rate limiting behind a proxy', () => {
  const tryLogin = (base: string, ip: string) =>
    fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
      body: JSON.stringify({ token: 'wrong' }),
    });

  test('with trustProxy, one client hitting the limit does not lock out others', async () => {
    const t = await startTestRelay({ trustProxy: true });
    try {
      for (let i = 0; i < 10; i++) await tryLogin(t.base, '203.0.113.7');
      assert.equal((await tryLogin(t.base, '203.0.113.7')).status, 429, 'attacker blocked');
      const other = await fetch(`${t.base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.9' },
        body: JSON.stringify({ token: 'test-owner-token-0123456789' }),
      });
      assert.equal(other.status, 200, 'owner from another IP can still log in');
    } finally {
      await t.stop();
    }
  });

  test('without trustProxy, a spoofed X-Forwarded-For does not bypass the limit', async () => {
    const t = await startTestRelay();
    try {
      for (let i = 0; i < 10; i++) await tryLogin(t.base, `10.0.0.${i}`);
      assert.equal((await tryLogin(t.base, '10.0.0.99')).status, 429);
    } finally {
      await t.stop();
    }
  });
});
