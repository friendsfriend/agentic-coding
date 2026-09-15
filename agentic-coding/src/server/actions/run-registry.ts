// Environment-action run tree, reservation and history retention
// (`port-action-execution-to-bun`, task 1.4).
//
// Ported from `server/pkg/actionrun/{types,registry,snapshot}.go`.
//
// A run is the record the TUI renders and the history endpoint replays: its
// steps, each step's commands with their exact stdout/stderr/exit code, and the
// version and definition snapshot the run was compiled from. Two properties
// matter most:
//
//   - `definitionSnapshot` strips everything executable (step configuration) and
//     everything protected (secret and ephemeral values), so history is readable
//     and safe to serve.
//   - a run keeps the registry version and snapshot it started with, so a
//     configuration reload can never relabel an active or historical run.
//
// The Go registry guards its maps with a mutex; Bun runs one event loop, so the
// equivalent guarantee here is that every mutation goes through one synchronous
// method and no `await` happens inside it.
import type {
	ActionCommand,
	ActionDefinition,
	ActionInputDefinition,
	ActionRun,
	ActionRunStatus,
	ActionStep,
	ActionStepDefinition,
	ActionValuePort,
	ActionValueVisibility,
} from "@devenv/types";

export const RUN_STATUS = {
	pending: "pending",
	active: "active",
	completed: "completed",
	// A cancelled run is recorded under its own status; the shared status type
	// keeps it with the other terminal states.
	canceled: "canceled",
	failed: "failed",
} as const satisfies Record<string, ActionRunStatus>;

/** History is kept for a day; older finished runs are pruned. */
export const HISTORY_RETENTION_MS = 24 * 60 * 60 * 1000;

export type { ActionCommand, ActionRun, ActionRunStatus, ActionStep };

const PROTECTED_VISIBILITY: readonly ActionValueVisibility[] = [
	"secret",
	"ephemeral",
];

function isProtected(visibility: ActionValueVisibility | undefined): boolean {
	return visibility !== undefined && PROTECTED_VISIBILITY.includes(visibility);
}

function visiblePorts(
	ports: readonly ActionValuePort[] | undefined,
): ActionValuePort[] {
	return (ports ?? [])
		.filter((port) => !isProtected(port.visibility))
		.map((port) => ({ ...port }));
}

function snapshotStep(step: ActionStepDefinition): ActionStepDefinition {
	return {
		...step,
		configuration: undefined,
		...(step.consumes ? { consumes: visiblePorts(step.consumes) } : {}),
		...(step.produces ? { produces: visiblePorts(step.produces) } : {}),
		...(step.children
			? { children: step.children.map(snapshotStep) }
			: { children: undefined }),
	};
}

/**
 * Removes executable configuration, protected input defaults and secret or
 * ephemeral ports from a definition while preserving the history chrome
 * (ids, labels, kinds, conditions, failure policies and public ports).
 */
export function definitionSnapshot(
	definition: ActionDefinition,
): ActionDefinition {
	return {
		...definition,
		owner: { ...definition.owner },
		inputs: definition.inputs.map((input): ActionInputDefinition => {
			const copy: ActionInputDefinition = { ...input };
			if (isProtected(input.visibility)) delete copy.default;
			return copy;
		}),
		availability: { ...definition.availability },
		root: snapshotStep(definition.root),
	};
}

/**
 * The Go sentinel for "the slot is claimed but no run is registered yet". A run
 * id can never collide with it because ids are UUIDs.
 */
const RESERVED = "reserved";

/** The Go key for "an action is already active for this app". */
function reservationKey(appIdent: string, action: string): string {
	return `${appIdent}\u0000${action}`;
}

export class RunRegistry {
	readonly #runs = new Map<string, ActionRun>();
	/** reservation key → run id, or the sentinel `reserved`. */
	readonly #keys = new Map<string, string>();
	/** dependency identity → owning run id. */
	readonly #refs = new Map<string, string>();

	constructor(private readonly now: () => Date = () => new Date()) {}

	/** Claims the app/action slot before a run exists, so the handler can fail
	 * early instead of compiling a definition it cannot start. */
	reserve(appIdent: string, action: string): void {
		const key = reservationKey(appIdent, action);
		const existing = this.#keys.get(key);
		if (existing !== undefined) {
			throw new Error(
				`${action} action already active for ${appIdent} (run ${existing})`,
			);
		}
		this.#keys.set(key, RESERVED);
	}

