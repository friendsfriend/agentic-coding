#!/usr/bin/env bun

// Synthetic-load harness for the unified TUI/server main thread
// (fix-tui-freezes-and-memory).
//
// The developer's freeze happens on a real store holding ~150 workflow records,
// several concurrent workflows and a large trace database. This harness builds
// that shape from synthetic data only and drives the real read paths in-process,
// so a main-thread cost can be measured as a number instead of argued about.
//
// Isolation is not optional: the harness refuses to run unless every store, wiki
// and configuration root it uses lives under one freshly created temporary
// directory, and it writes nothing outside that directory.
//
//   bun run scripts/tui-load-harness.ts [--workflows 150] [--active 8]
//        [--rounds 10] [--json]
//
// Reported per scenario: wall time (median/max), event-loop lag observed while
// the scenario runs, and RSS/heap delta. `--json` prints the same table as JSON.

import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Options {
	readonly workflows: number;
	readonly active: number;
	readonly rounds: number;
	readonly runsPerWorkflow: number;
	readonly taskBytes: number;
	readonly keep: boolean;
	readonly json: boolean;
}

function parseOptions(argv: readonly string[]): Options {
	const flag = (name: string, fallback: number): number => {
		const index = argv.indexOf(`--${name}`);
		if (index === -1) return fallback;
		const value = Number(argv[index + 1]);
		if (!Number.isFinite(value) || value < 1)
			throw new Error(`--${name} needs a positive number`);
		return Math.floor(value);
	};
	return {
		workflows: flag("workflows", 150),
		active: flag("active", 8),
		rounds: flag("rounds", 10),
		runsPerWorkflow: flag("runs", 6),
		taskBytes: flag("task-bytes", 4096),
		keep: argv.includes("--keep"),
		json: argv.includes("--json"),
	};
}

const options = parseOptions(process.argv.slice(2));

// ---------------------------------------------------------------------------
// Isolation: HOME, configuration root and wiki root are all temp directories.
// ---------------------------------------------------------------------------

const sandbox = mkdtempSync(join(tmpdir(), "tui-load-harness-"));
process.env.HOME = join(sandbox, "home");
process.env.AGENTIC_CODING_CONFIG_DIR = join(sandbox, "config");
process.env.HERDR_WIKI_DIR = join(sandbox, "wiki");
process.env.XDG_DATA_HOME = join(sandbox, "data");
process.env.XDG_CACHE_HOME = join(sandbox, "cache");
process.env.XDG_STATE_HOME = join(sandbox, "state");
for (const key of [
	"HOME",
	"AGENTIC_CODING_CONFIG_DIR",
	"HERDR_WIKI_DIR",
	"XDG_DATA_HOME",
	"XDG_CACHE_HOME",
	"XDG_STATE_HOME",
] as const) {
	const value = process.env[key];
	if (!value?.startsWith(sandbox))
		throw new Error(`harness refused: ${key} is not inside the sandbox`);
	mkdirSync(value, { recursive: true });
}

const repository = join(sandbox, "repo");
mkdirSync(repository, { recursive: true });
Bun.spawnSync(["git", "init", "-q", repository]);

// ---------------------------------------------------------------------------
// Real read paths.
// ---------------------------------------------------------------------------

const { registerBuiltins } = await import("../src/workflow/definitions.ts");
const { initializeStore, STORE_SCHEMA_VERSION } = await import(
	"../src/workflow/runtime/store.ts"
);
const { canonicalStorePath } = await import(
	"../src/workflow/runtime/targets.ts"
);
const { listWorkflowViewsFor } = await import("../src/server/handlers.ts");

const registry = registerBuiltins();
const definition = registry.definition("no-openspec", 1);
const activeStep = definition.steps.includes("core.implementation")
	? "core.implementation"
	: (definition.steps[0] ?? "");
const finishedStep = definition.steps.includes("core.archive")
	? "core.archive"
	: (definition.steps[definition.steps.length - 1] ?? activeStep);

