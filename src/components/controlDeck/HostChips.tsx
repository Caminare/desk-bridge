import React from 'react';
import { Wifi, WifiOff } from 'lucide-react';
import type { HostProfile } from '../../types/deskbridge';

interface HostChipsProps {
  hosts: HostProfile[];
  activeHostId: string;
  onSelectHost: (hostId: string) => void;
}

/** Horizontal one-tap switcher between paired computers. */
export function HostChips({ hosts, activeHostId, onSelectHost }: HostChipsProps) {
  if (hosts.length === 0) return null;
  return (
    <div className="flex items-center gap-2 overflow-x-auto pb-1">
      {hosts.map((host) => {
        const selected = host.hostId === activeHostId;
        return (
          <button
            key={host.hostId}
            type="button"
            onClick={() => onSelectHost(host.hostId)}
            className={`min-h-[40px] inline-flex items-center gap-2 px-3.5 py-2 rounded-xl border text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
              selected
                ? 'bg-blue-600 border-blue-600 text-white'
                : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300 hover:border-slate-300 dark:hover:border-slate-700'
            }`}
          >
            {host.status === 'online' ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
            <span>{host.groupLabel}</span>
            <span aria-hidden="true">·</span>
            <span className="max-w-[140px] truncate">{host.name}</span>
          </button>
        );
      })}
    </div>
  );
}
