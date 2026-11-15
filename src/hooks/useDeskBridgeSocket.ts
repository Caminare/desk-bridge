import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActivityLogEntry, HostProfile, RemoteInputEvent } from '../types/deskbridge';

function getWsEndpoint(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws`;
}

export function useDeskBridgeSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const activeHostIdRef = useRef<string | null>(null);

  const [wsConnected, setWsConnected] = useState(false);
  const [hosts, setHosts] = useState<HostProfile[]>([]);
  const [activeHostId, setActiveHostId] = useState<string | null>(null);
  const [framesByHost, setFramesByHost] = useState<Record<string, string>>({});
  const [pairError, setPairError] = useState<string | null>(null);
  const [activityLog, setActivityLog] = useState<ActivityLogEntry[]>([]);

  activeHostIdRef.current = activeHostId;

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

  const connect = useCallback(() => {
    if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const ws = new WebSocket(getWsEndpoint());
    wsRef.current = ws;

    ws.onopen = () => {
      setWsConnected(true);
      ws.send(JSON.stringify({ event: 'client:subscribe_fleet', payload: {} }));
      if (activeHostIdRef.current) {
        ws.send(JSON.stringify({ event: 'client:pair', payload: { hostId: activeHostIdRef.current } }));
      }
    };

    ws.onmessage = (evt) => {
      let msg: { event?: string; payload?: unknown };
      try {
        msg = JSON.parse(String(evt.data));
      } catch {
        return;
      }

      if (msg.event === 'fleet:update' && Array.isArray(msg.payload)) {
        const list = msg.payload as HostProfile[];
        setHosts(list);
      } else if (msg.event === 'client:paired' && msg.payload) {
        const data = msg.payload as { host: HostProfile; latestFrame?: string | null };
        setPairError(null);
        setActiveHostId(data.host.hostId);
        if (data.latestFrame) {
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
          activeWindow?: string;
          cpuUsage?: number;
          memoryUsage?: number;
        };
        if (data.frame) {
          setFramesByHost((prev) => ({ ...prev, [data.hostId]: data.frame }));
        }
        setHosts((prev) =>
          prev.map((h) =>
            h.hostId === data.hostId
              ? {
                  ...h,
                  status: 'online',
                  lastSeen: Date.now(),
                  activeWindow: data.activeWindow ?? h.activeWindow,
                  cpuUsage: data.cpuUsage ?? h.cpuUsage,
                  memoryUsage: data.memoryUsage ?? h.memoryUsage,
                }
              : h,
          ),
        );
      } else if (msg.event === 'host:status' && msg.payload) {
        const data = msg.payload as { hostId: string; status: HostProfile['status'] };
        setHosts((prev) =>
          prev.map((h) => (h.hostId === data.hostId ? { ...h, status: data.status } : h)),
        );
      }
    };

    ws.onclose = () => {
      setWsConnected(false);
      if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = window.setTimeout(connect, 2500);
    };
  }, [appendActivity]);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

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
      const res = await fetch('/api/hosts/pair-code', {
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
        setFramesByHost((prev) => ({ ...prev, [host.hostId]: data.latestFrame }));
      }
      pairHostById(host.hostId);
      return host;
    },
    [pairHostById],
  );

  const sendRemoteInput = useCallback(
    (input: RemoteInputEvent, targetHostId?: string, source: ActivityLogEntry['source'] = 'touch') => {
      const hostId = targetHostId || activeHostIdRef.current;
      if (!hostId) return false;
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
    const res = await fetch(`/api/hosts/${encodeURIComponent(hostId)}`, {
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
    const res = await fetch(`/api/hosts/${encodeURIComponent(hostId)}`, { method: 'DELETE' });
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
