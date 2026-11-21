/**
 * Appends a completed voice dictation transcript to an existing buffered input string,
 * inserting a separating space only when needed.
 */
export function appendDictationToBuffer(currentBuffer: string, transcript: string): string {
  const trimmed = transcript.trim();
  if (!trimmed) return currentBuffer;
  if (!currentBuffer || /\s$/.test(currentBuffer)) {
    return currentBuffer + trimmed;
  }
  return `${currentBuffer} ${trimmed}`;
}

/**
 * Formats a completed voice dictation transcript for live keystroke injection,
 * prepending a space after a prior live dictation unless it begins with closing/trailing punctuation.
 */
export function formatLiveDictationText(transcript: string, needsLeadingSpace: boolean): string {
  const trimmed = transcript.trim();
  if (!trimmed) return '';
  if (needsLeadingSpace && !/^[,.;:!?)]/.test(trimmed)) {
    return ` ${trimmed}`;
  }
  return trimmed;
}
