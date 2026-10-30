// The cost ceiling in a durable host (efficiency backlog item 6).
//
// Runs the real `pi-durable` host against a scripted faux provider, like
// `agent-host-compaction.test.ts`: what only the live harness can show is that
// the ceiling is decided from the measured context of a committed turn, that the
// compaction it admits is placed at a turn boundary without disturbing the
// summarizer's own context, and that the telemetry says which kind of compaction
// ran per run.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	createModels,
	type FauxProviderState,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
} from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { DurableHost } from "../src/agent-host/host.ts";
import { hostLayout } from "../src/agent-host/layout.ts";
import {
	COMPACTION_CEILING_MINIMUM,
	type CompactionConfig,
} from "../src/workflow/compaction.ts";
import {
	ensureFixtureRun,
	submitFixtureRun,
} from "./support/admitted-host-fixture.ts";

// Keep the test ceiling above the initial prompt/tool declarations (which grow
// with upstream tool descriptions), so only the scripted context triggers it.
const MODELS = [
	{ id: "wide", contextWindow: 1_000_000 },
	{ id: "narrow", contextWindow: 100_000 },
];

/** Roughly `tokens` tokens of prose at pi-ai's four-characters-per-token
 * estimate. */
function contextText(tokens: number): string {
	return "context worth summarizing. ".repeat(Math.ceil((tokens * 4) / 25));
}

function tempWorkflowDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "agent-host-ceiling-"));
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

function modelRef(faux: ReturnType<typeof fauxProvider>, id: string): string {
	const model = faux.getModel(id);
	if (!model) throw new Error(`no faux model: ${id}`);
	return `${model.provider}/${model.id}`;
}

async function openHost(options: {
	dir: string;
	models: ReturnType<typeof createModels>;
	compaction?: () => CompactionConfig;
	orchestrator?: boolean;
}) {
	return await DurableHost.open({
		layout: hostLayout(options.dir),
		settings: {},
		globalAgentDir: options.dir,
		storage: new MemoryStorage(),
		models: options.models,
		...(options.compaction ? { compaction: options.compaction } : {}),
		...(options.orchestrator ? { orchestrator: true } : {}),
	});
}

async function waitFor(
	predicate: () => boolean | Promise<boolean>,
	attempts = 200,
) {
	for (let i = 0; i < attempts; i++) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("waitFor timed out");
}

async function waitForIdle(host: DurableHost, runId: string): Promise<void> {
	await waitFor(async () => (await host.status(runId)).status === "idle", 400);
}

function readLines(telemetryPath: string): Array<Record<string, unknown>> {
	return fs.existsSync(telemetryPath)
		? fs
				.readFileSync(telemetryPath, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Record<string, unknown>)
		: [];
}

async function compactionEntries(host: DurableHost, runId: string) {
	return (await host.entriesForTest(runId)).filter(
		(entry) => (entry as { kind?: string }).kind === "pi.compaction",
	);
}

/** Every transcript the faux provider was asked to answer, flattened to text,
 * so a test can prove what the summarizer itself was given. */
function recordingFaux() {
	const transcripts: string[][] = [];
	const faux = fauxProvider({ models: MODELS });
	const record = (
		context: { messages: unknown[] },
		text: string,
	): ReturnType<typeof fauxAssistantMessage> => {
		transcripts.push(
			context.messages.map((message) => JSON.stringify(message) ?? ""),
		);
		return fauxAssistantMessage([fauxText(text)]);
	};
	return {
		faux,
		transcripts,
		record,
		/** A response factory for `setResponses`: what it answers per call. */
		factory:
			(text: string) =>
			(
				context: { messages: unknown[] },
				_options: unknown,
				_state: FauxProviderState,
			) =>
				record(context, text),
	};
}

