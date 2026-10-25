// A developer abort parks a run `blocked` (`agentic-coding workflow handoff
// --outcome blocked --aborted`); the developer's next message reopens it
// (`agentic-coding workflow resume-run` -> the `agent.resume` reducer). These
// tests pin the durable half of that transition: only an aborted run is
// reopenable, and a run that parked itself stays parked.

import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
	DEVELOPER_ABORT_MESSAGE,
	type ResolvedProfile,
	type WorkflowRouting,
} from "../src/contracts/workflow.ts";
import * as caller from "../src/workflow/cli/caller-environment.ts";
import { runResumeRun } from "../src/workflow/cli/commands/dispatch-actions.ts";
import { registerBuiltins } from "../src/workflow/definitions.ts";
import { agentRunEnvironmentFile } from "../src/workflow/run-env.ts";
import { canonicalStorePath, WorkflowEngine } from "../src/workflow/runtime.ts";
import {
	autoRemoveRepoFixtures,
	createTempRepoFixture,
	repoPreset,
} from "./support/git-fixture.ts";

autoRemoveRepoFixtures();

function requireDefined<T>(value: T | null | undefined, what: string): T {
	if (value === undefined || value === null)
		throw new Error(`expected ${what} to exist`);
	return value;
}

const profile: ResolvedProfile = {
	name: "fake",
	runtime: "pi-durable",
	executable: process.execPath,
	tools: [],
	extensions: [],
	readOnly: false,
	capabilities: ["prompt", "run-environment", "observe"],
	digest: "fake",
};
const routing: WorkflowRouting = {
	defaultProfile: "fake",
	routes: ["core.plan", "core.implementation", "core.triage"].map((stepId) => ({
		stepId,
		profile,
	})),
};

interface Started {
	readonly engine: WorkflowEngine;
	readonly repo: string;
	readonly runId: string;
	readonly stepId: string;
	readonly role: string;
	readonly generation: number;
	readonly token: string;
}

/** One started `no-openspec` workflow whose single run holds a launch-bound
 * capability. */
function startedRun(): Started {
	const repo = createTempRepoFixture("agent-resume-", repoPreset.readme);
	const engine = new WorkflowEngine(
		registerBuiltins(),
		() => new Date("2026-01-01T00:00:00Z"),
	);
	const started = engine.start({
		repo,
		workflowId: "change",
		definitionId: "no-openspec",
		metadata: {
			branch: "main",
			baseBranch: "main",
			baseCommit: "base",
			task: "task",
		},
		routing,
	});
	const run = requireDefined(started.view.runs[0], "first run");
	const token = requireDefined(
		engine
			.claimEffects(repo, 100)
			.find((effect) => effect.kind === "agent.launch")?.runToken,
		"run token",
	);
	// The view omits `generation`; the run row is what a handoff names.
	const launched = engine.getRun(repo, run.id);
	return {
		engine,
		repo,
		runId: run.id,
		stepId: launched.stepId,
		role: launched.role,
		generation: launched.generation,
		token,
	};
}

/** Park one run as a developer abort: exactly what the durable host records
 * when the developer aborts a live session. */
function abort(started: Started): void {
	started.engine.dispatch(started.repo, {
		type: "agent.handoff",
		runId: started.runId,
		generation: started.generation,
		token: started.token,
		outcome: "blocked",
		aborted: true,
		message: DEVELOPER_ABORT_MESSAGE,
	});
}

/** Write the step's output artifact, so a run can hand off `complete`. */
function writeArtifact(started: Started): string {
	const run = started.engine.getRun(started.repo, started.runId);
	const outputPath = requireDefined(run.outputPath, "output path");
	fs.mkdirSync(path.dirname(outputPath), { recursive: true });
	fs.writeFileSync(
		outputPath,
		JSON.stringify({
			runId: run.id,
			schemaId: run.outputSchema?.id,
			schemaVersion: run.outputSchema?.version,
			payload: { changed: true },
		}),
	);
	return outputPath;
}

function resume(started: Started) {
	return started.engine.dispatch(started.repo, {
		type: "agent.resume",
		workflowId: "change",
		runId: started.runId,
		stepId: started.stepId,
		role: started.role,
		token: started.token,
	});
}

