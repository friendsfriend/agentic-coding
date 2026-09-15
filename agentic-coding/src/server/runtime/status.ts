// Runtime status normalization and operation status
// (`port-environment-runtimes-to-bun`, task 4.4).
//
// Ported from `server/pkg/runstatus/status.go` and
// `server/pkg/status/manager.go`.
//
// Two rules are load-bearing:
//
//   - runtime type never affects priority: the highest-ranked *observation*
//     wins, so a running container is never hidden by a stopped Kubernetes
//     reading of the same app;
//   - observation failure is not absence: `error`/unavailable readings rank
//     below every real state instead of collapsing to "stopped", so a status
//     read never claims a resource is gone because the runtime was unreachable.
export type RuntimeState =
	| "running"
	| "starting"
	| "failed"
	| "stopped"
	| "unknown";

export interface RuntimeStatus {
	state: RuntimeState;
	detail?: string;
}

export function runtimeStatusString(status: RuntimeStatus): string {
	return status.detail === undefined || status.detail === ""
		? status.state
		: `${status.state} (${status.detail})`;
}

export interface RuntimeCandidate {
	source: string;
	status: string;
}

/** Ranks user-visible runtime states; runtime type never affects priority. */
export function rank(status: string): number {
	switch (state(status)) {
		case "running":
			return 5;
		case "starting":
			return 4;
		case "failed":
			return 3;
		case "stopped":
			return 2;
		default:
			return 1;
	}
}

/** Normalizes detailed provider output such as `running (1/1 pods)`. */
export function state(status: string): RuntimeState {
	const value = status.trim().toLowerCase();
	if (
		value.startsWith("running") ||
		value.startsWith("healthy") ||
		value.startsWith("up")
	) {
		return "running";
	}
	if (
		value.startsWith("starting") ||
		value.startsWith("pending") ||
		value.startsWith("creating") ||
		value.startsWith("restarting")
	) {
		return "starting";
	}
	if (
		value.startsWith("failed") ||
		value.startsWith("error") ||
		value.startsWith("unhealthy") ||
		value.includes("crash")
	) {
		return "failed";
	}
	if (
		value.startsWith("stopped") ||
		value.startsWith("exited") ||
		value.startsWith("not found") ||
		value.startsWith("unknown") ||
		value.startsWith("down") ||
		value === ""
	) {
		return "stopped";
	}
	return "unknown";
}

const PREFIXES = [
	"running",
	"healthy",
	"up",
	"starting",
	"pending",
	"creating",
	"restarting",
	"failed",
	"error",
	"unhealthy",
	"crash",
	"stopped",
	"exited",
	"not found",
	"unknown",
	"down",
] as const;

export function normalize(status: string): RuntimeStatus {
	const normalized = state(status);
	const value = status.trim();
	const lower = value.toLowerCase();
	for (const prefix of PREFIXES) {
		if (!lower.startsWith(prefix)) continue;
		let detail = value.slice(prefix.length).trim();
		if (detail.startsWith("(") && detail.endsWith(")")) {
			detail = detail.slice(1, -1).trim();
		}
		return detail === ""
			? { state: normalized }
			: { state: normalized, detail };
	}
	return { state: normalized };
}

/** The highest-priority observation; equal states aggregate as `N targets`. */
export function selectStatus(
	candidates: readonly RuntimeCandidate[],
): RuntimeStatus {
	if (candidates.length === 0) return { state: "stopped" };
	let bestRank = -1;
	let best: RuntimeCandidate[] = [];
	for (const candidate of candidates) {
		const value = rank(candidate.status);
		if (value > bestRank) {
			bestRank = value;
			best = [candidate];
			continue;
		}
		if (value === bestRank) best = [...best, candidate];
	}
	const selected = state(best[0].status);
	if (selected === "stopped" || selected === "unknown") {
		return { state: "stopped" };
	}
	if (best.length > 1) {
		return { state: selected, detail: `${best.length} targets` };
	}
	return normalize(best[0].status);
}

export function select(candidates: readonly RuntimeCandidate[]): string {
	return runtimeStatusString(selectStatus(candidates));
}

// --- operation status -----------------------------------------------------

