import React from 'react';
import type { HostProfile } from '../../types/deskbridge';

interface MonitorPickerProps {
  host: HostProfile;
  onSelect: (index: number) => void;
  className: string;
}

/** Lets the user pick which display a multi-monitor host streams. Hidden for single-monitor hosts. */
export function MonitorPicker({ host, onSelect, className }: MonitorPickerProps) {
  const monitors = host.monitors ?? [];
  if (monitors.length < 2) return null;
  const active = host.activeMonitor ?? monitors.find((m) => m.primary)?.index ?? monitors[0].index;
  return (
    <select
      value={active}
      onChange={(e) => onSelect(Number(e.target.value))}
      aria-label="Monitor"
      className={className}
    >
      {monitors.map((m, i) => (
        <option key={m.index} value={m.index}>
          {`Display ${i + 1}${m.primary ? ' (main)' : ''} · ${m.width}×${m.height}`}
        </option>
      ))}
    </select>
  );
}
