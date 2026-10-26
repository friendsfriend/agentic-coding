// Typed client for the durable agent host's control socket
// (durable-agent-host D3). Pure transport: no pi-durable or pi-ai import, so
// the engine adapter and the dashboard session view can depend on this
// module directly without loading the experimental runtime packages.
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import tls from "node:tls";
import {
	type AuthenticatedHostEndpoint,
	certificateFingerprint,
} from "./host-identity.ts";
import type { HostLayout } from "./layout.ts";
import {
	type CatalogResponse,
	type CompactRunResponse,
	decodeFrame,
	type EnsureRunRequest,
	type EnsureRunResponse,
	encodeFrame,
	FrameReader,
	type HostResponse,
	PROTOCOL_VERSION,
	type PrepareRestartForReattachmentResponse,
	type RetryTaskResponse,
	type StatusResponse,
	type SubmitResponse,
} from "./protocol.ts";
import {
	hostRetryCapabilityAvailable,
	releaseHostRetryCapability,
	replaceHostRetryCapabilityForLaunch,
} from "./retry-authority.ts";
import { applyWatchPatch } from "./view-ops.ts";

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

export type HostEndpoint = string | (() => Promise<AuthenticatedHostEndpoint>);

/** The provider revalidates authority on EVERY connection, including watch
 * retries. TLS authenticates and encrypts that very connection: a path swap or
 * forwarding listener cannot read command text or forge response/watch frames. */
async function connectHost(
	endpoint: HostEndpoint,
	timeoutMs: number,
): Promise<net.Socket> {
	const verified = typeof endpoint === "string" ? undefined : await endpoint();
	return new Promise((resolve, reject) => {
		const socket = verified
			? tls.connect({
					path: verified.socket,
					rejectUnauthorized: false,
					minVersion: "TLSv1.3",
				})
			: net.createConnection(endpoint as string);
		const timer = setTimeout(
			() => fail(new HostUnavailableError("agent host connection timed out")),
			timeoutMs,
		);
		const fail = (error: Error) => {
			clearTimeout(timer);
			socket.destroy();
			reject(error);
		};
		socket.once("error", fail);
		socket.once("close", () =>
			fail(new HostUnavailableError("agent host closed before authentication")),
		);
		socket.once(verified ? "secureConnect" : "connect", () => {
			if (verified) {
				const raw = (socket as tls.TLSSocket).getPeerCertificate().raw;
				if (!raw || certificateFingerprint(raw) !== verified.fingerprint) {
					fail(
						new HostUnavailableError(
							"agent host instance authentication failed",
						),
					);
					return;
				}
			}
			clearTimeout(timer);
			socket.removeListener("error", fail);
			resolve(socket);
		});
	});
}

