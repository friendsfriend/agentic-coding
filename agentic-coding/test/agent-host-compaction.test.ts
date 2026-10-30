// Manual compaction and the live compaction policy of a durable host
// (add-agent-compaction, tasks 2.1–2.4 and 3.1).
//
// Runs the experimental `pi-durable` surface for real against a scripted faux
// provider and in-memory storage, exactly like `agent-host-faux-provider.test.ts`:
// the outcome vocabulary, the reference window and the telemetry envelopes can
// only be confirmed against the real harness.
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
import type { CompactionConfig } from "../src/workflow/compaction.ts";
import { COMPACTION_DEFAULTS } from "../src/workflow/compaction.ts";
import {
	ensureFixtureRun,
	submitFixtureRun,
} from "./support/admitted-host-fixture.ts";

const MODELS = [
	{ id: "wide", contextWindow: 1_000_000 },
	{ id: "mid", contextWindow: 200_000 },
	{ id: "narrow", contextWindow: 100_000 },
];

function tempWorkflowDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "agent-host-compaction-"));
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

/** A provider response that stays pending for `delayMs`, so a compaction task is
 * observably in flight while the test looks at it. */
function delayedResponse(delayMs: number) {
	return async () => {
		await new Promise((resolve) => setTimeout(resolve, delayMs));
		return fauxAssistantMessage([fauxText("summary of the older context")]);
	};
}

async function openHost(options: {
	dir: string;
	models: ReturnType<typeof createModels>;
	compaction?: () => CompactionConfig;
}) {
	return await DurableHost.open({
		layout: hostLayout(options.dir),
		settings: {},
		globalAgentDir: options.dir,
		storage: new MemoryStorage(),
		models: options.models,
		...(options.compaction ? { compaction: options.compaction } : {}),
	});
}

async function waitFor(
	predicate: () => Promise<boolean>,
	attempts = 100,
): Promise<void> {
	for (let i = 0; i < attempts; i++) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("waitFor timed out");
}

async function waitForIdle(
	host: DurableHost,
	runId: string,
	attempts = 300,
): Promise<void> {
	for (let i = 0; i < attempts; i++) {
		if ((await host.status(runId)).status === "idle") return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`run ${runId} never became idle`);
}

/** Poll until an envelope with this exact `event` name is on disk. */
async function waitForLines(
	telemetryPath: string,
	name: string,
	attempts = 100,
): Promise<Array<Record<string, unknown>>> {
	const read = () =>
		fs.existsSync(telemetryPath)
			? fs
					.readFileSync(telemetryPath, "utf8")
					.trim()
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line) as Record<string, unknown>)
			: [];
	for (let i = 0; i < attempts; i++) {
		const lines = read();
		if (lines.some((line) => line.event === name)) return lines;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return read();
}

