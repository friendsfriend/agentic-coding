import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The pi telemetry bridge is loaded as a top-level-effect module by the pi
// runtime; copying it into the fake repo and importing a fresh copy per case
// runs recoverRunEnv against a scripted pointer file for each name shape.
async function runBridge(name: string, repo: string): Promise<void> {
	const savedArgv = process.argv;
	process.argv = ["pi", "--name", name];
	try {
		const module = path.join(repo, `bridge-${name}.ts`);
		fs.copyFileSync(
			path.resolve(
				import.meta.dir,
				"../../agent-definitions/bridges/pi-telemetry.ts",
			),
			module,
		);
		await import(module);
	} finally {
		process.argv = savedArgv;
	}
}

for (const name of ["planner-ab12cd34", "quality-verif-ab12cd34-12345678"]) {
	test(`pi telemetry bridge recovers run env via per-agent pointer (${name})`, async () => {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-recover-"));
		const savedCwd = process.cwd();
		try {
			const runtimeBin = path.join(repo, ".herdr-workflow", "runtime-bin");
			fs.mkdirSync(path.join(runtimeBin, "by-agent"), { recursive: true });
			fs.mkdirSync(path.join(runtimeBin, "run-1"), { recursive: true });
			fs.mkdirSync(path.join(runtimeBin, "00000000-run-9"), {
				recursive: true,
			});
			// A decoy from an unrelated run must not win over the pointer.
			fs.writeFileSync(
				path.join(runtimeBin, "00000000-run-9", "run.env"),
				"HERDR_RUN_ID=stale\n",
				{ mode: 0o600 },
			);
			fs.writeFileSync(
				path.join(runtimeBin, "run-1", "run.env"),
				"HERDR_RUN_ID=run-1\nHERDR_STEP_ID=core.implementation\n",
				{ mode: 0o600 },
			);
			fs.writeFileSync(
				path.join(runtimeBin, "by-agent", name),
				".herdr-workflow/runtime-bin/run-1/run.env\n",
				{ mode: 0o600 },
			);
			delete process.env.HERDR_RUN_ID;
			delete process.env.HERDR_STEP_ID;
			process.chdir(repo);
			await runBridge(name, repo);
			expect(String(process.env.HERDR_RUN_ID)).toBe("run-1");
			expect(String(process.env.HERDR_STEP_ID)).toBe("core.implementation");
		} finally {
			process.chdir(savedCwd);
			fs.rmSync(repo, { recursive: true, force: true });
		}
	});
}

