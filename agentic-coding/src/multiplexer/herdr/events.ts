// Herdr socket event subscription (add-multiplexer-adapters, task 4.2).
//
// The wire format is newline-delimited JSON: one `{id, result}` ack followed
// by `{event, data}` envelopes. Pure parsers live here so the adapter and the
// dashboard contract can be tested without a socket; the subscription itself
// is a scope-owned Effect that reconnects with a fixed delay until released.
import { connect, type Socket } from "node:net";
import { Effect, type Scope } from "effect";
import { HERDR_DASHBOARD_EVENTS } from "../../contracts/integration.ts";
import type { MultiplexerEvent } from "../port.ts";

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
	events: MultiplexerEvent[];
	rest: string;
} {
	const events: MultiplexerEvent[] = [];
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

/** Acquire one reconnect loop over the Herdr socket. The returned disposer
 * destroys the live socket and cancels the pending reconnect; the adapter
 * wraps it in `Effect.acquireRelease` so scope release owns cleanup. */
export function startHerdrEventSubscription(
	onEvent: (event: MultiplexerEvent) => void,
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

/** Scope-owned Herdr event subscription: releasing the scope disposes the
 * socket and the reconnect timer. A missing socket path (not running inside
 * Herdr) quietly disables the subscription, matching the previous behavior. */
export function herdrEventsSubscribe(
	onEvent: (event: MultiplexerEvent) => void,
	options: { socketPath?: string; reconnectDelayMs?: number } = {},
): Effect.Effect<unknown, never, Scope.Scope> {
	return Effect.acquireRelease(
		Effect.sync(() => startHerdrEventSubscription(onEvent, options)),
		(dispose) => Effect.sync(dispose),
	);
}