	start(
		run: ActionRun,
		appIdent: string,
		action: string,
		dependencies: readonly string[] = [],
	): void {
		const key = reservationKey(appIdent, action);
		const existing = this.#keys.get(key);
		if (existing !== undefined && existing !== RESERVED) {
			throw new Error(
				`${action} action already active for ${appIdent} (run ${existing})`,
			);
		}
		for (const dependency of dependencies) {
			if (!this.#refs.has(dependency)) this.#refs.set(dependency, run.id);
		}
		this.#keys.set(key, run.id);
		run.appIdent = appIdent;
		run.action = action;
		if (!run.startedAt) run.startedAt = this.now().toISOString();
		this.#runs.set(run.id, run);
	}

	release(appIdent: string, action: string): void {
		this.#keys.delete(reservationKey(appIdent, action));
	}

	/**
	 * Active runs for one app, in start order. Go iterates a map here, so its
	 * order was incidental; a fixture can only be a contract if the order is
	 * stable, which is why this returns insertion order.
	 */
	activeForApp(appIdent: string): ActionRun[] {
		return [...this.#runs.values()].filter(
			(run) =>
				run.appIdent === appIdent &&
				(run.status === RUN_STATUS.active || run.status === RUN_STATUS.pending),
		);
	}

	/** Active runs across every app, in start order (see `activeForApp`). */
	active(): ActionRun[] {
		return [...this.#runs.values()].filter(
			(run) =>
				run.status === RUN_STATUS.active || run.status === RUN_STATUS.pending,
		);
	}

	cancel(id: string): void {
		this.complete(id, RUN_STATUS.canceled);
	}

	/** Whether a dynamically discovered step is already present. */
	hasStep(id: string, stepId: string): boolean {
		const run = this.#runs.get(id);
		if (!run) return false;
		return run.steps.some((step) => step.id === stepId);
	}

	/**
	 * Appends a dynamically discovered step. Adding a step whose id already
	 * exists is a no-op, so a caller can add unconditionally without risking a
	 * duplicate or mislabelled entry for a pre-declared step.
	 */
	addStep(id: string, step: ActionStep): void {
		const run = this.#runs.get(id);
		if (!run) return;
		if (run.steps.some((existing) => existing.id === step.id)) return;
		run.steps.push(step);
	}

	updateRun(id: string, update: (run: ActionRun) => void): void {
		const run = this.#runs.get(id);
		if (!run) return;
		update(run);
	}

	updateStep(
		runId: string,
		stepId: string,
		update: (step: ActionStep) => void,
	): void {
		const run = this.#runs.get(runId);
		if (!run) return;
		const step = run.steps.find((candidate) => candidate.id === stepId);
		if (step) update(step);
	}

	complete(id: string, status: ActionRunStatus): void {
		const run = this.#runs.get(id);
		if (!run) return;
		run.status = status;
		run.finishedAt = this.now().toISOString();
		for (const [key, owner] of this.#keys) {
			if (owner === id) this.#keys.delete(key);
		}
		// Dependencies this run was holding are released with it.
		for (const [dependency, owner] of this.#refs) {
			if (owner === id) this.#refs.delete(dependency);
		}
	}

	get(id: string): ActionRun | undefined {
		return this.#runs.get(id);
	}

	/** Runs in start order, for the history projection. */
	all(): ActionRun[] {
		return [...this.#runs.values()];
	}

	/** Drops finished runs whose retention window has elapsed. */
	cleanup(now: Date = this.now()): void {
		for (const [id, run] of this.#runs) {
			if (!run.finishedAt) continue;
			const finished = Date.parse(run.finishedAt);
			if (Number.isNaN(finished)) continue;
			if (now.getTime() - finished < HISTORY_RETENTION_MS) continue;
			this.#runs.delete(id);
			for (const [key, owner] of this.#keys) {
				if (owner === id) this.#keys.delete(key);
			}
			for (const [dependency, owner] of this.#refs) {
				if (owner === id) this.#refs.delete(dependency);
			}
		}
	}
}
