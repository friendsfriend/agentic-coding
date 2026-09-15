// The environment action executor (`port-action-execution-to-bun`, tasks 2.1,
// 2.4 and 2.5).
//
// Ported from `server/pkg/actionexec/{engine,projection}.go`.
//
// The engine is deliberately small, and every rule it holds is one the spec
// names explicitly:
//
//   - **One canonical execution.** A step with an execution key runs once; a
//     second semantic node that reaches the same key emits a *reference* and
//     mirrors the canonical outcome, so a tree can show both relationships
//     without executing the work twice (task 2.1).
//   - **Failure policy is the engine's decision.** `always-run` and
//     `on-failure` steps execute after a failure; everything else is skipped
//     (task 2.4). A handler never decides this.
//   - **Already-running is a success without a command.** The coordinator's
//     ready probe short-circuits the step, so no startup command is invented
//     (task 2.6).
//   - **Only the owner publishes.** A lease that is not the owner waits; a late
//     result from a superseded execution cannot overwrite the canonical one
//     (task 2.5).
//
// This is not the workflow state machine and it has no durable outbox: an
// environment action run is a live, in-memory execution whose history record is
// the projection of its events.
import type { ActionDefinition, ActionStepDefinition } from "@devenv/types";
import { type Coordinator, LEASE_STATE } from "./coordinator.ts";
import type {
	HandlerContext,
	StepHandler,
	StepKind,
	StepOutcome,
	StepResult,
} from "./step-result.ts";
import {
	FAILURE_POLICY,
	OUTCOME,
	STEP_CONDITION,
	STEP_KIND,
} from "./step-result.ts";
import { type Value, ValueStore } from "./values.ts";

export interface EngineEvent {
	type: string;
	runId: string;
	stepId: string;
	outcome?: StepOutcome;
	label?: string;
	canonicalId?: string;
	reference?: boolean;
	error?: string;
	at: string;
}

export interface EventSink {
	emit(event: EngineEvent): void;
}

export interface RunResult {
	runId: string;
	outcome?: StepOutcome;
	error?: Error;
}

export interface EngineOptions {
	handlers: ReadonlyMap<string, CommandStepHandler>;
	events?: EventSink;
	coordinator?: Coordinator;
}

/**
 * A step handler receives the step descriptor and the run context; the engine
 * owns the surrounding policy. `step-result.ts` describes the boundary.
 */
export interface CommandStepHandler {
	execute(
		context: HandlerContext,
		step: ActionStepDefinition,
	): StepResult | Promise<StepResult>;
}

export class Engine {
	constructor(private readonly options: EngineOptions) {}

	async run(
		signal: AbortSignal,
		runId: string,
		definition: ActionDefinition,
		inputs: ReadonlyMap<string, Value> = new Map(),
	): Promise<RunResult> {
		const values = new ValueStore(inputs);
		const runner = new Runner({
			signal,
			runId,
			handlers: this.options.handlers,
			events: this.options.events,
			values,
			coordinator: this.options.coordinator,
		});
		try {
			const result = await runner.execute(definition.root);
			return { runId, outcome: result.outcome, error: result.error };
		} finally {
			this.options.coordinator?.clearScope(runId);
		}
	}
}

interface RunnerOptions {
	signal: AbortSignal;
	runId: string;
	handlers: ReadonlyMap<string, CommandStepHandler>;
	events?: EventSink;
	values: ValueStore;
	coordinator?: Coordinator;
}

class Runner {
	readonly #signal: AbortSignal;
	readonly #runId: string;
	readonly #handlers: ReadonlyMap<string, CommandStepHandler>;
	readonly #events?: EventSink;
	readonly #values: ValueStore;
	readonly #coordinator?: Coordinator;
	/** Execution key → the step id that canonically owns the work. */
	readonly #canonical = new Map<string, string>();

	constructor(options: RunnerOptions) {
		this.#signal = options.signal;
		this.#runId = options.runId;
		this.#handlers = options.handlers;
		this.#events = options.events;
		this.#values = options.values;
		this.#coordinator = options.coordinator;
	}

