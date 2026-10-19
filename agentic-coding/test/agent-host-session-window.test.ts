// durable-agent-telemetry / herdr-agent-telemetry: the session window
// (efficiency backlog item 20, "a run's window is its session's window").
//
// A durable host keys one pi-durable conversation per canonical agent name, so
// every later run of the same step and role is served by the same conversation.
// Two things are pinned here:
//
// 1. the conversation's runtime telemetry identity follows the run that is
//    working, so a later run's turns are that run's and the run that created the
//    conversation keeps only its own;
// 2. the host states the move as the session window — `opened` with its reason
//    (`created`, `rebound`, `adopted`, `resumed`) and `closed` for the run it
//    leaves — carrying the conversation id as the session identity.
//
// Both are observational: the run's own window (the engine's `started_at` to its
// `agent.handoff`) is untouched, and nothing here writes workflow state.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
} from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { DurableHost } from "../src/agent-host/host.ts";
import { hostLayout } from "../src/agent-host/layout.ts";

function tempWorkflowDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "agent-host-session-window-"));
}

function writeRunEnv(dir: string, name: string, vars: Record<string, string>) {
	const file = path.join(dir, `${name}.run.env`);
	fs.writeFileSync(
		file,
		Object.entries(vars)
			.map(([key, value]) => `${key}='${value}'`)
			.join("\n"),
	);
	return file;
}

/** One durable host with a faux provider and its own telemetry file. */
async function openHost(dir: string): Promise<{
	host: DurableHost;
	faux: ReturnType<typeof fauxProvider>;
	telemetryPath: string;
	model: string;
}> {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const host = await DurableHost.open({
		layout: hostLayout(dir),
		settings: {},
		globalAgentDir: dir,
		storage: new MemoryStorage(),
		models,
	});
	return {
		host,
		faux,
		telemetryPath: path.join(dir, "telemetry.jsonl"),
		model: `${faux.getModel().provider}/${faux.getModel().id}`,
	};
}

/** One plain turn on `runId`, driven to idle like every other host test. */
async function oneTurn(
	host: DurableHost,
	faux: ReturnType<typeof fauxProvider>,
	runId: string,
): Promise<void> {
	faux.setResponses([fauxAssistantMessage([fauxText("done")])]);
	await host.submit(runId, `work for ${runId}`, `req-${runId}`);
	let status = await host.status(runId);
	for (let index = 0; index < 100 && status.status !== "idle"; index += 1) {
		await new Promise((resolve) => setTimeout(resolve, 20));
		status = await host.status(runId);
	}
}