const PROFILE_DIGEST = "harness-profile-digest";
const routing = {
	defaultProfile: "harness",
	routes: definition.steps.map((stepId: string) => ({
		stepId,
		profile: {
			name: "harness",
			runtime: "pi-durable",
			executable: process.execPath,
			tools: [] as string[],
			extensions: [] as string[],
			readOnly: false,
			capabilities: ["prompt", "observe"],
			digest: PROFILE_DIGEST,
		},
	})),
};

const task = "A synthetic assignment body. ".repeat(
	Math.max(1, Math.floor(options.taskBytes / 29)),
);

/** Evidence a workflow of this round shape holds: every step that ran kept some. */
function evidenceFor(index: number): unknown[] {
	return Array.from({ length: 20 }, (_value, item) => ({
		kind: item % 2 === 0 ? "findings" : "report",
		path: `evidence/wf-${index}/item-${item}.json`,
		digest: `${index}${item}`.padEnd(64, "0"),
	}));
}

/** Answered developer questions, the dialogue half of a long-running workflow. */
function dialogueFor(index: number, at: string): unknown[] {
	return Array.from({ length: 12 }, (_value, item) => ({
		id: `wf-${index}-q-${item}`,
		workflowId: `wf-${index}`,
		runId: `wf-${index}-run-0`,
		stepId: activeStep,
		role: "worker",
		description: `synthetic question ${item}`,
		options: [],
		status: "answered",
		createdAt: at,
		expiresAt: at,
		answeredAt: at,
		answer: { kind: "option", value: "yes" },
	}));
}

function classifierDecisionsFor(index: number, at: string): unknown[] {
	return Array.from({ length: 6 }, (_value, item) => ({
		id: `wf-${index}-d-${item}`,
		at,
		integration: "routing",
		phase: "apply",
		questionId: `q-${item}`,
		model: "harness/model",
		input: "synthetic classifier state",
		inputTruncated: false,
		options: [],
		answer: { type: "noul", noul: 0.5, confidence: 0.9 },
		result: { applied: true, profiles: ["harness"] },
	}));
}

function gateDecisionsFor(index: number, at: string): unknown[] {
	return Array.from({ length: 6 }, (_value, item) => ({
		id: `wf-${index}-g-${item}`,
		at,
		stepId: activeStep,
		stage: "plan",
		policy: "auto",
		decision: "run",
		forced: false,
	}));
}

function snapshotFor(index: number, active: boolean, at: string): unknown {
	return {
		schemaVersion: 1,
		workflowId: `wf-${index}`,
		revision: 7,
		definition: {
			id: definition.id,
			version: definition.version,
			digest: definition.digest,
		},
		status: active ? "active" : index % 3 === 0 ? "closed" : "completed",
		currentStep: active ? activeStep : finishedStep,
		step: {
			attempt: 1,
			activeRunIds: active ? [`wf-${index}-run-active`] : [],
			completedRunIds: [],
			selectedRoles: ["worker"],
			testRunStarted: false,
			results: Array.from({ length: 4 }, (_value, item) => ({
				runId: `wf-${index}-run-${item}`,
				role: "worker",
				critical: 0,
				outputDigest: `${index}${item}`.padEnd(64, "0"),
			})),
		},
		metadata: {
			repository,
			worktree: repository,
			changeId: `change-${index}`,
			branch: "main",
			baseBranch: "main",
			baseCommit: "0".repeat(40),
			task,
			createdAt: at,
			updatedAt: at,
			stepEnteredAt: at,
			startedBy: "developer",
		},
		routing,
		evidence: evidenceFor(index),
		loopCounts: {},
		attention: [],
		developerDialogue: dialogueFor(index, at),
		classifierDecisions: classifierDecisionsFor(index, at),
		gateDecisions: gateDecisionsFor(index, at),
	};
}

