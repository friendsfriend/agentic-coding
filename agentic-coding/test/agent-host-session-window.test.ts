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
import { ensureAdmittedFixtureRun } from "./support/admitted-host.ts";

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
		const first = await ensureAdmittedFixtureRun(host, {
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
		const second = await ensureAdmittedFixtureRun(host, {
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
		expect(created?.["herdr.session.conversation_id"]).toBe(
			first.conversationId,
		);
		// The run that is left is named by the event that closes its window, and
		// the run that continues is named by the one that opens.
		expect(closed?.runId).toBe("run-a");
		expect(closed?.["herdr.session.rebound_to"]).toBe("run-b");
		expect(closed?.["herdr.session.conversation_id"]).toBe(
			first.conversationId,
		);
		expect(opened?.runId).toBe("run-b");
		expect(opened?.["herdr.session.reason"]).toBe("rebound");
		expect(opened?.["herdr.session.previous_run_id"]).toBe("run-a");
		expect(opened?.["herdr.session.conversation_id"]).toBe(
			first.conversationId,
		);
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
			ensureAdmittedFixtureRun(host, {
				runId: "run-resume",
				name: "worker-resume",
				cwd: dir,
				runEnvPath,
				toolPolicy: "default",
				model,
			});
		await ensure();
		await oneTurn(host, faux, "run-resume");
		// Wait for the run's own frames to be complete before reading: the delta below
		// must be the record's, not a trailing envelope that happened to land late.
		const before = await waitForEnvelopes(telemetryPath, "runtime.settled", 1);
		// The aborted run is resumed: the engine ensures the same run id on the
		// same conversation, which is `resumed` — the run's window is not reopened.
		await ensure();
		const envelopes = await waitForEnvelopes(
			telemetryPath,
			"runtime.session_window.opened",
			2,
		);
		// The resume wrote exactly one envelope and produced no turn: the record
		// observes the move and nothing else, so nothing the host emits could have
		// restarted, completed or re-opened the run's own window.
		const sessionOf = (rows: Array<Record<string, unknown>>) =>
			rows.filter((envelope) => SESSION_EVENTS.has(String(envelope.event)));
		expect(sessionOf(envelopes).length - sessionOf(before).length).toBe(1);
		expect(
			envelopes.filter((envelope) => envelope.event === "runtime.turn_started"),
		).toHaveLength(1);
		expect(
			envelopes.filter(
				(envelope) => envelope.event === "runtime.session_window.closed",
			),
		).toEqual([]);
		expect(
			envelopes.filter((envelope) => envelope.event === "runtime.settled"),
		).toHaveLength(1);
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
		const before = await ensureAdmittedFixtureRun(first, {
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
		const adopted = await ensureAdmittedFixtureRun(second, {
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
		expect(sessionEvents[1]?.["herdr.session.conversation_id"]).toBe(
			before.conversationId,
		);
		await second.shutdown();
	});

	test("a turn measured after a rebinding is judged by the run the message belongs to", async () => {
		// Efficiency backlog items 6 and 20 meet here: the cost ceiling is decided
		// from a measurement delivered on a conversation *another* run created. The
		// measurement must be charged to the run that produced the message, so it is
		// judged and reported — charging it to the creating run (which the engine has
		// already retired, and whose record is gone) silently drops the ceiling for
		// every run that reuses a conversation, which is every later run of a step.
		const dir = tempWorkflowDir();
		const telemetryPath = path.join(dir, "telemetry.jsonl");
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const model = `${faux.getModel().provider}/${faux.getModel().id}`;
		const host = await DurableHost.open({
			layout: hostLayout(dir),
			settings: {},
			globalAgentDir: dir,
			storage: new MemoryStorage(),
			models,
			compaction: () => ({ ceilingTokens: 30_000 }),
		});
		const envFor = (runId: string) =>
			writeRunEnv(dir, runId, {
				HERDR_WORKFLOW_ID: "wf-ceiling-window",
				HERDR_RUN_ID: runId,
				HERDR_TELEMETRY_PATH: telemetryPath,
			});
		try {
			const first = await ensureAdmittedFixtureRun(host, {
				runId: "run-creator",
				name: "worker-ceiling-window",
				cwd: dir,
				runEnvPath: envFor("run-creator"),
				toolPolicy: "default",
				model,
			});
			expect(host.ceilingForTest("run-creator")).toMatchObject({
				ceilingTokens: 30_000,
				active: true,
			});
			// The creator is retired before it ever committed a turn.
			await host.stopRun("run-creator");
			const second = await ensureAdmittedFixtureRun(host, {
				runId: "run-successor",
				name: "worker-ceiling-window",
				cwd: dir,
				runEnvPath: envFor("run-successor"),
				toolPolicy: "default",
				model,
			});
			expect(second.conversationId).toBe(first.conversationId);
			// Two responses: the turn's answer, then the summarizer's.
			faux.setResponses([
				fauxAssistantMessage([fauxText("acknowledged")]),
				fauxAssistantMessage([fauxText("summary of the older context")]),
			]);
			// Roughly 80,000 tokens of prose at pi-ai's four-characters estimate:
			// far above the 30,000 ceiling, far below the 700,000 overflow guard.
			const context = "context worth summarizing. ".repeat(12_800);
			await host.submit("run-successor", context, "req-ceiling-window");
			const envelopes = await waitForEnvelopes(
				telemetryPath,
				"runtime.compaction_ceiling",
				1,
			);
			const ceiling = envelopes.find(
				(envelope) =>
					envelope.event === "runtime.compaction_ceiling" &&
					envelope.status === "compact",
			);
			// The successor's measurement was judged, and the envelope names the run
			// that owns it — not the retired conversation creator.
			expect(ceiling).toMatchObject({
				runId: "run-successor",
				ceilingTokens: 30_000,
			});
			expect(ceiling?.contextTokens as number).toBeGreaterThanOrEqual(30_000);
		} finally {
			await host.shutdown();
		}
	});

	test("a conversation with no run id records nothing", async () => {
		const dir = tempWorkflowDir();
		const { host, faux, telemetryPath, model } = await openHost(dir);
		await ensureAdmittedFixtureRun(host, {
			runId: "run-orchestrator",
			name: "orchestrator",
			cwd: dir,
			// An orchestrator session carries no run id: the analysis is about runs,
			// so the session window says nothing about it.
			runEnvPath: writeRunEnv(dir, "run-orchestrator", {
				// Home is not a managed workflow and carries no workflow/run identity.
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

	test("a close that could not be written is retried on the next binding", async () => {
		// A `closed` record is what a reader treats as proof of a continuation, so a
		// close nobody wrote is a tail nobody can explain and a failed build. The
		// leaving run's own telemetry path is what failed, so the retry writes into the
		// binding that now holds the conversation — one durable statement, once.
		const dir = tempWorkflowDir();
		const { host, faux, telemetryPath, model } = await openHost(dir);
		const envFor = (runId: string, telemetry: string) =>
			writeRunEnv(dir, runId, {
				HERDR_WORKFLOW_ID: "wf-window-retry",
				HERDR_RUN_ID: runId,
				HERDR_TELEMETRY_PATH: telemetry,
			});
		// A *file* where the run's telemetry directory would be: the append cannot
		// happen, exactly as it cannot for a removed workspace.
		const blocked = path.join(dir, "blocked");
		fs.writeFileSync(blocked, "not a directory\n");
		const blockedPath = path.join(blocked, "telemetry.jsonl");
		const ensure = (runId: string, telemetry: string) =>
			ensureAdmittedFixtureRun(host, {
				runId,
				name: "worker-window-retry",
				cwd: dir,
				runEnvPath: envFor(runId, telemetry),
				toolPolicy: "default",
				model,
			});
		await ensure("run-a", blockedPath);
		await oneTurn(host, faux, "run-a");
		await ensure("run-b", telemetryPath);
		const afterRebinding = await waitForEnvelopes(
			telemetryPath,
			"runtime.session_window.opened",
			1,
		);
		const session = afterRebinding.filter((envelope) =>
			SESSION_EVENTS.has(String(envelope.event)),
		);
		// The retried close comes before the record that explains the continuation,
		// and it names the run that was left.
		expect(session.map((envelope) => envelope.event)).toEqual([
			"runtime.session_window.closed",
			"runtime.session_window.opened",
		]);
		expect(session[0]).toMatchObject({
			runId: "run-a",
			"herdr.session.rebound_to": "run-b",
		});
		// A third binding does not write the same close twice: the pending entry is
		// dropped once it landed.
		await host.stopRun("run-b");
		await ensure("run-c", telemetryPath);
		const all = await waitForEnvelopes(
			telemetryPath,
			"runtime.session_window.opened",
			2,
		);
		expect(
			all.filter(
				(envelope) =>
					envelope.event === "runtime.session_window.closed" &&
					envelope.runId === "run-a",
			),
		).toHaveLength(1);
		await host.shutdown();
	});

	test("two rebindings of one conversation never interleave", async () => {
		// The transition (read the previous binding, drain, write the new one) is one
		// step per conversation: without that, two overlapping rebindings close the
		// same run twice — once naming a successor that never held the conversation —
		// and leave the run that did hold it unclosed.
		const dir = tempWorkflowDir();
		const { host, telemetryPath, model } = await openHost(dir);
		const ensure = (runId: string) =>
			ensureAdmittedFixtureRun(host, {
				runId,
				name: "worker-window-chain",
				cwd: dir,
				runEnvPath: writeRunEnv(dir, runId, {
					HERDR_WORKFLOW_ID: "wf-window-chain",
					HERDR_RUN_ID: runId,
					HERDR_TELEMETRY_PATH: telemetryPath,
				}),
				toolPolicy: "default",
				model,
			});
		const first = await ensure("run-a");
		// Two runs of the same step and role are launched onto the same conversation
		// before the first has finished ensuring — a retried launch, or two clients of
		// one step — and neither is awaited until both are in flight.
		const [second, third] = await Promise.all([
			ensure("run-b"),
			ensure("run-c"),
		]);
		expect(second.conversationId).toBe(first.conversationId);
		expect(third.conversationId).toBe(first.conversationId);
		const session = readEnvelopes(telemetryPath).filter((envelope) =>
			SESSION_EVENTS.has(String(envelope.event)),
		);
		// One close per run that was left, each naming the run that followed it, and
		// one opening per run: no run is closed twice and none is left open.
		const closes = session.filter(
			(envelope) => envelope.event === "runtime.session_window.closed",
		);
		expect(closes.map((envelope) => envelope.runId)).toEqual([
			"run-a",
			"run-b",
		]);
		expect(
			closes.map((envelope) => envelope["herdr.session.rebound_to"]),
		).toEqual(["run-b", "run-c"]);
		expect(
			session
				.filter(
					(envelope) => envelope.event === "runtime.session_window.opened",
				)
				.map((envelope) => envelope.runId),
		).toEqual(["run-a", "run-b", "run-c"]);
		await host.shutdown();
	});
});
