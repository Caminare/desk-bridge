import React from 'react';
import {
  Activity,
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  Keyboard,
  Minimize2,
  MousePointerClick,
  Touchpad,
} from 'lucide-react';
import type { HostProfile } from '../../types/deskbridge';
import { MonitorPicker } from './MonitorPicker';
import { ZoomControls } from './ZoomControls';
import { QUALITY_OPTIONS, type StreamQualityPreset } from './qualityPresets';

export type InputMode = 'trackpad' | 'direct';

interface FullscreenHudProps {
  host: HostProfile;
  hosts: HostProfile[];
  hidden: boolean;
  inputMode: InputMode;
  showTrackpad: boolean;
  streamQuality: StreamQualityPreset;
  zoom: number;
  keyboardOpen: boolean;
  /** Rendered above the toolbar when the trackpad panel is toggled on. */
  trackpadPanel: React.ReactNode;
  onSelectHost: (hostId: string) => void;
  onToggleInputMode: () => void;
  onToggleTrackpad: () => void;
  onClick: (button: 'left' | 'right') => void;
  onScroll: (deltaY: number) => void;
  onQualityChange: (preset: StreamQualityPreset) => void;
  onSelectMonitor: (index: number) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onResetZoom: () => void;
  statsOpen: boolean;
  onToggleStats: () => void;
  onToggleKeyboard: () => void;
  onHide: () => void;
  onShow: () => void;
  onExit: () => void;
}

