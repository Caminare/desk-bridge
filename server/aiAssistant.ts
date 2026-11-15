import { FunctionDeclaration, GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import type {
  AIActionName,
  AIActionStep,
  AICommandResponse,
  AIThinkingMode,
  HostProfile,
} from '../src/types/deskbridge.js';

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw new Error('GEMINI_API_KEY is not configured. Please connect your Gemini API key in Settings > Secrets.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

const computerControlTools: FunctionDeclaration[] = [
  {
    name: 'open_application',
    description: 'Launch a Windows application or URL on the connected PC (e.g., outlook, excel, code, chrome, notepad, powershell, explorer, teams, or a URL).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        target: {
          type: Type.STRING,
          description: 'Executable name, shortcut, or URL to open on Windows.',
        },
        args: {
          type: Type.STRING,
          description: 'Optional command-line arguments.',
        },
      },
      required: ['target'],
    },
  },
  {
    name: 'type_text',
    description: 'Type a string of text at the current cursor focus on the Windows PC.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        text: {
          type: Type.STRING,
          description: 'Exact text to type into the active window.',
        },
        pressEnter: {
          type: Type.BOOLEAN,
          description: 'Whether to press Enter after typing.',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'press_hotkey',
    description: 'Trigger a Windows keyboard shortcut such as Win+D, Alt+Tab, Ctrl+C, Ctrl+V, Ctrl+S, Ctrl+Shift+Esc, or Enter/Tab/Escape.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        combo: {
          type: Type.STRING,
          description: 'Keyboard shortcut combo like Win+D, Alt+Tab, Ctrl+S, Ctrl+C, Ctrl+V, or Enter.',
        },
      },
      required: ['combo'],
    },
  },
  {
    name: 'move_and_click',
    description: 'Move the remote Windows cursor to a screen coordinate (0 to 100 percent X and Y) and click.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        xPercent: {
          type: Type.NUMBER,
          description: 'Horizontal position from 0 (left) to 100 (right).',
        },
        yPercent: {
          type: Type.NUMBER,
          description: 'Vertical position from 0 (top) to 100 (bottom).',
        },
        button: {
          type: Type.STRING,
          description: 'Mouse button: left or right.',
        },
        doubleClick: {
          type: Type.BOOLEAN,
          description: 'True for double-click.',
        },
        targetDescription: {
          type: Type.STRING,
          description: 'Brief description of the UI element being clicked.',
        },
      },
      required: ['xPercent', 'yPercent'],
    },
  },
  {
    name: 'scroll_screen',
    description: 'Scroll up or down in the active Windows application.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        direction: {
          type: Type.STRING,
          description: 'Scroll direction: up or down.',
        },
        amount: {
          type: Type.NUMBER,
          description: 'Scroll notch count (1 to 10).',
        },
      },
      required: ['direction'],
    },
  },
  {
    name: 'run_shell_command',
    description: 'Execute a PowerShell command on the connected Windows computer.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        command: {
          type: Type.STRING,
          description: 'PowerShell command to execute.',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'switch_workstation',
    description: 'Switch the active remote desktop session to a different paired Windows computer by its name or group label.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        targetQuery: {
          type: Type.STRING,
          description: 'Computer name or group label to switch to.',
        },
      },
      required: ['targetQuery'],
    },
  },
  {
    name: 'lock_workstation',
    description: 'Immediately lock the Windows computer screen (Win+L) for security.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        confirm: {
          type: Type.BOOLEAN,
          description: 'Set true to lock the workstation.',
        },
      },
      required: ['confirm'],
    },
  },
];

function formatActionLabel(name: AIActionName, args: Record<string, unknown>): string {
  switch (name) {
    case 'open_application':
      return `Open ${String(args.target || 'application')}`;
    case 'type_text':
      return `Type "${String(args.text || '').slice(0, 42)}${String(args.text || '').length > 42 ? '...' : ''}"`;
    case 'press_hotkey':
      return `Press ${String(args.combo || 'shortcut')}`;
    case 'move_and_click':
      return `Click ${String(args.targetDescription || `at ${Math.round(Number(args.xPercent || 50))}%, ${Math.round(Number(args.yPercent || 50))}%`)}`;
    case 'scroll_screen':
      return `Scroll ${String(args.direction || 'down')}`;
    case 'run_shell_command':
      return `Run PowerShell: ${String(args.command || '').slice(0, 36)}`;
    case 'switch_workstation':
      return `Switch to ${String(args.targetQuery || 'workstation')}`;
    case 'lock_workstation':
      return 'Lock Windows Workstation';
    default:
      return name;
  }
}

export async function transcribeAudioCommand(audioBase64: string, mimeType: string): Promise<string> {
  const ai = getGeminiClient();
  const cleanBase64 = audioBase64.includes(',') ? audioBase64.split(',')[1] : audioBase64;
  const candidateModels = Array.from(
    new Set([
      process.env.GEMINI_TRANSCRIBE_MODEL,
      'gemini-3.5-transcribe',
      process.env.GEMINI_MODEL,
      'gemini-4-hydrogen',
      'gemini-3.1-flash-lite',
    ].filter(Boolean) as string[]),
  );

  let lastErr: unknown;
  for (const model of candidateModels) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: {
          parts: [
            {
              inlineData: {
                mimeType: mimeType || 'audio/webm',
                data: cleanBase64,
              },
            },
            {
              text: 'Transcribe this voice command for controlling a Windows computer accurately. Output only the spoken command text.',
            },
          ],
        },
      });
      const text = (response.text ?? '').trim();
      if (text) return text;
    } catch (err) {
      lastErr = err;
    }
  }

  if (lastErr) throw lastErr;
  return '';
}

