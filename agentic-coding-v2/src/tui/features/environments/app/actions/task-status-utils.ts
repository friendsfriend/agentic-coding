/**
 * Task action metadata utility helpers.
 */

/** Truncate long arg values; empty Record returns empty string. */
export const formatTaskArgsSummary = (args: Record<string, string>): string => {
	const entries = Object.entries(args);
	if (entries.length === 0) return "";
	return entries
		.map(([k, v]) => {
			const flag = k.startsWith("-") ? k : `--${k}`;
			if (v.length > 30) return `${flag} ${v.slice(0, 30)}...`;
			return `${flag} ${v}`;
		})
		.join(" ");
};

/** Format milliseconds as "Xms", "X.Xs", or "Xm". */
export const formatDuration = (ms: number): string => {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	return `${Math.round(ms / 60_000)}m`;
};