/** Bottom floating toolbar over the fullscreen stream; keeps the remote title bar clear. */
export function FullscreenHud(props: FullscreenHudProps) {
  const {
    host,
    hosts,
    hidden,
    inputMode,
    showTrackpad,
    streamQuality,
    zoom,
    keyboardOpen,
    trackpadPanel,
  } = props;

  if (hidden) {
    return (
      <div className="fixed bottom-3 left-3 z-[10000] flex items-center gap-1.5 pb-safe">
        <button
          type="button"
          onClick={props.onShow}
          className="min-h-[40px] px-3 rounded-full bg-slate-950/75 border border-slate-700 text-xs font-medium text-white backdrop-blur-md inline-flex items-center gap-1.5"
        >
          <Eye className="w-3.5 h-3.5" />
          <span>Controls</span>
        </button>
        <button
          type="button"
          onClick={props.onExit}
          className="min-h-[40px] min-w-[40px] rounded-full bg-slate-950/75 border border-slate-700 text-white backdrop-blur-md flex items-center justify-center"
          aria-label="Exit full screen"
        >
          <Minimize2 className="w-4 h-4" />
        </button>
      </div>
    );
  }

  const smallButton = 'min-h-[36px] px-2 rounded-xl bg-slate-800/90 text-xs font-medium text-white shrink-0';
  const iconButton = 'min-h-[36px] min-w-[34px] rounded-xl bg-slate-800/90 text-slate-200 flex items-center justify-center shrink-0';
  const toggleButton = (active: boolean) =>
    `min-h-[36px] min-w-[36px] flex items-center justify-center rounded-xl shrink-0 ${
      active ? 'bg-blue-600 text-white' : 'bg-slate-800/90 text-slate-200'
    }`;

  return (
    <div className="absolute bottom-2 left-2 right-2 z-10 pointer-events-none flex flex-col items-center gap-2 pb-safe">
      {inputMode === 'trackpad' && showTrackpad && (
        <div className="pointer-events-auto w-full max-w-md rounded-2xl overflow-hidden border border-slate-700/70 shadow-2xl">
          {trackpadPanel}
        </div>
      )}

      <div className="pointer-events-auto max-w-full px-2.5 py-1.5 rounded-2xl bg-slate-950/80 backdrop-blur-md border border-slate-700/70 flex items-center gap-1.5 overflow-x-auto shadow-lg">
        <span className="text-xs font-semibold text-white truncate max-w-[96px] sm:max-w-[160px] pl-1">{host.name}</span>

        {hosts.length > 1 && (
          <select
            value={host.hostId}
            onChange={(e) => props.onSelectHost(e.target.value)}
            aria-label="Switch computer"
            className="min-h-[34px] px-2 py-0.5 rounded-lg bg-slate-900 border border-slate-700 text-xs text-slate-200"
          >
            {hosts.map((h) => (
              <option key={h.hostId} value={h.hostId}>
                {h.groupLabel} · {h.name}
              </option>
            ))}
          </select>
        )}

        <button
          type="button"
          onClick={props.onToggleInputMode}
          className="min-h-[36px] inline-flex items-center gap-1 px-2.5 rounded-xl bg-slate-800/90 text-xs font-medium text-white shrink-0"
        >
          {inputMode === 'trackpad' ? (
            <>
              <Touchpad className="w-3.5 h-3.5 text-blue-400" />
              <span>Drag Mouse</span>
            </>
          ) : (
            <>
              <MousePointerClick className="w-3.5 h-3.5 text-blue-400" />
              <span>Tap Screen</span>
            </>
          )}
        </button>

        {inputMode === 'trackpad' && !showTrackpad && (
          <>
            <button type="button" onClick={() => props.onClick('left')} className={smallButton}>
              L
            </button>
            <button type="button" onClick={() => props.onClick('right')} className={smallButton}>
              R
            </button>
            <button type="button" onClick={() => props.onScroll(-5)} className={iconButton} aria-label="Scroll up">
              <ChevronUp className="w-4 h-4" />
            </button>
            <button type="button" onClick={() => props.onScroll(5)} className={iconButton} aria-label="Scroll down">
              <ChevronDown className="w-4 h-4" />
            </button>
          </>
        )}

        {inputMode === 'trackpad' && (
          <button
            type="button"
            onClick={props.onToggleTrackpad}
            className={`min-h-[36px] px-2.5 rounded-xl text-xs font-medium shrink-0 ${
              showTrackpad ? 'bg-blue-600 text-white' : 'bg-slate-800/90 text-slate-300'
            }`}
          >
            {showTrackpad ? 'Hide Pad' : 'Pad'}
          </button>
        )}

        <MonitorPicker
          host={host}
          onSelect={props.onSelectMonitor}
          className="min-h-[36px] px-2 rounded-xl bg-slate-800/90 border border-slate-700 text-xs font-medium text-slate-200 shrink-0"
        />

        <select
          value={streamQuality}
          onChange={(e) => props.onQualityChange(e.target.value as StreamQualityPreset)}
          aria-label="Stream quality"
          className="min-h-[36px] px-2 rounded-xl bg-slate-800/90 border border-slate-700 text-xs font-medium text-slate-200 shrink-0"
        >
          {QUALITY_OPTIONS.map(([value, preset]) => (
            <option key={value} value={value}>
              {preset.label}
            </option>
          ))}
        </select>

        <ZoomControls
          zoom={zoom}
          onZoomIn={props.onZoomIn}
          onZoomOut={props.onZoomOut}
          onReset={props.onResetZoom}
          variant="hud"
        />

        <button
          type="button"
          onClick={props.onToggleStats}
          className={toggleButton(props.statsOpen)}
          aria-label={props.statsOpen ? 'Hide stream stats' : 'Show stream stats'}
        >
          <Activity className="w-4 h-4" />
        </button>

        <button
          type="button"
          onClick={props.onToggleKeyboard}
          className={toggleButton(keyboardOpen)}
          aria-label="Toggle keyboard"
        >
          <Keyboard className="w-4 h-4" />
        </button>

        <button
          type="button"
          onClick={props.onHide}
          className="min-h-[36px] min-w-[36px] flex items-center justify-center rounded-xl bg-slate-800/90 text-slate-300 shrink-0"
          aria-label="Hide controls"
        >
          <EyeOff className="w-4 h-4" />
        </button>

        <button
          type="button"
          onClick={props.onExit}
          className="min-h-[36px] inline-flex items-center gap-1 px-2.5 rounded-xl bg-red-600/90 hover:bg-red-600 text-xs font-semibold text-white shrink-0"
          aria-label="Exit full screen"
        >
          <Minimize2 className="w-3.5 h-3.5" />
          <span>Exit</span>
        </button>
      </div>
    </div>
  );
}
