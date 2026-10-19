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
	/** The session window's `closed` record for this run, when the recording
	 * states that its session went on under another run. */
	readonly closedAt?: string;
	/** The session window's `opened` record for this run: the run kept (or
	 * resumed) its own conversation, which is the record a resumed run has. */
	readonly openedAt?: string;
	/** Why the run was bound, when the recording says so (`created`, `rebound`,
	 * `adopted`, `resumed`). */
	readonly reason?: string;
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
			: new Date(Date.parse(run.completedAt) - 600_000).toISOString();
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
		// is due, because the whole workflow predates the record.
		expect(window).toMatchObject({
			drifting: 3,
			judged: { runs: 0, attributed: 0, resumed: 0 },
			unrecorded: { runs: 3, beforeRecord: 3, afterRecord: 0 },
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
			judged: { runs: 3, attributed: 1, resumed: 1 },
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
});
