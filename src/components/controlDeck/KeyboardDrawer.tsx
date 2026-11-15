import React from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Send, X } from 'lucide-react';

interface KeyboardDrawerProps {
  /** Compact dark variant used over the fullscreen stream. */
  compact?: boolean;
  /** Whether the drawer is currently shown (compact variant stays mounted while hidden). */
  visible: boolean;
  value: string;
  liveTyping: boolean;
  inputRef?: React.Ref<HTMLInputElement>;
  onChange: (value: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onFocus: () => void;
  onBlur: () => void;
  onClose?: () => void;
  onLiveTypingChange: (live: boolean) => void;
  onSendKey: (key: string) => void;
  onSendText: (text: string) => void;
}

const SPECIAL_KEYS = ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete'] as const;
const ARROW_KEYS = [
  { key: 'ArrowLeft', label: 'Left arrow', Icon: ArrowLeft },
  { key: 'ArrowUp', label: 'Up arrow', Icon: ArrowUp },
  { key: 'ArrowDown', label: 'Down arrow', Icon: ArrowDown },
  { key: 'ArrowRight', label: 'Right arrow', Icon: ArrowRight },
] as const;

export function KeyboardDrawer({
  compact = false,
  visible,
  value,
  liveTyping,
  inputRef,
  onChange,
  onSubmit,
  onKeyDown,
  onFocus,
  onBlur,
  onClose,
  onLiveTypingChange,
  onSendKey,
  onSendText,
}: KeyboardDrawerProps) {
  const keyTone = compact
    ? 'border-slate-700 bg-slate-950 text-slate-200'
    : 'border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-950 text-slate-800 dark:text-slate-200';
  const textKeyClass = `min-h-[38px] px-2.5 py-1 rounded-lg border text-xs font-mono hover:border-blue-500 ${keyTone}`;
  const iconKeyClass = `min-h-[38px] min-w-[38px] flex items-center justify-center rounded-lg border ${keyTone}`;

  return (
    <div
      className={`rounded-2xl border border-slate-200 dark:border-slate-800 ${
        compact ? 'bg-slate-900/95 backdrop-blur-md p-3 shadow-2xl border-slate-700/80' : 'bg-white dark:bg-slate-900 p-4'
      } space-y-2.5`}
    >
      <form onSubmit={onSubmit} className="flex items-center gap-2">
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={onFocus}
          onBlur={onBlur}
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="send"
          tabIndex={compact && !visible ? -1 : 0}
          placeholder={liveTyping ? 'Type live keystrokes to Windows...' : 'Type text to send to Windows...'}
          className={`flex-1 min-h-[44px] px-3.5 py-2 rounded-xl border text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 ${
            compact
              ? 'bg-slate-950 border-slate-700 text-white'
              : 'bg-slate-50 dark:bg-slate-950 border-slate-200 dark:border-slate-800 text-slate-900 dark:text-white'
          }`}
        />
        <button
          type="submit"
          className="min-h-[44px] px-4 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold inline-flex items-center gap-1.5 shrink-0"
        >
          <Send className="w-3.5 h-3.5" />
          <span>{liveTyping ? 'Enter' : 'Send'}</span>
        </button>
        {compact && onClose && (
          <button
            type="button"
            onClick={onClose}
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl bg-slate-800 text-slate-300 hover:text-white shrink-0"
            aria-label="Close keyboard"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </form>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {SPECIAL_KEYS.map((keyName) => (
            <button key={keyName} type="button" onClick={() => onSendKey(keyName)} className={textKeyClass}>
              {keyName === 'Escape' ? 'Esc' : keyName}
            </button>
          ))}
          <button type="button" onClick={() => onSendText(' ')} className={textKeyClass}>
            Space
          </button>
          {ARROW_KEYS.map(({ key, label, Icon }) => (
            <button key={key} type="button" onClick={() => onSendKey(key)} className={iconKeyClass} aria-label={label}>
              <Icon className="w-4 h-4" />
            </button>
          ))}
        </div>

        <label className="inline-flex items-center gap-2 text-xs text-slate-400 cursor-pointer">
          <input
            type="checkbox"
            checked={liveTyping}
            onChange={(e) => onLiveTypingChange(e.target.checked)}
            className="rounded border-slate-300 dark:border-slate-700 text-blue-600"
          />
          <span>Live keystrokes</span>
        </label>
      </div>
    </div>
  );
}
