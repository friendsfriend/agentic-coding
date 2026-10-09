// Typed client for the durable agent host's control socket
// (durable-agent-host D3). Pure transport: no pi-durable or pi-ai import, so
// the engine adapter and the dashboard session view can depend on this
// module directly without loading the experimental runtime packages.
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import type { HostLayout } from "./layout.ts";
import {
	type CatalogResponse,
	decodeFrame,
	type EnsureRunRequest,
	type EnsureRunResponse,
	encodeFrame,
	FrameReader,
	type HostResponse,
	PROTOCOL_VERSION,
	type StatusResponse,
	type SubmitResponse,
} from "./protocol.ts";

export class HostUnavailableError extends Error {}

/** How to start a workflow's host process when none is reachable yet. The
 * adapter supplies the already-resolved executable and arguments (compiled
 * binary self-exec, or `bun run src/cli.ts`), matching the pattern other
 * adapters use for their own launcher scripts. */
export interface HostSpawn {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd: string;
	/** Full child environment; the parent's when omitted. */
	readonly env?: NodeJS.ProcessEnv;
}

function sendRequest(
	socketPath: string,
	request: Record<string, unknown> & { type: string },
	timeoutMs: number,
	onFrame?: (value: HostResponse) => void,
): Promise<HostResponse> {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(socketPath);
		const reader = new FrameReader();
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			socket.destroy();
			reject(
				new HostUnavailableError(
					`agent host request timed out: ${request.type}`,
				),
			);
		}, timeoutMs);
		socket.once("connect", () => {
			socket.write(encodeFrame(request as never));
		});
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			for (const line of reader.push(chunk)) {
				const decoded = decodeFrame(line);
				const value = decoded.ok ? decoded.value : decoded.error;
				if (value.type === "watchFrame") {
					onFrame?.(value as HostResponse);
					continue;
				}
				if (settled) continue;
				settled = true;
				clearTimeout(timer);
				resolve(value as HostResponse);
				if (request.type !== "watch") socket.end();
			}
		});
		socket.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(error);
		});
		socket.on("close", () => clearTimeout(timer));
	});
}

/** Spawn the host detached from this process, so a bounded `workflow drain`
 * exiting never takes the agent's work with it (durable-agent-host: "Host
 * outlives drains and the dashboard"). */
function spawnHost(target: HostSpawn, layout: HostLayout): ChildProcess {
	// The host creates its own runtime directory when it opens, but the client
	// opens the host log first: on a workflow's first durable launch nothing has
	// created `agent-host/` yet, and the spawn dies on ENOENT before the host
	// ever starts. Same mode as `DurableHost.open`.
	fs.mkdirSync(layout.root, { recursive: true, mode: 0o700 });
	const out = fs.openSync(layout.logPath, "a");
	const child = spawn(target.command, target.args, {
		cwd: target.cwd,
		...(target.env ? { env: target.env } : {}),
		detached: true,
		stdio: ["ignore", out, out],
	});
	child.unref();
	return child;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A sleep that resolves early (never rejects) when the signal aborts, so a
 * reconnect backoff that is torn down mid-wait simply stops instead of leaking
 * a timer or throwing. */
function sleepUntilAborted(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const finish = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", finish);
			resolve();
		};
		const timer = setTimeout(finish, ms);
		signal?.addEventListener("abort", finish, { once: true });
	});
}

/** Ensure a workflow's host is reachable, spawning it when the socket is not
 * yet accepting connections. Idempotent under a concurrent caller: a host
 * that is still starting is simply retried against, and a host that won the
 * single-writer lock answers every later caller's requests (durable-agent-
 * host: "Concurrent host start"). */
export async function ensureHostRunning(
	layout: HostLayout,
	target: HostSpawn,
	options: { attempts?: number; delayMs?: number } = {},
): Promise<void> {
	const attempts = options.attempts ?? 30;
	const delayMs = options.delayMs ?? 200;
	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			await sendRequest(
				layout.socketPath,
				{ type: "hello", protocolVersion: PROTOCOL_VERSION },
				2_000,
			);
			return;
		} catch {
			if (attempt === 0) spawnHost(target, layout);
			await sleep(delayMs);
		}
	}
	throw new HostUnavailableError(
		`agent host did not become reachable: ${layout.socketPath}`,
	);
}

/** Typed request/response client over one workflow's control socket. Every
 * call opens its own connection (NDJSON framing, D3): low volume, no
 * multiplexed-request bookkeeping needed. */
