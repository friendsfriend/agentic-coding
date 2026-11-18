import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Runtime } from "./runtime.ts";
import {
	Catalog,
	decode,
	type Review,
	type Schedule,
	type TaskInfo,
	values,
} from "./state.ts";

/** Only native task ownership/admission, never visual spawnedBy lineage or
 * relatedTo: independent workflow conversations must survive task cleanup. */
export function taskSubtree(
	infos: readonly TaskInfo[],
	seed: { task?: number; conversation?: number },
): Set<number> {
	const owner = new Map(
		infos
			.filter((info) => info.conversationId !== undefined)
			.map((info) => [info.conversationId, info.id]),
	);
	const children = new Map<number, number[]>();
	const ids = new Set<number>();
	for (const info of infos) {
		const parent = info.parent ?? owner.get(info.admittedBy);
		if (parent !== undefined) {
			const siblings = children.get(parent) ?? [];
			siblings.push(info.id);
			children.set(parent, siblings);
		}
		if (
			info.id === seed.task ||
			(seed.conversation !== undefined && info.admittedBy === seed.conversation)
		)
			ids.add(info.id);
	}
	const pending = [...ids];
	while (pending.length) {
		const id = pending.pop();
		if (id === undefined) break;
		for (const child of children.get(id) ?? [])
			if (!ids.has(child)) {
				ids.add(child);
				pending.push(child);
			}
	}
	return ids;
}

async function dismiss(app: Runtime, ids: Set<number>) {
	return app.harness.commit(async (tx) => {
		const doc = await tx.doc(Catalog);
		let removed = 0;
		for (const id of ids) {
			const raw = doc.tasks[String(id)];
			if (!raw) continue;
			const info = decode<TaskInfo>(raw);
			if (info.dismissedAt !== undefined) continue;
			doc.tasks[String(id)] = JSON.stringify({
				...info,
				dismissedAt: Date.now(),
				reported: true,
			});
			removed++;
		}
		for (const review of values<Review>(doc.reviews)) {
			if (ids.has(review.taskId) && review.state === "pending") {
				doc.reviews[review.id] = JSON.stringify({
					...review,
					state: "cancelled",
					revision: review.revision + 1,
					comments: "Owning task removed from inventories.",
				});
			}
		}
		return removed;
	}, context);
}

/** Dismiss retained finished work, not its native history or admission fences.
 * Refuse a selected tree containing live work; bulk cleanup skips live tasks. */
export async function dismissTasks(app: Runtime, id?: number) {
	const infos = values<TaskInfo>(
		(await app.harness.snapshot(Catalog, context))?.tasks,
	);
	if (id !== undefined && !infos.some((info) => info.id === id))
		throw new Error("Unknown skill task");
	const byId = new Map(infos.map((info) => [info.id, info]));
	const candidates =
		id === undefined
			? new Set(infos.map((info) => info.id))
			: taskSubtree(infos, { task: id });
	const finished = new Set<number>();
	let keptActive = 0;
	for (const taskId of candidates) {
		const info = byId.get(taskId);
		if (info?.dismissedAt !== undefined) continue;
		const task = await app.taskResult(taskId);
		if (task && task.state.status !== "terminal") {
			if (id !== undefined)
				throw new Error(
					"Task tree still has active work; cancel it before removing it",
				);
			keptActive++;
		} else finished.add(taskId);
	}
	return { removed: await dismiss(app, finished), keptActive };
}

/** Called after retirement fences admission. Cancellation follows real ownership;
 * native abort handlers retain responsibility for joining/releasing their work. */
export async function cleanupOrchestratorTasks(
	app: Runtime,
	conversation: number,
) {
	const doc = await app.harness.snapshot(Catalog, context);
	const ids = taskSubtree(values<TaskInfo>(doc?.tasks), { conversation });
	await app.harness.commit(async (tx) => {
		const current = await tx.doc(Catalog);
		for (const schedule of values<Schedule>(current.schedules))
			if (
				schedule.orchestrator === conversation &&
				schedule.state === "enabled"
			) {
				current.schedules[schedule.id] = JSON.stringify({
					...schedule,
					state: "paused",
					revision: schedule.revision + 1,
				});
			}
	}, context);
	for (const id of ids) {
		const task = await app.taskResult(id);
		if (task && task.state.status !== "terminal") await app.cancel(id);
	}
	return dismiss(app, ids);
}
