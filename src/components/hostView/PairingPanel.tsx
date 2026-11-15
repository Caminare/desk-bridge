import React from 'react';
import { QrCode, RefreshCw } from 'lucide-react';

interface PairingPanelProps {
  qrDataUrl: string;
  pairingCode: string;
  pairingUrl: string;
  lastCommand: string;
  onRegenerate: () => void;
  onControl: () => void;
}

/** QR code, pairing code and quick actions shown while Browser Host Mode is running. */
export function PairingPanel({ qrDataUrl, pairingCode, pairingUrl, lastCommand, onRegenerate, onControl }: PairingPanelProps) {
  return (
        <div className="flex flex-col sm:flex-row items-center gap-5 p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
          <div className="w-36 h-36 rounded-xl bg-white p-2 shrink-0 flex items-center justify-center border border-slate-200">
            {qrDataUrl ? (
              <img
                src={qrDataUrl}
                alt="DeskBridge Host Pairing QR Code"
                className="w-full h-full object-contain"
              />
            ) : (
              <QrCode className="w-10 h-10 text-slate-400" />
            )}
          </div>

          <div className="flex-1 space-y-2.5 text-center sm:text-left min-w-0">
            <div className="text-xs text-slate-500 dark:text-slate-400">
              Scan with DeskBridge Mobile or enter pairing code
            </div>
            <div className="flex items-center justify-center sm:justify-start gap-2.5">
              <span className="text-2xl font-mono font-bold tracking-widest text-slate-900 dark:text-white tabular-nums">
                {pairingCode}
              </span>
              <button
                type="button"
                onClick={onRegenerate}
                className="min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                aria-label="Regenerate pairing code"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400 truncate">
              Last event: {lastCommand}
            </div>
            <div className="flex flex-wrap items-center justify-center sm:justify-start gap-2 pt-1">
              <button
                type="button"
                onClick={onControl}
                className="min-h-[40px] px-3.5 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold transition-colors"
              >
                Control This Host Now
              </button>
              {pairingUrl && (
                <button
                  type="button"
                  onClick={() => navigator.clipboard.writeText(pairingUrl)}
                  className="min-h-[40px] px-3.5 py-2 rounded-xl border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  Copy Pair Link
                </button>
              )}
            </div>
          </div>
        </div>
  );
}
