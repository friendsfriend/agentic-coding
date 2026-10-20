// Item 20 of the efficiency backlog (run-window-integrity): the build's
// run-window alarm.
//
// A run's window is the engine's; its session's window is the durable host's,
// and a session outlives the run. The build therefore refuses a dataset in which
// a run carries turns after its own recorded completion and no session-window
// row names that run — but only once the run's workflow has started recording
// one, because a generation that predates the record (the whole pinned snapshot)
// cannot say anything about it.
//
// The gate is per *run*, not per workflow: a workflow can record one run's move
// and still lose another run's record, and that lost record is exactly what the
// alarm has to catch. The evidence here is a fixture snapshot plus one synthetic
// telemetry file, and the build runs as a child process, exactly as a developer
// runs it.

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { inspectRunWindow } from "../../scripts/efficiency/lib/run-window.ts";
import { makeFixtureEvidence, makeTempDir } from "./fixture.ts";

/** Every drift shape the alarm has to judge, in one telemetry file. */
interface DriftRun {
	readonly runId: string;
	readonly completedAt: string;
	readonly tailAt: string;
	/** The run's own first turn, i.e. when the run started. Defaults to ten minutes
	 * before the completion; a run that has to predate its workflow's first record
	 * states it explicitly. */
	readonly startedAt?: string;
	/** The session window's `closed` record for this run, when the recording
	 * states that its session went on under another run. */
	readonly closedAt?: string;
	/** The session window's `opened` record for this run: the run kept (or
	 * resumed) its own conversation, which is the record a resumed run has. */
	readonly openedAt?: string;
	/** Why the run was bound, when the recording says so (`created`, `rebound`,
	 * `adopted`, `resumed`). */
	readonly reason?: string;
	/** Every `opened` row of this run, when more than one has to be pinned: a
	 * conversation bound twice to one run reports the later move. */
	readonly openings?: ReadonlyArray<{ at: string; reason: string }>;
	/** Set for a run whose own window cannot be read: only the handoff and a
	 * later turn, so the recorded completion is not after the start. */
	readonly unreadableWindow?: boolean;
}

const WF = "wf-session-window";

function envelope(
	event: string,
	at: string,
	runId: string,
	fields: Record<string, unknown> = {},
): string {
	return JSON.stringify({
		schemaVersion: 1,
		layer: "runtime",
		runtime: "pi-durable",
		event,
		at,
		workflowId: WF,
		runId,
		stepId: "core.implementation",
		role: "worker",
		profile: "durable-default",
		...fields,
	});
}

/** Write the synthetic workflow's telemetry into a fixture copy. */
function writeDriftTelemetry(root: string, runs: readonly DriftRun[]): void {
	const lines: string[] = [
		JSON.stringify({
			schemaVersion: 1,
			layer: "engine",
			event: "workflow.started",
			at: "2026-03-01T09:00:00.000Z",
			workflowId: WF,
		}),
	];
	for (const run of runs) {
		const first = run.unreadableWindow
			? "2026-03-01T12:00:00.000Z"
			: (run.startedAt ??
				new Date(Date.parse(run.completedAt) - 600_000).toISOString());
		if (!run.unreadableWindow)
			lines.push(envelope("runtime.turn_started", first, run.runId));
		lines.push(
			envelope("agent.handoff", run.completedAt, run.runId, {
				"herdr.handoff.outcome": "complete",
			}),
		);
		lines.push(envelope("runtime.turn_started", run.tailAt, run.runId));
		// A run's own binding: the record a resumed (or adopted) run has.
		if (run.openedAt !== undefined)
			lines.push(
				envelope("runtime.session_window.opened", run.openedAt, run.runId, {
					"herdr.session.conversation_id": `conv-${run.runId}`,
					"herdr.session.reason": run.reason ?? "resumed",
				}),
			);
		for (const opening of run.openings ?? [])
			lines.push(
				envelope("runtime.session_window.opened", opening.at, run.runId, {
					"herdr.session.conversation_id": `conv-${run.runId}`,
					"herdr.session.reason": opening.reason,
				}),
			);
		// The move to a later run.
		if (run.closedAt !== undefined)
			lines.push(
				envelope("runtime.session_window.closed", run.closedAt, run.runId, {
					"herdr.session.conversation_id": `conv-${run.runId}`,
					"herdr.session.rebound_to": `${run.runId}-next`,
				}),
			);
	}
	fs.writeFileSync(
		path.join(root, "main-store", "telemetry", `${WF}.jsonl`),
		`${lines.join("\n")}\n`,
	);
}

interface BuildRun {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly outDir: string;
	cleanup(): void;
}

