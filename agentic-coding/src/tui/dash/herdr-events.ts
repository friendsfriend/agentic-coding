// Event-driven dashboard refresh from the live Herdr server.
//
// The dashboard used to poll workflow state and watch state files. Herdr
// already publishes lifecycle events over its Unix socket
// (`HERDR_SOCKET_PATH`), so the dashboard subscribes once and refreshes only
// when something it renders actually changed. The wire format is
// newline-delimited JSON: one `{id, result}` ack followed by
// `{event, data}` envelopes.
import { connect, type Socket } from "node:net";

/** Low-frequency lifecycle events worth a dashboard reload. Per-pane agent
 * status subscriptions require a pane id, so this list stays workspace-wide;
 * the engine's tab reconcile turns a run-status transition into a
 * `tab.renamed` event, which is what actually drives status freshness. */
export const HERDR_DASHBOARD_EVENTS = [
	"tab.created",
	"tab.closed",
	"tab.renamed",
	"tab.moved",
	"pane.created",
	"pane.closed",
	"pane.exited",
	"pane.updated",
	"pane.agent_detected",
	"workspace.closed",
	"layout.updated",
] as const;

export interface HerdrEvent {
	event: string;
	data: Record<string, unknown>;
}

/** The one `events.subscribe` request the dashboard sends on connect. */
export function herdrEventRequest(): string {
	return `${JSON.stringify({
		id: "agentic-coding-dashboard",
		method: "events.subscribe",
		params: {
			subscriptions: HERDR_DASHBOARD_EVENTS.map((type) => ({ type })),
		},
	})}\n`;
}

/** Split a socket buffer into complete event envelopes, returning the partial
 * trailing line so the caller can prepend it to the next chunk. */
export function parseHerdrEventLines(buffer: string): {
	events: HerdrEvent[];
	rest: string;
} {
	const events: HerdrEvent[] = [];
	const lines = buffer.split("\n");
	const rest = lines.pop() ?? "";
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (!parsed || typeof parsed !== "object") continue;
		const envelope = parsed as { event?: unknown; data?: unknown };
		if (
			typeof envelope.event !== "string" ||
			!envelope.data ||
			typeof envelope.data !== "object" ||
			Array.isArray(envelope.data)
		)
			continue;
		events.push({
			event: envelope.event,
			data: envelope.data as Record<string, unknown>,
		});
	}
	return { events, rest };
}

/** Whether an event belongs to the given workspace. Events without a
 * `workspace_id` (e.g. global worktree events) are treated as relevant so a
 * reconnect never silently drops a refresh. */
export function herdrEventMatchesWorkspace(
	data: Record<string, unknown>,
	workspace: string | undefined,
): boolean {
	if (!workspace) return true;
	const id = data.workspace_id ?? data.workspaceId;
	return typeof id !== "string" || id === workspace;
}

/**
 * Subscribe to Herdr lifecycle events. Reconnects with a fixed delay after a
 * dropped connection until the returned disposer is called. A missing socket
 * path (not running inside Herdr) quietly disables the subscription.
 */
export function subscribeHerdrEvents(
	onEvent: (event: HerdrEvent) => void,
	options: { socketPath?: string; reconnectDelayMs?: number } = {},
): () => void {
	const socketPath = options.socketPath ?? process.env.HERDR_SOCKET_PATH;
	if (!socketPath) return () => {};
	const reconnectDelayMs = options.reconnectDelayMs ?? 1000;
	let disposed = false;
	let socket: Socket | undefined;
	let buffer = "";
	let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	const open = () => {
		if (disposed) return;
		buffer = "";
		const next = connect(socketPath);
		socket = next;
		next.setEncoding("utf8");
		next.on("connect", () => next.write(herdrEventRequest()));
		next.on("data", (chunk: string) => {
			buffer += chunk;
			const parsed = parseHerdrEventLines(buffer);
			buffer = parsed.rest;
			for (const event of parsed.events) onEvent(event);
		});
		next.on("error", () => {
			/* close handler schedules the reconnect */
		});
		next.on("close", () => {
			if (disposed) return;
			reconnectTimer = setTimeout(open, reconnectDelayMs);
		});
	};
	open();
	return () => {
		disposed = true;
		if (reconnectTimer) clearTimeout(reconnectTimer);
		socket?.destroy();
	};
}