describe("compaction policy of a durable host", () => {
	test("the documented defaults apply with no configuration, and a changed section is read live", async () => {
		const dir = tempWorkflowDir();
		const faux = fauxProvider({ models: MODELS });
		const models = createModels();
		models.setProvider(faux.provider);
		let configured: CompactionConfig = {};
		const host = await openHost({ dir, models, compaction: () => configured });
		try {
			expect(host.compactionPolicyForTest()).toEqual(COMPACTION_DEFAULTS);
			// The getter is re-read on every resolution: a configuration change
			// reaches an already-open host with no restart (design D4).
			configured = { reserveTokens: 40000 };
			expect(host.compactionPolicyForTest().reserveTokens).toBe(40000);
			expect(host.compactionPolicyForTest().enabled).toBe(true);
		} finally {
			await host.shutdown();
		}
	});

	test("exact windows and policies remain independent across tracked runs and switches", async () => {
		const dir = tempWorkflowDir();
		const faux = fauxProvider({ models: MODELS });
		const models = createModels();
		models.setProvider(faux.provider);
		const host = await openHost({ dir, models, compaction: () => ({}) });
		try {
			const envPath = writeRunEnv(dir, { HERDR_RUN_ID: "run-wide" });
			await ensureFixtureRun(host, {
				runId: "run-wide",
				name: "worker-wide",
				cwd: dir,
				runEnvPath: envPath,
				toolPolicy: "default",
				model: modelRef(faux, "wide"),
			});
			expect(host.referenceWindowForTest(modelRef(faux, "wide"))).toBe(
				1_000_000,
			);

			await ensureFixtureRun(host, {
				runId: "run-mid",
				name: "worker-mid",
				cwd: dir,
				runEnvPath: writeRunEnv(dir, { HERDR_RUN_ID: "run-mid" }),
				toolPolicy: "default",
				model: modelRef(faux, "mid"),
			});
			expect(host.referenceWindowForTest(modelRef(faux, "mid"))).toBe(200_000);
			expect(
				host.compactionPolicyForTest(modelRef(faux, "wide")).reserveTokens,
			).toBe(300_000);
			expect(
				host.compactionPolicyForTest(modelRef(faux, "mid")).reserveTokens,
			).toBe(60_000);

			// A live `/model` override to a smaller window shrinks it again.
			await host.configureRun("run-mid", { model: modelRef(faux, "narrow") });
			expect(host.referenceWindowForTest(modelRef(faux, "narrow"))).toBe(
				100_000,
			);
			expect(
				host.compactionPolicyForTest(modelRef(faux, "wide")).reserveTokens,
			).toBe(300_000);
			expect(host.compactionPolicyForTest("unknown/model").reserveTokens).toBe(
				32000,
			);

			// And the percentage resolves against it.
			const percentHost = await openHost({
				dir,
				models,
				compaction: () => ({ keepRecentTokens: "15%" }),
			});
			try {
				// No tracked run yet: no window, so the absolute default applies.
				expect(percentHost.compactionPolicyForTest().keepRecentTokens).toBe(
					COMPACTION_DEFAULTS.keepRecentTokens,
				);
			} finally {
				await percentHost.shutdown();
			}
		} finally {
			await host.shutdown();
		}
	});

	test("a run on a 1M-token window compacts automatically, far below the old absolute threshold", async () => {
		// The regression this file exists for: the documented default reserve is
		// window-relative, because an absolute 32000 put the blocking threshold at
		// 968000 tokens on the models the presets actually run (opencode-go's
		// deepseek-v4.1-flash and gpt-6-luna, kimi-coding's k3), which a real run
		// never reaches. Roughly 810000 estimated tokens of context — 3240000
		// characters at pi-ai's 4-chars-per-token estimate — is above the 700000
		// trigger and well below that threshold.
		const dir = tempWorkflowDir();
		const faux = fauxProvider({ models: MODELS });
		const models = createModels();
		models.setProvider(faux.provider);
		const host = await openHost({ dir, models });
		try {
			const telemetryPath = path.join(dir, "telemetry.jsonl");
			const envPath = writeRunEnv(dir, {
				HERDR_WORKFLOW_ID: "wf-1",
				HERDR_RUN_ID: "run-1",
				HERDR_ROLE: "worker",
				HERDR_TELEMETRY_PATH: telemetryPath,
			});
			await ensureFixtureRun(host, {
				runId: "run-1",
				name: "worker-1",
				cwd: dir,
				runEnvPath: envPath,
				toolPolicy: "default",
				model: modelRef(faux, "wide"),
			});
			expect(host.referenceWindowForTest(modelRef(faux, "wide"))).toBe(
				1_000_000,
			);
			// 30% of the window: automatic compaction starts at 70% of it.
			expect(
				host.compactionPolicyForTest(modelRef(faux, "wide")).reserveTokens,
			).toBe(300_000);

			// A first, small turn, so the huge one has a verbatim tail to keep.
			faux.setResponses([fauxAssistantMessage([fauxText("ok")])]);
			await submitFixtureRun(host, "run-1", "hello", "req-0");
			await waitForIdle(host, "run-1");

			faux.appendResponses([
				fauxAssistantMessage([fauxText("summary of the older context")]),
				fauxAssistantMessage([fauxText("acknowledged")]),
			]);
			await submitFixtureRun(
				host,
				"run-1",
				"context worth summarizing. ".repeat(120_000),
				"req-1",
			);
			await waitForIdle(host, "run-1");

			const entries = await host.entriesForTest("run-1");
			expect(
				entries.some(
					(entry) => (entry as { kind?: string }).kind === "pi.compaction",
				),
			).toBe(true);
			// The reason says it was the threshold, not an overflow recovery.
			const lines = await waitForLines(telemetryPath, "runtime.compaction");
			expect(
				lines.find((line) => line.event === "runtime.compaction_start"),
			).toMatchObject({ reason: "threshold", blocking: true });
			expect(
				lines.find((line) => line.event === "runtime.compaction"),
			).toMatchObject({ reason: "threshold", outcome: "completed" });
		} finally {
			await host.shutdown();
		}
	});
});

