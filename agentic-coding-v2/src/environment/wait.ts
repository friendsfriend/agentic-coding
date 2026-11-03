import type { Plan } from "./catalog.ts";
export type WaitReceipt = {
	batch: string;
	owner: number;
	request: string;
	plans: Plan[];
	retained: boolean;
	since: number;
	ordinal: number;
	revision: number;
	state: "waiting" | "acquired" | "cancelled" | "interrupted";
};
export type WaitPoll = {
	owner: number;
	batch: string;
	request: string;
	waitMs: number;
	state: "pending" | "waiting" | "acquired" | "cancelled";
	observedAt: number;
	position?: number;
};
export function waitingResult(
	poll: WaitPoll,
	receipt: WaitReceipt,
	replayed = false,
) {
	return {
		acquisition: receipt.batch,
		state: "still-waiting",
		owner: receipt.owner,
		apps: receipt.plans.map((plan) => plan.app),
		queuedAt: receipt.since,
		ordinal: receipt.ordinal,
		recordedPosition: poll.position ?? null,
		observedAt: poll.observedAt,
		currentState: receipt.state,
		replayed,
		continuation: "env_wait",
		authority:
			"No apps reserved or started by this result. The original exact approved plan may be continued only by its native owner while its live retained queue entry exists. This receipt never restores queue or execution authority after host restart.",
	};
}