function seedStore(): void {
	initializeStore(repository);
	const db = new Database(canonicalStorePath(repository));
	const at = "2026-10-18T09:00:00.000Z";
	const insertInstance = db.query(
		"INSERT INTO workflow_instances VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
	);
	const insertRun = db.query(
		"INSERT INTO workflow_runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
	);
	const insertEffect = db.query(
		"INSERT INTO workflow_outbox VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
	);
	db.exec("BEGIN IMMEDIATE");
	try {
		for (let index = 0; index < options.workflows; index++) {
			const active = index < options.active;
			const id = `wf-${index}`;
			const snapshot = snapshotFor(index, active, at);
			const status = (snapshot as { status: string }).status;
			const step = (snapshot as { currentStep: string }).currentStep;
			insertInstance.run(
				id,
				`change-${index}`,
				repository,
				repository,
				definition.id,
				definition.version,
				definition.digest,
				7,
				status,
				step,
				JSON.stringify(snapshot),
				at,
				at,
			);
			if (active) {
				insertRun.run(
					`${id}-run-active`,
					id,
					activeStep,
					"worker",
					1,
					1,
					"working",
					JSON.stringify({
						name: "harness",
						runtime: "pi-durable",
						model: "harness/model",
						digest: PROFILE_DIGEST,
					}),
					1,
					'["complete"]',
					"hash",
					at,
					`${id}/assignment.md`,
					null,
					null,
					null,
					null,
					null,
					at,
					null,
				);
			}
			for (let run = 0; run < options.runsPerWorkflow; run++) {
				insertRun.run(
					`${id}-run-${run}`,
					id,
					run % 2 === 0 ? "core.plan" : finishedStep,
					"worker",
					1,
					run + 1,
					"completed",
					JSON.stringify({
						name: "harness",
						runtime: "pi-durable",
						model: "harness/model",
						digest: PROFILE_DIGEST,
					}),
					1,
					'["complete"]',
					"hash",
					at,
					`${id}/assignment-${run}.md`,
					`${id}/out-${run}.json`,
					"core.json",
					1,
					randomUUID().replace(/-/g, ""),
					null,
					at,
					at,
				);
			}
			for (let effect = 0; effect < 2; effect++) {
				insertEffect.run(
					`${id}-effect-${effect}`,
					id,
					7,
					effect === 0 ? "agent.launch" : "delivery.commit",
					`${id}-key-${effect}`,
					"{}",
					"completed",
					1,
					4,
					null,
					null,
					null,
					null,
				);
			}
		}
		db.exec("COMMIT");
	} finally {
		db.close();
	}
}

// ---------------------------------------------------------------------------
// The open workflow: what the dashboard reads while a session is on screen.
// ---------------------------------------------------------------------------

const VERIFIER_ROLES = [
	"quality-verifier",
	"security-verifier",
	"test-verifier",
	"architecture-verifier",
];
const openWorkflowId = "wf-0";
const OPEN_ATTEMPTS = 2;
const FINDINGS_PER_FILE = 40;
const TELEMETRY_EVENTS = Number(process.env.HARNESS_TELEMETRY_EVENTS ?? 4_000);

/** Seed the files one open workflow's dashboard read touches: its telemetry
 * stream and one committed verifier artifact per role and round. */
