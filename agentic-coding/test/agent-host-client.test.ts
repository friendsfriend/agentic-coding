import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
	ensureHostRunning,
	HostClient,
	HostUnavailableError,
	watchStream,
} from "../src/agent-host/client.ts";
import { hostLayout } from "../src/agent-host/layout.ts";
import {
	decodeFrame,
	encodeFrame,
	FrameReader,
	type HostRequest,
	PROTOCOL_VERSION,
} from "../src/agent-host/protocol.ts";
import { hostRetryCapabilityAvailable } from "../src/agent-host/retry-authority.ts";

/** A minimal fake host: just enough of the protocol to exercise the client
 * without pulling in pi-durable (the real host lives in `host.ts`, tested by
 * its own narrower unit tests given the experimental runtime it wraps). */
function fakeServer(
	socketPath: string,
	handle: (request: HostRequest) => unknown,
): net.Server {
	const server = net.createServer((socket) => {
		const reader = new FrameReader();
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			for (const line of reader.push(chunk)) {
				const decoded = decodeFrame(line);
				if (!decoded.ok) {
					socket.write(encodeFrame(decoded.error));
					continue;
				}
				const response = handle(decoded.value as HostRequest);
				socket.write(encodeFrame(response as never));
			}
		});
	});
	server.listen(socketPath);
	return server;
}

/** Poll until `predicate` holds or the bound elapses, so a reconnect race is
 * awaited without a fixed sleep. */
