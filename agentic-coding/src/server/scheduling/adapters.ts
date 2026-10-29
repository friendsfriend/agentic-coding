import type {
	Job,
	Occurrence,
	TargetReceipt,
} from "../../contracts/scheduling.ts";
/** Reservations MUST be durable and non-runnable. activate receives committed scheduler authority, never a speculative claim. */
export interface SchedulingTargetAdapter {
	resolve(job: Job): Promise<Job>;
	reserve(occurrence: Occurrence): Promise<TargetReceipt>;
	activate(occurrence: Occurrence): Promise<TargetReceipt>;
	query(occurrence: Occurrence): Promise<TargetReceipt>;
}
export class SchedulingInfrastructureError extends Error {}
export class SchedulingDestinationUnavailable extends Error {}
export class SchedulingUnknownOutcome extends Error {}
