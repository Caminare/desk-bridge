import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { TestSocket, getEnrollKey, loginCookie, startTestRelay, type TestRelay } from './helpers.js';

type Json = Record<string, any>;

async function post(base: string, path: string, body: unknown, cookie?: string): Promise<{ status: number; data: Json }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as Json };
}

describe('Agent enrollment with one-time codes', () => {
  let t: TestRelay;
  let cookie: string;
  const logs: string[] = [];
  const sockets: TestSocket[] = [];

  const mint = async () => {
    const { status, data } = await post(t.base, '/api/agent/enroll-codes', {}, cookie);
    assert.equal(status, 200);
    return data as { code: string; link: string; expiresAt: number; expiresIn: number };
  };
  const enroll = (body: Json) => post(t.base, '/api/agent/enroll', body);
  const register = async (payload: Json) => {
    const h = await TestSocket.open(t.wsUrl);
    sockets.push(h);
    h.send('host:register', payload);
    await h.until(
      (s) => Boolean(s.event('host:registered')) || s.closeCode !== null,
      2000,
      'registration or close',
    );
    return h;
  };

  before(async () => {
    t = await startTestRelay({ log: (m) => logs.push(m) });
    cookie = await loginCookie(t.base);
  });
  after(async () => {
    sockets.forEach((s) => s.close());
    await t.stop();
  });

  test('minting a code requires the owner session', async () => {
    const { status } = await post(t.base, '/api/agent/enroll-codes', {});
    assert.equal(status, 401);
  });

  test('a minted code comes with an enrollment link on this relay', async () => {
    const { code, link, expiresAt, expiresIn } = await mint();
    assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    assert.equal(link, `${t.base}/enroll/${code}`);
    assert.ok(expiresAt > Date.now());
    // Relative lifetime, so a controller with a skewed clock still counts down correctly.
    assert.ok(expiresIn > 9 * 60 * 1000 && expiresIn <= 10 * 60 * 1000, `expiresIn ${expiresIn}`);
  });

  test('a valid code enrolls a new offline host, once', async () => {
    const { code } = await mint();
    const first = await enroll({ code, name: 'Office PC' });
    assert.equal(first.status, 200);
    assert.match(first.data.hostId, /^[A-Za-z0-9_.-]+$/);
    assert.ok(first.data.hostSecret);

    const hosts = (await (await fetch(`${t.base}/api/hosts`, { headers: { cookie } })).json()).hosts as Json[];
    const host = hosts.find((h) => h.hostId === first.data.hostId);
    assert.equal(host?.name, 'Office PC');
    assert.equal(host?.status, 'offline');

    const again = await enroll({ code, name: 'Office PC' });
    assert.equal(again.status, 401);
  });

  test('unknown and malformed codes are rejected', async () => {
    for (const code of ['ZZZZ-ZZZZ', '', 'nope', 42]) {
      const { status } = await enroll({ code, name: 'x' });
      assert.equal(status, 401, `accepted ${String(code)}`);
    }
  });

  test('an enrolled host registers with its secret alone', async () => {
    const { code } = await mint();
    const { data } = await enroll({ code, name: 'Laptop' });
    const h = await register({ hostId: data.hostId, hostSecret: data.hostSecret, name: 'Laptop' });
    const reg = h.event('host:registered');
    assert.ok(reg, `closed with ${h.closeCode}`);
    assert.equal(reg.payload.hostId, data.hostId);
    assert.equal(reg.payload.hostSecret, undefined, 'no new secret issued');
  });

  test('a wrong secret for a known host closes 4401', async () => {
    const { code } = await mint();
    const { data } = await enroll({ code, name: 'Desk' });
    const h = await register({ hostId: data.hostId, hostSecret: 'wrong-secret' });
    assert.equal(h.closeCode, 4401);
  });

  test('a secret for an unknown host closes 4403', async () => {
    const h = await register({ hostId: 'never-enrolled', hostSecret: 'whatever' });
    assert.equal(h.closeCode, 4403);
    assert.ok(h.event('host:auth_error'));
  });

  test('a host deleted from the fleet closes 4403 on its next connection', async () => {
    const { code } = await mint();
    const { data } = await enroll({ code, name: 'Old PC' });
    const del = await fetch(`${t.base}/api/hosts/${data.hostId}`, { method: 'DELETE', headers: { cookie } });
    assert.equal(del.status, 200);
    const h = await register({ hostId: data.hostId, hostSecret: data.hostSecret });
    assert.equal(h.closeCode, 4403);
  });

  test('re-enrolling with previousHostId keeps the id and rotates the secret', async () => {
    const first = await enroll({ code: (await mint()).code, name: 'Studio' });
    const second = await enroll({ code: (await mint()).code, name: 'Ignored', previousHostId: first.data.hostId });
    assert.equal(second.status, 200);
    assert.equal(second.data.hostId, first.data.hostId);
    assert.notEqual(second.data.hostSecret, first.data.hostSecret);

    const stale = await register({ hostId: first.data.hostId, hostSecret: first.data.hostSecret });
    assert.equal(stale.closeCode, 4401);
    const fresh = await register({ hostId: second.data.hostId, hostSecret: second.data.hostSecret });
    assert.ok(fresh.event('host:registered'));

    const hosts = (await (await fetch(`${t.base}/api/hosts`, { headers: { cookie } })).json()).hosts as Json[];
    assert.equal(hosts.find((h) => h.hostId === first.data.hostId)?.name, 'Studio');
  });

  test('previousHostId naming no existing host gets a fresh id', async () => {
    const { data } = await enroll({ code: (await mint()).code, name: 'New', previousHostId: 'gone-host' });
    assert.notEqual(data.hostId, 'gone-host');
  });

  test('the enrollment-key path still works for the PowerShell agent', async () => {
    const enrollKey = await getEnrollKey(t.base, cookie);
    const h = await register({ hostId: 'ps-agent', name: 'PS', enrollKey });
    assert.ok(h.event('host:registered')?.payload.hostSecret);
  });

  test('opening the link in a browser shows instructions and does not consume the code', async () => {
    const { code, link } = await mint();
    const page = await fetch(link);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') || '', /text\/html/);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    const html = await page.text();
    assert.match(html, /DeskBridge agent/);
    assert.ok(!html.includes(code), 'page does not echo the code');
    assert.equal((await enroll({ code, name: 'x' })).status, 200);
  });

  test('enrollment is logged without codes or secrets', async () => {
    const { code } = await mint();
    const { data } = await enroll({ code, name: 'Audit' });
    await enroll({ code: 'ZZZZ-ZZZZ', name: 'x' });
    const all = logs.join('\n');
    assert.match(all, /enroll.*code minted/i);
    assert.ok(all.includes(data.hostId), 'successful enroll logs the host id');
    assert.match(all, /enroll.*failed/i);
    assert.ok(!all.includes(code) && !all.includes(code.replace('-', '')), 'code leaked into logs');
    assert.ok(!all.includes(data.hostSecret), 'secret leaked into logs');
  });
});

describe('Agent enrollment rate limit', () => {
  let t: TestRelay;
  before(async () => {
    t = await startTestRelay();
  });
  after(() => t.stop());

  test('ten failed attempts block further tries, even with a valid code', async () => {
    const cookie = await loginCookie(t.base);
    for (let i = 0; i < 10; i++) {
      assert.equal((await post(t.base, '/api/agent/enroll', { code: 'ZZZZ-ZZZZ', name: 'x' })).status, 401);
    }
    const { data } = await post(t.base, '/api/agent/enroll-codes', {}, cookie);
    const blocked = await post(t.base, '/api/agent/enroll', { code: data.code, name: 'x' });
    assert.equal(blocked.status, 429);
  });

  test('failed enroll attempts do not lock out owner login', async () => {
    assert.ok(await loginCookie(t.base));
  });
});