test("native overflow recovery uses exact model policy and retries once", async () => {
	const dir = tempWorkflowDir();
	const faux = fauxProvider({ models: MODELS });
	const models = createModels();
	models.setProvider(faux.provider);
	const host = await openHost({
		dir,
		models,
		compaction: () => ({
			ceilingTokens: 0,
			backgroundTokens: 0,
			modelOverrides: {
				[modelRef(faux, "narrow")]: { keepRecentTokens: 4096 },
			},
		}),
	});
	try {
		await ensureFixtureRun(host, {
			runId: "overflow",
			name: "overflow",
			cwd: dir,
			runEnvPath: writeRunEnv(dir, { HERDR_RUN_ID: "overflow" }),
			toolPolicy: "default",
			model: modelRef(faux, "narrow"),
		});
		faux.setResponses([
			fauxAssistantMessage([fauxText("ok")]),
			fauxAssistantMessage([fauxText("ok")]),
		]);
		await submitFixtureRun(host, "overflow", "history ".repeat(15000), "seed");
		await waitForIdle(host, "overflow");
		await submitFixtureRun(host, "overflow", "tail", "tail");
		await waitForIdle(host, "overflow");
		faux.appendResponses([
			{
				...fauxAssistantMessage([]),
				stopReason: "error",
				errorMessage: "maximum context length exceeded",
			},
			fauxAssistantMessage([fauxText("summary")]),
			fauxAssistantMessage([fauxText("answer")]),
		]);
		await submitFixtureRun(host, "overflow", "continue", "overflow");
		await waitForIdle(host, "overflow");
		const summaries = (await host.entriesForTest("overflow")).filter(
			(entry) => (entry as { kind?: string }).kind === "pi.compaction",
		);
		expect(summaries).toHaveLength(1);
		expect(summaries[0]).toMatchObject({ data: { reason: "overflow" } });
	} finally {
		await host.shutdown();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("native policies isolate concurrent windows, live edits and a model switch", async () => {
	const dir = tempWorkflowDir();
	const faux = fauxProvider({ models: MODELS });
	const models = createModels();
	models.setProvider(faux.provider);
	let config: CompactionConfig = {
		enabled: false,
		ceilingTokens: 0,
		backgroundTokens: 0,
	};
	const host = await openHost({ dir, models, compaction: () => config });
	try {
		for (const id of ["narrow", "wide"]) {
			await ensureFixtureRun(host, {
				runId: id,
				name: id,
				cwd: dir,
				runEnvPath: writeRunEnv(dir, { HERDR_RUN_ID: id }),
				toolPolicy: "default",
				model: modelRef(faux, id),
			});
			faux.appendResponses([
				fauxAssistantMessage([fauxText("ok")]),
				fauxAssistantMessage([fauxText("ok")]),
			]);
			await submitFixtureRun(
				host,
				id,
				"old history ".repeat(30000),
				`seed-${id}`,
			);
			await waitForIdle(host, id);
			await submitFixtureRun(host, id, "tail", `tail-${id}`);
			await waitForIdle(host, id);
		}
		config = { ...config, enabled: true };
		faux.appendResponses(
			Array.from({ length: 8 }, () =>
				fauxAssistantMessage([fauxText("summary or answer")]),
			),
		);
		await Promise.all([
			submitFixtureRun(host, "narrow", "next", "next-narrow"),
			submitFixtureRun(host, "wide", "next", "next-wide"),
		]);
		await Promise.all([waitForIdle(host, "narrow"), waitForIdle(host, "wide")]);
		const summaries = async (id: string) =>
			(await host.entriesForTest(id)).filter(
				(entry) => (entry as { kind?: string }).kind === "pi.compaction",
			).length;
		expect(await summaries("narrow")).toBe(1);
		expect(await summaries("wide")).toBe(0);
		await host.configureRun("wide", { model: modelRef(faux, "narrow") });
		await submitFixtureRun(host, "wide", "after switch", "switched");
		await waitForIdle(host, "wide");
		expect(await summaries("wide")).toBe(1);
		config = {
			...config,
			modelOverrides: {
				[modelRef(faux, "narrow")]: { enabled: false, keepRecentTokens: "10%" },
			},
		};
		expect(
			host.compactionPolicyForTest(modelRef(faux, "narrow")),
		).toMatchObject({ enabled: false, keepRecentTokens: 10000 });
		expect(host.compactionPolicyForTest(modelRef(faux, "wide")).enabled).toBe(
			true,
		);
	} finally {
		await host.shutdown();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("manual compaction outcomes", () => {
	test("a conversation with nothing to summarize reports nothing-to-compact", async () => {
		const dir = tempWorkflowDir();
		const faux = fauxProvider({ models: MODELS });
		const models = createModels();
		models.setProvider(faux.provider);
		const host = await openHost({ dir, models });
		try {
			const envPath = writeRunEnv(dir, { HERDR_RUN_ID: "run-empty" });
			await ensureFixtureRun(host, {
				runId: "run-empty",
				name: "worker-empty",
				cwd: dir,
				runEnvPath: envPath,
				toolPolicy: "default",
				model: modelRef(faux, "mid"),
			});
			expect(await host.compactRun("run-empty")).toEqual({
				status: "nothing-to-compact",
			});
			// The host still serves a read-only run: compaction rewrites
			// conversation context, not the repository.
			const readOnlyEnv = writeRunEnv(dir, { HERDR_RUN_ID: "run-readonly" });
			await ensureFixtureRun(host, {
				runId: "run-readonly",
				name: "verifier-1",
				cwd: dir,
				runEnvPath: readOnlyEnv,
				toolPolicy: "read-only",
				model: modelRef(faux, "mid"),
			});
			expect(
				await host.compactRun("run-readonly", "focus on findings"),
			).toEqual({ status: "nothing-to-compact" });
		} finally {
			await host.shutdown();
		}
	});

	test("an untracked run is refused and an over-long instruction is an invalid request", async () => {
		const dir = tempWorkflowDir();
		const faux = fauxProvider({ models: MODELS });
		const models = createModels();
		models.setProvider(faux.provider);
		const host = await openHost({ dir, models });
		try {
			await expect(host.compactRun("ghost")).rejects.toThrow(/unknown run/);
			const envPath = writeRunEnv(dir, { HERDR_RUN_ID: "run-1" });
			await ensureFixtureRun(host, {
				runId: "run-1",
				name: "worker-1",
				cwd: dir,
				runEnvPath: envPath,
				toolPolicy: "default",
				model: modelRef(faux, "mid"),
			});
			await expect(host.compactRun("run-1", "x".repeat(2001))).rejects.toThrow(
				/invalid request/,
			);
		} finally {
			await host.shutdown();
		}
	});

	test("over the control socket an unknown run is `unknown-run`, an over-long instruction is `invalid-request` and a served run answers structurally", async () => {
		const dir = tempWorkflowDir();
		const faux = fauxProvider({ models: MODELS });
		const models = createModels();
		models.setProvider(faux.provider);
		const host = await openHost({ dir, models });
		try {
			await host.listen();
			const { HostClient } = await import("../src/agent-host/client.ts");
			const client = new HostClient(hostLayout(dir).socketPath, 5_000);
			await expect(client.compactRun("ghost")).rejects.toThrow(/unknown-run/);
			const envPath = writeRunEnv(dir, { HERDR_RUN_ID: "run-1" });
			await ensureFixtureRun(host, {
				runId: "run-1",
				name: "worker-1",
				cwd: dir,
				runEnvPath: envPath,
				toolPolicy: "default",
				model: modelRef(faux, "mid"),
			});
			await expect(
				client.compactRun("run-1", "x".repeat(2001)),
			).rejects.toThrow(/invalid-request/);
			// A served run answers with an outcome rather than an error.
			expect(await client.compactRun("run-1")).toMatchObject({
				type: "compactRun",
				runId: "run-1",
				status: "nothing-to-compact",
			});
		} finally {
			await host.shutdown();
		}
	});

	test("a compaction is admitted once, reported as already compacting while it runs, and places a summary", async () => {
		const dir = tempWorkflowDir();
		const faux = fauxProvider({ models: MODELS });
		const models = createModels();
		models.setProvider(faux.provider);
		// A kept-verbatim tail at the floor makes a small conversation compactable,
		// and a pending summarizer keeps the task observably in flight.
		const host = await openHost({
			dir,
			models,
			compaction: () => ({ keepRecentTokens: 4096 }),
		});
		try {
			const telemetryPath = path.join(dir, "telemetry.jsonl");
			const envPath = writeRunEnv(dir, {
				HERDR_WORKFLOW_ID: "wf-1",
				HERDR_RUN_ID: "run-1",
				HERDR_ROLE: "worker",
				HERDR_TELEMETRY_PATH: telemetryPath,
			});
			await ensureFixtureRun(host, {
				runId: "run-1",
				name: "worker-1",
				cwd: dir,
				runEnvPath: envPath,
				toolPolicy: "default",
				model: modelRef(faux, "mid"),
			});
			// A context larger than the kept tail, so a summarized range exists.
			const big = "context worth summarizing. ".repeat(4000);
			faux.setResponses([fauxAssistantMessage([fauxText("acknowledged")])]);
			await submitFixtureRun(host, "run-1", big, "req-1");
			faux.appendResponses([delayedResponse(1500)]);
			let working = await host.status("run-1");
			for (let i = 0; i < 50 && working.status !== "idle"; i++) {
				await new Promise((resolve) => setTimeout(resolve, 20));
				working = await host.status("run-1");
			}
			expect(working.status).toBe("idle");

			const started = await host.compactRun(
				"run-1",
				"focus on the open findings",
			);
			expect(started.status).toBe("started");
			expect(started.taskId).toBeTruthy();

			// A second compaction while the first is listed is reported, not admitted.
			const second = await host.compactRun("run-1");
			expect(second.status).toBe("already-compacting");
			expect(second.reason).toBe("manual");

			// The summary lands once the summarizer answers; the live status then
			// disappears and the transcript carries the committed compaction entry.
			let entries: readonly unknown[] = [];
			for (let i = 0; i < 100; i++) {
				entries = await host.entriesForTest("run-1");
				if (
					entries.some(
						(entry) => (entry as { kind?: string }).kind === "pi.compaction",
					)
				)
					break;
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			expect(
				entries.some(
					(entry) => (entry as { kind?: string }).kind === "pi.compaction",
				),
			).toBe(true);
		} finally {
			await host.shutdown();
		}
	});

	test("the compaction envelopes carry the reason, the outcome and the measured token movement", async () => {
		const dir = tempWorkflowDir();
		const faux = fauxProvider({ models: MODELS });
		const models = createModels();
		models.setProvider(faux.provider);
		const host = await openHost({
			dir,
			models,
			compaction: () => ({ keepRecentTokens: 4096 }),
		});
		try {
			const telemetryPath = path.join(dir, "telemetry.jsonl");
			const envPath = writeRunEnv(dir, {
				HERDR_WORKFLOW_ID: "wf-1",
				HERDR_RUN_ID: "run-1",
				HERDR_ROLE: "worker",
				HERDR_TELEMETRY_PATH: telemetryPath,
			});
			await ensureFixtureRun(host, {
				runId: "run-1",
				name: "worker-1",
				cwd: dir,
				runEnvPath: envPath,
				toolPolicy: "default",
				model: modelRef(faux, "mid"),
			});
			const big = "context worth summarizing. ".repeat(4000);
			faux.setResponses([fauxAssistantMessage([fauxText("acknowledged")])]);
			await submitFixtureRun(host, "run-1", big, "req-1");
			faux.appendResponses([delayedResponse(200)]);
			let working = await host.status("run-1");
			for (let i = 0; i < 50 && working.status !== "idle"; i++) {
				await new Promise((resolve) => setTimeout(resolve, 20));
				working = await host.status("run-1");
			}
			expect(await host.compactRun("run-1")).toMatchObject({
				status: "started",
			});
			// Wait for the summary to be placed: the committed `pi.compaction` entry
			// is the receipt that the compaction ended.
			await waitFor(async () =>
				(await host.entriesForTest("run-1")).some(
					(entry) => (entry as { kind?: string }).kind === "pi.compaction",
				),
			);
			// A generation after the placed summary measures the context it left.
			faux.appendResponses([fauxAssistantMessage([fauxText("after")])]);
			await submitFixtureRun(host, "run-1", "and now?", "req-2");

			const lines = await waitForLines(telemetryPath, "runtime.compaction");
			const started = lines.find(
				(line) => line.event === "runtime.compaction_start",
			);
			expect(started).toMatchObject({
				reason: "manual",
				blocking: false,
				attempt: 1,
			});
			const finished = lines.find(
				(line) => line.event === "runtime.compaction",
			);
			expect(finished).toMatchObject({
				reason: "manual",
				outcome: "completed",
			});
			expect(typeof finished?.durationMs).toBe("number");
			expect(typeof finished?.tokensBefore).toBe("number");
			// The measured request after the summary is genuinely smaller, so the
			// movement is reported rather than invented.
			expect(typeof finished?.tokensAfter).toBe("number");
			expect(finished?.tokensAfter as number).toBeLessThan(
				finished?.tokensBefore as number,
			);
			// No summary text ever reaches an envelope.
			expect(JSON.stringify(lines)).not.toContain(
				"summary of the older context",
			);
		} finally {
			await host.shutdown();
		}
	});
});