const BUILD = path.join(
	import.meta.dir,
	"..",
	"..",
	"scripts",
	"efficiency",
	"build-dataset.ts",
);
const ANALYZE = path.join(
	import.meta.dir,
	"..",
	"..",
	"scripts",
	"efficiency",
	"analyze.ts",
);
const cleanups: Array<() => void> = [];

afterAll(() => {
	for (const cleanup of cleanups) cleanup();
});

/** A fixture snapshot with the synthetic workflow's telemetry added. */
function evidenceWith(runs: readonly DriftRun[]): string {
	const fixture = makeFixtureEvidence();
	cleanups.push(fixture.cleanup);
	writeDriftTelemetry(fixture.root, runs);
	return fixture.root;
}

/** Run the dataset build the way a developer would, in a child process. */
function runBuild(root: string): BuildRun {
	const out = makeTempDir("efficiency-window-build-");
	cleanups.push(out.cleanup);
	const child = Bun.spawnSync(
		[process.execPath, BUILD, "--evidence", root, "--out", out.path, "--quiet"],
		{ cwd: out.path, stdout: "pipe", stderr: "pipe" },
	);
	return {
		exitCode: child.exitCode ?? -1,
		stdout: child.stdout.toString(),
		stderr: child.stderr.toString(),
		outDir: out.path,
		cleanup: out.cleanup,
	};
}

/** The `runWindow` block the build prints, in the shape it prints it. */
interface RunWindowSummary {
	drifting: number;
	judged: { runs: number; attributed: number; resumed: number };
	unrecorded: { runs: number; beforeRecord: number; afterRecord: number };
	clockArtifact: number;
	unexplained: number;
	recordedWorkflows: number;
}

function summaryOf(build: BuildRun): RunWindowSummary {
	return (JSON.parse(build.stdout) as { runWindow: RunWindowSummary })
		.runWindow;
}

const ATTRIBUTED: DriftRun = {
	runId: "run-attributed",
	completedAt: "2026-03-01T10:10:00.000Z",
	tailAt: "2026-03-01T10:20:00.000Z",
	closedAt: "2026-03-01T10:11:00.000Z",
};
const UNEXPLAINED: DriftRun = {
	runId: "run-unexplained",
	completedAt: "2026-03-01T11:10:00.000Z",
	tailAt: "2026-03-01T11:20:00.000Z",
};
const UNREADABLE: DriftRun = {
	runId: "run-clock",
	completedAt: "2026-03-01T12:00:00.000Z",
	tailAt: "2026-03-01T12:20:00.000Z",
	unreadableWindow: true,
};
/** A run that began before its workflow's first session-window record (the first
 * turn is ten minutes before its completion, and `ATTRIBUTED`'s close is later). */
const BEFORE_RECORD: DriftRun = {
	runId: "run-before-record",
	startedAt: "2026-03-01T09:50:00.000Z",
	completedAt: "2026-03-01T10:05:00.000Z",
	// Two minutes past the completion: the query's own one-minute floor, cleared.
	tailAt: "2026-03-01T10:07:00.000Z",
};

