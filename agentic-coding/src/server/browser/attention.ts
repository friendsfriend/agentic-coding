// The workflow side of the `stage_login` hand-off (add-stage-interactive-login):
// the browser coordinator raises one developer-dialogue record for the session it
// is waiting on and reads the developer's *Done* / *Abort* from it. This module
// is the adapter between the two halves, so neither knows the other's types.
//
// Every call here is best-effort. A hand-off that cannot raise its record still
// runs and still ends — by the declared success condition, by its deadline, by a
// closed window or by an agent abort — it just cannot be ended by *Done*.
import type {
	DeveloperDialogueRecord,
	WorkflowSnapshot,
} from "../../contracts/workflow.ts";
import { engine as workflowEngine } from "../../workflow/operations.ts";
import { workflowTargets } from "../../workflow/runtime.ts";
import type { LoginHandoffAttention } from "./handoff.ts";

/** The workflow one browser owner acts as. The owner was verified against the
 * session's capability before this adapter ran. */
export function ownerWorkflowId(owner: string): string | undefined {
	const prefix = "workflow:";
	return owner.startsWith(prefix) ? owner.slice(prefix.length) : undefined;
}

interface LocatedHandoff {
	readonly target: string;
	readonly snapshot: WorkflowSnapshot;
}

/** The two process-wide collaborators the adapter resolves records through.
 * Injected so the bridge can be exercised against a real engine in a test
 * without reaching for the server's own singleton. */
export interface LoginHandoffAttentionDeps {
	readonly engine?: () => {
		getSnapshot(target: string, workflowId: string): WorkflowSnapshot;
		/** The narrow read: one dialogue record, not the whole snapshot. */
		getDialogueRecord(
			target: string,
			workflowId: string,
			recordId: string,
		): DeveloperDialogueRecord | undefined;
		dispatch(target: string, command: unknown): unknown;
	};
	readonly targets?: () => string[];
}

export function workflowLoginHandoffAttention(
	deps: LoginHandoffAttentionDeps = {},
): LoginHandoffAttention {
	// The engine is resolved once: it is the process's own engine, and one
	// hand-off reads its record once per second for as long as it waits.
	const readEngine = deps.engine ?? (() => workflowEngine());
	let resolved: ReturnType<typeof readEngine> | undefined;
	const engine = () => (resolved ??= readEngine());
	const readTargets = deps.targets ?? (() => workflowTargets());
	/** Where one owner's workflow was last found. Every call re-reads the
	 * snapshot (the record's own status is the reason for the call), but the
	 * store target is resolved once per owner instead of scanning every target
	 * on each tick. */
	const locatedTargets = new Map<string, string>();

	/** The store target and snapshot of one workflow. A workflow this server does
	 * not host has no target, and the hand-off keeps running without a dialog. */
	const locate = (owner: string): LocatedHandoff | undefined => {
		const workflowId = ownerWorkflowId(owner);
		if (!workflowId) return undefined;
		const known = locatedTargets.get(owner);
		if (known !== undefined) {
			try {
				const snapshot = engine().getSnapshot(known, workflowId);
				if (snapshot.workflowId === workflowId)
					return { target: known, snapshot };
			} catch {
				// The workflow is not on this target any more; resolve it again below.
			}
			locatedTargets.delete(owner);
		}
		let targets: string[];
		try {
			targets = readTargets();
		} catch {
			return undefined;
		}
		for (const target of targets) {
			try {
				const snapshot = engine().getSnapshot(target, workflowId);
				if (snapshot.workflowId === workflowId) {
					locatedTargets.set(owner, target);
					return { target, snapshot };
				}
			} catch {
				// Not this target's workflow.
			}
		}
		return undefined;
	};

	const findRecord = (
		located: LocatedHandoff,
		recordId: string,
	): DeveloperDialogueRecord | undefined =>
		located.snapshot.developerDialogue.find(
			(item) => item.id === recordId && item.kind === "login-handoff",
		);

	/** An answered hand-off record as the coordinator reads it: the developer chose
	 * *Done* or *Abort* (Escape is a cancel, and reads as an abort). A record still
	 * pending, expired or cancelled without a choice is no answer yet. */
	const answerOf = (
		record: DeveloperDialogueRecord | undefined,
	): "done" | "abort" | undefined => {
		if (!record) return undefined;
		if (record.status === "pending") return undefined;
		if (record.status === "expired") return undefined;
		if (record.answer?.kind === "cancel") return "abort";
		return record.answer?.value === "done" ? "done" : "abort";
	};

	return {
		async open(input) {
			const located = locate(input.owner);
			// A session outlives the run that opened it, so a workflow this server no
			// longer hosts is honestly dialog-less rather than a failure.
			if (!located) return;
			const role =
				located.snapshot.step.results.at(-1)?.role ??
				located.snapshot.step.selectedRoles.at(-1);
			try {
				engine().dispatch(located.target, {
					type: "login-handoff.open",
					workflowId: located.snapshot.workflowId,
					recordId: input.recordId,
					description: input.description,
					context: input.context,
					expiresAt: input.expiresAt,
					...(input.canConfirm === undefined
						? {}
						: { canConfirm: input.canConfirm }),
					...(role === undefined ? {} : { role }),
					stepId: located.snapshot.currentStep,
				});
			} catch (error) {
				// The workflow refused the record: the hand-off still runs, but the
				// coordinator has to know it has no *Done* to read, so it says so in its
				// log instead of letting the developer wait for a dialog that is not there.
				throw new Error(
					`the login hand-off record was refused: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		},
		async answer(input) {
			// The record's own status is the whole answer, so it is read on its own: a
			// hand-off asks this once per tick, and decoding the run's whole snapshot
			// for one record's status is what PERF-001 was about. A target this server
			// no longer hosts falls through to the full resolution below.
			const workflowId = ownerWorkflowId(input.owner);
			const known =
				workflowId === undefined ? undefined : locatedTargets.get(input.owner);
			if (workflowId !== undefined && known !== undefined) {
				let record: DeveloperDialogueRecord | undefined;
				try {
					record = engine().getDialogueRecord(
						known,
						workflowId,
						input.recordId,
					);
				} catch {
					record = undefined;
				}
				if (record) return answerOf(record);
			}
			const located = locate(input.owner);
			if (!located) return undefined;
			return answerOf(findRecord(located, input.recordId));
		},
		async close(input) {
			const located = locate(input.owner);
			if (!located) return;
			const record = findRecord(located, input.recordId);
			if (!record) {
				locatedTargets.delete(input.owner);
				return;
			}
			// An answer the developer already gave through the dashboard is the same
			// resolution, so a replayed resolve is harmless.
			try {
				engine().dispatch(located.target, {
					type: "login-handoff.resolve",
					workflowId: located.snapshot.workflowId,
					recordId: input.recordId,
					answer: answerOf(record) ?? input.answer,
				});
			} catch {
				// The record is bookkeeping; the hand-off outcome is already decided.
			}
			// The hand-off is over, so the owner's cached target is no longer worth
			// keeping: the next hand-off resolves it once more.
			locatedTargets.delete(input.owner);
		},
	};
}
