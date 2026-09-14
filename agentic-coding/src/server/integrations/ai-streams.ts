// Streamed log analysis and the shared Pi process helpers
// (`port-git-providers-and-ai-to-bun`, task 4.2), ported from
// `handlers_github.go` (`handleAIAnalyzeLogs`, `handleAIAnalyzeLogsStream`,
// `handlePiAnalyzeLogsStream`).
//
// The Go implementation buffered the whole `pi --print` output and emitted it
// as one SSE delta; the port keeps that shape so the client sees the same
// events. Bounds and diagnostics are preserved: a 100 KB tail of the log with
// an appended truncation note, a 90 second timeout, and `pi not found in PATH`
// as a 503.
export const MAX_LOG_BYTES = 100 * 1024;
export const ANALYZE_TIMEOUT_MS = 90_000;

export const DEFAULT_LOG_PROMPT =
	"Analyze these logs. Summarize errors, warnings, and any notable events concisely.";

export class PiUnavailableError extends Error {
	readonly code = "pi-unavailable";
	constructor() {
		super("pi not found in PATH");
		this.name = "PiUnavailableError";
	}
}

export class PiTimeoutError extends Error {
	readonly code = "pi-timeout";
	constructor() {
		super("AI analysis timed out");
		this.name = "PiTimeoutError";
	}
}

/** Truncate to the most recent 100 KB and record that in the prompt. */
export function boundLogs(
	logs: string,
	prompt: string,
): { logs: string; prompt: string } {
	if (Buffer.byteLength(logs, "utf8") <= MAX_LOG_BYTES) return { logs, prompt };
	const bytes = Buffer.from(logs, "utf8");
	const tail = bytes
		.subarray(bytes.byteLength - MAX_LOG_BYTES)
		.toString("utf8");
	return {
		logs: tail,
		prompt: `${prompt}\n[Note: log was truncated to the most recent 100 KB]`,
	};
}

export interface PiRunResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
	readonly timedOut: boolean;
}

/** Run `pi --print --no-session --no-tools <prompt>` with the analysis bound. */
export async function runPiPrint(
	prompt: string,
	options: {
		readonly env?: NodeJS.ProcessEnv;
		readonly timeoutMs?: number;
		readonly signal?: AbortSignal;
	} = {},
): Promise<PiRunResult> {
	const child = Bun.spawn(
		["pi", "--print", "--no-session", "--no-tools", prompt],
		{
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
			env: { ...(options.env ?? process.env), GIT_TERMINAL_PROMPT: "0" },
		},
	);
	const timeoutMs = options.timeoutMs ?? ANALYZE_TIMEOUT_MS;
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill();
	}, timeoutMs);
	const onAbort = () => child.kill();
	options.signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { stdout, stderr, exitCode: exitCode ?? 1, timedOut };
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
	}
}

/** One analysis result, or the bounded diagnostic the Go handler produced. */
export async function analyzeLogs(
	logs: string,
	prompt: string,
	options: {
		readonly env?: NodeJS.ProcessEnv;
		readonly hasPi?: boolean;
		readonly timeoutMs?: number;
	} = {},
): Promise<{ summary: string }> {
	if (!(options.hasPi ?? true)) throw new PiUnavailableError();
	const bounded = boundLogs(logs, prompt);
	const result = await runPiPrint(
		`${bounded.prompt}\n\n${bounded.logs}`,
		options,
	);
	if (result.timedOut) throw new PiTimeoutError();
	if (result.exitCode !== 0) {
		const diagnostic = result.stderr.trim() || `exit ${result.exitCode}`;
		throw new Error(`pi analysis failed: ${diagnostic}`);
	}
	return { summary: result.stdout };
}

/** Server-sent-event body for one analysis. A failure is a single `error`
 * event, exactly as the Go handler wrote it. `onClose` runs exactly once when
 * the stream ends or the client disconnects, which is what releases an owned
 * resource such as a review checkout. */
export function logAnalysisEventStream(
	events: AsyncIterable<{ delta?: string; error?: string; done?: boolean }>,
	onClose?: () => void,
): Response {
	const encoder = new TextEncoder();
	let closed = false;
	const close = () => {
		if (closed) return;
		closed = true;
		onClose?.();
	};
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			try {
				for await (const event of events) {
					if (event.error !== undefined) {
						controller.enqueue(
							encoder.encode(
								`data: {"error":${JSON.stringify(event.error)}}\n\n`,
							),
						);
						continue;
					}
					if (event.delta !== undefined && event.delta !== "") {
						controller.enqueue(
							encoder.encode(
								`data: {"delta":${JSON.stringify(event.delta)}}\n\n`,
							),
						);
						continue;
					}
					if (event.done) {
						controller.enqueue(encoder.encode('data: {"done":true}\n\n'));
					}
				}
			} finally {
				controller.close();
				close();
			}
		},
		cancel() {
			// The client went away: the generator is abandoned, so the owned
			// resource is released here.
			close();
		},
	});
	return new Response(stream, {
		status: 200,
		headers: {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		},
	});
}