export type OperationType =
	| "build"
	| "test"
	| "run"
	| "start"
	| "stop"
	| "checkout"
	| "push"
	| "pull"
	| "fetch"
	| "script";

export type StatusType = "pending" | "active" | "completed" | "failed";

export interface OperationStatus {
	operation: OperationType;
	status: StatusType;
	message: string;
	timestamp: string;
	autoClear: boolean;
	clearAfterMs: number;
}

/** Auto-clear delay for a terminal operation status, as Go used. */
export const STATUS_CLEAR_AFTER_MS = 2000;

const INITIAL_MESSAGE: Record<OperationType, string> = {
	build: "Building...",
	test: "Testing...",
	run: "Running...",
	start: "Starting...",
	stop: "Stopping...",
	checkout: "Checking out...",
	push: "Pushing...",
	pull: "Pulling...",
	fetch: "Fetching...",
	script: "Running script...",
};

/**
 * The transient operation status one ident shows. `startOperation` returns the
 * callback the operation reports progress through, exactly as Go's did.
 */
export class StatusManager {
	readonly #statuses = new Map<string, OperationStatus>();
	readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly now: () => Date;

	constructor(now: () => Date = () => new Date()) {
		this.now = now;
	}

	startOperation(
		ident: string,
		operation: OperationType,
	): (message: string) => void {
		this.setStatus(ident, operation, "active", INITIAL_MESSAGE[operation]);
		return (message: string) => {
			this.setStatus(ident, operation, classify(message), message);
		};
	}

	setStatus(
		ident: string,
		operation: OperationType,
		statusType: StatusType,
		message: string,
	): void {
		const autoClear = statusType === "completed" || statusType === "failed";
		this.#statuses.set(ident, {
			operation,
			status: statusType,
			message,
			timestamp: this.now().toISOString(),
			autoClear,
			clearAfterMs: STATUS_CLEAR_AFTER_MS,
		});
		const existing = this.#timers.get(ident);
		if (existing) {
			clearTimeout(existing);
			this.#timers.delete(ident);
		}
		if (!autoClear) return;
		this.#timers.set(
			ident,
			setTimeout(() => {
				this.clearStatus(ident);
			}, STATUS_CLEAR_AFTER_MS),
		);
	}

	getStatus(ident: string): OperationStatus | undefined {
		const status = this.#statuses.get(ident);
		return status === undefined ? undefined : { ...status };
	}

	getAllStatuses(): Map<string, OperationStatus> {
		return new Map(
			[...this.#statuses].map(([ident, status]) => [ident, { ...status }]),
		);
	}

	clearStatus(ident: string): void {
		if (!this.#statuses.delete(ident)) return;
		const timer = this.#timers.get(ident);
		if (timer) {
			clearTimeout(timer);
			this.#timers.delete(ident);
		}
	}

	isActiveOperation(ident: string): boolean {
		return this.#statuses.get(ident)?.status === "active";
	}

	getFormattedStatus(ident: string): string {
		return this.#statuses.get(ident)?.message ?? "";
	}

	/** Stops every auto-clear timer, so a shutdown leaves nothing scheduled. */
	stop(): void {
		for (const timer of this.#timers.values()) clearTimeout(timer);
		this.#timers.clear();
	}
}

/** Classifies a progress message the way Go's callback did. */
export function classify(message: string): StatusType {
	const lower = message.toLowerCase();
	if (
		message === "completed" ||
		message === "start successful" ||
		message === "build successful" ||
		lower.includes("completed") ||
		lower.includes("successful") ||
		lower.includes("stopped")
	) {
		return "completed";
	}
	if (isErrorMessage(message) || lower.includes("failed")) return "failed";
	return "active";
}

function isErrorMessage(message: string): boolean {
	return (
		message.length > 5 &&
		(message.startsWith("Error:") || message.startsWith("error:"))
	);
}

/**
 * Docker's status text as a runtime observation: `not found` and `error` both
 * read as stopped for the container source, because the container source cannot
 * distinguish "the daemon is down" from "the container is gone" — the Kubernetes
 * or shell observation is what raises the selected state when it disagrees.
 */
export function dockerRuntimeStatus(status: string): string {
	if (status !== "" && status !== "not found" && status !== "error") {
		return status.toLowerCase();
	}
	return "stopped";
}
