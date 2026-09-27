// Hermetic Luvus UHP transport tests (verifier fixes TQV-001, SV-003, SV-004):
// request framing, result/error envelopes, close/deadline rejection, abort
// mapping, and the agent-start environment branch. No luvus binary or live
// session is required.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect, Either } from "effect";
import { writeAgentRunEnv } from "../src/multiplexer/agent-env.ts";
import { LuvusMultiplexer } from "../src/multiplexer/luvus/index.ts";
import { UhpError, uhpCall } from "../src/multiplexer/luvus/uhp.ts";

interface RecordedRequest {
	id: string;
	method: string;
	params: Record<string, unknown>;
}

function listenOnce(
	handler: (socket: Bun.Socket<unknown>, request: RecordedRequest) => void,
	options: { onClose?: () => void } = {},
): { socketPath: string; requests: RecordedRequest[]; stop: () => void } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uhp-"));
	const socketPath = path.join(dir, "luvus.sock");
	const requests: RecordedRequest[] = [];
	const server = Bun.listen({
		unix: socketPath,
		socket: {
			open(socket) {
				void socket;
			},
			data(socket, data) {
				for (const line of String(data).split("\n")) {
					if (!line.trim()) continue;
					const request = JSON.parse(line) as RecordedRequest;
					requests.push(request);
					handler(socket, request);
				}
			},
			close() {
				options.onClose?.();
			},
		},
	});
	return {
		socketPath,
		requests,
		stop: () => {
			void server.stop(true);
			fs.rmSync(dir, { recursive: true, force: true });
		},
	};
}

describe("uhpCall transport", () => {
	test("frames one newline-delimited {id,method,params} request and extracts the result", async () => {
		const server = listenOnce((socket, request) => {
			socket.write(
				`${JSON.stringify({ id: request.id, result: { type: "pong" } })}\n`,
			);
		});
		try {
			const result = await uhpCall(server.socketPath, "ping", {});
			expect(result).toEqual({ type: "pong" });
			expect(server.requests).toEqual([
				{ id: "agentic-coding", method: "ping", params: {} },
			]);
		} finally {
			server.stop();
		}
	});

	test("maps an error envelope to a coded UhpError", async () => {
		const server = listenOnce((socket, request) => {
			socket.write(
				`${JSON.stringify({
					id: request.id,
					error: { code: "pane_not_found", message: "no such pane" },
				})}\n`,
			);
		});
		try {
			const outcome = await uhpCall(server.socketPath, "pane.get", {
				pane: "9",
			}).catch((error) => error);
			expect(outcome).toBeInstanceOf(UhpError);
			expect((outcome as UhpError).code).toBe("pane_not_found");
			expect((outcome as UhpError).message).toBe("no such pane");
		} finally {
			server.stop();
		}
	});

	test("rejects a malformed reply as invalid_response", async () => {
		const server = listenOnce((socket) => {
			socket.write("not json\n");
		});
		try {
			const outcome = await uhpCall(server.socketPath, "ping").catch(
				(error) => error,
			);
			expect(outcome).toBeInstanceOf(UhpError);
			expect((outcome as UhpError).code).toBe("invalid_response");
		} finally {
			server.stop();
		}
	});

	test("rejects when the socket closes before a reply", async () => {
		const server = listenOnce((socket) => {
			socket.end();
		});
		try {
			const outcome = await uhpCall(server.socketPath, "ping").catch(
				(error) => error,
			);
			expect(outcome).toBeInstanceOf(UhpError);
			expect((outcome as UhpError).code).toBe("unavailable");
		} finally {
			server.stop();
		}
	});

	test("rejects after the reply deadline when the server never answers", async () => {
		const server = listenOnce(() => {
			/* accept and stay silent */
		});
		try {
			const outcome = await uhpCall(
				server.socketPath,
				"agent.start",
				{},
				undefined,
				25,
			).catch((error) => error);
			expect(outcome).toBeInstanceOf(UhpError);
			expect((outcome as UhpError).code).toBe("unavailable");
			expect((outcome as UhpError).message).toContain("agent.start");
		} finally {
			server.stop();
		}
	});

	test("an aborted signal maps to ownership loss and closes the socket", async () => {
		let closed = false;
		const server = listenOnce(
			() => {
				/* never answer */
			},
			{ onClose: () => (closed = true) },
		);
		try {
			const controller = new AbortController();
			const pending = uhpCall(
				server.socketPath,
				"agent.start",
				{},
				controller.signal,
			).catch((error) => error);
			controller.abort();
			const outcome = await pending;
			expect(outcome).toBeInstanceOf(Error);
			expect((outcome as Error).message).toContain("effect ownership was lost");
			const deadline = Date.now() + 500;
			while (Date.now() < deadline && !closed) await Bun.sleep(10);
			expect(closed).toBe(true);
		} finally {
			server.stop();
		}
	});
});

