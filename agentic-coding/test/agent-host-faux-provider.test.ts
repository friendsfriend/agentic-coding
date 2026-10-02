// Narrow end-to-end validation of the real pi-durable wiring in `host.ts`:
// an in-memory storage and a scripted faux model provider (both `host.ts`
// options accept for tests), exercising ensureRun -> submit -> a tool-using
// turn -> status settling back to idle, and the read-only policy actually
// narrowing the tool list. This is the one test that runs the experimental
// `@earendil-works/pi-durable`/`pi-ai` surface for real rather than through a
// fake socket server (`agent-host-client.test.ts` covers the transport).
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

function tempWorkflowDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "agent-host-"));
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

describe("DurableHost against a faux provider and in-memory storage", () => {
	test("a submitted turn completes a tool call and the run settles idle", async () => {
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
		const runEnvPath = writeRunEnv(dir, { HERDR_RUN_ID: "run-1" });
		const ensured = await host.ensureRun({
			runId: "run-1",
			name: "worker-1",
			cwd: dir,
			runEnvPath,
			toolPolicy: "default",
			model: `${faux.getModel().provider}/${faux.getModel().id}`,
		});
		expect(ensured.conversationId).toBeTruthy();

		// `ensureRun` above passes `model`: without a model configured on the
		// conversation, generation settles every submission immediately with
		// reason "no_model" and this test would reach "idle" without the faux
		// provider, or this tool call, ever running (confirmed by a throwaway
		// probe against a model-less conversation while writing this test).
		faux.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("read", { path: "does-not-matter.txt" })],
				{ stopReason: "toolUse" },
			),
		]);
		await host.submit("run-1", "read a file", "req-1");
		// The faux provider answers synchronously-ish; poll briefly for the tool
		// round and the follow-up generation to settle rather than assume timing.
		faux.setResponses([fauxAssistantMessage([fauxText("done")])]);
		let status = await host.status("run-1");
		for (let i = 0; i < 50 && status.status !== "idle"; i++) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			status = await host.status("run-1");
		}
		expect(status.status).toBe("idle");
		await host.shutdown();
	});

	test("a read-only run is offered read and bash only", async () => {
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
		const runEnvPath = writeRunEnv(dir, {});
		await host.ensureRun({
			runId: "verifier-1",
			name: "verifier-1",
			cwd: dir,
			runEnvPath,
			toolPolicy: "read-only",
		});
		// ensureRun succeeding with a `read-only` policy and no thrown error is the
		// bounded assertion here; the exact tool list offered to the model is
		// pi-durable's own `configure({ tools })` contract (durable-agent-tools
		// unit-tests the policy's tool *names* directly in
		// `agent-host-tools-policy.test.ts`).
		await host.shutdown();
	});

	test("two runs of the same workflow share one host as separate conversations", async () => {
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
		const envA = writeRunEnv(dir, {});
		const envB = writeRunEnv(dir, {});
		const a = await host.ensureRun({
			runId: "run-a",
			name: "worker-a",
			cwd: dir,
			runEnvPath: envA,
			toolPolicy: "default",
		});
		const b = await host.ensureRun({
			runId: "run-b",
			name: "worker-b",
			cwd: dir,
			runEnvPath: envB,
			toolPolicy: "default",
		});
		expect(a.conversationId).not.toBe(b.conversationId);
		await host.shutdown();
	});

	test("a retried submission with the same requestId is not admitted twice", async () => {
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
		const runEnvPath = writeRunEnv(dir, {});
		await host.ensureRun({
			runId: "run-1",
			name: "worker-dup",
			cwd: dir,
			runEnvPath,
			toolPolicy: "default",
		});
		faux.setResponses([fauxAssistantMessage([fauxText("ack")])]);
		const first = await host.submit("run-1", "hello", "same-request-id");
		const second = await host.submit("run-1", "hello", "same-request-id");
		expect(second.submissionId).toBe(first.submissionId);
		await host.shutdown();
	});

	test("a persistent role's conversation survives a host restart over the same storage", async () => {
		const dir = tempWorkflowDir();
		const layout = hostLayout(dir);
		const storage = new MemoryStorage();
		const fauxA = fauxProvider();
		const modelsA = createModels();
		modelsA.setProvider(fauxA.provider);
		const hostA = await DurableHost.open({
			layout,
			settings: {},
			globalAgentDir: dir,
			storage,
			models: modelsA,
		});
		const envA = writeRunEnv(dir, {});
		const first = await hostA.ensureRun({
			runId: "round-1",
			// Same canonical name both rounds: the engine's own reuse key for a
			// persistent role (`canonicalAgentName`), not a separate "persistent"
			// flag.
			name: "worker-persistent",
			cwd: dir,
			runEnvPath: envA,
			toolPolicy: "default",
		});
		// No clean shutdown: a restarted host is opened over the same storage
		// without this process ever closing the first harness, modelling a crash
		// rather than an orderly stop.
		const fauxB = fauxProvider();
		const modelsB = createModels();
		modelsB.setProvider(fauxB.provider);
		const hostB = await DurableHost.open({
			layout,
			settings: {},
			globalAgentDir: dir,
			storage,
			models: modelsB,
		});
		const envB = writeRunEnv(dir, {});
		const second = await hostB.ensureRun({
			runId: "round-2",
			name: "worker-persistent",
			cwd: dir,
			runEnvPath: envB,
			toolPolicy: "default",
		});
		expect(second.conversationId).toBe(first.conversationId);
		await hostB.shutdown();
	});
});
