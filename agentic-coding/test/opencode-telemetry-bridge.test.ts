import { expect, test } from "bun:test";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);

type BridgeEvent = { type: string; properties?: Record<string, unknown> };

async function loadHandler(
	name: "opencode-telemetry.js" | "opencode-v2-telemetry.js",
	repo: string,
): Promise<(input: { event: BridgeEvent }) => Promise<void>> {
	const source = path.resolve(
		import.meta.dir,
		"../../agent-definitions/bridges",
		name,
	);
	const target = path.join(repo, name);
	fs.copyFileSync(source, target);
	const module = require(target) as () => Promise<{
		event: (input: { event: BridgeEvent }) => Promise<void>;
	}>;
	const bridge = await module();
	return bridge.event;
}

function readEnvelopes(file: string): Array<Record<string, unknown>> {
	if (!fs.existsSync(file)) return [];
	return fs
		.readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

for (const name of [
	"opencode-telemetry.js",
	"opencode-v2-telemetry.js",
] as const) {
	test(`${name} discriminates parts and drops noise`, async () => {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), `bridge-${name}-`));
		const telemetryPath = path.join(repo, "telemetry.jsonl");
		const saved = process.env.HERDR_TELEMETRY_PATH;
		process.env.HERDR_TELEMETRY_PATH = telemetryPath;
		try {
			const emit = await loadHandler(name, repo);
			// v1 keeps the session id on the part; v2 duplicates it on properties.
			// Both paths must resolve the same identity (OPENSPEC-009).
			const part = (value: Record<string, unknown>, withSession = false) =>
				emit({
					event: {
						type: "message.part.updated",
						properties: {
							...(withSession ? { sessionID: "s-1" } : {}),
							part: { sessionID: "s-1", ...value },
						},
					},
				});
			await part({ type: "step-start" });
			await Bun.sleep(5);
			await part({
				type: "step-finish",
				cost: 0.03,
				tokens: {
					input: 10,
					output: 20,
					reasoning: 3,
					cache: { read: 4, write: 5 },
				},
				reason: "stop",
			});
			await part({
				type: "tool",
				tool: "bash",
				callID: "call-1",
				state: {
					status: "error",
					error: { message: "failed hard" },
					input: { command: "ls" },
					output: "x".repeat(50),
					time: { start: 100, end: 175 },
				},
			});
			await part({ type: "text", text: "hello world" });
			await part({ type: "retry", attempt: 2, reason: "rate limited" });
			await part({ type: "compaction", auto: true });
			await emit({
				event: {
					type: "session.status",
					properties: {
						sessionID: "s-1",
						status: { type: "retry", attempt: 3, next: 500, message: "again" },
					},
				},
			});
			await emit({
				event: {
					type: "session.error",
					properties: {
						sessionID: "s-1",
						error: { message: "boom" },
						retryable: true,
					},
				},
			});
			await emit({
				event: {
					type: "permission.asked",
					properties: {
						id: "perm-1",
						permission: "bash",
						patterns: ["a", "b"],
					},
				},
			});
			await emit({
				event: {
					type: "permission.replied",
					properties: { id: "perm-1", reply: "once" },
				},
			});
			await emit({
				event: {
					type: "todo.updated",
					properties: {
						sessionID: "s-1",
						todos: [
							{ status: "completed" },
							{ status: "in_progress" },
							{ status: "pending" },
							{ status: "pending" },
						],
					},
				},
			});
			await emit({
				event: {
					type: "session.diff",
					properties: {
						sessionID: "s-1",
						diff: [
							{ file: "a.ts", additions: 3, deletions: 1 },
							{ file: "b.ts", additions: 2, deletions: 2 },
						],
					},
				},
			});
			await emit({
				event: {
					type: "message.updated",
					properties: {
						sessionID: "s-1",
						info: {
							role: "assistant",
							modelID: "model-x",
							providerID: "provider-y",
						},
					},
				},
			});
			for (const noise of [
				"pty.data",
				"tui.render",
				"server.started",
				"installation.updated",
				"lsp.updated",
				"file.watcher.changed",
			]) {
				await emit({ event: { type: noise, properties: {} } });
			}

			const events = readEnvelopes(telemetryPath);
			const step = events.find((e) => e.event === "runtime.step_finish");
			expect(step?.["oc.cost"]).toBe(0.03);
			expect(step?.["oc.tokens.input"]).toBe(10);
			expect(step?.["oc.tokens.cache_read"]).toBe(4);
			expect(step?.["oc.finish.reason"]).toBe("stop");
			// Duration is tracked from the step-start boundary, not the event.
			expect(Number(step?.["oc.step.duration_ms"])).toBeGreaterThan(0);
			expect(step?.sessionId).toBe("s-1");
			expect(step?.runtime).toBe(
				name === "opencode-telemetry.js" ? "opencode" : "opencode-v2",
			);

			const tool = events.find((e) => e.event === "runtime.tool");
			expect(tool?.["oc.tool.name"]).toBe("bash");
			expect(tool?.["oc.tool.call_id"]).toBe("call-1");
			expect(tool?.["oc.tool.duration_ms"]).toBe(75);
			expect(typeof tool?.["oc.error.class"]).toBe("string");
			expect(tool?.outcome).toBe("error");

			const text = events.find((e) => e.event === "runtime.part_length");
			expect(text?.["oc.part.length"]).toBe("hello world".length);
			expect(JSON.stringify(text)).not.toContain("hello world");

			const retry = events.find((e) => e.event === "runtime.retry");
			expect(retry?.["oc.retry.attempt"]).toBe(2);
			const compaction = events.find((e) => e.event === "runtime.compaction");
			expect(compaction?.["oc.compaction.automatic"]).toBe(true);
			const status = events.find((e) => e.event === "runtime.session_status");
			expect(status?.["oc.session.status"]).toBe("retry");
			expect(status?.["oc.retry.attempt"]).toBe(3);
			const error = events.find((e) => e.event === "runtime.session_error");
			expect(error?.outcome).toBe("error");
			expect(error?.["oc.error.retryable"]).toBe(true);
			const asked = events.find(
				(e) => e.event === "runtime.permission_request",
			);
			expect(asked?.["oc.permission.type"]).toBe("bash");
			expect(asked?.["oc.permission.patterns"]).toBe(2);
			const replied = events.find(
				(e) => e.event === "runtime.permission_reply",
			);
			expect(replied?.["oc.permission.reply"]).toBe("once");
			const todos = events.find((e) => e.event === "runtime.todos");
			expect(todos?.["oc.todo.total"]).toBe(4);
			expect(todos?.["oc.todo.pending"]).toBe(2);
			expect(todos?.["oc.todo.completed"]).toBe(1);
			const diff = events.find((e) => e.event === "runtime.diff");
			expect(diff?.["oc.diff.files"]).toBe(2);
			expect(diff?.["oc.diff.additions"]).toBe(5);
			expect(diff?.["oc.diff.deletions"]).toBe(3);
			const message = events.find((e) => e.event === "runtime.message");
			expect(message?.["oc.model"]).toBe("model-x");
			expect(message?.["oc.provider"]).toBe("provider-y");

			const noiseEvents = events.filter((e) =>
				/(pty|tui|server|installation|lsp|file\.watcher)/.test(String(e.event)),
			);
			expect(noiseEvents).toHaveLength(0);
		} finally {
			if (saved === undefined) delete process.env.HERDR_TELEMETRY_PATH;
			else process.env.HERDR_TELEMETRY_PATH = saved;
			fs.rmSync(repo, { recursive: true, force: true });
		}
	});
}

test("the two opencode bridge variants stay at parity", () => {
	const read = (name: string) =>
		fs
			.readFileSync(
				path.resolve(
					import.meta.dir,
					`../../agent-definitions/bridges/${name}`,
				),
				"utf8",
			)
			.replace(/opencode-v2/g, "opencode");
	expect(read("opencode-v2-telemetry.js")).toBe(read("opencode-telemetry.js"));
});
