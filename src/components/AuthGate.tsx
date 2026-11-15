import React, { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { fetchSession, onUnauthorized } from '../lib/auth';
import { LoginScreen } from './LoginScreen';

type AuthState = 'checking' | 'authenticated' | 'anonymous';

/** Renders the app only for a logged-in owner. Query params (e.g. ?pair=) survive login. */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>('checking');

  useEffect(() => {
    let cancelled = false;
    fetchSession().then((ok) => {
      if (!cancelled) setState(ok ? 'authenticated' : 'anonymous');
    });
    const off = onUnauthorized(() => setState('anonymous'));
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  if (state === 'checking') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#090d16] text-slate-400">
        <Loader2 className="w-6 h-6 animate-spin" />
      </div>
    );
  }

  if (state === 'anonymous') {
    return <LoginScreen onAuthenticated={() => setState('authenticated')} />;
  }

  return <>{children}</>;
}
