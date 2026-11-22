import express from 'express';
import { createServer, type Server } from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import QRCode from 'qrcode';
import {
  GeminiUnavailableError,
  describeError,
  transcribeDictation,
} from './aiAssistant.js';
import { SlidingWindowLimiter } from './rateLimit.js';
import { AdaptiveQuality } from './adaptiveStream.js';
import { EnrollmentCodes } from './enrollmentCodes.js';
import { parseFrame, rewriteFrameHeader } from '../src/lib/frameProtocol.js';
import {
  LoginRateLimiter,
  buildClearedSessionCookie,
  buildSessionCookie,
  createSessionToken,
  generateHostSecret,
  hashSecret,
  isRequestAuthenticated,
  isSameOrigin,
  loadAuthConfig,
  parseCookies,
  safeEqual,
  SESSION_COOKIE,
  verifySecret,
} from './auth.js';
import type { HostProfile, MonitorInfo, RemoteInputEvent } from '../src/types/deskbridge.js';

export interface RelayOptions {
  /** Port to listen on; 0 picks a free port. Default 3000. */
  port?: number;
  /** Interface to bind. Default 0.0.0.0. */
  host?: string;
  /** Directory holding .deskbridge-auth.json and .deskbridge-hosts.json. */
  dataDir: string;
  /** How to serve the web client: Vite dev middleware, a built dist/ folder, or not at all (tests). */
  serveClient: 'vite' | 'static' | 'none';
  /** Built client folder for serveClient 'static'. Default <dataDir>/dist. */
  distDir?: string;
  /**
   * Behind a reverse proxy (Caddy, nginx) every request comes from 127.0.0.1. When true,
   * the client IP for login rate limiting is taken from the X-Forwarded-For entry the proxy
   * appended (the rightmost one). Only enable this when a trusted proxy is in front and the
   * relay port is not reachable directly.
   */
  trustProxy?: boolean;
  /** Owner access token. Default: DESKBRIDGE_ACCESS_TOKEN, else generated and stored. */
  accessToken?: string;
  heartbeatMs?: number;
  aiRateLimitPerMin?: number;
  /** Startup logger. Default console.log. */
  log?: (message: string) => void;
}

export interface RelayHandle {
  httpServer: Server;
  /** The port actually bound (useful with port 0). */
  port: number;
  close(): Promise<void>;
}

const WS_MAX_PAYLOAD = 8 * 1024 * 1024;
const HOST_ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_MONITORS = 16;
const MAX_AUDIO_BASE64_LENGTH = 5 * 1024 * 1024;

function clampDimension(value: unknown, fallback: number): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= 1 && n <= 32768 ? n : fallback;
}

/** Validates an agent-supplied monitor list; returns undefined if absent or malformed. */
export function sanitizeMonitors(value: unknown): MonitorInfo[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const monitors = value.slice(0, MAX_MONITORS).flatMap((m, i): MonitorInfo[] => {
    if (!m || typeof m !== 'object') return [];
    const rec = m as Record<string, unknown>;
    const width = clampDimension(rec.width, 0);
    const height = clampDimension(rec.height, 0);
    if (!width || !height) return [];
    return [
      {
        index: Number.isInteger(rec.index) ? (rec.index as number) : i,
        name: String(rec.name ?? `Display ${i + 1}`).slice(0, 64),
        width,
        height,
        primary: rec.primary === true,
      },
    ];
  });
  return monitors.length > 0 ? monitors : undefined;
}

function sanitizeActiveMonitor(value: unknown, monitors: MonitorInfo[] | undefined): number | undefined {
  if (!monitors || !Number.isInteger(value)) return undefined;
  return monitors.some((m) => m.index === value) ? (value as number) : undefined;
}

interface HostConnection {
  profile: HostProfile;
  ws: WebSocket | null;
  controllers: Set<WebSocket>;
  latestFrame?: string;
  latestJpeg?: Buffer;
  /** SHA-256 of the per-host secret issued to native agents. Never sent to clients. */
  secretHash?: string;
  /**
   * Controllers that must not receive tiled (v2) delta frames until the next keyframe:
   * newly paired ones, and ones we had to skip a frame for because they were backed up.
   */
  needsKey: Set<WebSocket>;
  lastKeyRequestAt: number;
  /** Adaptive quality controller, fed by the RTT the agent reports in v2 frame headers. */
  adaptive: AdaptiveQuality;
}