async function waitFor(
	predicate: () => boolean,
	timeoutMs = 2_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("waitFor timed out");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe("HostClient over the control socket", () => {
	let dir: string;
	let server: net.Server | undefined;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-host-client-"));
	});
	afterEach(() => {
		server?.close();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test("ensureRun/submit/status/abort/stopRun round-trip through the socket", async () => {
		const layout = hostLayout(dir);
		fs.mkdirSync(layout.root, { recursive: true });
		server = fakeServer(layout.socketPath, (request) => {
			switch (request.type) {
				case "ensureRun":
					return {
						type: "ensureRun",
						runId: request.runId,
						conversationId: "1",
					};
				case "submit":
					return { type: "submit", runId: request.runId, submissionId: "s1" };
				case "status":
					return { type: "status", runId: request.runId, status: "working" };
				case "abort":
				case "stopRun":
				case "shutdown":
					return { type: "ok" };
				default:
					return {
						type: "error",
						code: "invalid-request",
						message: "unhandled in fake server",
					};
			}
		});
		const client = new HostClient(layout.socketPath, 2_000);
		const ensured = await client.ensureRun({
			runId: "run-1",
			cwd: dir,
			runEnvPath: path.join(dir, "run.env"),
			name: "worker-1",
			toolPolicy: "default",
		});
		expect(ensured.conversationId).toBe("1");
		const submitted = await client.submit("run-1", "hello", "req-1");
		expect(submitted.submissionId).toBe("s1");
		const status = await client.status("run-1");
		expect(status.status).toBe("working");
		await expect(client.abort("run-1")).resolves.toBeUndefined();
		await expect(client.stopRun("run-1")).resolves.toBeUndefined();
	});

	test("compactRun carries the instructions and returns a structured outcome", async () => {
		const layout = hostLayout(dir);
		fs.mkdirSync(layout.root, { recursive: true });
		const seen: Array<Record<string, unknown>> = [];
		server = fakeServer(layout.socketPath, (request) => {
			if (request.type !== "compactRun")
				return {
					type: "error",
					code: "invalid-request",
					message: "unexpected request",
				};
			seen.push(request as unknown as Record<string, unknown>);
			return request.instructions
				? {
						type: "compactRun",
						runId: request.runId,
						status: "started",
						taskId: "7",
					}
				: {
						type: "compactRun",
						runId: request.runId,
						status: "already-compacting",
						reason: "threshold",
					};
		});
		const client = new HostClient(layout.socketPath, 2_000);
		const started = await client.compactRun("run-1", "focus on findings");
		expect(started).toEqual({
			type: "compactRun",
			runId: "run-1",
			status: "started",
			taskId: "7",
		});
		// A bare request carries no instructions field at all.
		const busy = await client.compactRun("run-1");
		expect(busy.status).toBe("already-compacting");
		expect(busy.reason).toBe("threshold");
		expect(seen[0]).toEqual({
			type: "compactRun",
			runId: "run-1",
			instructions: "focus on findings",
		});
		expect(seen[1]).toEqual({ type: "compactRun", runId: "run-1" });
	});

	test("retryTask carries both ownership identities and returns a bounded outcome", async () => {
		const layout = hostLayout(dir);
		fs.mkdirSync(layout.root, { recursive: true });
		let request: Record<string, unknown> | undefined;
		server = fakeServer(layout.socketPath, (value) => {
			request = value as unknown as Record<string, unknown>;
			return {
				type: "retryTask",
				runId: "run-1",
				taskId: "task-7",
				status: "retried",
			};
		});
		const client = new HostClient(
			layout.socketPath,
			2_000,
			"private-capability",
		);
		await expect(client.retryTask("run-1", "17", "task-7", 4)).resolves.toEqual(
			{
				type: "retryTask",
				runId: "run-1",
				taskId: "task-7",
				status: "retried",
			},
		);
		expect(request).toEqual({
			type: "retryTask",
			runId: "run-1",
			conversationId: "17",
			taskId: "task-7",
			generation: 4,
			recoveryCapability: "private-capability",
		});
	});

	test("an unknown run is the refusal a finished run maps to", async () => {
		const layout = hostLayout(dir);
		fs.mkdirSync(layout.root, { recursive: true });
		server = fakeServer(layout.socketPath, () => ({
			type: "error",
			code: "unknown-run",
			message: "unknown run: run-1",
		}));
		const client = new HostClient(layout.socketPath, 2_000);
		await expect(client.compactRun("run-1")).rejects.toThrow(/unknown-run/);
	});

	test("an error response is surfaced as a rejected promise", async () => {
		const layout = hostLayout(dir);
		fs.mkdirSync(layout.root, { recursive: true });
		server = fakeServer(layout.socketPath, () => ({
			type: "error",
			code: "unknown-run",
			message: "no such run",
		}));
		const client = new HostClient(layout.socketPath, 2_000);
		await expect(client.status("ghost")).rejects.toThrow(/unknown-run/);
	});

	test("a watch the host refuses rejects instead of waiting for a frame", async () => {
		// A run the host no longer tracks (it restarted since) is answered with an
		// error frame; the caller must fail rather than sit on a spinner.
		const layout = hostLayout(dir);
		fs.mkdirSync(layout.root, { recursive: true });
		server = fakeServer(layout.socketPath, () => ({
			type: "error",
			code: "unknown-run",
			message: "no such run",
		}));
		const client = new HostClient(layout.socketPath, 2_000);
		await expect(client.watch("ghost", () => {})).rejects.toThrow(
			/unknown-run/,
		);
	});

	test("a watch the host never starts rejects on its bound", async () => {
		const layout = hostLayout(dir);
		fs.mkdirSync(layout.root, { recursive: true });
		// A server that accepts the request and says nothing: the watch is never
		// acknowledged, so the client's own bound is the only way out.
		server = net.createServer((socket) => socket.setEncoding("utf8"));
		await new Promise<void>((resolve) =>
			server?.listen(layout.socketPath, resolve),
		);
		const client = new HostClient(layout.socketPath, 200);
		await expect(client.watch("quiet", () => {})).rejects.toBeInstanceOf(
			HostUnavailableError,
		);
	});

	test("a watch sends the conversation id it was given", async () => {
		const layout = hostLayout(dir);
		fs.mkdirSync(layout.root, { recursive: true });
		let seen: HostRequest | undefined;
		server = fakeServer(layout.socketPath, (request) => {
			seen = request;
			return { type: "watchFrame", runId: "run-1", value: { entries: [] } };
		});
		const client = new HostClient(layout.socketPath, 2_000);
		const stop = await client.watch("run-1", () => {}, {
			conversationId: "42",
		});
		stop();
		expect(seen).toEqual({
			type: "watch",
			runId: "run-1",
			conversationId: "42",
		});
	});

	test("a patch frame advances the snapshot the client already holds", async () => {
		const layout = hostLayout(dir);
		fs.mkdirSync(layout.root, { recursive: true });
		server = net.createServer((socket) => {
			const reader = new FrameReader();
			socket.setEncoding("utf8");
			socket.on("data", (chunk: string) => {
				for (const line of reader.push(chunk)) {
					const decoded = decodeFrame(line);
					if (!decoded.ok || decoded.value.type !== "watch") continue;
					const runId = decoded.value.runId;
					socket.write(
						encodeFrame({
							type: "watchFrame",
							runId,
							value: {
								entries: [{ id: "a", text: "he" }],
								timings: { a: { durationMs: 12 } },
							},
						} as never),
					);
					socket.write(
						encodeFrame({
							type: "watchFrame",
							runId,
							patch: { ops: [["a", ["entries", 0, "text"], "llo"]] },
						} as never),
					);
				}
			});
		});
		await new Promise<void>((resolve) =>
			server?.listen(layout.socketPath, resolve),
		);
		const client = new HostClient(layout.socketPath, 2_000);
		const frames: unknown[] = [];
		const stop = await client.watch("run-1", (value) => frames.push(value), {
			patches: true,
		});
		await waitFor(() => frames.length >= 2);
		stop();
		expect(frames[1]).toEqual({
			entries: [{ id: "a", text: "hello" }],
			// Timings are not part of the view delta; the client carries the
			// snapshot's map forward.
			timings: { a: { durationMs: 12 } },
		});
	});

	test("client requests a bounded idle-host restart for reattachment", async () => {
		const layout = hostLayout(dir);
		fs.mkdirSync(layout.root, { recursive: true });
		server = fakeServer(layout.socketPath, (request) =>
			request.type === "prepareRestartForReattachment"
				? {
						type: "prepareRestartForReattachment",
						status: "ready",
					}
				: { type: "error", code: "invalid-request", message: "not used" },
		);
		await expect(
			new HostClient(layout.socketPath, 2_000).prepareRestartForReattachment(),
		).resolves.toBe("ready");
	});

	test("ensureHostRunning spawns nothing once the host already answers hello", async () => {
		const layout = hostLayout(dir);
		fs.mkdirSync(layout.root, { recursive: true });
		server = fakeServer(layout.socketPath, (request) =>
			request.type === "hello"
				? {
						type: "hello",
						protocolVersion: request.protocolVersion,
						hostId: "fake",
					}
				: { type: "ok" },
		);
		await expect(
			ensureHostRunning(
				layout,
				{ command: "does-not-matter", args: [], cwd: dir },
				{ attempts: 3, delayMs: 10 },
			),
		).resolves.toBeUndefined();
	});

	test("authority reattachment refuses a busy surviving host without restarting it", async () => {
		const layout = hostLayout(dir);
		fs.mkdirSync(layout.root, { recursive: true });
		let restartChecks = 0;
		server = fakeServer(layout.socketPath, (request) => {
			if (request.type === "prepareRestartForReattachment") {
				restartChecks++;
				return { type: "prepareRestartForReattachment", status: "busy" };
			}
			return {
				type: "hello",
				protocolVersion: PROTOCOL_VERSION,
				hostId: "busy-host",
			};
		});
		await expect(
			ensureHostRunning(
				layout,
				{ command: "must-not-spawn", args: [], cwd: dir },
				{ attempts: 3, delayMs: 5, requireRetryAuthority: true },
			),
		).rejects.toThrow("cannot be restored without interrupting work");
		expect(restartChecks).toBe(1);
		expect(hostRetryCapabilityAvailable(layout.socketPath)).toBe(false);
		expect(fs.existsSync(layout.logPath)).toBe(false);
	});

	test("reattaches retry authority by restarting only an idle surviving host", async () => {
		const layout = hostLayout(dir);
		fs.mkdirSync(layout.root, { recursive: true });
		const oldServer = net.createServer((socket) => {
			const reader = new FrameReader();
			socket.setEncoding("utf8");
			socket.on("data", (chunk: string) => {
				for (const line of reader.push(chunk)) {
					const decoded = decodeFrame(line);
					if (!decoded.ok) continue;
					const request = decoded.value as HostRequest;
					if (request.type === "prepareRestartForReattachment") {
						socket.end(
							encodeFrame({
								type: "prepareRestartForReattachment",
								status: "ready",
							}),
						);
						setTimeout(() => oldServer.close(), 0);
						continue;
					}
					socket.end(
						encodeFrame({
							type: "hello",
							protocolVersion: PROTOCOL_VERSION,
							hostId: "old-host",
						}),
					);
				}
			});
		});
		server = oldServer;
		await new Promise<void>((resolve) =>
			oldServer.listen(layout.socketPath, resolve),
		);
		const pidPath = path.join(dir, "replacement-host.pid");
		const childPath = path.join(dir, "replacement-host.mjs");
		fs.writeFileSync(
			childPath,
			[
				'import net from "node:net";',
				'import fs from "node:fs";',
				'fs.readFileSync(3, "utf8");',
				"const server = net.createServer((socket) => {",
				'  let input = "";',
				'  socket.on("data", (chunk) => {',
				"    input += chunk.toString();",
				'    if (!input.includes("\\n")) return;',
				"    const request = JSON.parse(input);",
				'    socket.end(JSON.stringify({ type: "hello", protocolVersion: request.protocolVersion, hostId: "new-host" }) + "\\n");',
				"  });",
				"});",
				"server.listen(process.env.REPLACEMENT_HOST_SOCKET, () => fs.writeFileSync(process.env.REPLACEMENT_HOST_PID, String(process.pid)));",
			].join("\n"),
		);
		try {
			await ensureHostRunning(
				layout,
				{
					command: process.execPath,
					args: [childPath],
					cwd: dir,
					env: {
						REPLACEMENT_HOST_SOCKET: layout.socketPath,
						REPLACEMENT_HOST_PID: pidPath,
					},
				},
				{ attempts: 30, delayMs: 10, requireRetryAuthority: true },
			);
			expect(hostRetryCapabilityAvailable(layout.socketPath)).toBe(true);
			expect(Number(fs.readFileSync(pidPath, "utf8"))).toBeGreaterThan(0);
		} finally {
			server = undefined;
			if (oldServer.listening)
				await new Promise<void>((resolve) => oldServer.close(() => resolve()));
			if (fs.existsSync(pidPath)) {
				const pid = Number(fs.readFileSync(pidPath, "utf8"));
				if (Number.isSafeInteger(pid) && pid > 0) {
					try {
						process.kill(pid, "SIGTERM");
					} catch {
						/* child may already have exited */
					}
				}
			}
		}
	});

	test("watchStream reconnects after the host drops the stream", async () => {
		const layout = hostLayout(dir);
		fs.mkdirSync(layout.root, { recursive: true });
		let connections = 0;
		const sockets: net.Socket[] = [];
		server = net.createServer((socket) => {
			connections++;
			sockets.push(socket);
			const reader = new FrameReader();
			socket.setEncoding("utf8");
			socket.on("data", (chunk: string) => {
				for (const line of reader.push(chunk)) {
					if (!decodeFrame(line).ok) continue;
					socket.write(
						encodeFrame({
							type: "watchFrame",
							runId: "run-1",
							value: { attempt: connections },
						} as never),
					);
				}
			});
		});
		await new Promise<void>((resolve) =>
			server?.listen(layout.socketPath, resolve),
		);

		const client = new HostClient(layout.socketPath, 2_000);
		const frames: unknown[] = [];
		const states: string[] = [];
		const stop = watchStream(client, "run-1", {
			backoffMs: 5,
			onFrame: (value) => frames.push(value),
			onState: (state) => states.push(state),
		});
		await waitFor(() => frames.length >= 1);
		// The host drops the live socket: a single-shot watch would freeze here;
		// the resilient stream reconnects and keeps delivering frames.
		sockets[0]?.destroy();
		await waitFor(() => connections >= 2 && frames.length >= 2);
		stop();
		expect(states).toContain("open");
		expect(states).toContain("closed");
	});

	test("watchStream releases its abort wait listener on every drop and on stop", async () => {
		const { getEventListeners } = await import("node:events");
		const client = new HostClient("unused");
		let close: (() => void) | undefined;
		let connections = 0;
		const waitsAfterDrop: number[] = [];
		let signal: AbortSignal | undefined;
		client.watch = async (_runId, _onFrame, options) => {
			connections++;
			close = options?.onClose;
			return () => {};
		};
		const stop = watchStream(client, "flapping-run", {
			onFrame: () => {},
			sleep: async (_ms, current) => {
				signal = current;
				if (current)
					waitsAfterDrop.push(getEventListeners(current, "abort").length);
			},
		});
		try {
			for (let attempt = 1; attempt <= 24; attempt++) {
				await waitFor(() => connections === attempt);
				close?.();
				await waitFor(() => connections === attempt + 1);
			}
			expect(waitsAfterDrop).toEqual(Array.from({ length: 24 }, () => 0));
			expect(signal).toBeDefined();
			if (!signal) throw new Error("watch did not reach the reconnect wait");
			expect(getEventListeners(signal, "abort")).toHaveLength(1);
			stop();
			await Promise.resolve();
			expect(getEventListeners(signal, "abort")).toHaveLength(0);
			expect(connections).toBe(25);
		} finally {
			stop();
		}
	});

	test("watchStream stops cleanly and does not reconnect after stop", async () => {
		const layout = hostLayout(dir);
		fs.mkdirSync(layout.root, { recursive: true });
		let connections = 0;
		server = fakeServer(layout.socketPath, () => ({
			type: "watchFrame",
			runId: "run-1",
			value: { entries: [] },
		}));
		// Count connections on the same server by wrapping its connection handler.
		server.on("connection", () => {
			connections++;
		});
		const client = new HostClient(layout.socketPath, 2_000);
		const frames: unknown[] = [];
		const stop = watchStream(client, "run-1", {
			backoffMs: 5,
			onFrame: (value) => frames.push(value),
		});
		await waitFor(() => frames.length >= 1);
		stop();
		const seen = connections;
		await new Promise((resolve) => setTimeout(resolve, 60));
		// A deliberate stop must not look like a drop: no reconnect is scheduled.
		expect(connections).toBe(seen);
	});

	test("ensureHostRunning fails closed when nothing ever becomes reachable", async () => {
		// No `layout.root` up front: on a workflow's first durable launch the
		// client is the first thing to touch the runtime directory, and the
		// spawn must create it before opening the host log.
		const layout = hostLayout(dir);
		// No server listening, and the spawn target is a command that will not
		// produce a listening socket within the bounded attempts.
		await expect(
			ensureHostRunning(
				layout,
				{ command: "true", args: [], cwd: dir },
				{ attempts: 2, delayMs: 5 },
			),
		).rejects.toBeInstanceOf(HostUnavailableError);
		expect(fs.existsSync(layout.logPath)).toBe(true);
	});
});