async function sendRequest(
	socketPath: HostEndpoint,
	request: Record<string, unknown> & { type: string },
	timeoutMs: number,
	onFrame?: (value: HostResponse) => void,
): Promise<HostResponse> {
	const socket = await connectHost(socketPath, timeoutMs);
	return new Promise((resolve, reject) => {
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
		socket.write(encodeFrame(request as never));
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
function spawnHost(
	target: HostSpawn,
	layout: HostLayout,
	recoveryCapability: string,
): ChildProcess {
	// The host creates its own runtime directory when it opens, but the client
	// opens the host log first: on a workflow's first durable launch nothing has
	// created `agent-host/` yet, and the spawn dies on ENOENT before the host
	// ever starts. Same mode as `DurableHost.open`.
	fs.mkdirSync(layout.root, { recursive: true, mode: 0o700 });
	const out = fs.openSync(layout.logPath, "a");
	const env = { ...process.env, ...(target.env ?? {}) };
	// Operator credentials are never inherited by the host's task subprocesses.
	delete env.AGENTIC_WORKFLOW_TOKEN;
	const child = spawn(
		target.command,
		[...target.args, "--retry-capability-fd", "3"],
		{
			cwd: target.cwd,
			env,
			detached: true,
			stdio: ["ignore", out, out, "pipe"],
		},
	);
	const pipe = child.stdio[3];
	if (pipe && "end" in pipe) {
		pipe.on("error", () => {});
		pipe.end(recoveryCapability);
	}
	const releaseCapability = () =>
		releaseHostRetryCapability(layout.socketPath, recoveryCapability);
	child.once("exit", releaseCapability);
	child.once("error", releaseCapability);
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

/** Serialize start/reattach decisions per host path so concurrent workflow
 * launches cannot rotate authority while another caller is registering it. */
const hostEnsureOperations = new Map<string, Promise<void>>();

export async function ensureHostRunning(
	layout: HostLayout,
	target: HostSpawn,
	options: {
		attempts?: number;
		delayMs?: number;
		requireRetryAuthority?: boolean;
	} = {},
): Promise<void> {
	const key = layout.socketPath;
	const existing = hostEnsureOperations.get(key);
	if (existing) {
		await existing;
		if (
			options.requireRetryAuthority !== true ||
			hostRetryCapabilityAvailable(layout.socketPath)
		)
			return;
		return ensureHostRunning(layout, target, options);
	}
	const operation = ensureHostRunningOnce(layout, target, options);
	hostEnsureOperations.set(key, operation);
	try {
		await operation;
	} finally {
		if (hostEnsureOperations.get(key) === operation)
			hostEnsureOperations.delete(key);
	}
}

async function ensureHostRunningOnce(
	layout: HostLayout,
	target: HostSpawn,
	options: {
		attempts?: number;
		delayMs?: number;
		requireRetryAuthority?: boolean;
	},
): Promise<void> {
	const attempts = options.attempts ?? 30;
	const delayMs = options.delayMs ?? 200;
	let spawned = false;
	for (let attempt = 0; attempt < attempts; attempt++) {
		let reachable = false;
		try {
			await sendRequest(
				layout.socketPath,
				{ type: "hello", protocolVersion: PROTOCOL_VERSION },
				2_000,
			);
			reachable = true;
		} catch {
			if (!spawned) {
				const recoveryCapability = replaceHostRetryCapabilityForLaunch(
					layout.socketPath,
				);
				spawnHost(target, layout, recoveryCapability);
				spawned = true;
			}
			await sleep(delayMs);
			continue;
		}
		if (
			reachable &&
			options.requireRetryAuthority === true &&
			!hostRetryCapabilityAvailable(layout.socketPath)
		) {
			const prepared = await sendRequest(
				layout.socketPath,
				{ type: "prepareRestartForReattachment" },
				2_000,
			);
			if (prepared.type !== "prepareRestartForReattachment")
				throw unexpected(prepared);
			if (prepared.status !== "ready")
				throw new HostUnavailableError(
					"agent host is active; recovery authority cannot be restored without interrupting work",
				);
			await waitForHostUnavailable(layout.socketPath, attempts, delayMs);
			const recoveryCapability = replaceHostRetryCapabilityForLaunch(
				layout.socketPath,
			);
			spawnHost(target, layout, recoveryCapability);
			spawned = true;
			await sleep(delayMs);
			continue;
		}
		return;
	}
	throw new HostUnavailableError(
		`agent host did not become reachable: ${layout.socketPath}`,
	);
}

async function waitForHostUnavailable(
	socketPath: string,
	attempts: number,
	delayMs: number,
): Promise<void> {
	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			await sendRequest(
				socketPath,
				{ type: "hello", protocolVersion: PROTOCOL_VERSION },
				2_000,
			);
			await sleep(delayMs);
		} catch {
			return;
		}
	}
	throw new HostUnavailableError(
		"agent host did not stop for safe recovery-authority reattachment",
	);
}

/** Typed request/response client over one workflow's control socket. Every
 * call opens its own connection (NDJSON framing, D3): low volume, no
 * multiplexed-request bookkeeping needed. */
export class HostClient {
	constructor(
		private readonly socketPath: HostEndpoint,
		private readonly timeoutMs = 30_000,
		private readonly recoveryCapability?: string,
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
	async recoverRun(
		request: Omit<EnsureRunRequest, "type"> & {
			expectedConversationId: string;
		},
	): Promise<EnsureRunResponse> {
		const response = await sendRequest(
			this.socketPath,
			{ ...request, type: "recoverRun" },
			this.timeoutMs,
		);
		if (response.type !== "ensureRun") throw unexpected(response);
		return response;
	}
	async submit(
		runId: string,
		text: string,
		requestId: string,
		whenBusy?: string,
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

	/** Admit one manual compaction of a run's conversation (`/compact`). The
	 * host answers with a structured outcome; an untracked run is the
	 * `unknown-run` error, which callers report as "the run has finished". */
	async compactRun(
		runId: string,
		instructions?: string,
	): Promise<CompactRunResponse> {
		const response = await sendRequest(
			this.socketPath,
			{
				type: "compactRun",
				runId,
				...(instructions ? { instructions } : {}),
			},
			this.timeoutMs,
		);
		if (response.type !== "compactRun") throw unexpected(response);
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

	/** Explicitly retry one task the host has verified as parked at restart_limit. */
	async retryTask(
		runId: string,
		conversationId: string,
		taskId: string,
		generation: number,
	): Promise<RetryTaskResponse> {
		const response = await sendRequest(
			this.socketPath,
			{
				type: "retryTask",
				runId,
				conversationId,
				taskId,
				generation,
				recoveryCapability: this.recoveryCapability ?? "",
			},
			this.timeoutMs,
		);
		if (response.type !== "retryTask") throw unexpected(response);
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
	async prepareRestartForReattachment(): Promise<
		PrepareRestartForReattachmentResponse["status"]
	> {
		const response = await sendRequest(
			this.socketPath,
			{ type: "prepareRestartForReattachment" },
			this.timeoutMs,
		);
		if (response.type !== "prepareRestartForReattachment")
			throw unexpected(response);
		return response.status;
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
	async watch(
		runId: string,
		onFrame: (value: unknown) => void,
		options: {
			conversationId?: string;
			/** What each frame must carry (`WatchRequest.view`): `docs` asks for
			 * the live documents alone, which is all the activity badge reads. */
			view?: "docs";
			/** Ask the host for an initial snapshot and operation patches instead of
			 * a full snapshot per change. The stream still hands `onFrame` a full
			 * value: patches are applied to the cached snapshot here, so callers
			 * keep the same shape. */
			patches?: boolean;
			/** Called once if the stream drops *after* it had started — the socket
			 * closed or errored past the handshake. Not called when the caller stops
			 * the watch itself. A single-shot watch swallowed a post-start close,
			 * freezing the view on the last frame; `watchStream` uses this to
			 * reconnect instead of going stale. */
			onClose?: (error?: Error) => void;
		} = {},
	): Promise<() => void> {
		const socket = await connectHost(this.socketPath, this.timeoutMs);
		return new Promise((resolve, reject) => {
			const reader = new FrameReader();
			let settled = false;
			// The latest full value, kept only when the watcher asked for patches.
			// Every patch is applied to this value before the caller sees it.
			let current: unknown;
			let hasCurrent = false;
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
			socket.write(
				encodeFrame({
					type: "watch",
					runId,
					...(options.conversationId
						? { conversationId: options.conversationId }
						: {}),
					...(options.view ? { view: options.view } : {}),
					...(options.patches ? { patch: true } : {}),
				}),
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
						if (value.patch !== undefined) {
							// A patch before the first snapshot has nothing to advance; ignore it
							// rather than resolving the handshake on an unusable value.
							if (!hasCurrent) continue;
							try {
								current = applyWatchPatch(current, value.patch);
							} catch (error) {
								fail(error instanceof Error ? error : new Error(String(error)));
								return;
							}
							onFrame(current);
						} else {
							current = value.value;
							hasCurrent = true;
							onFrame(current);
						}
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
	/** What each frame must carry (`WatchRequest.view`). */
	readonly view?: "docs";
	/** Request incremental patches from the host (default true). The stream still
	 * calls `onFrame` with a full value, so the shape a caller reads is
	 * unchanged; an older host that ignores the request simply sends snapshots. */
	readonly patches?: boolean;
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
						...(options.view ? { view: options.view } : {}),
						patches: options.patches ?? true,
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
					const settle = () => {
						controller.signal.removeEventListener("abort", settle);
						wake = undefined;
						resolve();
					};
					wake = settle;
					controller.signal.addEventListener("abort", settle, { once: true });
					if (dropped || controller.signal.aborted) settle();
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
