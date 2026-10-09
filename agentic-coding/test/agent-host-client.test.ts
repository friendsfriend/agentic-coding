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
} from "../src/agent-host/protocol.ts";

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
