import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Harness, TaskInspection } from "@earendil-works/pi-durable";

type Activity = { activity: "running" | "idle"; detail: string };
function describeWork(
	id: number,
	nodes: Map<number, TaskInspection>,
	children: Map<number, number[]>,
): Activity {
	const leaves: TaskInspection[] = [];
	const blocked: string[] = [];
	const pending = [id];
	const visited = new Set<number>();
	while (pending.length) {
		const current = pending.pop();
		if (current === undefined || visited.has(current)) continue;
		visited.add(current);
		const node = nodes.get(current);
		if (!node) continue;
		if (node.state.kind === "blocked")
			blocked.push(`${current}: ${node.state.reason}`);
		const owned = children.get(current) ?? [];
		if (owned.length) pending.push(...owned);
		else leaves.push(node);
	}
	const running = leaves.some((node) => node.state.kind === "running");
	if (blocked.length)
		return {
			activity: running ? "running" : "idle",
			detail: `blocked native work (${blocked.join(", ")})`,
		};
	if (running) return { activity: "running", detail: "executing" };
	if (leaves.some((node) => node.state.kind === "ready"))
		return { activity: "idle", detail: "queued" };
	const sleeping = leaves.flatMap((node) =>
		node.state.kind === "sleeping" ? [node.state.until] : [],
	);
	if (sleeping.length)
		return {
			activity: "idle",
			detail: `sleeping until ${new Date(Math.min(...sleeping)).toISOString()}`,
		};
	return {
		activity: "idle",
		detail: leaves.some((node) => node.state.kind === "completing")
			? "finishing owned work"
			: "waiting for owned work",
	};
}

/** Inspect native descendants, including tasks running in task-owned conversations.
 * A skill invocation awaiting its child is not itself evidence that useful work is running. */
export async function taskActivities(
	harness: Harness,
	ids: number[],
): Promise<Map<number, Activity>> {
	if (!ids.length) return new Map();
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
		const siblings = children.get(Number(parent)) ?? [];
		siblings.push(Number(record.id));
		children.set(Number(parent), siblings);
	}
	return new Map(ids.map((id) => [id, describeWork(id, nodes, children)]));
}
