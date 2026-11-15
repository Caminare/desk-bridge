import 'dotenv/config';
import express from 'express';
import { createServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import QRCode from 'qrcode';
import { createServer as createViteServer } from 'vite';
import {
  generateBatchLauncher,
  generateNodeHostScript,
  generatePowerShellHostScript,
} from './server/windowsAgentGenerator.js';
import { processAssistantCommand, transcribeAudioCommand } from './server/aiAssistant.js';
import type { AIThinkingMode, HostProfile, RemoteInputEvent } from './src/types/deskbridge.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 3000);
const HOSTS_STORE_PATH = path.join(__dirname, '.deskbridge-hosts.json');

interface HostConnection {
  profile: HostProfile;
  ws: WebSocket | null;
  controllers: Set<WebSocket>;
  latestFrame?: string;
}

const hosts = new Map<string, HostConnection>();
const fleetSubscribers = new Set<WebSocket>();
const controllerHostMap = new WeakMap<WebSocket, Set<string>>();

function loadSavedHosts() {
  try {
    if (!fs.existsSync(HOSTS_STORE_PATH)) return;
    const raw = fs.readFileSync(HOSTS_STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as HostProfile[];
    for (const profile of parsed) {
      hosts.set(profile.hostId, {
        profile: {
          ...profile,
          status: 'offline',
          connectedControllers: 0,
        },
        ws: null,
        controllers: new Set(),
      });
    }
  } catch (err) {
    console.warn('Could not load saved hosts:', err);
  }
}

function persistHosts() {
  try {
    const list = Array.from(hosts.values()).map((h) => ({
      ...h.profile,
      connectedControllers: h.controllers.size,
    }));
    fs.writeFileSync(HOSTS_STORE_PATH, JSON.stringify(list, null, 2), 'utf8');
  } catch (err) {
    console.warn('Could not persist hosts:', err);
  }
}

function generatePairingCode(): string {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
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
  const rawHost = (req.headers['x-forwarded-host'] as string) || req.headers.host || `localhost:${PORT}`;
  const proto = rawProto.split(',')[0].trim();
  const host = rawHost.split(',')[0].trim();
  const appUrl = (envUrl || `${proto}://${host}`).replace(/\/$/, '');
  const wsProto = appUrl.startsWith('https') ? 'wss' : 'ws';
  const wsUrl = appUrl.replace(/^https?/, wsProto) + '/ws';
  return { appUrl, wsUrl };
}

loadSavedHosts();

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '15mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      geminiReady: Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY'),
      onlineHosts: Array.from(hosts.values()).filter((h) => h.profile.status === 'online').length,
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
      latestFrame: match.latestFrame || null,
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

    if (format === 'bat') {
      const content = generateBatchLauncher();
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', 'attachment; filename="Start-DeskBridge.bat"');
      res.send(content);
      return;
    }

    if (format === 'mjs') {
      const content = generateNodeHostScript({ wsUrl, appUrl, hostName, groupLabel });
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="deskbridge-host.mjs"');
      res.send(content);
      return;
    }

    const content = generatePowerShellHostScript({ wsUrl, appUrl, hostName, groupLabel });
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
      const frame = screenshotBase64 || activeEntry?.latestFrame;

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
      const message = (err as Error).message || 'Failed to process AI command.';
      res.status(500).json({ error: message });
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

      const transcript = await transcribeAudioCommand(audioBase64, mimeType || 'audio/webm');
      if (!transcript) {
        res.status(422).json({ error: 'Could not detect clear speech in the recording. Please try again.' });
        return;
      }

      const activeEntry = hostId ? hosts.get(hostId) : undefined;
      const frame = screenshotBase64 || activeEntry?.latestFrame;

      const result = await processAssistantCommand({
        prompt: transcript,
        thinkingMode: thinkingMode || 'fast',
        activeHost: activeEntry?.profile,
        availableHosts: getPublicHostsList(),
        screenshotBase64: frame,
        speakReply: Boolean(speakReply),
      });

      res.json({
        ...result,
        transcript,
      });
    } catch (err) {
      const message = (err as Error).message || 'Failed to transcribe or execute voice command.';
      res.status(500).json({ error: message });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const httpServer = createServer(app);
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws, req) => {
    let ownedHostId: string | null = null;
    controllerHostMap.set(ws, new Set());

    const rawProto = (req.headers['x-forwarded-proto'] as string) || 'http';
    const rawHost = (req.headers['x-forwarded-host'] as string) || req.headers.host || `localhost:${PORT}`;
    const proto = rawProto.split(',')[0].trim();
    const hostHeader = rawHost.split(',')[0].trim();
    const envAppUrl = process.env.APP_URL && process.env.APP_URL !== 'MY_APP_URL' ? process.env.APP_URL : '';
    const baseUrl = (envAppUrl || `${proto}://${hostHeader}`).replace(/\/$/, '');

    ws.on('message', (raw) => {
      let msg: { event?: string; payload?: Record<string, unknown> };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }

      const event = msg.event;
      const payload = msg.payload || {};

      if (event === 'host:register') {
        const hostId = String(payload.hostId || `pc-${Date.now()}`);
        const existing = hosts.get(hostId);
        const pairingCode = existing?.profile.pairingCode || generatePairingCode();
        const pairingUrl = `${baseUrl}/?pair=${pairingCode}&host=${encodeURIComponent(hostId)}`;

        const profile: HostProfile = {
          hostId,
          name: String(payload.name || existing?.profile.name || 'Windows PC'),
          groupLabel: String(payload.groupLabel || payload.jobLabel || existing?.profile.groupLabel || 'Workstation'),
          os: String(payload.os || 'Windows 11 Pro'),
          screenWidth: Number(payload.screenWidth || 1920),
          screenHeight: Number(payload.screenHeight || 1080),
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

        const controllers = existing?.controllers ?? new Set<WebSocket>();
        hosts.set(hostId, {
          profile,
          ws,
          controllers,
          latestFrame: existing?.latestFrame,
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

      if (event === 'host:regenerate_code' && ownedHostId) {
        const entry = hosts.get(ownedHostId);
        if (!entry) return;
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
        const hostId = String(payload.hostId || ownedHostId || '');
        const entry = hosts.get(hostId);
        if (!entry) return;
        const frame = typeof payload.frame === 'string' ? payload.frame : '';
        if (frame) {
          entry.latestFrame = frame;
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
          sendJson(ctrl, 'host:frame', {
            hostId,
            frame,
            activeWindow: entry.profile.activeWindow,
            cpuUsage: entry.profile.cpuUsage,
            memoryUsage: entry.profile.memoryUsage,
            timestamp: payload.timestamp || Date.now(),
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
          latestFrame: entry.latestFrame || null,
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

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`DeskBridge server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start DeskBridge server:', err);
  process.exit(1);
});
