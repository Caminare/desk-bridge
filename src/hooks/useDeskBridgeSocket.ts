import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActivityLogEntry, HostProfile, RemoteInputEvent } from '../types/deskbridge';
import { apiFetch, notifyUnauthorized } from '../lib/auth';
import { FrameStore } from '../lib/frameCompositor';
import { LOCK_WARNING, isLockingInput } from '../lib/remoteInput';

/** How often thumbnails (fleet cards, AI previews) are refreshed from the live canvas. */
const SNAPSHOT_INTERVAL_MS = 2000;

function getWsEndpoint(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws`;
}

export function useDeskBridgeSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const disposedRef = useRef(false);
  const activeHostIdRef = useRef<string | null>(null);
  const blobUrlsByHostRef = useRef<Record<string, string>>({});
  const snapshotVersionRef = useRef<Record<string, number>>({});
  // Live frames are composited onto per-host canvases outside React state, so a new
  // frame does not re-render the app. Only throttled snapshots go into state.
  const frameStoreRef = useRef<FrameStore | null>(null);
  if (!frameStoreRef.current) {
    frameStoreRef.current = new FrameStore((hostId) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ event: 'client:keyframe_request', payload: { hostId } }));
      }
    });
  }
  const frameStore = frameStoreRef.current;
  const hostLastMetaAtRef = useRef<Record<string, { ts: number; win?: string }>>({});

  const [wsConnected, setWsConnected] = useState(false);
  const [hosts, setHosts] = useState<HostProfile[]>([]);
  const [activeHostId, setActiveHostId] = useState<string | null>(null);
  const [framesByHost, setFramesByHost] = useState<Record<string, string>>({});
  const [pairError, setPairError] = useState<string | null>(null);
  const [activityLog, setActivityLog] = useState<ActivityLogEntry[]>([]);

  activeHostIdRef.current = activeHostId;
  const hostsRef = useRef<HostProfile[]>([]);
  hostsRef.current = hosts;

  const appendActivity = useCallback(
    (hostId: string, source: ActivityLogEntry['source'], summary: string) => {
      setActivityLog((prev) => [
        {
          id: `act-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          timestamp: Date.now(),
          hostId,
          source,
          summary,
        },
        ...prev.slice(0, 39),
      ]);
    },
    [],
  );

  const sendWs = useCallback((event: string, payload: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ event, payload }));
      return true;
    }
    return false;
  }, []);

  const applyHostMeta = useCallback((hostId: string, activeWindow?: string, cpuUsage?: number, memoryUsage?: number) => {
    const now = Date.now();
    const prevMeta = hostLastMetaAtRef.current[hostId];
    const winChanged = activeWindow !== undefined && prevMeta?.win !== activeWindow;
    if (!winChanged && prevMeta && now - prevMeta.ts < 2000) {
      return;
    }
    hostLastMetaAtRef.current[hostId] = { ts: now, win: activeWindow ?? prevMeta?.win };
    setHosts((prev) =>
      prev.map((h) =>
        h.hostId === hostId
          ? {
              ...h,
              status: 'online',
              lastSeen: now,
              activeWindow: activeWindow ?? h.activeWindow,
              cpuUsage: cpuUsage ?? h.cpuUsage,
              memoryUsage: memoryUsage ?? h.memoryUsage,
            }
          : h,
      ),
    );
  }, []);

  const connect = useCallback(() => {
    if (disposedRef.current) return;
    if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const ws = new WebSocket(getWsEndpoint());
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    const textDecoder = new TextDecoder();

    ws.onopen = () => {
      setWsConnected(true);
      ws.send(JSON.stringify({ event: 'client:subscribe_fleet', payload: {} }));
      if (activeHostIdRef.current) {
        ws.send(JSON.stringify({ event: 'client:pair', payload: { hostId: activeHostIdRef.current } }));
      }
    };

    ws.onmessage = (evt) => {
      if (evt.data instanceof ArrayBuffer) {
        const buf = evt.data;
        if (buf.byteLength <= 4) return;
        const view = new DataView(buf);
        if (view.getUint8(0) !== 0x44) return;
        const headerLen = view.getUint16(2, false);
        if (buf.byteLength < 4 + headerLen) return;
        let meta: { hostId?: string; activeWindow?: string };
        try {
          meta = JSON.parse(textDecoder.decode(new Uint8Array(buf, 4, headerLen)));
        } catch {
          return;
        }
        const hostId = meta.hostId;
        if (!hostId) return;
        applyHostMeta(hostId, meta.activeWindow);

        // Ack only after the frame is on the canvas, so the agent paces to what we can display.
        frameStore
          .get(hostId)
          .applyBinary(buf)
          .then((result) => {
            if (result.seq !== undefined && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ event: 'client:frame_ack', payload: { hostId, seq: result.seq } }));
            }
          });
        return;
      }

      let msg: { event?: string; payload?: unknown };
      try {
        msg = JSON.parse(String(evt.data));
      } catch {
        return;
      }

      if (msg.event === 'auth:required') {
        notifyUnauthorized();
      } else if (msg.event === 'fleet:update' && Array.isArray(msg.payload)) {
        const list = msg.payload as HostProfile[];
        setHosts(list);
      } else if (msg.event === 'client:paired' && msg.payload) {
        const data = msg.payload as { host: HostProfile; latestFrame?: string | null };
        setPairError(null);
        setActiveHostId(data.host.hostId);
        if (data.latestFrame) {
          frameStore.get(data.host.hostId).applyImageUrl(data.latestFrame);
          setFramesByHost((prev) => ({ ...prev, [data.host.hostId]: data.latestFrame! }));
        }
        setHosts((prev) => {
          const exists = prev.some((h) => h.hostId === data.host.hostId);
          return exists
            ? prev.map((h) => (h.hostId === data.host.hostId ? data.host : h))
            : [data.host, ...prev];
        });
        appendActivity(data.host.hostId, 'system', `Connected to ${data.host.name}`);
      } else if (msg.event === 'client:pair_error' && msg.payload) {
        const err = msg.payload as { error: string };
        setPairError(err.error || 'Could not pair with that workstation.');
      } else if (msg.event === 'host:frame' && msg.payload) {
        const data = msg.payload as {
          hostId: string;
          frame: string;
          seq?: number;
          timestamp?: number;
          activeWindow?: string;
          cpuUsage?: number;
          memoryUsage?: number;
        };
        applyHostMeta(data.hostId, data.activeWindow, data.cpuUsage, data.memoryUsage);
        if (data.frame) {
          frameStore
            .get(data.hostId)
            .applyImageUrl(data.frame)
            .then(() => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(
                  JSON.stringify({
                    event: 'client:frame_ack',
                    payload: { hostId: data.hostId, seq: data.seq, timestamp: data.timestamp },
                  }),
                );
              }
            });
        }
      } else if (msg.event === 'host:status' && msg.payload) {
        const data = msg.payload as { hostId: string; status: HostProfile['status'] };
        setHosts((prev) =>
          prev.map((h) => (h.hostId === data.hostId ? { ...h, status: data.status } : h)),
        );
      }
    };

    ws.onclose = (evt) => {
      setWsConnected(false);
      if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
      if (disposedRef.current) return;
      if (evt.code === 4401) {
        notifyUnauthorized();
        return;
      }
      reconnectTimerRef.current = window.setTimeout(connect, 2500);
    };
  }, [appendActivity, applyHostMeta, frameStore]);

  useEffect(() => {
    disposedRef.current = false;
    connect();
    const urlsMap = blobUrlsByHostRef.current;
    return () => {
      disposedRef.current = true;
      if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
      Object.values(urlsMap).forEach((u) => URL.revokeObjectURL(u));
    };
  }, [connect]);

  // Refresh thumbnails from the live canvases (only for hosts that drew something new).
  useEffect(() => {
    const timer = window.setInterval(async () => {
      for (const [hostId, compositor] of frameStore.entries()) {
        if (!compositor.hasImage || snapshotVersionRef.current[hostId] === compositor.version) continue;
        snapshotVersionRef.current[hostId] = compositor.version;
        const blob = await compositor.toBlob();
        if (!blob) continue;
        const url = URL.createObjectURL(blob);
        const prev = blobUrlsByHostRef.current[hostId];
        blobUrlsByHostRef.current[hostId] = url;
        setFramesByHost((p) => ({ ...p, [hostId]: url }));
        if (prev) window.setTimeout(() => URL.revokeObjectURL(prev), 1500);
      }
    }, SNAPSHOT_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [frameStore]);

  const pairHostById = useCallback(
    (hostId: string) => {
      setPairError(null);
      if (activeHostIdRef.current && activeHostIdRef.current !== hostId) {
        sendWs('client:unpair', { hostId: activeHostIdRef.current });
      }
      setActiveHostId(hostId);
      sendWs('client:pair', { hostId });
    },
    [sendWs],
  );

  const pairByQrOrCode = useCallback(
    async (rawInput: string): Promise<HostProfile | null> => {
      setPairError(null);
      const res = await apiFetch('/api/hosts/pair-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: rawInput }),
      });
      const data = await res.json();
      if (!res.ok) {
        const message = data.error || 'Pairing code not found.';
        setPairError(message);
        throw new Error(message);
      }
      const host = data.host as HostProfile;
      if (data.latestFrame) {
        frameStore.get(host.hostId).applyImageUrl(data.latestFrame);
        setFramesByHost((prev) => ({ ...prev, [host.hostId]: data.latestFrame }));
      }
      pairHostById(host.hostId);
      return host;
    },
    [pairHostById, frameStore],
  );

  const sendRemoteInput = useCallback(
    (input: RemoteInputEvent, targetHostId?: string, source: ActivityLogEntry['source'] = 'touch') => {
      const hostId = targetHostId || activeHostIdRef.current;
      if (!hostId) return false;
      // Locking a real PC can't be undone remotely (secure desktop), so confirm first. Covers the
      // Lock PC button, typed combos, the keyboard's sticky Win key and AI actions alike.
      const target = hostsRef.current.find((h) => h.hostId === hostId);
      if (isLockingInput(input) && target?.agentType !== 'browser-host' && !window.confirm(LOCK_WARNING)) {
        return false;
      }
      const sent = sendWs('client:input', { hostId, input });
      if (sent && input.type !== 'mousemove' && input.type !== 'quality') {
        const summary =
          input.type === 'click'
            ? `${input.double ? 'Double-click' : `${input.button} click`}`
            : input.type === 'type'
              ? `Typed "${input.text.slice(0, 32)}"`
              : input.type === 'hotkey'
                ? `Shortcut ${input.combo}`
                : input.type === 'launch'
                  ? `Launched ${input.target}`
                  : input.type === 'shell'
                    ? `Ran ${input.command.slice(0, 32)}`
                    : input.type === 'scroll'
                      ? `Scrolled ${input.deltaY > 0 ? 'down' : 'up'}`
                      : `Key ${input.type}`;
        appendActivity(hostId, source, summary);
      }
      return sent;
    },
    [appendActivity, sendWs],
  );

  const renameHost = useCallback(async (hostId: string, name: string, groupLabel: string) => {
    const res = await apiFetch(`/api/hosts/${encodeURIComponent(hostId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, groupLabel }),
    });
    if (res.ok) {
      const data = (await res.json()) as { host: HostProfile };
      setHosts((prev) => prev.map((h) => (h.hostId === hostId ? data.host : h)));
    }
  }, []);

  const removeHost = useCallback(async (hostId: string) => {
    const res = await apiFetch(`/api/hosts/${encodeURIComponent(hostId)}`, { method: 'DELETE' });
    if (res.ok) {
      setHosts((prev) => prev.filter((h) => h.hostId !== hostId));
      if (activeHostIdRef.current === hostId) {
        setActiveHostId(null);
      }
    }
  }, []);

  const activeHost = hosts.find((h) => h.hostId === activeHostId) || null;
  const activeFrame = activeHostId ? framesByHost[activeHostId] || null : null;

  return {
    wsConnected,
    hosts,
    activeHost,
    activeHostId,
    activeFrame,
    framesByHost,
    frameStore,
    pairError,
    activityLog,
    pairHostById,
    pairByQrOrCode,
    sendRemoteInput,
    renameHost,
    removeHost,
    setPairError,
  };
}