function readEnvelopes(telemetryPath: string): Array<Record<string, unknown>> {
	if (!fs.existsSync(telemetryPath)) return [];
	return fs
		.readFileSync(telemetryPath, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Wait until `count` envelopes of `event` are on the telemetry file. */
async function waitForEnvelopes(
	telemetryPath: string,
	event: string,
	count: number,
): Promise<Array<Record<string, unknown>>> {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		const found = readEnvelopes(telemetryPath).filter(
			(envelope) => envelope.event === event,
		);
		if (found.length >= count) return readEnvelopes(telemetryPath);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return readEnvelopes(telemetryPath);
}

const SESSION_EVENTS = new Set([
	"runtime.session_window.opened",
	"runtime.session_window.closed",
]);

describe("the session window of a durable conversation", () => {
	test("a later run on the same conversation records the rebinding and its own turns", async () => {
		const dir = tempWorkflowDir();
		const { host, faux, telemetryPath, model } = await openHost(dir);
		const envFor = (runId: string) =>
			writeRunEnv(dir, runId, {
				HERDR_WORKFLOW_ID: "wf-window",
				HERDR_RUN_ID: runId,
				HERDR_STEP_ID: "core.implementation",
				HERDR_ROLE: "worker",
				HERDR_PROFILE: "durable-default",
				HERDR_TELEMETRY_PATH: telemetryPath,
			});
		const envA = envFor("run-a");
		const envB = envFor("run-b");
		const envBBytes = fs.readFileSync(envB, "utf8");

		// The first run creates the conversation: `opened(created)`.
		const first = await host.ensureRun({
			runId: "run-a",
			name: "worker-window",
			cwd: dir,
			runEnvPath: envA,
			toolPolicy: "default",
			model,
		});
		await oneTurn(host, faux, "run-a");
		await waitForEnvelopes(telemetryPath, "runtime.turn_started", 1);
		const runATurns = readEnvelopes(telemetryPath).filter(
			(envelope) => envelope.event === "runtime.turn_started",
		);
		expect(runATurns).toHaveLength(1);
		expect(runATurns[0]?.runId).toBe("run-a");

		// The engine retires run-a, and the next run of the same step and role is
		// served by the same conversation.
		await host.stopRun("run-a");
		const second = await host.ensureRun({
			runId: "run-b",
			name: "worker-window",
			cwd: dir,
			runEnvPath: envB,
			toolPolicy: "default",
			model,
		});
		expect(second.conversationId).toBe(first.conversationId);
		const rebound = readEnvelopes(telemetryPath).filter((envelope) =>
			SESSION_EVENTS.has(String(envelope.event)),
		);
		expect(rebound.map((envelope) => envelope.event)).toEqual([
			"runtime.session_window.opened",
			"runtime.session_window.closed",
			"runtime.session_window.opened",
		]);
		const [created, closed, opened] = rebound;
		expect(created?.runId).toBe("run-a");
		expect(created?.["herdr.session.reason"]).toBe("created");
		expect(created?.sessionId).toBe(first.conversationId);
		// The run that is left is named by the event that closes its window, and
		// the run that continues is named by the one that opens.
		expect(closed?.runId).toBe("run-a");
		expect(closed?.["herdr.session.rebound_to"]).toBe("run-b");
		expect(closed?.sessionId).toBe(first.conversationId);
		expect(opened?.runId).toBe("run-b");
		expect(opened?.["herdr.session.reason"]).toBe("rebound");
		expect(opened?.["herdr.session.previous_run_id"]).toBe("run-a");
		expect(opened?.sessionId).toBe(first.conversationId);
		// Both session-window events carry the workflow, so the dataset can judge a
		// tail per workflow.
		for (const envelope of rebound)
			expect(envelope.workflowId).toBe("wf-window");

		// The later run's turns are its own; the earlier run keeps only its own.
		await oneTurn(host, faux, "run-b");
		const all = await waitForEnvelopes(
			telemetryPath,
			"runtime.turn_started",
			2,
		);
		const turnEvents = all.filter(
			(envelope) => envelope.event === "runtime.turn_started",
		);
		expect(turnEvents.map((envelope) => envelope.runId)).toEqual([
			"run-a",
			"run-b",
		]);
		const usage = all.filter((envelope) => envelope.event === "runtime.usage");
		expect(new Set(usage.map((envelope) => envelope.runId))).toEqual(
			new Set(["run-a", "run-b"]),
		);
		// Nothing the record wrote could complete a run: the host emits no handoff.
		expect(
			all.some((envelope) => String(envelope.event).includes("handoff")),
		).toBe(false);
		// …and the run's own environment is untouched by the record.
		expect(fs.readFileSync(envB, "utf8")).toBe(envBBytes);
		await host.shutdown();
	});

	test("a run bound to the same conversation again records `resumed` and no close", async () => {
		const dir = tempWorkflowDir();
		const { host, faux, telemetryPath, model } = await openHost(dir);
		const runEnvPath = writeRunEnv(dir, "run-resume", {
			HERDR_WORKFLOW_ID: "wf-resume",
			HERDR_RUN_ID: "run-resume",
			HERDR_TELEMETRY_PATH: telemetryPath,
		});
		const ensure = () =>
			host.ensureRun({
				runId: "run-resume",
				name: "worker-resume",
				cwd: dir,
				runEnvPath,
				toolPolicy: "default",
				model,
			});
		await ensure();
		await oneTurn(host, faux, "run-resume");
		const before = await host.status("run-resume");
		// The aborted run is resumed: the engine ensures the same run id on the
		// same conversation, which is `resumed` — the run's window is not reopened.
		await ensure();
		const after = await host.status("run-resume");
		expect(after).toEqual(before);
		const envelopes = await waitForEnvelopes(
			telemetryPath,
			"runtime.session_window.opened",
			2,
		);
		const sessionEvents = envelopes.filter((envelope) =>
			SESSION_EVENTS.has(String(envelope.event)),
		);
		expect(sessionEvents.map((envelope) => envelope.event)).toEqual([
			"runtime.session_window.opened",
			"runtime.session_window.opened",
		]);
		expect(sessionEvents[0]?.["herdr.session.reason"]).toBe("created");
		expect(sessionEvents[1]?.["herdr.session.reason"]).toBe("resumed");
		expect(sessionEvents[1]?.runId).toBe("run-resume");
		expect(sessionEvents[1]?.["herdr.session.previous_run_id"]).toBeUndefined();
		await host.shutdown();
	});

	test("a conversation the host did not bind (a restart) records `adopted`", async () => {
		const dir = tempWorkflowDir();
		const telemetryPath = path.join(dir, "telemetry.jsonl");
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const model = `${faux.getModel().provider}/${faux.getModel().id}`;
		const layout = hostLayout(dir);
		// A file-backed durable store, so a second host finds the first one's run
		// map and its conversation — exactly the restart the record has to survive.
		const first = await DurableHost.open({
			layout,
			settings: {},
			globalAgentDir: dir,
			models,
		});
		const before = await first.ensureRun({
			runId: "run-before",
			name: "worker-adopt",
			cwd: dir,
			runEnvPath: writeRunEnv(dir, "run-before", {
				HERDR_WORKFLOW_ID: "wf-adopt",
				HERDR_RUN_ID: "run-before",
				HERDR_TELEMETRY_PATH: telemetryPath,
			}),
			toolPolicy: "default",
			model,
		});
		await first.shutdown();

		const second = await DurableHost.open({
			layout,
			settings: {},
			globalAgentDir: dir,
			models,
		});
		const adopted = await second.ensureRun({
			runId: "run-after",
			name: "worker-adopt",
			cwd: dir,
			runEnvPath: writeRunEnv(dir, "run-after", {
				HERDR_WORKFLOW_ID: "wf-adopt",
				HERDR_RUN_ID: "run-after",
				HERDR_TELEMETRY_PATH: telemetryPath,
			}),
			toolPolicy: "default",
			model,
		});
		expect(adopted.conversationId).toBe(before.conversationId);
		const sessionEvents = readEnvelopes(telemetryPath).filter((envelope) =>
			SESSION_EVENTS.has(String(envelope.event)),
		);
		expect(sessionEvents.map((envelope) => envelope.event)).toEqual([
			"runtime.session_window.opened",
			"runtime.session_window.opened",
		]);
		expect(sessionEvents[0]?.["herdr.session.reason"]).toBe("created");
		// The previous run's window cannot be closed: this host never knew it.
		expect(sessionEvents[1]?.["herdr.session.reason"]).toBe("adopted");
		expect(sessionEvents[1]?.runId).toBe("run-after");
		expect(sessionEvents[1]?.["herdr.session.previous_run_id"]).toBeUndefined();
		expect(sessionEvents[1]?.sessionId).toBe(before.conversationId);
		await second.shutdown();
	});

	test("a conversation with no run id records nothing", async () => {
		const dir = tempWorkflowDir();
		const { host, faux, telemetryPath, model } = await openHost(dir);
		await host.ensureRun({
			runId: "run-orchestrator",
			name: "orchestrator",
			cwd: dir,
			// An orchestrator session carries no run id: the analysis is about runs,
			// so the session window says nothing about it.
			runEnvPath: writeRunEnv(dir, "run-orchestrator", {
				HERDR_WORKFLOW_ID: "wf-orchestrator",
				HERDR_TELEMETRY_PATH: telemetryPath,
			}),
			toolPolicy: "default",
			model,
		});
		await oneTurn(host, faux, "run-orchestrator");
		await waitForEnvelopes(telemetryPath, "runtime.turn_started", 1);
		const envelopes = readEnvelopes(telemetryPath);
		expect(envelopes.length).toBeGreaterThan(0);
		expect(
			envelopes.filter((envelope) =>
				SESSION_EVENTS.has(String(envelope.event)),
			),
		).toEqual([]);
		await host.shutdown();
	});
});