function seedOpenWorkflow(): { telemetryBytes: number; outputBytes: number } {
	const root = join(repository, ".herdr-workflow", openWorkflowId);
	mkdirSync(root, { recursive: true });
	const lines: string[] = [];
	for (let index = 0; index < TELEMETRY_EVENTS; index++) {
		lines.push(
			JSON.stringify({
				event: "provider_response",
				role: VERIFIER_ROLES[index % VERIFIER_ROLES.length],
				at: "2026-10-18T09:00:00.000Z",
				status: 200,
				model: "harness/model",
				inputTokens: 1000,
				outputTokens: 250,
				costUsd: 0.01,
				spanId: `span-${index}`,
				traceId: `trace-${index % 8}`,
			}),
		);
	}
	const telemetry = `${lines.join("\n")}\n`;
	writeFileSync(join(root, "telemetry.jsonl"), telemetry);

	const db = new Database(canonicalStorePath(repository));
	const insertRun = db.query(
		"INSERT INTO workflow_runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
	);
	let outputBytes = 0;
	const detail =
		"a synthetic finding body that describes one observation. ".repeat(40);
	db.exec("BEGIN IMMEDIATE");
	try {
		for (let attempt = 1; attempt <= OPEN_ATTEMPTS; attempt++) {
			for (const [roleIndex, role] of VERIFIER_ROLES.entries()) {
				const runId = `${openWorkflowId}-verify-${attempt}-${roleIndex}`;
				const findings = Array.from(
					{ length: FINDINGS_PER_FILE },
					(_value, item) => ({
						id: `${runId}-finding-${item}`,
						severity:
							item % 17 === 0
								? "critical"
								: item % 3 === 0
									? "warning"
									: "info",
						detail,
						path: "src/harness.ts",
						line: item + 1,
					}),
				);
				const envelope = `${JSON.stringify({
					runId,
					schemaId: "core.findings",
					schemaVersion: 1,
					payload: { findings },
				})}\n`;
				const outputPath = join(root, `findings-${attempt}-${roleIndex}.json`);
				writeFileSync(outputPath, envelope);
				outputBytes += Buffer.byteLength(envelope);
				insertRun.run(
					runId,
					openWorkflowId,
					"core.verification",
					role,
					1,
					attempt,
					"completed",
					JSON.stringify({
						name: "harness",
						runtime: "pi-durable",
						model: "harness/model",
						digest: PROFILE_DIGEST,
					}),
					1,
					'["complete"]',
					"hash",
					"2026-10-18T10:00:00.000Z",
					`${openWorkflowId}/assignment-${roleIndex}.md`,
					outputPath,
					"core.findings",
					1,
					createHash("sha256").update(envelope).digest("hex"),
					null,
					"2026-10-18T09:00:00.000Z",
					"2026-10-18T10:00:00.000Z",
				);
			}
		}
		db.exec("COMMIT");
	} finally {
		db.close();
	}
	return {
		telemetryBytes: Buffer.byteLength(telemetry),
		outputBytes,
	};
}

// ---------------------------------------------------------------------------
// Measurement.
// ---------------------------------------------------------------------------

/** High-resolution timer drift: a 10 ms ticker records how late each tick ran,
 * which is the synchronous blocking stretch of the thread it shares. */
class LagSampler {
	#timer: ReturnType<typeof setTimeout> | undefined;
	#last = 0;
	readonly samples: number[] = [];

