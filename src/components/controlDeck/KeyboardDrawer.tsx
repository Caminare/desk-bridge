import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  Command,
  Loader2,
  Mic,
  MicOff,
  Send,
  X,
} from 'lucide-react';
import { apiFetch } from '../../lib/auth';
import { appendDictationToBuffer, formatLiveDictationText } from '../../lib/dictation';
import type { TranscribeResponse } from '../../types/deskbridge';

export type KeyModifier = 'ctrl' | 'alt' | 'shift' | 'win';

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
  /** Sticky modifiers applied to the next key or typed character. */
  modifiers: KeyModifier[];
  onToggleModifier: (modifier: KeyModifier) => void;
  /** Sends an arbitrary combo such as "Ctrl+Shift+T". */
  onSendCombo: (combo: string) => void;
}

const MODIFIERS: Array<{ id: KeyModifier; label: string }> = [
  { id: 'ctrl', label: 'Ctrl' },
  { id: 'alt', label: 'Alt' },
  { id: 'shift', label: 'Shift' },
  { id: 'win', label: 'Win' },
];
const EXTRA_KEYS = [
  ...Array.from({ length: 12 }, (_, i) => ({ key: `F${i + 1}`, label: `F${i + 1}` })),
  { key: 'Home', label: 'Home' },
  { key: 'End', label: 'End' },
  { key: 'PageUp', label: 'PgUp' },
  { key: 'PageDown', label: 'PgDn' },
  { key: 'Insert', label: 'Ins' },
  { key: 'PrintScreen', label: 'PrtSc' },
];
const COMBO_PATTERN = /^\s*((ctrl|control|alt|shift|win|meta|cmd)\s*\+\s*)*[^+\s]+\s*$/i;
const MAX_RECORD_SECONDS = 60;
const MIN_AUDIO_BYTES = 400;

