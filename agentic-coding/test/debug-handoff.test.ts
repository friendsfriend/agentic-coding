// The debug family's handoff, driven through the engine and the real
// `workspace.setup` handler (`add-debug-workflow`, tasks 3.2 and 2.1): the
// detached worktree is selected from the `branch` start requirement, a
// completed `debug.investigate` handoff writes the report and the
// `changes.patch` evidence entry, a report missing a required heading is
// refused before the transaction, and a replayed complete is rejected without
// touching the committed artifacts.
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import type {
	ResolvedProfile,
	WorkflowRouting,
} from "../src/contracts/workflow.ts";
import { DEBUG_REPORT_HEADINGS } from "../src/workflow/definitions/contracts.ts";
import { definitionVersionForFamilyTraits } from "../src/workflow/definitions/manifest-policy.ts";
import { registerBuiltins } from "../src/workflow/definitions.ts";
import {
	agentEffectHandlers,
	EffectRunner,
} from "../src/workflow/effect-runner.ts";
import { WorkflowEngine } from "../src/workflow/runtime.ts";
import type {
	WorktreeEnsureInput,
	WorktreePort,
} from "../src/worktree/port.ts";
import {
	autoRemoveRepoFixtures,
	createTempRepoFixture,
} from "./support/git-fixture.ts";

autoRemoveRepoFixtures();

