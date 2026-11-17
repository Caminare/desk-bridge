import React, { useState } from 'react';
import { Check, Copy, Download, ShieldAlert, Terminal } from 'lucide-react';

interface AgentDownloadCardProps {
  hostName: string;
  groupLabel: string;
}

const QUICK_PS_COMMAND = `powershell -ExecutionPolicy Bypass -File .\\DeskBridge-Host.ps1`;

/** Download links for the native PowerShell agent, its launcher and the Node agent. */
export function AgentDownloadCard({ hostName, groupLabel }: AgentDownloadCardProps) {
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [keepAwake, setKeepAwake] = useState(false);
  const downloadBaseParams = `name=${encodeURIComponent(hostName)}&group=${encodeURIComponent(groupLabel)}${
    keepAwake ? '&keepAwake=1' : ''
  }`;
  const quickPsCommand = QUICK_PS_COMMAND;

  const handleCopyCommand = () => {
    navigator.clipboard.writeText(quickPsCommand).catch(() => {});
    setCopiedCmd(true);
    window.setTimeout(() => setCopiedCmd(false), 1800);
  };

  return (
      <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 sm:p-6 space-y-5">
        <div className="flex items-center gap-2.5">
          <Terminal className="w-5 h-5 text-blue-600 dark:text-blue-400" />
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-white">
              Native Windows 10/11 Host App
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Install on as many Windows PCs as you need with zero external dependencies
            </p>
          </div>
        </div>

        <div className="space-y-2.5 text-sm text-slate-600 dark:text-slate-400">
          <p>
            1. Enter a custom Computer Name and Group label above, then download both files into the same folder on that Windows computer.
          </p>
          <p>
            2. Double-click <code className="font-mono text-xs text-slate-900 dark:text-slate-200">Start-DeskBridge.bat</code>. It connects over WebSockets, prints a 6-character pairing code, and streams your desktop with real Win32 mouse &amp; keyboard control.
          </p>
          <p>
            3. Repeat on any number of Windows computers and scan or enter their pairing codes on your Android phone to switch between them anytime.
          </p>
        </div>

        <label className="flex items-start gap-3 p-3 rounded-xl border border-slate-200 dark:border-slate-800 cursor-pointer">
        <input
          type="checkbox"
          checked={keepAwake}
          onChange={(e) => setKeepAwake(e.target.checked)}
          className="mt-0.5 w-4 h-4 rounded border-slate-300 dark:border-slate-700 text-blue-600 shrink-0"
        />
        <span className="text-xs text-slate-600 dark:text-slate-400">
          <span className="block text-sm font-medium text-slate-900 dark:text-white">Keep this PC awake while a phone is connected</span>
          Prevents sleep, screen-off and idle lock during a session. A locked PC can&apos;t be unlocked remotely, because Windows
          doesn&apos;t let remote apps type the PIN. Only enable this on PCs in a safe place. Applies to the PowerShell agent;
          download it again after changing this.
        </span>
      </label>

      <div className="space-y-2.5 pt-2">
          <a
            href={`/api/host-agent/download?format=ps1&${downloadBaseParams}`}
            download="DeskBridge-Host.ps1"
            className="w-full min-h-[48px] px-4 py-3 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold flex items-center justify-between transition-colors"
          >
            <span>Download DeskBridge-Host.ps1</span>
            <Download className="w-4 h-4" />
          </a>

          <a
            href={`/api/host-agent/download?format=bat&${downloadBaseParams}`}
            download="Start-DeskBridge.bat"
            className="w-full min-h-[48px] px-4 py-3 rounded-xl border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-900 dark:text-white text-sm font-medium flex items-center justify-between transition-colors"
          >
            <span>Download Start-DeskBridge.bat</span>
            <Download className="w-4 h-4" />
          </a>

          <a
            href={`/api/host-agent/download?format=mjs&${downloadBaseParams}`}
            download="deskbridge-host.mjs"
            className="w-full min-h-[44px] px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 text-xs font-medium flex items-center justify-between transition-colors"
          >
            <span>Alternative: Node.js Host Script (deskbridge-host.mjs)</span>
            <Download className="w-4 h-4" />
          </a>
        </div>

  
      <p className="flex items-start gap-2 p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-700 dark:text-amber-400">
        <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
        <span>
          These scripts contain your relay&apos;s enrollment key. Anyone who has them can add a machine to your relay,
          so don&apos;t share or commit them.
        </span>
      </p>

      <div className="pt-3 border-t border-slate-200 dark:border-slate-800 space-y-2">
          <div className="text-xs font-medium text-slate-700 dark:text-slate-300">
            PowerShell Launch Command
          </div>
          <div className="flex items-center gap-2 p-2.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
            <code className="flex-1 text-xs font-mono text-slate-800 dark:text-slate-300 truncate">
              {quickPsCommand}
            </code>
            <button
              type="button"
              onClick={handleCopyCommand}
              className="min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-400"
              aria-label="Copy PowerShell command"
            >
              {copiedCmd ? <Check className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </div>
  );
}
