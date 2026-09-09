// Effect service boundaries for the workflow runtime (migrate-workflow-runtime-to-effect).
// The store service owns SQLite handle acquisition/close through Effect scopes and
// exposes the non-suspending synchronous transaction primitive; the clock service is
// the single live/test clock for ownership decisions. Layers are assembled at the
// engine composition root; business modules never construct these dependencies.
//
// The synchronous SQL primitives in `store.ts` remain the implementation detail of the
// transaction's critical section: once `BEGIN IMMEDIATE` succeeds, validation,
// authorization, reduction, writes, and commit/rollback run synchronously on the handle
// (no `yield*`, await, sleep, retry, or nested runtime execution inside the callback).
import type { Database } from "bun:sqlite";
import { Context, Effect, Layer } from "effect";
import {
	type WorkflowExecutionSettings,
	WorkflowRuntimeError,
} from "../contracts.ts";
import {
	type ConfigOptions,
	type ConfigProvenance,
	executionSettings,
	loadConfigWithProvenance,
	type ResolvedWorkflowConfig,
	type WorkflowConfig as WorkflowConfigValue,
} from "../effects.ts";
import { type TelemetryEnvelope, TelemetrySink } from "../observability.ts";
import {
	initializeStore,
	type ObservedStore,
	observedStore,
	openStore,
	rollback,
} from "./store.ts";

/** Map any synchronous throw to the runtime's typed failure. Expected
 * `WorkflowRuntimeError` instances pass through unchanged (preserving their
 * code/message/currentRevision); unexpected throws become a bounded
 * `unavailable` failure so the facade rethrows an `Error` with the original
 * message. */
export function toRuntimeError(error: unknown): WorkflowRuntimeError {
	if (error instanceof WorkflowRuntimeError) return error;
	return new WorkflowRuntimeError(
		"unavailable",
		error instanceof Error ? error.message : String(error),
	);
}

export interface WorkflowStoreShape {
	/** Run a single non-suspending synchronous critical section on a writable
	 * handle owned by the service: open/close via a scope and `BEGIN IMMEDIATE`,
	 * validation, reduction, writes, `COMMIT`/`ROLLBACK` all run synchronously
	 * on that handle with no `yield*`/sleep/retry/nested runtime inside `fn`. */
	readonly transaction: <A>(
		repo: string,
		fn: (db: Database) => A,
	) => Effect.Effect<A, WorkflowRuntimeError>;
	/** Autocommit scoped write used only outside command transactions (legacy
	 * import owns its own transaction control). */
	readonly write: <A>(
		repo: string,
		fn: (db: Database) => A,
	) => Effect.Effect<A, WorkflowRuntimeError>;
	/** Initialize the canonical store (and import legacy rows) exactly once. */
	readonly initialize: (
		repo: string,
	) => Effect.Effect<void, WorkflowRuntimeError>;
	/** Observation-only store metadata; never mutates or claims. */
	readonly observed: (
		repo: string,
	) => Effect.Effect<ObservedStore | undefined, WorkflowRuntimeError>;
}

/** Concrete workflow store dependency. */
export class WorkflowStore extends Context.Tag("workflow/WorkflowStore")<
	WorkflowStore,
	WorkflowStoreShape
>() {}

export interface WorkflowClockShape {
	readonly now: () => Date;
}

/** Concrete single clock used for claims, renewal, liveness, expiry, and
 * command-time validation. Tests inject a controlled clock here. */
export class WorkflowClock extends Context.Tag("workflow/WorkflowClock")<
	WorkflowClock,
	WorkflowClockShape
>() {}

/** Concrete configuration service: provenance-resolved workflow config reads
 * and execution-settings preflight at the Effect boundary, backed by the same
 * TOML precedence/provenance semantics as `effects.ts`. */
