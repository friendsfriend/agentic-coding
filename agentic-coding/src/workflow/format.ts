/**
 * Pure humanized duration formatting for run labels.
 *
 * Rules (truncation toward zero on each unit):
 * - Non-finite or negative input clamps to `0s`.
 * - < 60 seconds: whole seconds, e.g. `0s`, `3s`, `59s`.
 * - 60–3599 seconds: minutes plus leftover whole seconds, e.g. `2m`, `4m 5s`
 *   (zero leftover seconds renders as just `2m`).
 * - >= 3600 seconds: hours plus leftover whole minutes, e.g. `1h`, `1h 5m`,
 *   `25h 2m` (sub-minute remainder is truncated).
 */
export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "0s";
  const total = Math.floor(totalSeconds);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) {
    const seconds = total % 60;
    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}
