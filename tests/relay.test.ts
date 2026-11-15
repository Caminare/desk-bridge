import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TestSocket,
  decodeFrameMeta,
  encodeFrame,
  getEnrollKey,
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
    ['GET', '/api/host-agent/download?format=ps1'],
    ['POST', '/api/ai/command'],
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

  test('authenticated requests succeed and agent download is not cacheable', async () => {
    const cookie = await loginCookie(t.base);
    assert.equal((await fetch(`${t.base}/api/hosts`, { headers: { cookie } })).status, 200);
    const dl = await fetch(`${t.base}/api/host-agent/download?format=ps1`, { headers: { cookie } });
    assert.equal(dl.status, 200);
    assert.equal(dl.headers.get('cache-control'), 'no-store');
  });
});

describe('WebSocket host and controller protocol', () => {
  let t: TestRelay;
  let cookie: string;
  let enrollKey: string;
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
  const registerHost = async (hostId: string, extra: Record<string, unknown> = {}) => {
    const h = await open();
    h.send('host:register', { hostId, name: hostId, enrollKey, ...extra });
    await h.until((s) => Boolean(s.event('host:registered') || s.event('host:auth_error')), 2000, 'registration');
    return h;
  };

  before(async () => {
    t = await startTestRelay();
    cookie = await loginCookie(t.base);
    enrollKey = await getEnrollKey(t.base, cookie);
  });
  after(async () => {
    sockets.forEach((s) => s.close());
    await t.stop();
  });

  test('host without enrollment key is rejected with 4401', async () => {
    const h = await open();
    h.send('host:register', { hostId: 'no-key' });
    await h.until((s) => s.closeCode !== null, 2000, 'close');
    assert.ok(h.event('host:auth_error'));
    assert.equal(h.closeCode, 4401);
  });

  test('enrolled host receives a one-time host secret', async () => {
    const h = await registerHost('host-a');
    assert.ok(h.event('host:registered')?.payload.hostSecret);
  });

  test('re-registering a host id without its secret is rejected', async () => {
    const legit = await registerHost('host-b');
    const hijack = await registerHost('host-b');
    assert.ok(hijack.event('host:auth_error'));
    await sleep(50);
    assert.equal(legit.ws.readyState, legit.ws.OPEN);
  });

  test('host reconnects with its secret, replacing the old socket', async () => {
    const first = await registerHost('host-c');
    const hostSecret = first.event('host:registered')!.payload.hostSecret;
    const second = await registerHost('host-c', { hostSecret });
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
    await registerHost('host-x');
    const xo = await open({ headers: { cookie, origin: 'https://evil.example' } });
    xo.send('client:pair', { hostId: 'host-x' });
    await xo.until((s) => s.closeCode !== null, 2000, 'close');
    assert.equal(xo.closeCode, 4401);
    assert.equal(xo.event('client:paired'), undefined);
  });

  test('fleet updates never include host secrets', async () => {
    await registerHost('host-d');
    const c = await openController();
    const raw = JSON.stringify(c.messages);
    assert.ok(raw.includes('host-d'));
    assert.ok(!raw.includes('secretHash'));
    assert.ok(!raw.includes('hostSecret'));
    assert.ok(!raw.includes(enrollKey));
  });

  test('frames and input flow between paired controller and host', async () => {
    const h = await registerHost('host-e');
    const c = await openController();
    c.send('client:pair', { hostId: 'host-e' });
    await c.until((s) => Boolean(s.event('client:paired')), 2000, 'paired');

    h.ws.send(encodeFrame({ hostId: 'host-e', seq: 1 }, Buffer.from('jpeg-1')));
    await c.until((s) => s.binaries.length === 1, 2000, 'frame');
    assert.equal(decodeFrameMeta(c.binaries[0]).hostId, 'host-e');

    c.send('client:input', { hostId: 'host-e', input: { type: 'type', text: 'hello' } });
    await h.until((s) => s.messages.some((m) => m.event === 'client:input'), 2000, 'input');
    assert.equal(h.messages.find((m) => m.event === 'client:input')!.payload.text, 'hello');
  });

  test('a host cannot inject frames into another host stream', async () => {
    await registerHost('victim');
    const attacker = await registerHost('attacker');
    const c = await openController();
    c.send('client:pair', { hostId: 'victim' });
    await c.until((s) => Boolean(s.event('client:paired')), 2000, 'paired');

    attacker.ws.send(encodeFrame({ hostId: 'victim', seq: 1 }, Buffer.from('fake')));
    attacker.send('host:frame', { hostId: 'victim', frame: 'data:image/jpeg;base64,AAAA' });
    await sleep(200);
    assert.equal(c.binaries.length, 0);
    assert.equal(c.messages.filter((m) => m.event === 'host:frame').length, 0);
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
    const enrollKey = await getEnrollKey(t.base, cookie);
    // autoPong: false simulates a connection that died silently.
    const host = await TestSocket.open(t.wsUrl, { autoPong: false });
    host.send('host:register', { hostId: 'zombie', enrollKey });
    await host.until((s) => Boolean(s.event('host:registered')), 2000, 'registered');

    const healthy = await TestSocket.open(t.wsUrl);
    healthy.send('host:register', { hostId: 'healthy', enrollKey });
    await healthy.until((s) => Boolean(s.event('host:registered')), 2000, 'registered');

    await host.until((s) => s.closeCode !== null, 2000, 'zombie terminated');
    await sleep(350);
    assert.equal(healthy.ws.readyState, healthy.ws.OPEN, 'responsive host stays connected');

    const hosts = (await (await fetch(`${t.base}/api/hosts`, { headers: { cookie } })).json()).hosts as Array<{
      hostId: string;
      status: string;
    }>;
    assert.equal(hosts.find((h) => h.hostId === 'zombie')?.status, 'offline');
    assert.equal(hosts.find((h) => h.hostId === 'healthy')?.status, 'online');
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

  test('missing Gemini key yields 503, and requests are rate limited per session', async () => {
    const cookie = await loginCookie(t.base);
    const call = () =>
      fetch(`${t.base}/api/ai/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ prompt: 'open notepad' }),
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