export async function synthesizeReplySpeech(text: string): Promise<string | undefined> {
  const ai = getGeminiClient();
  const cleanText = text.replace(/[*_`#]/g, '').slice(0, 320);
  if (!cleanText) return undefined;

  const response = await ai.models.generateContent({
    model: 'gemini-3.8-flash-lite-tts',
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: cleanText,
            speechMetadata: {
              style: 'Clear, concise mobile assistant confirming remote desktop action',
            },
          },
        ],
      },
    ],
    config: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: 'Kore' },
        },
      },
    },
  });

  return response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
}

export async function processAssistantCommand(params: {
  prompt?: string;
  audioBase64?: string;
  audioMimeType?: string;
  thinkingMode?: AIThinkingMode;
  activeHost?: HostProfile;
  availableHosts: HostProfile[];
  screenshotBase64?: string;
  speakReply?: boolean;
}): Promise<AICommandResponse> {
  const ai = getGeminiClient();
  const hostListText = params.availableHosts
    .map(
      (h) =>
        `- ${h.name} | Group: ${h.groupLabel} | Status: ${h.status} | Active Window: ${h.activeWindow || 'Windows Desktop'} | Resolution: ${h.screenWidth}x${h.screenHeight}`,
    )
    .join('\n');

  const systemInstruction = `You are DeskBridge AI powered by Gemini, a remote Windows computer assistant for managing and controlling multiple paired Windows computers from mobile or web.
Active Workstation: ${
    params.activeHost
      ? `${params.activeHost.name} (${params.activeHost.groupLabel}, ${params.activeHost.screenWidth}x${params.activeHost.screenHeight}, active window: ${params.activeHost.activeWindow || 'Desktop'})`
      : 'None connected'
  }
All Paired Workstations:
${hostListText || 'No workstations registered yet'}

Rules:
1. When the user wants to control a PC (open an app, type text, click UI on the attached screenshot, switch workstations, press hotkeys, scroll, lock PC, or run PowerShell), invoke one or more appropriate tool calls.
2. If a screenshot is attached, inspect it carefully to estimate accurate xPercent (0-100) and yPercent (0-100) coordinates for move_and_click, or answer questions about what is visible on screen.
3. Keep your spoken/text reply crisp, practical, and under 2 sentences.`;

  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];

  if (params.screenshotBase64 && params.screenshotBase64.includes('base64,')) {
    const [meta, b64] = params.screenshotBase64.split('base64,');
    const mimeMatch = meta.match(/data:(image\/[a-zA-Z+]+);/);
    parts.push({
      inlineData: {
        mimeType: mimeMatch ? mimeMatch[1] : 'image/jpeg',
        data: b64,
      },
    });
  }

  if (params.audioBase64) {
    const cleanAudio = params.audioBase64.includes(',')
      ? params.audioBase64.split(',')[1]
      : params.audioBase64;
    parts.push({
      inlineData: {
        mimeType: params.audioMimeType || 'audio/webm',
        data: cleanAudio,
      },
    });
  }

  parts.push({
    text: params.prompt || 'Listen to the attached voice command and execute the requested Windows desktop action.',
  });

  const thinkingLevel = params.thinkingMode === 'deep' ? ThinkingLevel.HIGH : ThinkingLevel.LOW;
  const candidateModels = Array.from(
    new Set([process.env.GEMINI_MODEL, 'gemini-4-hydrogen', 'gemini-3.1-flash-lite'].filter(Boolean) as string[]),
  );

  let response: Awaited<ReturnType<typeof ai.models.generateContent>> | undefined;
  let usedModel = candidateModels[0];
  let lastErr: unknown;

  for (const model of candidateModels) {
    try {
      const config =
        model === 'gemini-4-hydrogen'
          ? {
              systemInstruction,
              thinkingConfig: { thinkingLevel },
              tools: [{ functionDeclarations: computerControlTools }],
            }
          : {
              systemInstruction,
              tools: [{ functionDeclarations: computerControlTools }],
            };
      response = await ai.models.generateContent({
        model,
        contents: { parts },
        config,
      });
      usedModel = model;
      break;
    } catch (err) {
      lastErr = err;
    }
  }

  if (!response) {
    throw lastErr instanceof Error ? lastErr : new Error('Gemini API request failed.');
  }

  const actions: AIActionStep[] = [];
  if (response.functionCalls && response.functionCalls.length > 0) {
    for (let i = 0; i < response.functionCalls.length; i++) {
      const fc = response.functionCalls[i];
      const actionName = fc.name as AIActionName;
      const args = (fc.args || {}) as Record<string, unknown>;
      actions.push({
        id: fc.id || `act-${Date.now()}-${i}`,
        action: actionName,
        label: formatActionLabel(actionName, args),
        params: args,
        status: 'pending',
      });
    }
  }

  const reply =
    (response.text ?? '').trim() ||
    (actions.length > 0
      ? `Prepared ${actions.length} action${actions.length > 1 ? 's' : ''}: ${actions.map((a) => a.label).join(', ')}.`
      : 'Command analyzed. No desktop actions were required.');

  let spokenAudioBase64: string | undefined;
  if (params.speakReply && reply) {
    try {
      spokenAudioBase64 = await synthesizeReplySpeech(reply);
    } catch {
      // Optional TTS enhancement
    }
  }

  return {
    model: usedModel,
    reply,
    actions,
    spokenAudioBase64,
  };
}
