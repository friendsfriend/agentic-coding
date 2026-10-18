// durable-agent-tools: "Runtime telemetry envelopes". Verifies a durable
// turn emits metadata-only envelopes by default, tagged runtime="pi-
// durable", and that content capture requires the explicit opt-in.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { DurableHost } from "../src/agent-host/host.ts";
import { hostLayout } from "../src/agent-host/layout.ts";
import { agentMetrics } from "../src/workflow/run-projections.ts";

function tempWorkflowDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "agent-host-telemetry-"));
}

function writeRunEnv(dir: string, vars: Record<string, string>): string {
	const file = path.join(dir, "run.env");
	fs.writeFileSync(
		file,
		Object.entries(vars)
			.map(([k, v]) => `${k}='${v}'`)
			.join("\n"),
	);
	return file;
}

async function waitForLines(
	telemetryPath: string,
	min: number,
	attempts = 50,
): Promise<string[]> {
	for (let i = 0; i < attempts; i++) {
		if (fs.existsSync(telemetryPath)) {
			const lines = fs
				.readFileSync(telemetryPath, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean);
			if (lines.length >= min) return lines;
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return fs.existsSync(telemetryPath)
		? fs.readFileSync(telemetryPath, "utf8").trim().split("\n").filter(Boolean)
		: [];
}

describe("tool-call telemetry shape", () => {
	/** One faux turn whose tool call fails, plus one that succeeds. */
	async function runToolTurn(options: {
		tool: string;
		args: Record<string, unknown>;
		callId: string;
		/** Set to echo a secret-looking value into the tool's own result. */
		secret?: string;
	}): Promise<{ dir: string; envelopes: Array<Record<string, unknown>> }> {
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
		const telemetryPath = path.join(dir, "telemetry.jsonl");
		const runEnvPath = writeRunEnv(dir, {
			HERDR_WORKFLOW_ID: "wf-shape",
			HERDR_RUN_ID: "run-shape",
			HERDR_STEP_ID: "core.implementation",
			HERDR_ROLE: "worker",
			HERDR_PROFILE: "durable-default",
			HERDR_RUN_GENERATION: "2",
			HERDR_TELEMETRY_PATH: telemetryPath,
		});
		await host.ensureRun({
			runId: "run-shape",
			name: "worker-shape",
			cwd: dir,
			runEnvPath,
			toolPolicy: "default",
			model: `${faux.getModel().provider}/${faux.getModel().id}`,
		});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall(options.tool, options.args)], {
				stopReason: "toolUse",
			}),
		]);
		faux.appendResponses([fauxAssistantMessage([fauxText("done")])]);
		await host.submit("run-shape", "do the thing", options.callId);
		let status = await host.status("run-shape");
		for (let i = 0; i < 100 && status.status !== "idle"; i++) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			status = await host.status("run-shape");
		}
		const lines = await waitForLines(telemetryPath, 3);
		const envelopes = lines.map(
			(line) => JSON.parse(line) as Record<string, unknown>,
		);
		await host.shutdown();
		return { dir, envelopes };
	}

	test("records what was asked, how long it took and why it failed", async () => {
		const { dir, envelopes } = await runToolTurn({
			tool: "read",
			args: { path: "missing-file.txt" },
			callId: "req-shape-1",
		});
		const start = envelopes.find((e) => e.event === "runtime.tool_start");
		expect(start).toBeDefined();
		expect(start?.["pi.tool.name"]).toBe("read");
		expect(start?.["pi.tool.args_digest"]).toBe("read missing-file.txt");
		expect(String(start?.["pi.tool.args_hash"])).toHaveLength(16);
		expect(start?.["pi.tool.argument_bytes"]).toBeGreaterThan(0);
		expect(start?.["pi.turn.index"]).toBe(0);
		// Every envelope of a run carries the run's generation.
		expect(start?.["herdr.run.generation"]).toBe(2);

		const end = envelopes.find((e) => e.event === "runtime.tool");
		expect(end).toBeDefined();
		// A failed call is recorded as failed even though its result entry
		// survived, and the failure is a code, not a `tool_error` blob.
		expect(end?.outcome).toBe("error");
		expect(end?.["pi.tool.ok"]).toBe(false);
		expect(end?.["pi.tool.failure_kind"]).toBe("not-found");
		expect(end?.["pi.tool.duration_ms"]).toBeGreaterThanOrEqual(0);
		expect(end?.["pi.tool.result_bytes"]).toBeGreaterThan(0);
		expect(end?.["pi.tool.result_lines"]).toBeGreaterThan(0);
		expect(end?.["pi.tool.result_truncated"]).toBe(false);
		// The result's own text never appears anywhere in the file.
		const text = fs.readFileSync(path.join(dir, "telemetry.jsonl"), "utf8");
		expect(text).not.toContain("ENOENT");
		expect(text).not.toContain("no such file");
	});

	test("a successful call states its outcome and size", async () => {
		const { envelopes } = await runToolTurn({
			tool: "bash",
			args: { command: "echo sk-live-abcdefghijklmnop" },
			callId: "req-shape-2",
		});
		const end = envelopes.find((e) => e.event === "runtime.tool");
		expect(end?.["pi.tool.ok"]).toBe(true);
		expect(end?.outcome).toBe("ok");
		expect(end?.["pi.tool.failure_kind"]).toBeUndefined();
		expect(end?.["pi.tool.result_bytes"]).toBeGreaterThan(0);
	});

	test("a secret-looking argument never reaches the telemetry file", async () => {
		const secret = "sk-live-abcdefghijklmnop";
		const { dir, envelopes } = await runToolTurn({
			tool: "bash",
			args: {
				command: `curl -H 'Authorization: Bearer ${secret}' https://example.com`,
			},
			callId: "req-shape-3",
		});
		const text = fs.readFileSync(path.join(dir, "telemetry.jsonl"), "utf8");
		expect(text).not.toContain(secret);
		expect(text).not.toContain("Bearer");
		const start = envelopes.find((e) => e.event === "runtime.tool_start");
		expect(String(start?.["pi.tool.args_digest"])).toContain("bash curl");
		expect(String(start?.["pi.tool.args_digest"])).toContain("«redacted");
	});
});

