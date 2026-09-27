// Luvus UHP transport (add-multiplexer-adapters, task 5.1).
//
// One newline-delimited JSON request over the selected session's Unix socket,
// one JSON reply: `{id, method, params}` -> `{id, result}` or `{id, error}`.
// The session/socket location is always resolved from the environment
// (`LUVUS_SOCKET_PATH`, `LUVUS_API_ADDRESS`, `LUVUS_HOME`, `LUVUS_SESSION`)
// and is never hardcoded. Event subscriptions reuse the same socket with
// `events.subscribe` and resume from the last observed sequence after a
// dropped connection.
import { connect, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { Effect, Schema, type Scope } from "effect";
import type { MultiplexerEvent } from "../port.ts";

export class UhpError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "UhpError";
		this.code = code;
	}
}

/** Resolve the UHP socket for the selected Luvus session without ever
 * hardcoding a path: explicit override first, then the platform-native
 * address, then the documented home/session layout. */
export function resolveLuvusSocketPath(
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	if (env.LUVUS_SOCKET_PATH) return env.LUVUS_SOCKET_PATH;
	if (env.LUVUS_API_ADDRESS && !/^tcp:/i.test(env.LUVUS_API_ADDRESS))
		return env.LUVUS_API_ADDRESS;
	const home = env.LUVUS_HOME ?? path.join(os.homedir(), ".luvus");
	const session = env.LUVUS_SESSION;
	return session && session !== "default"
		? path.join(home, "sessions", session, "luvus.sock")
		: path.join(home, "luvus.sock");
}

/** Default reply deadline for one UHP request. A socket that accepts the
 * connection and then never answers must not hang an Effect forever. */
export const UHP_REPLY_DEADLINE_MS = 30_000;

/** One request/one reply UHP call. The socket is closed as soon as the reply
 * envelope is complete, the reply deadline passes, or the caller's signal
 * aborts; exactly one settlement path runs. */
export function uhpCall(
	socketPath: string,
	method: string,
	params: Record<string, unknown> = {},
	signal?: AbortSignal,
	deadlineMs = UHP_REPLY_DEADLINE_MS,
): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const socket = connect(socketPath);
		let buffer = "";
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (run: () => void) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			socket.destroy();
			run();
		};
		const onAbort = () =>
			finish(() => reject(new Error("effect ownership was lost")));
		if (signal?.aborted) {
			onAbort();
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
		if (deadlineMs > 0)
			timer = setTimeout(
				() =>
					finish(() =>
						reject(
							new UhpError(
								"unavailable",
								`Luvus did not answer ${method} within ${deadlineMs}ms`,
							),
						),
					),
				deadlineMs,
			);
		socket.setEncoding("utf8");
		socket.on("connect", () => {
			socket.write(
				`${JSON.stringify({ id: "agentic-coding", method, params })}\n`,
			);
		});
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			const line = buffer.slice(0, newline).trim();
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				finish(() =>
					reject(new UhpError("invalid_response", "invalid UHP reply JSON")),
				);
				return;
			}
			const envelope = parsed as {
				result?: unknown;
				error?: { code?: unknown; message?: unknown };
			};
			if (envelope.error) {
				const code =
					typeof envelope.error.code === "string"
						? envelope.error.code
						: "error";
				const message =
					typeof envelope.error.message === "string"
						? envelope.error.message
						: code;
				finish(() => reject(new UhpError(code, message)));
				return;
			}
			finish(() => resolve(envelope.result ?? {}));
		});
		socket.on("error", (error) => finish(() => reject(error)));
		socket.on("close", () =>
			finish(() =>
				reject(new UhpError("unavailable", "Luvus socket closed before reply")),
			),
		);
	});
}

/** Decode a UHP result through its Luvus-specific schema; shape drift surfaces
 * as a bounded error rather than a silent default. */
export function decodeLuvusResult<A>(
	// biome-ignore lint/suspicious/noExplicitAny: Effect Schema generics don't line up with decoded shapes; mirrored from decodeHerdrResult.
	schema: Schema.Schema<A, any, never>,
	raw: unknown,
): A {
	try {
		return Schema.decodeUnknownSync(schema)(raw);
	} catch (error) {
		const message = String(
			error instanceof Error ? error.message : error,
		).slice(0, 512);
		throw new UhpError(
			"invalid_response",
			`Luvus envelope did not match its schema: ${message}`,
		);
	}
}

/** Scope-owned Luvus event subscription with sequence resume and bounded
 * reconnect backoff. The release finalizer closes the stream socket and
 * cancels any pending reconnect. */
export function luvusEventsSubscribe(
	socketPath: string,
	handler: (event: MultiplexerEvent) => void,
	options: {
		reconnectDelayMs?: number;
		maxReconnectDelayMs?: number;
		onError?: (message: string) => void;
	} = {},
): Effect.Effect<unknown, never, Scope.Scope> {
	return Effect.acquireRelease(
		Effect.sync(() =>
			startLuvusEventSubscription(socketPath, handler, options),
		),
		(dispose) => Effect.sync(dispose),
	);
}

export function startLuvusEventSubscription(
	socketPath: string,
	handler: (event: MultiplexerEvent) => void,
	options: {
		reconnectDelayMs?: number;
		maxReconnectDelayMs?: number;
		onError?: (message: string) => void;
	} = {},
): () => void {
	const baseDelay = options.reconnectDelayMs ?? 1000;
	const maxDelay = options.maxReconnectDelayMs ?? 30_000;
	let disposed = false;
	let socket: Socket | undefined;
	let buffer = "";
	let delay = baseDelay;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let lastSequence: number | undefined;
	const open = () => {
		if (disposed) return;
		buffer = "";
		const next = connect(socketPath);
		socket = next;
		next.setEncoding("utf8");
		next.on("connect", () => {
			next.write(
				`${JSON.stringify({
					id: "agentic-coding-events",
					method: "events.subscribe",
					params:
						lastSequence === undefined ? {} : { after_sequence: lastSequence },
				})}\n`,
			);
		});
		next.on("data", (chunk: string) => {
			buffer += chunk;
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
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
				const envelope = parsed as {
					event?: unknown;
					sequence?: unknown;
					data?: unknown;
				};
				if (typeof envelope.sequence === "number")
					lastSequence = envelope.sequence;
				if (
					typeof envelope.event !== "string" ||
					!envelope.data ||
					typeof envelope.data !== "object" ||
					Array.isArray(envelope.data)
				)
					continue;
				if (envelope.event === "events.resync_required") {
					// The runtime dropped events for a slow subscriber; surface the
					// loss to the consumer so it can refresh instead of staying stale.
					options.onError?.("Luvus event stream requires a resync");
					handler({
						event: "events.resync_required",
						data: envelope.data as Record<string, unknown>,
					});
					continue;
				}
				handler({
					event: envelope.event,
					data: envelope.data as Record<string, unknown>,
				});
			}
		});
		next.on("error", () => {
			/* the close handler schedules the reconnect */
		});
		next.on("close", () => {
			if (disposed) return;
			timer = setTimeout(open, delay);
			delay = Math.min(maxDelay, Math.max(baseDelay, delay * 2));
		});
	};
	open();
	return () => {
		disposed = true;
		if (timer) clearTimeout(timer);
		socket?.destroy();
	};
}
