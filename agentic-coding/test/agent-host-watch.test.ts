// durable-agent-host: "watch" request/response (protocol.ts, D3) and
// `DurableHost.watchRun`'s streaming of the conversation `viewState`.
// Exercises the real control socket end to end: `HostClient.watch()` against
// a live `DurableHost`, not a fake server.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	type AssistantMessage,
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { HostClient } from "../src/agent-host/client.ts";
import { DurableHost } from "../src/agent-host/host.ts";
import { hostLayout } from "../src/agent-host/layout.ts";
import { buildAgentSessionView } from "../src/tui/dash/agent-session.ts";

function tempWorkflowDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "agent-host-watch-"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isBusy(value: unknown): boolean {
	if (!isRecord(value)) return false;
	const docs = isRecord(value.docs) ? value.docs : {};
	const live = isRecord(docs["pi.live"]) ? docs["pi.live"] : undefined;
	return live?.run !== undefined;
}
function entryCount(value: unknown): number {
	if (!isRecord(value) || !Array.isArray(value.entries)) return 0;
	return value.entries.length;
}

describe("watch streams the conversation view over the control socket", () => {
	test("a watcher sees an initial frame, a busy frame, and a settled frame with the transcript", async () => {
		const dir = tempWorkflowDir();
		const layout = hostLayout(dir);
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const host = await DurableHost.open({
			layout,
			settings: {},
			globalAgentDir: dir,
			storage: new MemoryStorage(),
			models,
		});
		await host.listen();
		try {
			const runEnvPath = path.join(dir, "run.env");
			fs.writeFileSync(runEnvPath, "HERDR_RUN_ID='watch-run'\n");
			await host.ensureRun({
				runId: "watch-run",
				name: "watch-worker",
				cwd: dir,
				runEnvPath,
				toolPolicy: "default",
				model: `${faux.getModel().provider}/${faux.getModel().id}`,
			});

			const client = new HostClient(layout.socketPath, 10_000);
			const frames: unknown[] = [];
			const stop = await client.watch("watch-run", (value) => {
				frames.push(value);
			});
			try {
				expect(frames.length).toBeGreaterThanOrEqual(1);
				expect(isBusy(frames[0])).toBe(false);

				faux.setResponses([
					fauxAssistantMessage([fauxToolCall("read", { path: "x.txt" })], {
						stopReason: "toolUse",
					}),
				]);
				faux.appendResponses([fauxAssistantMessage([fauxText("done")])]);
				await client.submit("watch-run", "read a file", "req-1");

				let settled =
					frames.length > 0 &&
					!isBusy(frames[frames.length - 1]) &&
					entryCount(frames[frames.length - 1]) > 0;
				for (let i = 0; i < 50 && !settled; i++) {
					await new Promise((resolve) => setTimeout(resolve, 20));
					settled =
						frames.length > 0 &&
						!isBusy(frames[frames.length - 1]) &&
						entryCount(frames[frames.length - 1]) > 0;
				}
				expect(frames.length).toBeGreaterThan(1);
				expect(isBusy(frames[frames.length - 1])).toBe(false);
				expect(entryCount(frames[frames.length - 1])).toBeGreaterThan(0);
			} finally {
				stop();
			}
		} finally {
			await host.shutdown();
		}
	});

	test("a read-only run is offered the search and judgment tools it is told to use", async () => {
		// The verifier briefs tell the run to prefer `grep` over `bash` scans and to
		// reach for `ask_jev` instead of reading file after file, and a read-only
		// run names its tools explicitly: both have to be in that list or the
		// prompt names a tool the session never got.
		const dir = tempWorkflowDir();
		const layout = hostLayout(dir);
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const host = await DurableHost.open({
			layout,
			settings: {},
			globalAgentDir: dir,
			storage: new MemoryStorage(),
			models,
		});
		await host.listen();
		try {
			const runEnvPath = path.join(dir, "run.env");
			fs.writeFileSync(runEnvPath, "");
			const client = new HostClient(layout.socketPath, 10_000);
			const offered = async (runId: string, toolPolicy: string) => {
				await host.ensureRun({
					runId,
					name: runId,
					cwd: dir,
					runEnvPath,
					// biome-ignore lint/suspicious/noExplicitAny: the request's policy union includes the read-only value this test varies.
					toolPolicy: toolPolicy as any,
				});
				let frame: unknown;
				const stop = await client.watch(runId, (value) => {
					frame = value;
				});
				stop();
				const docs = isRecord(frame) && isRecord(frame.docs) ? frame.docs : {};
				const agent = isRecord(docs["pi.agent"]) ? docs["pi.agent"] : {};
				return Array.isArray(agent.tools) ? [...agent.tools] : undefined;
			};
			const readOnly = await offered("read-only-run", "read-only");
			expect(readOnly).toContain("read");
			expect(readOnly).toContain("bash");
			expect(readOnly).toContain("ask_jev");
			expect(readOnly).toContain("grep");
			expect(readOnly).not.toContain("write");
			expect(readOnly).not.toContain("edit");
			// A writable run keeps the full coding set and, with it, write and edit.
			expect(await offered("writable-run", "default")).toBeUndefined();
		} finally {
			await host.shutdown();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a watch that names the conversation serves a run the host no longer tracks", async () => {
		// The run id lives only in the host's in-memory run map: a host that
		// restarted since the run was launched answers `unknown-run`. The
		// conversation is durable, so a watcher that still holds it reads the
		// transcript the run wrote — without ever registering a run to mutate.
		const dir = tempWorkflowDir();
		const layout = hostLayout(dir);
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const host = await DurableHost.open({
			layout,
			settings: {},
			globalAgentDir: dir,
			storage: new MemoryStorage(),
			models,
		});
		await host.listen();
		try {
			const runEnvPath = path.join(dir, "run.env");
			fs.writeFileSync(runEnvPath, "");
			const ensured = await host.ensureRun({
				runId: "recovered-run",
				name: "recovered-worker",
				cwd: dir,
				runEnvPath,
				toolPolicy: "default",
			});
			const client = new HostClient(layout.socketPath, 10_000);
			const forgotten = "run-id-from-a-previous-host";
			const frames: unknown[] = [];
			const stop = await client.watch(
				forgotten,
				(value) => frames.push(value),
				{
					conversationId: ensured.conversationId,
				},
			);
			try {
				expect(frames.length).toBeGreaterThanOrEqual(1);
				expect(entryCount(frames[frames.length - 1])).toBe(0);
			} finally {
				stop();
			}
			// Without the conversation there is nothing to serve: the client is told
			// instead of waiting for a frame that never comes.
			await expect(client.watch(forgotten, () => {})).rejects.toThrow(
				/unknown-run/,
			);
			// A conversation that does not exist is refused too.
			await expect(
				client.watch(forgotten, () => {}, { conversationId: "999999" }),
			).rejects.toThrow(/conversation gone/);
			// The recovery is read-only: the run id still names no run to mutate.
			await expect(
				client.submit(forgotten, "hi", "req-recovered"),
			).rejects.toThrow(/unknown-run/);
		} finally {
			await host.shutdown();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("busy input queues FIFO and steers at tool boundaries before the run ends", async () => {
		const dir = tempWorkflowDir();
		const layout = hostLayout(dir);
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const host = await DurableHost.open({
			layout,
			settings: {},
			globalAgentDir: dir,
			storage: new MemoryStorage(),
			models,
		});
		const started = Promise.withResolvers<void>();
		const firstResponse = Promise.withResolvers<AssistantMessage>();
		const toolResponse = fauxAssistantMessage(
			[fauxToolCall("read", { path: "input.txt" })],
			{ stopReason: "toolUse" },
		);
		const requests: string[][] = [];
		faux.setResponses([
			async () => {
				started.resolve();
				return firstResponse.promise;
			},
			...Array.from(
				{ length: 2 },
				(_, index) => (context: TranscriptContext) => {
					requests.push(
						context.messages
							.filter((message) => message.role === "user")
							.map((message) =>
								typeof message.content === "string"
									? message.content
									: message.content
											.filter((part) => part.type === "text")
											.map((part) => part.text)
											.join(""),
							),
					);
					return index === 0 ? toolResponse : fauxAssistantMessage("done");
				},
			),
		]);
		let stop: (() => void) | undefined;
		try {
			await host.listen();
			fs.writeFileSync(path.join(dir, "input.txt"), "contents");
			const runEnvPath = path.join(dir, "run.env");
			fs.writeFileSync(runEnvPath, "");
			await host.ensureRun({
				runId: "steer-run",
				name: "steer-worker",
				cwd: dir,
				runEnvPath,
				toolPolicy: "default",
				model: `${faux.getModel().provider}/${faux.getModel().id}`,
			});
			const client = new HostClient(layout.socketPath, 10_000);
			await client.submit("steer-run", "start work", "start");
			await started.promise;
			await client.submit("steer-run", "use approach B", "steer-1", "steer");
			await client.submit("steer-run", "keep the tests", "steer-2", "steer");
			let snapshot: unknown;
			stop = await client.watch("steer-run", (value) => {
				snapshot = value;
			});
			expect(
				buildAgentSessionView(snapshot)
					.filter((block) => block.kind === "notice")
					.map((block) => block.text),
			).toEqual([
				"Queued steering: use approach B",
				"Queued steering: keep the tests",
			]);
			firstResponse.resolve(toolResponse);
			for (
				let i = 0;
				i < 100 && (await host.status("steer-run")).status !== "idle";
				i++
			) {
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			expect((await host.status("steer-run")).status).toBe("idle");
			expect(requests).toEqual([
				["start work", "use approach B"],
				["start work", "use approach B", "keep the tests"],
			]);
			const entries = (await host.entriesForTest("steer-run")) as Array<{
				kind: string;
			}>;
			expect(entries.filter((entry) => entry.kind === "pi.user")).toHaveLength(
				3,
			);
			expect(
				entries.filter((entry) => entry.kind === "pi.tool-result"),
			).toHaveLength(2);
		} finally {
			firstResponse.resolve(toolResponse);
			stop?.();
			await host.shutdown();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
