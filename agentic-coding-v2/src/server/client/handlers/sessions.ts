import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { Session, Snapshot, Transcript } from "../../../protocol/index.ts";
import { record } from "../../../protocol/index.ts";
import type { Runtime } from "../../../runtime.ts";

export async function sessionCatalog(
	app: Runtime,
	snapshot?: Awaited<ReturnType<Runtime["snapshot"]>>,
): Promise<Session[]> {
	const state = snapshot ?? (await app.snapshot());
	const sessions: Session[] = [
		{
			id: Number(app.home.id),
			parent: null,
			task: null,
			title: "Orchestrator",
			writable: true,
		},
	];
	for (const info of state.tasks) {
		const task = await app.taskResult(info.id);
		if (!task) continue;
		const checkpoint =
			task.state.status === "terminal" ? {} : record(task.state.checkpoint);
		const child = info.conversationId ?? checkpoint.child;
		if (typeof child !== "number") continue;
		sessions.push({
			id: child,
			parent: Number(app.home.id),
			task: info.id,
			title: `${info.skill} · ${info.topicId} · #${info.id}`,
			writable: task.state.status !== "terminal" && !task.abortRequested,
		});
	}
	return sessions;
}
export async function clientSnapshot(app: Runtime): Promise<Snapshot> {
	const state = await app.snapshot();
	return {
		tasks: state.tasks,
		reviews: state.reviews,
		schedules: state.schedules,
		profiles: state.profiles,
		topics: state.topics,
		repositories: state.repositories,
		environments: state.environments,
		sessions: await sessionCatalog(app, state),
	};
}
export async function clientSession(app: Runtime, id: number, writable = true) {
	if (!Number.isSafeInteger(id) || id < 0)
		throw new Error("Invalid session identity");
	if (id === Number(app.home.id)) return app.home;
	const session = (await sessionCatalog(app)).find((item) => item.id === id);
	if (!session || (writable && !session.writable))
		throw new Error("Session is unavailable or no longer writable");
	const native = await app.harness.conversation(id as ConversationId, context);
	if (!native) throw new Error("Native session is unavailable");
	return native;
}
export async function readSession(
	app: Runtime,
	id: number,
): Promise<Transcript> {
	const session = await clientSession(app, id, false);
	const agent = await session.agent(context);
	const history = await session.entries(
		{ order: "descending" },
		201,
		undefined,
		context,
	);
	const visible = history.items.slice(0, 200);
	return {
		id,
		model: agent.model
			? `${agent.model.provider}/${agent.model.modelId}`
			: null,
		thinking: agent.thinkingLevel,
		entries: [...visible].reverse().map((entry) => ({ ...entry })),
		truncated: history.items.length > 200,
		// Reported provider usage in the returned history window, not a lifetime estimate.
		usage: visible
			.flatMap((entry) => entry.model ?? [])
			.reduce(
				(total, message) => {
					if (message.role === "assistant") {
						total.input += message.usage.input;
						total.output += message.usage.output;
						total.cacheRead += message.usage.cacheRead;
						total.cacheWrite += message.usage.cacheWrite;
						total.cost += message.usage.cost.total;
					}
					return total;
				},
				{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
			),
	};
}
