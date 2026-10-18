// Fail fast on a run whose tool surface is dead (efficiency backlog item 3).
//
// Nothing used to cut a run short when every tool call failed: the agent kept
// taking turns — each one re-reading the whole context — against a broken tool
// host, a denied sandbox or a wrong working directory. This module is the
// detection: a per-run counter of consecutive failed calls and of successes,
// and one decision — re-probe the tool host once, or stop the run — derived
// from the tool-call telemetry shape (`ok` plus a machine-readable failure
// kind) the runtime now records for every call.
//
// The rule is deliberately about a surface that *never* worked: a run that has
// had one successful call is never surface-dead, however badly it is going.

import { redactToolText, type ToolFailureKind } from "./tool-telemetry.ts";

/** Consecutive broken-surface failures, with zero successful calls in the run,
 * that trip detection. Five is the documented default: one failed call is
 * ordinary, five in a row from a surface no call has ever reached are not. */
export const FAIL_FAST_CONSECUTIVE_FAILURES = 5;

/** Turns a run may take without a single successful call before failures that
 * are all one tool's are treated as a dead surface as well. The counter is the
 * run's own turn count (zero-based turn indexes, so turn 14 is the 15th turn). */
export const FAIL_FAST_TURNS_WITHOUT_SUCCESS = 15;

/** The failure kinds that mean the surface is broken rather than the request
 * being wrong. `not-found` and `no-match` are deliberately absent: reading a
 * path that does not exist yet, or editing text that is not there, is ordinary
 * exploration and must never end a run. */
export const SURFACE_DEAD_KINDS: readonly ToolFailureKind[] = [
	"host-error",
	"denied",
	"timeout",
	"aborted",
	"invalid-args",
	"other",
];

export function isSurfaceDeadKind(kind: ToolFailureKind): boolean {
	return SURFACE_DEAD_KINDS.includes(kind);
}

/** Roles whose first failing calls are expected evidence rather than a broken
 * surface, verified against the code that writes them:
 *
 * - `env-setup` (`ENV_SETUP_ROLE`, `src/workflow/steps/env-setup.ts`): its brief
 *   says that when the environment tools are unavailable it must report what it
 *   authored and hand off `blocked` naming the missing server, so a first call
 *   `env_*` cannot answer is its own finding, not a dead host.
 * - `debug` (`DEBUG_ROLE`, `src/workflow/steps/debug.ts`): its brief says to
 *   read a failure rather than guess (`env_start` fails with `run-exited`, a
 *   start that failed holds nothing), so a failing call is the evidence a debug
 *   run is asked for.
 *
 * An orchestrator conversation is not an engine run at all and never carries a
 * run id, which is why it needs no entry here. */
export const FAIL_FAST_EXEMPT_ROLES: readonly string[] = ["env-setup", "debug"];

export function failFastEligibleRole(role: string | undefined): boolean {
	return role !== undefined && !FAIL_FAST_EXEMPT_ROLES.includes(role);
}

/** Bound of the `blocked` handoff message (and so of the attention line the
 * engine derives from it). */
export const FAIL_FAST_MESSAGE_LIMIT = 400;
/** Bound of the one error line kept from a failed call. */
export const FAIL_FAST_ERROR_LINE_LIMIT = 120;

/** What the monitor knows when it decides. Counts and a fixed vocabulary only:
 * no argument text, no result payload. */
export interface ToolSurfaceFacts {
	/** The last tool that failed. */
	readonly tool: string;
	/** Every failure kind seen in this run, unique, in first-seen order. */
	readonly failureKinds: readonly ToolFailureKind[];
	/** Consecutive failed calls at the moment of the decision. */
	readonly consecutiveFailures: number;
	/** Successful calls in this run so far (always 0 when a decision is made). */
	readonly successes: number;
	/** Turns the run has taken. */
	readonly turns: number;
	/** One bounded, redacted line of the last failure, when there was one. */
	readonly lastError?: string;
}

export type FailFastDecision =
	/** Give the run one more turn after re-probing the tool host. */
	| { readonly action: "probe"; readonly facts: ToolSurfaceFacts }
	/** End the run: its `blocked` handoff carries {@link message}. */
	| {
			readonly action: "blocked";
			readonly facts: ToolSurfaceFacts;
			readonly message: string;
	  };

