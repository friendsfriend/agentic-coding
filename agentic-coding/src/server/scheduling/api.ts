import type {
	JobInput,
	SchedulingCreation,
	Timing,
} from "../../contracts/scheduling.ts";
import {
	decodeScheduling,
	type Schedule,
	SchedulingError,
} from "../../contracts/scheduling.ts";
import {
	type SchedulingRequest,
	type SchedulingResponse,
	type SchedulingTimingInput,
	schedulingOperationRequiresOperator,
	schedulingRequestSchema,
} from "../../contracts/scheduling-api.ts";
import {
	previewTiming,
	resolveDelay,
	resolveLocalOnce,
} from "../../scheduling/recurrence.ts";

function resolveTimingInput(input: SchedulingTimingInput, now: number): Timing {
	switch (input.kind) {
		case "delay":
			return resolveDelay(input.delayMs, input.timezone, now);
		case "local-once":
			return resolveLocalOnce(input.local, input.timezone, input.fold);
		default:
			return input;
	}
}

import type { Principal } from "../auth.ts";
import type { SchedulingService } from "./service.ts";
import { historyCursor } from "./store.ts";

/** One application boundary for HTTP, tools and the manual client. The caller's
 * authority is transport-derived, never an input field. No transaction spans I/O. */
export class SchedulingApi {
	constructor(
		readonly service: SchedulingService,
		readonly manualDestination?: () => Promise<
			Extract<JobInput["target"], { kind: "wake-up" }>
		>,
	) {}
	private schedule(schedule: Schedule): SchedulingResponse {
		return {
			kind: "schedule",
			schedule,
			preview: previewTiming(schedule.timing, this.service.now()),
			active: this.service.store.activeForSchedule(schedule.id),
		};
	}
	async execute(
		raw: unknown,
		principal: Principal,
	): Promise<SchedulingResponse> {
		const request: SchedulingRequest = decodeScheduling(
			schedulingRequestSchema,
			raw,
		);
		const store = this.service.store;
		const authorize = () => {
			if (principal === "operator") return;
			const guarded = (job: JobInput) =>
				job.target.kind === "standalone" &&
				job.target.policy === "read-only" &&
				job.target.destination !== undefined;
			let protectedSession = false;
			switch (request.operation) {
				case "create":
				case "jobs.create":
					protectedSession = guarded(request.job);
					break;
				case "jobs.update":
					protectedSession =
						guarded(request.job) || guarded(store.job(request.id));
					break;
				case "jobs.delete":
					protectedSession = guarded(store.job(request.id));
					break;
				case "schedules.create":
					protectedSession = guarded(store.job(request.schedule.jobId));
					break;
				case "schedules.update":
					protectedSession =
						guarded(store.job(request.schedule.jobId)) ||
						guarded(store.job(store.schedule(request.id).jobId));
					break;
				case "schedules.action":
					protectedSession = guarded(
						store.job(store.schedule(request.id).jobId),
					);
					break;
				case "occurrences.approve":
					protectedSession = guarded(store.occurrence(request.id).job);
					break;
			}
			if (protectedSession)
				throw new SchedulingError(
					"forbidden",
					"Only the authenticated operator may schedule or mutate a persistent workflowless-session destination.",
				);
		};
		authorize();
		let validatedJob: { id: string; revision: number } | undefined;
		if (
			schedulingOperationRequiresOperator(request.operation) &&
			principal !== "operator"
		)
			throw new SchedulingError(
				"forbidden",
				"Only an operator may approve writable standalone execution or initialize a manual destination.",
			);
		// An acknowledgement must survive a destination disappearing after commit.
		// Combined creation has its own receipt (the same service is usable directly).
		if ("requestId" in request) {
			if (request.operation === "create") {
				const prior = store.replay<SchedulingCreation>(
					principal,
					request.requestId,
					request,
				);
				if (prior !== undefined) return { kind: "created", ...prior };
			} else {
				const prior = store.replay<SchedulingResponse>(
					principal,
					request.requestId,
					request,
				);
				if (prior !== undefined) return prior;
			}
		}
		switch (request.operation) {
			case "status":
				return { kind: "status", status: this.service.status() };
			case "destination": {
				if (!this.manualDestination)
					throw new SchedulingError(
						"unavailable",
						"Manual orchestrator destination is unavailable.",
					);
				const target = await this.manualDestination();
				return store.mutate(principal, request.requestId, request, () => ({
					kind: "destination" as const,
					target,
				}));
			}
			case "preview": {
				const now = this.service.now();
				return {
					kind: "preview",
					preview: previewTiming(resolveTimingInput(request.timing, now), now),
				};
			}
			case "create":
				return {
					kind: "created",
					...(await this.service.create(
						principal,
						request.requestId,
						request.job,
						{
							...request.schedule,
							timing: resolveTimingInput(
								request.schedule.timing,
								this.service.now(),
							),
						},
						request,
					)),
				};
			case "jobs.list": {
				const items = store.listJobs(request.after, request.limit);
				const last = items.at(-1);
				return {
					kind: "jobs",
					items,
					...(last && items.length === (request.limit ?? 100)
						? { nextCursor: last.id }
						: {}),
				};
			}
			case "jobs.get":
				return {
					kind: "job",
					job: store.job(request.id),
					affectedSchedules: store.referencingSchedules(request.id),
				};
			case "schedules.list": {
				const items = store.listSchedules(request.after, request.limit);
				const last = items.at(-1);
				return {
					kind: "schedules",
					items,
					summaries: items.map((schedule) => {
						const job = store.job(schedule.jobId),
							last = store.latestOutcome(schedule.id);
						return {
							scheduleId: schedule.id,
							jobName: job.name,
							targetKind: job.target.kind,
							project:
								job.target.kind === "wake-up"
									? "orchestrator"
									: job.target.repository,
							latenessMs: Math.max(
								0,
								this.service.now() - (schedule.nextDue ?? this.service.now()),
							),
							activeStates: store
								.activeForSchedule(schedule.id)
								.map((value) => value.state),
							...(last
								? {
										lastOutcome: {
											id: last.id,
											state: last.state,
											at: last.terminalAt ?? last.updatedAt,
										},
									}
								: {}),
						};
					}),
					...(last && items.length === (request.limit ?? 100)
						? { nextCursor: last.id }
						: {}),
				};
			}
			case "schedules.get":
				return this.schedule(store.schedule(request.id));
			case "history": {
				store.schedule(request.scheduleId);
				const items = store.history(
					request.scheduleId,
					request.after,
					request.limit,
				);
				const last = items.at(-1);
				return {
					kind: "occurrences",
					items,
					...(last && items.length === (request.limit ?? 100)
						? { nextCursor: historyCursor(last) }
						: {}),
				};
			}
			case "occurrences.get":
				return { kind: "occurrence", occurrence: store.occurrence(request.id) };
			case "jobs.create":
			case "jobs.update":
				await this.service.validateJob(request.job);
				break;
			case "schedules.create":
			case "schedules.update": {
				const job = store.job(request.schedule.jobId);
				validatedJob = { id: job.id, revision: job.revision };
				await this.service.validateJob(job);
				break;
			}
		}
		// Recheck the request key, expected revisions, and shared-job fan-out together
		// after validation; another request may have committed while I/O was pending.
		return store.mutate(
			principal,
			request.requestId,
			request,
			(): SchedulingResponse => {
				authorize();
				if (
					validatedJob &&
					store.job(validatedJob.id).revision !== validatedJob.revision
				)
					throw new SchedulingError(
						"conflict",
						"Referenced job changed during validation; reload and retry.",
					);
				const now = this.service.now();
				switch (request.operation) {
					case "jobs.create":
						return {
							kind: "job",
							job: store.createJob(request.job, now),
							affectedSchedules: [],
						};
					case "jobs.update": {
						const affected = store.referencingSchedules(request.id);
						if (
							JSON.stringify(affected) !==
							JSON.stringify([...new Set(request.affectedSchedules)].sort())
						)
							throw new SchedulingError(
								"conflict",
								"Affected schedules changed; reload and confirm all affected schedules before editing this job.",
							);
						return {
							kind: "job",
							...store.updateJob(
								request.id,
								request.revision,
								request.job,
								now,
							),
						};
					}
					case "jobs.delete":
						return {
							kind: "job",
							job: store.deleteJob(request.id, request.revision, now),
							affectedSchedules: [],
						};
					case "schedules.create":
						return this.schedule(
							store.createSchedule(
								{
									...request.schedule,
									timing: resolveTimingInput(request.schedule.timing, now),
								},
								now,
							),
						);
					case "schedules.update":
						return this.schedule(
							store.updateSchedule(
								request.id,
								request.revision,
								{
									...request.schedule,
									timing: resolveTimingInput(request.schedule.timing, now),
								},
								now,
							),
						);
					case "schedules.action": {
						const result = store.action(
							request.id,
							request.revision,
							request.action,
							now,
							request.requestId,
							request.until,
						);
						return this.schedule(result.schedule);
					}
					case "occurrences.approve":
						return {
							kind: "occurrence",
							occurrence: store.approve(
								request.id,
								request.fence,
								principal,
								now,
							),
						};
				}
			},
		);
	}
}
