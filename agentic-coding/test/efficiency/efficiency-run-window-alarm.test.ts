// Item 20 of the efficiency backlog (run-window-integrity): the build's
// run-window alarm.
//
// A run's window is the engine's; its session's window is the durable host's,
// and a session outlives the run. The build therefore refuses a dataset in which
// a run carries turns after its own recorded completion and nothing in the
// recording explains them — but only for a workflow whose own recording states a
// session window, because a generation that predates the record (the whole
// pinned snapshot) cannot say anything about it.
//
// The evidence here is a fixture snapshot plus one synthetic telemetry file, and
// the build runs as a child process, exactly as a developer runs it.

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
		const opened = run.unreadableWindow
			? "2026-03-01T12:00:00.000Z"
			: new Date(Date.parse(run.completedAt) - 600_000).toISOString();
		if (!run.unreadableWindow)
			lines.push(envelope("runtime.turn_started", opened, run.runId));
		lines.push(
			envelope("agent.handoff", run.completedAt, run.runId, {
				"herdr.handoff.outcome": "complete",
			}),
		);
		lines.push(envelope("runtime.turn_started", run.tailAt, run.runId));
		if (run.closedAt !== undefined)
			lines.push(
				envelope("runtime.session_window.closed", run.closedAt, run.runId, {
					sessionId: `conv-${run.runId}`,
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
	test("an unexplained tail in a recorded workflow fails the build", () => {
		const root = evidenceWith([ATTRIBUTED, UNEXPLAINED, UNREADABLE]);
		const build = runBuild(root);
		// The workflow's own recording states a session window (run-attributed), so
		// its unexplained tail is a defect rather than an unrecorded generation.
		expect(build.exitCode).toBe(1);
		expect(build.stderr).toContain("run-unexplained");
		expect(build.stderr).toContain(WF);
		expect(build.stderr).toContain("run-window-drift");
		// The recording explained the first run and cannot read the third, so
		// neither of them is named as a failure.
		expect(build.stderr).not.toContain("run run-attributed");
		expect(build.stderr).not.toContain("run run-clock");
		// No dataset and no README are left behind.
		expect(fs.existsSync(path.join(build.outDir, "dataset.sqlite"))).toBe(
			false,
		);
		expect(fs.existsSync(path.join(build.outDir, "README.md"))).toBe(false);
	});

	test("a generation that predates the record is reported unrecorded and still builds", () => {
		// Not one session-window event anywhere: the pinned snapshot's shape.
		const root = evidenceWith([
			{ ...ATTRIBUTED, closedAt: undefined },
			UNEXPLAINED,
			UNREADABLE,
		]);
		const build = runBuild(root);
		expect(build.exitCode).toBe(0);
		const summary = JSON.parse(build.stdout) as {
			runWindow: Record<string, number>;
		};
		// All three drifting runs are counted, and none of them is judged.
		expect(summary.runWindow.unrecorded).toBe(3);
		expect(summary.runWindow.judged).toBe(0);
		expect(summary.runWindow.clockArtifact).toBe(1);
		expect(summary.runWindow.unexplained).toBe(2);
		expect(fs.existsSync(path.join(build.outDir, "dataset.sqlite"))).toBe(true);
	});

	test("attributed and clock-artifact tails pass a recorded workflow", () => {
		const root = evidenceWith([ATTRIBUTED, UNREADABLE]);
		const build = runBuild(root);
		expect(build.exitCode).toBe(0);
		const summary = JSON.parse(build.stdout) as {
			runWindow: Record<string, number>;
		};
		expect(summary.runWindow).toMatchObject({
			drifting: 2,
			judged: 2,
			attributed: 1,
			clockArtifact: 1,
			unexplained: 0,
			unrecorded: 0,
		});
		// The alarm reads the same statement the query registers, so its own view of
		// the written dataset agrees with the summary.
		const report = inspectRunWindow(path.join(build.outDir, "dataset.sqlite"));
		expect(report.failures).toEqual([]);
		expect(report.rows.map((row) => row.drift_kind).sort()).toEqual([
			"attributed",
			"clock-artifact",
		]);
		expect(report.attributed).toBe(1);
		expect(report.recordedWorkflows).toEqual([WF]);
	});
});