/** Skip frames for a controller whose socket already has this much queued. */
const CONTROLLER_BACKLOG_LIMIT = 512 * 1024;
const KEYFRAME_REQUEST_INTERVAL_MS = 300;

type StoredHost = HostProfile & { secretHash?: string };

function getLatestFrameDataUrl(entry?: HostConnection): string | undefined {
  if (!entry) return undefined;
  if (entry.latestFrame) return entry.latestFrame;
  if (entry.latestJpeg && entry.latestJpeg.length > 0) {
    entry.latestFrame = `data:image/jpeg;base64,${entry.latestJpeg.toString('base64')}`;
    return entry.latestFrame;
  }
  return undefined;
}

export async function createRelay(opts: RelayOptions): Promise<RelayHandle> {
  const log = opts.log ?? ((message: string) => console.log(message));
  const port = opts.port ?? 3000;
  const HOSTS_STORE_PATH = path.join(opts.dataDir, '.deskbridge-hosts.json');
  const AUTH_STORE_PATH = path.join(opts.dataDir, '.deskbridge-auth.json');

  const auth = loadAuthConfig(AUTH_STORE_PATH, opts.accessToken);
  const loginLimiter = new LoginRateLimiter();
  // Separate from login so a PC guessing codes cannot lock the owner out.
  const enrollLimiter = new LoginRateLimiter();
  const enrollCodes = new EnrollmentCodes();
  const HEARTBEAT_MS = opts.heartbeatMs ?? 15000;
  const aiLimiter = new SlidingWindowLimiter(opts.aiRateLimitPerMin ?? 20, 60_000);

  const hosts = new Map<string, HostConnection>();
  const fleetSubscribers = new Set<WebSocket>();
  const controllerHostMap = new WeakMap<WebSocket, Set<string>>();

  function loadSavedHosts() {
    try {
      if (!fs.existsSync(HOSTS_STORE_PATH)) return;
      const raw = fs.readFileSync(HOSTS_STORE_PATH, 'utf8');
      const parsed = JSON.parse(raw) as StoredHost[];
      for (const { secretHash, ...profile } of parsed) {
        hosts.set(profile.hostId, {
          profile: {
            ...profile,
            status: 'offline',
            connectedControllers: 0,
          },
          ws: null,
          controllers: new Set(),
          secretHash,
          needsKey: new Set(),
          lastKeyRequestAt: 0,
          adaptive: new AdaptiveQuality(),
        });
      }
    } catch (err) {
      console.warn('Could not load saved hosts:', err);
    }
  }

  function persistHosts() {
    try {
      const list: StoredHost[] = Array.from(hosts.values()).map((h) => ({
        ...h.profile,
        connectedControllers: h.controllers.size,
        secretHash: h.secretHash,
      }));
      fs.writeFileSync(HOSTS_STORE_PATH, JSON.stringify(list, null, 2), { encoding: 'utf8', mode: 0o600 });
    } catch (err) {
      console.warn('Could not persist hosts:', err);
    }
  }

  function generatePairingCode(): string {
    const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars[crypto.randomInt(chars.length)];
    }
    return code;
  }

  function getPublicHostsList(): HostProfile[] {
    return Array.from(hosts.values())
      .map((entry) => ({
        ...entry.profile,
        connectedControllers: entry.controllers.size,
      }))
      .sort((a, b) => {
        if (a.status === 'online' && b.status !== 'online') return -1;
        if (a.status !== 'online' && b.status === 'online') return 1;
        return b.lastSeen - a.lastSeen;
      });
  }

  function sendJson(ws: WebSocket | null, event: string, payload: unknown) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ event, payload }));
  }

  function clientIp(req: express.Request): string {
    if (opts.trustProxy) {
      const xff = String(req.headers['x-forwarded-for'] || '');
      const last = xff.split(',').map((p) => p.trim()).filter(Boolean).pop();
      if (last) return last;
    }
    return req.socket.remoteAddress || 'unknown';
  }

  /** Asks the host agent for a keyframe (throttled). Agents without v2 support ignore it. */
  function requestKeyframe(entry: HostConnection) {
    const now = Date.now();
    if (now - entry.lastKeyRequestAt < KEYFRAME_REQUEST_INTERVAL_MS) return;
    entry.lastKeyRequestAt = now;
    sendJson(entry.ws, 'host:keyframe_request', {});
  }

  function broadcastFleet() {
    const list = getPublicHostsList();
    for (const ws of fleetSubscribers) {
      sendJson(ws, 'fleet:update', list);
    }
  }

  function getBaseUrls(req: express.Request) {
    const envUrl = process.env.APP_URL && process.env.APP_URL !== 'MY_APP_URL' ? process.env.APP_URL : '';
    const rawProto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'http';
    const rawHost = (req.headers['x-forwarded-host'] as string) || req.headers.host || `localhost:${port}`;
    const proto = rawProto.split(',')[0].trim();
    const host = rawHost.split(',')[0].trim();
    const appUrl = (envUrl || `${proto}://${host}`).replace(/\/$/, '');
    const wsProto = appUrl.startsWith('https') ? 'wss' : 'ws';
    const wsUrl = appUrl.replace(/^https?/, wsProto) + '/ws';
    return { appUrl, wsUrl };
  }

  function sendAiError(res: express.Response, err: unknown, fallback: string) {
    if (err instanceof GeminiUnavailableError) {
      res.status(502).json({ error: err.message });
      return;
    }
    const message = describeError(err) || fallback;
    const status = /GEMINI_API_KEY is not configured/.test(message) ? 503 : 500;
    res.status(status).json({ error: message });
  }

  loadSavedHosts();

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '15mb' }));

  app.get('/api/health', (req, res) => {
    if (!isRequestAuthenticated(auth, req)) {
      res.json({ ok: true });
      return;
    }
    res.json({
      ok: true,
      transcriptionReady: Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY'),
      onlineHosts: Array.from(hosts.values()).filter((h) => h.profile.status === 'online').length,
    });
  });

  app.get('/api/auth/session', (req, res) => {
    res.json({ authenticated: isRequestAuthenticated(auth, req) });
  });

  app.post('/api/auth/login', (req, res) => {
    const limiterKey = clientIp(req);
    if (loginLimiter.isBlocked(limiterKey)) {
      res.status(429).json({ error: 'Too many failed attempts. Try again in a few minutes.' });
      return;
    }
    if (!safeEqual(req.body?.token, auth.accessToken)) {
      loginLimiter.recordFailure(limiterKey);
      res.status(401).json({ error: 'Invalid access token.' });
      return;
    }
    loginLimiter.reset(limiterKey);
    res.setHeader('Set-Cookie', buildSessionCookie(req, createSessionToken(auth)));
    res.json({ authenticated: true });
  });

  app.post('/api/auth/logout', (_req, res) => {
    res.setHeader('Set-Cookie', buildClearedSessionCookie());
    res.json({ authenticated: false });
  });

  // Agents have no owner session: the one-time code is the credential.
  app.post('/api/agent/enroll', (req, res) => {
    const ip = clientIp(req);
    if (enrollLimiter.isBlocked(ip)) {
      res.status(429).json({ error: 'Too many failed attempts. Try again in a few minutes.' });
      return;
    }
    if (!enrollCodes.redeem(req.body?.code)) {
      enrollLimiter.recordFailure(ip);
      log(`[enroll] failed attempt from ${ip}`);
      res.status(401).json({ error: 'This enrollment code is invalid, expired or already used. Create a new one in the Windows Host tab.' });
      return;
    }
    enrollLimiter.reset(ip);

    const previousHostId = typeof req.body?.previousHostId === 'string' ? req.body.previousHostId : '';
    const existing = previousHostId ? hosts.get(previousHostId) : undefined;
    const hostSecret = generateHostSecret();
    let hostId: string;
    if (existing) {
      hostId = previousHostId;
      existing.secretHash = hashSecret(hostSecret);
      // The old connection was authorised by the secret we just rotated away.
      if (existing.ws && existing.ws.readyState === WebSocket.OPEN) {
        existing.ws.close(4409, 'Host re-enrolled');
      }
    } else {
      hostId = `pc-${crypto.randomUUID().slice(0, 8)}`;
      const name = typeof req.body?.name === 'string' && req.body.name.trim() ? req.body.name.trim().slice(0, 64) : 'Windows PC';
      const pairingCode = generatePairingCode();
      hosts.set(hostId, {
        profile: {
          hostId,
          name,
          groupLabel: 'Workstation',
          os: 'Windows',
          screenWidth: 1920,
          screenHeight: 1080,
          pairingCode,
          pairingUrl: `${getBaseUrls(req).appUrl}/?pair=${pairingCode}&host=${encodeURIComponent(hostId)}`,
          status: 'offline',
          lastSeen: Date.now(),
          agentType: 'windows-native',
          activeWindow: 'Windows Desktop',
          cpuUsage: 0,
          memoryUsage: 0,
          connectedControllers: 0,
        },
        ws: null,
        controllers: new Set(),
        secretHash: hashSecret(hostSecret),
        needsKey: new Set(),
        lastKeyRequestAt: 0,
        adaptive: new AdaptiveQuality(),
      });
    }
    persistHosts();
    broadcastFleet();
    log(`[enroll] host ${hostId} enrolled${existing ? ' (re-enrolled, secret rotated)' : ''} from ${ip}`);
    res.json({ hostId, hostSecret });
  });

  // Someone opened the enrollment link in a browser. Never consumes or echoes the code.
  app.get('/enroll/:code', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<title>DeskBridge enrollment</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem">' +
        '<h1>Add this PC to DeskBridge</h1><p>This is an enrollment link for the DeskBridge agent. ' +
        'Copy the link from your browser address bar and paste it into the DeskBridge agent window on the PC you want to add.</p>' +
        '<p>The link works once and expires 10 minutes after it was created.</p></body></html>',
    );
  });

  // Every other API route requires an owner session.
  app.use('/api', (req, res, next) => {
    if (!isRequestAuthenticated(auth, req)) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    next();
  });

  // Gemini calls cost money: cap them per owner session.
  app.use('/api/ai', (req, res, next) => {
    const key = parseCookies(req.headers.cookie)[SESSION_COOKIE] || req.socket.remoteAddress || 'unknown';
    const waitMs = aiLimiter.take(key);
    if (waitMs > 0) {
      res.setHeader('Retry-After', String(Math.ceil(waitMs / 1000)));
      res.status(429).json({ error: `AI rate limit reached. Try again in ${Math.ceil(waitMs / 1000)}s.` });
      return;
    }
    next();
  });

  app.post('/api/agent/enroll-codes', (req, res) => {
    const { code, expiresAt } = enrollCodes.mint();
    log('[enroll] code minted');
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      code,
      expiresAt,
      // Relative too: the controller's clock may not match the relay's.
      expiresIn: Math.max(0, expiresAt - Date.now()),
      link: `${getBaseUrls(req).appUrl}/enroll/${code}`,
    });
  });

  app.get('/api/hosts', (_req, res) => {
    res.json({ hosts: getPublicHostsList() });
  });

  app.post('/api/hosts/pair-code', (req, res) => {
    const rawCode = String(req.body?.code || '').trim();
    if (!rawCode) {
      res.status(400).json({ error: 'Pairing code or QR payload is required.' });
      return;
    }

    let lookupCode = rawCode.toUpperCase();
    let lookupHostId = '';

    if (rawCode.includes('pair=') || rawCode.startsWith('http')) {
      try {
        const parsed = new URL(rawCode);
        lookupCode = (parsed.searchParams.get('pair') || '').toUpperCase();
        lookupHostId = parsed.searchParams.get('host') || '';
      } catch {
        // Not a valid URL, treat as raw code
      }
    }

    const match = Array.from(hosts.values()).find(
      (entry) =>
        (lookupCode && entry.profile.pairingCode.toUpperCase() === lookupCode) ||
        (lookupHostId && entry.profile.hostId === lookupHostId),
    );

    if (!match) {
      res.status(404).json({ error: 'No workstation found with that pairing code.' });
      return;
    }

    res.json({
      host: {
        ...match.profile,
        connectedControllers: match.controllers.size,
      },
      latestFrame: getLatestFrameDataUrl(match) || null,
    });
  });

  app.patch('/api/hosts/:hostId', (req, res) => {
    const { hostId } = req.params;
    const existing = hosts.get(hostId);
    if (!existing) {
      res.status(404).json({ error: 'Host not found.' });
      return;
    }
    const nextName = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const nextGroup = typeof req.body?.groupLabel === 'string' ? req.body.groupLabel.trim() : '';
    if (nextName) existing.profile.name = nextName;
    if (nextGroup) existing.profile.groupLabel = nextGroup;
    persistHosts();
    broadcastFleet();
    res.json({ host: { ...existing.profile, connectedControllers: existing.controllers.size } });
  });

  app.delete('/api/hosts/:hostId', (req, res) => {
    const { hostId } = req.params;
    const existing = hosts.get(hostId);
    if (!existing) {
      res.status(404).json({ error: 'Host not found.' });
      return;
    }
    if (existing.ws && existing.ws.readyState === WebSocket.OPEN) {
      existing.ws.close(1000, 'Host removed');
    }
    hosts.delete(hostId);
    persistHosts();
    broadcastFleet();
    res.json({ ok: true });
  });

  app.get('/api/qr', async (req, res) => {
    const data = String(req.query.data || '');
    if (!data) {
      res.status(400).json({ error: 'Missing data parameter.' });
      return;
    }
    try {
      const dataUrl = await QRCode.toDataURL(data, {
        width: 320,
        margin: 2,
        color: {
          dark: '#0f172a',
          light: '#ffffff',
        },
      });
      res.json({ dataUrl });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/ai/transcribe', async (req, res) => {
    try {
      const { audioBase64, mimeType } = (req.body ?? {}) as { audioBase64?: unknown; mimeType?: unknown };
      if (typeof audioBase64 !== 'string' || !audioBase64.trim()) {
        res.status(400).json({ error: 'Audio payload is required.' });
        return;
      }
      if (audioBase64.length > MAX_AUDIO_BASE64_LENGTH) {
        res.status(413).json({ error: 'Audio payload exceeds the 5 MB limit.' });
        return;
      }
      const result = await transcribeDictation(audioBase64, typeof mimeType === 'string' && mimeType ? mimeType : 'audio/webm');
      res.json(result);
    } catch (err) {
      sendAiError(res, err, 'Failed to transcribe audio.');
    }
  });

  let closeVite: (() => Promise<void>) | undefined;
  if (opts.serveClient === 'vite') {
    // Imported lazily so production and tests do not load Vite.
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    closeVite = () => vite.close();
    app.use(vite.middlewares);
  } else if (opts.serveClient === 'static') {
    const distPath = opts.distDir ?? path.join(opts.dataDir, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const httpServer = createServer(app);
  const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: WS_MAX_PAYLOAD });

  // Heartbeat: ping every socket; terminate any that did not answer the previous ping.
  // Terminating fires 'close', which marks a host offline. Browsers, .NET ClientWebSocket
  // and Node's WebSocket all answer pings automatically.
  const alive = new WeakMap<WebSocket, boolean>();
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if (alive.get(client) === false) {
        client.terminate();
        continue;
      }
      alive.set(client, false);
      try {
        client.ping();
      } catch {
        client.terminate();
      }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();
  wss.on('close', () => clearInterval(heartbeat));

  wss.on('connection', (ws, req) => {
    let ownedHostId: string | null = null;
    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));
    controllerHostMap.set(ws, new Set());

    // Controllers must hold an owner session cookie from this origin. Unauthenticated
    // sockets may only register as an enrolled host agent using its per-host secret.
    const isOwner = isSameOrigin(req) && isRequestAuthenticated(auth, req);

    // Without an error listener, a protocol error (e.g. an oversized frame) throws and
    // takes down the whole relay process.
    ws.on('error', (err) => {
      console.warn('WebSocket error:', err.message);
    });

    const rejectHost = (reason: string) => {
      sendJson(ws, 'host:auth_error', { error: reason });
      ws.close(4401, 'Host authentication failed');
    };

    const rawProto = (req.headers['x-forwarded-proto'] as string) || 'http';
    const rawHost = (req.headers['x-forwarded-host'] as string) || req.headers.host || `localhost:${port}`;
    const proto = rawProto.split(',')[0].trim();
    const hostHeader = rawHost.split(',')[0].trim();
    const envAppUrl = process.env.APP_URL && process.env.APP_URL !== 'MY_APP_URL' ? process.env.APP_URL : '';
    const baseUrl = (envAppUrl || `${proto}://${hostHeader}`).replace(/\/$/, '');

    ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
        const parsed = parseFrame(buf);
        if (!parsed) return;
        // Frames are always attributed to the host this socket registered, never to a
        // client-supplied id. Rewrite the header if needed so controllers see the truth.
        if (!ownedHostId) return;
        const entry = hosts.get(ownedHostId);
        if (!entry || entry.ws !== ws) return;
        const meta = parsed.header;
        let outBuf: Buffer = buf;
        if (meta.hostId !== ownedHostId) {
          const rewritten = rewriteFrameHeader(buf, parsed, { ...meta, hostId: ownedHostId });
          if (!rewritten) return;
          outBuf = Buffer.from(rewritten.buffer, rewritten.byteOffset, rewritten.byteLength);
        }

        // Cache a complete image for newly paired controllers:
        // v1 frames, or v2 keyframes made of a single full-frame tile.
        if (parsed.isKey) {
          const t = parsed.tiles[0];
          const fullTile =
            parsed.version === 1 ||
            (parsed.tiles.length === 1 && t.x === 0 && t.y === 0 && t.w === meta.w && t.h === meta.h);
          if (fullTile) {
            entry.latestJpeg = Buffer.from(buf.subarray(t.offset, t.offset + t.length));
            entry.latestFrame = undefined;
          }
        }
        entry.profile.lastSeen = Date.now();
        entry.profile.status = 'online';
        if (typeof meta.activeWindow === 'string') {
          entry.profile.activeWindow = meta.activeWindow;
        }

        let delivered = false;
        for (const ctrl of entry.controllers) {
          if (ctrl.readyState !== WebSocket.OPEN) continue;
          if (!parsed.isKey && entry.needsKey.has(ctrl)) continue;
          if (ctrl.bufferedAmount >= CONTROLLER_BACKLOG_LIMIT) {
            // Skipping a v2 delta would corrupt this controller's picture: resync with a keyframe.
            if (parsed.version === 2) {
              entry.needsKey.add(ctrl);
              requestKeyframe(entry);
            }
            continue;
          }
          ctrl.send(outBuf, { binary: true });
          if (parsed.isKey) entry.needsKey.delete(ctrl);
          delivered = true;
        }

        // Nobody will ack a frame nobody received; ack it here so the agent's
        // in-flight window does not stall.
        if (!delivered && typeof meta.seq === 'number') {
          sendJson(ws, 'host:frame_ack', { seq: meta.seq, relay: true });
        }

        const rtt = meta.stats?.rtt;
        if (parsed.version === 2 && typeof rtt === 'number') {
          const level = entry.adaptive.onRttSample(rtt);
          if (level) sendJson(ws, 'client:input', { type: 'quality', ...level });
        }
        return;
      }

      let msg: { event?: string; payload?: Record<string, unknown> };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }

      const event = msg.event;
      const payload = msg.payload || {};

      if (event === 'host:register') {
        const requestedId = typeof payload.hostId === 'string' ? payload.hostId : '';
        if (!isOwner) {
          if (typeof payload.hostSecret !== 'string' || !payload.hostSecret) {
            rejectHost('Missing host secret. Enroll this PC with a one-time link from the Windows Host tab.');
            return;
          }
          if (!hosts.get(requestedId)?.secretHash) {
            // Distinct from 4401 so the agent knows to forget its credentials and re-enroll.
            sendJson(ws, 'host:auth_error', { error: 'This PC is not enrolled (it may have been removed from the fleet). Enroll it again.' });
            ws.close(4403, 'Host unknown or revoked');
            return;
          }
        }
        if (ownedHostId) {
          sendJson(ws, 'host:auth_error', { error: 'This connection already registered a host.' });
          return;
        }
        const hostId = HOST_ID_PATTERN.test(requestedId) ? requestedId : `pc-${crypto.randomUUID().slice(0, 8)}`;
        const existing = hosts.get(hostId);

        // A host id with a secret can only be reclaimed by the agent holding it
        // (or by the logged-in owner running browser host mode).
        const secretHash = existing?.secretHash;
        if (secretHash && !isOwner && !verifySecret(payload.hostSecret, secretHash)) {
          rejectHost('Host secret mismatch for this host id. Re-enroll this PC or delete it from the Fleet tab.');
          return;
        }

        if (existing?.ws && existing.ws !== ws && existing.ws.readyState === WebSocket.OPEN) {
          existing.ws.close(4409, 'Replaced by a newer host connection');
        }
        const pairingCode = existing?.profile.pairingCode || generatePairingCode();
        const pairingUrl = `${baseUrl}/?pair=${pairingCode}&host=${encodeURIComponent(hostId)}`;

        const profile: HostProfile = {
          hostId,
          name: String(payload.name || existing?.profile.name || 'Windows PC'),
          groupLabel: String(payload.groupLabel || payload.jobLabel || existing?.profile.groupLabel || 'Workstation'),
          os: String(payload.os || 'Windows 11 Pro'),
          screenWidth: clampDimension(payload.screenWidth, 1920),
          screenHeight: clampDimension(payload.screenHeight, 1080),
          pairingCode,
          pairingUrl,
          status: 'online',
          lastSeen: Date.now(),
          agentType: (payload.agentType as HostProfile['agentType']) || 'browser-host',
          activeWindow: String(payload.activeWindow || 'Windows Desktop'),
          cpuUsage: Number(payload.cpuUsage ?? 18),
          memoryUsage: Number(payload.memoryUsage ?? 42),
          connectedControllers: existing?.controllers.size ?? 0,
        };
        const monitors = sanitizeMonitors(payload.monitors);
        if (monitors) {
          profile.monitors = monitors;
          profile.activeMonitor = sanitizeActiveMonitor(payload.activeMonitor, monitors);
        }

        const controllers = existing?.controllers ?? new Set<WebSocket>();
        hosts.set(hostId, {
          profile,
          ws,
          controllers,
          latestFrame: existing?.latestFrame,
          latestJpeg: existing?.latestJpeg,
          secretHash,
          needsKey: new Set(controllers),
          lastKeyRequestAt: 0,
          adaptive: new AdaptiveQuality(),
        });
        ownedHostId = hostId;

        persistHosts();
        sendJson(ws, 'host:registered', {
          hostId,
          pairingCode,
          pairingUrl,
          controllerCount: controllers.size,
        });
        sendJson(ws, 'host:controller_count', { count: controllers.size });
        broadcastFleet();
        return;
      }

      if (event === 'host:update' && ownedHostId) {
        // Agent-reported changes (e.g. after switching monitors). Only from the owning socket.
        const entry = hosts.get(ownedHostId);
        if (!entry || entry.ws !== ws) return;
        if (payload.screenWidth !== undefined) {
          entry.profile.screenWidth = clampDimension(payload.screenWidth, entry.profile.screenWidth);
        }
        if (payload.screenHeight !== undefined) {
          entry.profile.screenHeight = clampDimension(payload.screenHeight, entry.profile.screenHeight);
        }
        const monitors = sanitizeMonitors(payload.monitors);
        if (monitors) entry.profile.monitors = monitors;
        if (payload.activeMonitor !== undefined) {
          entry.profile.activeMonitor = sanitizeActiveMonitor(payload.activeMonitor, entry.profile.monitors);
        }
        persistHosts();
        broadcastFleet();
        return;
      }

      if (event === 'host:regenerate_code' && ownedHostId) {
        const entry = hosts.get(ownedHostId);
        if (!entry || entry.ws !== ws) return;
        const pairingCode = generatePairingCode();
        const pairingUrl = `${baseUrl}/?pair=${pairingCode}&host=${encodeURIComponent(ownedHostId)}`;
        entry.profile.pairingCode = pairingCode;
        entry.profile.pairingUrl = pairingUrl;
        persistHosts();
        sendJson(ws, 'host:registered', {
          hostId: ownedHostId,
          pairingCode,
          pairingUrl,
          controllerCount: entry.controllers.size,
        });
        broadcastFleet();
        return;
      }

      if (event === 'host:frame') {
        if (!ownedHostId) return;
        const hostId = ownedHostId;
        const entry = hosts.get(hostId);
        if (!entry || entry.ws !== ws) return;
        const frame = typeof payload.frame === 'string' ? payload.frame : '';
        if (frame) {
          entry.latestFrame = frame;
          entry.latestJpeg = undefined;
        }
        entry.profile.lastSeen = Date.now();
        entry.profile.status = 'online';
        if (typeof payload.activeWindow === 'string') {
          entry.profile.activeWindow = payload.activeWindow;
        }
        if (typeof payload.cpuUsage === 'number') {
          entry.profile.cpuUsage = payload.cpuUsage;
        }
        if (typeof payload.memoryUsage === 'number') {
          entry.profile.memoryUsage = payload.memoryUsage;
        }
        for (const ctrl of entry.controllers) {
          if (ctrl.readyState === WebSocket.OPEN && ctrl.bufferedAmount < 1024 * 1024) {
            sendJson(ctrl, 'host:frame', {
              hostId,
              frame,
              seq: payload.seq,
              activeWindow: entry.profile.activeWindow,
              cpuUsage: entry.profile.cpuUsage,
              memoryUsage: entry.profile.memoryUsage,
              timestamp: payload.timestamp || Date.now(),
            });
          }
        }
        return;
      }

      if (typeof event === 'string' && event.startsWith('client:') && !isOwner) {
        sendJson(ws, 'auth:required', { error: 'Authentication required.' });
        ws.close(4401, 'Authentication required');
        return;
      }

      if (event === 'client:frame_ack') {
        const hostId = String(payload.hostId || '');
        const entry = hosts.get(hostId);
        if (entry?.ws && entry.ws.readyState === WebSocket.OPEN) {
          sendJson(entry.ws, 'host:frame_ack', {
            seq: payload.seq,
            timestamp: payload.timestamp,
          });
        }
        return;
      }

      if (event === 'client:subscribe_fleet') {
        fleetSubscribers.add(ws);
        sendJson(ws, 'fleet:update', getPublicHostsList());
        return;
      }

      if (event === 'client:pair') {
        const code = String(payload.pairingCode || '').trim().toUpperCase();
        const hostId = String(payload.hostId || '').trim();
        const entry = Array.from(hosts.values()).find(
          (h) => (hostId && h.profile.hostId === hostId) || (code && h.profile.pairingCode.toUpperCase() === code),
        );

        if (!entry) {
          sendJson(ws, 'client:pair_error', { error: 'Workstation not found or pairing code expired.' });
          return;
        }

        entry.controllers.add(ws);
        entry.needsKey.add(ws);
        controllerHostMap.get(ws)?.add(entry.profile.hostId);
        requestKeyframe(entry);

        sendJson(ws, 'client:paired', {
          host: {
            ...entry.profile,
            connectedControllers: entry.controllers.size,
          },
          latestFrame: getLatestFrameDataUrl(entry) || null,
        });
        sendJson(entry.ws, 'host:controller_count', { count: entry.controllers.size });
        broadcastFleet();
        return;
      }

      if (event === 'client:unpair') {
        const hostId = String(payload.hostId || '');
        const entry = hosts.get(hostId);
        if (entry) {
          entry.controllers.delete(ws);
          entry.needsKey.delete(ws);
          controllerHostMap.get(ws)?.delete(hostId);
          sendJson(entry.ws, 'host:controller_count', { count: entry.controllers.size });
          broadcastFleet();
        }
        return;
      }

      if (event === 'client:keyframe_request') {
        // A controller lost sync (e.g. a decode error) and needs a full picture.
        const entry = hosts.get(String(payload.hostId || ''));
        if (entry && entry.controllers.has(ws)) {
          entry.needsKey.add(ws);
          requestKeyframe(entry);
        }
        return;
      }

      if (event === 'client:input') {
        const hostId = String(payload.hostId || '');
        const input = payload.input as RemoteInputEvent | undefined;
        const entry = hosts.get(hostId);
        if (!entry || !input) return;

        if (entry.ws && entry.ws.readyState === WebSocket.OPEN) {
          if (input.type === 'quality') {
            // The user's preset is a ceiling; adaptive control works below it.
            const level = entry.adaptive.setCap(Number(input.maxWidth) || 1152);
            sendJson(entry.ws, 'client:input', { type: 'quality', ...level });
          } else {
            sendJson(entry.ws, 'client:input', input);
          }
        }
        return;
      }
    });

    ws.on('close', () => {
      fleetSubscribers.delete(ws);

      const pairedIds = controllerHostMap.get(ws);
      if (pairedIds) {
        for (const id of pairedIds) {
          const entry = hosts.get(id);
          if (entry) {
            entry.controllers.delete(ws);
            entry.needsKey.delete(ws);
            sendJson(entry.ws, 'host:controller_count', { count: entry.controllers.size });
          }
        }
      }

      if (ownedHostId) {
        const entry = hosts.get(ownedHostId);
        if (entry && entry.ws === ws) {
          entry.ws = null;
          entry.profile.status = 'offline';
          entry.profile.lastSeen = Date.now();
          for (const ctrl of entry.controllers) {
            sendJson(ctrl, 'host:status', { hostId: ownedHostId, status: 'offline' });
          }
          persistHosts();
          broadcastFleet();
        }
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, opts.host ?? '0.0.0.0', () => {
      httpServer.off('error', reject);
      resolve();
    });
  });
  const address = httpServer.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;
  log(`DeskBridge server listening on http://${opts.host ?? '0.0.0.0'}:${boundPort}`);
  if (auth.tokenFromStore) {
    log('');
    log(`  Owner access token${auth.generatedToken ? ' (newly generated)' : ''}: ${auth.accessToken}`);
    log(`  Stored in ${path.basename(AUTH_STORE_PATH)}. Set DESKBRIDGE_ACCESS_TOKEN to choose your own.`);
    log('');
  }

  return {
    httpServer,
    port: boundPort,
    async close() {
      clearInterval(heartbeat);
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      const closed = new Promise<void>((resolve) => httpServer.close(() => resolve()));
      httpServer.closeAllConnections();
      await closed;
      await closeVite?.();
    },
  };
}
