import {
	type JobInput,
	type Occurrence,
	type ScheduleInput,
	SchedulingError,
	type Target,
	type TargetReceipt,
} from "../../contracts/scheduling.ts";
import { isTerminal } from "../../scheduling/domain.ts";
import { previewTiming } from "../../scheduling/recurrence.ts";
import {
	SchedulingDestinationUnavailable,
	SchedulingInfrastructureError,
	type SchedulingTargetAdapter,
} from "./adapters.ts";
import type { SchedulingStore } from "./store.ts";

const BACKOFF = [1000, 5000, 30000, 120000, 300000];

/** Lifecycle-owned orchestration. Neither a view nor a conversation owns this timer. */
import type { SchedulingCreation } from "../../contracts/scheduling.ts";
export class SchedulingService {
	private timer: ReturnType<typeof setInterval> | undefined;
	private running: Promise<void> | undefined;
	private stopped = false;
	private resumed = true;
	private cursor = "";
	private nextMaintenance = 0;
	constructor(
		readonly store: SchedulingStore,
		private readonly adapters: Record<Target["kind"], SchedulingTargetAdapter>,
		readonly now: () => number = Date.now,
		private readonly publish: (occurrence: Occurrence) => void = () => {},
	) {}
	start(): void {
		if (this.timer) return;
		this.stopped = false;
		this.timer = setInterval(() => {
			void this.tick().catch(() => {
				/* Status/history stays authoritative; a subsequent poll retries reconciliation. */
			});
		}, 1000);
		void this.tick().catch(() => {});
	}
	async stop(): Promise<void> {
		this.stopped = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		await this.running;
	}
	tick(): Promise<void> {
		if (this.stopped) return Promise.resolve();
		if (this.running) return this.running;
		this.running = this.reconcile().finally(() => {
			this.running = undefined;
		});
		return this.running;
	}
	private notify(value: Occurrence): void {
		try {
			this.publish(value);
		} catch {
			/* Notification loss never rolls back durable history. */
		}
	}
	private async reconcile(): Promise<void> {
		for (const value of this.store.reconcileDue(this.now(), this.resumed))
			this.notify(value);
		this.resumed = false;
		let batch = this.store.activeBatch(this.cursor);
		if (!batch.length) {
			this.cursor = "";
			batch = this.store.activeBatch("");
		}
		for (const item of batch) {
			if (this.stopped) break;
			this.cursor = item.id;
			const claimed = this.store.claim(item.id, this.now());
			if (!claimed) continue;
			await this.dispatch(claimed);
		}
		if (this.now() >= this.nextMaintenance) {
			this.store.prune(this.now());
			this.nextMaintenance = this.now() + 60_000;
		}
	}
	private async dispatch(initial: Occurrence): Promise<void> {
		let value = initial;
		const adapter = this.adapters[value.job.target.kind];
		try {
			if (!value.receipt) {
				const resolved = await adapter.resolve(this.store.job(value.jobId));
				value = this.store.resolveJob(value.id, value.fence, resolved);
				const receipt = await adapter.reserve(value);
				if (receipt.id !== value.id || receipt.state !== "reserved")
					throw new SchedulingError(
						"conflict",
						"Invalid target reservation receipt.",
					);
				value = this.store.transition(
					value.id,
					value.fence,
					"reserved",
					this.now(),
					{ receipt },
				);
			}
			if (
				value.admittedAt === undefined &&
				value.job.target.kind === "standalone" &&
				value.job.target.policy === "default" &&
				value.approvedAt === undefined
			) {
				this.notify(
					this.store.transition(
						value.id,
						value.fence,
						"waiting-review",
						this.now(),
						{
							reason:
								"Operator approval required before this writable standalone occurrence can activate.",
						},
					),
				);
				return;
			}
			if (value.admittedAt === undefined)
				value = this.store.authorize(value.id, value.fence, this.now());
			const observed = await adapter.query(value);
			const receipt =
				observed.state === "reserved" || observed.state === "admitted"
					? await adapter.activate(value)
					: observed;
			this.record(value, receipt);
		} catch (error) {
			// A concurrent mutation or lease replacement owns the state now: never publish under our old fence.
			const current = this.store.occurrence(value.id);
			if (current.fence !== value.fence || isTerminal(current.state)) return;
			if (error instanceof SchedulingDestinationUnavailable) {
				this.notify(
					this.store.transition(
						value.id,
						value.fence,
						"destination-unavailable",
						this.now(),
						{
							reason:
								"Pinned destination unavailable; no redirection was attempted.",
							nextAttempt: this.now() + 300000,
						},
					),
				);
				return;
			}
			if (value.admittedAt !== undefined || current.admittedAt !== undefined) {
				this.notify(
					this.store.transition(
						value.id,
						value.fence,
						"reconciling",
						this.now(),
						{
							reason:
								"Admitted target outcome requires reconciliation; identity and occupancy retained.",
							nextAttempt: this.now() + 30000,
						},
					),
				);
				return;
			}
			if (
				error instanceof SchedulingInfrastructureError &&
				value.attempts < BACKOFF.length
			) {
				const delay = BACKOFF[value.attempts] ?? 300000;
				this.store.transition(
					value.id,
					value.fence,
					current.receipt ? "reserved" : "pending",
					this.now(),
					{
						reason: "Transient pre-execution infrastructure failure.",
						attempts: value.attempts + 1,
						nextAttempt: this.now() + delay,
					},
				);
				return;
			}
			this.notify(
				this.store.transition(
					value.id,
					value.fence,
					"launch-failed",
					this.now(),
					{
						reason:
							error instanceof SchedulingError
								? error.message
								: "Target validation or admission failed; no automatic execution retry.",
					},
				),
			);
		}
	}
	private record(value: Occurrence, receipt: TargetReceipt): void {
		if (receipt.id !== value.id || receipt.digest !== value.receipt?.digest)
			throw new SchedulingError(
				"conflict",
				"Target receipt ownership mismatch.",
			);
		this.notify(
			this.store.transition(value.id, value.fence, receipt.state, this.now(), {
				receipt,
			}),
		);
	}
	async validateJob(job: JobInput): Promise<void> {
		await this.adapters[job.target.kind].resolve({
			...job,
			id: "validation",
			revision: 1,
			createdAt: this.now(),
			updatedAt: this.now(),
		});
	}
	async create(
		principal: string,
		requestId: string,
		job: JobInput,
		schedule: Omit<ScheduleInput, "jobId">,
		receiptBody: unknown = { job, schedule },
	): Promise<SchedulingCreation> {
		const previous = this.store.replay<SchedulingCreation>(
			principal,
			requestId,
			receiptBody,
		);
		if (previous !== undefined) return previous;
		// Resolve configuration before the atomic mutation, then persist only non-secret references/settings.
		const candidate = {
			...job,
			id: "validation",
			revision: 1,
			createdAt: this.now(),
			updatedAt: this.now(),
		};
		await this.adapters[job.target.kind].resolve(candidate);
		return this.store.mutate(principal, requestId, receiptBody, () => {
			const created = this.store.createJob(job, this.now());
			const when = this.store.createSchedule(
				{ ...schedule, jobId: created.id },
				this.now(),
			);
			return {
				job: created,
				schedule: when,
				preview: previewTiming(when.timing, this.now()),
				noOverlap: "job" as const,
			};
		});
	}
	status() {
		return {
			storeId: this.store.identity,
			available: !this.stopped && this.timer !== undefined,
			pollingAllowanceMs: 5000,
			machineWake: false,
			operatesOnlyWhileServiceRunning: true,
		} as const;
	}
}