test("an aborted run reopens for the developer's next message and hands off again", () => {
	const started = startedRun();
	const { engine, repo } = started;
	abort(started);
	expect(engine.status(repo, "change").status).toBe("attention-required");
	expect(engine.getRun(repo, started.runId).status).toBe("blocked");
	expect(engine.getSnapshot(repo, "change").attention).toEqual([
		DEVELOPER_ABORT_MESSAGE,
	]);
	expect(engine.getSnapshot(repo, "change").step.activeRunIds).toEqual([]);

	const resumed = resume(started);
	expect(resumed.view.status).toBe("active");
	// The transition is a durable, recorded event, not an ad hoc edit.
	const event = new Database(canonicalStorePath(repo))
		.query(
			"SELECT type, data_json FROM workflow_events ORDER BY revision DESC LIMIT 1",
		)
		.get() as { type: string; data_json: string };
	expect(event.type).toBe("agent.resumed");
	expect(JSON.parse(event.data_json)).toMatchObject({
		runId: started.runId,
		stepId: started.stepId,
		role: started.role,
	});
	expect(engine.getRun(repo, started.runId).status).toBe("working");
	const snapshot = engine.getSnapshot(repo, "change");
	expect(snapshot.attention).toEqual([]);
	expect(snapshot.step.activeRunIds).toEqual([started.runId]);
	expect(snapshot.step.completedRunIds).not.toContain(started.runId);

	// The reopened run still owns its launch-bound capability: the handoff at
	// the end of its (continued) turn works exactly as before the abort.
	const outputPath = writeArtifact(started);
	const completed = engine.dispatch(repo, {
		type: "agent.handoff",
		runId: started.runId,
		generation: started.generation,
		token: started.token,
		outcome: "complete",
		artifact: outputPath,
	});
	expect(completed.view.currentStep.id).toBe("core.triage");
});

test("a run that parked itself is not reopened by an unrelated message", () => {
	const started = startedRun();
	const { engine, repo } = started;
	engine.dispatch(repo, {
		type: "agent.handoff",
		runId: started.runId,
		generation: started.generation,
		token: started.token,
		outcome: "blocked",
		message: "need a decision",
	});
	const revision = engine.getSnapshot(repo, "change").revision;
	expect(() => resume(started)).toThrow(/not parked by a developer abort/);
	expect(engine.getSnapshot(repo, "change").revision).toBe(revision);
	expect(engine.status(repo, "change").status).toBe("attention-required");
	expect(engine.getSnapshot(repo, "change").attention).toEqual([
		"need a decision",
	]);
	expect(engine.getRun(repo, started.runId).status).toBe("blocked");
});

test("a finished run is not reopened", () => {
	const started = startedRun();
	const { engine, repo } = started;
	const outputPath = writeArtifact(started);
	engine.dispatch(repo, {
		type: "agent.handoff",
		runId: started.runId,
		generation: started.generation,
		token: started.token,
		outcome: "complete",
		artifact: outputPath,
	});
	const revision = engine.getSnapshot(repo, "change").revision;
	expect(() => resume(started)).toThrow(/not parked by a developer abort/);
	expect(engine.getSnapshot(repo, "change").revision).toBe(revision);
	expect(engine.getRun(repo, started.runId).status).toBe("completed");
});

test("a stamped-but-forged capability cannot reopen a parked run", () => {
	const started = startedRun();
	const { engine, repo } = started;
	abort(started);
	const revision = engine.getSnapshot(repo, "change").revision;
	expect(() =>
		engine.dispatch(repo, {
			type: "agent.resume",
			workflowId: "change",
			runId: started.runId,
			stepId: started.stepId,
			role: started.role,
			token: "forged",
		}),
	).toThrow(/capability/);
	expect(engine.getSnapshot(repo, "change").revision).toBe(revision);
	expect(engine.getRun(repo, started.runId).status).toBe("blocked");
});

test("a capability cannot reopen a run it is not the capability of", () => {
	const started = startedRun();
	const { engine, repo } = started;
	abort(started);
	const revision = engine.getSnapshot(repo, "change").revision;
	for (const [stepId, role] of [
		[started.stepId, "somebody-else"],
		["core.triage", started.role],
	]) {
		expect(() =>
			engine.dispatch(repo, {
				type: "agent.resume",
				workflowId: "change",
				runId: started.runId,
				stepId: stepId as string,
				role: role as string,
				token: started.token,
			}),
		).toThrow(/does not match caller/);
	}
	expect(engine.getSnapshot(repo, "change").revision).toBe(revision);
	expect(engine.getRun(repo, started.runId).status).toBe("blocked");
});

/** The environment one managed run carries: what `resume-run` resolves its own
 * identity and capability from. */
function asManagedRun(started: Started): () => void {
	// Linux authenticates launch identity from /proc, not mutable process.env.
	// Supply only this fixture's caller at the boundary; never read/use the
	// implementation or verifier run's live capability for a test command.
	const identity = spyOn(caller, "callerEnvironment").mockReturnValue({
		HERDR_WORKFLOW_TARGET: started.repo,
		HERDR_WORKFLOW_ID: "change",
		HERDR_RUN_ID: started.runId,
		HERDR_STEP_ID: started.stepId,
		HERDR_ROLE: started.role,
		HERDR_RUN_TOKEN: started.token,
	});
	return () => identity.mockRestore();
}

/** Capture what one `resume-run` invocation printed (its one JSON line). */
function printedView(run: () => void): Record<string, unknown> {
	const printed: string[] = [];
	const log = console.log;
	console.log = (...args: unknown[]) => {
		printed.push(args.map((arg) => String(arg)).join(" "));
	};
	try {
		run();
	} finally {
		console.log = log;
	}
	const line = printed.at(-1);
	return line === undefined
		? {}
		: (JSON.parse(line) as Record<string, unknown>);
}

