/** Original transcript formats, local and presentation-only. */
export function formatClock(epochMs: number): string {
	const at = new Date(epochMs);
	const two = (value: number) => String(value).padStart(2, "0");
	return `${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}`;
}

export function formatCallDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${Math.round(seconds - minutes * 60)}s`;
}

export const SLOW_CALL_MS = 10_000;

export function formatTokenCount(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
	if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`;
	return String(Math.round(tokens));
}

export function formatCost(cost: number): string {
	if (cost > 0 && cost < 0.01) return "<$0.01";
	return `$${cost.toFixed(2)}`;
}
