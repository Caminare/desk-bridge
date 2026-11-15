import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check,
  Copy,
  Download,
  Monitor,
  MonitorPlay,
  Play,
  QrCode,
  RefreshCw,
  ScreenShare,
  Square,
  Terminal,
} from 'lucide-react';
import type { RemoteInputEvent } from '../types/deskbridge';
import { apiFetch } from '../lib/auth';
import wallpaperUrl from '../assets/images/windows_studio_wallpaper_1794751481490.jpg';

interface WindowsHostViewProps {
  onConnectToHost: (hostId: string) => void;
}

interface VirtualWindow {
  id: string;
  title: string;
  app: string;
  x: number;
  y: number;
  w: number;
  h: number;
  content: string[];
  minimized?: boolean;
}

function getWsEndpoint(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws`;
}

export function WindowsHostView({ onConnectToHost }: WindowsHostViewProps) {
  const [hostName, setHostName] = useState('Desktop-PC-01');
  const [groupLabel, setGroupLabel] = useState('Workstation');
  const [captureSource, setCaptureSource] = useState<'virtual' | 'display'>('virtual');
  const [isHosting, setIsHosting] = useState(false);
  const [hostId] = useState(() => {
    const saved = localStorage.getItem('deskbridge_browser_host_id');
    if (saved) return saved;
    const created = `win-sim-${Math.random().toString(36).slice(2, 8)}`;
    localStorage.setItem('deskbridge_browser_host_id', created);
    return created;
  });
  const [pairingCode, setPairingCode] = useState<string>('');
  const [pairingUrl, setPairingUrl] = useState<string>('');
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [controllerCount, setControllerCount] = useState(0);
  const [lastCommand, setLastCommand] = useState<string>('Ready for remote connections');
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [hostError, setHostError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const displayStreamRef = useRef<MediaStream | null>(null);
  const frameIntervalRef = useRef<number | null>(null);
  const wallpaperImgRef = useRef<HTMLImageElement | null>(null);

  const virtualStateRef = useRef<{
    cursorX: number;
    cursorY: number;
    locked: boolean;
    startMenuOpen: boolean;
    focusedId: string;
    windows: VirtualWindow[];
  }>({
    cursorX: 480,
    cursorY: 270,
    locked: false,
    startMenuOpen: false,
    focusedId: 'outlook',
    windows: [
      {
        id: 'outlook',
        title: 'Outlook — Client Updates',
        app: 'outlook',
        x: 70,
        y: 52,
        w: 440,
        h: 270,
        content: [
          'Inbox · Primary Account',
          '----------------------------------------',
          'From: Sarah Chen <schen@clientops.io>',
          'Subject: Q4 Deployment Checklist',
          '',
          'Hi! Can you confirm once the staging build',
          'is pushed before 2:00 PM?',
          '',
          'Draft Reply: ',
        ],
      },
      {
        id: 'terminal',
        title: 'Windows PowerShell',
        app: 'powershell',
        x: 540,
        y: 88,
        w: 360,
        h: 240,
        content: [
          'PS C:\\Projects\\ClientApp> git status',
          'On branch main — clean working tree',
          'PS C:\\Projects\\ClientApp> ',
        ],
      },
    ],
  });

  useEffect(() => {
    const img = new Image();
    img.src = wallpaperUrl;
    img.onload = () => {
      wallpaperImgRef.current = img;
    };
  }, []);

  const stopHosting = useCallback(() => {
    if (frameIntervalRef.current) {
      window.clearInterval(frameIntervalRef.current);
      frameIntervalRef.current = null;
    }
    if (displayStreamRef.current) {
      displayStreamRef.current.getTracks().forEach((t) => t.stop());
      displayStreamRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setIsHosting(false);
    setControllerCount(0);
  }, []);

  useEffect(() => {
    return () => {
      stopHosting();
    };
  }, [stopHosting]);

  const drawVirtualDesktop = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = 960;
    const H = 540;
    if (canvas.width !== W) canvas.width = W;
    if (canvas.height !== H) canvas.height = H;

    const state = virtualStateRef.current;

    if (wallpaperImgRef.current) {
      ctx.drawImage(wallpaperImgRef.current, 0, 0, W, H);
    } else {
      const grad = ctx.createLinearGradient(0, 0, W, H);
      grad.addColorStop(0, '#0f172a');
      grad.addColorStop(1, '#1e3a8a');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
    }

    if (state.locked) {
      ctx.fillStyle = 'rgba(9, 13, 22, 0.85)';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#ffffff';
      ctx.font = '600 32px "Plus Jakarta Sans", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), W / 2, H / 2 - 20);
      ctx.font = '500 14px "DM Sans", sans-serif';
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(`${hostName} Locked · Click or press a key to unlock`, W / 2, H / 2 + 16);
      ctx.textAlign = 'left';
    } else {
      const desktopIcons = [
        { label: 'Outlook', x: 24, y: 24 },
        { label: 'Excel', x: 24, y: 98 },
        { label: 'VS Code', x: 24, y: 172 },
        { label: 'PowerShell', x: 24, y: 246 },
      ];
      for (const icon of desktopIcons) {
        ctx.fillStyle = 'rgba(15, 23, 42, 0.55)';
        ctx.fillRect(icon.x, icon.y, 64, 58);
        ctx.strokeStyle = 'rgba(255,255,255,0.14)';
        ctx.strokeRect(icon.x, icon.y, 64, 58);
        ctx.fillStyle = '#3b82f6';
        ctx.fillRect(icon.x + 20, icon.y + 10, 24, 22);
        ctx.fillStyle = '#f8fafc';
        ctx.font = '500 11px "DM Sans", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(icon.label, icon.x + 32, icon.y + 48);
      }
      ctx.textAlign = 'left';

      const ordered = [...state.windows].sort((a, b) =>
        a.id === state.focusedId ? 1 : b.id === state.focusedId ? -1 : 0,
      );

      for (const win of ordered) {
        if (win.minimized) continue;
        const isFocused = win.id === state.focusedId;

        ctx.fillStyle = win.app === 'powershell' ? 'rgba(9, 13, 22, 0.94)' : 'rgba(15, 23, 42, 0.92)';
        ctx.fillRect(win.x, win.y, win.w, win.h);
        ctx.strokeStyle = isFocused ? '#3b82f6' : 'rgba(148, 163, 184, 0.28)';
        ctx.lineWidth = isFocused ? 1.5 : 1;
        ctx.strokeRect(win.x, win.y, win.w, win.h);

        ctx.fillStyle = isFocused ? '#1e293b' : '#0f172a';
        ctx.fillRect(win.x, win.y, win.w, 30);

        ctx.fillStyle = '#f8fafc';
        ctx.font = '600 12px "DM Sans", sans-serif';
        ctx.fillText(win.title, win.x + 12, win.y + 19);

        ctx.fillStyle = '#94a3b8';
        ctx.fillText('—   □   ×', win.x + win.w - 64, win.y + 19);

        ctx.fillStyle = win.app === 'powershell' ? '#38bdf8' : '#e2e8f0';
        ctx.font = '400 12px "JetBrains Mono", monospace';
        const lines = win.content.slice(-11);
        lines.forEach((line, idx) => {
          ctx.fillText(line.slice(0, 52), win.x + 14, win.y + 54 + idx * 18);
        });
      }

      if (state.startMenuOpen) {
        ctx.fillStyle = 'rgba(15, 23, 42, 0.96)';
        ctx.fillRect(W / 2 - 140, H - 250, 280, 198);
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.3)';
        ctx.strokeRect(W / 2 - 140, H - 250, 280, 198);
        ctx.fillStyle = '#ffffff';
        ctx.font = '600 13px "Plus Jakarta Sans", sans-serif';
        ctx.fillText(`${hostName} · ${groupLabel}`, W / 2 - 122, H - 224);
        ctx.fillStyle = '#94a3b8';
        ctx.font = '400 12px "DM Sans", sans-serif';
        ctx.fillText('Pinned: Outlook, Excel, VS Code, Terminal', W / 2 - 122, H - 196);
      }

      ctx.fillStyle = 'rgba(9, 13, 22, 0.88)';
      ctx.fillRect(0, H - 42, W, 42);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
      ctx.beginPath();
      ctx.moveTo(0, H - 42);
      ctx.lineTo(W, H - 42);
      ctx.stroke();

      ctx.fillStyle = '#3b82f6';
      ctx.fillRect(W / 2 - 90, H - 32, 22, 22);
      ctx.fillStyle = '#e2e8f0';
      ctx.font = '500 11px "DM Sans", sans-serif';
      ctx.fillText(groupLabel, 16, H - 17);
      ctx.fillText(
        new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        W - 64,
        H - 17,
      );
    }

    const cx = state.cursorX;
    const cy = state.cursorY;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx, cy + 18);
    ctx.lineTo(cx + 5, cy + 14);
    ctx.lineTo(cx + 12, cy + 14);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }, [hostName, groupLabel]);

  const applyInputToVirtualDesktop = useCallback((input: RemoteInputEvent) => {
    const state = virtualStateRef.current;
    const W = 960;
    const H = 540;

    if (input.type === 'mousemove') {
      if (input.relative) {
        state.cursorX = Math.max(0, Math.min(W - 4, state.cursorX + (input.dx || 0)));
        state.cursorY = Math.max(0, Math.min(H - 4, state.cursorY + (input.dy || 0)));
      } else {
        state.cursorX = Math.max(0, Math.min(W - 4, input.x * W));
        state.cursorY = Math.max(0, Math.min(H - 4, input.y * H));
      }
      return;
    }

    if (input.type === 'click') {
      if (typeof input.x === 'number' && typeof input.y === 'number') {
        state.cursorX = Math.max(0, Math.min(W - 4, input.x * W));
        state.cursorY = Math.max(0, Math.min(H - 4, input.y * H));
      }
      if (state.locked) {
        state.locked = false;
        setLastCommand('Unlocked desktop');
        return;
      }

      const cx = state.cursorX;
      const cy = state.cursorY;

      if (cy >= H - 42 && cx >= W / 2 - 100 && cx <= W / 2 - 60) {
        state.startMenuOpen = !state.startMenuOpen;
        setLastCommand('Toggled Start Menu');
        return;
      }

      for (let i = state.windows.length - 1; i >= 0; i--) {
        const win = state.windows[i];
        if (win.minimized) continue;
        if (cx >= win.x && cx <= win.x + win.w && cy >= win.y && cy <= win.y + win.h) {
          state.focusedId = win.id;
          state.startMenuOpen = false;
          setLastCommand(`Clicked inside ${win.title}`);
          return;
        }
      }

      if (cx >= 24 && cx <= 88) {
        const launchMap = [
          { minY: 24, maxY: 82, app: 'outlook', title: 'Outlook — Client Updates' },
          { minY: 98, maxY: 156, app: 'excel', title: 'Excel — Q4 Budget.xlsx' },
          { minY: 172, maxY: 230, app: 'code', title: 'Visual Studio Code' },
          { minY: 246, maxY: 304, app: 'powershell', title: 'Windows PowerShell' },
        ];
        const hit = launchMap.find((m) => cy >= m.minY && cy <= m.maxY);
        if (hit) {
          const existing = state.windows.find((w) => w.app === hit.app);
          if (existing) {
            existing.minimized = false;
            state.focusedId = existing.id;
          } else {
            const newWin: VirtualWindow = {
              id: hit.app,
              title: hit.title,
              app: hit.app,
              x: 120 + state.windows.length * 24,
              y: 64 + state.windows.length * 20,
              w: 440,
              h: 250,
              content: [`Opened ${hit.title}`, 'Ready for keyboard input...'],
            };
            state.windows.push(newWin);
            state.focusedId = newWin.id;
          }
          setLastCommand(`Opened ${hit.title}`);
        }
      }
      return;
    }

    if (input.type === 'type') {
      state.locked = false;
      const win = state.windows.find((w) => w.id === state.focusedId) || state.windows[0];
      if (win) {
        const lastIdx = win.content.length - 1;
        win.content[lastIdx] = (win.content[lastIdx] || '') + input.text;
        setLastCommand(`Typed "${input.text.slice(0, 28)}"`);
      }
      return;
    }

    if (input.type === 'key') {
      state.locked = false;
      const win = state.windows.find((w) => w.id === state.focusedId) || state.windows[0];
      if (win) {
        if (input.key === 'Enter') {
          win.content.push('');
        } else if (input.key === 'Backspace') {
          const lastIdx = win.content.length - 1;
          win.content[lastIdx] = (win.content[lastIdx] || '').slice(0, -1);
        }
      }
      setLastCommand(`Key: ${input.key}`);
      return;
    }

    if (input.type === 'hotkey') {
      if (input.combo === 'Win+D') {
        const anyOpen = state.windows.some((w) => !w.minimized);
        state.windows.forEach((w) => {
          w.minimized = anyOpen;
        });
      } else if (input.combo === 'Win+L') {
        state.locked = true;
      } else if (input.combo === 'Alt+Tab') {
        const idx = state.windows.findIndex((w) => w.id === state.focusedId);
        const next = state.windows[(idx + 1) % state.windows.length];
        if (next) {
          next.minimized = false;
          state.focusedId = next.id;
        }
      }
      setLastCommand(`Shortcut: ${input.combo}`);
      return;
    }

    if (input.type === 'launch') {
      state.locked = false;
      const target = input.target.toLowerCase();
      const existing = state.windows.find((w) => w.app === target || w.title.toLowerCase().includes(target));
      if (existing) {
        existing.minimized = false;
        state.focusedId = existing.id;
      } else {
        const id = `${target}-${Date.now()}`;
        state.windows.push({
          id,
          title: `${input.target} — Active Window`,
          app: target,
          x: 110 + (state.windows.length % 4) * 28,
          y: 56 + (state.windows.length % 4) * 24,
          w: 450,
          h: 255,
          content: [`Launched ${input.target}`, 'Ready for input: '],
        });
        state.focusedId = id;
      }
      setLastCommand(`Launched ${input.target}`);
      return;
    }

    if (input.type === 'shell') {
      state.locked = false;
      let ps = state.windows.find((w) => w.app === 'powershell');
      if (!ps) {
        ps = {
          id: 'powershell',
          title: 'Windows PowerShell',
          app: 'powershell',
          x: 360,
          y: 80,
          w: 440,
          h: 250,
          content: [],
        };
        state.windows.push(ps);
      }
      ps.minimized = false;
      state.focusedId = ps.id;
      ps.content.push(`PS> ${input.command}`);
      ps.content.push(`Executed "${input.command}" [OK]`);
      setLastCommand(`Ran PowerShell: ${input.command}`);
    }
  }, []);

  const startHosting = async () => {
    setHostError(null);
    stopHosting();

    if (captureSource === 'display') {
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        displayStreamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
      } catch {
        setHostError('Screen capture was cancelled or unavailable. Switched to Interactive Windows Studio Canvas.');
        setCaptureSource('virtual');
      }
    }

    const ws = new WebSocket(getWsEndpoint());
    wsRef.current = ws;

    ws.onopen = () => {
      setIsHosting(true);
      ws.send(
        JSON.stringify({
          event: 'host:register',
          payload: {
            hostId,
            name: hostName.trim() || 'Windows PC',
            groupLabel: groupLabel.trim() || 'Workstation',
            os: captureSource === 'display' ? 'Windows Screen Share' : 'Windows 11 Pro (Live Host)',
            screenWidth: 1920,
            screenHeight: 1080,
            agentType: 'browser-host',
            activeWindow: virtualStateRef.current.windows.find(
              (w) => w.id === virtualStateRef.current.focusedId,
            )?.title || 'Windows Desktop',
          },
        }),
      );

      frameIntervalRef.current = window.setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;

        let frameData = '';
        if (captureSource === 'display' && videoRef.current && videoRef.current.readyState >= 2) {
          const v = videoRef.current;
          const off = canvasRef.current;
          if (off) {
            off.width = Math.min(1280, v.videoWidth || 1280);
            off.height = Math.round(off.width * ((v.videoHeight || 720) / (v.videoWidth || 1280)));
            const ctx = off.getContext('2d');
            if (ctx) {
              ctx.drawImage(v, 0, 0, off.width, off.height);
              frameData = off.toDataURL('image/jpeg', 0.62);
            }
          }
        } else {
          drawVirtualDesktop();
          if (canvasRef.current) {
            frameData = canvasRef.current.toDataURL('image/jpeg', 0.68);
          }
        }

        if (frameData) {
          const activeWin = virtualStateRef.current.windows.find(
            (w) => w.id === virtualStateRef.current.focusedId,
          )?.title;
          ws.send(
            JSON.stringify({
              event: 'host:frame',
              payload: {
                hostId,
                frame: frameData,
                activeWindow: virtualStateRef.current.locked ? 'Lock Screen' : activeWin || 'Windows Desktop',
                timestamp: Date.now(),
              },
            }),
          );
        }
      }, 220);
    };

    ws.onmessage = async (evt) => {
      let msg: { event?: string; payload?: Record<string, unknown> };
      try {
        msg = JSON.parse(String(evt.data));
      } catch {
        return;
      }

      if (msg.event === 'host:registered' && msg.payload) {
        const code = String(msg.payload.pairingCode || '');
        const url = String(msg.payload.pairingUrl || '');
        setPairingCode(code);
        setPairingUrl(url);
        setControllerCount(Number(msg.payload.controllerCount || 0));
        try {
          const res = await apiFetch(`/api/qr?data=${encodeURIComponent(url)}`);
          const data = await res.json();
          if (data.dataUrl) setQrDataUrl(data.dataUrl);
        } catch {
          // ignore QR render error
        }
      } else if (msg.event === 'host:controller_count' && msg.payload) {
        setControllerCount(Number(msg.payload.count || 0));
      } else if (msg.event === 'client:input' && msg.payload) {
        applyInputToVirtualDesktop(msg.payload as unknown as RemoteInputEvent);
      }
    };

    ws.onclose = () => {
      setIsHosting(false);
    };
  };

  const regeneratePairingCode = () => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ event: 'host:regenerate_code', payload: {} }));
    }
  };

  const downloadBaseParams = `name=${encodeURIComponent(hostName)}&group=${encodeURIComponent(groupLabel)}`;
  const quickPsCommand = `powershell -ExecutionPolicy Bypass -File .\\DeskBridge-Host.ps1`;

  const handleCopyCommand = () => {
    navigator.clipboard.writeText(quickPsCommand).catch(() => {});
    setCopiedCmd(true);
    window.setTimeout(() => setCopiedCmd(false), 1800);
  };

  return (
    <div className="space-y-8">
      <div className="space-y-1.5">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-white text-balance">
          Windows Host App
        </h1>
        <p className="text-sm text-slate-600 dark:text-slate-400 max-w-2xl">
          Run the Windows agent on any number of Windows PCs to generate a QR code and expose each desktop securely, or start Live Browser Host Mode right here to test pairing immediately.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <div className="lg:col-span-7 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 sm:p-6 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <MonitorPlay className="w-5 h-5 text-blue-600 dark:text-blue-400" />
              <div>
                <h2 className="text-base font-semibold text-slate-900 dark:text-white">
                  Live Browser Host & QR Generator
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Exposes this session over WebSockets so your phone can scan & control it
                </p>
              </div>
            </div>

            {isHosting ? (
              <button
                type="button"
                onClick={stopHosting}
                className="min-h-[44px] inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-white text-sm font-semibold transition-colors"
              >
                <Square className="w-4 h-4" />
                <span>Stop Hosting</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={startHosting}
                className="min-h-[44px] inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold transition-colors"
              >
                <Play className="w-4 h-4" />
                <span>Start Host & Generate QR</span>
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Computer Name
              </label>
              <input
                type="text"
                value={hostName}
                onChange={(e) => setHostName(e.target.value)}
                disabled={isHosting}
                placeholder="e.g. Studio-Desktop-01"
                className="w-full min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-sm text-slate-900 dark:text-white disabled:opacity-60"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Group / Location Label
              </label>
              <input
                type="text"
                value={groupLabel}
                onChange={(e) => setGroupLabel(e.target.value)}
                disabled={isHosting}
                placeholder="e.g. Office, Home, Studio"
                className="w-full min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-sm text-slate-900 dark:text-white disabled:opacity-60"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-1 p-1 rounded-xl bg-slate-100 dark:bg-slate-800">
              <button
                type="button"
                onClick={() => setCaptureSource('virtual')}
                disabled={isHosting}
                className={`min-h-[38px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  captureSource === 'virtual'
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                <Monitor className="w-3.5 h-3.5" />
                <span>Interactive Windows Canvas</span>
              </button>
              <button
                type="button"
                onClick={() => setCaptureSource('display')}
                disabled={isHosting}
                className={`min-h-[38px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  captureSource === 'display'
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                <ScreenShare className="w-3.5 h-3.5" />
                <span>Real Screen Share</span>
              </button>
            </div>

            {isHosting && (
              <span className="text-xs text-slate-600 dark:text-slate-400 tabular-nums">
                {controllerCount} paired controller{controllerCount === 1 ? '' : 's'}
              </span>
            )}
          </div>

          {hostError && (
            <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-600 dark:text-amber-400">
              {hostError}
            </div>
          )}

          <div className="rounded-xl overflow-hidden border border-slate-200 dark:border-slate-800 bg-slate-950 aspect-video relative">
            <video ref={videoRef} muted playsInline className="hidden" />
            <canvas ref={canvasRef} className="w-full h-full object-contain" />
            {!isHosting && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-slate-950/75 text-center p-6">
                <QrCode className="w-8 h-8 text-blue-400" />
                <p className="text-sm font-medium text-white">Host Standby</p>
                <p className="text-xs text-slate-400 max-w-sm">
                  Click &ldquo;Start Host &amp; Generate QR&rdquo; to expose this desktop and get a scannable pairing QR code.
                </p>
              </div>
            )}
          </div>

          {isHosting && (
            <div className="flex flex-col sm:flex-row items-center gap-5 p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
              <div className="w-36 h-36 rounded-xl bg-white p-2 shrink-0 flex items-center justify-center border border-slate-200">
                {qrDataUrl ? (
                  <img
                    src={qrDataUrl}
                    alt="DeskBridge Host Pairing QR Code"
                    className="w-full h-full object-contain"
                  />
                ) : (
                  <QrCode className="w-10 h-10 text-slate-400" />
                )}
              </div>

              <div className="flex-1 space-y-2.5 text-center sm:text-left min-w-0">
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  Scan with DeskBridge Mobile or enter pairing code
                </div>
                <div className="flex items-center justify-center sm:justify-start gap-2.5">
                  <span className="text-2xl font-mono font-bold tracking-widest text-slate-900 dark:text-white tabular-nums">
                    {pairingCode}
                  </span>
                  <button
                    type="button"
                    onClick={regeneratePairingCode}
                    className="min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                    aria-label="Regenerate pairing code"
                  >
                    <RefreshCw className="w-4 h-4" />
                  </button>
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400 truncate">
                  Last event: {lastCommand}
                </div>
                <div className="flex flex-wrap items-center justify-center sm:justify-start gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => onConnectToHost(hostId)}
                    className="min-h-[40px] px-3.5 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold transition-colors"
                  >
                    Control This Host Now
                  </button>
                  {pairingUrl && (
                    <button
                      type="button"
                      onClick={() => navigator.clipboard.writeText(pairingUrl)}
                      className="min-h-[40px] px-3.5 py-2 rounded-xl border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                    >
                      Copy Pair Link
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="lg:col-span-5 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 sm:p-6 space-y-5">
          <div className="flex items-center gap-2.5">
            <Terminal className="w-5 h-5 text-blue-600 dark:text-blue-400" />
            <div>
              <h2 className="text-base font-semibold text-slate-900 dark:text-white">
                Native Windows 10/11 Host App
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Install on as many Windows PCs as you need with zero external dependencies
              </p>
            </div>
          </div>

          <div className="space-y-2.5 text-sm text-slate-600 dark:text-slate-400">
            <p>
              1. Enter a custom Computer Name and Group label above, then download both files into the same folder on that Windows computer.
            </p>
            <p>
              2. Double-click <code className="font-mono text-xs text-slate-900 dark:text-slate-200">Start-DeskBridge.bat</code>. It connects over WebSockets, prints a 6-character pairing code, and streams your desktop with real Win32 mouse &amp; keyboard control.
            </p>
            <p>
              3. Repeat on any number of Windows computers and scan or enter their pairing codes on your Android phone to switch between them anytime.
            </p>
          </div>

          <div className="space-y-2.5 pt-2">
            <a
              href={`/api/host-agent/download?format=ps1&${downloadBaseParams}`}
              download="DeskBridge-Host.ps1"
              className="w-full min-h-[48px] px-4 py-3 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold flex items-center justify-between transition-colors"
            >
              <span>Download DeskBridge-Host.ps1</span>
              <Download className="w-4 h-4" />
            </a>

            <a
              href={`/api/host-agent/download?format=bat&${downloadBaseParams}`}
              download="Start-DeskBridge.bat"
              className="w-full min-h-[48px] px-4 py-3 rounded-xl border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-900 dark:text-white text-sm font-medium flex items-center justify-between transition-colors"
            >
              <span>Download Start-DeskBridge.bat</span>
              <Download className="w-4 h-4" />
            </a>

            <a
              href={`/api/host-agent/download?format=mjs&${downloadBaseParams}`}
              download="deskbridge-host.mjs"
              className="w-full min-h-[44px] px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 text-xs font-medium flex items-center justify-between transition-colors"
            >
              <span>Alternative: Node.js Host Script (deskbridge-host.mjs)</span>
              <Download className="w-4 h-4" />
            </a>
          </div>

          <div className="pt-3 border-t border-slate-200 dark:border-slate-800 space-y-2">
            <div className="text-xs font-medium text-slate-700 dark:text-slate-300">
              PowerShell Launch Command
            </div>
            <div className="flex items-center gap-2 p-2.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
              <code className="flex-1 text-xs font-mono text-slate-800 dark:text-slate-300 truncate">
                {quickPsCommand}
              </code>
              <button
                type="button"
                onClick={handleCopyCommand}
                className="min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-400"
                aria-label="Copy PowerShell command"
              >
                {copiedCmd ? <Check className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
