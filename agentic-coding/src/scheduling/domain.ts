import {
	type Job,
	type LatePolicy,
	type Occurrence,
	type OccurrenceState,
	SchedulingError,
	type Target,
} from "../contracts/scheduling.ts";

const TERMINAL = new Set<OccurrenceState>([
	"succeeded",
	"execution-failed",
	"launch-failed",
	"skipped-overlap",
	"missed",
	"expired",
	"cancelled-before-admission",
]);
export function isTerminal(state: OccurrenceState): boolean {
	return TERMINAL.has(state);
}
export function holdsOccupancy(state: OccurrenceState): boolean {
	return !isTerminal(state);
}
export function destinationKey(target: Target): string | null {
	return target.kind === "wake-up"
		? JSON.stringify([target.hostId, target.conversationId])
		: null;
}
export function effectiveLatePolicy(job: Job, policy?: LatePolicy): LatePolicy {
	if (job.target.kind === "wake-up" && policy === undefined)
		return { kind: "run-late" };
	if (!policy)
		throw new SchedulingError(
			"invalid-input",
			"Select an explicit late-run policy.",
		);
	if (
		policy.kind === "expire-after" &&
		(!Number.isSafeInteger(policy.graceMs) || policy.graceMs < 0)
	)
		throw new SchedulingError("invalid-input", "Invalid expiry grace.");
	return policy;
}
/** The delivery envelope is independent of transcript compaction and grants no new authority. */
export function wakeUpEnvelope(occurrence: Occurrence): string {
	return JSON.stringify({
		kind: "scheduled-follow-up",
		occurrenceId: occurrence.id,
		nominalDue: new Date(occurrence.nominalDue).toISOString(),
		lateByMs: Math.max(0, occurrence.createdAt - occurrence.nominalDue),
		instruction: occurrence.job.originalInstruction,
		task: occurrence.job.task,
		reason: occurrence.job.reason,
		references: occurrence.job.references,
		reportingDestination: occurrence.job.reportingDestination,
		authority:
			"Observation and reporting only. This reminder grants no remediation, deployment, review approval or permission changes.",
	});
}
