// The run-progress checkpoint inside the durable host (efficiency backlog item
// 19): what one run's supervisor exports, what it applies, and — the whole point
// of the feature — that nothing it decides stops a run unless a developer
// question exists and is still unanswered or was cancelled.
//
// The host half runs the real durable wiring (`DurableHost` + in-memory storage +
// a scripted faux provider), with `agentic-coding` replaced by a shim that logs
// every invocation and answers the three run commands this feature uses, so
// nothing here can reach a real workflow store.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
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
import type { CheckpointThresholds } from "../src/agent-host/progress-checkpoint.ts";
import type { ResolvedCheckpointConfig } from "../src/workflow/checkpoint.ts";

// Every test drives a real durable host over a scripted provider and waits for a
// turn boundary; the waits are bounded by the module's own interval, not by the
// suite's five-second default.
setDefaultTimeout(30_000);

function tempWorkflowDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "agent-host-checkpoint-"));
}

function writeRunEnv(dir: string, vars: Record<string, string>): string {
	const file = path.join(dir, "run.env");
	fs.writeFileSync(
		file,
		Object.entries(vars)
			.map(([key, value]) => `${key}='${value}'`)
			.join("\n"),
	);
	return file;
}

/** A shim `agentic-coding` on PATH that logs every invocation and answers the
 * commands this feature runs: `workflow checkpoint --record` and
 * `workflow question` print the JSON line the host parses, and every other
 * command exits 0 the way the fail-fast shim does. A command named in `fail` is
 * made to fail, which is how a test drives one fail-open path. */
function installShim(options: {
	question?: Record<string, unknown>;
	fail?: "checkpoint" | "question" | "handoff";
}): { log: string; restore: () => void } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-coding-shim-"));
	const log = path.join(dir, "calls.log");
	const record = JSON.stringify({ recorded: true, records: 1 });
	const questionPayload = JSON.stringify(
		options.question ?? { id: "q-checkpoint-1", status: "answered" },
	);
	const lines = [
		"#!/bin/sh",
		`printf '%s\\n' "$*" >> "${log}"`,
		'case "$2" in',
		`  checkpoint) ${options.fail === "checkpoint" ? "exit 1" : `printf '%s\\n' '${record}'`} ;;`,
		`  question) ${options.fail === "question" ? "exit 1" : `printf '%s\\n' '${questionPayload}'`} ;;`,
		`  handoff) ${options.fail === "handoff" ? "exit 1" : "exit 0"} ;;`,
		"esac",
		"exit 0",
	];
	fs.writeFileSync(path.join(dir, "agentic-coding"), lines.join("\n"), {
		mode: 0o700,
	});
	const previous = process.env.PATH;
	process.env.PATH = `${dir}${path.delimiter}${previous ?? ""}`;
	return {
		log,
		restore: () => {
			if (previous === undefined) delete process.env.PATH;
			else process.env.PATH = previous;
		},
	};
}

let restore: (() => void) | undefined;
afterEach(() => {
	restore?.();
	restore = undefined;
});

function shimCalls(log: string): string {
	try {
		return fs.readFileSync(log, "utf8");
	} catch {
		return "";
	}
}

