// The archive step's bounded repair loop (`bound-archive-repair-loop`): one
// archive entry gets at most `ARCHIVE_ATTEMPT_LIMIT` `openspec validate`/
// `archive` attempts (the entry itself plus one structural repair round). The
// second failure parks the workflow with the run's own validator output —
// bounded and redacted — and no third run is launched until a developer repairs
// or resumes the workflow, which grants a fresh pair.
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type {
	ResolvedProfile,
	WorkflowRouting,
	WorkflowSnapshot,
	WorkflowView,
} from "../src/contracts/workflow.ts";
import { registerBuiltins } from "../src/workflow/definitions.ts";
import { WorkflowEngine } from "../src/workflow/runtime.ts";
import { stepBehavior } from "../src/workflow/steps/index.ts";
import {
	ARCHIVE_ATTEMPT_KEY,
	ARCHIVE_ATTEMPT_LIMIT,
} from "../src/workflow/steps/lifecycle.ts";
import type {
	AgentCompletionContext,
	AssignmentInputsContext,
} from "../src/workflow/steps/types.ts";
import {
	autoRemoveRepoFixtures,
	createTempRepoFixture,
	repoPreset,
} from "./support/git-fixture.ts";

// Sweep the repositories this file created, at the end of this file only.
autoRemoveRepoFixtures();

const CHANGE_ID = "openspec-apply";

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
	routes: [
		"core.implementation",
		"core.triage",
		"core.verification",
		"core.archive",
	].map((stepId) => ({ stepId, profile })),
};

function repo(): string {
	return createTempRepoFixture("archive-attempts-", repoPreset.openspec);
}

function launchToken(
	engine: WorkflowEngine,
	root: string,
	runId: string,
): string {
	const effect = engine
		.claimEffects(root, 100)
		.find(
			(item) =>
				item.kind === "agent.launch" &&
				(item.payload as { runId?: string }).runId === runId,
		);
	if (!effect?.runToken) throw new Error(`missing launch token for ${runId}`);
	return effect.runToken;
}

function pendingRun(view: WorkflowView, role: string) {
	const summary = view.runs.find(
		(run) => run.role === role && ["pending", "working"].includes(run.status),
	);
	if (!summary) throw new Error(`missing ${role} run`);
	return summary;
}

function complete(
	engine: WorkflowEngine,
	root: string,
	view: WorkflowView,
	role: string,
	payload: unknown,
	runToken?: string,
): WorkflowView {
	const summary = pendingRun(view, role);
	const run = engine.getRun(root, summary.id);
	const token = runToken ?? launchToken(engine, root, run.id);
	fs.mkdirSync(path.dirname(requireDefined(run.outputPath, "output path")), {
		recursive: true,
	});
	fs.writeFileSync(
		requireDefined(run.outputPath, "output path"),
		JSON.stringify({
			runId: run.id,
			schemaId: run.outputSchema?.id,
			schemaVersion: run.outputSchema?.version,
			payload,
		}),
	);
	return engine.dispatch(root, {
		type: "agent.handoff",
		runId: run.id,
		generation: run.generation,
		token,
		outcome: "complete",
		artifact: run.outputPath,
	}).view;
}

/** The archive attempt's own failure report: no artifact, only the message the
 * engine keeps as the attempt's result. */
function blockArchive(
	engine: WorkflowEngine,
	root: string,
	view: WorkflowView,
	message: string,
): WorkflowView {
	const summary = pendingRun(view, "archive");
	const run = engine.getRun(root, summary.id);
	return engine.dispatch(root, {
		type: "agent.handoff",
		runId: run.id,
		generation: run.generation,
		token: launchToken(engine, root, run.id),
		outcome: "blocked",
		message,
	}).view;
}

function action(
	engine: WorkflowEngine,
	root: string,
	view: WorkflowView,
	actionId: string,
	input?: unknown,
): WorkflowView {
	return engine.dispatch(root, {
		type: "developer.action",
		workflowId: view.workflowId,
		revision: view.revision,
		actionId,
		...(input === undefined ? {} : { input }),
	}).view;
}

/** Complete the pinned classifier routing pass so the graph reaches its first
 * agent step. */
function advanceRouting(
	engine: WorkflowEngine,
	root: string,
	view: WorkflowView,
): WorkflowView {
	const classify = engine
		.claimEffects(root, 100)
		.find((effect) => effect.kind === "model.classify");
	if (!classify) return view;
	const phase =
		(classify.payload as { phase?: string }).phase === "apply"
			? "apply"
			: "plan";
	return engine.dispatch(root, {
		type: "effect.result",
		effectId: classify.id,
		lease: requireDefined(classify.lease, "classify lease"),
		outcome: "complete",
		data: { integration: "routing", phase, answers: {} },
	}).view;
}

/** Drive a real openspec-apply workflow to its archive entry. The wiki variants
 * are left out on purpose: this file is about the archive budget, not the wiki
 * gate. */