describe("durable host telemetry", () => {
	test("a tool-using turn emits metadata-only runtime envelopes by default", async () => {
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
		const telemetryPath = path.join(dir, "telemetry.jsonl");
		const runEnvPath = writeRunEnv(dir, {
			HERDR_WORKFLOW_ID: "wf-1",
			HERDR_RUN_ID: "run-1",
			HERDR_STEP_ID: "core.implementation",
			HERDR_ROLE: "worker",
			HERDR_PROFILE: "durable-default",
			HERDR_TELEMETRY_PATH: telemetryPath,
		});
		await host.ensureRun({
			runId: "run-1",
			name: "worker-telemetry",
			cwd: dir,
			runEnvPath,
			toolPolicy: "default",
			model: `${faux.getModel().provider}/${faux.getModel().id}`,
		});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "x.txt" })], {
				stopReason: "toolUse",
			}),
		]);
		faux.appendResponses([fauxAssistantMessage([fauxText("done")])]);
		await host.submit("run-1", "read a file", "req-1");
		let status = await host.status("run-1");
		for (let i = 0; i < 50 && status.status !== "idle"; i++) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			status = await host.status("run-1");
		}
		const lines = await waitForLines(telemetryPath, 2);
		expect(lines.length).toBeGreaterThan(0);
		const envelopes = lines.map((line) => JSON.parse(line));
		for (const envelope of envelopes) {
			expect(envelope.layer).toBe("runtime");
			expect(envelope.runtime).toBe("pi-durable");
			expect(envelope.workflowId).toBe("wf-1");
			expect(envelope.runId).toBe("run-1");
			expect(JSON.stringify(envelope)).not.toContain("herdr.content");
		}
		expect(envelopes.some((e) => e.event === "runtime.tool_start")).toBe(true);
		expect(envelopes.some((e) => e.event === "runtime.tool")).toBe(true);
		// One usage envelope per committed assistant message: this is what the
		// dashboard's per-agent cost/token/tok-s projection aggregates, and what
		// persists for long-term monitoring.
		const usage = envelopes.find((e) => e.event === "runtime.usage");
		expect(usage).toBeDefined();
		expect(usage.workflowId).toBe("wf-1");
		expect(usage.runId).toBe("run-1");
		expect(usage.role).toBe("worker");
		expect(usage.outputTokens).toBeGreaterThan(0);
		expect(usage.inputTokens).toBeGreaterThan(0);
		const metrics = agentMetrics(envelopes).get("worker");
		expect(metrics?.outputTokens).toBeGreaterThan(0);
		expect(metrics?.inputTokens).toBeGreaterThan(0);
		await host.shutdown();
	});

	test("content capture requires the explicit per-run opt-in", async () => {
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
		const telemetryPath = path.join(dir, "telemetry.jsonl");
		const runEnvPath = writeRunEnv(dir, {
			HERDR_RUN_ID: "run-2",
			HERDR_TELEMETRY_PATH: telemetryPath,
			HERDR_CAPTURE_CONTENT: "1",
		});
		await host.ensureRun({
			runId: "run-2",
			name: "worker-telemetry-capture",
			cwd: dir,
			runEnvPath,
			toolPolicy: "default",
			model: `${faux.getModel().provider}/${faux.getModel().id}`,
		});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "secret.txt" })], {
				stopReason: "toolUse",
			}),
		]);
		faux.appendResponses([fauxAssistantMessage([fauxText("done")])]);
		await host.submit("run-2", "read a file", "req-1");
		let status = await host.status("run-2");
		for (let i = 0; i < 50 && status.status !== "idle"; i++) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			status = await host.status("run-2");
		}
		const lines = await waitForLines(telemetryPath, 1);
		const envelopes = lines.map((line) => JSON.parse(line));
		expect(
			envelopes.some((e) => typeof e["herdr.content.tool_input"] === "string"),
		).toBe(true);
		await host.shutdown();
	});
});
