import React, { useEffect, useState } from 'react';
import type { FrameStore, StreamStats } from '../../lib/frameCompositor';

interface StreamStatsOverlayProps {
  store: FrameStore;
  hostId: string;
}

function fmt(n: number | undefined, unit = '', digits = 0): string {
  return n === undefined || !Number.isFinite(n) ? '–' : `${n.toFixed(digits)}${unit}`;
}

/** Live pipeline numbers: what the phone receives and what the agent reports. */
export function StreamStatsOverlay({ store, hostId }: StreamStatsOverlayProps) {
  const [stats, setStats] = useState<StreamStats>(() => store.get(hostId).stats());

  useEffect(() => {
    const compositor = store.get(hostId);
    setStats(compositor.stats());
    const t = window.setInterval(() => setStats(compositor.stats()), 500);
    return () => window.clearInterval(t);
  }, [store, hostId]);

  const a = stats.agent;
  const rows: Array<[string, string]> = [
    ['FPS', fmt(stats.fps)],
    ['Down', fmt(stats.kbpsIn / 1000, ' Mbps', 2)],
    ['Decode', fmt(stats.decodeMs, ' ms', 1)],
    ['Size', stats.width ? `${stats.width}×${stats.height}` : '–'],
  ];
  if (a) {
    rows.push(
      ['Agent FPS', fmt(a.sfps, '', 1)],
      ['RTT', fmt(a.rtt, ' ms')],
      ['Queue', a.rtt !== undefined && a.brtt !== undefined ? fmt(Math.max(0, a.rtt - a.brtt), ' ms') : '–'],
      ['Window', fmt(a.win, ' KB')],
      ['Up', fmt(a.kbps !== undefined ? a.kbps / 1000 : undefined, ' Mbps', 2)],
      ['Capture', `${fmt(a.cap, ' ms', 1)}${a.cm ? ` (${a.cm})` : ''}`],
      ['Encode', fmt(a.enc, ' ms', 1)],
      ['Quality', a.q !== undefined ? `${a.q} @ ${a.mw}px` : '–'],
      ['Changed', a.tt ? `${a.ch}/${a.tt} tiles` : '–'],
    );
  }
  if (stats.queued > 1) rows.push(['Queue', String(stats.queued)]);
  if (stats.skipped) rows.push(['Resyncs', String(stats.skipped)]);

  return (
    <div
      className="pointer-events-none absolute top-2 left-2 z-20 rounded-lg bg-black/70 px-2.5 py-1.5 font-mono text-[11px] leading-4 text-slate-100 backdrop-blur-sm"
      aria-live="off"
    >
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-3">
          <span className="text-slate-400">{k}</span>
          <span className="tabular-nums">{v}</span>
        </div>
      ))}
    </div>
  );
}
