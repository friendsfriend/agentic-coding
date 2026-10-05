import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorkflowView } from "../src/contracts/workflow.ts";
import {
	previewWorkflowRepair,
	repairWorkflow,
	runWorkflowAction,
	viewToDashboardState,
} from "../src/server/operations/engine.ts";
import {
	dashboardTestHelpers,
	listWorkflows,
	listWorkflowsFromCatalog,
	loadLocalChanges,
} from "../src/server/operations/observations.ts";
import {
	definitionVersionForPolicy,
	registerBuiltins,
} from "../src/workflow/definitions.ts";
import {
	canonicalStorePath,
	researchWorkflowTarget,
	WorkflowEngine,
} from "../src/workflow/runtime.ts";
import {
	autoRemoveRepoFixtures,
	createRepoFixture,
} from "./support/git-fixture.ts";

// Sweep the repositories this file created, at the end of this file only.
autoRemoveRepoFixtures();

function view(step = "extension.future"): WorkflowView {
	return {
		workflowId: "wf",
		changeId: "change",
		revision: 7,
		definition: {
			id: "custom",
			version: 2,
			digest: "pin",
			label: "Custom flow",
		},
		status: "attention-required",
		repository: "/repo",
		worktree: "/worktree",
		branch: "feature/change",
		baseCommit: "base",
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-02T00:00:00Z",
		currentStep: {
			id: step,
			label: "Future audit",
			attempt: 2,
			enteredAt: "2026-01-01T12:00:00Z",
		},
		runs: [
			{
				id: "run",
				stepId: "core.verification",
				attempt: 2,
				role: "audit",
				status: "working",
				runtime: "pi-durable",
				profile: "oc2",
				model: "provider/model",
			},
		],
		routing: {
			defaultProfile: "oc2",
			routes: [],
			diversity: [{ routes: ["implementation", "audit"], satisfied: true }],
		},
		effects: [
			{
				id: "effect",
				kind: "delivery.push",
				status: "failed",
				attempts: 4,
				lastError: "network",
			},
		],
		observations: [
			{
				runId: "run",
				runtime: "pi-durable",
				status: "idle",
				at: "2026-01-02T00:00:01Z",
			},
		],
		health: { valid: true, attention: ["effect failed"] },
		availableActions: [
			{
				id: "retry-effect:effect",
				label: "Retry delivery push",
				confirmation: "confirm",
			},
		],
	};
}

test("dashboard projection renders registry-provided future step and generated actions", () => {
	const state = viewToDashboardState(view());
	expect(state.phase).toBe("extension.future");
	expect(state.stepLabel).toBe("Future audit");
	expect(state.definition.label).toBe("Custom flow");
	expect(state.availableActions[0]?.id).toBe("retry-effect:effect");
	expect(state.verificationModels.audit).toBe("provider/model");
	expect(state.phaseStartedAt).toBe("2026-01-01T12:00:00Z");
});
test("dashboard projection carries classifier decisions and defaults to an empty list", () => {
	const withoutDecisions = viewToDashboardState(view());
	expect(withoutDecisions.classifierDecisions).toEqual([]);
	const classified = view();
	classified.classifierDecisions = [
		{
			id: "decision",
			at: "2026-01-01T00:00:00Z",
			integration: "routing",
			phase: "apply",
			questionId: "core.implementation",
			model: "jev",
			input: "state",
			inputTruncated: false,
			options: [],
			answer: { type: "noul" },
			result: { applied: false, profiles: ["worker"] },
		},
	];
	expect(viewToDashboardState(classified).classifierDecisions).toEqual(
		classified.classifierDecisions,
	);
});

test("dashboard projection carries gate decisions and defaults to an empty list", () => {
	const withoutDecisions = viewToDashboardState(view());
	expect(withoutDecisions.gateDecisions).toEqual([]);
	const gated = view();
	gated.gateDecisions = [
		{
			id: "gate",
			at: "2026-01-01T00:00:00Z",
			stepId: "core.review-gate",
			stage: "developerReview",
			policy: "auto",
			decision: "skip",
			forced: false,
			noul: 0.1,
		},
	];
	expect(viewToDashboardState(gated).gateDecisions).toEqual(
		gated.gateDecisions,
	);
});

