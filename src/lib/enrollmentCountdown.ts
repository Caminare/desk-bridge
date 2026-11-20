/** "m:ss" for the time left on an enrollment code. Rounds up so a still-valid code never shows 0:00. */
export function formatCountdown(msLeft: number): string {
  const totalSeconds = Math.max(0, Math.ceil(msLeft / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
