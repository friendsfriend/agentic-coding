// Named application composition roots for the workflow layer
// (complete-workflow-effect-cutover, task 1). CLI invocation owns a bounded
// layer scope for its command; the dashboard owns one application layer
// shared across refresh/action/start/repair, with repository execution and
// observation running as child scopes through the store service's own
// acquire/release. Guarded services never run their own nested Effect
// runtime — every program is provided with the shared production
// application layer here, at the named composition root.
import { Cause, Chunk, Effect, Exit, Layer, Option } from "effect";
import { WorkflowRuntimeError } from "./contracts.ts";
import type {
	WorkflowClock,
	WorkflowConfig,
	WorkflowStore,
	WorkflowTelemetry,
} from "./runtime/services.ts";
import {
	engineLayer,
	toRuntimeError,
	WorkflowConfigLive,
} from "./runtime/services.ts";

/** The concrete services the production application layer provides. */
export type ApplicationServices =
	| WorkflowConfig
	| WorkflowStore
	| WorkflowClock
	| WorkflowTelemetry;

/** Production application layer: the store, live clock, and provenance-aware
 * config services composed once at the named composition root. Pure succeed
 * services — heavy resources are per-transaction acquire/release inside the
 * store service, so providing this layer never opens files by itself. */
export function applicationLayer(
	now: () => Date = () => new Date(),
): Layer.Layer<ApplicationServices, never, never> {
	return Layer.merge(engineLayer(now), WorkflowConfigLive);
}

/** One application layer owned by a named root. The dashboard shares one
 * instance for its whole lifetime; a CLI invocation builds one for its
 * command and disposes it afterwards. Repository execution and observation
 * run as child scopes through the store service's acquire/release. */
export class WorkflowApplication {
	private layer: Layer.Layer<ApplicationServices, never, never> | null;
	readonly clock: () => Date;

	constructor(now: () => Date = () => new Date()) {
		this.clock = now;
		this.layer = applicationLayer(now);
	}

	private layerFor(): Layer.Layer<ApplicationServices, never, never> {
		this.layer ??= applicationLayer(this.clock);
		return this.layer;
	}

	/** The shared production layer. Exposed to composition roots so the
	 * engine facade consumes the root-owned layer instead of building a
	 * nested runtime of its own (complete-workflow-effect-cutover, task 1). */
	layerOf(): Layer.Layer<ApplicationServices, never, never> {
		return this.layerFor();
	}

	/** Run an Effect program on the owned application layer, surfacing the
	 * typed `WorkflowRuntimeError` (or underlying defect) instead of an
	 * Effect `FiberFailure`. */
	runSync<A>(
		program: Effect.Effect<A, WorkflowRuntimeError, ApplicationServices>,
	): A {
		const exit = Effect.runSyncExit(Effect.provide(program, this.layerFor()));
		if (Exit.isSuccess(exit)) return exit.value;
		const failure = Cause.failureOption(exit.cause);
		if (Option.isSome(failure)) throw failure.value;
		const firstDefect = Chunk.head(Cause.defects(exit.cause));
		if (Option.isSome(firstDefect)) {
			const defect = firstDefect.value;
			if (defect instanceof WorkflowRuntimeError) throw defect;
			throw toRuntimeError(defect);
		}
		throw toRuntimeError(new Error(Cause.pretty(exit.cause)));
	}

	/** Release the owned layer (bounded shutdown finalization); reopening
	 * re-acquires the production layer. */
	dispose(): void {
		this.layer = null;
	}
}

/** CLI-invocation owner: build one application layer for a bounded command
 * lifetime, run the program, then dispose the layer scope. */
export function runCliProgram<A>(
	program: Effect.Effect<A, WorkflowRuntimeError, ApplicationServices>,
	now: () => Date = () => new Date(),
): A {
	const application = new WorkflowApplication(now);
	try {
		return application.runSync(program);
	} finally {
		application.dispose();
	}
}
