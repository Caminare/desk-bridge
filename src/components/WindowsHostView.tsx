import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Monitor, MonitorPlay, Play, QrCode, ScreenShare, Square } from 'lucide-react';
import type { RemoteInputEvent } from '../types/deskbridge';
import { apiFetch } from '../lib/auth';
import { AgentDownloadCard } from './hostView/AgentDownloadCard';
import { PairingPanel } from './hostView/PairingPanel';
import {
  VIRTUAL_H,
  VIRTUAL_W,
  applyVirtualInput,
  createVirtualDesktopState,
  drawVirtualDesktop,
  getFocusedWindowTitle,
  type VirtualDesktopState,
} from '../lib/virtualDesktop';
import wallpaperUrl from '../assets/images/windows_studio_wallpaper_1794751481490.jpg';

interface WindowsHostViewProps {
  onConnectToHost: (hostId: string) => void;
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
  const [hostError, setHostError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const displayStreamRef = useRef<MediaStream | null>(null);
  const frameIntervalRef = useRef<number | null>(null);
  const wallpaperImgRef = useRef<HTMLImageElement | null>(null);

  const virtualStateRef = useRef<VirtualDesktopState>(createVirtualDesktopState());

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

  const renderVirtualFrame = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    if (canvas.width !== VIRTUAL_W) canvas.width = VIRTUAL_W;
    if (canvas.height !== VIRTUAL_H) canvas.height = VIRTUAL_H;
    drawVirtualDesktop(ctx, virtualStateRef.current, {
      wallpaper: wallpaperImgRef.current,
      hostName,
      groupLabel,
    });
  }, [hostName, groupLabel]);

  const applyInputToVirtualDesktop = useCallback((input: RemoteInputEvent) => {
    const status = applyVirtualInput(virtualStateRef.current, input);
    if (status) setLastCommand(status);
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
            activeWindow: getFocusedWindowTitle(virtualStateRef.current) || 'Windows Desktop',
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
          renderVirtualFrame();
          if (canvasRef.current) {
            frameData = canvasRef.current.toDataURL('image/jpeg', 0.68);
          }
        }

        if (frameData) {
          const activeWin = getFocusedWindowTitle(virtualStateRef.current);
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
            <PairingPanel
              qrDataUrl={qrDataUrl}
              pairingCode={pairingCode}
              pairingUrl={pairingUrl}
              lastCommand={lastCommand}
              onRegenerate={regeneratePairingCode}
              onControl={() => onConnectToHost(hostId)}
            />
          )}
        </div>

        <div className="lg:col-span-5">
          <AgentDownloadCard hostName={hostName} groupLabel={groupLabel} />
        </div>
      </div>
    </div>
  );
}
