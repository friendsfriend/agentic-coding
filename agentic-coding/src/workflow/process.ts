// Asynchronous subprocess boundary (migrate-workflow-execution-to-effect,
// task 2.1): bounded output capture, a hard timeout, real child cancellation
// on interruption, and bounded termination/reader cleanup. This is the one
// place workflow code spawns a cancellable child apart from the credential
// relay (`credentials.ts`, which owns its askpass shim) and the detached
// managed-agent lifecycle (`adapters.ts`, which deliberately outlives the
// runner and must never be killed through process-group semantics).
//
// Supported process-tree termination: `proc.kill()` signals the direct child
// only. Descendants (shells, relays) are never signal-driven directly; they
// observe EOF on their inherited pipes when the child exits and terminate on
// their own. This is deliberate — detached managed agents and credential
// relay readers must not be killed by accident when the owning command is
// terminated.
import { Effect } from "effect";

export const MAX_PROCESS_OUTPUT_BYTES = 4 * 1024 * 1024;
/** Grace period after signaling a child before forcing SIGKILL. */
export const PROCESS_TERMINATION_GRACE_MS = 2_000;
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

function readBounded(
	stream: ReadableStream<Uint8Array>,
	maxBytes: number,
	onOverflow: () => void,
): Promise<{ text: string; overflow: boolean }> {
	return new Promise((resolve, reject) => {
		const reader = stream.getReader();
		const chunks: Uint8Array[] = [];
		let total = 0;
		let overflow = false;
		const pump = () => {
			void reader.read().then(
				({ done, value }) => {
					if (done) {
						resolve({
							text: Buffer.concat(chunks).toString("utf8"),
							overflow,
						});
						return;
					}
					total += value.byteLength;
					if (total > maxBytes && !overflow) {
						overflow = true;
						// A chatty child must be terminated immediately, not left
						// streaming until its natural exit.
						onOverflow();
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
		// overflow terminates the child promptly.
		let overflowKilled = false;
		const killOnOverflow = () => {
			overflowKilled = true;
			try {
				proc.kill();
			} catch {
				/* already gone */
			}
		};
		const stdoutRead = readBounded(proc.stdout, maxOutputBytes, killOnOverflow);
		const stderrRead = readBounded(proc.stderr, maxOutputBytes, killOnOverflow);
		let settled = false;
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
		void Promise.all([boundedExited(proc), stdoutRead, stderrRead])
			.then(([exitCode, stdout, stderr]) => {
				if (stdout.overflow || stderr.overflow || overflowKilled)
					return finish({
						_tag: "overflow",
						detail: `command output exceeded ${maxOutputBytes} bytes: ${args.join(" ")}`,
					});
				if (settled) return;
				if (aborted) {
					return finish({
						_tag: "canceled",
						detail: `command canceled: ${args.join(" ")}`,
					});
				}
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