test("openspec-fusion steps render their registry labels in phase status", () => {
	const fusion = (stepId: string, label: string) => {
		const fixture = view();
		fixture.definition = { ...fixture.definition, id: "openspec-fusion" };
		fixture.currentStep = { ...fixture.currentStep, id: stepId, label };
		const state = viewToDashboardState(fixture);
		expect(state.stepLabel).toBe(label);
	};
	fusion("fusion.plan", "Fusion planning");
	fusion("fusion.consolidate", "Plan fusion");
});
test("committed run state stays separate from adapter observation", () => {
	const current = view();
	expect(current.runs[0]?.status).toBe("working");
	expect(current.observations[0]?.status).toBe("idle");
	expect(current.effects[0]?.lastError).toBe("network");
});
test("dashboard discovery keeps malformed workflows visible with diagnostic", () => {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-invalid-"));
	try {
		execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
		fs.writeFileSync(path.join(repo, "README.md"), "x\n");
		execFileSync("git", ["add", "."], { cwd: repo });
		execFileSync(
			"git",
			[
				"-c",
				"user.email=test@example.com",
				"-c",
				"user.name=Test",
				"commit",
				"-qm",
				"base",
			],
			{ cwd: repo },
		);
		const profile = {
			name: "test",
			runtime: "pi-durable" as const,
			executable: "sh",
			tools: [],
			extensions: [],
			readOnly: false,
			capabilities: ["prompt", "run-environment", "observe"] as const,
			digest: "profile",
		};
		const started = new WorkflowEngine(registerBuiltins()).start({
			repo,
			workflowId: "invalid",
			definitionId: "no-openspec",
			metadata: {
				branch: "main",
				baseBranch: "main",
				baseCommit: "base",
				task: "task",
			},
			routing: {
				defaultProfile: "test",
				routes: [{ stepId: "core.implementation", role: "worker", profile }],
				diversity: [],
			},
		});
		const db = new Database(canonicalStorePath(repo));
		const snapshot = structuredClone(started.snapshot);
		snapshot.currentStep = "broken.step";
		db.query(
			"UPDATE workflow_instances SET snapshot_json=?, current_step=? WHERE id=?",
		).run(JSON.stringify(snapshot), "broken.step", started.view.workflowId);
		db.close();
		const item = listWorkflows(repo).find(
			(entry) => entry.state.workflowId === "invalid",
		);
		expect(item?.state.health?.valid).toBe(false);
		expect(item?.state.health?.diagnostic).toContain(
			"step not in pinned definition",
		);
		// A repository-backed row is addressed by the root the caller listed.
		expect(item?.target).toBe(repo);
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});
test("committed verifier artifact and round survive later workflow steps", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-report-"));
	try {
		const outputPath = path.join(root, "run.output.json");
		const envelope = JSON.stringify({
			runId: "run",
			schemaId: "core.findings",
			schemaVersion: 1,
			payload: {
				findings: [{ id: "Q-1", severity: "warning", detail: "detail" }],
			},
		});
		fs.writeFileSync(outputPath, envelope);
		const current = view();
		current.currentStep = {
			id: "core.developer-review",
			label: "Review",
			attempt: 1,
			enteredAt: "2026-01-02T00:00:00Z",
		};
		current.runs[0] = {
			...current.runs[0],
			status: "completed",
			outputPath,
			outputDigest: createHash("sha256").update(envelope).digest("hex"),
		};
		// biome-ignore lint/suspicious/noExplicitAny: asserting on internal state shape
		const state = viewToDashboardState(current) as any;
		expect(state.verificationRound).toBe(2);
		expect(state.verificationRoles).toEqual(["audit"]);
		expect(state.runs[0].status).toBe("completed");
		expect(
			dashboardTestHelpers.committedVerifierOutput(state, "audit")?.findings[0]
				?.id,
		).toBe("Q-1");
		expect(dashboardTestHelpers.verificationHistory(state)).toEqual([
			"round-2: PASS",
		]);
		state.runs.push({
			...state.runs[0],
			id: "pending",
			role: "test-verifier",
			status: "working",
		});
		expect(dashboardTestHelpers.verificationHistory(state)).toEqual([
			"round-2: PENDING",
		]);
		state.runs[state.runs.length - 1].status = "expired";
		expect(dashboardTestHelpers.verificationHistory(state)).toEqual([
			"round-2: EXPIRED",
		]);
		state.runs.pop();
		fs.writeFileSync(outputPath, "{}");
		expect(dashboardTestHelpers.verificationHistory(state)).toEqual([
			"round-2: EVIDENCE ERROR",
		]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
test("developer review reads authoritative workflow worktree and closed state is terminal", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-worktree-"));
	const repo = path.join(root, "repo");
	const linked = path.join(root, "linked");
	try {
		fs.mkdirSync(repo);
		createRepoFixture(repo, {
			files: {
				"README.md": "base\n",
			},
		});
		execFileSync(
			"git",
			["worktree", "add", "-q", "-b", "feature/review", linked],
			{ cwd: repo },
		);
		const base = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: repo,
			encoding: "utf8",
		}).trim();
		const profile = {
			name: "test",
			runtime: "pi-durable" as const,
			executable: "sh",
			tools: [],
			extensions: [],
			readOnly: false,
			capabilities: ["prompt", "run-environment", "observe"] as const,
			digest: "profile",
		};
		new WorkflowEngine(registerBuiltins()).start({
			repo,
			worktree: linked,
			workflowId: "review",
			definitionId: "no-openspec",
			metadata: {
				branch: "feature/review",
				baseBranch: "main",
				baseCommit: base,
				task: "task",
			},
			routing: {
				defaultProfile: "test",
				routes: [{ stepId: "core.implementation", role: "worker", profile }],
				diversity: [],
			},
		});
		fs.writeFileSync(path.join(linked, "README.md"), "changed\n");
		expect(
			loadLocalChanges(repo, "review").map((item) => item.newPath),
		).toContain("README.md");
		expect(
			listWorkflows(linked).some((item) => item.state.workflowId === "review"),
		).toBe(true);
		// Discovery no longer recurses into a parent directory: only an explicit
		// canonical project root is read, so an unconfigured nested repository
		// cannot appear automatically.
		expect(
			listWorkflows(root).some((item) => item.state.workflowId === "review"),
		).toBe(false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
test("a research workflow is listed under the research target, not the wiki one", () => {
	// Wiki and research resolve to one store file, so the root that read a row
	// cannot name its target: the manifest's target kind does. Reporting the
	// wiki target for research work would address it with a key the start path
	// and the execution coordinator never used.
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-research-"));
	const previousWikiRoot = process.env.HERDR_WIKI_DIR;
	process.env.HERDR_WIKI_DIR = path.join(tmp, "wiki");
	try {
		const researchProfile = {
			name: "researcher",
			runtime: "pi-durable" as const,
			executable: "sh",
			tools: ["read"],
			extensions: [],
			readOnly: true,
			capabilities: [
				"interactive",
				"prompt",
				"persistent-session",
				"run-environment",
				"observe",
				"read-only",
			] as const,
			digest: "profile",
		};
		new WorkflowEngine(registerBuiltins()).start({
			repo: researchWorkflowTarget(),
			workflowId: "research-listed",
			definitionId: "research",
			// The standalone research lifecycle has no legacy version 1.
			definitionVersion: definitionVersionForPolicy(6),
			metadata: { branch: "", baseBranch: "", baseCommit: "", task: "task" },
			routing: {
				defaultProfile: researchProfile.name,
				routes: [
					{
						stepId: "core.research",
						role: "researcher",
						profile: researchProfile,
					},
				],
				diversity: [],
			},
		});

		const row = listWorkflows().find(
			(entry) => entry.state.workflowId === "research-listed",
		);
		expect(row?.target).toBe(researchWorkflowTarget());
		// The repository column is not the key: a repository-independent
		// workflow has none.
		expect(row?.state.repository).toBe("");
	} finally {
		if (previousWikiRoot === undefined) delete process.env.HERDR_WIKI_DIR;
		else process.env.HERDR_WIKI_DIR = previousWikiRoot;
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("catalog-backed history annotates the configured project ident", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-catalog-"));
	const repo = path.join(root, "repo");
	fs.mkdirSync(repo);
	const canonicalRepo = fs.realpathSync(repo);
	const server = Bun.serve({
		port: 0,
		fetch: () =>
			Response.json({
				revision: "rev",
				projects: [
					{
						ident: "configured-repo",
						displayName: "Configured Repo",
						kind: "app",
						canonicalRoot: canonicalRepo,
						activeCheckout: canonicalRepo,
						available: true,
						availability: "available",
						capabilities: { openspec: false },
					},
				],
			}),
	});
	try {
		createRepoFixture(repo, {
			files: {
				"README.md": "base\n",
			},
		});
		const base = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: repo,
			encoding: "utf8",
		}).trim();
		const profile = {
			name: "test",
			runtime: "pi-durable" as const,
			executable: "sh",
			tools: [],
			extensions: [],
			readOnly: false,
			capabilities: ["prompt", "run-environment", "observe"] as const,
			digest: "profile",
		};
		new WorkflowEngine(registerBuiltins()).start({
			repo,
			worktree: repo,
			workflowId: "catalog-review",
			definitionId: "no-openspec",
			metadata: {
				branch: "main",
				baseBranch: "main",
				baseCommit: base,
				task: "task",
			},
			routing: {
				defaultProfile: "test",
				routes: [{ stepId: "core.implementation", role: "worker", profile }],
				diversity: [],
			},
		});

		const overviews = await listWorkflowsFromCatalog(
			`http://127.0.0.1:${server.port}`,
		);
		const item = overviews.find(
			(overview) => overview.state.workflowId === "catalog-review",
		);
		expect(item?.projectIdent).toBe("configured-repo");
	} finally {
		server.stop(true);
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("dashboard repair and actions use displayed revision", async () => {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-repair-"));
	try {
		execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
		fs.writeFileSync(path.join(repo, "README.md"), "x\n");
		execFileSync("git", ["add", "."], { cwd: repo });
		execFileSync(
			"git",
			[
				"-c",
				"user.email=test@example.com",
				"-c",
				"user.name=Test",
				"commit",
				"-qm",
				"base",
			],
			{ cwd: repo },
		);
		const profile = {
			name: "test",
			runtime: "pi-durable" as const,
			executable: "sh",
			tools: [],
			extensions: [],
			readOnly: false,
			capabilities: ["prompt", "run-environment", "observe"] as const,
			digest: "profile",
		};
		const started = new WorkflowEngine(registerBuiltins()).start({
			repo,
			workflowId: "repair",
			definitionId: "no-openspec",
			metadata: {
				branch: "main",
				baseBranch: "main",
				baseCommit: "base",
				task: "task",
			},
			routing: {
				defaultProfile: "test",
				routes: [
					{ stepId: "core.implementation", role: "worker", profile },
					{ stepId: "core.triage", role: "triage", profile },
					{ stepId: "core.verification", profile },
				],
				diversity: [],
			},
		}).view;
		expect(
			previewWorkflowRepair(repo, "repair").find(
				(item) => item.targetStep === "core.implementation",
			)?.expiresRuns,
		).toContain(started.runs[0]?.id);
		expect(() =>
			repairWorkflow(
				repo,
				"repair",
				started.revision + 1,
				"core.implementation",
				"reason",
			),
		).toThrow(/stale revision/);
		expect(
			repairWorkflow(
				repo,
				"repair",
				started.revision,
				"core.implementation",
				"reason",
			).status,
		).toBe("active");
		await expect(
			runWorkflowAction("resume", repo, "repair", started.revision),
		).rejects.toThrow(/stale revision/);
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});
test("dashboard repair dispatches with an empty/omitted reason", () => {
	const repo = fs.mkdtempSync(
		path.join(os.tmpdir(), "dashboard-repair-empty-reason-"),
	);
	try {
		execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
		fs.writeFileSync(path.join(repo, "README.md"), "x\n");
		execFileSync("git", ["add", "."], { cwd: repo });
		execFileSync(
			"git",
			[
				"-c",
				"user.email=test@example.com",
				"-c",
				"user.name=Test",
				"commit",
				"-qm",
				"base",
			],
			{ cwd: repo },
		);
		const profile = {
			name: "test",
			runtime: "pi-durable" as const,
			executable: "sh",
			tools: [],
			extensions: [],
			readOnly: false,
			capabilities: ["prompt", "run-environment", "observe"] as const,
			digest: "profile",
		};
		const started = new WorkflowEngine(registerBuiltins()).start({
			repo,
			workflowId: "repair-empty",
			definitionId: "no-openspec",
			metadata: {
				branch: "main",
				baseBranch: "main",
				baseCommit: "base",
				task: "task",
			},
			routing: {
				defaultProfile: "test",
				routes: [
					{ stepId: "core.implementation", role: "worker", profile },
					{ stepId: "core.triage", role: "triage", profile },
					{ stepId: "core.verification", profile },
				],
				diversity: [],
			},
		}).view;
		const repairedWithOmittedReason = repairWorkflow(
			repo,
			"repair-empty",
			started.revision,
			"core.implementation",
		);
		expect(repairedWithOmittedReason.status).toBe("active");
		const repairedWithEmptyReason = repairWorkflow(
			repo,
			"repair-empty",
			repairedWithOmittedReason.revision,
			"core.implementation",
			"",
		);
		expect(repairedWithEmptyReason.status).toBe("active");
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});
