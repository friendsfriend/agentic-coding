// Live per-agent activity for the Agents panel (agents-panel-live-activity).
//
// The workflow store only knows a run's coarse `RunStatus`, which the engine
// learns when it next observes the host — too slow to read as "this agent is
// running bash right now". The host itself publishes the finer truth in
// pi-durable's `pi.live` document (the running tool slots, the generation in
// flight, queued inbox items), so the dashboard attaches one `HostClient.watch`
// per durable run and projects that snapshot into the one-word activity the
// panel shows.
//
// The projection is purely defensive: `pi.live` is read as unknown and a shape
// drift degrades to the workflow status badge instead of throwing. The
// subscription owns its sockets and stops them when the agent disappears or the
// dashboard unmounts.

import { createSignal } from "solid-js";

/** The activity a durable run is in the middle of. `active` is true only while
 * something is actually in flight, so the panel can animate it (like the
 * working status badge) and fall back to the workflow status when idle. */
export interface AgentActivity {
	/** One word: `bash`, `read`, `edit`, `search`, `thinking`, `answering`, … */
	readonly label: string;
	/** A step in flight; the badge animates. False only for a snapshot that
	 * carries no active work, which the panel renders as the status badge. */
	readonly active: boolean;
	/** The status tone the badge takes while active: a running tool is
	 * `working`; a question the run is blocked on is `blocked`. */
	readonly tone: "working" | "blocked";
}

/** One durable agent the panel wants activity for. Only `pi-durable` rows carry
 * a run id and host socket; other runtimes have no live document to read. */
export interface AgentActivityTarget {
	readonly role: string;
	readonly runId?: string;
	readonly hostSocket?: string;
	/** The run's durable conversation, so the watch survives a host that no longer
	 * tracks the run id. */
	readonly conversationId?: string;
}

/** Starts one run's live watch. Injectable so the store is testable without a
 * socket; the default dynamically imports the host client. */
export type AgentActivityWatch = (
	target: {
		readonly runId: string;
		readonly hostSocket: string;
		readonly conversationId?: string;
	},
	onValue: (value: unknown) => void,
) => Promise<() => void>;

export interface AgentActivitySource {
	/** The role's current activity, or undefined while nothing is in flight. */
	readonly activity: (role: string) => AgentActivity | undefined;
	/** Reconcile the watched set with the dashboard's current durable agents. */
	readonly sync: (agents: readonly AgentActivityTarget[]) => void;
	/** Stop every watch; the dashboard owner calls this on unmount. */
	readonly dispose: () => void;
}

/** pi tool name → the one word the panel shows. Unknown tools keep their own
 * name (underscores read as spaces) instead of being hidden. */
const ACTIVITY_LABELS: Readonly<Record<string, string>> = {
	read: "read",
	write: "write",
	edit: "edit",
	apply_patch: "edit",
	patch: "edit",
	bash: "bash",
	shell: "bash",
	execute: "run",
	grep: "search",
	find: "search",
	glob: "search",
	websearch: "search",
	web_search: "search",
	webfetch: "fetch",
	web_fetch: "fetch",
	fetch: "fetch",
	codemode: "code",
	task: "task",
	subagent: "task",
	developer_question: "asking",
	agent_ask: "asking",
	ask_jev: "asking",
};

