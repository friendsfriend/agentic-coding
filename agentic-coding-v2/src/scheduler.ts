import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Harness, TaskId, Tx } from "@earendil-works/pi-durable";
import { text } from "./config.ts";
import { scheduleFingerprint } from "./identity.ts";
import { nextDue } from "./recurrence.ts";
import {
	Catalog,
	decode,
	type Invocation,
	type Schedule,
	type Timing,
	values,
} from "./state.ts";

export type ScheduleSlot = {
	scheduleId: string;
	revision: number;
	due: number;
	clock: number;
};
export type Admission = (
	invocation: Invocation,
	slot?: ScheduleSlot | null,
) => Promise<number>;

export async function finishSlot(
	tx: Tx,
	slot: ScheduleSlot,
	admitted: number | null,
	outcome: string,
) {
	const doc = await tx.doc(Catalog);
	const current = decode<Schedule>(doc.schedules[slot.scheduleId]);
	if (
		current.revision !== slot.revision ||
		current.nextDue !== slot.due ||
		current.state !== "enabled"
	)
		throw new Error("Schedule changed before admission");
	current.lastSlot = slot.due;
	current.nextDue = nextDue(current.timing, Math.max(slot.due, slot.clock));
	current.activeTask = admitted ?? current.activeTask;
	current.history.push({ due: slot.due, task: admitted, result: outcome });
	current.history = current.history.slice(-200);
	doc.schedules[current.id] = JSON.stringify(current);
}

function matchingSchedule(
	raw: string | undefined,
	invocation: Invocation,
	timing: Timing,
	lateGraceMs: number | null,
): Schedule | null {
	if (!raw) return null;
	const existing = decode<Schedule>(raw);
	if (
		scheduleFingerprint(
			existing.invocation,
			existing.timing,
			existing.lateGraceMs,
		) !== scheduleFingerprint(invocation, timing, lateGraceMs)
	)
		throw new Error("Schedule ID already used for a different request");
	return existing;
}

/** Timing/admission accounting, never an execution engine. The native task is the only worker. */
export class Scheduler {
	constructor(
		private readonly harness: Harness,
		private readonly admit: Admission,
		private readonly validate: (invocation: Invocation) => Promise<unknown>,
	) {}
	async find(
		invocation: Invocation,
		timing: Timing,
		lateGraceMs: number | null,
		id: string,
	): Promise<Schedule | null> {
		text(id, "schedule ID", 128);
		return matchingSchedule(
			(await this.harness.snapshot(Catalog, context))?.schedules[id],
			invocation,
			timing,
			lateGraceMs,
		);
	}
	async create(
		invocation: Invocation,
		timing: Timing,
		lateGraceMs: number | null,
		id: string,
	) {
		const previous = await this.find(invocation, timing, lateGraceMs, id);
		if (previous) return previous;
		await this.validate(invocation);
		if (
			lateGraceMs !== null &&
			(!Number.isSafeInteger(lateGraceMs) || lateGraceMs < 0)
		)
			throw new Error("Invalid late policy");
		const due = nextDue(timing, Date.now());
		if (due === null) throw new Error("Schedule has no future occurrence");
		const schedule: Schedule = {
			id,
			invocation,
			timing,
			nextDue: due,
			state: "enabled",
			revision: 1,
			activeTask: null,
			lastSlot: null,
			lateGraceMs,
			history: [],
			lastError: null,
		};
		return this.harness.commit(async (tx) => {
			const doc = await tx.doc(Catalog);
			const existing = matchingSchedule(
				doc.schedules[id],
				invocation,
				timing,
				lateGraceMs,
			);
			if (existing) return existing;
			doc.schedules[id] = JSON.stringify(schedule);
			return schedule;
		}, context);
	}
	async setState(id: string, revision: number, state: "enabled" | "paused") {
		await this.harness.commit(async (tx) => {
			const doc = await tx.doc(Catalog);
			const raw = doc.schedules[id];
			if (!raw) throw new Error("Unknown schedule");
			const schedule = decode<Schedule>(raw);
			if (schedule.revision !== revision) throw new Error("Stale schedule");
			schedule.state = state;
			schedule.revision++;
			doc.schedules[id] = JSON.stringify(schedule);
		}, context);
	}
	async tick(now: number) {
		const schedules = values<Schedule>(
			(await this.harness.snapshot(Catalog, context))?.schedules,
		);
		for (const schedule of schedules) {
			if (
				schedule.state !== "enabled" ||
				schedule.nextDue === null ||
				schedule.nextDue > now
			)
				continue;
			try {
				const slot: ScheduleSlot = {
					scheduleId: schedule.id,
					revision: schedule.revision,
					due: schedule.nextDue,
					clock: now,
				};
				const previous =
					schedule.activeTask === null
						? null
						: await this.harness.getTask(
								schedule.activeTask as TaskId,
								context,
							);
				let skip: string | null = null;
				if (previous && previous.state.status !== "terminal")
					skip = "skipped-overlap";
				else if (
					schedule.lateGraceMs !== null &&
					now - slot.due > schedule.lateGraceMs
				)
					skip = "expired";
				if (skip) {
					const reason = skip;
					await this.harness.commit(
						(tx) => finishSlot(tx, slot, null, reason),
						context,
					);
				} else
					await this.admit(
						{
							...schedule.invocation,
							inputs: `${schedule.invocation.inputs}\n\nOccurrence context:\n${JSON.stringify({ occurrenceId: `${schedule.id}:${slot.due}`, nominalDue: slot.due })}`,
							requestId: `schedule:${schedule.id}:${slot.due}`,
						},
						slot,
					);
			} catch (error) {
				await this.harness.commit(async (tx) => {
					const doc = await tx.doc(Catalog);
					const raw = doc.schedules[schedule.id];
					if (!raw) return;
					const current = decode<Schedule>(raw);
					if (
						current.revision !== schedule.revision ||
						current.nextDue !== schedule.nextDue ||
						current.state !== "enabled"
					)
						return;
					current.state = "paused";
					current.revision++;
					current.lastError = (
						error instanceof Error
							? error.message
							: "Scheduled admission failed"
					).slice(0, 1000);
					doc.schedules[current.id] = JSON.stringify(current);
				}, context);
			}
		}
	}
}
