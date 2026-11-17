import type { StreamStats } from './frameCompositor';

export type StatsRow = [label: string, value: string];

export function fmt(n: number | undefined, unit = '', digits = 0): string {
  return n === undefined || !Number.isFinite(n) ? '–' : `${n.toFixed(digits)}${unit}`;
}

const SCALE_LABELS: Record<string, string> = {
  ht: 'halftone',
  coc: 'coarse',
  bil: 'bilinear',
  nn: 'nearest',
  none: '1:1',
};

const KEY_REASON_LABELS: Record<string, string> = {
  req: 'requested',
  init: 'start',
  big: '>50%',
};

/**
 * Rows for the stats panel. `detailed` adds the agent diagnostics (capture-thread rates, scaling,
 * mailbox and send timing) that explain a gap between capture speed and sent FPS.
 */
export function buildStatsRows(stats: StreamStats, detailed: boolean): StatsRow[] {
  const a = stats.agent;
  const rows: StatsRow[] = [
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
    if (detailed) {
      const perSec = (n: number | undefined) => fmt(n, '/s', 1);
      rows.push(
        ['Scaling', a.sm ? (SCALE_LABELS[a.sm] ?? a.sm) : '–'],
        ['Cap smooth', fmt(a.caps, ' ms', 1)],
        ['Cap coarse', fmt(a.capc, ' ms', 1)],
        ['Diff', fmt(a.dif, ' ms', 1)],
        ['Cycle', fmt(a.tick, ' ms', 1)],
        ['Captures', perSec(a.cfps)],
        ['Produced', perSec(a.pfps)],
        ['Unchanged', perSec(a.same)],
        ['Dropped', perSec(a.drop)],
        ['Re-diffs', perSec(a.rd)],
        ['Keyframes', `${perSec(a.kf)}${a.kr ? ` (${KEY_REASON_LABELS[a.kr] ?? a.kr})` : ''}`],
        ['Key reqs', perSec(a.kreq)],
        ['Mailbox', fmt(a.age, ' ms')],
        ['Send', fmt(a.snd, ' ms')],
        ['Agent loop', fmt(a.lps, '/s')],
      );
    }
  }
  if (stats.queued > 1) rows.push(['Pending', String(stats.queued)]);
  if (stats.skipped) rows.push(['Resyncs', String(stats.skipped)]);
  return rows;
}
