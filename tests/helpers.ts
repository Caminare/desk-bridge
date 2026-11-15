import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createRelay, type RelayHandle, type RelayOptions } from '../server/relay.js';

export const TEST_TOKEN = 'test-owner-token-0123456789';

export interface TestRelay {
  relay: RelayHandle;
  base: string;
  wsUrl: string;
  dataDir: string;
  stop(): Promise<void>;
}

export async function startTestRelay(overrides: Partial<RelayOptions> = {}): Promise<TestRelay> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskbridge-test-'));
  const relay = await createRelay({
    port: 0,
    host: '127.0.0.1',
    dataDir,
    serveClient: 'none',
    accessToken: TEST_TOKEN,
    log: () => {},
    ...overrides,
  });
  return {
    relay,
    base: `http://127.0.0.1:${relay.port}`,
    wsUrl: `ws://127.0.0.1:${relay.port}/ws`,
    dataDir,
    async stop() {
      await relay.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export async function loginCookie(base: string, token = TEST_TOKEN): Promise<string> {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

export async function getEnrollKey(base: string, cookie: string): Promise<string> {
  const res = await fetch(`${base}/api/host-agent/download?format=ps1`, { headers: { cookie } });
  const text = await res.text();
  const key = text.match(/\[string\]\$EnrollKey = '([^']+)'/)?.[1];
  if (!key) throw new Error('enroll key not found in agent script');
  return key;
}

type Json = { event: string; payload: Record<string, any> };

/** A WebSocket client that records every message and the close code. */
export class TestSocket {
  readonly messages: Json[] = [];
  readonly binaries: Buffer[] = [];
  closeCode: number | null = null;
  private waiters: Array<() => void> = [];

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data, isBinary) => {
      if (isBinary) this.binaries.push(data as Buffer);
      else this.messages.push(JSON.parse(String(data)));
      this.flush();
    });
    ws.on('close', (code) => {
      this.closeCode = code;
      this.flush();
    });
    ws.on('error', () => {});
  }

  static open(url: string, options: ConstructorParameters<typeof WebSocket>[2] = {}): Promise<TestSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, options);
      const sock = new TestSocket(ws);
      ws.once('open', () => resolve(sock));
      ws.once('error', reject);
    });
  }

  send(event: string, payload: Record<string, unknown> = {}) {
    this.ws.send(JSON.stringify({ event, payload }));
  }

  private flush() {
    const waiters = this.waiters;
    this.waiters = [];
    waiters.forEach((w) => w());
  }

  /** Resolves when predicate becomes true; rejects after timeoutMs. */
  async until(predicate: (s: TestSocket) => boolean, timeoutMs = 2000, label = 'condition'): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate(this)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Timed out waiting for ${label}`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, Math.min(remaining, 50));
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  event(name: string): Json | undefined {
    return this.messages.find((m) => m.event === name);
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // already closed
    }
  }
}

/** Encodes a binary frame in the DeskBridge wire format. */
export function encodeFrame(meta: Record<string, unknown>, jpeg: Buffer): Buffer {
  const metaBuf = Buffer.from(JSON.stringify(meta), 'utf8');
  const header = Buffer.alloc(4);
  header[0] = 0x44;
  header[1] = 0x01;
  header.writeUInt16BE(metaBuf.length, 2);
  return Buffer.concat([header, metaBuf, jpeg]);
}

export function decodeFrameMeta(buf: Buffer): Record<string, unknown> {
  const len = buf.readUInt16BE(2);
  return JSON.parse(buf.subarray(4, 4 + len).toString('utf8'));
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
