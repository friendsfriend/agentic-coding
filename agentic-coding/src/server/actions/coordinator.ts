// Execution-key coordination and resource leases
// (`port-action-execution-to-bun`, tasks 2.1 and 2.5).
//
// Ported from `server/pkg/actionexec/coordinator.go`.
//
// Two rules are load-bearing:
//
//   - one canonical execution owns the work. Two semantic paths that reach the
//     same execution key must run it once; the second lease mirrors the first
//     one's outcome instead of executing again.
//   - a lease that is not the owner never publishes a result. A late result
//     from a cancelled or superseded execution is dropped rather than
//     overwriting the new owner's outcome or killing an adopted resource.
import type { StepOutcome, StepResult } from "./step-result.ts";

export const LEASE_STATE = {
	owner: "owner",
	sharedRunning: "shared-running",
	completed: "completed",
	alreadyRunning: "already-running",
} as const;

export type LeaseState = (typeof LEASE_STATE)[keyof typeof LEASE_STATE];

class Execution {
	readonly done: Promise<void>;
	#resolve: (() => void) | undefined;
	result: StepResult = {};
	complete = false;

	constructor() {
		this.done = new Promise<void>((resolve) => {
			this.#resolve = resolve;
		});
	}

	finish(result: StepResult): void {
		this.result = result;
		this.complete = true;
		this.#resolve?.();
	}
}

export class ClaimConflict extends Error {
	readonly claim: string;
	readonly owner: string;

	constructor(claim: string, owner: string) {
		super(`resource claim already held: ${claim}`);
		this.name = "ClaimConflict";
		this.claim = claim;
		this.owner = owner;
	}
}

export interface ExecutionLease {
	readonly state: LeaseState;
	owner(): boolean;
	/** Undefined until the owning execution publishes an outcome. */
	outcome(): StepOutcome | undefined;
	wait(signal?: AbortSignal): Promise<StepResult>;
	release(result: StepResult): void;
}

export class Coordinator {
	readonly #executions = new Map<string, Execution>();
	readonly #claims = new Map<string, string>();

	/**
	 * `ready` reports an external resource that a previous run left running, so
	 * the action can succeed as `already-running` without executing anything.
	 */
	constructor(private readonly ready?: (key: string) => boolean) {}

	acquire(key: string, claims: readonly string[] = []): ExecutionLease {
		if (this.ready?.(key)) {
			return new Lease(
				LEASE_STATE.alreadyRunning,
				undefined,
				undefined,
				key,
				[],
			);
		}
		const existing = this.#executions.get(key);
		if (existing) {
			return new Lease(
				existing.complete ? LEASE_STATE.completed : LEASE_STATE.sharedRunning,
				existing,
				undefined,
				key,
				[],
			);
		}
		const sorted = [...claims].sort();
		for (const claim of sorted) {
			const owner = this.#claims.get(claim);
			if (owner !== undefined && owner !== key) {
				throw new ClaimConflict(claim, owner);
			}
		}
		for (const claim of sorted) this.#claims.set(claim, key);
		const execution = new Execution();
		this.#executions.set(key, execution);
		return new Lease(LEASE_STATE.owner, execution, this, key, sorted);
	}

	/** Forgets every execution in a run's scope so a retry can execute again. */
	clearScope(scope: string): void {
		const prefix = `${scope}:`;
		for (const key of [...this.#executions.keys()]) {
			if (key.startsWith(prefix)) this.#executions.delete(key);
		}
	}

	/** @internal — the lease releases its own claims through this. */
	releaseClaims(claims: readonly string[], key: string): void {
		for (const claim of claims) {
			if (this.#claims.get(claim) === key) this.#claims.delete(claim);
		}
	}
}

class Lease implements ExecutionLease {
	readonly #state: LeaseState;
	readonly #execution: Execution | undefined;
	readonly #coordinator: Coordinator | undefined;
	readonly #key: string;
	readonly #claims: readonly string[];
	#result: StepResult = {};
	#released = false;

	constructor(
		state: LeaseState,
		execution: Execution | undefined,
		coordinator: Coordinator | undefined,
		key: string,
		claims: readonly string[],
	) {
		this.#state = state;
		this.#execution = execution;
		this.#coordinator = coordinator;
		this.#key = key;
		this.#claims = claims;
	}

	get state(): LeaseState {
		return this.#state;
	}

	owner(): boolean {
		return this.#state === LEASE_STATE.owner;
	}

	outcome(): StepOutcome | undefined {
		if (this.#state === LEASE_STATE.alreadyRunning) return "already-running";
		if (this.#execution?.complete) return this.#execution.result.outcome;
		return this.#result.outcome;
	}

	async wait(signal?: AbortSignal): Promise<StepResult> {
		if (this.#state === LEASE_STATE.alreadyRunning) return this.#result;
		const execution = this.#execution;
		if (!execution) return {};
		if (signal?.aborted) throw abortReason(signal);
		await raceAbort(execution.done, signal);
		return execution.result;
	}

	/**
	 * Publishing a result is owner-only and happens at most once, so a late
	 * result from a cancelled execution cannot overwrite the canonical one.
	 */
	release(result: StepResult): void {
		if (!this.owner() || this.#released) return;
		this.#released = true;
		this.#result = result;
		this.#execution?.finish(result);
		this.#coordinator?.releaseClaims(this.#claims, this.#key);
	}
}

function abortReason(signal: AbortSignal): Error {
	const reason: unknown = signal.reason;
	if (reason instanceof Error) return reason;
	return new Error("aborted");
}

function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(abortReason(signal));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}