export class HostClient {
	constructor(
		private readonly socketPath: string,
		private readonly timeoutMs = 30_000,
	) {}

	async ensureRun(
		request: Omit<EnsureRunRequest, "type">,
	): Promise<EnsureRunResponse> {
		const response = await sendRequest(
			this.socketPath,
			{ type: "ensureRun", ...request },
			this.timeoutMs,
		);
		if (response.type !== "ensureRun") throw unexpected(response);
		return response;
	}
	async submit(
		runId: string,
		text: string,
		requestId: string,
		whenBusy?: "steer" | "followUp",
	): Promise<SubmitResponse> {
		const response = await sendRequest(
			this.socketPath,
			{
				type: "submit",
				runId,
				text,
				requestId,
				...(whenBusy ? { whenBusy } : {}),
			},
			this.timeoutMs,
		);
		if (response.type !== "submit") throw unexpected(response);
		return response;
	}
	/** Apply a live model / thinking override to one run. */
	async configureRun(
		runId: string,
		change: { model?: string; thinking?: string },
	): Promise<void> {
		const response = await sendRequest(
			this.socketPath,
			{
				type: "configureRun",
				runId,
				...(change.model ? { model: change.model } : {}),
				...(change.thinking ? { thinking: change.thinking } : {}),
			},
			this.timeoutMs,
		);
		if (response.type !== "ok") throw unexpected(response);
	}

	/** The models and thinking levels this host can run. */
	async catalog(): Promise<CatalogResponse> {
		const response = await sendRequest(
			this.socketPath,
			{ type: "catalog" },
			this.timeoutMs,
		);
		if (response.type !== "catalog") throw unexpected(response);
		return response;
	}

	async status(runId: string): Promise<StatusResponse> {
		const response = await sendRequest(
			this.socketPath,
			{ type: "status", runId },
			this.timeoutMs,
		);
		if (response.type !== "status") throw unexpected(response);
		return response;
	}
	async abort(runId: string): Promise<void> {
		const response = await sendRequest(
			this.socketPath,
			{ type: "abort", runId },
			this.timeoutMs,
		);
		if (response.type !== "ok") throw unexpected(response);
	}
	async stopRun(runId: string): Promise<void> {
		const response = await sendRequest(
			this.socketPath,
			{ type: "stopRun", runId },
			this.timeoutMs,
		);
		if (response.type !== "ok") throw unexpected(response);
	}
	async shutdown(): Promise<void> {
		const response = await sendRequest(
			this.socketPath,
			{ type: "shutdown" },
			this.timeoutMs,
		);
		if (response.type !== "ok") throw unexpected(response);
	}
	/** Streams watch frames until `stop` is awaited; resolves with the stop
	 * function once the watch is acknowledged by the first frame.
	 *
	 * `conversationId` lets a watch survive a host that no longer tracks the run
	 * id (see `WatchRequest`). A watch that never starts — the host refuses the
	 * run, closes the socket, or says nothing — rejects instead of leaving the
	 * caller on a spinner forever. */
	watch(
		runId: string,
		onFrame: (value: unknown) => void,
		options: {
			conversationId?: string;
			/** Called once if the stream drops *after* it had started — the socket
			 * closed or errored past the handshake. Not called when the caller stops
			 * the watch itself. A single-shot watch swallowed a post-start close,
			 * freezing the view on the last frame; `watchStream` uses this to
			 * reconnect instead of going stale. */
			onClose?: (error?: Error) => void;
		} = {},
	): Promise<() => void> {
		return new Promise((resolve, reject) => {
			const socket = net.createConnection(this.socketPath);
			const reader = new FrameReader();
			let settled = false;
			// Once the watch has started the caller already holds `stop`, so a later
			// drop must notify `onClose` rather than be swallowed; `done` guards both
			// an intentional stop and a doubled close/error event.
			let done = false;
			const fail = (error: Error) => {
				if (settled) {
					if (done) return;
					done = true;
					clearTimeout(timer);
					socket.destroy();
					options.onClose?.(error);
					return;
				}
				settled = true;
				clearTimeout(timer);
				socket.destroy();
				reject(error);
			};
			const timer = setTimeout(
				() =>
					fail(
						new HostUnavailableError(
							`agent host did not start the watch: ${runId}`,
						),
					),
				this.timeoutMs,
			);
			socket.once("connect", () =>
				socket.write(
					encodeFrame({
						type: "watch",
						runId,
						...(options.conversationId
							? { conversationId: options.conversationId }
							: {}),
					}),
				),
			);
			socket.setEncoding("utf8");
			socket.on("data", (chunk: string) => {
				for (const line of reader.push(chunk)) {
					const decoded = decodeFrame(line);
					if (!decoded.ok) continue;
					const value = decoded.value;
					// The host answers a watch it cannot serve with an error frame: the
					// run is gone, the conversation is gone, or the request was refused.
					if (value.type === "error") {
						fail(unexpected(value));
						return;
					}
					if (value.type === "watchFrame" && value.runId === runId) {
						onFrame(value.value);
						if (!settled) {
							settled = true;
							clearTimeout(timer);
							// An intentional stop marks `done` so the close it triggers is
							// not reported to `onClose` as a dropped stream.
							resolve(() => {
								done = true;
								socket.end();
							});
						}
					}
				}
			});
			socket.on("error", (error) => fail(error));
			socket.on("close", () =>
				fail(new HostUnavailableError(`agent host closed the watch: ${runId}`)),
			);
		});
	}
}

