import React, { useEffect, useState } from 'react';
import {
  Laptop,
  LogOut,
  Monitor,
  Moon,
  QrCode,
  Sun,
  Touchpad,
} from 'lucide-react';
import { useDeskBridgeSocket } from './hooks/useDeskBridgeSocket';
import { FleetView } from './components/FleetView';
import { TouchControlDeck } from './components/TouchControlDeck';
import { WindowsHostView } from './components/WindowsHostView';
import { QrScannerModal } from './components/QrScannerModal';
import { logout } from './lib/auth';

type ActiveTab = 'fleet' | 'control' | 'host';

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('fleet');
  const [qrModalOpen, setQrModalOpen] = useState(false);
  const [darkMode, setDarkMode] = useState(true);

  const {
    hosts,
    activeHost,
    activeHostId,
    framesByHost,
    frameStore,
    pairError,
    activityLog,
    pairHostById,
    pairByQrOrCode,
    sendRemoteInput,
    renameHost,
    removeHost,
    setPairError,
  } = useDeskBridgeSocket();

  useEffect(() => {
    const root = document.documentElement;
    if (darkMode) {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [darkMode]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const pairCode = params.get('pair');
    const hostId = params.get('host');
    const mode = params.get('mode');

    if (mode === 'host') {
      setActiveTab('host');
    } else if (pairCode || hostId) {
      pairByQrOrCode(pairCode ? window.location.href : hostId || '')
        .then(() => {
          setActiveTab('control');
          window.history.replaceState({}, '', window.location.pathname);
        })
        .catch(() => {});
    }
  }, [pairByQrOrCode]);

  const handleSelectHost = (hostId: string) => {
    pairHostById(hostId);
    setActiveTab('control');
  };

  const handlePairValue = async (codeOrUrl: string) => {
    await pairByQrOrCode(codeOrUrl);
    setActiveTab('control');
  };

  const navItems: Array<{ id: ActiveTab; label: string; mobileLabel: string; icon: React.ReactNode }> = [
    { id: 'fleet', label: 'Fleet', mobileLabel: 'Fleet', icon: <Laptop className="w-5 h-5" /> },
    { id: 'control', label: 'Control Deck', mobileLabel: 'Control', icon: <Touchpad className="w-5 h-5" /> },
    { id: 'host', label: 'Windows Host', mobileLabel: 'Host PC', icon: <Monitor className="w-5 h-5" /> },
  ];

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900 dark:bg-[#090d16] dark:text-slate-100">
      <header className="hidden md:flex sticky top-0 z-30 h-16 px-6 lg:px-10 items-center justify-between gap-8 bg-white/90 dark:bg-[#090d16]/90 backdrop-blur-md border-b border-slate-200 dark:border-slate-800">
        <button
          type="button"
          onClick={() => setActiveTab('fleet')}
          className="text-lg font-bold tracking-tight text-slate-900 dark:text-white whitespace-nowrap shrink-0 cursor-pointer"
        >
          DeskBridge
        </button>

        <nav className="flex items-center gap-7 text-sm font-medium">
          {navItems.map((item) => {
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`py-2 border-b-2 transition-colors whitespace-nowrap shrink-0 ${
                  active
                    ? 'border-blue-600 text-slate-900 dark:text-white'
                    : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </nav>

        <div className="flex items-center shrink-0">
          <button
            type="button"
            onClick={() => setQrModalOpen(true)}
            className="min-h-[40px] inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold transition-colors whitespace-nowrap shrink-0"
          >
            <QrCode className="w-4 h-4" />
            <span>Scan QR</span>
          </button>
        </div>
      </header>

      <header className="md:hidden sticky top-0 z-30 h-[52px] px-4 flex items-center justify-between bg-white/90 dark:bg-[#090d16]/90 backdrop-blur-md border-b border-slate-200 dark:border-slate-800">
        <button
          type="button"
          onClick={() => setActiveTab('fleet')}
          className="text-base font-bold tracking-tight text-slate-900 dark:text-white whitespace-nowrap shrink-0"
        >
          DeskBridge
        </button>

        <span className="text-sm font-semibold text-slate-700 dark:text-slate-300 truncate px-2">
          {navItems.find((n) => n.id === activeTab)?.label}
        </span>

        <button
          type="button"
          onClick={() => setQrModalOpen(true)}
          className="min-h-[40px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-blue-600 text-white text-xs font-semibold whitespace-nowrap shrink-0"
        >
          <QrCode className="w-3.5 h-3.5" />
          <span>Scan QR</span>
        </button>
      </header>

      <main className="flex-1 w-full max-w-[1440px] mx-auto px-4 sm:px-6 lg:px-10 py-6 pb-24 md:pb-10">
        {pairError && (
          <div className="mb-4 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/30 text-xs text-red-600 dark:text-red-400 flex items-center justify-between gap-3">
            <span>{pairError}</span>
            <button
              type="button"
              onClick={() => setPairError(null)}
              className="text-xs font-semibold underline shrink-0"
            >
              Dismiss
            </button>
          </div>
        )}

        {activeTab === 'fleet' && (
          <FleetView
            hosts={hosts}
            activeHostId={activeHostId}
            framesByHost={framesByHost}
            activityLog={activityLog}
            onSelectHost={handleSelectHost}
            onOpenQrScanner={() => setQrModalOpen(true)}
            onOpenHostSetup={() => setActiveTab('host')}
            onRenameHost={renameHost}
            onRemoveHost={removeHost}
          />
        )}

        {activeTab === 'control' && (
          <TouchControlDeck
            hosts={hosts}
            activeHost={activeHost}
            frameStore={frameStore}
            onSelectHost={pairHostById}
            onSendInput={sendRemoteInput}
            onOpenQrScanner={() => setQrModalOpen(true)}
            onOpenHostSetup={() => setActiveTab('host')}
          />
        )}

        {activeTab === 'host' && <WindowsHostView onConnectToHost={handleSelectHost} />}

        <footer className="mt-12 pt-6 border-t border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-4 text-xs text-slate-500 dark:text-slate-400">
          <span>DeskBridge · Multi-Workstation Remote Access</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => logout().then(() => window.location.reload())}
              className="min-h-[38px] inline-flex items-center gap-2 px-3 py-1.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>Sign out</span>
            </button>
            <button
              type="button"
              onClick={() => setDarkMode((d) => !d)}
              className="min-h-[38px] inline-flex items-center gap-2 px-3 py-1.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
            >
              {darkMode ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
              <span>{darkMode ? 'Light Theme' : 'Dark Theme'}</span>
            </button>
          </div>
        </footer>
      </main>

      <nav
        className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-white/95 dark:bg-[#090d16]/95 backdrop-blur-md border-t border-slate-200 dark:border-slate-800 grid grid-cols-3 h-16 pb-safe"
        aria-label="Mobile navigation"
      >
        {navItems.map((item) => {
          const active = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setActiveTab(item.id)}
              className={`flex flex-col items-center justify-center gap-0.5 transition-colors ${
                active
                  ? 'text-blue-600 dark:text-blue-400'
                  : 'text-slate-500 dark:text-slate-400'
              }`}
            >
              {item.icon}
              <span className="text-[11px] font-medium tracking-tight">{item.mobileLabel}</span>
            </button>
          );
        })}
      </nav>

      <QrScannerModal
        open={qrModalOpen}
        onClose={() => setQrModalOpen(false)}
        onPairValue={handlePairValue}
      />
    </div>
  );
}
