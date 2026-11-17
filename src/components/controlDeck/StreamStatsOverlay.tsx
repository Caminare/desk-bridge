import React, { useEffect, useState } from 'react';
import type { FrameStore, StreamStats } from '../../lib/frameCompositor';
import { buildStatsRows } from '../../lib/streamStatsRows';

interface StreamStatsOverlayProps {
  store: FrameStore;
  hostId: string;
  /** `overlay`: floating over the stream (fullscreen). `strip`: compact grid below the stream. */
  variant?: 'overlay' | 'strip';
  containerRef?: React.Ref<HTMLDivElement>;
}

/**
 * Live pipeline numbers: what the phone receives and what the agent reports. The strip also
 * shows the agent diagnostics; the fullscreen overlay keeps to the basics so it stays small.
 */
export function StreamStatsOverlay({ store, hostId, variant = 'overlay', containerRef }: StreamStatsOverlayProps) {
  const [stats, setStats] = useState<StreamStats>(() => store.get(hostId).stats());

  useEffect(() => {
    const compositor = store.get(hostId);
    setStats(compositor.stats());
    const t = window.setInterval(() => setStats(compositor.stats()), 500);
    return () => window.clearInterval(t);
  }, [store, hostId]);

  const rows = buildStatsRows(stats, variant === 'strip');

  if (variant === 'strip') {
    return (
      <div
        ref={containerRef}
        className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-x-3 gap-y-0.5 px-3 py-2 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 font-mono text-[11px] leading-4 text-slate-700 dark:text-slate-200"
        aria-live="off"
        aria-label="Stream stats"
      >
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-2 min-w-0">
            <span className="text-slate-500 dark:text-slate-400 truncate">{k}</span>
            <span className="tabular-nums truncate">{v}</span>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="pointer-events-none absolute top-2 left-2 z-20 rounded-lg bg-black/70 px-2.5 py-1.5 font-mono text-[11px] leading-4 text-slate-100 backdrop-blur-sm"
      aria-live="off"
      aria-label="Stream stats"
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