function unexpected(response: HostResponse): Error {
	if (response.type === "error")
		return new Error(`agent host: ${response.code}: ${response.message}`);
	return new Error(`agent host: unexpected response type ${response.type}`);
}

/** The live connection state of a resilient watch: `connecting` is an attempt
 * in flight, `open` is streaming frames, `closed` is a drop awaiting the next
 * reconnect. */
export type WatchStreamState = "connecting" | "open" | "closed";

export interface WatchStreamOptions {
	readonly conversationId?: string;
	readonly onFrame: (value: unknown) => void;
	/** Connection-state changes, so a caller can fall back to a status badge or
	 * show a "reconnecting" notice while the stream is down. */
	readonly onState?: (state: WatchStreamState) => void;
	/** First reconnect backoff, doubling up to `maxBackoffMs`. */
	readonly backoffMs?: number;
	readonly maxBackoffMs?: number;
	/** Injectable for tests. */
	readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * A watch that stays live: it opens `client.watch`, forwards every frame, and
 * reconnects with doubling backoff whenever the stream drops, until the
 * returned `stop()` is called. A single `watch()` resolves once and then goes
 * silent if its socket closes, freezing the view on the last frame; this is the
 * resilient wrapper the dashboard's transcript and live activity use, so a host
 * restart or a dropped socket self-heals instead of leaving the UI stale.
 */
export function watchStream(
	client: HostClient,
	runId: string,
	options: WatchStreamOptions,
): () => void {
	const sleep = options.sleep ?? sleepUntilAborted;
	const base = options.backoffMs ?? 500;
	const max = options.maxBackoffMs ?? 10_000;
	const controller = new AbortController();
	let innerStop: (() => void) | undefined;
	let attempt = 0;
	void (async () => {
		while (!controller.signal.aborted) {
			options.onState?.("connecting");
			// A drop after the watch started resolves the wait below, waking the loop
			// to reconnect; `dropped` covers a drop that races the resolve setup.
			let wake: (() => void) | undefined;
			let dropped = false;
			try {
				const stop = await client.watch(
					runId,
					(value) => {
						if (!controller.signal.aborted) options.onFrame(value);
					},
					{
						...(options.conversationId
							? { conversationId: options.conversationId }
							: {}),
						onClose: () => {
							dropped = true;
							wake?.();
						},
					},
				);
				if (controller.signal.aborted) {
					stop();
					return;
				}
				innerStop = stop;
				attempt = 0;
				options.onState?.("open");
				await new Promise<void>((resolve) => {
					if (dropped || controller.signal.aborted) {
						resolve();
						return;
					}
					wake = resolve;
					controller.signal.addEventListener("abort", () => resolve(), {
						once: true,
					});
				});
				innerStop = undefined;
				if (controller.signal.aborted) return;
			} catch {
				// The initial handshake failed (host not up yet, or it refused the
				// run): fall through to the same backoff and try again.
				if (controller.signal.aborted) return;
			}
			options.onState?.("closed");
			attempt++;
			let backoff = base;
			for (let i = 1; i < attempt; i++) backoff = Math.min(backoff * 2, max);
			await sleep(backoff, controller.signal);
		}
	})();
	return () => {
		controller.abort();
		innerStop?.();
	};
}
