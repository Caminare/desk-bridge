import express from 'express';
import { createServer, type Server } from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import QRCode from 'qrcode';
import {
  generateBatchLauncher,
  generateNodeHostScript,
  generatePowerShellHostScript,
} from './windowsAgentGenerator.js';
import {
  GeminiUnavailableError,
  describeError,
  processAssistantCommand,
  transcribeAudioCommand,
} from './aiAssistant.js';
import { SlidingWindowLimiter } from './rateLimit.js';
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
import type { AIThinkingMode, HostProfile, MonitorInfo, RemoteInputEvent } from '../src/types/deskbridge.js';

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
}

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
      geminiReady: Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY'),
      onlineHosts: Array.from(hosts.values()).filter((h) => h.profile.status === 'online').length,
    });
  });

  app.get('/api/auth/session', (req, res) => {
    res.json({ authenticated: isRequestAuthenticated(auth, req) });
  });

  app.post('/api/auth/login', (req, res) => {
    const limiterKey = req.socket.remoteAddress || 'unknown';
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

  app.get('/api/host-agent/download', (req, res) => {
    const format = String(req.query.format || 'ps1');
    const hostName = String(req.query.name || 'Windows-PC');
    const groupLabel = String(req.query.group || req.query.job || 'Workstation');
    const { appUrl, wsUrl } = getBaseUrls(req);
    // Agent scripts embed the enrollment key: never let proxies or browsers cache them.
    res.setHeader('Cache-Control', 'no-store');

    if (format === 'bat') {
      const content = generateBatchLauncher();
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', 'attachment; filename="Start-DeskBridge.bat"');
      res.send(content);
      return;
    }

    if (format === 'mjs') {
      const content = generateNodeHostScript({ wsUrl, appUrl, hostName, groupLabel, enrollKey: auth.enrollKey });
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="deskbridge-host.mjs"');
      res.send(content);
      return;
    }

    const content = generatePowerShellHostScript({ wsUrl, appUrl, hostName, groupLabel, enrollKey: auth.enrollKey });
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="DeskBridge-Host.ps1"');
    res.send(content);
  });

  app.post('/api/ai/command', async (req, res) => {
    try {
      const { prompt, thinkingMode, hostId, speakReply, screenshotBase64 } = req.body as {
        prompt?: string;
        thinkingMode?: AIThinkingMode;
        hostId?: string;
        speakReply?: boolean;
        screenshotBase64?: string;
      };

      if (!prompt || !prompt.trim()) {
        res.status(400).json({ error: 'Prompt is required.' });
        return;
      }

      const activeEntry = hostId ? hosts.get(hostId) : undefined;
      const clientShot =
        typeof screenshotBase64 === 'string' && screenshotBase64.startsWith('data:image/')
          ? screenshotBase64
          : undefined;
      const frame = clientShot || getLatestFrameDataUrl(activeEntry);

      const result = await processAssistantCommand({
        prompt: prompt.trim(),
        thinkingMode: thinkingMode || 'fast',
        activeHost: activeEntry?.profile,
        availableHosts: getPublicHostsList(),
        screenshotBase64: frame,
        speakReply: Boolean(speakReply),
      });

      res.json(result);
    } catch (err) {
      sendAiError(res, err, 'Failed to process AI command.');
    }
  });

  app.post('/api/ai/voice-command', async (req, res) => {
    try {
      const { audioBase64, mimeType, thinkingMode, hostId, speakReply, screenshotBase64 } = req.body as {
        audioBase64?: string;
        mimeType?: string;
        thinkingMode?: AIThinkingMode;
        hostId?: string;
        speakReply?: boolean;
        screenshotBase64?: string;
      };

      if (!audioBase64) {
        res.status(400).json({ error: 'Audio payload is required.' });
        return;
      }

      let transcript = '';
      let transcribeWarning = '';
      try {
        transcript = await transcribeAudioCommand(audioBase64, mimeType || 'audio/webm');
      } catch (err) {
        // Fallback: pass raw audio directly to the multimodal command processor.
        transcribeWarning = `Transcription failed (${describeError(err)}); sent the raw audio to the assistant instead.`;
        console.warn(`[ai] ${transcribeWarning}`);
      }

      const activeEntry = hostId ? hosts.get(hostId) : undefined;
      const clientShot =
        typeof screenshotBase64 === 'string' && screenshotBase64.startsWith('data:image/')
          ? screenshotBase64
          : undefined;
      const frame = clientShot || getLatestFrameDataUrl(activeEntry);

      const result = await processAssistantCommand({
        prompt: transcript || undefined,
        audioBase64: transcript ? undefined : audioBase64,
        audioMimeType: transcript ? undefined : mimeType || 'audio/webm',
        thinkingMode: thinkingMode || 'fast',
        activeHost: activeEntry?.profile,
        availableHosts: getPublicHostsList(),
        screenshotBase64: frame,
        speakReply: Boolean(speakReply),
      });

      const warning = [transcribeWarning, result.warning].filter(Boolean).join(' ');
      res.json({
        ...result,
        transcript: transcript || 'Voice command',
        ...(warning ? { warning } : {}),
      });
    } catch (err) {
      sendAiError(res, err, 'Failed to transcribe or execute voice command.');
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
    // sockets may only register as a host agent using the enrollment key.
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
        if (buf.length <= 4 || buf[0] !== 0x44 || buf[1] !== 0x01) {
          return;
        }
        const headerLen = buf.readUInt16BE(2);
        if (buf.length <= 4 + headerLen) return;
        let meta: {
          hostId?: string;
          seq?: number;
          activeWindow?: string;
          timestamp?: number;
        };
        try {
          meta = JSON.parse(buf.subarray(4, 4 + headerLen).toString('utf8'));
        } catch {
          return;
        }
        // Frames are always attributed to the host this socket registered, never to a
        // client-supplied id. Rewrite the header if needed so controllers see the truth.
        if (!ownedHostId) return;
        const entry = hosts.get(ownedHostId);
        if (!entry || entry.ws !== ws) return;
        let outBuf = buf;
        if (meta.hostId !== ownedHostId) {
          const fixedMeta = Buffer.from(JSON.stringify({ ...meta, hostId: ownedHostId }), 'utf8');
          if (fixedMeta.length > 0xffff) return;
          const header = Buffer.alloc(4);
          header[0] = 0x44;
          header[1] = 0x01;
          header.writeUInt16BE(fixedMeta.length, 2);
          outBuf = Buffer.concat([header, fixedMeta, buf.subarray(4 + headerLen)]);
        }
        entry.latestJpeg = Buffer.from(buf.subarray(4 + headerLen));
        entry.latestFrame = undefined;
        entry.profile.lastSeen = Date.now();
        entry.profile.status = 'online';
        if (typeof meta.activeWindow === 'string') {
          entry.profile.activeWindow = meta.activeWindow;
        }
        for (const ctrl of entry.controllers) {
          if (ctrl.readyState === WebSocket.OPEN && ctrl.bufferedAmount < 512 * 1024) {
            ctrl.send(outBuf, { binary: true });
          }
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
        if (!isOwner && !safeEqual(payload.enrollKey, auth.enrollKey)) {
          rejectHost('Invalid or missing enrollment key. Download a fresh agent script from the DeskBridge Host tab.');
          return;
        }
        if (ownedHostId) {
          sendJson(ws, 'host:auth_error', { error: 'This connection already registered a host.' });
          return;
        }
        const requestedId = typeof payload.hostId === 'string' ? payload.hostId : '';
        const hostId = HOST_ID_PATTERN.test(requestedId) ? requestedId : `pc-${crypto.randomUUID().slice(0, 8)}`;
        const existing = hosts.get(hostId);

        // A host id that already has a secret can only be reclaimed by the agent that
        // holds it (or by the logged-in owner running browser host mode).
        let issuedSecret: string | undefined;
        let secretHash = existing?.secretHash;
        if (secretHash) {
          if (!isOwner && !verifySecret(payload.hostSecret, secretHash)) {
            rejectHost('Host secret mismatch for this host id. Delete the host from the Fleet tab to re-enroll it.');
            return;
          }
        } else if (!isOwner) {
          issuedSecret = generateHostSecret();
          secretHash = hashSecret(issuedSecret);
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
        });
        ownedHostId = hostId;

        persistHosts();
        sendJson(ws, 'host:registered', {
          hostId,
          pairingCode,
          pairingUrl,
          controllerCount: controllers.size,
          ...(issuedSecret ? { hostSecret: issuedSecret } : {}),
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
        controllerHostMap.get(ws)?.add(entry.profile.hostId);

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
          controllerHostMap.get(ws)?.delete(hostId);
          sendJson(entry.ws, 'host:controller_count', { count: entry.controllers.size });
          broadcastFleet();
        }
        return;
      }

      if (event === 'client:input') {
        const hostId = String(payload.hostId || '');
        const input = payload.input as RemoteInputEvent | undefined;
        const entry = hosts.get(hostId);
        if (!entry || !input) return;

        if (entry.ws && entry.ws.readyState === WebSocket.OPEN) {
          sendJson(entry.ws, 'client:input', input);
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
