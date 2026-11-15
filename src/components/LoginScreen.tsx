import React, { useState } from 'react';
import { KeyRound, Loader2 } from 'lucide-react';
import { login } from '../lib/auth';

interface LoginScreenProps {
  onAuthenticated: () => void;
}

export function LoginScreen({ onAuthenticated }: LoginScreenProps) {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await login(token.trim());
      setToken('');
      onAuthenticated();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dark min-h-screen flex items-center justify-center px-4 bg-[#090d16] text-slate-100">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-2xl border border-slate-800 bg-slate-900 p-6 space-y-5"
      >
        <div className="space-y-1.5">
          <h1 className="text-xl font-bold tracking-tight text-white">DeskBridge</h1>
          <p className="text-sm text-slate-400">
            Enter the owner access token. It is printed in the server console on startup, or set via{' '}
            <code className="text-slate-300">DESKBRIDGE_ACCESS_TOKEN</code>.
          </p>
        </div>

        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-slate-400">Access token</span>
          <div className="relative">
            <KeyRound className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              type="password"
              autoComplete="current-password"
              autoFocus
              value={token}
              onChange={(e) => setToken(e.target.value)}
              className="w-full min-h-[44px] pl-9 pr-3 rounded-xl border border-slate-700 bg-slate-950 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-blue-500"
              placeholder="Paste your token"
            />
          </div>
        </label>

        {error && <p className="text-xs text-red-400">{error}</p>}

        <button
          type="submit"
          disabled={busy || !token.trim()}
          className="w-full min-h-[44px] inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-semibold transition-colors"
        >
          {busy && <Loader2 className="w-4 h-4 animate-spin" />}
          <span>Sign in</span>
        </button>
      </form>
    </div>
  );
}
