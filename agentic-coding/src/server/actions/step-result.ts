// Step execution results and the step-kind contract
// (`port-action-execution-to-bun`, tasks 2.1–2.6).
//
// Ported from `server/pkg/actiondef/{types.go,descriptor.go}`.
//
// A step handler answers one question: what happened. It never decides whether
// the run continues — the engine applies the step's condition and failure
// policy — and it never writes history directly. That split is what keeps one
// leaf per executed command (task 2.3) and makes `always-run` cleanup (task 2.4)
// a single engine rule instead of a handler-by-handler convention.

import type { ValueStore } from "./values.ts";

export type StepOutcome = "executed" | "already-running" | "skipped" | "failed";

export const OUTCOME = {
	executed: "executed",
	alreadyRunning: "already-running",
	skipped: "skipped",
	failed: "failed",
} as const satisfies Record<string, StepOutcome>;

export interface StepResult {
	outcome?: StepOutcome;
	exitCode?: number;
	error?: Error;
}

/** Step kinds. `composite` executes children; every other kind needs a handler. */
export const STEP_KIND = {
	composite: "composite",
	command: "command",
	process: "process",
	readiness: "readiness",
	operation: "operation",
	cleanup: "cleanup",
} as const;

export type StepKind = (typeof STEP_KIND)[keyof typeof STEP_KIND] | string;

export const STEP_CONDITION = {
	always: "always",
	onSuccess: "on-success",
	onFailure: "on-failure",
} as const;

export const FAILURE_POLICY = {
	stop: "stop",
	continue: "continue",
	alwaysRun: "always-run",
} as const;

/**
 * The subset of a compiled step descriptor a handler reads. Handlers receive
 * the whole `ActionStepDefinition`, so this is only the part they rely on.
 */
export interface HandlerContext {
	/** Cancelled when the action is cancelled or its deadline passes. */
	readonly signal: AbortSignal;
	readonly runId: string;
	readonly stepId: string;
	/**
	 * The run's named values. Steps publish what they produce here and read what
	 * earlier steps produced; `resolveValueTemplates` is the only reader that
	 * turns them into argv.
	 */
	readonly values: ValueStore;
}

export interface StepHandler<Step = unknown> {
	execute(context: HandlerContext, step: Step): Promise<StepResult>;
}