describe("the run-window build alarm", () => {
	test("a drifting run with no record of its own fails a workflow that records", () => {
		const root = evidenceWith([ATTRIBUTED, UNEXPLAINED]);
		const build = runBuild(root);
		// The workflow already records session windows (run-attributed), and
		// run-unexplained started after that record, so its own missing record is a
		// defect — not an unrecorded generation.
		expect(build.exitCode).toBe(1);
		expect(build.stderr).toContain("run-unexplained");
		expect(build.stderr).toContain(WF);
		expect(build.stderr).toContain("run-window-drift");
		// The recording explained the first run, so it is not named as a failure.
		expect(build.stderr).not.toContain("run run-attributed");
		// No dataset and no README are left behind.
		expect(fs.existsSync(path.join(build.outDir, "dataset.sqlite"))).toBe(
			false,
		);
		expect(fs.existsSync(path.join(build.outDir, "README.md"))).toBe(false);
	});

	test("a generation that predates the record is reported unrecorded and still builds", () => {
		// Not one session-window event anywhere: the pinned snapshot's shape.
		const root = evidenceWith(
			[ATTRIBUTED, UNEXPLAINED, UNREADABLE].map((run) => ({
				...run,
				closedAt: undefined,
				openedAt: undefined,
			})),
		);
		const build = runBuild(root);
		expect(build.exitCode).toBe(0);
		const window = summaryOf(build);
		// All three drifting runs are counted, and none of them is judged: nothing
		// is due, because the whole workflow predates the record. The unreadable one
		// is its own class and the other two are unrecorded.
		expect(window).toMatchObject({
			drifting: 3,
			judged: { runs: 0, attributed: 0, resumed: 0 },
			unrecorded: { runs: 2, beforeRecord: 2, afterRecord: 0 },
			clockArtifact: 1,
			unexplained: 2,
			recordedWorkflows: 0,
		});
		expect(fs.existsSync(path.join(build.outDir, "dataset.sqlite"))).toBe(true);
	});

	test("attributed, resumed and clock-artifact tails pass a recorded workflow", () => {
		const root = evidenceWith([
			ATTRIBUTED,
			// A run that kept its own conversation through an abort and a resume: the
			// record is `opened`, and it lands after the run's own completion, which
			// used to classify it as unexplained.
			{
				runId: "run-resumed",
				completedAt: "2026-03-01T11:10:00.000Z",
				tailAt: "2026-03-01T11:20:00.000Z",
				openedAt: "2026-03-01T11:15:00.000Z",
				reason: "resumed",
			},
			{
				...UNREADABLE,
				openedAt: "2026-03-01T12:00:00.000Z",
				reason: "created",
			},
		]);
		const build = runBuild(root);
		expect(build.exitCode).toBe(0);
		const window = summaryOf(build);
		expect(window).toMatchObject({
			drifting: 3,
			judged: { runs: 2, attributed: 1, resumed: 1 },
			unrecorded: { runs: 0, beforeRecord: 0, afterRecord: 0 },
			clockArtifact: 1,
			unexplained: 0,
			recordedWorkflows: 1,
		});
		// The alarm reads the same statement the query registers, so its own view of
		// the written dataset agrees with the summary.
		const report = inspectRunWindow(path.join(build.outDir, "dataset.sqlite"));
		expect(report.failures).toEqual([]);
		expect(report.rows.map((row) => row.drift_kind).sort()).toEqual([
			"attributed",
			"clock-artifact",
			"resumed",
		]);
		expect(
			report.rows.find((row) => row.run_id === "run-resumed")?.session_reason,
		).toBe("resumed");
		expect(report.recordedWorkflows).toEqual([WF]);
	});

	test("an opened-only record explains a resumed run whose tail follows its completion", () => {
		// The abort → resume path: the store clears `completed_at`, the dataset still
		// dates the completion at the last handoff, so the resumed turns look like a
		// tail of the same run. The `opened` record is the statement that they are
		// that run working on, and nothing may be judged as unexplained.
		const root = evidenceWith([
			{
				runId: "run-resumed-only",
				completedAt: "2026-03-01T11:10:00.000Z",
				tailAt: "2026-03-01T11:30:00.000Z",
				openedAt: "2026-03-01T11:12:00.000Z",
				reason: "resumed",
			},
		]);
		const build = runBuild(root);
		expect(build.exitCode).toBe(0);
		expect(summaryOf(build)).toMatchObject({
			drifting: 1,
			judged: { runs: 1, attributed: 0, resumed: 1 },
			unrecorded: { runs: 0, beforeRecord: 0, afterRecord: 0 },
			unexplained: 0,
		});
		const report = inspectRunWindow(path.join(build.outDir, "dataset.sqlite"));
		expect(report.failures).toEqual([]);
		expect(report.rows[0]).toMatchObject({
			drift_kind: "resumed",
			session_recorded: 1,
			session_reason: "resumed",
		});
	});

	test("an upgrade in progress: a run that began before the workflow's first record is counted, not failed", () => {
		// The shape of every workflow that straddles this change: the workflow has
		// begun recording (run-attributed's close), one drifting run predates that
		// first record and has none of its own, and one run's window cannot be read.
		// Neither the pre-record run nor the unreadable one may fail the build.
		const root = evidenceWith([ATTRIBUTED, BEFORE_RECORD, UNREADABLE]);
		const build = runBuild(root);
		expect(build.exitCode).toBe(0);
		expect(build.stderr).toBe("");
		const window = summaryOf(build);
		expect(window).toMatchObject({
			drifting: 3,
			judged: { runs: 1, attributed: 1, resumed: 0 },
			unrecorded: { runs: 1, beforeRecord: 1, afterRecord: 0 },
			clockArtifact: 1,
			unexplained: 1,
			recordedWorkflows: 1,
		});
		const report = inspectRunWindow(path.join(build.outDir, "dataset.sqlite"));
		expect(report.failures).toEqual([]);
		const before = report.rows.find(
			(row) => row.run_id === "run-before-record",
		);
		expect(before).toMatchObject({
			drift_kind: "unexplained",
			session_recorded: 0,
		});
		// …which is exactly the `>=` boundary: a run that begins at the very instant
		// of its workflow's first record is judged, and its missing record fails.
		const boundary = evidenceWith([
			ATTRIBUTED,
			{
				runId: "run-boundary",
				startedAt: "2026-03-01T10:11:00.000Z",
				completedAt: "2026-03-01T10:20:00.000Z",
				tailAt: "2026-03-01T10:30:00.000Z",
			},
		]);
		const second = runBuild(boundary);
		expect(second.exitCode).toBe(1);
		expect(second.stderr).toContain("run-boundary");
		expect(second.stderr).not.toContain("run run-attributed");
	});

	test("a binding the run's own completion predates does not explain its tail", () => {
		// The misattribution item 20 exists to refuse: the session went on under a
		// later run that this host cannot name (a handover across a host lifetime),
		// so the leaving run keeps only the `created` binding it got before it
		// closed. A binding is not a record of a continuation.
		const root = evidenceWith([
			ATTRIBUTED,
			{
				runId: "run-created-only",
				startedAt: "2026-03-01T10:15:00.000Z",
				completedAt: "2026-03-01T10:20:00.000Z",
				tailAt: "2026-03-01T10:40:00.000Z",
				openedAt: "2026-03-01T10:18:00.000Z",
				reason: "created",
			},
		]);
		const build = runBuild(root);
		expect(build.exitCode).toBe(1);
		expect(build.stderr).toContain("run-created-only");
		expect(build.stderr).not.toContain("run run-attributed");
	});

	test("the reason is the run's latest binding, and one after its completion explains the tail", () => {
		// A conversation bound twice to one run: `created` before the run's own
		// completion and `adopted` (a host restart re-bound it) after it. The later
		// move is what the column must report, and it is what makes the tail a
		// continuation rather than a lost record.
		const root = evidenceWith([
			ATTRIBUTED,
			{
				runId: "run-bound-twice",
				startedAt: "2026-03-01T10:05:00.000Z",
				completedAt: "2026-03-01T10:10:00.000Z",
				tailAt: "2026-03-01T10:30:00.000Z",
				openings: [
					{ at: "2026-03-01T10:04:00.000Z", reason: "created" },
					{ at: "2026-03-01T10:20:00.000Z", reason: "adopted" },
				],
			},
		]);
		const build = runBuild(root);
		expect(build.exitCode).toBe(0);
		const report = inspectRunWindow(path.join(build.outDir, "dataset.sqlite"));
		expect(report.failures).toEqual([]);
		expect(
			report.rows.find((row) => row.run_id === "run-bound-twice"),
		).toMatchObject({
			drift_kind: "resumed",
			session_reason: "adopted",
			session_opened_after_completion: 1,
		});
	});

	test("--json keeps its stdout parseable and states the build's age on stderr", () => {
		// The JSON output is what the parsers read, so the provenance line — the only
		// signal that an older file's zeros may be "not recorded yet" — belongs on
		// stderr instead of in front of the array.
		const root = evidenceWith([ATTRIBUTED]);
		const build = runBuild(root);
		expect(build.exitCode).toBe(0);
		const child = Bun.spawnSync(
			[
				process.execPath,
				ANALYZE,
				"run-window-drift",
				"--dataset",
				path.join(build.outDir, "dataset.sqlite"),
				"--json",
			],
			{ cwd: build.outDir, stdout: "pipe", stderr: "pipe" },
		);
		expect(child.exitCode).toBe(0);
		const rows: unknown = JSON.parse(child.stdout.toString());
		expect(Array.isArray(rows)).toBe(true);
		expect(child.stderr.toString()).toMatch(
			/^dataset .* built .* \(schema 4\)$/m,
		);
	});

	test("a dataset file an earlier build wrote is refused with the rebuild named", () => {
		// The columns this analysis reads are append-only within schema 4, so a file
		// written before them has no such column at all. Reading it must name the one
		// fix that exists instead of dying on `no such column`, and must not write to
		// it: the file stays exactly as it was found.
		const root = evidenceWith([ATTRIBUTED]);
		const build = runBuild(root);
		expect(build.exitCode).toBe(0);
		const stale = path.join(build.outDir, "stale.sqlite");
		fs.copyFileSync(path.join(build.outDir, "dataset.sqlite"), stale);
		const writer = new Database(stale, { readwrite: true });
		try {
			writer.run(
				"UPDATE meta SET value = '3' WHERE key = 'datasetSchemaVersion'",
			);
		} finally {
			writer.close();
		}
		// From here on the file must not change again: neither reader writes to it.
		const before = fs.statSync(stale);
		expect(() => inspectRunWindow(stale)).toThrow(
			/schema 3 .*reads 4.*rebuild/,
		);
		const child = Bun.spawnSync(
			[process.execPath, ANALYZE, "run-window-drift", "--dataset", stale],
			{ cwd: build.outDir, stdout: "pipe", stderr: "pipe" },
		);
		expect(child.exitCode).toBe(2);
		expect(child.stderr.toString()).toContain("rebuild");
		const after = fs.statSync(stale);
		expect(after.size).toBe(before.size);
		expect(after.mtimeMs).toBe(before.mtimeMs);
	});
});
