import React from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { HostProfile, RemoteInputEvent } from '../../types/deskbridge';
import { AIAssistantPanel } from '../AIAssistantPanel';

interface MobileAIDrawerProps {
  host: HostProfile;
  hosts: HostProfile[];
  frame: string | null;
  getScreenshot?: () => string | undefined;
  onDispatchInput: (input: RemoteInputEvent, hostId?: string) => void;
  onSwitchHost: (hostId: string) => void;
  onClose: () => void;
}

/** Bottom sheet with the AI assistant for small screens. */
export function MobileAIDrawer({ host, hosts, frame, getScreenshot, onDispatchInput, onSwitchHost, onClose }: MobileAIDrawerProps) {
  return createPortal(
    <div className="fixed inset-0 z-[10001] lg:hidden flex items-end bg-black/60 backdrop-blur-sm" role="dialog" aria-modal="true">
      <div className="w-full rounded-t-3xl bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-800">
          <span className="text-sm font-semibold text-slate-900 dark:text-white">AI Voice & Command Drawer</span>
          <button
            type="button"
            onClick={onClose}
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl text-slate-500"
            aria-label="Close AI drawer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-3">
          <AIAssistantPanel
            compact
            activeHost={host}
            hosts={hosts}
            activeFrame={frame}
            getScreenshot={getScreenshot}
            onDispatchInput={onDispatchInput}
            onSwitchHost={onSwitchHost}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}