test("resume-run reports the run's state and reopens the parked one", () => {
	const started = startedRun();
	const restoreEnvironment = asManagedRun(started);
	try {
		// A live run: nothing to reconcile, and no revision is spent on it.
		const revision = started.engine.getSnapshot(
			started.repo,
			"change",
		).revision;
		expect(
			printedView(() =>
				runResumeRun([], started.engine, undefined, started.repo),
			).state,
		).toBe("active");
		expect(started.engine.getSnapshot(started.repo, "change").revision).toBe(
			revision,
		);

		abort(started);
		const resumed = printedView(() =>
			runResumeRun([], started.engine, undefined, started.repo),
		);
		expect(resumed).toMatchObject({
			state: "resumed",
			runId: started.runId,
			workflowId: "change",
			stepId: started.stepId,
			role: started.role,
		});
		expect(started.engine.getRun(started.repo, started.runId).status).toBe(
			"working",
		);
		expect(started.engine.status(started.repo, "change").status).toBe("active");

		// A park recorded before the abort marker: the command attempts the
		// reopen and the reducer verifies the launch token against the run's own
		// environment file.
		preMarkerPark(started);
		expect(
			printedView(() =>
				runResumeRun([], started.engine, undefined, started.repo),
			).state,
		).toBe("blocked");
		writeLaunchEnvironment(started);
		expect(
			printedView(() =>
				runResumeRun([], started.engine, undefined, started.repo),
			).state,
		).toBe("resumed");

		// A park the run made itself is reported, never cleared: only an abort
		// parks a run the developer may reopen.
		started.engine.dispatch(started.repo, {
			type: "agent.handoff",
			runId: started.runId,
			generation: started.generation,
			token: started.token,
			outcome: "blocked",
			message: "need a decision",
		});
		expect(
			printedView(() =>
				runResumeRun([], started.engine, undefined, started.repo),
			).state,
		).toBe("blocked");
		expect(started.engine.status(started.repo, "change").status).toBe(
			"attention-required",
		);
	} finally {
		restoreEnvironment();
	}
});

/** The launch environment the launcher writes for one run: the only credential
 * a park recorded before the abort marker existed can be verified against. */
function writeLaunchEnvironment(started: Started): string {
	const file = agentRunEnvironmentFile({
		worktree: started.engine.getSnapshot(started.repo, "change").metadata
			.worktree,
		definitionId: "no-openspec",
		workflowId: "change",
		runId: started.runId,
	});
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(
		file,
		`HERDR_RUN_ID='${started.runId}'\nHERDR_RUN_TOKEN='${started.token}'\n`,
	);
	return file;
}

/** Park one run the way the build that predates the abort marker did: the
 * blocked handoff clears the capability and only the abort message remains. */
function preMarkerPark(started: Started): void {
	started.engine.dispatch(started.repo, {
		type: "agent.handoff",
		runId: started.runId,
		generation: started.generation,
		token: started.token,
		outcome: "blocked",
		message: DEVELOPER_ABORT_MESSAGE,
	});
}

test("a park recorded before the abort marker reopens with the run's own launch token", () => {
	const started = startedRun();
	const { engine, repo } = started;
	preMarkerPark(started);
	expect(engine.getRun(repo, started.runId).capabilityHash).toBe("");
	const revision = engine.getSnapshot(repo, "change").revision;
	// Without the run's launch environment there is nothing to verify, so the
	// park stays parked instead of reopening for any caller.
	expect(() => resume(started)).toThrow(/not parked by a developer abort/);
	expect(engine.getSnapshot(repo, "change").revision).toBe(revision);

	writeLaunchEnvironment(started);
	const resumed = resume(started);
	expect(resumed.view.status).toBe("active");
	expect(engine.getRun(repo, started.runId).status).toBe("working");
	// The launch token is bound as the reopened run's capability, so the
	// continued turn can hand off like any other.
	expect(engine.getRun(repo, started.runId).capabilityHash).not.toBe("");
	const outputPath = writeArtifact(started);
	expect(
		engine.dispatch(repo, {
			type: "agent.handoff",
			runId: started.runId,
			generation: started.generation,
			token: started.token,
			outcome: "complete",
			artifact: outputPath,
		}).view.currentStep.id,
	).toBe("core.triage");
});

test("another token cannot reopen a pre-marker park", () => {
	const started = startedRun();
	const { engine, repo } = started;
	preMarkerPark(started);
	writeLaunchEnvironment(started);
	const revision = engine.getSnapshot(repo, "change").revision;
	expect(() =>
		engine.dispatch(repo, {
			type: "agent.resume",
			workflowId: "change",
			runId: started.runId,
			stepId: started.stepId,
			role: started.role,
			token: "forged",
		}),
	).toThrow(/not parked by a developer abort/);
	expect(engine.getSnapshot(repo, "change").revision).toBe(revision);
	expect(engine.getRun(repo, started.runId).status).toBe("blocked");
});
