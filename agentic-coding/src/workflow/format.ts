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
	return remainingMinutes === 0
		? `${hours}h`
		: `${hours}h ${remainingMinutes}m`;
}

/**
 * Humanized byte size for stored evidence and download progress.
 *
 * Rules (decimal units, one decimal place above a kilobyte):
 * - Below a kilobyte: whole bytes, e.g. `0 B`, `512 B`.
 * - Otherwise the largest unit that fits: `1.5 KB`, `2.3 MB`, `1.1 GB`.
 * - Non-finite or negative input clamps to `0 B`, so a missing size renders as
 *   a size rather than as `NaN`.
 */
export function formatBytes(bytes: number): string {
	const value = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
	for (const [label, size] of [
		["GB", 1_000_000_000],
		["MB", 1_000_000],
		["KB", 1_000],
	] as const)
		if (value >= size) return `${(value / size).toFixed(1)} ${label}`;
	return `${Math.round(value)} B`;
}