export interface WorkflowConfigShape {
	readonly load: (
		options?: ConfigOptions,
	) => Effect.Effect<ResolvedWorkflowConfig, WorkflowRuntimeError>;
	readonly executionSettingsOf: (
		config: WorkflowConfigValue,
		provenance: ConfigProvenance,
	) => Effect.Effect<WorkflowExecutionSettings, WorkflowRuntimeError>;
}

export class WorkflowConfig extends Context.Tag("workflow/WorkflowConfig")<
	WorkflowConfig,
	WorkflowConfigShape
>() {}

/** Production configuration layer over the real config files. */
export const WorkflowConfigLive: Layer.Layer<WorkflowConfig, never> =
	Layer.succeed(WorkflowConfig, {
		load: (options) =>
			Effect.try({
				try: () => loadConfigWithProvenance(options),
				catch: toRuntimeError,
			}),
		executionSettingsOf: (config, provenance) =>
			Effect.try({
				try: () => executionSettings(config, provenance),
				catch: toRuntimeError,
			}),
	});

/** Production store layer backed by the real canonical SQLite files. */
export const WorkflowStoreLive: Layer.Layer<WorkflowStore, never> =
	Layer.succeed(WorkflowStore, {
		transaction: (repo, fn) =>
			Effect.scoped(
				Effect.acquireRelease(
					Effect.try({
						try: () => openStore(repo),
						catch: toRuntimeError,
					}),
					(db) => Effect.sync(() => db.close()),
				).pipe(
					Effect.flatMap((db) =>
						Effect.try({
							try: () => {
								db.exec("BEGIN IMMEDIATE");
								const result = fn(db);
								db.exec("COMMIT");
								return result;
							},
							catch: (error) => {
								rollback(db);
								return toRuntimeError(error);
							},
						}),
					),
				),
			),
		write: (repo, fn) =>
			Effect.scoped(
				Effect.acquireRelease(
					Effect.try({
						try: () => openStore(repo),
						catch: toRuntimeError,
					}),
					(db) => Effect.sync(() => db.close()),
				).pipe(
					Effect.flatMap((db) =>
						Effect.try({
							try: () => fn(db),
							catch: toRuntimeError,
						}),
					),
				),
			),
		initialize: (repo) =>
			Effect.try({
				try: () => initializeStore(repo),
				catch: toRuntimeError,
			}),
		observed: (repo) =>
			Effect.try({
				try: () => observedStore(repo),
				catch: toRuntimeError,
			}),
	});

/** Build a clock layer from a concrete `now` reader (real or test-controlled). */
export function WorkflowClockLive(
	now: () => Date,
): Layer.Layer<WorkflowClock, never> {
	return Layer.succeed(WorkflowClock, { now });
}

/** Merge of the runtime's production store and a given clock. */
export function engineLayer(
	now: () => Date,
): Layer.Layer<WorkflowStore | WorkflowClock | WorkflowTelemetry, never> {
	return Layer.merge(
		WorkflowStoreLive,
		Layer.merge(WorkflowClockLive(now), WorkflowTelemetryLive),
	);
}

/** Concrete workflow telemetry dependency: one bounded emission boundary for
 * JSONL envelope writes (never raises) and bracketed OTLP export within the
 * fixed `TELEMETRY_FLUSH_BUDGET_MS` budget (complete-workflow-effect-cutover,
 * task 2.4). Emitting through the service keeps engine programs off raw
 * filesystem/network I/O and guarantees export failure is observational — it
 * never rolls back or re-plays a committed command. */
export interface WorkflowTelemetryShape {
	readonly emit: (directory: string, envelope: TelemetryEnvelope) => void;
}

export class WorkflowTelemetry extends Context.Tag(
	"workflow/WorkflowTelemetry",
)<WorkflowTelemetry, WorkflowTelemetryShape>() {}

/** Production telemetry layer over the bounded JSONL/export sink. */
export const WorkflowTelemetryLive: Layer.Layer<WorkflowTelemetry, never> =
	Layer.succeed(WorkflowTelemetry, {
		emit: (directory, envelope) => new TelemetrySink(directory).emit(envelope),
	});
