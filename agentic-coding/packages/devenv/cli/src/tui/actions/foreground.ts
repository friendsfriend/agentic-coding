import { AsyncLocalStorage } from "node:async_hooks";

// Asynchronous foreground terminal utilities (compose-unified-feature-shell,
// task 4.3). The unified shell runs the workflow engine and telemetry receiver
// in the same Bun process, so a synchronous child wait while the renderer is
// suspended would block lease renewal and telemetry processing. These helpers
// spawn asynchronously, await the child, and always restore the renderer in a
// `finally`, whether the tool succeeds, fails or is cancelled.
//
// The renderer is a single shared terminal: suspend()/resume() are stateful
// teardown/setup, so overlapping foreground owners must be serialized and the
// suspend/resume pair reference-counted. One queue/ref-count guarantees
// resume() only runs after the last foreground owner exits (CONCURRENCY-001).

export interface ForegroundRenderer {
	suspend(): void;
	resume(): void;
}

export interface ForegroundOptions {
	renderer: ForegroundRenderer;
	cwd?: string;
}

export interface ForegroundResult {
	code: number | undefined;
	error?: Error;
}

let foregroundChain: Promise<unknown> = Promise.resolve();
const foregroundOwner = new AsyncLocalStorage<ForegroundRenderer>();

/**
 * Run `fn` while the renderer is suspended, serialized against every other
 * foreground owner. Owners run strictly one at a time (the chain forbids
 * nesting); each suspends on entry and resumes in `finally`, including when
 * `fn` rejects. `suspend()` runs inside the try so a failing suspend cannot
 * leave the terminal in a half-suspended state.
 */
export async function withForegroundTerminal<T>(
	renderer: ForegroundRenderer,
	fn: () => Promise<T>,
): Promise<T> {
	const owner = foregroundOwner.getStore();
	// Reuse the active shared-terminal owner rather than queuing behind the
	// callback that is awaiting us. Different nested renderers are rejected so
	// they cannot form a cross-renderer queue cycle (CONCURRENCY-001).
	if (owner === renderer) return fn();
	if (owner) throw new Error("nested foreground terminal owner");
	const run = async (): Promise<T> => {
		let suspended = false;
		try {
			renderer.suspend();
			suspended = true;
			return await foregroundOwner.run(renderer, fn);
		} finally {
			if (suspended) renderer.resume();
		}
	};
	// Chain on settled (fulfilled or rejected) so a failed tool cannot wedge
	// the queue for later foreground owners.
	const result = foregroundChain.then(run, run);
	foregroundChain = result.then(
		() => undefined,
		() => undefined,
	);
	return result;
}

/**
 * Spawn `command` with inherited stdio and await it without touching the
 * renderer. Callers that already own the suspend/resume boundary (the script
 * runner's keypress prompt) use this directly.
 */
export async function spawnAndWait(
	command: string,
	args: readonly string[],
	options: { cwd?: string } = {},
): Promise<ForegroundResult> {
	try {
		const child = Bun.spawn([command, ...args], {
			stdio: ["inherit", "inherit", "inherit"],
			cwd: options.cwd,
		});
		return { code: await child.exited };
	} catch (error) {
		return {
			code: undefined,
			error: error instanceof Error ? error : new Error(String(error)),
		};
	}
}

/**
 * Suspend the renderer, run `command` with inherited stdio, and resume. Resolves
 * with the child's exit code (or undefined if it could not be spawned). Never
 * throws, so fire-and-forget launchers cannot produce unhandled rejections.
 */
export async function runForeground(
	command: string,
	args: readonly string[],
	options: ForegroundOptions,
): Promise<number | undefined> {
	try {
		return await withForegroundTerminal(options.renderer, async () => {
			const { code } = await spawnAndWait(command, args, { cwd: options.cwd });
			return code;
		});
	} catch {
		// Never throws: a suspend/spawn failure still releases the queue and the
		// fire-and-forget launchers cannot produce unhandled rejections.
		return undefined;
	}
}