describe("cost ceiling of a durable host", () => {
	test("a growing context compacts at the ceiling, at a turn boundary, and the envelopes say auto-ceiling", async () => {
		const dir = tempWorkflowDir();
		const { faux, factory, transcripts } = recordingFaux();
		const models = createModels();
		models.setProvider(faux.provider);
		const host = await openHost({
			dir,
			models,
			compaction: () => ({ ceilingTokens: 60_000 }),
		});
		try {
			const telemetryPath = path.join(dir, "telemetry.jsonl");
			const envPath = writeRunEnv(dir, {
				HERDR_WORKFLOW_ID: "wf-ceiling",
				HERDR_RUN_ID: "run-ceiling",
				HERDR_ROLE: "worker",
				HERDR_TELEMETRY_PATH: telemetryPath,
			});
			await ensureFixtureRun(host, {
				runId: "run-ceiling",
				name: "worker-ceiling",
				cwd: dir,
				runEnvPath: envPath,
				toolPolicy: "default",
				model: modelRef(faux, "wide"),
			});
			// A 1M window puts the overflow guard at 700,000 tokens, so the 60,000
			// ceiling is far below it and is the trigger that actually fires.
			expect(host.ceilingForTest("run-ceiling")).toMatchObject({
				ceilingTokens: 60_000,
				active: true,
				overflowTokens: 700_000,
			});

			// The assignment: the head the summarizer has to keep.
			faux.setResponses([factory("acknowledged")]);
			await submitFixtureRun(
				host,
				"run-ceiling",
				"ASSIGNMENT: implement the cost ceiling. Plan: step 1, step 2.",
				"req-0",
			);
			await waitForIdle(host, "run-ceiling");
			// The turn that crosses the ceiling, plus the summarizer's own answer.
			faux.appendResponses([
				factory("acknowledged"),
				factory("summary of the older context"),
			]);
			await submitFixtureRun(host, "run-ceiling", contextText(80_000), "req-1");
			await waitFor(
				async () => (await compactionEntries(host, "run-ceiling")).length > 0,
			);

			// The ceiling path keeps the same summarizer context the overflow path
			// does: the assignment is the head the summarizer reads and keeps.
			const summarizer = transcripts.at(-1)?.join("\n") ?? "";
			expect(summarizer).toContain("ASSIGNMENT: implement the cost ceiling");
			expect(summarizer).toContain("Plan: step 1, step 2");

			// No summary text ever reaches an envelope.
			expect(JSON.stringify(readLines(telemetryPath))).not.toContain(
				"summary of the older context",
			);

			// The per-run completion envelope carries the peak context and the count,
			// which is what makes "automatic compactions > 0, peak context < 200k"
			// checkable after the fact. A generation after the placed summary measures
			// the reduced context and flushes the compaction envelope with it.
			faux.appendResponses([factory("after")]);
			await submitFixtureRun(host, "run-ceiling", "and now?", "req-2");
			await waitFor(
				async () => (await compactionEntries(host, "run-ceiling")).length > 0,
			);
			await waitForIdle(host, "run-ceiling");
			await waitFor(async () =>
				readLines(telemetryPath).some(
					(line) => line.event === "runtime.compaction",
				),
			);
			const lines = readLines(telemetryPath);
			expect(
				lines.find((line) => line.event === "runtime.compaction_start"),
			).toMatchObject({ kind: "auto-ceiling", reason: "manual" });
			expect(
				lines.find((line) => line.event === "runtime.compaction"),
			).toMatchObject({ kind: "auto-ceiling", outcome: "completed" });
			expect(
				lines.find((line) => line.event === "runtime.compaction_ceiling"),
			).toMatchObject({ status: "compact", ceilingTokens: 60_000 });
			const settled = lines.filter((line) => line.event === "runtime.settled");
			expect(settled.at(-1)).toMatchObject({ compactionsAutoCeiling: 1 });
			expect(
				settled.at(-1)?.peakContextTokens as number,
			).toBeGreaterThanOrEqual(60_000);
			expect(host.ceilingStateForTest("run-ceiling")?.compactionTurns).toEqual([
				1,
			]);
		} finally {
			await host.shutdown();
		}
	});

	test("the floor holds a second compaction back after a compaction just ran", async () => {
		const dir = tempWorkflowDir();
		const { faux, factory } = recordingFaux();
		const models = createModels();
		models.setProvider(faux.provider);
		const host = await openHost({
			dir,
			models,
			compaction: () => ({ ceilingTokens: 60_000, keepRecentTokens: 4096 }),
		});
		try {
			const envPath = writeRunEnv(dir, { HERDR_RUN_ID: "run-floor" });
			await ensureFixtureRun(host, {
				runId: "run-floor",
				name: "worker-floor",
				cwd: dir,
				runEnvPath: envPath,
				toolPolicy: "default",
				model: modelRef(faux, "wide"),
			});
			faux.setResponses([factory("acknowledged")]);
			await submitFixtureRun(host, "run-floor", "start", "req-0");
			await waitForIdle(host, "run-floor");

			faux.appendResponses([
				factory("acknowledged"),
				factory("summary of the older context"),
			]);
			await submitFixtureRun(host, "run-floor", contextText(80_000), "req-1");
			await waitFor(
				async () => (await compactionEntries(host, "run-floor")).length === 1,
			);
			await waitForIdle(host, "run-floor");
			expect(host.ceilingStateForTest("run-floor")?.compactionTurns).toEqual([
				1,
			]);

			// The next turn grows the context past the ceiling again, but by less than
			// the 40,000-token floor and within one turn: both floors hold, so nothing
			// is admitted.
			faux.appendResponses([factory("acknowledged")]);
			await submitFixtureRun(host, "run-floor", contextText(20_000), "req-2");
			await waitForIdle(host, "run-floor");
			expect(await compactionEntries(host, "run-floor")).toHaveLength(1);
			expect(host.ceilingStateForTest("run-floor")?.compactionTurns).toEqual([
				1,
			]);
		} finally {
			await host.shutdown();
		}
	});

	test("three compactions inside ten turns stop the ceiling and report the guard", async () => {
		const dir = tempWorkflowDir();
		const { faux, factory } = recordingFaux();
		const models = createModels();
		models.setProvider(faux.provider);
		// The smallest accepted ceiling and kept tail: each huge turn crosses it by
		// far more than the token floor, so every turn would compact without the
		// guard.
		const host = await openHost({
			dir,
			models,
			compaction: () => ({
				ceilingTokens: COMPACTION_CEILING_MINIMUM,
				keepRecentTokens: 4096,
			}),
		});
		try {
			const telemetryPath = path.join(dir, "telemetry.jsonl");
			const envPath = writeRunEnv(dir, {
				HERDR_RUN_ID: "run-guard",
				HERDR_ROLE: "worker",
				HERDR_TELEMETRY_PATH: telemetryPath,
			});
			await ensureFixtureRun(host, {
				runId: "run-guard",
				name: "worker-guard",
				cwd: dir,
				runEnvPath: envPath,
				toolPolicy: "default",
				model: modelRef(faux, "wide"),
			});
			faux.setResponses([factory("acknowledged")]);
			await submitFixtureRun(host, "run-guard", "start", "req-0");
			await waitForIdle(host, "run-guard");

			for (let turn = 1; turn <= 6; turn++) {
				faux.appendResponses([
					factory("acknowledged"),
					factory("summary of the older context"),
				]);
				await submitFixtureRun(
					host,
					"run-guard",
					contextText(60_000),
					`req-${turn}`,
				);
				// Wait for this turn's measurement to be decided: the recorded turn
				// index only advances when the ceiling evaluated that turn.
				await waitFor(() => {
					const record = host.ceilingStateForTest("run-guard");
					return (record?.turnIndex ?? -1) >= turn;
				});
				await waitForIdle(host, "run-guard");
			}

			const state = host.ceilingStateForTest("run-guard");
			expect(state?.suspended).toBe(true);
			expect(state?.compactionTurns).toHaveLength(3);
			const lines = readLines(telemetryPath);
			expect(
				lines.find(
					(line) =>
						line.event === "runtime.compaction_ceiling" &&
						line.status === "suspended",
				),
			).toMatchObject({
				reason: "loop-guard",
				compactionsInWindow: 3,
				windowTurns: 10,
			});
		} finally {
			await host.shutdown();
		}
	}, 60_000);

	test("a ceiling of 0 leaves a long context alone", async () => {
		const dir = tempWorkflowDir();
		const { faux, factory } = recordingFaux();
		const models = createModels();
		models.setProvider(faux.provider);
		const host = await openHost({
			dir,
			models,
			compaction: () => ({ ceilingTokens: 0 }),
		});
		try {
			const telemetryPath = path.join(dir, "telemetry.jsonl");
			const envPath = writeRunEnv(dir, {
				HERDR_RUN_ID: "run-off",
				HERDR_ROLE: "worker",
				HERDR_TELEMETRY_PATH: telemetryPath,
			});
			await ensureFixtureRun(host, {
				runId: "run-off",
				name: "worker-off",
				cwd: dir,
				runEnvPath: envPath,
				toolPolicy: "default",
				model: modelRef(faux, "wide"),
			});
			expect(host.ceilingForTest("run-off")).toMatchObject({
				active: false,
				inactive: "off",
			});
			faux.setResponses([factory("acknowledged")]);
			await submitFixtureRun(host, "run-off", contextText(80_000), "req-0");
			await waitForIdle(host, "run-off");
			expect(await compactionEntries(host, "run-off")).toHaveLength(0);
			expect(
				readLines(telemetryPath).some(
					(line) => line.event === "runtime.compaction_ceiling",
				),
			).toBe(false);
		} finally {
			await host.shutdown();
		}
	});

	test("on a small window the ceiling is ignored once, with a warning naming the overflow threshold", async () => {
		const dir = tempWorkflowDir();
		const { faux, factory } = recordingFaux();
		const models = createModels();
		models.setProvider(faux.provider);
		const host = await openHost({ dir, models, compaction: () => ({}) });
		try {
			const telemetryPath = path.join(dir, "telemetry.jsonl");
			const envPath = writeRunEnv(dir, {
				HERDR_RUN_ID: "run-narrow",
				HERDR_ROLE: "worker",
				HERDR_TELEMETRY_PATH: telemetryPath,
			});
			await ensureFixtureRun(host, {
				runId: "run-narrow",
				name: "worker-narrow",
				cwd: dir,
				runEnvPath: envPath,
				toolPolicy: "default",
				model: modelRef(faux, "narrow"),
			});
			// 100k window, reserve 32000: the overflow guard fires above 68000, so the
			// 150000 default ceiling can never be the tighter trigger.
			expect(host.ceilingForTest("run-narrow")).toMatchObject({
				active: false,
				inactive: "above-overflow",
				overflowTokens: 68_000,
			});
			faux.setResponses([factory("acknowledged")]);
			await submitFixtureRun(host, "run-narrow", "small context", "req-0");
			await waitForIdle(host, "run-narrow");
			// A second turn proves the warning is emitted once, not per turn.
			faux.appendResponses([factory("acknowledged")]);
			await submitFixtureRun(host, "run-narrow", "and again", "req-1");
			await waitForIdle(host, "run-narrow");

			const warnings = readLines(telemetryPath).filter(
				(line) => line.event === "runtime.compaction_ceiling",
			);
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toMatchObject({
				status: "ignored",
				reason: "above-overflow",
				ceilingTokens: 150_000,
				overflowTokens: 68_000,
			});
			expect(await compactionEntries(host, "run-narrow")).toHaveLength(0);
		} finally {
			await host.shutdown();
		}
	});

	// A read-only run is served like any other: compaction rewrites the
	// conversation, never the repository, so a verifier's ceiling is the same
	// mechanism and its summarizer keeps the same head context.
	test("a read-only verifier run compacts at the ceiling and keeps its finding references", async () => {
		const dir = tempWorkflowDir();
		const { faux, factory, transcripts } = recordingFaux();
		const models = createModels();
		models.setProvider(faux.provider);
		const host = await openHost({
			dir,
			models,
			compaction: () => ({ ceilingTokens: 60_000 }),
		});
		try {
			const telemetryPath = path.join(dir, "telemetry.jsonl");
			const envPath = writeRunEnv(dir, {
				HERDR_RUN_ID: "run-verifier",
				HERDR_ROLE: "test-verifier",
				HERDR_TELEMETRY_PATH: telemetryPath,
			});
			await ensureFixtureRun(host, {
				runId: "run-verifier",
				name: "verifier-ceiling",
				cwd: dir,
				runEnvPath: envPath,
				toolPolicy: "read-only",
				model: modelRef(faux, "wide"),
			});
			faux.setResponses([factory("acknowledged")]);
			await submitFixtureRun(
				host,
				"run-verifier",
				"ASSIGNMENT: verify the cost ceiling. Findings so far: F-1 src/a.ts, F-2 src/b.ts.",
				"req-0",
			);
			await waitForIdle(host, "run-verifier");
			faux.appendResponses([
				factory("acknowledged"),
				factory("summary of the older context"),
			]);
			await submitFixtureRun(
				host,
				"run-verifier",
				contextText(80_000),
				"req-1",
			);
			await waitFor(
				async () => (await compactionEntries(host, "run-verifier")).length > 0,
			);
			const summarizer = transcripts.at(-1)?.join("\n") ?? "";
			expect(summarizer).toContain(
				"Findings so far: F-1 src/a.ts, F-2 src/b.ts",
			);
			expect(
				readLines(telemetryPath).find(
					(line) => line.event === "runtime.compaction_start",
				),
			).toMatchObject({ kind: "auto-ceiling", role: "test-verifier" });
		} finally {
			await host.shutdown();
		}
	});

	test("the orchestrator conversation compacts at the ceiling like every other role", async () => {
		const dir = tempWorkflowDir();
		const { faux, factory } = recordingFaux();
		const models = createModels();
		models.setProvider(faux.provider);
		const host = await openHost({
			dir,
			models,
			compaction: () => ({ ceilingTokens: 60_000 }),
			orchestrator: true,
		});
		try {
			const telemetryPath = path.join(dir, "telemetry.jsonl");
			const envPath = writeRunEnv(dir, {
				HERDR_RUN_ID: "run-orchestrator",
				HERDR_ROLE: "orchestrator",
				HERDR_TELEMETRY_PATH: telemetryPath,
			});
			await ensureFixtureRun(host, {
				runId: "run-orchestrator",
				name: "orchestrator",
				cwd: dir,
				runEnvPath: envPath,
				toolPolicy: "orchestrator",
				model: modelRef(faux, "wide"),
			});
			faux.setResponses([factory("acknowledged")]);
			await submitFixtureRun(
				host,
				"run-orchestrator",
				"dispatch the workflow",
				"req-0",
			);
			await waitForIdle(host, "run-orchestrator");

			faux.appendResponses([
				factory("acknowledged"),
				factory("summary of the older context"),
			]);
			await submitFixtureRun(
				host,
				"run-orchestrator",
				contextText(80_000),
				"req-1",
			);
			await waitFor(
				async () =>
					(await compactionEntries(host, "run-orchestrator")).length > 0,
			);
			const lines = readLines(telemetryPath);
			expect(
				lines.find((line) => line.event === "runtime.compaction_start"),
			).toMatchObject({
				kind: "auto-ceiling",
				role: "orchestrator",
				runId: "run-orchestrator",
			});
			expect(
				lines.find((line) => line.event === "runtime.compaction_ceiling"),
			).toMatchObject({ status: "compact", role: "orchestrator" });
		} finally {
			await host.shutdown();
		}
	});
});
