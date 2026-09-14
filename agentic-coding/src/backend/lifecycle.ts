// Named composition root for the owned environment backend. This is the only
// place that runs the backend Effect programs (scripts/workflow-architecture.ts
// `runtime:nested`); every caller stays plain TypeScript and receives a
// Promise-based handle.
//
// The process scope is owned here for the handle's whole lifetime, so
// `stop()` runs exactly the finalizers a failed or interrupted startup would
// have run: bounded child termination first, then extraction-directory
// removal. Failures surface as the concrete tagged errors from
// `managed-backend.ts` (never an Effect `FiberFailure`), matching the
// `WorkflowApplication.runSync` idiom.
import { Cause, Chunk, Effect, Exit, type Layer, Option, Scope } from "effect";
import {
	acquireOwnedBackend,
	BackendRuntime,
	BackendRuntimeLive,
	BackendStartupError,
	ensureExecutable,
	newInstanceId,
	type OwnedBackend,
	type StartBackendOptions,
} from "./managed-backend.ts";

export {
	BackendStartupError,
	type ChildEnvironment,
	type OwnedBackend,
	resolveConfigDir,
	resolveDevenvHome,
	type StartBackendOptions,
} from "./managed-backend.ts";

/** Live process/filesystem/network boundary; tests pass a stub layer. */
export type BackendLayer = Layer.Layer<BackendRuntime>;

/** Run a backend program, unwrapping the tagged failure instead of leaking a
 * `FiberFailure` to the caller. */
async function runBackendProgram<A, R>(
	program: Effect.Effect<A, BackendStartupError, R>,
	runtime: BackendLayer & Layer.Layer<R>,
): Promise<A> {
	const exit = await Effect.runPromiseExit(Effect.provide(program, runtime));
	if (Exit.isSuccess(exit)) return exit.value;
	const failure = Cause.failureOption(exit.cause);
	if (Option.isSome(failure)) throw failure.value;
	const defect = Chunk.head(Cause.defects(exit.cause));
	if (Option.isSome(defect)) {
		const value = defect.value;
		throw value instanceof Error ? value : new Error(String(value));
	}
	throw new Error(Cause.pretty(exit.cause));
}

function asStartupError(error: unknown): BackendStartupError {
	return error instanceof BackendStartupError
		? error
		: new BackendStartupError({
				reason: "spawn-failed",
				detail: error instanceof Error ? error.message : String(error),
			});
}

/** Start the owned backend, or throw `BackendStartupError`. */
export async function startOwnedBackend(
	options: StartBackendOptions,
	runtime: BackendLayer = BackendRuntimeLive,
): Promise<OwnedBackend & { stop: () => Promise<void> }> {
	const scope = await Effect.runPromise(Scope.make());
	try {
		const backend = await runBackendProgram(
			Scope.extend(acquireOwnedBackend(options), scope),
			runtime,
		);
		return {
			...backend,
			stop: () =>
				runBackendProgram(Scope.close(scope, Exit.void), runtime).then(
					() => undefined,
				),
		};
	} catch (error) {
		// Partial-startup rollback: close the scope so the finalizers stop
		// whatever had already been acquired before the failure surfaced.
		await runBackendProgram(Scope.close(scope, Exit.void), runtime).catch(
			() => {},
		);
		throw asStartupError(error);
	}
}

/** Release an owned backend started by `startOwnedBackend`. */
export async function stopOwnedBackend(backend: {
	stop: () => Promise<void>;
}): Promise<void> {
	await backend.stop().catch(() => {});
}

/**
 * Hold the owned backend until `signal` resolves, then release it. Used by
 * `agentic-coding server`: one scoped program, so a signal unwinds the child
 * through the same finalizers instead of a second lifecycle implementation.
 */
export async function serveOwnedBackend(
	options: StartBackendOptions & { onReady: (backend: OwnedBackend) => void },
	signal: Promise<void>,
	runtime: BackendLayer = BackendRuntimeLive,
): Promise<void> {
	const scope = await Effect.runPromise(Scope.make());
	try {
		await runBackendProgram(
			Scope.extend(
				Effect.gen(function* () {
					const backend = yield* acquireOwnedBackend(options);
					options.onReady(backend);
					yield* Effect.promise(() => signal);
				}),
				scope,
			),
			runtime,
		);
	} catch (error) {
		throw asStartupError(error);
	} finally {
		await runBackendProgram(Scope.close(scope, Exit.void), runtime).catch(
			() => {},
		);
	}
}

/**
 * Run `use` with the backend executable this installation would spawn (the
 * embedded binary, `dist/server/devenv`, or a source-tree build of it).
 *
 * Used by bounded one-shot backend modes — the catalog read a headless consumer
 * performs when no server is reachable — so a packaged executable can always
 * answer them. An embedded extraction is private to this call and removed
 * afterwards; a development build is kept at the shared `dist/server/devenv`
 * path so it is built once.
 */
export async function withBackendExecutable<T>(
	use: (executable: string) => T | Promise<T>,
	runtime: BackendLayer = BackendRuntimeLive,
): Promise<T> {
	const instance = newInstanceId();
	const resolved = await runBackendProgram(
		Effect.gen(function* () {
			const service = yield* BackendRuntime;
			const binary = yield* service.resolveBinary(instance);
			const executable = yield* ensureExecutable(binary);
			return { executable, isEmbedded: binary.isEmbedded };
		}),
		runtime,
	);
	try {
		return await use(resolved.executable);
	} finally {
		if (resolved.isEmbedded) {
			await runBackendProgram(
				Effect.gen(function* () {
					const service = yield* BackendRuntime;
					yield* service.removeExtractionDir(instance);
				}),
				runtime,
			).catch(() => {});
		}
	}
}