type DictationNotice = {
  kind: 'error' | 'warning' | 'info';
  text: string;
};

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
  modifiers,
  onToggleModifier,
  onSendCombo,
}: KeyboardDrawerProps) {
  const [showMore, setShowMore] = useState(false);
  const [combo, setCombo] = useState('');
  const comboValid = COMBO_PATTERN.test(combo);
  const [transcriptionReady, setTranscriptionReady] = useState<boolean | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [dictationNotice, setDictationNotice] = useState<DictationNotice | null>(null);

  const localInputRef = useRef<HTMLInputElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const lastLiveDictatedRef = useRef(false);
  const unmountedRef = useRef(false);

  const latestRef = useRef({ value, liveTyping, onChange, onSendText });
  latestRef.current = { value, liveTyping, onChange, onSendText };

  const setInputRef = useCallback(
    (el: HTMLInputElement | null) => {
      localInputRef.current = el;
      if (typeof inputRef === 'function') {
        inputRef(el);
      } else if (inputRef && 'current' in inputRef) {
        (inputRef as React.MutableRefObject<HTMLInputElement | null>).current = el;
      }
    },
    [inputRef],
  );

  useEffect(() => {
    let active = true;
    apiFetch('/api/health')
      .then((r) => r.json())
      .then((d: { transcriptionReady?: boolean }) => {
        if (active && typeof d.transcriptionReady === 'boolean') {
          setTranscriptionReady(d.transcriptionReady);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    lastLiveDictatedRef.current = false;
  }, [value, liveTyping]);

  const stopRecording = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    setIsRecording(false);
  }, []);

  useEffect(() => {
    if (!visible) {
      lastLiveDictatedRef.current = false;
      stopRecording();
    }
  }, [visible, stopRecording]);

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      if (timerRef.current !== null) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, []);

  const toggleRecording = async () => {
    if (isRecording) {
      stopRecording();
      return;
    }
    if (isTranscribing || transcriptionReady === false) return;

    setDictationNotice(null);

    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        setDictationNotice({ kind: 'error', text: 'Voice dictation is not supported in this browser.' });
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (unmountedRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      streamRef.current = stream;
      const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4';
      const recorder = new MediaRecorder(stream, { mimeType });
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        if (streamRef.current === stream) streamRef.current = null;
        if (mediaRecorderRef.current === recorder) mediaRecorderRef.current = null;
        if (unmountedRef.current) return;

        const blob = new Blob(chunksRef.current, { type: mimeType });
        if (blob.size < MIN_AUDIO_BYTES) {
          setDictationNotice({
            kind: 'error',
            text: 'Recording was too short. Speak clearly and try again.',
          });
          return;
        }

        setIsTranscribing(true);
        try {
          const base64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(String(reader.result || ''));
            reader.onerror = () => reject(new Error('Failed to read audio recording.'));
            reader.readAsDataURL(blob);
          });
          if (unmountedRef.current) return;

          const res = await apiFetch('/api/ai/transcribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ audioBase64: base64, mimeType }),
          });
          const data = (await res.json().catch(() => ({}))) as Partial<TranscribeResponse> & { error?: string };
          if (unmountedRef.current) return;

          if (!res.ok) {
            setDictationNotice({ kind: 'error', text: data.error || 'Voice dictation failed.' });
            return;
          }

          const transcript = String(data.text ?? '').trim();
          if (!transcript) {
            setDictationNotice({ kind: 'info', text: 'No speech detected.' });
            return;
          }

          setDictationNotice(data.warning ? { kind: 'warning', text: data.warning } : null);
          const latest = latestRef.current;
          if (latest.liveTyping) {
            const liveText = formatLiveDictationText(transcript, lastLiveDictatedRef.current);
            if (liveText) {
              latest.onSendText(liveText);
              lastLiveDictatedRef.current = true;
            }
          } else {
            latest.onChange(appendDictationToBuffer(latest.value, transcript));
            localInputRef.current?.focus();
          }
        } catch (err) {
          if (!unmountedRef.current) {
            setDictationNotice({
              kind: 'error',
              text: (err as Error).message || 'Voice dictation failed.',
            });
          }
        } finally {
          if (!unmountedRef.current) {
            setIsTranscribing(false);
          }
        }
      };

      mediaRecorderRef.current = recorder;
      recorder.start();
      setRecordSeconds(0);
      setIsRecording(true);
      let elapsed = 0;
      timerRef.current = window.setInterval(() => {
        elapsed += 1;
        setRecordSeconds(elapsed);
        if (elapsed >= MAX_RECORD_SECONDS) {
          stopRecording();
        }
      }, 1000);
    } catch {
      if (!unmountedRef.current) {
        setDictationNotice({
          kind: 'error',
          text: 'Microphone permission is required for voice dictation.',
        });
      }
    }
  };

  const handleFormSubmit = (e: React.FormEvent) => {
    lastLiveDictatedRef.current = false;
    setDictationNotice(null);
    onSubmit(e);
  };

  const handleSendKey = (key: string) => {
    lastLiveDictatedRef.current = false;
    onSendKey(key);
  };

  const handleSendSpace = () => {
    lastLiveDictatedRef.current = false;
    onSendText(' ');
  };

  const handleSendCombo = (nextCombo: string) => {
    lastLiveDictatedRef.current = false;
    onSendCombo(nextCombo);
  };

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
      <form onSubmit={handleFormSubmit} className="flex items-center gap-2">
        <input
          ref={setInputRef}
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
          placeholder={
            isTranscribing
              ? 'Transcribing voice dictation...'
              : liveTyping
                ? 'Type live keystrokes to Windows...'
                : 'Type text to send to Windows...'
          }
          className={`flex-1 min-h-[44px] px-3.5 py-2 rounded-xl border text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 ${
            compact
              ? 'bg-slate-950 border-slate-700 text-white'
              : 'bg-slate-50 dark:bg-slate-950 border-slate-200 dark:border-slate-800 text-slate-900 dark:text-white'
          }`}
        />
        <button
          type="button"
          onClick={toggleRecording}
          disabled={transcriptionReady === false || isTranscribing}
          title={
            transcriptionReady === false
              ? 'Voice dictation unavailable: GEMINI_API_KEY is not configured on the relay'
              : isRecording
                ? 'Stop voice dictation'
                : 'Start voice dictation'
          }
          aria-label={
            transcriptionReady === false
              ? 'Voice dictation unavailable (GEMINI_API_KEY not configured)'
              : isTranscribing
                ? 'Transcribing voice dictation'
                : isRecording
                  ? 'Stop voice dictation'
                  : 'Start voice dictation'
          }
          className={`min-h-[44px] min-w-[44px] px-2.5 rounded-xl border text-xs font-medium inline-flex items-center justify-center gap-1.5 shrink-0 transition-colors ${
            isRecording
              ? 'border-red-600 bg-red-600 hover:bg-red-700 text-white'
              : transcriptionReady === false
                ? compact
                  ? 'border-slate-800 bg-slate-900 text-slate-500 opacity-50 cursor-not-allowed'
                  : 'border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-950 text-slate-400 opacity-50 cursor-not-allowed'
                : compact
                  ? 'border-slate-700 bg-slate-950 text-slate-200 hover:border-blue-500 disabled:opacity-50'
                  : 'border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-950 text-slate-700 dark:text-slate-200 hover:border-blue-500 disabled:opacity-50'
          }`}
        >
          {isTranscribing ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : isRecording ? (
            <>
              <MicOff className="w-4 h-4" />
              <span className="font-mono tabular-nums text-xs">{recordSeconds}s</span>
            </>
          ) : (
            <Mic className="w-4 h-4" />
          )}
        </button>
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
            onClick={() => {
              setDictationNotice(null);
              onClose();
            }}
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl bg-slate-800 text-slate-300 hover:text-white shrink-0"
            aria-label="Close keyboard"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </form>

      {dictationNotice && (
        <div
          role="status"
          className={`px-3 py-1.5 rounded-xl border text-xs flex items-center justify-between gap-2 ${
            dictationNotice.kind === 'error'
              ? 'bg-red-500/10 border-red-500/30 text-red-600 dark:text-red-400'
              : dictationNotice.kind === 'warning'
                ? 'bg-amber-500/10 border-amber-500/30 text-amber-600 dark:text-amber-400'
                : compact
                  ? 'bg-slate-800/80 border-slate-700 text-slate-300'
                  : 'bg-slate-100 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'
          }`}
        >
          <span className="truncate">{dictationNotice.text}</span>
          <button
            type="button"
            onClick={() => setDictationNotice(null)}
            className="min-h-[40px] min-w-[40px] -my-1 -mr-1.5 flex items-center justify-center rounded-lg hover:bg-black/10 dark:hover:bg-white/10 shrink-0"
            aria-label="Dismiss dictation notice"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {SPECIAL_KEYS.map((keyName) => (
            <button key={keyName} type="button" onClick={() => handleSendKey(keyName)} className={textKeyClass}>
              {keyName === 'Escape' ? 'Esc' : keyName}
            </button>
          ))}
          <button type="button" onClick={handleSendSpace} className={textKeyClass}>
            Space
          </button>
          {ARROW_KEYS.map(({ key, label, Icon }) => (
            <button key={key} type="button" onClick={() => handleSendKey(key)} className={iconKeyClass} aria-label={label}>
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

      <div className="flex flex-wrap items-center gap-1.5">
        {MODIFIERS.map(({ id, label }) => {
          const active = modifiers.includes(id);
          return (
            <button
              key={id}
              type="button"
              aria-pressed={active}
              onClick={() => onToggleModifier(id)}
              className={
                active
                  ? 'min-h-[38px] px-2.5 py-1 rounded-lg border text-xs font-mono border-blue-600 bg-blue-600 text-white'
                  : textKeyClass
              }
            >
              {label}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => setShowMore((v) => !v)}
          aria-expanded={showMore}
          className={`${textKeyClass} inline-flex items-center gap-1`}
        >
          <span>More keys</span>
          {showMore ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
        </button>
        {modifiers.length > 0 && (
          <span className="text-xs text-blue-500">Next key is sent with {modifiers.map((m) => m[0].toUpperCase() + m.slice(1)).join('+')}</span>
        )}
      </div>

      {showMore && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {EXTRA_KEYS.map(({ key, label }) => (
              <button key={key} type="button" onClick={() => handleSendKey(key)} className={textKeyClass}>
                {label}
              </button>
            ))}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!comboValid) return;
              handleSendCombo(combo.replace(/\s+/g, ''));
              setCombo('');
            }}
            className="flex items-center gap-2"
          >
            <input
              type="text"
              value={combo}
              onChange={(e) => setCombo(e.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              placeholder="Any shortcut, e.g. Ctrl+Shift+T"
              aria-label="Custom key combination"
              className={`flex-1 min-h-[40px] px-3 py-1.5 rounded-xl border text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-600 ${
                compact
                  ? 'bg-slate-950 border-slate-700 text-white'
                  : 'bg-slate-50 dark:bg-slate-950 border-slate-200 dark:border-slate-800 text-slate-900 dark:text-white'
              }`}
            />
            <button
              type="submit"
              disabled={!comboValid}
              className="min-h-[40px] px-3 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-xs font-semibold inline-flex items-center gap-1.5 shrink-0"
            >
              <Command className="w-3.5 h-3.5" />
              <span>Send</span>
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
