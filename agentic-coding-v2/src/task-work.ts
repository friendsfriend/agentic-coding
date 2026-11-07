import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import type { OwnedWork } from "./protocol/index.ts";
/** Scoped current native inspection; no checkpoint/input bytes or adoption authority. */
export async function ownedWork(
	harness: Harness,
	ownerId: number,
): Promise<OwnedWork> {
	const { tasks } = await harness.inspect(context);
	const conversations = [
		...new Set(tasks.map((task) => task.record.conversationId)),
	];
	const owners = new Map(
		await harness.commit(
			async (tx) =>
				Promise.all(
					conversations.map(async (id) => {
						const conversation = await tx.conversation(id);
						return [
							Number(id),
							conversation?.owner
								? Number(conversation.owner.taskId)
								: undefined,
						] as const;
					}),
				),
			context,
		),
	);
	const nodes = new Map(tasks.map((task) => [Number(task.record.id), task]));
	const children = new Map<number, number[]>();
	for (const { record } of tasks) {
		const parent = record.owner ?? owners.get(Number(record.conversationId));
		if (parent === undefined) continue;
		children.set(Number(parent), [
			...(children.get(Number(parent)) ?? []),
			Number(record.id),
		]);
	}
	const pending: { id: number; parent: number | null }[] = [
			{ id: ownerId, parent: null },
		],
		seen = new Set<number>(),
		items: OwnedWork["items"] = [];
	while (pending.length && items.length < 128) {
		const next = pending.shift();
		if (!next || seen.has(next.id)) continue;
		seen.add(next.id);
		const task = nodes.get(next.id);
		if (!task) continue;
		items.push({
			id: next.id,
			parent: next.parent,
			conversationId: Number(task.record.conversationId),
			state: task.state.kind,
			until: task.state.kind === "sleeping" ? task.state.until : null,
			reason:
				task.state.kind === "blocked" ? task.state.reason.slice(0, 2048) : null,
			reasonTruncated:
				task.state.kind === "blocked" && task.state.reason.length > 2048,
		});
		for (const id of children.get(next.id) ?? [])
			if (!seen.has(id)) pending.push({ id, parent: next.id });
	}
	return { items, truncated: pending.length > 0 };
}
