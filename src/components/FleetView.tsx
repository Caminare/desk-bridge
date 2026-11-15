import React, { useMemo, useState } from 'react';
import {
  ArrowRight,
  Check,
  Download,
  Laptop,
  Monitor,
  Pencil,
  QrCode,
  Search,
  Trash2,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import type { ActivityLogEntry, HostProfile } from '../types/deskbridge';

interface FleetViewProps {
  hosts: HostProfile[];
  activeHostId: string | null;
  framesByHost: Record<string, string>;
  activityLog: ActivityLogEntry[];
  onSelectHost: (hostId: string) => void;
  onOpenQrScanner: () => void;
  onOpenHostSetup: () => void;
  onRenameHost: (hostId: string, name: string, groupLabel: string) => Promise<void>;
  onRemoveHost: (hostId: string) => void;
}

function formatRelativeTime(ts: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 10) return 'Just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ago`;
}

export function FleetView({
  hosts,
  activeHostId,
  framesByHost,
  activityLog,
  onSelectHost,
  onOpenQrScanner,
  onOpenHostSetup,
  onRenameHost,
  onRemoveHost,
}: FleetViewProps) {
  const [groupFilter, setGroupFilter] = useState<string>('All');
  const [searchQuery, setSearchQuery] = useState('');
  const [editingHostId, setEditingHostId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editGroup, setEditGroup] = useState('');

  const groupFilters = useMemo(() => {
    const uniqueGroups = Array.from(
      new Set(hosts.map((h) => h.groupLabel).filter((g) => g && g.trim().length > 0)),
    );
    return ['All', ...uniqueGroups];
  }, [hosts]);

  const filteredHosts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return hosts.filter((host) => {
      if (groupFilter !== 'All' && host.groupLabel !== groupFilter) return false;
      if (!q) return true;
      return (
        host.name.toLowerCase().includes(q) ||
        host.groupLabel.toLowerCase().includes(q) ||
        (host.activeWindow || '').toLowerCase().includes(q) ||
        host.pairingCode.toLowerCase().includes(q)
      );
    });
  }, [hosts, groupFilter, searchQuery]);

  const onlineCount = hosts.filter((h) => h.status === 'online').length;

  const startEditing = (host: HostProfile) => {
    setEditingHostId(host.hostId);
    setEditName(host.name);
    setEditGroup(host.groupLabel);
  };

  const saveEdit = async (hostId: string) => {
    await onRenameHost(hostId, editName, editGroup);
    setEditingHostId(null);
  };

  return (
    <div className="space-y-8">
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
        <div className="space-y-1.5">
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-white text-balance">
            Workstation Fleet
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 max-w-2xl">
            Add, name, and switch between multiple Windows computers from your phone or browser.
          </p>
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400 tabular-nums pt-1">
            <span>{hosts.length} paired computers</span>
            <span aria-hidden="true">·</span>
            <span>{onlineCount} online now</span>
            <span aria-hidden="true">·</span>
            <span>WebSocket relay active</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={onOpenHostSetup}
            className="min-h-[44px] inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 text-sm font-medium transition-colors whitespace-nowrap"
          >
            <Download className="w-4 h-4" />
            <span>Set Up Windows Host</span>
          </button>
          <button
            type="button"
            onClick={onOpenQrScanner}
            className="min-h-[44px] inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold transition-colors whitespace-nowrap"
          >
            <QrCode className="w-4 h-4" />
            <span>Scan QR to Add PC</span>
          </button>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
        <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-x-auto">
          {groupFilters.map((filter) => (
            <button
              key={filter}
              type="button"
              onClick={() => setGroupFilter(filter)}
              className={`min-h-[38px] px-3 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                groupFilter === filter
                  ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              {filter}
            </button>
          ))}
        </div>

        <div className="relative sm:w-72">
          <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search computers or groups..."
            className="w-full min-h-[44px] pl-10 pr-4 py-2 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-sm text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600"
          />
        </div>
      </div>

      {filteredHosts.length === 0 ? (
        <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-8 sm:p-12 text-center space-y-5">
          <div className="w-12 h-12 rounded-xl bg-blue-600/10 text-blue-600 dark:text-blue-400 flex items-center justify-center mx-auto">
            <Laptop className="w-6 h-6" />
          </div>
          <div className="space-y-2 max-w-md mx-auto">
            <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
              {hosts.length === 0 ? 'No Windows computers paired yet' : 'No computers match this filter'}
            </h2>
            <p className="text-sm text-slate-600 dark:text-slate-400">
              {hosts.length === 0
                ? 'Run the DeskBridge Host agent on any Windows PC (or start Browser Host Mode in another tab) to generate a QR code and connect immediately.'
                : 'Try switching back to All workstations or clearing your search text.'}
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              onClick={onOpenQrScanner}
              className="min-h-[44px] inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold transition-colors"
            >
              <QrCode className="w-4 h-4" />
              <span>Scan Host QR Code</span>
            </button>
            <button
              type="button"
              onClick={onOpenHostSetup}
              className="min-h-[44px] inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 text-sm font-medium transition-colors"
            >
              <Monitor className="w-4 h-4" />
              <span>Open Windows Host App</span>
            </button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filteredHosts.map((host) => {
            const isOnline = host.status === 'online';
            const isActive = host.hostId === activeHostId;
            const preview = framesByHost[host.hostId];

            return (
              <div
                key={host.hostId}
                className={`rounded-2xl border bg-white dark:bg-slate-900 overflow-hidden transition-colors flex flex-col ${
                  isActive
                    ? 'border-blue-600 dark:border-blue-500'
                    : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'
                }`}
              >
                <div className="aspect-video w-full bg-slate-100 dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800 relative overflow-hidden">
                  {preview ? (
                    <img
                      src={preview}
                      alt={`${host.name} screen preview`}
                      referrerPolicy="no-referrer"
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-slate-400 dark:text-slate-600">
                      <Monitor className="w-8 h-8" />
                      <span className="text-xs">
                        {isOnline ? 'Stream ready on connect' : 'Host currently offline'}
                      </span>
                    </div>
                  )}
                </div>

                <div className="p-5 flex-1 flex flex-col justify-between gap-4">
                  <div className="space-y-2">
                    {editingHostId === host.hostId ? (
                      <div className="space-y-2">
                        <input
                          type="text"
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          placeholder="Computer name"
                          className="w-full min-h-[38px] px-3 py-1.5 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 text-sm text-slate-900 dark:text-white"
                        />
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            value={editGroup}
                            onChange={(e) => setEditGroup(e.target.value)}
                            placeholder="Group label"
                            className="flex-1 min-h-[38px] px-3 py-1.5 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 text-xs text-slate-900 dark:text-white"
                          />
                          <button
                            type="button"
                            onClick={() => saveEdit(host.hostId)}
                            className="min-h-[38px] min-w-[38px] flex items-center justify-center rounded-lg bg-blue-600 text-white"
                            aria-label="Save name"
                          >
                            <Check className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingHostId(null)}
                            className="min-h-[38px] min-w-[38px] flex items-center justify-center rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500"
                            aria-label="Cancel rename"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-start justify-between gap-3">
                        <h3 className="text-base font-semibold text-slate-900 dark:text-white truncate">
                          {host.name}
                        </h3>
                        <span
                          className={`inline-flex items-center gap-1.5 text-xs font-medium shrink-0 ${
                            isOnline
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : 'text-slate-500 dark:text-slate-400'
                          }`}
                        >
                          {isOnline ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
                          <span>{isOnline ? 'Online' : 'Offline'}</span>
                        </span>
                      </div>
                    )}

                    <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                      <span className="font-medium text-slate-700 dark:text-slate-300">{host.groupLabel}</span>
                      <span aria-hidden="true">·</span>
                      <span>{host.os}</span>
                      <span aria-hidden="true">·</span>
                      <span>
                        {host.screenWidth}×{host.screenHeight}
                      </span>
                    </div>

                    <div className="text-xs text-slate-600 dark:text-slate-400 truncate">
                      Window: {host.activeWindow || 'Windows Desktop'}
                    </div>
                    <div className="text-xs font-mono text-slate-500 dark:text-slate-500 tabular-nums">
                      Code {host.pairingCode} · Seen {formatRelativeTime(host.lastSeen)}
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
                    <button
                      type="button"
                      onClick={() => onSelectHost(host.hostId)}
                      className="flex-1 min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium transition-colors"
                    >
                      <span>{isActive ? 'Open Control Deck' : 'Connect & Control'}</span>
                      <ArrowRight className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => startEditing(host)}
                      className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl border border-slate-200 dark:border-slate-800 text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                      aria-label={`Rename ${host.name}`}
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onRemoveHost(host.hostId)}
                      className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl border border-slate-200 dark:border-slate-800 text-slate-500 hover:text-red-600 dark:text-slate-400 dark:hover:text-red-400 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                      aria-label={`Remove ${host.name}`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {activityLog.length > 0 && (
        <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-white">Recent Remote Actions</h2>
            <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
              {activityLog.length} events
            </span>
          </div>
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {activityLog.slice(0, 6).map((item) => {
              const hostName = hosts.find((h) => h.hostId === item.hostId)?.name || item.hostId;
              return (
                <div key={item.id} className="px-5 py-2.5 flex items-center justify-between gap-4 text-xs">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-medium text-slate-900 dark:text-slate-200 truncate">{hostName}</span>
                    <span aria-hidden="true" className="text-slate-400">·</span>
                    <span className="text-slate-600 dark:text-slate-400 truncate">{item.summary}</span>
                  </div>
                  <span className="font-mono text-slate-400 shrink-0 tabular-nums">
                    {new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
