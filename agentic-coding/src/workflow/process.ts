// Asynchronous subprocess boundary (migrate-workflow-execution-to-effect,
// task 2.1): bounded output capture, a hard timeout, real child cancellation
// on interruption, and bounded termination/reader cleanup. This is the one
// place workflow code spawns a cancellable child apart from the credential
// relay (`credentials.ts`, which owns its askpass shim) and the detached
// managed-agent lifecycle (`adapters.ts`, which deliberately outlives the
// runner and must never be killed through process-group semantics).
//
// Supported process-tree termination: `proc.kill()` signals the direct child
// only. Descendants (shells, relays) are never signal-driven directly. This is
// deliberate — detached managed agents and credential relay readers must not be
// killed by accident when the owning command is terminated.
//
// The consequence is that a descendant which inherited the child's pipes can
// still hold the write end open after the child is gone, so this module settles
// on the child's exit and drains the readers for a bounded grace rather than
// waiting for EOF. Measured: `sh -c "yes x | head -c 100000; sleep 30"` never
// reached EOF after `proc.kill()` in 12/12 rounds, because the surviving
// `sleep` held the pipe; waiting for EOF there wedged the effect until that
// descendant happened to exit. `exec`-ing the last command moves the pipe into
// the direct child and reaches EOF in 0/12, which is why the difference only
// surfaced as a load-dependent flake.
import { Effect } from "effect";

export const MAX_PROCESS_OUTPUT_BYTES = 4 * 1024 * 1024;
/** Grace period after signaling a child before forcing SIGKILL. */
export const PROCESS_TERMINATION_GRACE_MS = 2_000;
/** How long the readers may keep draining after the child has been reaped
 * before the effect settles on what was captured. Long enough for the tail of a
 * normal command's output to arrive, short enough that a descendant holding the
 * pipe cannot extend the command's lifetime. */
export const OUTPUT_DRAIN_GRACE_MS = 500;
export const DEFAULT_PROCESS_TIMEOUT_MS = 120_000;

export interface ProcessResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export type ProcessFailure =
	| { _tag: "exit"; exitCode: number; detail: string }
	| { _tag: "timeout"; detail: string }
	| { _tag: "canceled"; detail: string }
	| { _tag: "overflow"; detail: string };

export interface ProcessOptions {
	readonly cwd?: string;
	readonly env?: Record<string, string>;
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
	readonly maxOutputBytes?: number;
}

interface BoundedRead {
	readonly maxBytes: number;
	readonly onOverflow: () => void;
	/** Resolves when the caller stops caring about the pipe. */
	readonly stop?: Promise<void>;
	/** Whether the direct child has already been reaped. */
	readonly childGone: () => boolean;
	/** Called when a chunk arrives after the child was reaped, which is the only
	 * evidence that someone other than the child is still writing. */
	readonly onLateOutput: () => void;
}

function readBounded(
	stream: ReadableStream<Uint8Array>,
	options: BoundedRead,
): Promise<{ text: string; overflow: boolean }> {
	const { maxBytes, onOverflow, stop, childGone, onLateOutput } = options;
	return new Promise((resolve, reject) => {
		const reader = stream.getReader();
		let chunks: Uint8Array[] = [];
		let total = 0;
		let overflow = false;
		let settled = false;
		// Resolve on EOF, or as soon as the caller says the drain window has
		// closed, whichever happens first. Settling ends the reader too: the
		// promise is all the caller keeps, so a pump left running after it has
		// no observer and no ceiling. A descendant that inherited the pipe
		// keeps writing for its whole lifetime, and every byte of that is
		// buffered here — measured on this machine: the surviving `sleep` in
		// `sh -c "yes x | head -c 100000; sleep 30"` holds the pipe open
		// forever, so the pre-fix pump appended without bound in the runner.
		const settle = () => {
			if (settled) return;
			settled = true;
			const text = Buffer.concat(chunks).toString("utf8");
			chunks = [];
			void reader.cancel().catch(() => {
				/* the stream is already closed */
			});
			resolve({ text, overflow });
		};
		void stop?.then(settle);
		const pump = () => {
			void reader.read().then(
				({ done, value }) => {
					if (done) {
						settle();
						return;
					}
					if (settled) return;
					// The child's own buffered tail also lands here, which is why
					// this only marks a *possible* descendant writer: the caller
					// pairs it with the drain window never closing early.
					if (childGone()) onLateOutput();
					total += value.byteLength;
					if (total > maxBytes) {
						// A chatty child must be terminated immediately, not left
						// streaming until its natural exit, and its excess output
						// must not be buffered while the kill lands.
						overflow = true;
						onOverflow();
						settle();
						return;
					}
					chunks.push(value);
					pump();
				},
				(error) => reject(error),
			);
		};
		pump();
	});
}

async function boundedExited(proc: import("bun").Subprocess): Promise<number> {
	return await proc.exited;
}

function terminateProc(
	proc: import("bun").Subprocess,
	graceMs: number,
): () => void {
	const hard = setTimeout(() => {
		try {
			proc.kill(9);
		} catch {
			/* already gone */
		}
	}, graceMs);
	return () => clearTimeout(hard);
}

