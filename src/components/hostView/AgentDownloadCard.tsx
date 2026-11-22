import React from 'react';
import { Download, ExternalLink, Terminal } from 'lucide-react';

const RELEASES_URL = 'https://github.com/Caminare/desk-bridge/releases';
// The asset name carries no version, so this always resolves to the newest non-prerelease agent.
const AGENT_DOWNLOAD_URL = `${RELEASES_URL}/latest/download/deskbridge-agent-win-x64.zip`;

/** Download link for the native Windows agent, published as a GitHub release asset by CI. */
export function AgentDownloadCard() {
  return (
    <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 sm:p-6 space-y-4">
      <div className="flex items-center gap-2.5">
        <Terminal className="w-5 h-5 text-blue-600 dark:text-blue-400" />
        <div>
          <h2 className="text-base font-semibold text-slate-900 dark:text-white">DeskBridge agent for Windows</h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Windows 10 or 11 (64-bit). No installer, no admin rights.
          </p>
        </div>
      </div>

      <ol className="space-y-1.5 text-sm text-slate-600 dark:text-slate-400 list-decimal list-inside">
        <li>Download the zip on the PC you want to control and extract it to a folder you keep, such as Documents.</li>
        <li>
          Run <code className="font-mono text-xs text-slate-900 dark:text-slate-200">DeskBridge.Agent.exe</code>. The app
          isn&apos;t code-signed yet, so Windows may show &ldquo;Windows protected your PC&rdquo;: choose More info, then Run
          anyway.
        </li>
        <li>Paste a link from Add a PC into the window that opens.</li>
      </ol>

      <a
        href={AGENT_DOWNLOAD_URL}
        className="w-full min-h-[48px] px-4 py-3 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold flex items-center justify-between transition-colors"
      >
        <span>Download agent (zip, about 55 MB)</span>
        <Download className="w-4 h-4" />
      </a>

      <p className="text-xs text-slate-500 dark:text-slate-400">
        The agent then runs in the notification area. Its menu turns on Start with Windows and Keep PC awake.{' '}
        <a
          href={RELEASES_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-blue-600 dark:text-blue-400 hover:underline"
        >
          Release notes
          <ExternalLink className="w-3 h-3" />
        </a>
      </p>
    </div>
  );
}
