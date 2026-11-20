import React, { useEffect, useState } from 'react';
import { Check, Clock, Copy, KeyRound, Plus, RefreshCw } from 'lucide-react';
import { apiFetch } from '../../lib/auth';
import { formatCountdown } from '../../lib/enrollmentCountdown';

interface EnrollmentCode {
  code: string;
  link: string;
  /** Local-clock deadline, derived from the relay's relative expiresIn. */
  deadline: number;
}

/** Mints a one-time enrollment code for the native agent and shows its link with a countdown. */
export function AddPcCard() {
  const [current, setCurrent] = useState<EnrollmentCode | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const msLeft = current ? current.deadline - now : 0;
  const expired = Boolean(current) && msLeft <= 0;

  useEffect(() => {
    if (!current || expired) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [current, expired]);

  const mint = async () => {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const res = await apiFetch('/api/agent/enroll-codes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!res.ok) throw new Error(`The relay answered ${res.status}.`);
      const data = (await res.json()) as { code: string; link: string; expiresIn: number };
      const received = Date.now();
      setNow(received);
      setCurrent({ code: data.code, link: data.link, deadline: received + data.expiresIn });
    } catch (err) {
      setError(`Could not create an enrollment code. ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const copyLink = () => {
    if (!current) return;
    navigator.clipboard
      .writeText(current.link)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1800);
      })
      .catch(() => setError('Copy failed. Select the link and copy it by hand.'));
  };

  return (
    <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 sm:p-6 space-y-4">
      <div className="flex items-center gap-2.5">
        <KeyRound className="w-5 h-5 text-blue-600 dark:text-blue-400" />
        <div>
          <h2 className="text-base font-semibold text-slate-900 dark:text-white">Add a PC (native agent)</h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            One-time link for the DeskBridge agent. No keys or files to copy around.
          </p>
        </div>
      </div>

      <ol className="space-y-1.5 text-sm text-slate-600 dark:text-slate-400 list-decimal list-inside">
        <li>Create a link here.</li>
        <li>Start the DeskBridge agent on the PC you want to add.</li>
        <li>Paste the link into the agent&apos;s window and choose Enroll.</li>
      </ol>

      {!current && (
        <button
          type="button"
          onClick={mint}
          disabled={busy}
          className="w-full min-h-[48px] px-4 py-3 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white text-sm font-semibold flex items-center justify-center gap-2 transition-colors"
        >
          <Plus className="w-4 h-4" />
          {busy ? 'Creating link...' : 'Add a PC'}
        </button>
      )}

      {current && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 p-2.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
            <input
              readOnly
              value={current.link}
              onFocus={(e) => e.currentTarget.select()}
              aria-label="Enrollment link"
              className={`flex-1 min-w-0 bg-transparent text-xs font-mono text-slate-800 dark:text-slate-300 outline-none ${
                expired ? 'line-through opacity-50' : ''
              }`}
            />
            <button
              type="button"
              onClick={copyLink}
              disabled={expired}
              className="min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg hover:bg-slate-200 dark:hover:bg-slate-800 disabled:opacity-40 text-slate-600 dark:text-slate-400"
              aria-label="Copy enrollment link"
            >
              {copied ? <Check className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
            </button>
          </div>

          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400">Code</div>
              <div
                className={`font-mono text-xl font-semibold tracking-widest text-slate-900 dark:text-white ${
                  expired ? 'line-through opacity-50' : ''
                }`}
              >
                {current.code}
              </div>
            </div>
            <div
              className={`flex items-center gap-1.5 text-sm font-medium ${
                expired ? 'text-red-600 dark:text-red-400' : 'text-slate-600 dark:text-slate-300'
              }`}
              aria-live="polite"
            >
              <Clock className="w-4 h-4" />
              {expired ? 'Expired' : `Expires in ${formatCountdown(msLeft)}`}
            </div>
          </div>

          <button
            type="button"
            onClick={mint}
            disabled={busy}
            className="w-full min-h-[44px] px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-60 text-slate-900 dark:text-white text-sm font-medium flex items-center justify-center gap-2 transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
            {busy ? 'Creating link...' : 'New link'}
          </button>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Works once and expires after 10 minutes. Typing the address instead? Enter the relay address and this code in the
            agent.
          </p>
        </div>
      )}

      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