export function runProcessEffect(
	args: readonly string[],
	options: ProcessOptions = {},
): Effect.Effect<ProcessResult, ProcessFailure> {
	return Effect.async<ProcessResult, ProcessFailure>((resume) => {
		const timeoutMs = options.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS;
		const maxOutputBytes = options.maxOutputBytes ?? MAX_PROCESS_OUTPUT_BYTES;
		const proc = Bun.spawn([...args], {
			cwd: options.cwd,
			env: options.env as Record<string, string> | undefined,
			stdout: "pipe",
			stderr: "pipe",
		});
		// Readers are bounded so a chatty child cannot pin unbounded memory; an
		// overflow terminates the child promptly. The bound is enforced in
		// `readBounded` itself, so it also holds after the effect has settled and
		// only a surviving descendant is still writing.
		let overflowKilled = false;
		const killOnOverflow = () => {
			overflowKilled = true;
			try {
				proc.kill();
			} catch {
				/* already gone */
			}
		};
		// The readers stop when the caller closes this window, so a descendant
		// holding an inherited pipe cannot keep the effect pending.
		let closeDrainWindow: () => void = () => {};
		const drainWindowClosed = new Promise<void>((resolve) => {
			closeDrainWindow = resolve;
		});
		const readOptions = {
			maxBytes: maxOutputBytes,
			onOverflow: killOnOverflow,
			stop: drainWindowClosed,
			childGone: () => childGone,
			onLateOutput: () => {
				lateOutputSeen = true;
			},
		} as const;
		const stdoutRead = readBounded(proc.stdout, readOptions);
		const stderrRead = readBounded(proc.stderr, readOptions);
		let settled = false;
		/** The drain window expired without EOF: someone still holds the pipe. */
		let drainWindowExpired = false;
		/** A chunk arrived after the child was reaped. */
		let lateOutputSeen = false;
		let childGone = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let aborted = false;
		const onAbort = () => {
			aborted = true;
			clearTimeout(timer);
			try {
				proc.kill();
			} catch {
				/* already gone */
			}
		};
		let terminate: (() => void) | undefined;
		const finish = (failure?: ProcessFailure, result?: ProcessResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			terminate?.();
			options.signal?.removeEventListener("abort", onAbort);
			if (failure) resume(Effect.fail(failure));
			else if (result) resume(Effect.succeed(result));
		};
		if (options.signal?.aborted) {
			aborted = true;
			try {
				proc.kill();
			} catch {
				/* already gone */
			}
		} else {
			options.signal?.addEventListener("abort", onAbort, { once: true });
		}
		if (!aborted) {
			timer = setTimeout(() => {
				if (settled) return;
				terminate = terminateProc(proc, PROCESS_TERMINATION_GRACE_MS);
				try {
					proc.kill();
				} catch {
					/* already gone */
				}
				void boundedExited(proc).then(() =>
					finish({
						_tag: "timeout",
						detail: `command timed out after ${timeoutMs}ms: ${args.join(" ")}`,
					}),
				);
			}, timeoutMs);
		}
		// Settle on the child's exit, not on the pipes reaching EOF: the child is
		// the process this module owns, and a descendant that outlived it must not
		// extend the command's lifetime. The readers get a bounded grace to hand
		// over the tail of the output first.
		void boundedExited(proc)
			.then(async (exitCode) => {
				childGone = true;
				const grace = setTimeout(() => {
					// EOF never arrived, so the pipe is still held open after the
					// child was reaped. On its own that proves nothing about the
					// output: a descendant can inherit the pipe and write nothing.
					drainWindowExpired = true;
					closeDrainWindow();
				}, OUTPUT_DRAIN_GRACE_MS);
				const [stdout, stderr] = await Promise.all([stdoutRead, stderrRead]);
				clearTimeout(grace);
				return [exitCode, stdout, stderr] as const;
			})
			.then(([exitCode, stdout, stderr]) => {
				if (stdout.overflow || stderr.overflow || overflowKilled)
					return finish({
						_tag: "overflow",
						detail: `command output exceeded ${maxOutputBytes} bytes: ${args.join(" ")}`,
					});
				// Cancellation is an ownership fact and outranks the state of a
				// descendant: an aborted command must keep its non-retryable class
				// even when a survivor is still holding the pipe, which is exactly
				// when both conditions hold at once.
				if (settled) return;
				if (aborted) {
					return finish({
						_tag: "canceled",
						detail: `command canceled: ${args.join(" ")}`,
					});
				}
				// Incomplete output is reported only when the pipe was still held
				// open AND someone wrote after the child was reaped. The first fact
				// alone is not evidence — a silent descendant holds the pipe for its
				// whole lifetime while the capture is already complete — so it would
				// fail a green command (measured: `sh -c "printf 'hi\n'; sleep 30 &"`
				// returned `overflow` for a complete `hi`). Callers parse `stdout`
				// as authoritative data (a created PR/MR URL, a changed-file list),
				// so a stream that was still producing is not usable as one; it is
				// reported as `overflow`, the class they already retry.
				if (drainWindowExpired && lateOutputSeen)
					return finish({
						_tag: "overflow",
						detail: `command output was still being written ${OUTPUT_DRAIN_GRACE_MS}ms after the process exited, so the result may be incomplete: ${args.join(" ")}`,
					});
				if (exitCode !== 0)
					return finish({
						_tag: "exit",
						exitCode,
						detail: (stderr.text.trim() || stdout.text.trim()).slice(
							0,
							4 * 1024,
						),
					});
				finish(undefined, {
					exitCode,
					stdout: stdout.text,
					stderr: stderr.text,
				});
			})
			.catch((error) =>
				finish({
					_tag: "canceled",
					detail: String((error as Error).message ?? error),
				}),
			);
		// Effect.async finalizer: called when the fiber is interrupted or the
		// Effect is canceled — propagate to the real child and settle.
		return Effect.sync(() => {
			if (!settled) {
				terminate = terminateProc(proc, PROCESS_TERMINATION_GRACE_MS);
				try {
					proc.kill();
				} catch {
					/* already gone */
				}
			}
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
		});
	});
}