function reachArchive(engine: WorkflowEngine, root: string): WorkflowView {
	const change = `${root}/openspec/changes/${CHANGE_ID}`;
	fs.mkdirSync(`${change}/specs/feature`, { recursive: true });
	fs.writeFileSync(`${change}/proposal.md`, "proposal\n");
	fs.writeFileSync(`${change}/design.md`, "design\n");
	fs.writeFileSync(`${change}/tasks.md`, "- [ ] task\n");
	fs.writeFileSync(`${change}/specs/feature/spec.md`, "#### Scenario: works\n");
	execFileSync("git", ["add", "."], { cwd: root });
	execFileSync(
		"git",
		[
			"-c",
			"user.email=test@example.com",
			"-c",
			"user.name=Test",
			"commit",
			"-qm",
			"plan",
		],
		{ cwd: root },
	);
	let view = engine.start({
		repo: root,
		workflowId: CHANGE_ID,
		definitionId: CHANGE_ID,
		metadata: { branch: "main", baseBranch: "main", baseCommit: "base" },
		routing,
	}).view;
	view = advanceRouting(engine, root, view);
	fs.writeFileSync(`${change}/tasks.md`, "- [x] task\n");
	fs.writeFileSync(`${root}/implementation.txt`, "changed\n");
	view = complete(engine, root, view, "worker", { changed: true });
	view = complete(engine, root, view, "triage", {
		roles: [
			{
				role: "quality-verifier",
				reason: "code changed",
				files: ["implementation.txt"],
			},
		],
	});
	view = complete(engine, root, view, "quality-verifier", { findings: [] });
	view = complete(engine, root, view, "test-verifier", { findings: [] });
	view = action(engine, root, view, "approve-review");
	if (view.currentStep.id !== "core.archive")
		throw new Error(`expected core.archive, reached ${view.currentStep.id}`);
	return view;
}

function archiveRuns(view: WorkflowView) {
	return view.runs.filter((run) => run.role === "archive");
}

function attentionOf(
	engine: WorkflowEngine,
	root: string,
	view: WorkflowView,
): string[] {
	return engine.getSnapshot(root, view.workflowId).attention ?? [];
}

/** The handoff contract's own message bound: `agentHandoffSchema` keeps a
 * blocked detail at 4096 bytes, so no transcript can reach attention unbounded. */
const HANDOFF_MESSAGE_BYTES = 4096;

