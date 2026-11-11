import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
	type ConversationId,
	InboxDoc,
	LiveDoc,
} from "@earendil-works/pi-durable";
import type {
	Session,
	SessionContext,
	Snapshot,
	Transcript,
} from "../../../protocol/index.ts";
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
		telemetryRevision: app.telemetryRevision,
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
/** Explicit inspection only. Native context assembly reads committed entries;
 * it neither submits work nor invokes a model. Context, agent and catalogue are
 * separately observed, not an atomic revision or the final provider request. */
export async function readContext(
	app: Runtime,
	id: number,
): Promise<SessionContext> {
	const session = await clientSession(app, id, false);
	const view = await session.context(context);
	const agent = await session.agent(context);
	const model = agent.model
		? app.models.getModel(agent.model.provider, agent.model.modelId)
		: undefined;
	const positive = (value: number | undefined) =>
		typeof value === "number" && Number.isFinite(value) && value > 0
			? value
			: null;
	const result: SessionContext = {
		id,
		head: view.head ? { ...view.head } : null,
		entries: view.entries.map((entry) => ({ ...entry })),
		contributions: view.contributions.map((messages) =>
			messages.map((message) => ({ ...message })),
		),
		messages: view.messages.map((message) => ({ ...message })),
		model: agent.model
			? {
					...agent.model,
					catalogued: model !== undefined,
					contextWindow: positive(model?.contextWindow),
					maxOutput: positive(model?.maxTokens),
				}
			: null,
		thinking: agent.thinkingLevel,
	};
	// Never silently trim an active context or sever entry/contribution alignment.
	// Leave ample room for the authenticated response envelope below the frame cap.
	if (
		result.entries.length !== result.contributions.length ||
		Buffer.byteLength(JSON.stringify(result), "utf8") > 400000
	)
		throw new Error("Native context projection exceeds the inspection budget");
	// Native identity remains catalog-owned even if task retention/ownership changed
	// while assembling the separate observations. Read access is not writability.
	await clientSession(app, id, false);
	return result;
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
	// Read entries before the live document: native commits replace a partial with its
	// retained entry and clear it together. This is still a non-atomic projection.
	const live = await app.harness.snapshot(LiveDoc, session.id, context);
	const inbox = await app.harness.snapshot(InboxDoc, session.id, context);
	return {
		id,
		model: agent.model
			? `${agent.model.provider}/${agent.model.modelId}`
			: null,
		thinking: agent.thinkingLevel,
		entries: [...visible].reverse().map((entry) => ({ ...entry })),
		truncated: history.items.length > 200,
		progress: {
			run: live?.run ?? null,
			generation: live?.generation
				? {
						...live.generation,
						message: live.generation.message
							? record({ ...live.generation.message })
							: undefined,
					}
				: null,
			tools: live?.tools ?? [],
			nestedTools: live?.nestedTools ?? [],
			compactions: live?.compactions ?? [],
			compactionFailure: live?.compactionFailure ?? null,
			inbox: (inbox?.items ?? []).map(({ id, mode }) => ({
				id: Number(id),
				mode,
			})),
		},
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
