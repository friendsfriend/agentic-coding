/** Scoped console capture for dashboard surfaces that must not print into the
 * OpenTUI console overlay (e.g. library-detected memory leaks while the agent
 * configuration editor is open). Captured warnings/errors are handed to the
 * caller, which routes them to OTEL telemetry and a warning notification. */

export interface ConsoleIssue {
	level: "warn" | "error";
	message: string;
}

const MAX_MESSAGE_LENGTH = 500;

function formatValue(value: unknown): string {
	if (typeof value === "string") return value;
	if (value instanceof Error) return value.message;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

/** Flatten console arguments into one bounded, single-line message. */
export function formatConsoleIssue(args: readonly unknown[]): string {
	const text = args.map(formatValue).join(" ").replace(/\s+/g, " ").trim();
	return text.length > MAX_MESSAGE_LENGTH
		? `${text.slice(0, MAX_MESSAGE_LENGTH)}…`
		: text;
}

/** Replace `console.warn`/`console.error` with a forwarder that reports each
 * issue to `onIssue` and does not print it into the TUI. Returns a disposer
 * that restores the intercepted methods. */
export function captureConsoleIssues(
	onIssue: (issue: ConsoleIssue) => void,
): () => void {
	const originalWarn = console.warn;
	const originalError = console.error;
	console.warn = (...args: unknown[]) =>
		onIssue({ level: "warn", message: formatConsoleIssue(args) });
	console.error = (...args: unknown[]) =>
		onIssue({ level: "error", message: formatConsoleIssue(args) });
	return () => {
		console.warn = originalWarn;
		console.error = originalError;
	};
}