describe("agentStart environment injection", () => {
	test("sources the run env file, waits for the marker, and prompts only after readiness", async () => {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "uhp-env-"));
		const requests: Array<{ method: string; params: Record<string, unknown> }> =
			[];
		let markerFile: string | undefined;
		try {
			const port = new LuvusMultiplexer({
				request: async (method, params) => {
					requests.push({ method, params });
					if (method === "pane.run") {
						const command = String(params.command ?? "");
						expect(command).toContain("set -a; . '");
						expect(command).toContain("touch '");
						const match = command.match(/touch '([^']+)'/);
						markerFile = match?.[1];
						// Simulate the pane shell sourcing the env file and touching
						// the marker.
						if (markerFile) fs.writeFileSync(markerFile, "");
						return { type: "ok" };
					}
					if (method === "agent.start")
						return {
							type: "agent_start",
							name: "worker",
							kind: "pi",
							pane: "1",
							ready: true,
							status: "idle",
						};
					if (method === "agent.prompt")
						return { type: "agent_prompt", submitted: true };
					if (method === "agent.get")
						return {
							type: "agent",
							pane: "1",
							agent: "pi",
							name: "worker",
							status: "working",
						};
					return { type: "ok" };
				},
				sleep: () => Effect.void,
				runCli: () => ({}),
			});
			const started = await Effect.runPromise(
				port.agentStart({
					kind: "pi",
					name: "worker",
					paneId: "1",
					cwd: repo,
					runId: "run-env",
					runtimeArgs: [],
					environment: { HERDR_RUN_ID: "run-env", HERDR_RUN_TOKEN: "t" },
					prompt: "go",
				}),
			);
			expect(started.paneId).toBe("1");
			expect(markerFile).toBeDefined();
			expect(requests[0]?.method).toBe("pane.run");
			expect(requests.some((request) => request.method === "agent.start")).toBe(
				true,
			);
			expect(
				requests.some((request) => request.method === "agent.prompt"),
			).toBe(true);
		} finally {
			fs.rmSync(repo, { recursive: true, force: true });
		}
	});

	test("a marker that never lands fails before agent.start", async () => {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "uhp-env-fail-"));
		try {
			const methods: string[] = [];
			const port = new LuvusMultiplexer({
				request: async (method) => {
					methods.push(method);
					return { type: "ok" };
				},
				sleep: () => Effect.void,
			});
			const outcome = await Effect.runPromise(
				Effect.either(
					port.agentStart({
						kind: "pi",
						name: "worker",
						paneId: "1",
						cwd: repo,
						runId: "run-env",
						runtimeArgs: [],
						environment: { HERDR_RUN_ID: "run-env" },
						prompt: "go",
					}),
				),
			);
			expect(Either.isLeft(outcome)).toBe(true);
			if (Either.isLeft(outcome))
				expect(outcome.left.message).toContain(
					"run environment injection did not land",
				);
			expect(methods).not.toContain("agent.start");
			expect(methods).not.toContain("agent.prompt");
		} finally {
			fs.rmSync(repo, { recursive: true, force: true });
		}
	});

	test("writeAgentRunEnv rejects newline and NUL-bearing values", () => {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "env-guard-"));
		try {
			expect(() =>
				writeAgentRunEnv({
					cwd: repo,
					runId: "run",
					environment: { TARGET: "repo\nINJECTED=1" },
				}),
			).toThrow(/may not contain newlines/);
			expect(() =>
				writeAgentRunEnv({
					cwd: repo,
					runId: "run",
					environment: { TOKEN: "a\0b" },
				}),
			).toThrow(/may not contain newlines/);
		} finally {
			fs.rmSync(repo, { recursive: true, force: true });
		}
	});
});