test("pi telemetry bridge emits usage envelope with cache, duration, tok/s", async () => {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-usage-"));
	const telemetryPath = path.join(repo, "telemetry.jsonl");
	const savedPath = process.env.HERDR_TELEMETRY_PATH;
	process.env.HERDR_TELEMETRY_PATH = telemetryPath;
	try {
		const module = path.join(repo, "bridge-usage.ts");
		fs.copyFileSync(
			path.resolve(
				import.meta.dir,
				"../../agent-definitions/bridges/pi-telemetry.ts",
			),
			module,
		);
		const handlers = new Map<string, (event: unknown) => void>();
		const pi = {
			on: (event: string, handler: (event: unknown) => void) => {
				handlers.set(event, handler);
			},
		};
		const bridge = await import(module);
		bridge.default(pi);

		handlers.get("message_start")?.({ message: { role: "assistant" } });
		// Ensure measurable wall-clock generation time (millisecond resolution).
		await Bun.sleep(5);
		handlers.get("message_end")?.({
			message: {
				role: "assistant",
				usage: {
					input: 1200,
					output: 300,
					cacheRead: 900,
					cacheWrite: 0,
					totalTokens: 1500,
					cost: { total: 0.012 },
				},
			},
		});

		const lines = fs.readFileSync(telemetryPath, "utf8").trim().split("\n");
		expect(lines).toHaveLength(1);
		const envelope = JSON.parse(lines[0]) as Record<string, unknown>;
		expect(envelope.event).toBe("runtime.usage");
		expect(envelope.inputTokens).toBe(1200);
		expect(envelope.outputTokens).toBe(300);
		expect(envelope.cacheReadTokens).toBe(900);
		// An explicitly reported zero cache write must remain distinguishable from
		// unavailable cache-write telemetry.
		expect(envelope.cacheWriteTokens).toBe(0);
		expect(envelope.cost).toBe(0.012);
		expect(Number(envelope.durationMs)).toBeGreaterThan(0);
		expect(envelope.tokensPerSecond).toBeGreaterThan(0);
	} finally {
		if (savedPath === undefined) delete process.env.HERDR_TELEMETRY_PATH;
		else process.env.HERDR_TELEMETRY_PATH = savedPath;
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("pi telemetry bridge books tool durations, provider status, compaction, and settle totals", async () => {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-hooks-"));
	const telemetryPath = path.join(repo, "telemetry.jsonl");
	const savedPath = process.env.HERDR_TELEMETRY_PATH;
	process.env.HERDR_TELEMETRY_PATH = telemetryPath;
	try {
		const module = path.join(repo, "bridge-hooks.ts");
		fs.copyFileSync(
			path.resolve(
				import.meta.dir,
				"../../agent-definitions/bridges/pi-telemetry.ts",
			),
			module,
		);
		const handlers = new Map<string, (event: unknown, ctx?: unknown) => void>();
		// The fake api exposes only `on`; all session/model identity must come
		// from the handler context, exactly as the real ExtensionAPI does.
		const pi = {
			on: (event: string, handler: (event: unknown, ctx?: unknown) => void) => {
				handlers.set(event, handler);
			},
		};
		const ctx = {
			sessionManager: { getSessionId: () => "session-9" },
			model: { id: "model-a", provider: "provider-a" },
			thinkingLevel: "high",
			getContextUsage: () => ({
				percent: 55,
				tokens: 1234,
				contextWindow: 100000,
			}),
		};
		const bridge = await import(module);
		bridge.default(pi);

		handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
		handlers.get("turn_start")?.(
			{ type: "turn_start", turnIndex: 1, timestamp: Date.now() },
			ctx,
		);
		// Two tools overlap: their durations must not be assigned by completion order.
		handlers.get("tool_execution_start")?.(
			{ toolCallId: "call-a", toolName: "read", args: { path: "file.ts" } },
			ctx,
		);
		await Bun.sleep(5);
		handlers.get("tool_execution_start")?.(
			{ toolCallId: "call-b", toolName: "bash", args: { cmd: "ls" } },
			ctx,
		);
		await Bun.sleep(5);
		handlers.get("tool_execution_end")?.(
			{
				toolCallId: "call-b",
				toolName: "bash",
				isError: true,
				result: "SECRET-TOOL-OUTPUT",
			},
			ctx,
		);
		await Bun.sleep(5);
		handlers.get("tool_execution_end")?.(
			{
				toolCallId: "call-a",
				toolName: "read",
				isError: false,
				result: "ok",
			},
			ctx,
		);

		handlers.get("before_provider_request")?.(
			{ type: "before_provider_request", payload: {} },
			ctx,
		);
		await Bun.sleep(5);
		handlers.get("after_provider_response")?.(
			{ type: "after_provider_response", status: 500, headers: {} },
			ctx,
		);
		handlers.get("session_before_compact")?.(
			{
				type: "session_before_compact",
				preparation: { tokensBefore: 1000 },
				reason: "threshold",
			},
			ctx,
		);
		await Bun.sleep(5);
		handlers.get("session_compact")?.(
			{
				type: "session_compact",
				compactionEntry: { tokensBefore: 1000 },
				reason: "threshold",
				fromExtension: false,
				willRetry: false,
			},
			ctx,
		);
		handlers.get("turn_end")?.(
			{ type: "turn_end", turnIndex: 1, message: {}, toolResults: [{}, {}] },
			ctx,
		);
		handlers.get("message_end")?.(
			{
				message: {
					role: "assistant",
					usage: {
						input: 10,
						output: 20,
						cacheRead: 5,
						cacheWrite: 2,
						cost: { total: 0.25 },
					},
				},
			},
			ctx,
		);
		handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);

		const raw = fs.readFileSync(telemetryPath, "utf8");
		const events = raw
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const started = events.find((e) => e.event === "runtime.started");
		expect(started?.sessionId).toBe("session-9");
		expect(started?.["pi.model"]).toBe("model-a");
		expect(started?.["pi.provider"]).toBe("provider-a");
		expect(started?.["pi.thinking"]).toBe("high");

		const tools = events.filter((e) => e.event === "runtime.tool");
		expect(tools).toHaveLength(2);
		const bash = tools.find((e) => e["pi.tool.call_id"] === "call-b");
		const read = tools.find((e) => e["pi.tool.call_id"] === "call-a");
		expect(Number(bash?.["pi.tool.duration_ms"])).toBeGreaterThan(0);
		expect(Number(read?.["pi.tool.duration_ms"])).toBeGreaterThan(0);
		// call-a started before call-b, so it must report the longer duration.
		expect(Number(read?.["pi.tool.duration_ms"])).toBeGreaterThan(
			Number(bash?.["pi.tool.duration_ms"]),
		);
		expect(read?.["pi.tool.argument_bytes"]).toBeGreaterThan(0);
		expect(read?.["pi.tool.result_bytes"]).toBe(2);
		expect(bash?.outcome).toBe("error");
		// A failed tool reports a bounded class, never the result content.
		expect(bash?.["pi.error.class"]).toBe("tool_error");
		expect(raw).not.toContain("SECRET-TOOL-OUTPUT");

		const provider = events.find(
			(e) => e.event === "runtime.provider_response",
		);
		expect(provider?.["pi.provider.status"]).toBe(500);
		expect(Number(provider?.["pi.provider.latency_ms"])).toBeGreaterThanOrEqual(
			0,
		);
		expect(provider?.outcome).toBe("error");
		expect(provider?.["pi.error.class"]).toBe("http_500");

		const compaction = events.find((e) => e.event === "runtime.compaction");
		expect(compaction?.["pi.compaction.tokens_before"]).toBe(1000);
		expect(compaction?.["pi.compaction.tokens_after"]).toBe(1234);
		expect(Number(compaction?.["pi.compaction.duration_ms"])).toBeGreaterThan(
			0,
		);
		expect(compaction?.["pi.compaction.automatic"]).toBe(true);

		const turn = events.find((e) => e.event === "runtime.turn");
		expect(turn?.["pi.turn.index"]).toBe(1);
		expect(turn?.["pi.turn.tool_calls"]).toBe(2);
		expect(turn?.["pi.turn.tool_errors"]).toBe(1);

		const settle = events.find((e) => e.event === "runtime.settled");
		expect(settle?.["pi.context.percent"]).toBe(55);
		expect(settle?.["pi.context.tokens"]).toBe(1234);
		expect(settle?.["pi.session.turns"]).toBe(1);
		expect(settle?.["pi.session.tool_calls"]).toBe(2);
		expect(settle?.["pi.session.tool_errors"]).toBe(1);
		expect(settle?.["pi.session.input_tokens"]).toBe(10);
		expect(settle?.["pi.session.output_tokens"]).toBe(20);
		expect(settle?.["pi.session.cache_read_tokens"]).toBe(5);
		expect(settle?.["pi.session.cache_write_tokens"]).toBe(2);
		expect(settle?.["pi.session.cost"]).toBe(0.25);
		expect(handlers.has("tool_execution_update")).toBe(false);
		expect(handlers.has("message_update")).toBe(false);
	} finally {
		if (savedPath === undefined) delete process.env.HERDR_TELEMETRY_PATH;
		else process.env.HERDR_TELEMETRY_PATH = savedPath;
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("embedded bridge bundle contains the pointer-based recovery", async () => {
	const { AGENT_DEFINITIONS } = await import(
		"../src/workflow/embedded.generated.ts"
	);
	const source = AGENT_DEFINITIONS["bridges/pi-telemetry.ts"];
	expect(source).toContain("by-agent");
	expect(source).not.toMatch(/8-char suffix|startsWith\(runId8\)/);
});