async function until(check: () => boolean, attempts = 250): Promise<boolean> {
	for (let index = 0; index < attempts; index++) {
		if (check()) return true;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return check();
}

function telemetryLines(telemetryPath: string): Array<Record<string, unknown>> {
	try {
		return fs
			.readFileSync(telemetryPath, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
	} catch {
		return [];
	}
}

/** How many finished tool calls the run recorded. */
function toolCallCount(telemetryPath: string): number {
	return telemetryLines(telemetryPath).filter(
		(line) => line.event === "runtime.tool",
	).length;
}

function checkpointLines(
	telemetryPath: string,
	event = "runtime.checkpoint",
): Array<Record<string, unknown>> {
	return telemetryLines(telemetryPath).filter((line) => line.event === event);
}

/** The first checkpoint fires on the turn whose measured context arrives, which
 * is one turn before that turn's own tool call is recorded: a repeat stall needs
 * the soft threshold one turn past the repeat window's minimum. */
const WORKER_SOFT: CheckpointThresholds = { softTurns: 10, hardTurns: 40 };
const WORKER_REPEAT: CheckpointThresholds = { softTurns: 11, hardTurns: 44 };
const WORKER_HARD_SOON: CheckpointThresholds = { softTurns: 3, hardTurns: 6 };

/** One run of the real durable host, driven by a scripted faux provider that
 * reads one file per turn. Distinct paths are progress-free but never repeats;
 * one repeated path is the repeat-stall the decider steers. */
async function runCheckpointRun(options: {
	shimLog: string;
	thresholds: CheckpointThresholds;
	steer?: boolean;
	enabled?: boolean;
	calls: number;
	/** Read the same path every turn instead of a fresh one. */
	repeat?: boolean;
	/** Write a fresh file every turn, which is progress the checkpoint can see. */
	mutating?: boolean;
	/** Throw from the injected sample, as a `git` timeout would. */
	sampleThrows?: boolean;
	role?: string;
	checkpointClass?: string;
	/** Leave `HERDR_RUN_ID` out of the environment, as an orchestrator session has
	 * no run id to be supervised under. */
	noRunId?: boolean;
}): Promise<{ telemetryPath: string; calls: string }> {
	const dir = tempWorkflowDir();
	fs.writeFileSync(path.join(dir, "work.txt"), "one\ntwo\n");
	// Every scripted read resolves, so the only supervisor that can stop this run is
	// the checkpoint: a missing file would trip the dead-tool-surface guard first.
	for (let index = 0; index < options.calls; index++)
		fs.writeFileSync(path.join(dir, `note-${index}.txt`), `${index}\n`);
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const config: ResolvedCheckpointConfig = {
		enabled: options.enabled ?? true,
		steer: options.steer ?? true,
		contextTokens: 200_000,
		thresholds: { worker: options.thresholds },
	};
	const host = await DurableHost.open({
		layout: hostLayout(dir),
		settings: {},
		globalAgentDir: dir,
		storage: new MemoryStorage(),
		models,
		checkpoint: () => config,
		checkpointSample: async () => {
			if (options.sampleThrows)
				throw new Error("git diff timed out after 2000 ms");
			return {};
		},
	});
	const telemetryPath = path.join(dir, "telemetry.jsonl");
	const runEnvPath = writeRunEnv(dir, {
		HERDR_WORKFLOW_ID: "wf-checkpoint",
		...(options.noRunId ? {} : { HERDR_RUN_ID: "run-checkpoint" }),
		HERDR_STEP_ID: "core.implementation",
		HERDR_ROLE: options.role ?? "worker",
		HERDR_PROFILE: "durable-default",
		HERDR_RUN_TOKEN: "token",
		HERDR_TELEMETRY_PATH: telemetryPath,
		HERDR_CHECKPOINT_CLASS: options.checkpointClass ?? "worker",
	});
	await host.ensureRun({
		runId: "run-checkpoint",
		name: "worker-checkpoint",
		cwd: dir,
		runEnvPath,
		toolPolicy: "default",
		model: `${faux.getModel().provider}/${faux.getModel().id}`,
	});
	faux.setResponses([
		...Array.from({ length: options.calls }, (_, index) =>
			fauxAssistantMessage(
				[
					options.mutating
						? fauxToolCall("write", {
								path: `out-${index}.txt`,
								content: `line ${index}\n`,
							})
						: fauxToolCall("read", {
								path: options.repeat ? "work.txt" : `note-${index}.txt`,
							}),
				],
				{ stopReason: "toolUse" },
			),
		),
		// The steer and the escalation answer each re-issue a turn; leave room.
		...Array.from({ length: 5 }, () =>
			fauxAssistantMessage([fauxText("noted")]),
		),
	]);
	await host.submit("run-checkpoint", "work", "req-checkpoint");
	// The first checkpoint is the thing to wait for: it is evaluated once a turn
	// has been measured, and everything else follows on the same chain. A feature
	// that is switched off never writes one, so that run waits on its turns.
	await until(
		() =>
			checkpointLines(telemetryPath).length > 0 ||
			shimCalls(options.shimLog).includes("workflow handoff") ||
			toolCallCount(telemetryPath) >= options.calls,
	);
	// A run that keeps going takes every scripted turn; a parked one stops, so its
	// handoff is what ends this wait instead.
	await until(
		() =>
			toolCallCount(telemetryPath) >= options.calls ||
			shimCalls(options.shimLog).includes("workflow handoff"),
		100,
	);
	// A decision that files a question settles after the question and, when it
	// parks, after the handoff: wait until neither is still coming.
	await until(() => {
		const calls = shimCalls(options.shimLog);
		if (!calls.includes("workflow question")) return true;
		const escalation = checkpointLines(
			telemetryPath,
			"runtime.checkpoint_escalation",
		);
		if (escalation.length === 0) return false;
		const outcome = escalation.at(-1)?.["herdr.checkpoint.outcome"];
		if (outcome !== "pending-parked") return true;
		return calls.includes("workflow handoff");
	});
	const calls = shimCalls(options.shimLog);
	await host.shutdown();
	return { telemetryPath, calls };
}

describe("a run-progress checkpoint in the durable host", () => {
	test("evaluates at its soft threshold, records the decision, and keeps running", async () => {
		const shim = installShim({});
		restore = shim.restore;
		const run = await runCheckpointRun({
			shimLog: shim.log,
			thresholds: WORKER_SOFT,
			calls: 12,
		});
		const lines = checkpointLines(run.telemetryPath);
		expect(lines.length).toBeGreaterThan(0);
		const first = lines[0] ?? {};
		expect(first["herdr.checkpoint.ordinal"]).toBe(1);
		expect(first["herdr.checkpoint.trigger"]).toBe("soft");
		expect(first["herdr.checkpoint.class"]).toBe("worker");
		expect(first["herdr.checkpoint.read_only"]).toBe(false);
		expect(first["herdr.checkpoint.soft_turns"]).toBe(10);
		expect(first["herdr.checkpoint.hard_turns"]).toBe(40);
		expect(first["herdr.checkpoint.decision"]).toBe("continue");
		expect(first["herdr.checkpoint.rule"]).toBe("default");
		expect(first["herdr.checkpoint.applied"]).toBe(true);
		expect(first["herdr.checkpoint.decider"]).toBe("rules/v1");
		expect(first["herdr.checkpoint.recorded"]).toBe(true);
		expect(first["herdr.checkpoint.status"]).toBe("ok");
		expect(first["herdr.checkpoint.error_class"]).toBeUndefined();
		// The record went through the run command, and nothing stopped the run.
		expect(run.calls).toContain("workflow checkpoint --record");
		expect(run.calls).not.toContain("workflow handoff");
		expect(run.calls).not.toContain("workflow question");
		// The envelope carries no conversation text.
		expect(JSON.stringify(lines)).not.toContain("note-0.txt");
	});

	test("steers a repeat stall with one catalog message and records it", async () => {
		const shim = installShim({});
		restore = shim.restore;
		const run = await runCheckpointRun({
			shimLog: shim.log,
			thresholds: WORKER_REPEAT,
			calls: 12,
			repeat: true,
		});
		const first = checkpointLines(run.telemetryPath)[0] ?? {};
		expect(first["herdr.checkpoint.decision"]).toBe("steer");
		expect(first["herdr.checkpoint.rule"]).toBe("repeats");
		expect(first["herdr.checkpoint.applied"]).toBe(true);
		expect(first["herdr.checkpoint.signals"]).toContain("repeats");
		expect(first["herdr.checkpoint.status"]).toBe("ok");
		expect(run.calls).toContain("workflow checkpoint --record");
		expect(run.calls).not.toContain("workflow handoff");
	});

	test("with steering off a signal decides continue and never escalates", async () => {
		const shim = installShim({});
		restore = shim.restore;
		const run = await runCheckpointRun({
			shimLog: shim.log,
			thresholds: WORKER_REPEAT,
			calls: 12,
			repeat: true,
			steer: false,
		});
		const first = checkpointLines(run.telemetryPath)[0] ?? {};
		expect(first["herdr.checkpoint.decision"]).toBe("continue");
		expect(first["herdr.checkpoint.rule"]).toBe("steer-disabled");
		expect(run.calls).not.toContain("workflow question");
		expect(run.calls).not.toContain("workflow handoff");
	});

	test("a run far above its soft threshold keeps running on plain continues", async () => {
		const shim = installShim({});
		restore = shim.restore;
		// The soft threshold is 3 and the run takes 20 turns of real file changes:
		// a turn count alone stops nothing, so every checkpoint continues and no
		// question is ever filed.
		const run = await runCheckpointRun({
			shimLog: shim.log,
			thresholds: { softTurns: 3, hardTurns: 1_000_000 },
			calls: 20,
			mutating: true,
		});
		const lines = checkpointLines(run.telemetryPath);
		expect(lines.length).toBeGreaterThan(1);
		for (const line of lines)
			expect(line["herdr.checkpoint.decision"]).toBe("continue");
		expect(run.calls).not.toContain("workflow question");
		expect(run.calls).not.toContain("workflow handoff");
	});

	test("the hard limit escalates as a developer question and parks the run unanswered", async () => {
		const shim = installShim({
			question: { id: "q-checkpoint-7", status: "pending" },
		});
		restore = shim.restore;
		const run = await runCheckpointRun({
			shimLog: shim.log,
			thresholds: WORKER_HARD_SOON,
			calls: 16,
		});
		// The first checkpoint is the soft one; the hard limit is reached at the next
		// scheduled checkpoint after it, which is where the escalation belongs.
		const hard = checkpointLines(run.telemetryPath).find(
			(line) => line["herdr.checkpoint.trigger"] === "hard",
		);
		expect(hard).toBeDefined();
		expect(hard?.["herdr.checkpoint.decision"]).toBe("escalate");
		expect(hard?.["herdr.checkpoint.rule"]).toBe("hard-limit");
		expect(hard?.["herdr.checkpoint.applied"]).toBe(false);
		expect(hard?.["herdr.checkpoint.recorded"]).toBe(true);

		// The question was filed first, and only then did the run park.
		const escalation = checkpointLines(
			run.telemetryPath,
			"runtime.checkpoint_escalation",
		);
		expect(escalation).toHaveLength(1);
		expect(escalation[0]?.["herdr.checkpoint.outcome"]).toBe("pending-parked");
		expect(escalation[0]?.["herdr.checkpoint.question_id"]).toBe(
			"q-checkpoint-7",
		);
		const questionAt = run.calls.indexOf("workflow question");
		const handoffAt = run.calls.indexOf("workflow handoff --outcome blocked");
		expect(questionAt).toBeGreaterThanOrEqual(0);
		expect(handoffAt).toBeGreaterThan(questionAt);
		expect(run.calls).toContain("q-checkpoint-7");
	});

	test("an answer inside the grace window keeps the run going", async () => {
		const shim = installShim({
			question: {
				id: "q-checkpoint-8",
				status: "answered",
				answer: {
					kind: "custom",
					value: "skip the flaky test, finish the doc",
				},
			},
		});
		restore = shim.restore;
		const run = await runCheckpointRun({
			shimLog: shim.log,
			thresholds: WORKER_HARD_SOON,
			calls: 16,
		});
		const escalation = checkpointLines(
			run.telemetryPath,
			"runtime.checkpoint_escalation",
		);
		expect(escalation[0]?.["herdr.checkpoint.outcome"]).toBe("answered");
		expect(escalation[0]?.["herdr.checkpoint.question_id"]).toBe(
			"q-checkpoint-8",
		);
		// Nothing stopped: no handoff of any kind, and the run kept taking turns.
		expect(run.calls).not.toContain("workflow handoff");
		expect(
			telemetryLines(run.telemetryPath).filter(
				(line) => line.event === "runtime.tool",
			).length,
		).toBeGreaterThan(6);
	});

	test("a cancelled question stops the run and names the question", async () => {
		const shim = installShim({
			question: { id: "q-checkpoint-9", status: "cancelled" },
		});
		restore = shim.restore;
		const run = await runCheckpointRun({
			shimLog: shim.log,
			thresholds: WORKER_HARD_SOON,
			calls: 16,
		});
		const escalation = checkpointLines(
			run.telemetryPath,
			"runtime.checkpoint_escalation",
		);
		expect(escalation[0]?.["herdr.checkpoint.outcome"]).toBe("cancelled");
		expect(run.calls).toContain("workflow handoff --outcome blocked");
		expect(run.calls).toContain("q-checkpoint-9");
	});

	test("a question that cannot be filed leaves the run running", async () => {
		const shim = installShim({ fail: "question" });
		restore = shim.restore;
		const run = await runCheckpointRun({
			shimLog: shim.log,
			thresholds: WORKER_HARD_SOON,
			calls: 16,
		});
		const escalation = checkpointLines(
			run.telemetryPath,
			"runtime.checkpoint_escalation",
		);
		expect(escalation[0]?.["herdr.checkpoint.outcome"]).toBe("filing-failed");
		// The failure is stated as a fail-open checkpoint envelope with a bounded
		// error class, and the run was not stopped.
		expect(
			checkpointLines(run.telemetryPath).some(
				(line) =>
					line["herdr.checkpoint.status"] === "error" &&
					line["herdr.checkpoint.error_class"] === "question",
			),
		).toBe(true);
		expect(run.calls).not.toContain("workflow handoff");
	});

	test("a failed record write fails open and keeps the decision's effect", async () => {
		const shim = installShim({ fail: "checkpoint" });
		restore = shim.restore;
		const run = await runCheckpointRun({
			shimLog: shim.log,
			thresholds: WORKER_SOFT,
			calls: 12,
		});
		const first = checkpointLines(run.telemetryPath)[0] ?? {};
		expect(first["herdr.checkpoint.recorded"]).toBe(false);
		expect(first["herdr.checkpoint.status"]).toBe("error");
		expect(first["herdr.checkpoint.error_class"]).toBe("record");
		// The decision still applied, and the run never stopped.
		expect(first["herdr.checkpoint.applied"]).toBe(true);
		expect(run.calls).not.toContain("workflow handoff");
	});

	test("a failed worktree sample is recorded as a missing measurement", async () => {
		const shim = installShim({});
		restore = shim.restore;
		const run = await runCheckpointRun({
			shimLog: shim.log,
			thresholds: WORKER_SOFT,
			calls: 12,
			sampleThrows: true,
		});
		const first = checkpointLines(run.telemetryPath)[0] ?? {};
		expect(first["herdr.checkpoint.status"]).toBe("error");
		expect(first["herdr.checkpoint.error_class"]).toBe("sample");
		// Unknown is not zero: the numbers say -1 rather than a clean tree.
		expect(first["herdr.checkpoint.diff_files"]).toBe(-1);
		expect(first["herdr.checkpoint.ticked_tasks"]).toBe(-1);
		expect(run.calls).not.toContain("workflow handoff");
	});

	test("a configuration with the feature off evaluates nothing", async () => {
		const shim = installShim({});
		restore = shim.restore;
		const run = await runCheckpointRun({
			shimLog: shim.log,
			thresholds: WORKER_SOFT,
			calls: 12,
			enabled: false,
		});
		expect(checkpointLines(run.telemetryPath)).toEqual([]);
		expect(run.calls).not.toContain("workflow checkpoint");
	});

	test("a session with no run id in its environment is never supervised", async () => {
		const shim = installShim({});
		restore = shim.restore;
		const run = await runCheckpointRun({
			shimLog: shim.log,
			thresholds: WORKER_HARD_SOON,
			calls: 12,
			noRunId: true,
		});
		expect(checkpointLines(run.telemetryPath)).toEqual([]);
		expect(run.calls).not.toContain("workflow checkpoint");
		expect(run.calls).not.toContain("workflow question");
	});

	test("an undeclared class runs on the worker row", async () => {
		const shim = installShim({});
		restore = shim.restore;
		const run = await runCheckpointRun({
			shimLog: shim.log,
			thresholds: WORKER_SOFT,
			calls: 12,
			checkpointClass: "not-a-class",
		});
		const first = checkpointLines(run.telemetryPath)[0] ?? {};
		expect(first["herdr.checkpoint.class"]).toBe("other");
		expect(first["herdr.checkpoint.soft_turns"]).toBe(10);
	});
});