	async execute(step: ActionStepDefinition): Promise<StepResult> {
		const executionKey = step.executionKey;
		const coordinator = this.#coordinator;
		if (!coordinator || !executionKey) return this.#executeOwned(step);

		// The key is scoped to the run: the same dependency in a later run is a
		// new execution, and a retry is decided by the ready probe, not by a
		// stale lease from the previous one.
		const lease = coordinator.acquire(
			`${this.#runId}:${executionKey}`,
			stepClaims(step),
		);
		if (!lease.owner()) {
			if (lease.state === LEASE_STATE.alreadyRunning) {
				// Already running is an explicit successful outcome: the step is
				// announced and completed with the outcome, and no command is
				// invented for work that did not execute. Go marks this as a bare
				// shared reference, which leaves the run-tree node active forever.
				this.#emit({
					type: "step.started",
					stepId: step.id,
					label: step.label,
				});
				this.#emit({
					type: "step.completed",
					stepId: step.id,
					outcome: OUTCOME.alreadyRunning,
				});
				return { outcome: OUTCOME.alreadyRunning };
			}
			this.#emit({
				type: "step.reference",
				stepId: step.id,
				canonicalId: this.#canonical.get(executionKey),
				reference: true,
				label: step.label,
			});
			let result: StepResult;
			try {
				result = await lease.wait(this.#signal);
			} catch (error) {
				return { outcome: OUTCOME.failed, error: asError(error) };
			}
			if (lease.outcome() === OUTCOME.alreadyRunning) {
				result = { ...result, outcome: OUTCOME.alreadyRunning };
			}
			return result;
		}

		this.#canonical.set(executionKey, step.id);
		const result = await this.#executeOwned(step);
		lease.release(result);
		return result;
	}

	async #executeOwned(step: ActionStepDefinition): Promise<StepResult> {
		// Cancellation stops children before they start, but never a cleanup step:
		// releasing a lease or killing an adopted process has to still run.
		if (
			this.#signal.aborted &&
			step.kind !== STEP_KIND.composite &&
			step.failurePolicy !== FAILURE_POLICY.alwaysRun
		) {
			return { outcome: OUTCOME.failed, error: abortError(this.#signal) };
		}
		this.#emit({ type: "step.started", stepId: step.id, label: step.label });
		let result: StepResult;
		if (step.kind === STEP_KIND.composite) {
			result = await this.#executeComposite(step);
		} else {
			const handler = this.#handlers.get(step.kind);
			if (!handler) {
				result = {
					outcome: OUTCOME.failed,
					error: new Error(`no handler for ${step.kind}`),
				};
			} else {
				try {
					result = await handler.execute(this.#context(step.id), step);
				} catch (error) {
					result = { outcome: OUTCOME.failed, error: asError(error) };
				}
			}
		}
		if (result.outcome === undefined) {
			result = {
				...result,
				outcome: result.error ? OUTCOME.failed : OUTCOME.executed,
			};
		}
		const failed =
			result.error !== undefined || result.outcome === OUTCOME.failed;
		this.#emit({
			type: failed ? "step.failed" : "step.completed",
			stepId: step.id,
			outcome: result.outcome,
			...(result.error ? { error: result.error.message } : {}),
		});
		return result;
	}

	async #executeComposite(step: ActionStepDefinition): Promise<StepResult> {
		let failed = false;
		let firstError: Error | undefined;
		for (const child of step.children ?? []) {
			const always =
				child.failurePolicy === FAILURE_POLICY.alwaysRun ||
				child.condition === STEP_CONDITION.always;
			if (failed && !always) continue;
			if (!failed && child.condition === STEP_CONDITION.onFailure) continue;
			const result = await this.execute(child);
			if (result.error || result.outcome === OUTCOME.failed) {
				failed = true;
				if (!firstError) firstError = result.error;
			}
		}
		if (!failed) return { outcome: OUTCOME.executed };
		return {
			outcome: OUTCOME.failed,
			error: firstError ?? new Error("child step failed"),
		};
	}

	#context(stepId: string): HandlerContext {
		return {
			signal: this.#signal,
			runId: this.#runId,
			stepId,
			values: this.#values,
		};
	}

	#emit(event: Omit<EngineEvent, "runId" | "at">): void {
		this.#events?.emit({
			...event,
			runId: this.#runId,
			at: new Date().toISOString(),
		});
	}
}

/** The resource claims a step holds for the duration of its execution. */
export function stepClaims(step: ActionStepDefinition): string[] {
	const raw = step.configuration?.resourceClaims;
	if (!Array.isArray(raw)) return [];
	return raw.filter((claim): claim is string => typeof claim === "string");
}

function abortError(signal: AbortSignal): Error {
	const reason: unknown = signal.reason;
	if (reason instanceof Error) return reason;
	return new Error("context canceled");
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

export type { StepHandler, StepKind };
export { STEP_KIND };