/** Tools that mean the run is waiting on the developer rather than working. */
const BLOCKING_TOOLS = new Set(["developer_question", "agent_ask", "ask_jev"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function activityLabel(name: string): string {
	return ACTIVITY_LABELS[name] ?? name.replace(/_/g, " ");
}

/** Whether a generation message already carries streamed assistant text (the
 * model is answering) instead of having produced nothing yet (thinking). */
function hasStreamedText(value: unknown): boolean {
	if (!isRecord(value)) return false;
	const content = value.content;
	if (typeof content === "string") return content.length > 0;
	if (!Array.isArray(content)) return false;
	return content.some(
		(block) =>
			isRecord(block) &&
			block.type === "text" &&
			typeof block.text === "string" &&
			block.text.length > 0,
	);
}

/** Project one host watch frame into the activity the panel shows, or undefined
 * when the run has no live work (idle between turns, a finished run, a frame
 * from a host that does not publish `pi.live`). */
export function agentActivityFromValue(
	value: unknown,
): AgentActivity | undefined {
	if (!isRecord(value)) return undefined;
	const docs = isRecord(value.docs) ? value.docs : {};
	const live = isRecord(docs["pi.live"]) ? docs["pi.live"] : undefined;
	if (!live) return undefined;

	// A running tool is the most concrete activity: prefer the newest slot so a
	// parallel batch reports the call that actually started last.
	const tools = Array.isArray(live.tools) ? live.tools : [];
	for (let index = tools.length - 1; index >= 0; index--) {
		const slot = tools[index];
		if (!isRecord(slot) || slot.status !== "running") continue;
		const name = typeof slot.name === "string" ? slot.name : "tool";
		return {
			label: activityLabel(name),
			active: true,
			tone: BLOCKING_TOOLS.has(name) ? "blocked" : "working",
		};
	}

	const generation = isRecord(live.generation) ? live.generation : undefined;
	if (generation) {
		if (isRecord(generation.retry))
			return { label: "retrying", active: true, tone: "working" };
		if (generation.deferred)
			return { label: "waiting", active: true, tone: "working" };
		return {
			label: hasStreamedText(generation.message) ? "answering" : "thinking",
			active: true,
			tone: "working",
		};
	}

	const compactions = Array.isArray(live.compactions) ? live.compactions : [];
	if (compactions.length > 0)
		return { label: "compacting", active: true, tone: "working" };

	const inbox = isRecord(docs["pi.inbox"]) ? docs["pi.inbox"] : undefined;
	if (Array.isArray(inbox?.items) && inbox.items.length > 0)
		return { label: "queued", active: true, tone: "working" };

	// Run active but between generations and tools: the host is still working.
	if (live.run !== undefined)
		return { label: "working", active: true, tone: "working" };

	return undefined;
}

/** The production watch: one HostClient connection streaming the run's view,
 * kept live across a host restart or a dropped socket by `watchStream`. A
 * single-shot watch froze the badge on the last frame when the socket closed;
 * the resilient stream reconnects, and clears the badge (fall back to the
 * workflow status) while it is down so a disconnected run never reads as still
 * running its last tool. */
const hostWatch: AgentActivityWatch = async (target, onValue) => {
	const { HostClient, watchStream } = await import(
		"../../agent-host/client.ts"
	);
	const client = new HostClient(target.hostSocket);
	return watchStream(client, target.runId, {
		...(target.conversationId ? { conversationId: target.conversationId } : {}),
		onFrame: onValue,
		onState: (state) => {
			if (state !== "open") onValue(undefined);
		},
	});
};

/**
 * The dashboard's live activity store: one watch per durable agent, reconciled
 * against the agent list the dashboard already reads. A watch exists only while
 * its agent is present and its run identity is unchanged, so a reassigned run
 * restarts instead of reporting the previous run's tools.
 */
export function createAgentActivitySource(
	options: { readonly watch?: AgentActivityWatch } = {},
): AgentActivitySource {
	const watch = options.watch ?? hostWatch;
	const [activities, setActivities] = createSignal<
		ReadonlyMap<string, AgentActivity>
	>(new Map());
	/** Started watches by role; `stop` is a no-op until the socket resolves. */
	const watches = new Map<
		string,
		{ readonly key: string; stop: () => void; started: boolean }
	>();
	let disposed = false;

	const setActivity = (role: string, activity: AgentActivity | undefined) => {
		setActivities((current) => {
			if (activity === undefined) {
				if (!current.has(role)) return current;
				const next = new Map(current);
				next.delete(role);
				return next;
			}
			const before = current.get(role);
			if (
				before &&
				before.label === activity.label &&
				before.active === activity.active &&
				before.tone === activity.tone
			)
				return current;
			const next = new Map(current);
			next.set(role, activity);
			return next;
		});
	};

	const start = (agent: AgentActivityTarget, key: string) => {
		const entry = { key, stop: () => {}, started: false };
		watches.set(agent.role, entry);
		void (async () => {
			try {
				const stop = await watch(
					{
						runId: agent.runId ?? "",
						hostSocket: agent.hostSocket ?? "",
						...(agent.conversationId
							? { conversationId: agent.conversationId }
							: {}),
					},
					(value) => {
						if (disposed) return;
						if (watches.get(agent.role) !== entry) return;
						setActivity(agent.role, agentActivityFromValue(value));
					},
				);
				// The agent or its run changed while the socket was connecting: the
				// frame belongs to a stale identity, so close it instead of using it.
				if (disposed || watches.get(agent.role) !== entry) {
					stop();
					return;
				}
				entry.stop = stop;
				entry.started = true;
			} catch {
				// Host unavailable: the badge falls back to the workflow status.
				if (watches.get(agent.role) === entry) watches.delete(agent.role);
			}
		})();
	};

	const stopWatch = (role: string) => {
		const entry = watches.get(role);
		if (!entry) return;
		entry.stop();
		watches.delete(role);
		setActivity(role, undefined);
	};

	const sync = (agents: readonly AgentActivityTarget[]) => {
		if (disposed) return;
		const desired = new Set<string>();
		for (const agent of agents) {
			if (!agent.runId || !agent.hostSocket) continue;
			desired.add(agent.role);
			const key = `${agent.runId}\0${agent.hostSocket}\0${agent.conversationId ?? ""}`;
			const existing = watches.get(agent.role);
			if (existing && existing.key === key) continue;
			if (existing) stopWatch(agent.role);
			start(agent, key);
		}
		for (const role of [...watches.keys()])
			if (!desired.has(role)) stopWatch(role);
	};

	const dispose = () => {
		if (disposed) return;
		disposed = true;
		for (const [role, entry] of watches) {
			entry.stop();
			watches.delete(role);
			setActivity(role, undefined);
		}
	};

	return {
		activity: (role) => activities().get(role),
		sync,
		dispose,
	};
}