test("a failed archive attempt hands the step its one repair round", () => {
	const root = repo();
	try {
		const engine = new WorkflowEngine(registerBuiltins());
		let view = reachArchive(engine, root);
		expect(archiveRuns(view)).toHaveLength(1);
		const routingAttention = attentionOf(engine, root, view);
		view = blockArchive(engine, root, view, "openspec validate failed");
		expect(view.currentStep.id).toBe("core.archive");
		expect(view.status).toBe("active");
		const snapshot = engine.getSnapshot(root, view.workflowId);
		expect(snapshot.loopCounts[ARCHIVE_ATTEMPT_KEY]).toBe(2);
		// The granted repair round is not itself an attention entry: only an
		// exhausted budget parks the workflow.
		expect(snapshot.attention).toEqual(routingAttention);
		expect(snapshot.step.attempt).toBe(2);
		expect(archiveRuns(view)).toHaveLength(2);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("the second archive failure parks with the redacted validator output", () => {
	const root = repo();
	try {
		const engine = new WorkflowEngine(registerBuiltins());
		let view = reachArchive(engine, root);
		view = blockArchive(engine, root, view, "first attempt failed");
		const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345";
		const failure = `openspec validate ${CHANGE_ID} --strict failed:\n${secret}\n${"x".repeat(3000)}`;
		view = blockArchive(engine, root, view, failure);
		expect(view.status).toBe("attention-required");
		expect(view.currentStep.id).toBe("core.archive");
		const detail = requireDefined(
			attentionOf(engine, root, view).at(-1),
			"attention detail",
		);
		// The developer still reads the run's own validator output, not a summary.
		expect(detail).toContain(`openspec validate ${CHANGE_ID} --strict failed:`);
		expect(detail).not.toContain(secret);
		expect(detail).toContain("[REDACTED]");
		expect(Buffer.byteLength(detail, "utf8")).toBeLessThanOrEqual(
			HANDOFF_MESSAGE_BYTES,
		);
		// The budget is spent: no third archive run is started by the park.
		expect(archiveRuns(view)).toHaveLength(ARCHIVE_ATTEMPT_LIMIT);
		expect(engine.claimEffects(root, 100)).toEqual([]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("a blocked detail larger than the handoff contract is refused, not persisted", () => {
	const root = repo();
	try {
		const engine = new WorkflowEngine(registerBuiltins());
		const view = reachArchive(engine, root);
		expect(() =>
			blockArchive(engine, root, view, "x".repeat(HANDOFF_MESSAGE_BYTES + 1)),
		).toThrow(/4096 bytes/);
		// A refused handoff leaves the attempt intact and the workflow unparked.
		expect(engine.status(root, view.workflowId).status).toBe("active");
		expect(
			engine.getSnapshot(root, view.workflowId).loopCounts[ARCHIVE_ATTEMPT_KEY],
		).toBe(1);
		expect(archiveRuns(engine.status(root, view.workflowId))).toHaveLength(1);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("a developer repair grants a fresh pair of archive attempts", () => {
	const root = repo();
	try {
		const engine = new WorkflowEngine(registerBuiltins());
		let view = reachArchive(engine, root);
		view = blockArchive(engine, root, view, "first attempt failed");
		view = blockArchive(engine, root, view, "second attempt failed");
		expect(view.status).toBe("attention-required");
		view = engine.dispatch(root, {
			type: "operator.repair",
			workflowId: view.workflowId,
			revision: view.revision,
			targetStep: "core.archive",
			reason: "fixed the missing merge markers",
		}).view;
		expect(view.status).toBe("active");
		const repaired = engine.getSnapshot(root, view.workflowId);
		expect(repaired.loopCounts[ARCHIVE_ATTEMPT_KEY]).toBe(1);
		view = blockArchive(engine, root, view, "repaired attempt failed");
		expect(view.status).toBe("active");
		expect(
			engine.getSnapshot(root, view.workflowId).loopCounts[ARCHIVE_ATTEMPT_KEY],
		).toBe(2);
		expect(archiveRuns(view)).toHaveLength(4);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("an archived change keeps the unchanged happy path", () => {
	const root = repo();
	try {
		const engine = new WorkflowEngine(registerBuiltins());
		let view = reachArchive(engine, root);
		const active = `${root}/openspec/changes/${CHANGE_ID}`;
		const archived = `${root}/openspec/changes/archive/${CHANGE_ID}`;
		fs.mkdirSync(`${root}/openspec/changes/archive`, { recursive: true });
		fs.renameSync(active, archived);
		view = complete(engine, root, view, "archive", { archived: true });
		expect(view.currentStep.id).toBe("core.delivery");
		expect(
			engine.getSnapshot(root, view.workflowId).loopCounts[ARCHIVE_ATTEMPT_KEY],
		).toBe(1);
		expect(archiveRuns(view)).toHaveLength(1);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("the archive assignment states the attempt and its one round of duties", () => {
	const behavior = stepBehavior("core.archive");
	const assignmentFor = (attempt: number) =>
		requireDefined(
			behavior.assignmentInputs?.({
				snapshot: {
					currentStep: "core.archive",
					loopCounts: { [ARCHIVE_ATTEMPT_KEY]: attempt },
				} as unknown as WorkflowSnapshot,
				run: { stepId: "core.archive", role: "archive", profile },
			} as unknown as AssignmentInputsContext),
			"archive assignment inputs",
		);
	const first = assignmentFor(1);
	expect(first.introLines?.join("\n")).toContain(
		`Archive attempt 1 of ${ARCHIVE_ATTEMPT_LIMIT}`,
	);
	expect(first.introLines?.join("\n")).toContain(
		"do not edit the change documents",
	);
	const second = assignmentFor(2);
	expect(second.introLines?.join("\n")).toContain(
		`Archive attempt 2 of ${ARCHIVE_ATTEMPT_LIMIT}`,
	);
	expect(second.introLines?.join("\n")).toContain("structural repair attempt");
});

test("the archive behavior reports the granted repair round and stops after the budget", () => {
	const behavior = stepBehavior("core.archive");
	const completionFor = (
		attempt: number,
		outcome: "blocked" | "complete" | "failed",
	) =>
		behavior.onAgentComplete?.({
			snapshot: {
				currentStep: "core.archive",
				loopCounts: { [ARCHIVE_ATTEMPT_KEY]: attempt },
			} as unknown as WorkflowSnapshot,
			outcome,
		} as unknown as AgentCompletionContext);
	expect(completionFor(1, "blocked")).toEqual({
		transition: { outcome: "blocked" },
		telemetry: [
			{
				event: "archive.repair_round",
				payload: {
					"herdr.archive.failed_attempt": 1,
					"herdr.archive.next_attempt": 2,
					"herdr.archive.limit": ARCHIVE_ATTEMPT_LIMIT,
				},
			},
		],
	});
	// The last attempt transitions nowhere: the blocked handoff parks instead.
	expect(completionFor(ARCHIVE_ATTEMPT_LIMIT, "blocked")).toBeUndefined();
	expect(completionFor(1, "complete")).toBeUndefined();
	// `failed` keeps the graph's own retry edge, budget or not.
	expect(completionFor(ARCHIVE_ATTEMPT_LIMIT, "failed")).toBeUndefined();
});