/** One observed tool result, as the runtime telemetry stream reports it. */
export interface ToolOutcomeInput {
	readonly tool: string;
	readonly ok: boolean;
	readonly kind?: ToolFailureKind;
	readonly errorLine?: string;
	readonly turn?: number;
}

/**
 * The per-run counter. `observe` is called once per finished tool call and
 * answers the one decision the caller has to act on — nothing at all while the
 * surface is fine, `probe` once (the run gets one more turn), and `blocked` if a
 * call fails again afterwards.
 */
export class ToolSurfaceMonitor {
	#successes = 0;
	#consecutiveFailures = 0;
	#surfaceDeadStreak = 0;
	#tools = new Set<string>();
	#kinds: ToolFailureKind[] = [];
	#lastError: string | undefined;
	#lastTool = "";
	#turns = 0;
	/** The one re-probe was requested; the next failure ends the run. */
	#probeSpent = false;
	#done = false;

	observe(input: ToolOutcomeInput): FailFastDecision | undefined {
		if (this.#done) return undefined;
		if (input.turn !== undefined && input.turn >= 0)
			this.#turns = Math.max(this.#turns, input.turn + 1);
		if (input.ok) {
			this.#successes += 1;
			this.#consecutiveFailures = 0;
			this.#surfaceDeadStreak = 0;
			return undefined;
		}
		this.#consecutiveFailures += 1;
		this.#surfaceDeadStreak =
			input.kind !== undefined && isSurfaceDeadKind(input.kind)
				? this.#surfaceDeadStreak + 1
				: 0;
		this.#tools.add(input.tool);
		this.#lastTool = input.tool;
		if (input.kind !== undefined && !this.#kinds.includes(input.kind))
			this.#kinds.push(input.kind);
		if (input.errorLine) this.#lastError = input.errorLine;
		// The rule is about a surface that never worked. One successful call
		// anywhere in the run disables it for the rest of the run.
		if (this.#successes > 0) return undefined;
		// Past the one re-probe the next failure ends the run whatever its kind
		// is: the extra turn was the retry.
		if (this.#probeSpent) return this.#block();
		if (!this.#deadSurface()) return undefined;
		this.#probeSpent = true;
		return { action: "probe", facts: this.#facts() };
	}

	#deadSurface(): boolean {
		return (
			this.#surfaceDeadStreak >= FAIL_FAST_CONSECUTIVE_FAILURES ||
			(this.#turns >= FAIL_FAST_TURNS_WITHOUT_SUCCESS && this.#tools.size === 1)
		);
	}

	#block(): FailFastDecision {
		this.#done = true;
		const facts = this.#facts();
		return { action: "blocked", facts, message: failFastHandoffMessage(facts) };
	}

	#facts(): ToolSurfaceFacts {
		return {
			tool: this.#lastTool || "(unknown)",
			failureKinds: [...this.#kinds],
			consecutiveFailures: this.#consecutiveFailures,
			successes: this.#successes,
			turns: this.#turns,
			...(this.#lastError ? { lastError: this.#lastError } : {}),
		};
	}
}

/** The monitor a run's environment earns, or `undefined` for a session the rule
 * must leave alone: anything without a run id (the orchestrator conversation
 * has none) and the exempt roles. */
export function toolSurfaceMonitorFor(
	env: Readonly<Record<string, string>>,
): ToolSurfaceMonitor | undefined {
	if (!env.HERDR_RUN_ID) return undefined;
	if (!failFastEligibleRole(env.HERDR_ROLE)) return undefined;
	return new ToolSurfaceMonitor();
}

/** The bounded, secret-free `blocked` handoff message: the tool, the failure
 * kinds, the count, the turns and one short error line — never a payload. */
export function failFastHandoffMessage(facts: ToolSurfaceFacts): string {
	const kinds =
		facts.failureKinds.length > 0
			? facts.failureKinds.join(", ")
			: "(unrecorded)";
	const parts = [
		`tool surface dead: ${facts.consecutiveFailures} consecutive failed ${facts.tool} calls with no successful call in this run`,
		`failure kind(s): ${kinds}`,
		`turns taken: ${facts.turns}`,
	];
	if (facts.lastError) parts.push(`last error: ${facts.lastError}`);
	const text = redactToolText(parts.join("; ")).replace(/\s+/g, " ").trim();
	return text.length > FAIL_FAST_MESSAGE_LIMIT
		? `${text.slice(0, FAIL_FAST_MESSAGE_LIMIT - 1)}…`
		: text;
}