function requireDefined<T>(value: T | null | undefined, what: string): T {
	if (value === undefined || value === null)
		throw new Error(`expected ${what} to exist`);
	return value;
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const profile: ResolvedProfile = {
	name: "fake",
	runtime: "pi-durable",
	executable: process.execPath,
	tools: [],
	extensions: [],
	readOnly: false,
	capabilities: ["prompt", "run-environment", "observe", "shell", "edit"],
	digest: "fake",
};

const routing: WorkflowRouting = {
	defaultProfile: "fake",
	routes: [{ stepId: "debug.investigate", role: "debug", profile }],
};

function reportMarkdown(missing?: string): string {
	return DEBUG_REPORT_HEADINGS.filter((heading) => heading !== missing)
		.map((heading) => `# ${heading}\n\ncontent`)
		.join("\n\n");
}

/** A worktree port that records every `ensure` and returns the repository
 * itself as the detached worktree path, so the handoff's patch runs against a
 * real checkout without creating one outside the temp root. */
function recordingPort(
	root: string,
	calls: WorktreeEnsureInput[],
): WorktreePort {
	return {
		list: () => Effect.succeed([]),
		find: () => Effect.succeed(undefined),
		ensure: (input) => {
			calls.push(input);
			return Effect.succeed({
				path: root,
				branch: "",
				isMain: false,
				detached: true,
				created: true,
			});
		},
		remove: () => Effect.void,
	};
}

/** Start a debug workflow, run its `workspace.setup` through the real handler
 * with a recording worktree port, advance its routing step to
 * `debug.investigate`, and return the agent run and its launch capability. */
async function startInvestigation(
	engine: WorkflowEngine,
	root: string,
	workflowId: string,
): Promise<{
	runId: string;
	outputPath: string;
	token: string;
	ensureCalls: WorktreeEnsureInput[];
}> {
	const ensureCalls: WorktreeEnsureInput[] = [];
	engine.start({
		repo: root,
		mode: "worktree",
		workflowId,
		definitionId: "debug",
		definitionVersion: definitionVersionForFamilyTraits(6),
		metadata: {
			branch: "main",
			baseBranch: "main",
			baseCommit: git(root, ["rev-parse", "HEAD"]),
			task: "reproduce the bug",
		},
		routing,
	});
	const registry = registerBuiltins();
	const runner = new EffectRunner(
		root,
		engine,
		agentEffectHandlers(root, engine, {
			registry,
			adapters: new Map(),
			worktree: recordingPort(root, ensureCalls),
		}),
	);
	// One effect only: the workspace setup, so the routing pass is still pending.
	await runner.drain(1);
	// The `branch` requirement selected the detached path: the port was asked to
	// create a **detached** worktree at the selected branch.
	expect(ensureCalls.map((call) => call.detached)).toEqual([true]);
	expect(ensureCalls[0]?.branch).toBe("main");
	const classify = engine
		.claimEffects(root, 100)
		.find((effect) => effect.kind === "model.classify");
	if (classify)
		engine.dispatch(root, {
			type: "effect.result",
			effectId: classify.id,
			lease: requireDefined(classify.lease, "classify lease"),
			outcome: "complete",
			data: { integration: "routing", phase: "apply", answers: {} },
		});
	const view = engine.status(root, workflowId);
	expect(view.currentStep.id).toBe("debug.investigate");
	const runId = requireDefined(view.runs[0]?.id, "debug run");
	const run = engine.getRun(root, runId);
	const launch = requireDefined(
		engine
			.claimEffects(root, 100)
			.find((effect) => effect.kind === "agent.launch"),
		"launch effect",
	);
	return {
		runId,
		outputPath: requireDefined(run.outputPath, "output path"),
		token: requireDefined(launch.runToken, "run token"),
		ensureCalls,
	};
}

function writeArtifact(
	outputPath: string,
	runId: string,
	report: string,
): void {
	fs.mkdirSync(path.dirname(outputPath), { recursive: true });
	fs.writeFileSync(
		outputPath,
		JSON.stringify({
			runId,
			schemaId: "core.debug-report",
			schemaVersion: 1,
			payload: { report },
		}),
	);
}

/** After a committed investigation, request a follow-up from the review gate and
 * advance the new round to `debug.investigate`, returning its active run. */
function startFollowUp(
	engine: WorkflowEngine,
	root: string,
	workflowId: string,
): { runId: string; outputPath: string; token: string } {
	const review = engine.status(root, workflowId);
	engine.dispatch(root, {
		type: "developer.action",
		workflowId,
		revision: review.revision,
		actionId: "review-comments",
		input: { comments: [{ comment: "dig deeper into the empty result" }] },
	});
	const classify = engine
		.claimEffects(root, 100)
		.find((effect) => effect.kind === "model.classify");
	if (classify)
		engine.dispatch(root, {
			type: "effect.result",
			effectId: classify.id,
			lease: requireDefined(classify.lease, "classify lease"),
			outcome: "complete",
			data: { integration: "routing", phase: "apply", answers: {} },
		});
	const view = engine.status(root, workflowId);
	expect(view.currentStep.id).toBe("debug.investigate");
	const runId = requireDefined(
		view.runs.find((run) => run.status !== "completed")?.id,
		"follow-up run",
	);
	const run = engine.getRun(root, runId);
	const launch = requireDefined(
		engine
			.claimEffects(root, 100)
			.find((effect) => effect.kind === "agent.launch"),
		"launch effect",
	);
	return {
		runId,
		outputPath: requireDefined(run.outputPath, "output path"),
		token: requireDefined(launch.runToken, "run token"),
	};
}

test("a completed debug handoff writes the report and patch evidence", async () => {
	const root = createTempRepoFixture("debug-handoff-", {
		files: { "README.md": "test\n" },
		excludeWorkflowState: true,
	});
	const workflowId = "debug-handoff";
	const engine = new WorkflowEngine(registerBuiltins());
	try {
		const { runId, outputPath, token } = await startInvestigation(
			engine,
			root,
			workflowId,
		);
		// A probe the agent wrote; the handoff must preserve it as a patch.
		fs.writeFileSync(path.join(root, "probe.txt"), "probe\n");
		const report = reportMarkdown();
		writeArtifact(outputPath, runId, report);
		const completed = engine.dispatch(root, {
			type: "agent.handoff",
			runId,
			generation: 1,
			token,
			outcome: "complete",
			artifact: outputPath,
		});
		expect(completed.view.currentStep.id).toBe("debug.review");
		// Both artifacts land in the repository's data root, outside the detached
		// worktree that cleanup removes. The engine realpaths the repository, so the
		// expected directory does too.
		const directory = path.join(
			fs.realpathSync(root),
			".herdr-workflow",
			workflowId,
		);
		expect(
			fs.readFileSync(path.join(directory, "debug-report.md"), "utf8"),
		).toBe(`${report.trim()}\n`);
		const patch = fs.readFileSync(
			path.join(directory, "changes.patch"),
			"utf8",
		);
		expect(patch).toContain("probe.txt");
		const evidence = engine.getSnapshot(root, workflowId).evidence;
		expect(evidence.some((entry) => entry.kind === "debug:report")).toBe(true);
		const patchEntry = evidence.find(
			(entry) => entry.kind === "debug:changes.patch",
		);
		expect(patchEntry?.path).toBe(path.join(directory, "changes.patch"));
		// A replayed complete is refused as stale before any write, so the
		// committed artifact keeps its bytes.
		const before = fs.readFileSync(
			path.join(directory, "changes.patch"),
			"utf8",
		);
		fs.writeFileSync(path.join(root, "later.txt"), "later\n");
		writeArtifact(outputPath, runId, report);
		expect(() =>
			engine.dispatch(root, {
				type: "agent.handoff",
				runId,
				generation: 1,
				token,
				outcome: "complete",
				artifact: outputPath,
			}),
		).toThrow();
		expect(fs.readFileSync(path.join(directory, "changes.patch"), "utf8")).toBe(
			before,
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("a follow-up round replaces the evidence entry instead of duplicating it", async () => {
	const root = createTempRepoFixture("debug-handoff-followup-", {
		files: { "README.md": "test\n" },
		excludeWorkflowState: true,
	});
	const workflowId = "debug-handoff-followup";
	const engine = new WorkflowEngine(registerBuiltins());
	try {
		const first = await startInvestigation(engine, root, workflowId);
		fs.writeFileSync(path.join(root, "probe.txt"), "first\n");
		writeArtifact(first.outputPath, first.runId, reportMarkdown());
		engine.dispatch(root, {
			type: "agent.handoff",
			runId: first.runId,
			generation: 1,
			token: first.token,
			outcome: "complete",
			artifact: first.outputPath,
		});
		// A second round with a fresh report and a new edit.
		const second = startFollowUp(engine, root, workflowId);
		fs.writeFileSync(path.join(root, "probe.txt"), "second\n");
		const secondReport = `${reportMarkdown()}\n\n# Summary\nsecond round`;
		writeArtifact(second.outputPath, second.runId, secondReport);
		const completed = engine.dispatch(root, {
			type: "agent.handoff",
			runId: second.runId,
			generation: engine.getRun(root, second.runId).generation,
			token: second.token,
			outcome: "complete",
			artifact: second.outputPath,
		});
		expect(completed.view.currentStep.id).toBe("debug.review");
		// One stable path per artifact: the follow-up's entry replaces round one's
		// rather than leaving a stale duplicate that resolves to the new bytes.
		const evidence = engine.getSnapshot(root, workflowId).evidence;
		const reports = evidence.filter((entry) => entry.kind === "debug:report");
		const patches = evidence.filter(
			(entry) => entry.kind === "debug:changes.patch",
		);
		expect(reports).toHaveLength(1);
		expect(patches).toHaveLength(1);
		const directory = path.join(
			fs.realpathSync(root),
			".herdr-workflow",
			workflowId,
		);
		expect(reports[0]?.path).toBe(path.join(directory, "debug-report.md"));
		for (const entry of [...reports, ...patches]) {
			const content = fs.readFileSync(entry.path);
			expect(createHash("sha256").update(content).digest("hex")).toBe(
				entry.digest,
			);
		}
		expect(
			fs.readFileSync(path.join(directory, "changes.patch"), "utf8"),
		).toContain("second");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("a report missing a required heading is refused before the transaction", async () => {
	const root = createTempRepoFixture("debug-handoff-bad-", {
		files: { "README.md": "test\n" },
		excludeWorkflowState: true,
	});
	const workflowId = "debug-handoff-bad";
	const engine = new WorkflowEngine(registerBuiltins());
	try {
		const { runId, outputPath, token } = await startInvestigation(
			engine,
			root,
			workflowId,
		);
		writeArtifact(outputPath, runId, reportMarkdown("Findings"));
		expect(() =>
			engine.dispatch(root, {
				type: "agent.handoff",
				runId,
				generation: 1,
				token,
				outcome: "complete",
				artifact: outputPath,
			}),
		).toThrow(/Findings/);
		// The workflow stayed on the investigation step and nothing was written.
		expect(engine.status(root, workflowId).currentStep.id).toBe(
			"debug.investigate",
		);
		expect(
			fs.existsSync(
				path.join(root, ".herdr-workflow", workflowId, "debug-report.md"),
			),
		).toBe(false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
