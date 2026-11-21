import { GoogleGenAI } from '@google/genai';
import type { TranscribeResponse } from '../src/types/deskbridge.js';

/** Short, single-line description of a Gemini SDK error for logs and user-facing warnings. */
export function describeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  return oneLine.length > 200 ? `${oneLine.slice(0, 197)}...` : oneLine || 'unknown error';
}

/** Thrown when every candidate model failed; lists each model's error. */
export class GeminiUnavailableError extends Error {
  constructor(public readonly failures: Array<{ model: string; error: string }>) {
    super(`All Gemini models failed: ${failures.map((f) => `${f.model}: ${f.error}`).join(' | ')}`);
    this.name = 'GeminiUnavailableError';
  }
}

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw new Error('GEMINI_API_KEY is not configured. Please connect your Gemini API key in Settings > Secrets.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'deskbridge',
      },
    },
  });
}

export async function transcribeDictation(audioBase64: string, mimeType: string): Promise<TranscribeResponse> {
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

  let text = '';
  let usedModel: string | undefined;
  const failures: Array<{ model: string; error: string }> = [];
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
              text: 'Transcribe this spoken dictation verbatim in the language spoken, including natural punctuation. Output only the spoken words—no commentary, quotes, or interpretation. If no speech is audible, output nothing.',
            },
          ],
        },
      });
      text = (response.text ?? '').trim();
      usedModel = model;
      break;
    } catch (err) {
      failures.push({ model, error: describeError(err) });
      console.warn(`[ai] transcription with ${model} failed: ${describeError(err)}`);
    }
  }

  if (!usedModel) {
    throw new GeminiUnavailableError(failures);
  }

  const warning =
    failures.length > 0
      ? `Fell back to ${usedModel} after ${failures.map((f) => `${f.model} failed (${f.error})`).join(', ')}.`
      : undefined;

  return {
    text,
    model: usedModel,
    ...(warning ? { warning } : {}),
  };
}