	start(intervalMs = 10): void {
		this.#last = performance.now();
		const tick = () => {
			const now = performance.now();
			this.samples.push(Math.max(0, now - this.#last - intervalMs));
			this.#last = now;
			this.#timer = setTimeout(tick, intervalMs);
			this.#timer.unref?.();
		};
		this.#timer = setTimeout(tick, intervalMs);
		this.#timer.unref?.();
	}

	stop(): {
		readonly max: number;
		readonly p95: number;
		readonly count: number;
	} {
		if (this.#timer !== undefined) clearTimeout(this.#timer);
		this.#timer = undefined;
		const sorted = [...this.samples].sort((a, b) => a - b);
		const at = (q: number) =>
			sorted.length === 0
				? 0
				: Math.round(
						sorted[
							Math.min(sorted.length - 1, Math.floor(q * sorted.length))
						] ?? 0,
					);
		return {
			max: at(1) || Math.round(sorted.at(-1) ?? 0),
			p95: at(0.95),
			count: sorted.length,
		};
	}
}

interface Measurement {
	readonly name: string;
	readonly runs: number;
	readonly minMs: number;
	readonly medianMs: number;
	readonly maxMs: number;
	readonly lagMaxMs: number;
	readonly lagP95Ms: number;
	/** Bytes the operation allocated (garbage included) before any collection.
	 * Forced GC before and after turns a noisy heap delta into a stable churn
	 * figure: it is what the main thread makes the collector deal with. */
	readonly churnMb: number;
	readonly heapDeltaMb: number;
	readonly rssDeltaMb: number;
}

async function measure(
	name: string,
	runs: number,
	operation: () => unknown,
): Promise<Measurement> {
	const sampler = new LagSampler();
	sampler.start();
	const heapBefore = process.memoryUsage().heapUsed;
	const rssBefore = process.memoryUsage().rss;
	const durations: number[] = [];
	let churn = 0;
	for (let run = 0; run < runs; run++) {
		Bun.gc(true);
		const before = process.memoryUsage().heapUsed;
		const started = performance.now();
		await operation();
		durations.push(performance.now() - started);
		churn += process.memoryUsage().heapUsed - before;
		// One turn between rounds: the lag sampler can then observe the blocking
		// stretch that just ran instead of only the sum of the loop.
		await Bun.sleep(1);
	}
	const lag = sampler.stop();
	const heapAfter = process.memoryUsage().heapUsed;
	const rssAfter = process.memoryUsage().rss;
	const sorted = [...durations].sort((a, b) => a - b);
	return {
		name,
		runs,
		minMs: Number((sorted[0] ?? 0).toFixed(1)),
		medianMs: Number((sorted[Math.floor(sorted.length / 2)] ?? 0).toFixed(1)),
		maxMs: Number((sorted.at(-1) ?? 0).toFixed(1)),
		lagMaxMs: lag.max,
		lagP95Ms: lag.p95,
		churnMb: Number((churn / runs / 1_048_576).toFixed(1)),
		heapDeltaMb: Number(((heapAfter - heapBefore) / 1_048_576).toFixed(1)),
		rssDeltaMb: Number(((rssAfter - rssBefore) / 1_048_576).toFixed(1)),
	};
}

// ---------------------------------------------------------------------------

seedStore();
const openFiles = seedOpenWorkflow();
const storeBytes = (() => {
	const db = new Database(canonicalStorePath(repository), { readonly: true });
	try {
		return (
			(
				db
					.query(
						"SELECT SUM(LENGTH(snapshot_json)) AS n FROM workflow_instances",
					)
					.get() as {
					n: number;
				}
			).n ?? 0
		);
	} finally {
		db.close();
	}
})();

const results: Measurement[] = [];
// Warm-up: the first listing pays module-state and statement-preparation costs.
listWorkflowViewsFor(repository);
results.push(
	await measure("listWorkflowViews", options.rounds, () => {
		listWorkflowViewsFor(repository);
	}),
);
results.push(
	await measure("listWorkflowViews (back to back)", 3, () => {
		for (let round = 0; round < 5; round++) listWorkflowViewsFor(repository);
	}),
);

const firstId = "wf-0";
const { getWorkflowView } = await import("../src/server/operations/engine.ts");
results.push(
	await measure("workflow view (one)", options.rounds, () => {
		getWorkflowView(repository, firstId);
	}),
);

// The read the session view refreshes through when a run hands off: the whole
// dashboard observation of the workflow on screen.
const { loadDashboard } = await import(
	"../src/server/operations/observations.ts"
);
await loadDashboard(repository, openWorkflowId);
results.push(
	await measure("loadDashboard (open workflow)", options.rounds, () =>
		loadDashboard(repository, openWorkflowId),
	),
);

// Component breakdown: the same 150 records, each step of a listing measured on
// its own, so a fix can name the part it removed.
const { decodeSnapshot } = await import("../src/workflow/contracts.ts");
const store = new Database(canonicalStorePath(repository), { readonly: true });
const instanceRows = store
	.query("SELECT id, snapshot_json FROM workflow_instances")
	.all() as Array<{ id: string; snapshot_json: string }>;
results.push(
	await measure(`JSON.parse ×${instanceRows.length}`, 3, () => {
		for (const row of instanceRows) JSON.parse(row.snapshot_json);
	}),
);
const parsed = instanceRows.map((row) => JSON.parse(row.snapshot_json));
results.push(
	await measure(`decodeSnapshot ×${parsed.length}`, 3, () => {
		for (const value of parsed) decodeSnapshot(value);
	}),
);
const ids = instanceRows.map((row) => row.id);
results.push(
	await measure(`instance row by id ×${ids.length}`, 3, () => {
		for (const id of ids)
			store.query("SELECT * FROM workflow_instances WHERE id=?").get(id);
	}),
);
results.push(
	await measure(`runs + effects by id ×${ids.length}`, 3, () => {
		for (const id of ids) {
			store.query("SELECT * FROM workflow_runs WHERE workflow_id=?").all(id);
			store.query("SELECT * FROM workflow_outbox WHERE workflow_id=?").all(id);
		}
	}),
);
results.push(
	await measure("bulk: instances + runs + effects", 3, () => {
		store.query("SELECT id, snapshot_json FROM workflow_instances").all();
		store.query("SELECT * FROM workflow_runs").all();
		store.query("SELECT * FROM workflow_outbox").all();
	}),
);
store.close();

// ---------------------------------------------------------------------------
// Live telemetry: the OTLP path the receivers push into the TUI stores.
// ---------------------------------------------------------------------------

const { TraceStore } = await import("../src/tui/otel/model/traceStore.ts");
const { LogStore } = await import("../src/tui/otel/model/logStore.ts");

type SpanLike = Parameters<
	InstanceType<typeof TraceStore>["pushBatch"]
>[0][number];
type LogLike = Parameters<
	InstanceType<typeof LogStore>["pushBatch"]
>[0][number];

/** One span of a workflow's trace, shaped like the OTLP decoder's output. */
function spanAt(trace: string, index: number): SpanLike {
	return {
		traceId: `trace-${trace}`,
		spanId: `span-${trace}-${index}`,
		parentSpanId: index === 0 ? "" : `span-${trace}-0`,
		name: "workflow.run",
		startTimeUnixNano: `${1_700_000_000_000_000_000n + BigInt(index)}`,
		endTimeUnixNano: `${1_700_000_000_000_000_000n + BigInt(index) + 1000n}`,
		status: { code: 0 },
		attributes: [{ key: "herdr.change.id", value: `change-${index % 8}` }],
		resource: { attributes: [], droppedAttributesCount: 0 },
		scope: { name: "harness", version: "1" },
		serviceName: "harness",
		kind: 0,
	} as SpanLike;
}

function logAt(index: number): LogLike {
	return {
		traceId: `trace-${index % 8}`,
		spanId: `span-${index}`,
		serviceName: "harness",
		severityText: "INFO",
		severityNumber: 9,
		body: `harness log line ${index}`,
		timeUnixNano: `${1_700_000_000_000_000_000n + BigInt(index)}`,
		attributes: [],
		resource: { attributes: [], droppedAttributesCount: 0 },
		scope: { name: "harness", version: "1" },
	} as LogLike;
}

const totalSpans = Number(process.env.HARNESS_SPANS ?? 100_000);
const batchSize = 100;
const traceStore = new TraceStore();
// One subscriber doing what a mounted trace view does on every notification:
// derive the span tree of the workspace it shows and count the spans.
let notificationCount = 0;
let derivedNodes = 0;
traceStore.onChange(() => {
	notificationCount += 1;
	derivedNodes += traceStore.getSpanTree("change-0").length;
});
const beforeSpans = process.memoryUsage();
const spanSampler = new LagSampler();
spanSampler.start();
const spanStarted = performance.now();
for (let index = 0; index < totalSpans; index += batchSize) {
	const batch: SpanLike[] = [];
	for (let item = 0; item < batchSize; item++)
		batch.push(spanAt("0", index + item));
	traceStore.pushBatch(batch);
}
const spanElapsed = performance.now() - spanStarted;
// Let a coalesced notification land before reading the counters: the deferred
// pass is part of the cost a store adds to the load it was given.
await Bun.sleep(200);
const spanLag = spanSampler.stop();
const afterSpans = process.memoryUsage();
console.log(
	`\nlive push: ${totalSpans} spans in ${totalSpans / batchSize} batches ` +
		`=> ${spanElapsed.toFixed(0)}ms total, worst block ${spanLag.max}ms, ` +
		`${notificationCount} notifications, ${derivedNodes} tree nodes derived, ` +
		`${traceStore.spanCount_} spans retained, ` +
		`rss ${((afterSpans.rss - beforeSpans.rss) / 1_048_576).toFixed(0)}MB, ` +
		`heap ${((afterSpans.heapUsed - beforeSpans.heapUsed) / 1_048_576).toFixed(0)}MB`,
);
const beforeLogs = process.memoryUsage();
const logStore = new LogStore();
const logStarted = performance.now();
for (let index = 0; index < totalSpans; index += batchSize) {
	const batch: LogLike[] = [];
	for (let item = 0; item < batchSize; item++) batch.push(logAt(index + item));
	logStore.pushBatch(batch);
}
const logElapsed = performance.now() - logStarted;
await Bun.sleep(400);
const afterLogs = process.memoryUsage();
console.log(
	`live push: ${totalSpans} logs in ${totalSpans / batchSize} batches ` +
		`=> ${logElapsed.toFixed(0)}ms total, ${logStore.logCount_} logs retained, ` +
		`rss ${((afterLogs.rss - beforeLogs.rss) / 1_048_576).toFixed(0)}MB, ` +
		`heap ${((afterLogs.heapUsed - beforeLogs.heapUsed) / 1_048_576).toFixed(0)}MB`,
);

const report = {
	sandbox,
	workflows: options.workflows,
	active: options.active,
	snapshotBytes: storeBytes,
	storeSchemaVersion: STORE_SCHEMA_VERSION,
	results,
	liveSpans: {
		total: totalSpans,
		batches: totalSpans / batchSize,
		elapsedMs: Number(spanElapsed.toFixed(1)),
		worstBlockMs: spanLag.max,
		notifications: notificationCount,
		treeNodesDerived: derivedNodes,
		heapMb: Number(
			((afterSpans.heapUsed - beforeSpans.heapUsed) / 1_048_576).toFixed(1),
		),
	},
	liveLogs: {
		total: totalSpans,
		elapsedMs: Number(logElapsed.toFixed(1)),
		heapMb: Number(
			((afterLogs.heapUsed - beforeLogs.heapUsed) / 1_048_576).toFixed(1),
		),
	},
};

if (options.json) {
	console.log(JSON.stringify(report, null, 2));
} else {
	console.log(
		`harness: ${options.workflows} workflows (${options.active} active), ` +
			`${(storeBytes / 1024).toFixed(0)} KiB of snapshot JSON, ` +
			`schema v${STORE_SCHEMA_VERSION}; open workflow: ` +
			`${(openFiles.telemetryBytes / 1024 / 1024).toFixed(1)} MiB telemetry, ` +
			`${(openFiles.outputBytes / 1024).toFixed(0)} KiB of verifier output\n`,
	);
	console.log(
		"scenario                            runs     min  median     max   lag-max    churn",
	);
	for (const item of results) {
		console.log(
			`${item.name.padEnd(34)} ${String(item.runs).padStart(4)} ` +
				`${`${item.minMs}ms`.padStart(7)} ${`${item.medianMs}ms`.padStart(7)} ${`${item.maxMs}ms`.padStart(7)} ` +
				`${`${item.lagMaxMs}ms`.padStart(8)} ${`${item.churnMb}MB`.padStart(8)}`,
		);
	}
}

if (!options.keep && existsSync(sandbox))
	rmSync(sandbox, { recursive: true, force: true });
