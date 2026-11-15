import React, { useEffect, useRef, useState } from 'react';
import {
  Bot,
  Check,
  Mic,
  MicOff,
  Play,
  Send,
  Volume2,
  VolumeX,
} from 'lucide-react';
import type {
  AIActionStep,
  AICommandResponse,
  AIThinkingMode,
  HostProfile,
  RemoteInputEvent,
} from '../types/deskbridge';
import { apiFetch } from '../lib/auth';

interface ChatTurn {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  actions?: AIActionStep[];
  warning?: string;
}

interface AIAssistantPanelProps {
  activeHost: HostProfile | null;
  hosts: HostProfile[];
  activeFrame: string | null;
  onDispatchInput: (input: RemoteInputEvent, targetHostId?: string) => void;
  onSwitchHost: (hostId: string) => void;
  compact?: boolean;
}

const QUICK_PROMPTS = [
  'What is currently open on my screen?',
  'Open Outlook and type Running 10 mins late from my appointment',
  'Switch to my other Windows computer',
  'Open PowerShell and check git status',
];

export function AIAssistantPanel({
  activeHost,
  hosts,
  activeFrame,
  onDispatchInput,
  onSwitchHost,
  compact = false,
}: AIAssistantPanelProps) {
  const [thinkingMode, setThinkingMode] = useState<AIThinkingMode>('fast');
  const [geminiReady, setGeminiReady] = useState<boolean | null>(null);
  const [promptInput, setPromptInput] = useState('');
  const [autoExecute, setAutoExecute] = useState(true);
  const [speakReplies, setSpeakReplies] = useState(false);
  const [includeScreen, setIncludeScreen] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [turns, setTurns] = useState<ChatTurn[]>([
    {
      id: 'welcome',
      role: 'assistant',
      text: 'Speak or type a command for Gemini to control your selected Windows PC, launch apps, dictate emails, or switch between your paired Windows computers.',
    },
  ]);

  useEffect(() => {
    apiFetch('/api/health')
      .then((r) => r.json())
      .then((d: { geminiReady?: boolean }) => setGeminiReady(Boolean(d.geminiReady)))
      .catch(() => {});
  }, []);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [turns, isLoading]);

  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
    };
  }, []);

  const executeActionStep = (step: AIActionStep): boolean => {
    const p = step.params || {};
    switch (step.action) {
      case 'open_application':
        onDispatchInput({ type: 'launch', target: String(p.target || 'notepad'), args: p.args ? String(p.args) : undefined });
        return true;
      case 'type_text':
        onDispatchInput({ type: 'type', text: String(p.text || '') });
        if (p.pressEnter) {
          onDispatchInput({ type: 'key', key: 'Enter' });
        }
        return true;
      case 'press_hotkey':
        onDispatchInput({ type: 'hotkey', combo: String(p.combo || 'Alt+Tab') });
        return true;
      case 'move_and_click': {
        const x = Math.max(0, Math.min(1, Number(p.xPercent ?? 50) / 100));
        const y = Math.max(0, Math.min(1, Number(p.yPercent ?? 50) / 100));
        onDispatchInput({
          type: 'click',
          button: p.button === 'right' ? 'right' : 'left',
          double: Boolean(p.doubleClick),
          x,
          y,
        });
        return true;
      }
      case 'scroll_screen': {
        const dir = String(p.direction || 'down').toLowerCase() === 'up' ? -1 : 1;
        const amt = Math.max(1, Math.min(10, Number(p.amount || 3)));
        onDispatchInput({ type: 'scroll', deltaX: 0, deltaY: dir * amt });
        return true;
      }
      case 'run_shell_command':
        onDispatchInput({ type: 'shell', command: String(p.command || '') });
        return true;
      case 'lock_workstation':
        onDispatchInput({ type: 'hotkey', combo: 'Win+L' });
        return true;
      case 'switch_workstation': {
        const query = String(p.targetQuery || '').toLowerCase();
        const found = hosts.find(
          (h) =>
            h.name.toLowerCase().includes(query) ||
            h.groupLabel.toLowerCase().includes(query) ||
            h.hostId.toLowerCase() === query,
        );
        if (found) {
          onSwitchHost(found.hostId);
          return true;
        }
        return false;
      }
      default:
        return false;
    }
  };

  const handleAssistantResult = (data: AICommandResponse, userDisplayText: string) => {
    const processedActions: AIActionStep[] = (data.actions || []).map((step) => {
      const isSensitive = step.action === 'run_shell_command' || step.action === 'lock_workstation';
      if (autoExecute && !isSensitive && (activeHost || step.action === 'switch_workstation')) {
        const ok = executeActionStep(step);
        return { ...step, status: ok ? 'executed' : 'failed' };
      }
      return { ...step, status: 'pending' };
    });

    setTurns((prev) => [
      ...prev,
      { id: `u-${Date.now()}`, role: 'user', text: userDisplayText },
      {
        id: `a-${Date.now() + 1}`,
        role: 'assistant',
        text: data.reply,
        actions: processedActions,
        warning: data.warning,
      },
    ]);

    if (data.spokenAudioBase64) {
      const audio = new Audio(`data:audio/wav;base64,${data.spokenAudioBase64}`);
      audio.play().catch(() => {});
    }
  };

  const sendTextCommand = async (textToSend: string) => {
    const trimmed = textToSend.trim();
    if (!trimmed || isLoading) return;
    setErrorMsg(null);
    setIsLoading(true);
    setPromptInput('');

    try {
      const res = await apiFetch('/api/ai/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: trimmed,
          thinkingMode,
          hostId: activeHost?.hostId,
          speakReply: speakReplies,
          screenshotBase64: includeScreen ? activeFrame || undefined : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Assistant request failed.');
      handleAssistantResult(data as AICommandResponse, trimmed);
    } catch (err) {
      setErrorMsg((err as Error).message);
    } finally {
      setIsLoading(false);
    }
  };

  const toggleRecording = async () => {
    if (isRecording) {
      mediaRecorderRef.current?.stop();
      setIsRecording(false);
      if (timerRef.current) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
      return;
    }

    setErrorMsg(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4';
      const recorder = new MediaRecorder(stream, { mimeType });
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: mimeType });
        if (blob.size < 400) {
          setErrorMsg('Recording was too short. Hold or speak clearly and try again.');
          return;
        }
        setIsLoading(true);
        try {
          const base64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(String(reader.result || ''));
            reader.onerror = () => reject(new Error('Failed to read audio recording.'));
            reader.readAsDataURL(blob);
          });

          const res = await apiFetch('/api/ai/voice-command', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              audioBase64: base64,
              mimeType,
              thinkingMode,
              hostId: activeHost?.hostId,
              speakReply: speakReplies,
              screenshotBase64: includeScreen ? activeFrame || undefined : undefined,
            }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Voice command failed.');
          handleAssistantResult(
            data as AICommandResponse,
            `Voice: "${(data as AICommandResponse).transcript || 'Audio command'}"`,
          );
        } catch (err) {
          setErrorMsg((err as Error).message);
        } finally {
          setIsLoading(false);
        }
      };

      mediaRecorderRef.current = recorder;
      recorder.start();
      setRecordSeconds(0);
      setIsRecording(true);
      timerRef.current = window.setInterval(() => {
        setRecordSeconds((s) => s + 1);
      }, 1000);
    } catch {
      setErrorMsg('Microphone permission is required for voice commands.');
    }
  };

  const handleRunActionClick = (turnId: string, stepId: string) => {
    setTurns((prev) =>
      prev.map((turn) => {
        if (turn.id !== turnId || !turn.actions) return turn;
        return {
          ...turn,
          actions: turn.actions.map((step) => {
            if (step.id !== stepId) return step;
            const ok = executeActionStep(step);
            return { ...step, status: ok ? 'executed' : 'failed' };
          }),
        };
      }),
    );
  };

  return (
    <div
      className={`flex flex-col rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden ${
        compact ? 'h-[520px]' : 'min-h-[620px] max-h-[calc(100vh-180px)]'
      }`}
    >
      <div className="px-4 py-3.5 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <Bot className="w-5 h-5 text-blue-600 dark:text-blue-400" />
          <div>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
              Gemini Remote Assistant
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {geminiReady === false
                ? 'Connect GEMINI_API_KEY in Settings > Secrets'
                : activeHost
                  ? `Gemini Active · ${activeHost.name} · ${activeHost.groupLabel}`
                  : 'Gemini Active · Select a Windows PC'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1 p-1 rounded-xl bg-slate-100 dark:bg-slate-800">
          <button
            type="button"
            onClick={() => setThinkingMode('fast')}
            className={`min-h-[36px] px-3 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap ${
              thinkingMode === 'fast'
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            Fast
          </button>
          <button
            type="button"
            onClick={() => setThinkingMode('deep')}
            className={`min-h-[36px] px-3 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap ${
              thinkingMode === 'deep'
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            Deep Reason
          </button>
        </div>
      </div>

      <div className="px-4 py-2 border-b border-slate-100 dark:border-slate-800/80 flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex items-center gap-4">
          <label className="inline-flex items-center gap-2 cursor-pointer text-slate-700 dark:text-slate-300">
            <input
              type="checkbox"
              checked={autoExecute}
              onChange={(e) => setAutoExecute(e.target.checked)}
              className="rounded border-slate-300 dark:border-slate-700 text-blue-600 focus:ring-blue-600"
            />
            <span>Auto-run safe actions</span>
          </label>
          <label className="inline-flex items-center gap-2 cursor-pointer text-slate-700 dark:text-slate-300">
            <input
              type="checkbox"
              checked={includeScreen}
              onChange={(e) => setIncludeScreen(e.target.checked)}
              className="rounded border-slate-300 dark:border-slate-700 text-blue-600 focus:ring-blue-600"
            />
            <span>See live screen</span>
          </label>
        </div>

        <button
          type="button"
          onClick={() => setSpeakReplies((v) => !v)}
          className={`min-h-[34px] inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border transition-colors ${
            speakReplies
              ? 'border-blue-600/40 bg-blue-600/10 text-blue-600 dark:text-blue-400'
              : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'
          }`}
        >
          {speakReplies ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
          <span>{speakReplies ? 'Voice Reply On' : 'Voice Reply Off'}</span>
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
        {turns.map((turn) => (
          <div
            key={turn.id}
            className={`flex flex-col ${turn.role === 'user' ? 'items-end' : 'items-start'}`}
          >
            <div
              className={`max-w-[88%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                turn.role === 'user'
                  ? 'bg-blue-600 text-white'
                  : 'bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-slate-100'
              }`}
            >
              <p>{turn.text}</p>

              {turn.warning && (
                <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">{turn.warning}</p>
              )}

              {turn.actions && turn.actions.length > 0 && (
                <div className="mt-3 space-y-2 pt-2 border-t border-slate-200/70 dark:border-slate-700">
                  {turn.actions.map((step) => (
                    <div
                      key={step.id}
                      className="flex items-center justify-between gap-3 rounded-xl bg-white dark:bg-slate-900 px-3 py-2 border border-slate-200 dark:border-slate-700 text-xs"
                    >
                      <span className="font-medium text-slate-800 dark:text-slate-200 truncate">
                        {step.label}
                      </span>
                      {step.status === 'executed' ? (
                        <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-medium shrink-0">
                          <Check className="w-3.5 h-3.5" />
                          <span>Sent</span>
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => handleRunActionClick(turn.id, step.id)}
                          className="min-h-[32px] inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium shrink-0 transition-colors"
                        >
                          <Play className="w-3 h-3" />
                          <span>Run</span>
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}

        {isLoading && (
          <div className="flex items-start">
            <div className="rounded-2xl px-4 py-3 bg-slate-100 dark:bg-slate-800 text-xs text-slate-600 dark:text-slate-300">
              Analyzing command and preparing desktop actions...
            </div>
          </div>
        )}
      </div>

      {!compact && (
        <div className="px-4 py-2 border-t border-slate-100 dark:border-slate-800 flex items-center gap-2 overflow-x-auto">
          {QUICK_PROMPTS.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => sendTextCommand(q)}
              className="min-h-[36px] px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-xs text-slate-700 dark:text-slate-300 hover:border-blue-500 transition-colors whitespace-nowrap shrink-0"
            >
              {q}
            </button>
          ))}
        </div>
      )}

      {errorMsg && (
        <div className="mx-4 mb-2 px-3 py-2 rounded-xl bg-red-500/10 border border-red-500/30 text-xs text-red-600 dark:text-red-400">
          {errorMsg}
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          sendTextCommand(promptInput);
        }}
        className="p-3 border-t border-slate-200 dark:border-slate-800 flex items-center gap-2"
      >
        <button
          type="button"
          onClick={toggleRecording}
          disabled={isLoading}
          className={`min-h-[48px] min-w-[48px] px-3 rounded-xl flex items-center justify-center gap-1.5 font-medium text-xs transition-colors shrink-0 ${
            isRecording
              ? 'bg-red-600 hover:bg-red-700 text-white'
              : 'bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200'
          }`}
          aria-label={isRecording ? 'Stop voice command' : 'Record voice command'}
        >
          {isRecording ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
          {isRecording && <span className="font-mono tabular-nums">{recordSeconds}s</span>}
        </button>

        <input
          type="text"
          value={promptInput}
          onChange={(e) => setPromptInput(e.target.value)}
          placeholder={isRecording ? 'Listening to voice command...' : 'Tell Gemini what to do on your PC...'}
          disabled={isRecording || isLoading}
          className="flex-1 min-h-[48px] px-4 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-sm text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600"
        />

        <button
          type="submit"
          disabled={!promptInput.trim() || isLoading || isRecording}
          className="min-h-[48px] min-w-[48px] rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white flex items-center justify-center transition-colors shrink-0"
          aria-label="Send command"
        >
          <Send className="w-5 h-5" />
        </button>
      </form>
    </div>
  );
}
